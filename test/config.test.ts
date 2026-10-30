import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig, parseBrokerUrl, parseConfig } from '../src/config.js';
import { ConfigError, UnsupportedModeError } from '../src/errors.js';
import { INPUT, rendered, TARGET } from './fixtures.js';

const parse = (value: unknown) => parseConfig(JSON.stringify(value));

describe('parseConfig', () => {
  it('reads what Newboot renders, with the broker URL as mqtts://', () => {
    const config = parse(rendered());
    assert.equal(config.brokerUrl, 'mqtts://broker:8883');
    assert.deepEqual(config.inputs, [INPUT]);
    assert.deepEqual(config.secretFiles, ['/vault/material/device-password.json']);
    assert.deepEqual(config.target, TARGET);
    assert.equal(config.twin?.endpoint, 'https://twin/twin');
    assert.equal(config.mqtt.identity, '/vault/material/mqtt-client.pem');
  });

  it('accepts a module without twin, inputs or secrets', () => {
    const config = parse(rendered({ configuration: undefined, twin: undefined }));
    assert.equal(config.twin, undefined);
    assert.deepEqual(config.inputs, []);
    assert.deepEqual(config.secretFiles, []);
  });

  it('refuses any broker authentication but mutual TLS, naming the mode', () => {
    const token = { ca: '/ca', mode: 'token', token: '/token' };
    assert.throws(() => parse(rendered({ mqtt: token })), {
      message: 'this SDK connects with mutual-tls only, not "token"',
      name: 'UnsupportedModeError',
    });
    assert.throws(() => parse(rendered({ mqtt: token })), ConfigError, 'a ConfigError too');
  });

  it('keeps the twin endpoint exactly as given', () => {
    const endpoint = 'https://twin/a/./b/../c;v=1?q=%7e&x';
    const twin = { ca: '/ca', endpoint, identity: '/id' };
    assert.equal(parse(rendered({ twin })).twin?.endpoint, endpoint);
    assert.throws(
      () => parse(rendered({ twin: { ...twin, endpoint: 7 } })),
      /twin.endpoint must be a URL/,
    );
  });

  it('treats "twin": null as no twin', () => {
    assert.equal(parse(rendered({ twin: null })).twin, undefined);
  });

  // The shared host/port table: the same cases in every SDK.
  const BROKER_ACCEPT: [string, string][] = [
    ['tcps://broker', 'mqtts://broker:8883'],
    ['mqtts://broker:8883', 'mqtts://broker:8883'],
    ['tcps://mq.example.com:1', 'mqtts://mq.example.com:1'],
    ['tcps://10.0.0.1:65535', 'mqtts://10.0.0.1:65535'],
    ['tcps://[::1]:8883', 'mqtts://[::1]:8883'],
    ['tcps://[::1]', 'mqtts://[::1]:8883'],
    ['tcps://[1.2.3.4]', 'mqtts://[1.2.3.4]:8883'],
  ];
  const BROKER_REFUSE = [
    'tcp://broker:8883',
    'tcps://broker:',
    'tcps://broker:0',
    'tcps://broker:65536',
    'tcps://broker:+8883',
    'tcps://broker:8883/',
    'tcps://broker:8883/x',
    'tcps://u:p@broker:8883',
    'tcps://broker:8883?x=1',
    'tcps://broker:8883#f',
    'tcps://a_b:8883',
    'tcps://b;x:8883',
    'tcps://h%41:8883',
    'tcps://bröker:8883',
    'tcps://broker\u0000:8883',
    'tcps://:8883',
    'tcps://[::1:8883',
    'broker:8883',
    'tcps://broker:8883\n',
    'tcps://bro\tker:8883',
    ' tcps://broker',
    'tcps://broker:8883 ',
  ];

  for (const [brokerUrl, expected] of BROKER_ACCEPT) {
    it(`accepts brokerUrl ${brokerUrl}`, () => {
      assert.equal(parseBrokerUrl(brokerUrl), expected);
      assert.equal(parse(rendered({ brokerUrl })).brokerUrl, expected);
    });
  }

  for (const brokerUrl of BROKER_REFUSE) {
    it(`refuses brokerUrl ${JSON.stringify(brokerUrl)}`, () => {
      assert.throws(() => parse(rendered({ brokerUrl })), {
        message: 'module configuration: brokerUrl must be tcps:// or mqtts://host[:port]',
        name: 'ConfigError',
      });
    });
  }

  it('checks the mode first, on the configuration a module set up for another mode gets', () => {
    const tokenShaped = {
      brokerUrl: 'other-broker:18884',
      mqtt: { ca: '/etc/newboot/ca/mqtt-ca.crt', mode: 'token' },
      target: TARGET,
    };
    assert.throws(() => parse(tokenShaped), {
      message: 'this SDK connects with mutual-tls only, not "token"',
      name: 'UnsupportedModeError',
    });
    const { mode: _mode, ...modeless } = tokenShaped.mqtt;
    assert.throws(() => parse({ ...tokenShaped, mqtt: modeless }), UnsupportedModeError, 'missing');
    for (const mode of [undefined, null, '', 'MUTUAL-TLS', 7, true, ['mutual-tls']]) {
      const mqtt = { ...tokenShaped.mqtt, mode };
      assert.throws(() => parse({ ...tokenShaped, mqtt }), UnsupportedModeError, String(mode));
    }
  });

  it('requires every path to be a non-empty string', () => {
    const cases: Record<string, unknown>[] = [
      { mqtt: { ca: '', identity: '/id', mode: 'mutual-tls' } },
      { mqtt: { ca: '/ca', identity: 7, mode: 'mutual-tls' } },
      { twin: { ca: '', endpoint: 'https://twin/twin', identity: '/id' } },
      { twin: { ca: '/ca', endpoint: 'https://twin/twin', identity: null } },
      { configuration: { secretFiles: [''] } },
      { configuration: { secretFiles: [7] } },
    ];
    for (const override of cases) {
      assert.throws(() => parse(rendered(override)), ConfigError, JSON.stringify(override));
    }
  });

  it('refuses control characters in ids and inputs', () => {
    for (const moduleId of ['a\u0007b', 'a\nb', 'a\u007fb']) {
      assert.throws(() => parse(rendered({ target: { ...TARGET, moduleId } })), /target.moduleId/);
    }
    for (const input of ['output/telemetry/a\nb/v', 'output/\u0000/v']) {
      assert.throws(
        () => parse(rendered({ configuration: { inputs: [input] } })),
        /without wildcards or control characters/,
      );
    }
  });

  it('defaults the broker port to 8883 and keeps an explicit one', () => {
    assert.equal(parse(rendered({ brokerUrl: 'tcps://broker' })).brokerUrl, 'mqtts://broker:8883');
    assert.equal(
      parse(rendered({ brokerUrl: 'mqtts://broker:18883' })).brokerUrl,
      'mqtts://broker:18883',
    );
  });

  it('refuses a broker without TLS and a twin endpoint without https', () => {
    assert.throws(() => parse(rendered({ brokerUrl: 'tcp://broker:1883' })), ConfigError);
    const twin = { ca: '/ca', endpoint: 'http://twin/twin', identity: '/id' };
    assert.throws(() => parse(rendered({ twin })), /twin.endpoint must use https/);
  });

  it('refuses target ids that cannot be topic levels', () => {
    for (const moduleId of ['', 'a/b', 'a+', '#', 'a\u0000', 'x'.repeat(201), 7]) {
      assert.throws(() => parse(rendered({ target: { ...TARGET, moduleId } })), /target.moduleId/);
    }
  });

  it('refuses wildcard inputs and secret files that are not .json', () => {
    const wildcard = { inputs: ['output/telemetry/#'] };
    assert.throws(() => parse(rendered({ configuration: wildcard })), /without wildcards/);
    const secret = { secretFiles: ['/vault/material/password.txt'] };
    assert.throws(() => parse(rendered({ configuration: secret })), /end in .json/);
  });

  it('refuses missing or malformed fields, naming them', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ brokerUrl: undefined }, /brokerUrl must be tcps/],
      [{ brokerUrl: 'not a url' }, /brokerUrl must be tcps/],
      [{ mqtt: undefined }, /mqtt must be an object/],
      [{ mqtt: { identity: '/id', mode: 'mutual-tls' } }, /mqtt.ca must be a file path/],
      [
        { mqtt: { ca: '/ca', identity: '', mode: 'mutual-tls' } },
        /mqtt.identity must be a file path/,
      ],
      [{ target: undefined }, /target must be an object/],
      [{ target: { ...TARGET, nodeId: undefined } }, /target.nodeId/],
      [{ configuration: [] }, /configuration must be an object/],
      [{ configuration: { inputs: 'a/b' } }, /configuration.inputs must be a list/],
      [{ configuration: { inputs: [''] } }, /without wildcards/],
      [{ configuration: { secretFiles: {} } }, /configuration.secretFiles must be a list/],
      [{ twin: 'https://twin' }, /twin must be an object/],
      [{ twin: { ca: '/ca', identity: '/id' } }, /twin.endpoint must be a URL/],
      [{ twin: { ca: '/ca', endpoint: 'https://twin/twin' } }, /twin.identity must be a file path/],
    ];
    for (const [override, message] of cases) {
      assert.throws(
        () => parse(rendered(override)),
        { message, name: 'ConfigError' },
        String(message),
      );
    }
  });

  it('refuses text that is not a JSON object', () => {
    assert.throws(() => parseConfig('{'), { message: 'module configuration is not JSON' });
    assert.throws(() => parseConfig('[]'), /must be an object/);
  });
});

describe('loadConfig', () => {
  it('reads the file it is given, and names a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-config-'));
    const path = join(dir, 'module.json');
    writeFileSync(path, JSON.stringify(rendered()));
    assert.equal(loadConfig(path).target.moduleId, 'my-module');
    assert.throws(() => loadConfig(join(dir, 'nope.json')), /nope.json cannot be read/);
  });
});
