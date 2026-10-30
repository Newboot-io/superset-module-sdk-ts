import type { Target } from './config.js';
import type { Topics } from './topics.js';
import {
  decodeUtf8,
  hasNonFinite,
  invalidTelemetryField,
  isObject,
  type TelemetryValue,
  validSegment,
} from './validation.js';

/** Commands, and the data messages this SDK accepts on input topics, are at most 8 KiB. */
export const MAX_MESSAGE_BYTES = 8192;
/** A command issued up to this far in the future is still on time (clock skew). */
export const MAX_CLOCK_SKEW_MS = 1000;
/** A command lives at most this long. */
export const MAX_TTL_MS = 30_000;
export const DELIVERIES: readonly string[] = ['broadcast', 'unicast'];
export const RELOAD_COMMAND = 'reload';
export const RELOAD_FAILED = 'reload_failed';
export const INVALID_PAYLOAD = 'invalid_payload';

/**
 * A received message as a JSON object, or undefined for what a module drops: a retained message
 * (stored, not live), one over 8 KiB, one that is not JSON or not an object.
 */
export function decodeMessage({
  payload,
  retain,
}: {
  payload: Buffer;
  retain: boolean;
}): Record<string, unknown> | undefined {
  if (retain || payload.length > MAX_MESSAGE_BYTES) return undefined;
  try {
    // Invalid UTF-8 throws here, and the message is dropped.
    const message: unknown = JSON.parse(decodeUtf8(payload));
    return isObject(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

/** A telemetry message from a linked module. */
export interface TelemetryMessage {
  name?: string;
  /** Epoch milliseconds, as the sender set it. */
  timestamp?: number;
  /** The input topic it arrived on: one per linked module. */
  topic: string;
  value: TelemetryValue;
  variableId: string;
}

/**
 * A linked module's message, or undefined when it breaks the telemetry payload rules (the same
 * rules `sendTelemetry` applies): a valid `variableId`, a scalar or array-of-scalars `value`, an
 * optional integer `timestamp` >= 0 and an optional string `name`.
 */
export function parseTelemetry({
  message,
  topic,
}: {
  message: Record<string, unknown>;
  topic: string;
}): TelemetryMessage | undefined {
  if (invalidTelemetryField(message) || hasNonFinite(message)) return undefined;
  const { name, timestamp, value, variableId } = message as {
    name?: string;
    timestamp?: number;
    value: TelemetryValue;
    variableId: string;
  };
  return {
    ...(name === undefined ? {} : { name }),
    ...(timestamp === undefined ? {} : { timestamp }),
    topic,
    value,
    variableId,
  };
}

/** A command addressed to this module and on time. */
export interface Command {
  command: string;
  correlationId: string;
  delivery: string;
  expiresAtUnixMs: number;
  issuedAtUnixMs: number;
  payload: unknown;
  replyTopic: string;
  target: Record<string, unknown>;
}

/** Issued by now (1 s of clock skew allowed), valid at most 30 s, not yet expired. */
export function onTime({
  expires,
  issued,
  now,
}: {
  expires: unknown;
  issued: unknown;
  now: number;
}): boolean {
  return (
    Number.isSafeInteger(issued) &&
    Number.isSafeInteger(expires) &&
    (issued as number) <= now + MAX_CLOCK_SKEW_MS &&
    (expires as number) > now &&
    (expires as number) > (issued as number) &&
    (expires as number) - (issued as number) <= MAX_TTL_MS
  );
}

/** Exactly this module's cluster, module and tenant: no more keys, no fewer. */
export const sameTarget = ({ target, value }: { target: Target; value: unknown }): boolean =>
  isObject(value) &&
  Object.keys(value).length === 3 &&
  value.clusterId === target.clusterId &&
  value.moduleId === target.moduleId &&
  value.tenantConfigId === target.tenantConfigId;

/**
 * The command in a message received on `topic`, or undefined when a module must not answer it:
 * not addressed to this module (topic, reply topic or target differ) or not on time. Unknown
 * keys are ignored, which stays compatible with a longer envelope.
 */
export function parseCommand({
  message,
  now,
  target,
  topic,
  topics,
}: {
  message: Record<string, unknown>;
  now: number;
  target: Target;
  topic: string;
  topics: Topics;
}): Command | undefined {
  const { command, correlationId, delivery, expiresAtUnixMs, issuedAtUnixMs, payload, replyTopic } =
    message;
  const addressed =
    validSegment(correlationId) &&
    validSegment(command) &&
    typeof delivery === 'string' &&
    DELIVERIES.includes(delivery) &&
    topic === `${topics.command}/${delivery}/${command}` &&
    replyTopic === `${topics.reply}/${correlationId}` &&
    sameTarget({ target, value: message.target });
  if (!addressed || !onTime({ expires: expiresAtUnixMs, issued: issuedAtUnixMs, now })) {
    return undefined;
  }
  return {
    command,
    correlationId,
    delivery,
    expiresAtUnixMs: expiresAtUnixMs as number,
    issuedAtUnixMs: issuedAtUnixMs as number,
    payload,
    replyTopic,
    target: message.target as Record<string, unknown>,
  };
}

/** A command's answer: a result, or a short error code. */
export type Answer = { error: string } | { result: unknown };

/** The reply body: exactly the correlation id, the target and a result or an error. */
export const replyBody = ({ answer, command }: { answer: Answer; command: Command }): string =>
  JSON.stringify({ correlationId: command.correlationId, target: command.target, ...answer });
