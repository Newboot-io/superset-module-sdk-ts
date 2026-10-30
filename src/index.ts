export {
  MAX_PACKET_BYTES,
  ModuleClient,
  type ModuleClientOptions,
  RECONNECT_AFTER_MS,
  type TelemetryHandler,
  type TwinChangeHandler,
} from './client.js';
export {
  CONFIG_PATH_ENV,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  type ModuleConfig,
  MUTUAL_TLS,
  parseBrokerUrl,
  parseConfig,
  type Target,
} from './config.js';
export {
  ConfigError,
  SdkError,
  SecretError,
  TelemetryError,
  TwinError,
  UnsupportedModeError,
} from './errors.js';
export {
  type Answer,
  type Command,
  decodeMessage,
  MAX_MESSAGE_BYTES,
  onTime,
  parseCommand,
  parseTelemetry,
  RELOAD_COMMAND,
  replyBody,
  type TelemetryMessage,
} from './messages.js';
export { readSecret, secretNames } from './secrets.js';
export { type Telemetry, telemetryPayload } from './telemetry.js';
export { type Topics, topicsFor } from './topics.js';
export { CORRELATION_HEADER, type ModuleTwin, parseTwinAnswer, type Variable } from './twin.js';
export { isTelemetryValue, type Scalar, type TelemetryValue, validSegment } from './validation.js';
