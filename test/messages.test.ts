import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeMessage,
  MAX_MESSAGE_BYTES,
  MAX_TTL_MS,
  onTime,
  parseCommand,
  parseTelemetry,
  replyBody,
} from '../src/messages.js';
import { topicsFor } from '../src/topics.js';
import { INPUT, TARGET } from './fixtures.js';

const NOW = 1_800_000_000_000;
const TOPICS = topicsFor(TARGET);
const SCOPE = { clusterId: 'cluster-a', moduleId: 'my-module', tenantConfigId: 'tenant-a' };

const envelope = (override: Record<string, unknown> = {}) => ({
  command: 'reload',
  correlationId: 'reload-1',
  delivery: 'unicast',
  expiresAtUnixMs: NOW + 5000,
  issuedAtUnixMs: NOW,
  payload: {},
  replyTopic: `${TOPICS.reply}/reload-1`,
  target: SCOPE,
  ...override,
});

const parse = (message: Record<string, unknown>, topic = `${TOPICS.command}/unicast/reload`) =>
  parseCommand({ message, now: NOW, target: TARGET, topic, topics: TOPICS });

describe('decodeMessage', () => {
  const decode = (text: string, retain = false) =>
    decodeMessage({ payload: Buffer.from(text), retain });

  it('keeps a live JSON object up to 8 KiB', () => {
    assert.deepEqual(decode('{"a":1}'), { a: 1 });
    const padded = JSON.stringify({ pad: 'x'.repeat(MAX_MESSAGE_BYTES - 10) });
    assert.equal(padded.length, MAX_MESSAGE_BYTES);
    assert.ok(decode(padded));
  });

  it('drops retained, oversized, non-JSON and non-object messages', () => {
    assert.equal(decode('{"a":1}', true), undefined);
    assert.equal(decode(JSON.stringify({ pad: 'x'.repeat(MAX_MESSAGE_BYTES) })), undefined);
    for (const text of ['not json', '{"value": NaN}', '5', '[1]', 'null', '"text"', '']) {
      assert.equal(decode(text), undefined, text);
    }
  });
});

describe('parseTelemetry', () => {
  it('keeps scalars and arrays of scalars with their name and timestamp', () => {
    for (const value of [1.5, 3, true, 'on', [1, 2.5], ['a', false]]) {
      assert.deepEqual(parseTelemetry({ message: { value, variableId: 'v-1' }, topic: INPUT }), {
        topic: INPUT,
        value,
        variableId: 'v-1',
      });
    }
    const full = { name: 'Temp', timestamp: NOW, value: 2, variableId: 'v-1' };
    assert.deepEqual(parseTelemetry({ message: full, topic: INPUT }), { ...full, topic: INPUT });
  });

  it('drops a message with 1e400 anywhere, even outside value', () => {
    for (const text of [
      '{"value": 1, "variableId": "v", "extra": 1e400}',
      '{"value": 1, "variableId": "v", "meta": {"list": [0, -1e400]}}',
    ]) {
      const message = decodeMessage({ payload: Buffer.from(text), retain: false });
      assert.ok(message);
      assert.equal(parseTelemetry({ message, topic: INPUT }), undefined, text);
    }
  });

  it('takes an integral JSON timestamp written as a decimal or exponent', () => {
    for (const text of ['1.7e12', '1700000000000.0', '9007199254740991']) {
      const message = decodeMessage({
        payload: Buffer.from(`{"timestamp": ${text}, "value": 1, "variableId": "v"}`),
        retain: false,
      });
      assert.ok(message && parseTelemetry({ message, topic: INPUT }), text);
    }
    const tooBig = decodeMessage({
      payload: Buffer.from('{"timestamp": 9007199254740992, "value": 1, "variableId": "v"}'),
      retain: false,
    });
    assert.ok(tooBig);
    assert.equal(parseTelemetry({ message: tooBig, topic: INPUT }), undefined);
  });

  it('ignores nested, non-finite or missing values and invalid variable ids', () => {
    const ignored = [
      { value: { a: [1] }, variableId: 'v' },
      { value: [[1]], variableId: 'v' },
      { value: Number.POSITIVE_INFINITY, variableId: 'v' },
      { value: null, variableId: 'v' },
      { variableId: 'v' },
      { value: 1, variableId: 'a/b' },
      { value: 1, variableId: '' },
      { value: 1 },
      { name: 7, value: 1, variableId: 'v' },
      { timestamp: -1, value: 1, variableId: 'v' },
      { timestamp: 1.5, value: 1, variableId: 'v' },
      { timestamp: '1', value: 1, variableId: 'v' },
      { timestamp: 2 ** 53, value: 1, variableId: 'v' },
      { name: null, value: 1, variableId: 'v' },
      { timestamp: null, value: 1, variableId: 'v' },
      { extra: Number.POSITIVE_INFINITY, value: 1, variableId: 'v' },
      { extra: { deep: [1, Number.NEGATIVE_INFINITY] }, value: 1, variableId: 'v' },
    ];
    for (const message of ignored) {
      assert.equal(parseTelemetry({ message, topic: INPUT }), undefined, JSON.stringify(message));
    }
  });
});

