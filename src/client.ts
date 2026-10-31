import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import mqtt, { type IClientOptions, type IPublishPacket, type MqttClient } from 'mqtt';
import { loadConfig, type ModuleConfig } from './config.js';
import { SdkError } from './errors.js';
import { Flow } from './flow.js';
import {
  type Answer,
  type Command,
  decodeMessage,
  INVALID_PAYLOAD,
  parseCommand,
  parseTelemetry,
  RELOAD_COMMAND,
  RELOAD_FAILED,
  replyBody,
  type TelemetryMessage,
} from './messages.js';
import { readSecret, secretNames } from './secrets.js';
import { type Telemetry, telemetryPayload } from './telemetry.js';
import { type Topics, topicsFor } from './topics.js';
import { fetchTwin, type ModuleTwin } from './twin.js';
import { isObject } from './validation.js';

/** After a dropped or refused connection, connect again after this long, with fresh certificates. */
export const RECONNECT_AFTER_MS = 5000;

/** MQTT 5 maximum packet size announced on CONNECT: 2 MiB + 1 KiB. */
export const MAX_PACKET_BYTES = 2 * 1024 * 1024 + 1024;

export type TelemetryHandler = (message: TelemetryMessage) => void | Promise<void>;
export type TwinChangeHandler = (twin: ModuleTwin) => void | Promise<void>;

