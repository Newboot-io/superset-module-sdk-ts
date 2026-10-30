import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IClientOptions, MqttClient } from 'mqtt';
import { makeTestCerts } from './certs.js';

/** A throwaway CA, a localhost server and a client identity, made for this test process. */
const CERTS = makeTestCerts();
export const CA = CERTS.ca;
export const CLIENT_PEM = CERTS.clientPem;

/** An HTTPS server that asks for a client certificate signed by the test CA. */
export async function twinServer(
  handle: Parameters<typeof createServer>[1],
): Promise<{ close: () => Promise<void>; endpoint: string; server: Server }> {
  const server = createServer(
    {
      ca: readFileSync(CA),
      cert: readFileSync(CERTS.serverCert),
      key: readFileSync(CERTS.serverKey),
      rejectUnauthorized: true,
      requestCert: true,
    },
    handle,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    endpoint: `https://localhost:${port}/twin`,
    server,
  };
}

export interface Published {
  options: unknown;
  payload: string;
  topic: string;
}

/** A stand-in for an mqtt.js client: records what is published and subscribed. */
export class FakeMqtt extends EventEmitter {
  connected = false;
  ended = false;
  granted = [{ qos: 1 }];
  published: Published[] = [];
  subscriptions: { filters: string[]; options: unknown }[] = [];

  constructor(
    readonly url: string,
    readonly options: IClientOptions,
  ) {
    super();
  }

  /** The broker accepts the connection. */
  accept(): void {
    this.connected = true;
    this.emit('connect');
  }

  /** The connection drops. */
  drop(): void {
    this.connected = false;
    this.emit('close');
  }

  /** A message arrives. */
  deliver(topic: string, payload: string | Buffer, retain = false): void {
    const body = Buffer.from(payload);
    this.emit('message', topic, body, { payload: body, retain, topic });
  }

  subscribe(
    filters: string[],
    options: unknown,
    callback: (error: Error | null, granted: { qos: number }[]) => void,
  ): void {
    this.subscriptions.push({ filters, options });
    callback(null, this.granted);
  }

  publish(topic: string, payload: string, options: unknown): void {
    this.published.push({ options, payload, topic });
  }

  end(): void {
    this.ended = true;
    this.connected = false;
  }

  async endAsync(): Promise<void> {
    this.end();
  }
}

/** A connect function that hands out fake clients and remembers them. */
export function fakeConnect() {
  const clients: FakeMqtt[] = [];
  const connect = (url: string, options: IClientOptions) => {
    const client = new FakeMqtt(url, options);
    clients.push(client);
    return client as unknown as MqttClient;
  };
  return { clients, connect };
}

/** Waits until `condition` holds, polling briefly. */
export async function until(condition: () => boolean, what: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
