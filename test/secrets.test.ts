import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readSecret, secretNames } from '../src/secrets.js';

const VALUE = 'p4ss-w0rd-value';

function secretDir(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-secret-'));
  const file = join(dir, 'device-password.json');
  writeFileSync(file, content);
  return { file, secretFiles: [file] };
}

/** The error a read throws, checked to name the secret and never quote its value. */
function refusal(content: string): string {
  const { secretFiles } = secretDir(content);
  try {
    readSecret({ name: 'device-password', secretFiles });
  } catch (error) {
    const { message, name } = error as Error;
    assert.equal(name, 'SecretError');
    assert.ok(message.startsWith('secret device-password '), message);
    assert.ok(!message.includes(VALUE), message);
    return message;
  }
  assert.fail('the secret was accepted');
}

describe('secrets', () => {
  it('names each secret after its file', () => {
    assert.deepEqual(secretNames(['/vault/material/a.json', '/vault/material/b-c.json']), [
      'a',
      'b-c',
    ]);
  });

  it('reads a JSON string value, again on every call', () => {
    const { file, secretFiles } = secretDir(JSON.stringify(VALUE));
    assert.equal(readSecret({ name: 'device-password', secretFiles }), VALUE);
    writeFileSync(file, JSON.stringify('rotated'));
    assert.equal(readSecret({ name: 'device-password', secretFiles }), 'rotated');
  });

  it('refuses a file that is not valid UTF-8, without quoting it', () => {
    const { file, secretFiles } = secretDir('');
    writeFileSync(
      file,
      Buffer.concat([Buffer.from(`"${VALUE}`), Buffer.from([0xff, 0xfe]), Buffer.from('"')]),
    );
    assert.throws(
      () => readSecret({ name: 'device-password', secretFiles }),
      (error: Error) =>
        error.name === 'SecretError' &&
        error.message === 'secret device-password cannot be read' &&
        !error.message.includes(VALUE),
    );
  });

  it('refuses a raw value without quoting it (a parse error would)', () => {
    assert.equal(refusal(VALUE), 'secret device-password cannot be read');
  });

  it('refuses JSON that is not a string', () => {
    assert.equal(
      refusal(JSON.stringify({ value: VALUE })),
      'secret device-password is not a string',
    );
  });

  it('refuses an empty file, malformed JSON and a file that is not on disk', () => {
    assert.equal(refusal(''), 'secret device-password cannot be read');
    assert.equal(refusal(`{"value": "${VALUE}"`), 'secret device-password cannot be read');
    assert.equal(refusal(`"${VALUE}`), 'secret device-password cannot be read');
    const missing = { name: 'device-password', secretFiles: ['/nonexistent/device-password.json'] };
    assert.throws(() => readSecret(missing), { message: 'secret device-password cannot be read' });
  });

  it('never passes on a read error, and refuses an undeclared secret', () => {
    const { secretFiles } = secretDir('');
    assert.throws(
      () =>
        readSecret({
          name: 'device-password',
          read: () => {
            throw new Error(VALUE);
          },
          secretFiles,
        }),
      {
        message: 'secret device-password cannot be read',
      },
    );
    assert.throws(() => readSecret({ name: 'other', secretFiles }), {
      message: 'secret other is not declared',
    });
  });
});
