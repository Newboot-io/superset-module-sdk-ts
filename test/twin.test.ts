import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.js';
import { TwinError } from '../src/errors.js';
import {
  CORRELATION_HEADER,
  correlationHeaders,
  fetchTwin,
  MAX_TWIN_BYTES,
  parseTwinAnswer,
  requestTarget,
} from '../src/twin.js';
import { rendered } from './fixtures.js';
import { CA, CLIENT_PEM, twinServer } from './helpers.js';

const configFor = (endpoint: string) =>
  parseConfig(JSON.stringify(rendered({ twin: { ca: CA, endpoint, identity: CLIENT_PEM } })));
const ANSWER = {
  modules: { 'my-module': { serverport: 4840, variables: { v: { name: 'Temp' } } } },
};

const MODULE = 'my-module';
const parse = (answer: unknown) =>
  parseTwinAnswer({ body: JSON.stringify(answer), moduleId: MODULE });

describe('parseTwinAnswer', () => {
  it('returns this module’s twin with its fields and variables', () => {
    const module = {
      serverport: 4840,
      variables: { 'variable-1': { modelId: 'dtmi:x;1', name: 'Temp' } },
    };
    assert.deepEqual(parse({ modules: { [MODULE]: module }, path: '/site/scope' }), module);
    assert.deepEqual(parse({ modules: { [MODULE]: { active: true } } }), { active: true });
  });

  it('refuses an answer with 1e400 anywhere', () => {
    for (const body of [
      '{"modules": {"my-module": {"serverport": 1e400}}}',
      '{"modules": {"my-module": {"variables": {"v": {"limits": [1, -1e400]}}}}}',
      '{"modules": {"my-module": {}}, "path": 1e400}',
    ]) {
      assert.throws(() => parseTwinAnswer({ body, moduleId: MODULE }), TwinError, body);
    }
  });

  it('accepts a valid answer with a 200k-element array', () => {
    const big = Array.from({ length: 200_000 }, (_, index) => index % 10);
    const body = JSON.stringify({ modules: { [MODULE]: { samples: big } } });
    assert.ok(body.length < MAX_TWIN_BYTES);
    assert.equal((parse(JSON.parse(body)).samples as number[]).length, 200_000);
    const infinite = body.replace(/,9\]\}\}\}$/, ',1e400]}}}');
    assert.notEqual(infinite, body);
    assert.throws(() => parseTwinAnswer({ body: infinite, moduleId: MODULE }), TwinError);
  });

  it('finds this module by its own key only', () => {
    const inherited = (moduleId: string) => () =>
      parseTwinAnswer({ body: JSON.stringify({ modules: { other: {} } }), moduleId });
    assert.throws(inherited('constructor'), TwinError);
    assert.throws(inherited('__proto__'), TwinError);
  });

  it('refuses any answer but exactly one module, this one, with object variables', () => {
    const refused = [
      [1],
      { modules: {} },
      { modules: { other: {} } },
      { modules: { [MODULE]: {}, other: {} } },
      { modules: { [MODULE]: [] } },
      { modules: { [MODULE]: { variables: [] } } },
      { modules: { [MODULE]: { variables: 'x' } } },
    ];
    for (const answer of refused)
      assert.throws(() => parse(answer), TwinError, JSON.stringify(answer));
    assert.throws(() => parseTwinAnswer({ body: 'not json', moduleId: MODULE }), TwinError);
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    assert.throws(() => parseTwinAnswer({ body: deep, moduleId: MODULE }), TwinError);
  });
});

describe('requestTarget', () => {
  it('takes the path, params and query exactly as given, without the fragment', () => {
    const cases: [string, { host: string; path: string; port: number }][] = [
      ['https://twin/twin', { host: 'twin', path: '/twin', port: 443 }],
      ['https://twin', { host: 'twin', path: '/', port: 443 }],
      ['https://twin?x=1', { host: 'twin', path: '/?x=1', port: 443 }],
      [
        'https://twin:8443/a/./b/../c;v=1?q=%7e&x#frag',
        { host: 'twin', path: '/a/./b/../c;v=1?q=%7e&x', port: 8443 },
      ],
      ['https://[::1]:9443/t', { host: '::1', path: '/t', port: 9443 }],
    ];
    for (const [endpoint, expected] of cases) {
      assert.deepEqual(requestTarget(endpoint), expected, endpoint);
    }
  });
});

describe('correlationHeaders', () => {
  it('passes a plain correlation id on, and drops one that could inject a header', () => {
    assert.deepEqual(correlationHeaders('reload-1'), { [CORRELATION_HEADER]: 'reload-1' });
    assert.deepEqual(correlationHeaders('a\r\nx: y'), {});
    assert.deepEqual(correlationHeaders(undefined), {});
  });
});

describe('fetchTwin', () => {
  it('rejects with a TwinError when no twin is configured', async () => {
    const config = parseConfig(JSON.stringify(rendered({ twin: undefined })));
    await assert.rejects(fetchTwin({ config }), {
      message: 'this module has no twin endpoint',
      name: 'TwinError',
    });
  });

  it('rejects when the certificate files cannot be read', async () => {
    const twin = {
      ca: '/nonexistent/ca',
      endpoint: 'https://twin/twin',
      identity: '/nonexistent/id',
    };
    const config = parseConfig(JSON.stringify(rendered({ twin })));
    await assert.rejects(fetchTwin({ config }), {
      message: 'the twin certificates cannot be read',
    });
  });
});

