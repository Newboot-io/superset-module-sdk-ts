/**
 * The base of every error the SDK throws or rejects with: ConfigError (and UnsupportedModeError),
 * SecretError, TwinError, TelemetryError. Messages never quote a secret or a file's content.
 */
export class SdkError extends Error {
  override name = 'SdkError';
}

/** The module configuration file is missing, is not JSON, or does not hold what a module needs. */
export class ConfigError extends SdkError {
  override name = 'ConfigError';
}

/** The module uses a broker access mode this SDK does not support (only `mutual-tls`). */
export class UnsupportedModeError extends ConfigError {
  override name = 'UnsupportedModeError';
}

/** A secret is not declared, cannot be read, or is not a JSON string. */
export class SecretError extends SdkError {
  override name = 'SecretError';
}

/** The module twin could not be fetched, or the answer is not this module's twin. */
export class TwinError extends SdkError {
  override name = 'TwinError';
}

/** A telemetry message breaks the payload rules. */
export class TelemetryError extends SdkError {
  override name = 'TelemetryError';
}
