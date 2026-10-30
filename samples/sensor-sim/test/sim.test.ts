import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_PRESSURE_HPA,
  BASE_TEMPERATURE_C,
  DEFAULT_AMPLITUDE,
  DEFAULT_RATE_MS,
  MAX_AMPLITUDE,
  MAX_RATE_MS,
  MIN_RATE_MS,
  ownVariables,
  PERIOD_MS,
  PRESSURE_NOISE_HPA,
  pressureAt,
  readSettings,
  TEMPERATURE_NOISE,
  temperatureAt,
} from '../src/sim.js';

/** A random source that always returns the middle of [0, 1): zero noise. */
const quiet = () => 0.5;

describe('readSettings', () => {
  it('reads valid settings from the twin fields', () => {
    assert.deepEqual(readSettings({ amplitude: 2.5, rateMs: 500 }), {
      fallbacks: [],
      settings: { amplitude: 2.5, rateMs: 500 },
    });
    assert.equal(readSettings({ amplitude: 0, rateMs: MIN_RATE_MS }).settings.rateMs, MIN_RATE_MS);
  });

  it('falls back to the defaults, naming each field', () => {
    assert.deepEqual(readSettings({}), {
      fallbacks: ['rateMs', 'amplitude'],
      settings: { amplitude: DEFAULT_AMPLITUDE, rateMs: DEFAULT_RATE_MS },
    });
    assert.equal(readSettings({ amplitude: 1, rateMs: MAX_RATE_MS }).settings.rateMs, MAX_RATE_MS);
    const tooSlow = [MAX_RATE_MS + 1, 2 ** 31, 2 ** 31 - 1];
    for (const rateMs of [MIN_RATE_MS - 1, 2000.5, '2000', null, -1, Number.NaN, ...tooSlow]) {
      assert.deepEqual(
        readSettings({ amplitude: 1, rateMs }).fallbacks,
        ['rateMs'],
        String(rateMs),
      );
    }
    for (const amplitude of [MAX_AMPLITUDE, -MAX_AMPLITUDE]) {
      assert.deepEqual(readSettings({ amplitude, rateMs: 1000 }).fallbacks, [], String(amplitude));
    }
    const tooLarge = [MAX_AMPLITUDE * 2, -MAX_AMPLITUDE - 1, 1e300];
    for (const amplitude of ['5', null, Number.POSITIVE_INFINITY, Number.NaN, [5], ...tooLarge]) {
      const read = readSettings({ amplitude, rateMs: 1000 });
      assert.deepEqual(read.fallbacks, ['amplitude'], String(amplitude));
      assert.equal(read.settings.amplitude, DEFAULT_AMPLITUDE);
    }
  });
});

describe('ownVariables', () => {
  it('finds the variables by name, whatever their ids', () => {
    const twin = {
      variables: {
        'variable-1': { name: 'pressure' },
        'variable-2': { name: 'humidity' },
        'variable-3': { name: 'temperature' },
      },
    };
    assert.deepEqual(ownVariables(twin), { pressure: 'variable-1', temperature: 'variable-3' });
  });

  it('finds nothing in a twin without variables or names', () => {
    assert.deepEqual(ownVariables({}), {});
    assert.deepEqual(ownVariables({ variables: { v: {} } }), {});
  });
});

describe('temperatureAt', () => {
  it('follows a sine around 20 °C scaled by the amplitude', () => {
    const at = (nowMs: number, amplitude = 5) => temperatureAt({ amplitude, nowMs, random: quiet });
    assert.equal(at(0), BASE_TEMPERATURE_C);
    assert.ok(Math.abs(at(PERIOD_MS / 4) - 25) < 1e-9);
    assert.ok(Math.abs(at((3 * PERIOD_MS) / 4) - 15) < 1e-9);
    assert.ok(Math.abs(at(PERIOD_MS / 4, 2) - 22) < 1e-9);
    assert.equal(at(PERIOD_MS / 4, 0), BASE_TEMPERATURE_C);
  });

  it('adds noise within its share of the amplitude', () => {
    const bound = 5 * (1 + TEMPERATURE_NOISE);
    for (const random of [() => 0, () => 0.999999, Math.random]) {
      for (let nowMs = 0; nowMs < PERIOD_MS; nowMs += 997) {
        const value = temperatureAt({ amplitude: 5, nowMs, random });
        assert.ok(Math.abs(value - BASE_TEMPERATURE_C) <= bound, `${value}`);
      }
    }
    assert.ok(temperatureAt({ amplitude: 5, nowMs: 0, random: () => 0 }) < BASE_TEMPERATURE_C);
  });
});

describe('pressureAt', () => {
  it('stays around 1013 hPa within the noise', () => {
    assert.equal(pressureAt(quiet), BASE_PRESSURE_HPA);
    assert.equal(
      pressureAt(() => 0),
      BASE_PRESSURE_HPA - PRESSURE_NOISE_HPA,
    );
    for (let i = 0; i < 1000; i++) {
      assert.ok(Math.abs(pressureAt(Math.random) - BASE_PRESSURE_HPA) <= PRESSURE_NOISE_HPA);
    }
  });
});