export interface ModuleClientOptions {
  /** Opens one MQTT connection; defaults to the `mqtt` package's `connect`. For tests. */
  connectMqtt?: (url: string, options: IClientOptions) => MqttClient;
  /** Where log lines go; defaults to standard error. Lines never hold a secret. */
  log?: (line: string) => void;
  /** Delay before reconnecting; defaults to {@link RECONNECT_AFTER_MS}. */
  reconnectAfterMs?: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** An error's type, logged instead of a message that could quote a value. */
const errorType = (error: unknown) =>
  error instanceof Error ? error.constructor.name || error.name : typeof error;

/** A module's link to its Newboot Superset: its twin, its secrets, its telemetry and `reload`. */
export class ModuleClient {
  readonly config: ModuleConfig;
  /**
   * This client's flow observations, served by `metrics()`. The SDK records `receive`, `process`,
   * `enqueue` and the connection; record `acquire` here when the module reads a device.
   */
  readonly flow = new Flow();
  readonly topics: Topics;
  private client: MqttClient | undefined;
  private closed = false;
  private started = false;
  private readonly connectMqtt: (url: string, options: IClientOptions) => MqttClient;
  private lastTwin: ModuleTwin | undefined;
  private readonly log: (line: string) => void;
  private readonly reconnectAfterMs: number;
  private reloading: Promise<void> = Promise.resolve();
  private subscribed = false;
  private readonly telemetryHandlers: TelemetryHandler[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly twinHandlers: TwinChangeHandler[] = [];

  constructor(config: ModuleConfig, options: ModuleClientOptions = {}) {
    this.config = config;
    this.topics = topicsFor(config.target);
    this.connectMqtt = options.connectMqtt ?? mqtt.connect;
    this.log = options.log ?? ((line) => console.error(line));
    this.reconnectAfterMs = options.reconnectAfterMs ?? RECONNECT_AFTER_MS;
  }

  /** Reads and validates `MODULE_CONFIG` (default `/etc/newboot/module.json`). */
  static fromEnv(options: ModuleClientOptions = {}): ModuleClient {
    return new ModuleClient(loadConfig(), options);
  }

  /** The names of the module's declared secrets. */
  secretNames(): string[] {
    return secretNames(this.config.secretFiles);
  }

  /** A secret's value, read from its file now. Errors name the secret, never its value. */
  getSecret(name: string): string {
    return readSecret({ name, secretFiles: this.config.secretFiles });
  }

  /**
   * Reads every declared secret now; throws a `SecretError` naming the first one that cannot be
   * read. Call it at start to stop early.
   */
  checkSecrets(): void {
    for (const name of this.secretNames()) this.getSecret(name);
  }

  /**
   * Fetches this module's twin now, as received: its fields and an optional `variables` map.
   * Rejects with a `TwinError`, also when no twin endpoint is configured.
   */
  async getTwin(correlationId?: string): Promise<ModuleTwin> {
    const twin = await fetchTwin({ config: this.config, correlationId });
    this.lastTwin = twin;
    return twin;
  }

  /**
   * True while connected to the broker AND subscribed to the inputs and commands: what a module's
   * `/readyz` should answer.
   */
  isConnected(): boolean {
    return this.subscribed && this.client?.connected === true;
  }

  /**
   * The flow observability metrics (the 17 `newboot_flow_*` series) in the Prometheus text format:
   * serve them on `GET /metrics`, port 8080, as `METRICS_CONTENT_TYPE`. Newboot's console shows the
   * module's activity from them. Counters reset when the process restarts.
   */
  metrics(): string {
    return this.flow.render();
  }

  /**
   * Starts connecting to the broker, then keeps the connection: it subscribes to the inputs and
   * the module's commands, and after any drop or failure (a certificate file missing too) logs
   * `mqtt: <reason>` and reconnects with freshly read certificates. Resolves once started, not once
   * connected: `isConnected()` tells when the module is ready. A second call does nothing; a call
   * after `close()` rejects.
   */
  async connect(): Promise<void> {
    if (this.closed) throw new SdkError('the client is closed');
    if (this.started) return;
    this.started = true;
    this.start();
  }

  /**
   * Publishes one value on this module's telemetry topic, QoS 0, not retained. Returns false when
   * not connected or when the local client refuses it at once (the value is dropped). Throws a
   * `TelemetryError` for an invalid message.
   * Counted as `enqueue`: a success when the local client takes it without refusing it at once,
   * an error when it refuses it or when not connected.
   */
  sendTelemetry(telemetry: Telemetry): boolean {
    // An invalid message never reaches the local client: it throws, and is not counted.
    const body = telemetryPayload({ now: Date.now(), telemetry, twin: this.lastTwin });
    const client = this.client;
    if (!client || !this.isConnected()) {
      this.flow.record({ operation: 'enqueue', success: false });
      return false;
    }
    // Counted once, as soon as publish() returns: the local client refuses a message at once
    // (disconnecting, a topic alias error) by calling back during the call. A later callback
    // (written to the socket, or on 'drain') is not counted. Not proof the broker received it.
    let calling = true;
    let refused = false;
    client.publish(this.topics.telemetry, body, { qos: 0, retain: false }, (error) => {
      if (calling && error) refused = true;
    });
    calling = false;
    this.flow.record({ operation: 'enqueue', success: !refused });
    return !refused;
  }

  /**
   * Adds a handler called for each value a linked module sends, after the handlers added before
   * it (see the README for what is dropped). A failing handler is logged and ignored.
   */
  onTelemetry(handler: TelemetryHandler): void {
    this.telemetryHandlers.push(handler);
  }

  /**
   * Adds a handler called, in order, with the twin fetched again on each `reload`, before the
   * answer. A failing handler makes the answer `reload_failed`.
   */
  onTwinChange(handler: TwinChangeHandler): void {
    this.twinHandlers.push(handler);
  }

  /** Disconnects and stops reconnecting. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.subscribed = false;
    this.flow.connection(false);
    await this.client?.endAsync(true);
  }

  private openConnection(): MqttClient {
    // Certificates rotate: read the files again for every connection.
    const identity = readFileSync(this.config.mqtt.identity); // certificate, chain and key
    const options: IClientOptions = {
      ca: readFileSync(this.config.mqtt.ca),
      cert: identity,
      clientId: `${this.config.target.moduleId}-${hostname()}`,
      key: identity,
      // Announce the largest packet this module takes: the broker drops bigger ones instead of
      // sending them, so a huge PUBLISH is never buffered here.
      properties: { maximumPacketSize: MAX_PACKET_BYTES },
      protocolVersion: 5,
      reconnectPeriod: 0, // reconnect in start(), with fresh certificates
    };
    return this.connectMqtt(this.config.brokerUrl, options);
  }

  private start(): void {
    if (this.closed) return;
    let current: MqttClient;
    try {
      current = this.openConnection();
    } catch (error) {
      // A certificate file is missing for now: read it again for the next connection.
      this.log(`mqtt: ${message(error)}`);
      this.flow.connection(false);
      this.timer = setTimeout(() => this.start(), this.reconnectAfterMs);
      return;
    }
    this.client = current;
    current.on('connect', () => {
      // Newboot's broker sends stored messages with the retain flag set, and they are dropped;
      // live ones arrive with the flag cleared. On other brokers these options skip stored ones.
      const options = { qos: 1, rap: true, rh: 2 } as const;
      const filters = [this.topics.commandFilter, ...this.config.inputs];
      current.subscribe(filters, options, (error, granted) => {
        if (current !== this.client || this.closed) return;
        this.subscribed = !error && (granted ?? []).every((grant) => grant.qos < 128);
        this.flow.connection(this.subscribed);
        if (!this.subscribed) this.log('mqtt: subscription refused');
      });
    });
    current.on('message', (topic, _payload, packet) => this.receive(topic, packet));
    current.on('error', (error) => this.log(`mqtt: ${error.message}`));
    // A close, or an end the library decides on (a disconnect from the broker, a protocol error),
    // leaves this connection unable to go on: treat either as a drop. Only close() ends the loop.
    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      this.subscribed = false;
      current.end(true);
      if (current !== this.client) return; // a late drop of a replaced connection
      this.flow.connection(false);
      if (this.closed) return;
      this.log('mqtt: disconnected, reconnecting');
      this.timer = setTimeout(() => this.start(), this.reconnectAfterMs);
    };
    current.once('close', drop);
    current.once('end', drop);
  }

  private receive(topic: string, packet: IPublishPacket): void {
    const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
    if (this.config.inputs.includes(topic)) {
      this.receiveInput(topic, payload, packet.retain);
      return;
    }
    const decoded = decodeMessage({ payload, retain: packet.retain });
    if (!decoded) return;
    const command = parseCommand({
      message: decoded,
      now: Date.now(),
      target: this.config.target,
      topic,
      topics: this.topics,
    });
    // v0.1 answers `reload` only; any other command (getValue, custom ones) is left unanswered.
    if (command?.command === RELOAD_COMMAND) this.reload(command);
  }

  /**
   * A live message on an input topic: `receive`, then `process` once it was decoded and every
   * handler finished, an error when it breaks the rules or a handler failed. A retained (stored)
   * message is not a live input and counts as neither.
   */
  private receiveInput(topic: string, payload: Buffer, retain: boolean): void {
    if (retain) return;
    this.flow.record({ operation: 'receive', success: true });
    const decoded = decodeMessage({ payload, retain });
    const telemetry = decoded && parseTelemetry({ message: decoded, topic });
    if (!telemetry) {
      this.flow.record({ operation: 'process', success: false });
      return;
    }
    const delivered = this.telemetryHandlers.map((handler) => this.deliver(handler, telemetry));
    Promise.all(delivered).then((results) =>
      this.flow.record({ operation: 'process', success: results.every(Boolean) }),
    );
  }

  /**
   * A failing handler is logged (its name only: the error may quote a value) and ignored. Resolves
   * to whether it succeeded.
   */
  private deliver(handler: TelemetryHandler, telemetry: TelemetryMessage): Promise<boolean> {
    const failed = (error: unknown) => {
      this.log(`handler: telemetry handler failed (${errorType(error)})`);
      return false;
    };
    try {
      return Promise.resolve(handler(telemetry)).then(() => true, failed);
    } catch (error) {
      return Promise.resolve(failed(error));
    }
  }

  /** Fetches the twin again, one reload at a time, calls the handlers, then answers. */
  private reload(command: Command): void {
    if (!isObject(command.payload)) {
      this.reply({ answer: { error: INVALID_PAYLOAD }, command });
      return;
    }
    this.reloading = this.reloading.then(async () => {
      try {
        const twin = await this.getTwin(command.correlationId);
        for (const handler of this.twinHandlers) await handler(twin);
        this.reply({ answer: { result: { reloaded: true } }, command });
      } catch (error) {
        // The SDK's own errors are safe to log; a handler's message may quote values: type only.
        this.log(
          error instanceof SdkError
            ? `reload: ${error.message}`
            : `reload: twin-change handler failed (${errorType(error)})`,
        );
        this.reply({ answer: { error: RELOAD_FAILED }, command });
      }
    });
  }

  private reply({ answer, command }: { answer: Answer; command: Command }): void {
    if (Date.now() >= command.expiresAtUnixMs) return; // nobody waits for a late answer
    // On the current connection: a slow reload can outlive the one its command came on.
    // Only while connected and subscribed; never queued for later.
    const client = this.client;
    if (!client || !this.isConnected()) return;
    client.publish(command.replyTopic, replyBody({ answer, command }), { qos: 0, retain: false });
  }
}
