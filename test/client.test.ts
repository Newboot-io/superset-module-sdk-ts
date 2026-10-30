import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MAX_PACKET_BYTES, ModuleClient } from '../src/client.js';
import { parseConfig } from '../src/config.js';
import { SecretError, TelemetryError, TwinError } from '../src/errors.js';
import type { TelemetryMessage } from '../src/messages.js';
import { topicsFor } from '../src/topics.js';
import type { ModuleTwin } from '../src/twin.js';
import { INPUT, rendered, TARGET } from './fixtures.js';
import { CA, CLIENT_PEM, type FakeMqtt, fakeConnect, twinServer, until } from './helpers.js';

const TOPICS = topicsFor(TARGET);
const SCOPE = { clusterId: 'cluster-a', moduleId: 'my-module', tenantConfigId: 'tenant-a' };
const MQTT = { ca: CA, identity: CLIENT_PEM, mode: 'mutual-tls' };

function setup(override: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const { clients, connect } = fakeConnect();
  const config = parseConfig(JSON.stringify(rendered({ mqtt: MQTT, ...override })));
  const client = new ModuleClient(config, {
    connectMqtt: connect,
    log: (line) => lines.push(line),
    reconnectAfterMs: 1,
  });
  return { client, clients, lines };
}

/** Connects through a fake broker that accepts at once. */
async function connected(override: Record<string, unknown> = {}) {
  const context = setup(override);
  const done = context.client.connect();
  await until(() => context.clients.length === 1, 'a connection');
  (context.clients[0] as FakeMqtt).accept();
  await done;
  return { ...context, broker: context.clients[0] as FakeMqtt };
}

const reload = (correlationId: string, override: Record<string, unknown> = {}) => {
  const now = Date.now();
  return JSON.stringify({
    command: 'reload',
    correlationId,
    delivery: 'unicast',
    expiresAtUnixMs: now + 5000,
    issuedAtUnixMs: now,
    payload: {},
    replyTopic: `${TOPICS.reply}/${correlationId}`,
    target: SCOPE,
    ...override,
  });
};

const replies = (broker: FakeMqtt) =>
  broker.published
    .filter(({ topic }) => topic.startsWith(`${TOPICS.reply}/`))
    .map(({ options, payload, topic }) => ({ options, payload: JSON.parse(payload), topic }));

