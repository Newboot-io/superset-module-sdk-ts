// sensor-sim: a sample module for a Newboot Superset. It simulates a sensor and sends
// `temperature` and `pressure` every `rateMs`, both read from its module twin.
import { createServer } from 'node:http';
import {
  METRICS_CONTENT_TYPE,
  ModuleClient,
  type ModuleTwin,
} from '@newboot-io/superset-module-sdk';
import {
  ownVariables,
  PRESSURE,
  pressureAt,
  readSettings,
  type Settings,
  TEMPERATURE,
  temperatureAt,
} from './sim.js';

const DEVICE_PASSWORD = 'device-password';
const HEALTH_PORT = 8080;
/** Log the number of messages sent every this many ticks. */
const LOG_EVERY_TICKS = 30;
const RETRY_TWIN_AFTER_MS = 3000;

let client: ModuleClient;
try {
  client = ModuleClient.fromEnv();
  client.checkSecrets();
  // Simulates logging in to the device: only its presence is checked, the value is never shown.
  if (client.getSecret(DEVICE_PASSWORD).length === 0) {
    throw new Error(`secret ${DEVICE_PASSWORD} is empty`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

let ids: ReturnType<typeof ownVariables> = {};
let settings: Settings = readSettings({}).settings;
let timer: NodeJS.Timeout | undefined;
let ticks = 0;
let sent = 0;

/** Applies a twin: settings (with defaults for invalid ones) and the variables to send. */
function apply(twin: ModuleTwin): void {
  const read = readSettings(twin);
  for (const field of read.fallbacks) console.log(`settings: ${field} missing or invalid, default`);
  settings = read.settings;
  ids = ownVariables(twin);
  for (const name of [TEMPERATURE, PRESSURE] as const) {
    const id = ids[name];
    console.log(id ? `variable ${name}: ${id}` : `variable ${name}: not in the twin, not sent`);
  }
  clearInterval(timer);
  timer = setInterval(tick, settings.rateMs);
}

function tick(): void {
  if (!client.isConnected()) return;
  const nowMs = Date.now();
  const values: [string | undefined, number][] = [
    [ids.temperature, temperatureAt({ amplitude: settings.amplitude, nowMs, random: Math.random })],
    [ids.pressure, pressureAt(Math.random)],
  ];
  for (const [variableId, value] of values) {
    if (!variableId) continue;
    // The SDK names each message after the twin's variable: `temperature`, `pressure`. A
    // TelemetryError (a variable id it refuses) names the field only and must not stop the timer.
    try {
      if (client.sendTelemetry({ timestamp: nowMs, value, variableId })) sent++;
    } catch (error) {
      console.error((error as Error).message);
    }
  }
  if (++ticks % LOG_EVERY_TICKS === 0) console.log(`sent ${sent} messages`);
}

function loadTwin(): void {
  client.getTwin().then(apply, (error: Error) => {
    console.error(`twin: ${error.message}`);
    setTimeout(loadTwin, RETRY_TWIN_AFTER_MS);
  });
}

client.onTwinChange((twin) => {
  console.log('twin: reloaded');
  apply(twin);
});

// Health probes, and the flow metrics Newboot's console shows the module's activity from.
createServer((request, response) => {
  if (request.url === '/metrics') {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': METRICS_CONTENT_TYPE }).end(client.metrics());
    } else {
      response.writeHead(405, { allow: 'GET' }).end();
    }
    return;
  }
  const ok = request.url === '/healthz' || (request.url === '/readyz' && client.isConnected());
  response.writeHead(ok ? 200 : 503).end();
}).listen(HEALTH_PORT);

process.on('SIGTERM', () => {
  client.close().finally(() => process.exit(0));
});

loadTwin();
await client.connect();