describe('onTime', () => {
  it('accepts a command issued now, within 1 s of skew, for at most 30 s', () => {
    assert.ok(onTime({ expires: NOW + 5000, issued: NOW, now: NOW }));
    assert.ok(onTime({ expires: NOW + 5000, issued: NOW + 1000, now: NOW }));
    assert.ok(onTime({ expires: NOW + MAX_TTL_MS, issued: NOW, now: NOW }));
  });

  it('refuses expired, future, too long and non-integer deadlines', () => {
    assert.ok(!onTime({ expires: NOW, issued: NOW - 5000, now: NOW }));
    assert.ok(!onTime({ expires: NOW + 10_000, issued: NOW + 1001, now: NOW }));
    assert.ok(!onTime({ expires: NOW + MAX_TTL_MS + 1, issued: NOW, now: NOW }));
    assert.ok(!onTime({ expires: NOW + 10, issued: NOW + 10, now: NOW }));
    assert.ok(!onTime({ expires: 'soon', issued: NOW, now: NOW }));
    assert.ok(!onTime({ expires: undefined, issued: NOW, now: NOW }));
    assert.ok(!onTime({ expires: NOW + 1.5, issued: NOW, now: NOW }));
  });
});

describe('parseCommand', () => {
  it('accepts a command addressed to this module, unicast or broadcast', () => {
    assert.equal(parse(envelope())?.correlationId, 'reload-1');
    const broadcast = parse(
      envelope({ delivery: 'broadcast' }),
      `${TOPICS.command}/broadcast/reload`,
    );
    assert.equal(broadcast?.delivery, 'broadcast');
    assert.ok(parse(envelope({ extra: 'ignored' })), 'unknown keys are ignored');
  });

  it('refuses a command not addressed to this module or not on time', () => {
    const refused: Record<string, Record<string, unknown>> = {
      'another target': { target: { ...SCOPE, moduleId: 'other' } },
      'a longer target': { target: { ...SCOPE, nodeId: 'node-a' } },
      expired: { expiresAtUnixMs: NOW - 1, issuedAtUnixMs: NOW - 5000 },
      'no deadline': { expiresAtUnixMs: undefined },
      'wrong delivery': { delivery: 'multicast' },
      'wrong reply topic': { replyTopic: `${TOPICS.reply}/elsewhere` },
      'invalid correlation id': { correlationId: 'a/b', replyTopic: `${TOPICS.reply}/a/b` },
    };
    for (const [what, override] of Object.entries(refused)) {
      assert.equal(parse(envelope(override)), undefined, what);
    }
    assert.equal(parse(envelope(), `${TOPICS.command}/unicast/getValue`), undefined, 'topic');
    assert.equal(parse(envelope(), `${TOPICS.command}/broadcast/reload`), undefined, 'delivery');
  });
});

describe('replyBody', () => {
  it('holds exactly the correlation id, the target and the answer', () => {
    const command = parse(envelope());
    assert.ok(command);
    assert.deepEqual(JSON.parse(replyBody({ answer: { result: { reloaded: true } }, command })), {
      correlationId: 'reload-1',
      result: { reloaded: true },
      target: SCOPE,
    });
    assert.deepEqual(JSON.parse(replyBody({ answer: { error: 'reload_failed' }, command })), {
      correlationId: 'reload-1',
      error: 'reload_failed',
      target: SCOPE,
    });
  });
});
