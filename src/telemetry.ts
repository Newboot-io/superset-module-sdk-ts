import { TelemetryError } from './errors.js';
import type { ModuleTwin } from './twin.js';
import {
  invalidTelemetryField,
  isObject,
  TELEMETRY_RULES,
  type TelemetryValue,
} from './validation.js';

/** What a module sends for one of its variables. */
export interface Telemetry {
  /** Defaults to the variable's name in the last twin fetched; left out when there is none. */
  name?: string;
  /** Epoch milliseconds, an integer >= 0; defaults to now. */
  timestamp?: number;
  value: TelemetryValue;
  /** A key of `variables` in the module twin. */
  variableId: string;
}

/**
 * The JSON body of one telemetry message: `{name?, timestamp, value, variableId}`. `name` defaults
 * to the variable's name in the twin fetched last, and is left out when there is none.
 */
export function telemetryPayload({
  now,
  telemetry,
  twin,
}: {
  now: number;
  telemetry: Telemetry;
  twin?: ModuleTwin;
}): string {
  if (!isObject(telemetry)) throw new TelemetryError('invalid telemetry: must be an object');
  const field = invalidTelemetryField(telemetry);
  if (field) throw new TelemetryError(`invalid telemetry: ${TELEMETRY_RULES[field]}`);
  const { timestamp = now, value, variableId } = telemetry;
  const variables = twin?.variables;
  // Own keys only: `constructor` or `__proto__` must not find Object's members.
  const variable =
    variables && Object.hasOwn(variables, variableId) ? variables[variableId] : undefined;
  const twinName =
    isObject(variable) && Object.hasOwn(variable, 'name') ? variable.name : undefined;
  const name = telemetry.name ?? (typeof twinName === 'string' ? twinName : undefined);
  return JSON.stringify({ ...(name === undefined ? {} : { name }), timestamp, value, variableId });
}
