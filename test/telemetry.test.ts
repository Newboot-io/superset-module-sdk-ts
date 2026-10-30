import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TelemetryError } from '../src/errors.js';
import { type Telemetry, telemetryPayload } from '../src/telemetry.js';

const NOW = 1_800_000_000_000;
const TWIN = { variables: { 'variable-1': { name: 'Boiler temperature' } } };

describe('telemetryPayload', () => {
  it('sends name, timestamp, value and variableId, named after the twin’s variable', () => {
    const body = telemetryPayload({
      now: NOW,
      telemetry: { value: 21.5, variableId: 'variable-1' },
      twin: TWIN,
    });
    assert.equal(
      body,
      '{"name":"Boiler temperature","timestamp":1800000000000,"value":21.5,"variableId":"variable-1"}',
    );
  });

  it('takes an explicit name and timestamp, and leaves the name out when the twin has none', () => {
    const named = { name: 'Other', timestamp: 5, value: [1, 2], variableId: 'variable-1' };
    assert.deepEqual(
      JSON.parse(telemetryPayload({ now: NOW, telemetry: named, twin: TWIN })),
      named,
    );
    const plain = JSON.parse(
      telemetryPayload({ now: NOW, telemetry: { value: true, variableId: 'v-2' } }),
    );
    assert.deepEqual(plain, { timestamp: NOW, value: true, variableId: 'v-2' });
    const unnamed = { variables: { 'v-3': { name: 42 } } };
    const body = telemetryPayload({
      now: NOW,
      telemetry: { value: 1, variableId: 'v-3' },
      twin: unnamed,
    });
    assert.equal(body, '{"timestamp":1800000000000,"value":1,"variableId":"v-3"}');
  });

  it('refuses values JSON cannot carry, nested values, bad ids and bad timestamps', () => {
    const refused = [
      { value: Number.NaN, variableId: 'v' },
      { value: Number.POSITIVE_INFINITY, variableId: 'v' },
      { value: { a: 1 }, variableId: 'v' },
      { value: [[1]], variableId: 'v' },
      { value: 1, variableId: 'a/b' },
      { value: 1, variableId: '' },
      { timestamp: 1.5, value: 1, variableId: 'v' },
      { timestamp: -1, value: 1, variableId: 'v' },
      { name: 7, value: 1, variableId: 'v' },
    ];
    for (const telemetry of refused) {
      assert.throws(
        () => telemetryPayload({ now: NOW, telemetry: telemetry as unknown as Telemetry }),
        TelemetryError,
      );
    }
  });

  it('takes the twin name from the variable’s own keys only', () => {
    for (const variableId of ['constructor', 'toString', 'hasOwnProperty']) {
      const body = JSON.parse(
        telemetryPayload({ now: NOW, telemetry: { value: 1, variableId }, twin: TWIN }),
      );
      assert.equal(body.name, undefined, variableId);
    }
    const inherited = { variables: { v: Object.create({ name: 'inherited' }) } };
    const body = JSON.parse(
      telemetryPayload({ now: NOW, telemetry: { value: 1, variableId: 'v' }, twin: inherited }),
    );
    assert.equal(body.name, undefined);
  });

  it('takes integral timestamps up to 2^53-1, and nothing beyond', () => {
    const at = (timestamp: number) =>
      JSON.parse(
        telemetryPayload({ now: NOW, telemetry: { timestamp, value: 1, variableId: 'v' } }),
      );
    assert.equal(at(1.7e12).timestamp, 1_700_000_000_000);
    assert.equal(at(0).timestamp, 0);
    assert.equal(at(2 ** 53 - 1).timestamp, Number.MAX_SAFE_INTEGER);
    for (const timestamp of [2 ** 53, 1e300, Number.POSITIVE_INFINITY, Number.NaN]) {
      assert.throws(() => at(timestamp), TelemetryError, String(timestamp));
    }
  });

  it('names the field at fault, never the value', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ value: 1, variableId: 'secret/42' }, 'variableId'],
      [{ value: { pin: 'secret-42' }, variableId: 'v' }, 'value'],
      [{ timestamp: 'secret-42', value: 1, variableId: 'v' }, 'timestamp'],
      [{ name: ['secret-42'], value: 1, variableId: 'v' }, 'name'],
    ];
    for (const [telemetry, field] of cases) {
      assert.throws(
        () => telemetryPayload({ now: NOW, telemetry: telemetry as unknown as Telemetry }),
        (error: Error) =>
          error.message.startsWith(`invalid telemetry: ${field} must be`) &&
          !error.message.includes('secret'),
      );
    }
  });
});
