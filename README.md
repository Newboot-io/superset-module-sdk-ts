# Superset module SDK for TypeScript

Write a module for a Newboot Superset in a few lines. The SDK reads the module configuration
Newboot mounts into your container and gives you four operations, plus the `reload` command:

- **getTwin**: fetch your module twin (the fields saved in the console and your variables);
- **getSecret**: read one of your module's secrets;
- **sendTelemetry**: publish a value for one of your variables;
- **onTelemetry**: receive the values of the modules your Superset links to yours;
- **onTwinChange** + built-in `reload`: when your twin changes in the console, the SDK fetches it
  again, calls you, and answers Newboot.

It implements the wire contract for you: topics, payload rules, command validation, reply shape,
certificate rotation, timeouts and size bounds.

Same API in the sister SDKs for [Python](https://github.com/Newboot-io/superset-module-sdk-py) and
[Rust](https://github.com/Newboot-io/superset-module-sdk-rs).

## Requirements

- Node.js 22 or later (ESM only), for running modules and this repository's tests.
- A module deployed by a Newboot Superset whose broker access is `mutual-tls` (see
  [Compatibility](#compatibility)).

## Install

From GitHub for now (package registries later):

```sh
npm install github:Newboot-io/superset-module-sdk-ts#v0.1.0
```

npm builds the package on install. The only runtime dependency is [`mqtt`](https://www.npmjs.com/package/mqtt).

## Quick start

```ts
import { createServer } from 'node:http';
import { ModuleClient } from '@newboot-io/superset-module-sdk';

/** Read your machine or sensor here. */
const readSensor = (_variableId: string) => 20 + Math.random() * 5;

const client = ModuleClient.fromEnv(); // reads MODULE_CONFIG, default /etc/newboot/module.json
let twin = await client.getTwin();

client.onTwinChange((fetched) => {
  twin = fetched; // the console saved new values
});
client.onTelemetry((message) => {
  console.log(`input: ${message.name ?? message.variableId}`);
});

// Newboot probes /healthz (restart when failing) and /readyz (ready once 2xx) on port 8080.
createServer((request, response) => {
  const ok = request.url === '/healthz' || (request.url === '/readyz' && client.isConnected());
  response.writeHead(ok ? 200 : 503).end();
}).listen(8080);

await client.connect();
setInterval(() => {
  for (const variableId of Object.keys(twin.variables ?? {})) {
    client.sendTelemetry({ value: readSensor(variableId), variableId });
  }
}, 5000);
```

[`examples/minimal`](examples/minimal) is a complete module: it also retries the first twin fetch,
checks its secrets at start and closes on `SIGTERM`. Build its image from the repository root:

```sh
docker build --platform linux/amd64 -f examples/minimal/Dockerfile -t my-module .
```

The image follows what Newboot requires: linux/amd64, runs as user 10001, works on a read-only
root file system (nothing is written to disk), keeps the system certificate bundle.

## Sample module

[`samples/sensor-sim`](samples/sensor-sim) simulates a temperature and pressure sensor. It is the
first of three linked samples, with `smoother` in the
[Python SDK](https://github.com/Newboot-io/superset-module-sdk-py/tree/main/samples/smoother) and
`alarm-monitor` in the
[Rust SDK](https://github.com/Newboot-io/superset-module-sdk-rs/tree/main/samples/alarm-monitor).

## API reference

Errors: `ConfigError` (and its subtype `UnsupportedModeError`), `SecretError`, `TwinError`,
`TelemetryError`, all extending `SdkError` (thrown as such only by `connect()` after `close()`). No
other error type escapes the API. Messages never contain a secret value or a file's content.

### `ModuleClient.fromEnv(options?)` and `new ModuleClient(config, options?)`

Reads the file named by `MODULE_CONFIG` (default `/etc/newboot/module.json`) and validates it.

- `options.log(line)`: where log lines go; default standard error. Connection problems are logged
  as `mqtt: …`, failed reloads as `reload: …`, failing handlers as `handler: …`.
- `options.reconnectAfterMs`: delay before reconnecting; default 5000.
- `options.connectMqtt`: replaces the `mqtt` package's `connect` (for tests).
- Returns a `ModuleClient`; `client.config` is the validated configuration, `client.topics` the
  module's topics.
- Throws `ConfigError` when the file cannot be read, is not JSON, or misses or breaks a field;
  `UnsupportedModeError` (a `ConfigError`) for a broker mode other than `mutual-tls`.
  `parseConfig(text)` and `loadConfig(path?)` do the same without a client.

Validation: `mqtt.mode` is checked first, so a module set up for another mode always gets
`UnsupportedModeError`, whatever the rest holds. `brokerUrl` is exactly `tcps://host[:port]` or
`mqtts://host[:port]`: the host made of letters, digits, dots and dashes, or a bracketed IPv6
literal (`[::1]`); the port 1 to 5 digits, 1-65535, default 8883 when absent (`host:` with an empty
port is refused); no user, path, query or fragment. Every path (`mqtt.ca`, `mqtt.identity`,
`twin.ca`, `twin.identity`, each `secretFiles` entry) is a non-empty string. The `target` ids are topic levels (non-empty, at
most 200 bytes, no `/`, `+`, `#` or control character); `configuration.inputs` are topics without
`+`, `#` or control characters; every `configuration.secretFiles` entry ends in `.json`.
`"twin": null` means no twin, as when `twin` is absent.

### `client.getTwin(correlationId?) → Promise<ModuleTwin>`

Fetches this module's twin over HTTPS from `twin.endpoint`, requested exactly as given (path,
`;params` and query, no normalisation), presenting the `twin.identity` client
certificate (one PEM file: certificate, chain, key) and trusting `twin.ca`.

- `correlationId`: optional, sent as `x-newboot-correlation-id` when made of letters, digits and
  dashes only (reloads pass the command's id).
- Resolves to the twin as received, a plain object: its fields, and `variables` (an object keyed
  by variable id, each with its `name`, `modelId` and fields) when the module has variables.
- Rejects with `TwinError` when the configuration has no twin endpoint, the certificate files
  cannot be read or are corrupt, the request fails or exceeds 12 s (connection to last byte),
  the answer is not HTTP 200 (redirects are not followed), is over 2 MiB, is cut short, or does not
  hold exactly one module, this one, with object `variables`, or holds a number too large for a
double (`1e400`) anywhere.

### `client.getSecret(name) → string`

Reads the secret `name` from its file `<name>.json` among `configuration.secretFiles`, which holds
the value as a JSON string. `client.secretNames()` lists the declared names.

- Throws `SecretError`: `secret <name> is not declared`, `secret <name> cannot be read` (missing
  file, not JSON: the parse error is never passed on, it can quote the file), or
  `secret <name> is not a string`.

### `client.checkSecrets()`

Reads every declared secret now and throws the `SecretError` of the first one that cannot be read.
Call it at start, so a module with a broken secret stops at once (the example does).

### `client.connect() → Promise<void>`

Connects to `brokerUrl` with MQTT 5 over TLS, presenting `mqtt.identity` and trusting `mqtt.ca`,
with client id `<moduleId>-<hostname>`. Subscribes, QoS 1 with retain-as-published and no retained
messages sent, to the module's command topic and to each topic of `configuration.inputs`. It
announces an MQTT 5 maximum packet size of 2 MiB + 1 KiB (2098176 bytes): the broker drops larger
messages for this client instead of sending them (see
[Security notes](#security-notes) for what that relies on).

- Resolves once started, not once connected: it never fails because a certificate file is missing
  or unreadable. Connection problems are logged as `mqtt: <reason>` and it reconnects after 5 s,
  reading the certificate files again; this goes on after every drop.
- A second call does nothing. A call after `close()` rejects with `SdkError`.
- Use `isConnected()` for readiness.

### `client.isConnected() → boolean`

True while the connection is up AND the subscriptions are granted. This is what a module's
`/readyz` should answer (`/healthz` can answer 200 while the process runs).

### `client.sendTelemetry({ variableId, value, name?, timestamp? }) → boolean`

Publishes `{"name"?,"timestamp","value","variableId"}` as JSON on
`output/telemetry/<tenantConfigId>/<nodeId>/<moduleId>/v`, QoS 0, not retained.

- `variableId`: a key of `variables` in the module twin; non-empty, at most 200 bytes, no `/`,
  `+`, `#` or control character.
- `value`: a finite number, a string, a boolean, or an array of those (no objects, no nested
  arrays, no `NaN` or `Infinity`).
- `name`: optional string; defaults to the variable's `name` in the twin fetched last, and is left
  out of the message when there is none.
- `timestamp`: optional integer from 0 to 2^53-1, epoch milliseconds; default now. A number with
  an integral value (`1.7e12`) counts as an integer.
- Returns `true` once handed to the connection, `false` when not connected (including before
  `connect()` and between a drop and the next subscription): the value is dropped, never queued.
- Throws `TelemetryError` naming the field at fault, never its value.

### `client.onTelemetry(handler)`

Adds a handler; several may be added, and each message goes to them in the order they were added.
Each is called with `{ topic, variableId, value, name?, timestamp? }` for each value a linked module
publishes on one of `configuration.inputs`. Dropped without a call: retained (stored) messages,
messages over 8 KiB, payloads that are not a JSON object, and messages that break the payload rules
of `sendTelemetry` (the same rules apply both ways: an invalid `variableId`, an object or nested
array `value`, a `name` that is not a string or a `timestamp` that is not an integer from 0 to
2^53-1, `null` included), and messages with a number too large for a double (`1e400`) anywhere. A throwing
or rejecting handler is logged as `handler: telemetry handler failed (<error name>)`, without its
message (it could quote a value), and does not stop the module.

### `client.onTwinChange(handler)` and the `reload` command

Adds a handler; several may be added, called in the order they were added.

When the console saves new values, Newboot sends the module a `reload` command. The SDK accepts it
only when it is addressed to this module (topic, `replyTopic` and `target` match exactly; delivery
`unicast` or `broadcast`) and on time (issued no more than 1 s in the future, expiring within 30 s
of issue, not yet expired), not retained and at most 8 KiB. Then, one reload at a time, it:

1. fetches the twin again (`getTwin`, with the command's correlation id);
2. awaits each `onTwinChange` handler with the new twin, in order (a failing one stops the rest);
3. answers `{"correlationId","target","result":{"reloaded":true}}` on the reply topic, QoS 0.

If the fetch or a handler fails, it answers `"error":"reload_failed"` instead, and logs
`reload: <reason>` for a fetch failure or `reload: twin-change handler failed (<error type>)` for a
handler (only the type: the message could quote a value); a payload that is not an object gets `"error":"invalid_payload"`. An answer
that would arrive after the command expired, or while the module is not connected and subscribed,
is not sent, and never queued for later. Any other answer, or none, makes Newboot
send `reload` again later.

Keep twin handlers fast: the reply waits for them, and a command lives at most 30 s (Newboot waits
15 s for the answer), of which the twin fetch may take up to 12 s. A slow async handler can push the
answer past the command's expiry, and then nothing is sent. Start long work in the background and
return.

Other commands (`getValue`, custom commands) are out of scope for v0.1: the SDK leaves them
unanswered, so do not declare them for a module built on this version.

### `client.close() → Promise<void>`

Disconnects and stops reconnecting.

### Pure helpers

Exported for tests and custom transports: `parseConfig`, `parseBrokerUrl`, `loadConfig`, `topicsFor`, `readSecret`,
`secretNames`, `parseTwinAnswer`, `telemetryPayload`, `decodeMessage`, `parseTelemetry`,
`parseCommand`, `onTime`, `replyBody`, `validSegment`, `isTelemetryValue`.

## Security notes

- **Certificates rotate.** The broker and twin certificate files are read again for every
  connection and every twin request; nothing is cached.
- **Secrets are never logged.** Secret files are read on every `getSecret` call, and errors name
  the secret only, never its value or content. Do not log values yourself; log names.
- **Access comes from the Superset.** The broker's per-module access rules (which topics a module
  may publish and read) come from your Superset, not from this SDK: publishing elsewhere is refused
  by the broker.
- **Maximum packet size.** The client announces a 2 MiB + 1 KiB maximum packet size to the
  broker on CONNECT. The `mqtt` library enforces it only after a packet has been read, so the SDK
  relies on the broker (trusted, reached over mutual TLS) honouring it.
- Commands are checked before anything runs: address, deadlines and size, as described above.

## Compatibility

| Item              | Supported in v0.1                        |
| ----------------- | ---------------------------------------- |
| Broker access     | `mutual-tls` only; other modes throw     |
| Commands answered | `reload`                                 |
| Node.js           | 22 or later                              |

## Testing

Unit tests (with a coverage report and a 90 % line threshold), lint and type check, on Node.js 22
or later (CI runs 22 and 24):

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

No Node.js locally? Run them in Docker:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:22-bookworm-slim \
  sh -c 'npm ci && npm run lint && npm run typecheck && npm test'
```

The end-to-end test builds the example and sensor-sim images and runs each the way Newboot does
(user 10001, read-only root, no capabilities) against a throwaway MQTT broker and twin endpoint on
an internal Docker network, with a throwaway CA. It needs Docker only and cleans up after itself:

```sh
e2e/run.sh
```

The unit tests make a throwaway CA and certificates in a temporary directory on each run.

## Contributing

Issues and pull requests are welcome. Keep changes small, add tests for each behaviour change, and
run lint, type check, unit tests and the end-to-end test before opening a pull request. By
contributing, you agree that your contribution is licensed under the Apache License 2.0.

## License

[Apache License 2.0](LICENSE). Copyright Newboot.
