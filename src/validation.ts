/**
 * Decodes UTF-8 strictly: invalid bytes throw (a `TypeError`) instead of turning into U+FFFD, and
 * a byte order mark is kept, so JSON.parse refuses it as the other SDKs do.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const decodeUtf8 = (bytes: Uint8Array): string => UTF8.decode(bytes);

/** Topic levels and ids are at most this many bytes. */
export const MAX_SEGMENT_BYTES = 200;

/** A scalar telemetry value: what a module sends and receives, alone or in an array. */
export type Scalar = boolean | number | string;

/** A telemetry value: a scalar, or an array of scalars (as an OPC UA array variable sends). */
export type TelemetryValue = Scalar | Scalar[];

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A topic level or id: non-empty, at most 200 bytes, no control character, `/`, `+` or `#`. */
export const validSegment = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= MAX_SEGMENT_BYTES &&
  !/[/+#\p{Cc}]/u.test(value);

/** A boolean, a string or a number finite as a double (JSON `1e400` parses to Infinity). */
export const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'boolean' ||
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value));

/** A scalar or an array of scalars; anything nested is not a telemetry value. */
export const isTelemetryValue = (value: unknown): value is TelemetryValue =>
  isScalar(value) || (Array.isArray(value) && value.every(isScalar));

/**
 * True when a number that is not finite (JSON `1e400` parses to Infinity) sits anywhere in a parsed
 * JSON value. Walks iteratively: a deeply nested answer cannot overflow the stack.
 */
export function hasNonFinite(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return true;
    } else if (Array.isArray(item)) {
      // A loop, not push(...item): spreading a large array overflows the call's argument limit.
      for (const element of item) stack.push(element);
    } else if (isObject(item)) {
      for (const key in item) stack.push(item[key]);
    }
  }
  return false;
}

/** What each telemetry field must be: the same rules when sending and when receiving. */
export const TELEMETRY_RULES = {
  name: 'name must be a string',
  timestamp: 'timestamp must be an integer from 0 to 2^53-1 (epoch milliseconds)',
  value: 'value must be a finite number, a string, a boolean or an array of those',
  variableId: 'variableId must be a non-empty id of at most 200 bytes without / + # or controls',
} as const;

/** The first telemetry field that breaks the payload rules, or undefined when all hold. */
export function invalidTelemetryField({
  name,
  timestamp,
  value,
  variableId,
}: {
  name?: unknown;
  timestamp?: unknown;
  value?: unknown;
  variableId?: unknown;
} = {}): keyof typeof TELEMETRY_RULES | undefined {
  if (!validSegment(variableId)) return 'variableId';
  if (!isTelemetryValue(value)) return 'value';
  // Number.isSafeInteger: an integral JSON number (1.7e12 too) from -(2^53-1) to 2^53-1.
  if (timestamp !== undefined && !(Number.isSafeInteger(timestamp) && (timestamp as number) >= 0)) {
    return 'timestamp';
  }
  if (name !== undefined && typeof name !== 'string') return 'name';
  return undefined;
}
