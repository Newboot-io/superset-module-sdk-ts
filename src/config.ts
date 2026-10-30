import { readFileSync } from 'node:fs';
import { ConfigError, UnsupportedModeError } from './errors.js';
import { decodeUtf8, isObject, validSegment } from './validation.js';

/** Where Newboot mounts the module configuration, unless `MODULE_CONFIG` names another file. */
export const DEFAULT_CONFIG_PATH = '/etc/newboot/module.json';
export const CONFIG_PATH_ENV = 'MODULE_CONFIG';
/** The only broker authentication this version supports: a client certificate. */
export const MUTUAL_TLS = 'mutual-tls';

/**
 * `scheme://host[:port]`: scheme tcps or mqtts; host letters, digits, dots and dashes, or a
 * bracketed IPv6 literal; port 1-5 digits (range checked apart). Nothing else: no user, path,
 * query or fragment, no empty port.
 */
const BROKER_URL = /^(tcps|mqtts):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?$/;
const MAX_PORT = 65_535;
/** The broker port when `brokerUrl` names none. */
export const DEFAULT_BROKER_PORT = '8883';
const SECRET_SUFFIX = '.json';

/** Where this module runs: the ids its topics are built from. */
export interface Target {
  clusterId: string;
  moduleId: string;
  nodeId: string;
  tenantConfigId: string;
}

/** The module configuration Newboot renders into `module.json`, validated. */
export interface ModuleConfig {
  /** The broker, as `mqtts://host:port` (Newboot writes `tcps://`). */
  brokerUrl: string;
  /**
   * The module's own `configuration` object as given in `module.json`: `inputs`, `secretFiles`
   * and any other field the module's description adds. `{}` when absent.
   */
  configuration: Record<string, unknown>;
  /** Telemetry topics of the modules the superset links to this one. */
  inputs: string[];
  mqtt: { ca: string; identity: string; mode: typeof MUTUAL_TLS };
  /** One file per declared secret, `<name>.json`, holding the value as a JSON string. */
  secretFiles: string[];
  target: Target;
  /** Absent when the module has no twin endpoint. */
  twin?: { ca: string; endpoint: string; identity: string };
}

const isPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function filePath(value: unknown, field: string): string {
  if (!isPath(value)) throw new ConfigError(`module configuration: ${field} must be a file path`);
  return value;
}

function stringList(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`module configuration: ${field} must be a list`);
  return value;
}

/**
 * The broker URL as `mqtts://host:port`: exactly `scheme://host[:port]`, scheme `tcps` or
 * `mqtts`, no user, path, query or fragment, port 1-65535 (default 8883).
 */
export function parseBrokerUrl(value: unknown): string {
  const match = typeof value === 'string' ? BROKER_URL.exec(value) : null;
  const port = match?.[3] ?? DEFAULT_BROKER_PORT;
  if (!match || Number(port) < 1 || Number(port) > MAX_PORT) {
    throw new ConfigError('module configuration: brokerUrl must be tcps:// or mqtts://host[:port]');
  }
  return `mqtts://${match[2]}:${Number(port)}`;
}

/** Validates the text of `module.json`. Throws a {@link ConfigError} naming the field at fault. */
export function parseConfig(text: string): ModuleConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError('module configuration is not JSON');
  }
  if (!isObject(raw)) throw new ConfigError('module configuration must be an object');

  const { brokerUrl, configuration = {}, mqtt, target } = raw;
  // The mode first: a module set up for another mode gets a configuration this SDK cannot read
  // (no scheme in brokerUrl, no identity), and must learn why.
  if (!isObject(mqtt)) throw new ConfigError('module configuration: mqtt must be an object');
  if (mqtt.mode !== MUTUAL_TLS) {
    throw new UnsupportedModeError(
      `this SDK connects with ${MUTUAL_TLS} only, not ${JSON.stringify(mqtt.mode)}`,
    );
  }
  const twin = raw.twin ?? undefined; // `"twin": null` means no twin, as when absent
  const broker = parseBrokerUrl(brokerUrl);

  if (!isObject(target)) throw new ConfigError('module configuration: target must be an object');
  for (const field of ['clusterId', 'moduleId', 'nodeId', 'tenantConfigId']) {
    if (!validSegment(target[field])) {
      throw new ConfigError(`module configuration: target.${field} must be a topic level`);
    }
  }

  if (!isObject(configuration)) {
    throw new ConfigError('module configuration: configuration must be an object');
  }
  const inputs = stringList(configuration.inputs, 'configuration.inputs').map((topic) => {
    if (typeof topic !== 'string' || topic.length === 0 || /[+#\p{Cc}]/u.test(topic)) {
      throw new ConfigError(
        'module configuration: each input must be a topic without wildcards or control characters',
      );
    }
    return topic;
  });
  const secretFiles = stringList(configuration.secretFiles, 'configuration.secretFiles').map(
    (file) => {
      if (!isPath(file) || !file.endsWith(SECRET_SUFFIX)) {
        throw new ConfigError('module configuration: each secret file must end in .json');
      }
      return file;
    },
  );

  let twinConfig: ModuleConfig['twin'];
  if (twin !== undefined) {
    if (!isObject(twin)) throw new ConfigError('module configuration: twin must be an object');
    let endpoint: URL;
    try {
      if (typeof twin.endpoint !== 'string') throw new TypeError();
      endpoint = new URL(twin.endpoint);
    } catch {
      throw new ConfigError('module configuration: twin.endpoint must be a URL');
    }
    if (endpoint.protocol !== 'https:') {
      throw new ConfigError('module configuration: twin.endpoint must use https');
    }
    twinConfig = {
      ca: filePath(twin.ca, 'twin.ca'),
      endpoint: twin.endpoint as string, // as given: requested without normalisation
      identity: filePath(twin.identity, 'twin.identity'),
    };
  }

  return {
    brokerUrl: broker,
    configuration,
    inputs,
    mqtt: {
      ca: filePath(mqtt.ca, 'mqtt.ca'),
      identity: filePath(mqtt.identity, 'mqtt.identity'),
      mode: MUTUAL_TLS,
    },
    secretFiles,
    target: {
      clusterId: target.clusterId as string,
      moduleId: target.moduleId as string,
      nodeId: target.nodeId as string,
      tenantConfigId: target.tenantConfigId as string,
    },
    ...(twinConfig ? { twin: twinConfig } : {}),
  };
}

/** Reads and validates the module configuration: `MODULE_CONFIG`, else the default path. */
export function loadConfig(
  path = process.env[CONFIG_PATH_ENV] ?? DEFAULT_CONFIG_PATH,
): ModuleConfig {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new ConfigError(`module configuration ${path} cannot be read`);
  }
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    throw new ConfigError(`module configuration ${path} is not UTF-8`);
  }
  return parseConfig(text);
}
