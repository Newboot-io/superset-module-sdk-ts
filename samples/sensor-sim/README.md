# sensor-sim: sample module

A sample module for a Newboot Superset, built on this SDK. It simulates a sensor: every `rateMs`
it sends a `temperature` (°C, a sine around 20 over one minute plus noise, scaled by `amplitude`)
and a `pressure` (hPa, around 1013 plus noise).

It is the first of three linked samples, one per SDK:

```
sensor-sim (TypeScript) --temperature, pressure--> smoother (Python) --temp_avg, temp_f--> alarm-monitor (Rust)
```

- [sensor-sim](https://github.com/Newboot-io/superset-module-sdk-ts/tree/main/samples/sensor-sim)
  (this one) sends the raw readings;
- [smoother](https://github.com/Newboot-io/superset-module-sdk-py/tree/main/samples/smoother)
  receives `temperature` and sends its moving average `temp_avg` and `temp_f`;
- [alarm-monitor](https://github.com/Newboot-io/superset-module-sdk-rs/tree/main/samples/alarm-monitor)
  receives `temp_avg` and sends `alarm` and `alarm_count`.

In the Superset, link sensor-sim's `temperature` to smoother, and smoother's `temp_avg` to
alarm-monitor. Receivers match messages by their `name`, which sensor-sim takes from its twin.

## Twin settings

Module twin fields, read at start and again on every `reload` (when the console saves new values):

| Field       | Type    | Default | Rule              |
| ----------- | ------- | ------- | ----------------- |
| `rateMs`    | integer | 2000    | at least 200      |
| `amplitude` | number  | 5       | any finite number |

A missing or invalid field falls back to its default, and the module logs the field's name.

## Variables

sensor-sim owns two variables of its twin, found by their `name` whatever ids the Superset gives
them: `temperature` and `pressure`. It sends one message for each on every tick; a variable missing
from the twin is not sent (the module logs it). It logs variable ids and message counts, never
values.

## Secrets

`device-password`: simulates logging in to the device. The module checks at start that every
declared secret can be read and that `device-password` is not empty, and stops otherwise. The value
is never printed.

## Health

`/healthz` answers 200 while the process runs; `/readyz` answers 200 while the SDK is connected and
subscribed (`isConnected()`). Both on port 8080.

## Build and test

The sample depends on the SDK in this repository (`file:../..`). In your own module, depend on the
published SDK instead:

```sh
npm install github:Newboot-io/superset-module-sdk-ts#v0.1.0
```

Unit tests for the simulation and the settings (Node.js 22 or later; run the repository's
`npm ci` first, which builds the SDK):

```sh
cd samples/sensor-sim
npm ci
npm test
```

The image, from the repository root (linux/amd64, runs as user 10001 on a read-only root):

```sh
docker build --platform linux/amd64 -f samples/sensor-sim/Dockerfile -t sensor-sim .
```

## Run

- **Locally**, against the SDK's end-to-end harness: `e2e/run.sh` from the repository root builds
  this image and runs it against a throwaway broker and twin endpoint, with a twin setting
  `rateMs` to 500, and checks its health probes and messages.
- **On a Superset cluster**: push the image to a registry your Superset reads, declare the module
  with its `temperature` and `pressure` variables, the `rateMs` and `amplitude` fields and the
  `device-password` secret, and the `reload` command. Newboot mounts the module configuration,
  certificates and secret file the SDK reads.
