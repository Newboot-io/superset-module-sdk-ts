// The simulation and the settings, as pure functions: main.ts wires them to the SDK.
import type { ModuleTwin } from '@newboot-io/superset-module-sdk';

export const DEFAULT_RATE_MS = 2000;
export const MIN_RATE_MS = 200;
export const DEFAULT_AMPLITUDE = 5;
/** One full temperature cycle. */
export const PERIOD_MS = 60_000;
export const BASE_TEMPERATURE_C = 20;
export const BASE_PRESSURE_HPA = 1013;
/** Noise, as a share of the amplitude for temperature, in hPa for pressure. */
export const TEMPERATURE_NOISE = 0.1;
export const PRESSURE_NOISE_HPA = 1;

/** The variable names this module owns: it finds their ids in the twin by these names. */
export const TEMPERATURE = 'temperature';
export const PRESSURE = 'pressure';

export interface Settings {
  amplitude: number;
  rateMs: number;
}

/**
 * The settings from the twin's fields. A missing or invalid one falls back to its default, and
 * its field name (never its value) is listed in `fallbacks`.
 */
export function readSettings(twin: ModuleTwin): { fallbacks: string[]; settings: Settings } {
  const fallbacks: string[] = [];
  const { amplitude, rateMs } = twin;
  const validRate = Number.isSafeInteger(rateMs) && (rateMs as number) >= MIN_RATE_MS;
  const validAmplitude = typeof amplitude === 'number' && Number.isFinite(amplitude);
  if (!validRate) fallbacks.push('rateMs');
  if (!validAmplitude) fallbacks.push('amplitude');
  return {
    fallbacks,
    settings: {
      amplitude: validAmplitude ? (amplitude as number) : DEFAULT_AMPLITUDE,
      rateMs: validRate ? (rateMs as number) : DEFAULT_RATE_MS,
    },
  };
}

/** The ids of the variables this module owns, found by their `name` in the twin. */
export function ownVariables(twin: ModuleTwin): { pressure?: string; temperature?: string } {
  const found: { pressure?: string; temperature?: string } = {};
  const variables = twin.variables ?? {};
  for (const id of Object.keys(variables)) {
    const name = variables[id]?.name;
    if (name === TEMPERATURE && found.temperature === undefined) found.temperature = id;
    if (name === PRESSURE && found.pressure === undefined) found.pressure = id;
  }
  return found;
}

/** A source of numbers in [0, 1), like Math.random: injected so tests are deterministic. */
export type Random = () => number;

/** Uniform noise in [-1, 1). */
const noise = (random: Random) => random() * 2 - 1;

/** °C: a sine around 20 over PERIOD_MS, plus noise, both scaled by `amplitude`. */
export function temperatureAt({
  amplitude,
  nowMs,
  random,
}: {
  amplitude: number;
  nowMs: number;
  random: Random;
}): number {
  const wave = Math.sin((2 * Math.PI * nowMs) / PERIOD_MS);
  return BASE_TEMPERATURE_C + amplitude * (wave + TEMPERATURE_NOISE * noise(random));
}

/** hPa: around 1013, plus noise. */
export const pressureAt = (random: Random): number =>
  BASE_PRESSURE_HPA + PRESSURE_NOISE_HPA * noise(random);
