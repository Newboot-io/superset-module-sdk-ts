import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import type { ModuleConfig } from './config.js';
import { TwinError } from './errors.js';
import { decodeUtf8, hasNonFinite, isObject } from './validation.js';

/** The whole fetch, connection to last byte, within the 15 s Newboot gives a reload. */
export const TWIN_TIMEOUT_MS = 12_000;
/** The largest twin answer a module accepts. */
export const MAX_TWIN_BYTES = 2 * 1024 * 1024;
/** Sent with a reload's correlation id, so the twin endpoint can tie its logs to the command. */
export const CORRELATION_HEADER = 'x-newboot-correlation-id';

const CORRELATION_ID = /^[A-Za-z0-9-]+$/;

/** A variable of the module twin: at least its display name and model, when set. */
export type Variable = { modelId?: unknown; name?: unknown } & Record<string, unknown>;

/** This module's twin: the fields saved in the console and its variables, keyed by variable id. */
export type ModuleTwin = { variables?: Record<string, Variable> } & Record<string, unknown>;

/**
 * Validates the twin endpoint's answer: exactly one module, this one, whose variables (if any)
 * are an object, and no number in it is infinite. Returns that module's twin.
 */
export function parseTwinAnswer({
  body,
  moduleId,
}: {
  body: string;
  moduleId: string;
}): ModuleTwin {
  let modules: unknown;
  try {
    const answer: unknown = JSON.parse(body);
    // A number JSON.parse turned into Infinity (`1e400`) anywhere makes the answer invalid.
    modules = isObject(answer) && !hasNonFinite(answer) ? answer.modules : undefined;
  } catch {
    // Not JSON, or nested too deep to parse.
  }
  const ours =
    isObject(modules) && Object.hasOwn(modules, moduleId) ? modules[moduleId] : undefined;
  if (
    !isObject(modules) ||
    Object.keys(modules).length !== 1 ||
    !isObject(ours) ||
    !(ours.variables === undefined || isObject(ours.variables))
  ) {
    throw new TwinError('the twin answer is not this module’s');
  }
  return ours as ModuleTwin;
}

/**
 * Host, port and path of an `https://` endpoint, the path (with `;params` and query) taken from
 * the string exactly as given: a URL parser would normalise it (`/./`, `..`, percent-encoding).
 */
export function requestTarget(endpoint: string): { host: string; path: string; port: number } {
  const url = new URL(endpoint);
  const afterScheme = endpoint.slice(endpoint.indexOf('//') + 2);
  const start = afterScheme.search(/[/?#]/);
  const rest = start < 0 ? '' : afterScheme.slice(start).split('#')[0];
  const path = rest.startsWith('/') ? rest : `/${rest}`;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), path, port: Number(url.port || 443) };
}

/** The correlation id header, for an id made of letters, digits and dashes only. */
export const correlationHeaders = (correlationId?: string): Record<string, string> =>
  correlationId && CORRELATION_ID.test(correlationId)
    ? { [CORRELATION_HEADER]: correlationId }
    : {};

/**
 * Fetches this module's twin over HTTPS with its client certificate. The certificate files are
 * read again for every request: they rotate while a module runs.
 */
export function fetchTwin({
  config,
  correlationId,
  maxBytes = MAX_TWIN_BYTES,
  timeoutMs = TWIN_TIMEOUT_MS,
}: {
  config: ModuleConfig;
  correlationId?: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<ModuleTwin> {
  const twin = config.twin;
  if (!twin) return Promise.reject(new TwinError('this module has no twin endpoint'));
  return new Promise((resolve, reject) => {
    let identity: Buffer;
    let ca: Buffer;
    try {
      identity = readFileSync(twin.identity); // certificate, chain and key in one file
      ca = readFileSync(twin.ca);
    } catch {
      reject(new TwinError('the twin certificates cannot be read'));
      return;
    }
    let get: ReturnType<typeof request>;
    try {
      get = request({
        ...requestTarget(twin.endpoint),
        ca,
        cert: identity,
        headers: correlationHeaders(correlationId),
        key: identity,
      });
    } catch {
      // A corrupt certificate or key, or a path Node refuses: never pass the library's error on.
      reject(new TwinError('the twin request cannot be built'));
      return;
    }
    let settled = false;
    const deadline = setTimeout(
      () => get.destroy(new TwinError('the twin request timed out')),
      timeoutMs,
    );
    const fail = (error: Error) => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(error instanceof TwinError ? error : new TwinError(`twin request: ${error.message}`));
    };
    get.on('error', fail);
    get.on('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size <= maxBytes) {
          chunks.push(chunk);
          return;
        }
        fail(new TwinError('the twin answer is too large'));
        get.destroy();
      });
      response.on('error', fail);
      // A connection that drops mid-body ends without 'end': fail it, or a reload waits forever.
      response.on('close', () => {
        if (!response.complete) fail(new TwinError('the twin answer was cut short'));
      });
      response.on('end', () => {
        clearTimeout(deadline);
        if (settled) return;
        settled = true;
        if (response.statusCode !== 200) {
          reject(new TwinError(`the twin endpoint answered HTTP ${response.statusCode}`));
          return;
        }
        let body: string;
        try {
          body = decodeUtf8(Buffer.concat(chunks));
        } catch {
          reject(new TwinError('the twin answer is not UTF-8'));
          return;
        }
        try {
          resolve(parseTwinAnswer({ body, moduleId: config.target.moduleId }));
        } catch (error) {
          reject(error);
        }
      });
    });
    get.end();
  });
}
