import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SecretError } from './errors.js';
import { decodeUtf8 } from './validation.js';

const SUFFIX = '.json';

/** The names of the declared secrets: each file `<name>.json` holds one. */
export const secretNames = (secretFiles: readonly string[]): string[] =>
  secretFiles.map((file) => basename(file, SUFFIX));

/**
 * One secret by name, read from its file now: a new value replaces the file while a module runs.
 * Errors name the secret only, never its value nor a parse error (which can quote the file).
 */
export function readSecret({
  name,
  // Strict UTF-8: invalid bytes fail the read instead of becoming U+FFFD.
  read = (path) => decodeUtf8(readFileSync(path)),
  secretFiles,
}: {
  name: string;
  read?: (path: string) => string;
  secretFiles: readonly string[];
}): string {
  const file = secretFiles.find((path) => basename(path) === `${name}${SUFFIX}`);
  if (!file) throw new SecretError(`secret ${name} is not declared`);
  let value: unknown;
  try {
    value = JSON.parse(read(file));
  } catch {
    throw new SecretError(`secret ${name} cannot be read`);
  }
  if (typeof value !== 'string') throw new SecretError(`secret ${name} is not a string`);
  return value;
}