describe('fetchTwin over HTTPS', () => {
  it('presents the client certificate, passes the correlation id and returns the twin', async (t) => {
    const seen: { cn?: string; correlation?: string } = {};
    const twin = await twinServer((request, response) => {
      const socket = request.socket as import('node:tls').TLSSocket;
      seen.cn = socket.getPeerCertificate().subject?.CN as string;
      seen.correlation = request.headers[CORRELATION_HEADER] as string;
      response.end(JSON.stringify(ANSWER));
    });
    t.after(twin.close);
    const fetched = await fetchTwin({
      config: configFor(twin.endpoint),
      correlationId: 'reload-7',
    });
    assert.deepEqual(fetched, ANSWER.modules['my-module']);
    assert.deepEqual(seen, { cn: 'client', correlation: 'reload-7' });
  });

  it('requests the endpoint’s path and query string as given', async (t) => {
    let seen: string | undefined;
    const twin = await twinServer((request, response) => {
      seen = request.url;
      response.end(JSON.stringify(ANSWER));
    });
    t.after(twin.close);
    await fetchTwin({ config: configFor(`${twin.endpoint}/./sub/..;v=1?site=a&x=%2F&y=%7e`) });
    assert.equal(seen, '/twin/./sub/..;v=1?site=a&x=%2F&y=%7e');
  });

  it('rejects with a TwinError, never a library error, for a corrupt certificate or key', async (t) => {
    const twin = await twinServer((_request, response) => response.end(JSON.stringify(ANSWER)));
    t.after(twin.close);
    const dir = mkdtempSync(join(tmpdir(), 'sdk-corrupt-'));
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const corrupt = join(dir, 'corrupt.pem');
    writeFileSync(
      corrupt,
      '-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n',
    );
    for (const twinConfig of [
      { ca: CA, endpoint: twin.endpoint, identity: corrupt },
      { ca: corrupt, endpoint: twin.endpoint, identity: CLIENT_PEM },
    ]) {
      const config = parseConfig(JSON.stringify(rendered({ twin: twinConfig })));
      await assert.rejects(fetchTwin({ config }), (error: Error) => error instanceof TwinError);
    }
  });

  it('rejects an HTTP error, a redirect and another module’s answer', async (t) => {
    const answers: [number, unknown][] = [
      [500, ''],
      [302, ANSWER],
      [200, { modules: { other: {} } }],
      [200, { modules: { ...ANSWER.modules, other: {} } }],
    ];
    let index = 0;
    const twin = await twinServer((_request, response) => {
      const [status, body] = answers[index++] as [number, unknown];
      response.writeHead(status).end(JSON.stringify(body));
    });
    t.after(twin.close);
    const config = configFor(twin.endpoint);
    await assert.rejects(fetchTwin({ config }), { message: 'the twin endpoint answered HTTP 500' });
    await assert.rejects(fetchTwin({ config }), { message: 'the twin endpoint answered HTTP 302' });
    await assert.rejects(fetchTwin({ config }), {
      message: 'the twin answer is not this module’s',
    });
    await assert.rejects(fetchTwin({ config }), {
      message: 'the twin answer is not this module’s',
    });
  });

  it('rejects an answer that is not valid UTF-8', async (t) => {
    const body = Buffer.from(JSON.stringify({ modules: { 'my-module': { note: 'XX' } } }));
    body.set([0x80, 0x80], body.indexOf('XX'));
    const twin = await twinServer((_request, response) => response.end(body));
    t.after(twin.close);
    await assert.rejects(fetchTwin({ config: configFor(twin.endpoint) }), {
      message: 'the twin answer is not UTF-8',
      name: 'TwinError',
    });
  });

  it('rejects an answer over the size bound', async (t) => {
    const twin = await twinServer((_request, response) => response.end('x'.repeat(4096)));
    t.after(twin.close);
    await assert.rejects(fetchTwin({ config: configFor(twin.endpoint), maxBytes: 1024 }), {
      message: 'the twin answer is too large',
    });
  });

  it('rejects an answer cut short', async (t) => {
    const twin = await twinServer((_request, response) => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write('{');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    t.after(twin.close);
    await assert.rejects(fetchTwin({ config: configFor(twin.endpoint) }), TwinError);
  });

  it('gives up at its deadline on a server that never answers', async (t) => {
    const twin = await twinServer(() => {});
    t.after(twin.close);
    await assert.rejects(fetchTwin({ config: configFor(twin.endpoint), timeoutMs: 100 }), {
      message: 'the twin request timed out',
    });
  });

  it('rejects a connection refused', async () => {
    const twin = await twinServer(() => {});
    await twin.close();
    await assert.rejects(
      fetchTwin({ config: configFor(twin.endpoint) }),
      /^TwinError: twin request: /,
    );
  });
});