describe('ModuleClient', () => {
  it('reads MODULE_CONFIG in fromEnv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-client-'));
    const path = join(dir, 'module.json');
    writeFileSync(path, JSON.stringify(rendered()));
    const previous = process.env.MODULE_CONFIG;
    process.env.MODULE_CONFIG = path;
    try {
      assert.equal(ModuleClient.fromEnv().topics.telemetry, TOPICS.telemetry);
    } finally {
      if (previous === undefined) delete process.env.MODULE_CONFIG;
      else process.env.MODULE_CONFIG = previous;
    }
  });

  it('checks every declared secret, naming the first unreadable one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-client-'));
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');
    writeFileSync(good, '"ok"');
    writeFileSync(bad, 'raw-secret-value');
    setup({ configuration: { secretFiles: [good] } }).client.checkSecrets();
    const { client } = setup({ configuration: { secretFiles: [good, bad] } });
    assert.throws(
      () => client.checkSecrets(),
      (error: Error) =>
        error instanceof SecretError &&
        error.message === 'secret bad cannot be read' &&
        !error.message.includes('raw-secret-value'),
    );
  });

  it('lists and reads its declared secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-client-'));
    const file = join(dir, 'api-key.json');
    writeFileSync(file, '"k"');
    const { client } = setup({ configuration: { secretFiles: [file] } });
    assert.deepEqual(client.secretNames(), ['api-key']);
    assert.equal(client.getSecret('api-key'), 'k');
  });

  it('is not connected before connect, and drops telemetry then', () => {
    const { client } = setup();
    assert.equal(client.isConnected(), false);
    assert.equal(client.sendTelemetry({ value: 1, variableId: 'v' }), false);
    assert.throws(
      () => client.sendTelemetry({ value: Number.NaN, variableId: 'v' }),
      TelemetryError,
    );
  });

  it('rejects getTwin with a TwinError when no twin is configured', async () => {
    await assert.rejects(setup({ twin: undefined }).client.getTwin(), TwinError);
    await assert.rejects(setup({ twin: null }).client.getTwin('reload-1'), TwinError);
  });

  it('connects with its certificate over MQTT 5 and subscribes to commands and inputs', async () => {
    const { broker, client } = await connected();
    assert.equal(broker.url, 'mqtts://broker:8883');
    assert.equal(broker.options.clientId, `my-module-${hostname()}`);
    assert.equal(broker.options.protocolVersion, 5);
    assert.equal(broker.options.reconnectPeriod, 0);
    assert.deepEqual(broker.options.properties, { maximumPacketSize: 2098176 });
    assert.equal(MAX_PACKET_BYTES, 2 * 1024 * 1024 + 1024);
    assert.ok(Buffer.isBuffer(broker.options.cert) && broker.options.cert === broker.options.key);
    assert.deepEqual(broker.subscriptions, [
      { filters: [TOPICS.commandFilter, INPUT], options: { qos: 1, rap: true, rh: 2 } },
    ]);
    assert.ok(client.isConnected());
    await client.connect();
    assert.equal(broker.subscriptions.length, 1, 'a second connect() does nothing');
    await client.close();
    assert.ok(broker.ended && !client.isConnected());
  });

  it('is not connected, and sends nothing, when the broker refuses a subscription', async () => {
    const { client, clients, lines } = setup();
    client.connect().catch(() => {});
    await until(() => clients.length === 1, 'a connection');
    const broker = clients[0] as FakeMqtt;
    broker.granted = [{ qos: 1 }, { qos: 135 }];
    broker.accept();
    assert.ok(broker.connected);
    assert.equal(client.isConnected(), false);
    assert.equal(client.sendTelemetry({ value: 1, variableId: 'v' }), false);
    assert.deepEqual(broker.published, []);
    assert.deepEqual(lines, ['mqtt: subscription refused']);
    await client.close();
  });

  it('reconnects with fresh certificates after a drop, and logs it', async () => {
    const { broker, client, clients, lines } = await connected();
    broker.emit('error', new Error('boom'));
    broker.drop();
    assert.equal(client.isConnected(), false);
    assert.equal(client.sendTelemetry({ value: 1, variableId: 'v' }), false, 'never queued');
    await until(() => clients.length === 2, 'a second connection');
    (clients[1] as FakeMqtt).accept();
    assert.ok(client.isConnected());
    assert.deepEqual(broker.published, [], 'nothing sent on the dropped connection');
    assert.notEqual(clients[1]?.options.cert, broker.options.cert, 'certificates read again');
    assert.deepEqual(lines, ['mqtt: boom', 'mqtt: disconnected, reconnecting']);
    await client.close();
  });

  it('starts without its certificates, retries, and stops once closed', async () => {
    const { client, clients, lines } = setup({
      mqtt: { ...MQTT, identity: '/nonexistent/id.pem' },
    });
    await client.connect(); // resolves once started, even with a certificate file missing
    assert.equal(client.isConnected(), false);
    await until(() => lines.length >= 2, 'two attempts');
    await client.close();
    const attempts = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines.length, attempts, 'no retry after close');
    assert.equal(clients.length, 0);
    assert.match(lines[0] ?? '', /^mqtt: ENOENT/);
    await assert.rejects(client.connect(), { message: 'the client is closed' });
  });

  it('sends telemetry on its own topic, QoS 0, not retained', async () => {
    const { broker, client } = await connected();
    assert.equal(client.sendTelemetry({ timestamp: 7, value: 2.5, variableId: 'v-1' }), true);
    assert.deepEqual(broker.published, [
      {
        options: { qos: 0, retain: false },
        payload: '{"timestamp":7,"value":2.5,"variableId":"v-1"}',
        topic: TOPICS.telemetry,
      },
    ]);
    await client.close();
  });

  it('delivers linked modules’ telemetry, and drops what it must', async () => {
    const { broker, client, lines } = await connected();
    const received: TelemetryMessage[] = [];
    const order: string[] = [];
    client.onTelemetry((message) => {
      order.push('first');
      received.push(message);
    });
    client.onTelemetry(() => {
      order.push('second');
      throw new Error('handler broke on 1.5');
    });
    client.onTelemetry(async () => {
      order.push('third');
      throw new TypeError('async handler broke on 1.5');
    });
    broker.deliver(INPUT, JSON.stringify({ value: 1.5, variableId: 'v-up' }));
    broker.deliver(INPUT, JSON.stringify({ value: 2, variableId: 'v-retained' }), true);
    broker.deliver(INPUT, JSON.stringify({ value: 'x'.repeat(9000), variableId: 'v-big' }));
    broker.deliver(INPUT, '{"value": NaN, "variableId": "v-nan"}');
    broker.deliver(INPUT, JSON.stringify({ value: { a: 1 }, variableId: 'v-nested' }));
    broker.deliver(INPUT, JSON.stringify({ name: 7, value: 1, variableId: 'v-bad-name' }));
    broker.deliver(INPUT, JSON.stringify({ timestamp: -1, value: 1, variableId: 'v-bad-time' }));
    broker.deliver(
      'output/telemetry/tenant-a/node-a/other/v',
      JSON.stringify({ value: 1, variableId: 'v-x' }),
    );
    assert.deepEqual(received, [{ topic: INPUT, value: 1.5, variableId: 'v-up' }]);
    assert.deepEqual(order, ['first', 'second', 'third'], 'handlers run in the order added');
    await until(() => lines.length === 2, 'handler errors logged');
    // Logged without the error message: it may quote a value.
    assert.deepEqual(lines.sort(), [
      'handler: telemetry handler failed (Error)',
      'handler: telemetry handler failed (TypeError)',
    ]);
    await client.close();
  });

  it('answers reload with the twin fetched again, after the handlers ran', async (t) => {
    let served = 0;
    const twin = await twinServer((request, response) => {
      served++;
      const name = request.headers['x-newboot-correlation-id'] ?? 'startup';
      response.end(JSON.stringify({ modules: { 'my-module': { variables: { v: { name } } } } }));
    });
    t.after(twin.close);
    const { broker, client } = await connected({
      twin: { ca: CA, endpoint: twin.endpoint, identity: CLIENT_PEM },
    });
    const seen: ModuleTwin[] = [];
    client.onTwinChange(async (fetched) => {
      seen.push(fetched);
    });
    broker.deliver(`${TOPICS.command}/unicast/reload`, reload('reload-1'));
    await until(() => replies(broker).length === 1, 'the reload reply');
    assert.deepEqual(replies(broker), [
      {
        options: { qos: 0, retain: false },
        payload: { correlationId: 'reload-1', result: { reloaded: true }, target: SCOPE },
        topic: `${TOPICS.reply}/reload-1`,
      },
    ]);
    assert.deepEqual(seen, [{ variables: { v: { name: 'reload-1' } } }]);
    // Telemetry is named after the twin fetched last.
    client.sendTelemetry({ timestamp: 1, value: 1, variableId: 'v' });
    assert.equal(JSON.parse(broker.published.at(-1)?.payload ?? '{}').name, 'reload-1');
    assert.equal(served, 1);
    await client.close();
  });

  it('answers reload_failed when the fetch or a handler fails', async (t) => {
    const twin = await twinServer((_request, response) => response.writeHead(500).end());
    t.after(twin.close);
    const { broker, client, lines } = await connected({
      twin: { ca: CA, endpoint: twin.endpoint, identity: CLIENT_PEM },
    });
    broker.deliver(`${TOPICS.command}/unicast/reload`, reload('reload-500'));
    await until(() => replies(broker).length === 1, 'the failed reload reply');
    assert.deepEqual(replies(broker)[0]?.payload, {
      correlationId: 'reload-500',
      error: 'reload_failed',
      target: SCOPE,
    });
    assert.deepEqual(lines, ['reload: the twin endpoint answered HTTP 500']);
    await client.close();
  });

  it('runs twin handlers in order, and answers reload_failed when one fails', async (t) => {
    const twin = await twinServer((_request, response) =>
      response.end(JSON.stringify({ modules: { 'my-module': {} } })),
    );
    t.after(twin.close);
    const { broker, client, lines } = await connected({
      twin: { ca: CA, endpoint: twin.endpoint, identity: CLIENT_PEM },
    });
    const order: string[] = [];
    client.onTwinChange(() => {
      order.push('first');
    });
    client.onTwinChange(async () => {
      order.push('second');
      throw new Error('cannot apply');
    });
    client.onTwinChange(() => {
      order.push('never');
    });
    broker.deliver(`${TOPICS.command}/unicast/reload`, reload('reload-h'));
    await until(() => replies(broker).length === 1, 'the reply');
    assert.equal(replies(broker)[0]?.payload.error, 'reload_failed');
    assert.deepEqual(order, ['first', 'second']);
    // The handler's message may quote values: only its type is logged.
    assert.deepEqual(lines, ['reload: twin-change handler failed (Error)']);
    await client.close();
  });

  it('answers reload_failed without a twin, and invalid_payload for a non-object payload', async () => {
    const { broker, client } = await connected({ twin: undefined });
    broker.deliver(`${TOPICS.command}/unicast/reload`, reload('no-twin'));
    broker.deliver(`${TOPICS.command}/unicast/reload`, reload('bad', { payload: 'x' }));
    await until(() => replies(broker).length === 2, 'two replies');
    const errors = Object.fromEntries(
      replies(broker).map(({ payload }) => [payload.correlationId, payload.error]),
    );
    assert.deepEqual(errors, { bad: 'invalid_payload', 'no-twin': 'reload_failed' });
    await client.close();
  });

  it('does not answer a reload that expired while its twin was fetched', async (t) => {
    const twin = await twinServer((_request, response) => {
      setTimeout(() => response.end(JSON.stringify({ modules: { 'my-module': {} } })), 100);
    });
    t.after(twin.close);
    const { broker, client } = await connected({
      twin: { ca: CA, endpoint: twin.endpoint, identity: CLIENT_PEM },
    });
    let changed = false;
    client.onTwinChange(() => {
      changed = true;
    });
    broker.deliver(
      `${TOPICS.command}/unicast/reload`,
      reload('expiring', { expiresAtUnixMs: Date.now() + 50 }),
    );
    await until(() => changed, 'the twin fetched');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(replies(broker), []);
    await client.close();
  });

  it('does not answer a reload while disconnected, nor queue the answer', async (t) => {
    const twin = await twinServer((_request, response) => {
      setTimeout(() => response.end(JSON.stringify({ modules: { 'my-module': {} } })), 100);
    });
    t.after(twin.close);
    const { broker, client, clients } = await connected({
      twin: { ca: CA, endpoint: twin.endpoint, identity: CLIENT_PEM },
    });
    let changed = false;
    client.onTwinChange(() => {
      changed = true;
    });
    broker.deliver(`${TOPICS.command}/unicast/reload`, reload('while-down'));
    broker.drop();
    await until(() => changed && clients.length === 2, 'the fetch and a new connection');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = clients[1] as FakeMqtt;
    next.accept();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([...replies(broker), ...replies(next)], []);
    await client.close();
  });

  it('leaves getValue, custom, misaddressed, late and retained commands unanswered', async () => {
    const { broker, client } = await connected({ twin: undefined });
    const now = Date.now();
    broker.deliver(`${TOPICS.command}/unicast/getValue`, reload('get', { command: 'getValue' }));
    broker.deliver(`${TOPICS.command}/unicast/ping`, reload('ping', { command: 'ping' }));
    broker.deliver(
      `${TOPICS.command}/unicast/reload`,
      reload('other', { target: { ...SCOPE, moduleId: 'x' } }),
    );
    broker.deliver(
      `${TOPICS.command}/unicast/reload`,
      reload('late', { expiresAtUnixMs: now - 1, issuedAtUnixMs: now - 5000 }),
    );
    broker.deliver(`${TOPICS.command}/unicast/reload`, reload('kept'), true);
    broker.deliver(`${TOPICS.command}/unicast/reload`, 'not json');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(replies(broker), []);
    await client.close();
  });
});
