// A minimal module for a Newboot Superset: sends one value per variable of its module twin every
// few seconds, logs the values its linked modules send (by name only), follows `reload`, and
// answers Newboot's health probes and flow metrics.
import { createServer } from 'node:http';
import {
  METRICS_CONTENT_TYPE,
  ModuleClient,
  type ModuleTwin,
} from '@newboot-io/superset-module-sdk';

const HEALTH_PORT = 8080;
const RETRY_TWIN_AFTER_MS = 3000;
const SEND_EVERY_MS = 5000;

let client: ModuleClient;
try {
  client = ModuleClient.fromEnv();
  // Stop at start when a declared secret cannot be read: the error names the secret only.
  client.checkSecrets();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

let twin: ModuleTwin = {};

/** Read your machine or sensor here. */
function readSensor(_variableId: string): number {
  return 20 + Math.random() * 5;
}

/** At start: keep trying until the twin arrives. Without variables there is nothing to send. */
function loadTwin(): void {
  client.getTwin().then(
    (fetched) => {
      twin = fetched;
    },
    (error: Error) => {
      console.error(`twin: ${error.message}`);
      setTimeout(loadTwin, RETRY_TWIN_AFTER_MS);
    },
  );
}

client.onTwinChange((fetched) => {
  twin = fetched;
  console.log(`twin: reloaded, ${Object.keys(fetched.variables ?? {}).length} variable(s)`);
});

client.onTelemetry((message) => {
  // Log names only: values may be sensitive.
  console.log(`input: ${message.name ?? message.variableId}`);
});

// Newboot restarts the module when /healthz fails, and counts it as ready once /readyz succeeds.
// Its console shows the module's activity from /metrics.
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

setInterval(() => {
  if (!client.isConnected()) return;
  for (const variableId of Object.keys(twin.variables ?? {})) {
    // The SDK names the message after the twin's variable. A variable id it refuses (a TelemetryError
    // naming the field) must not stop the timer.
    try {
      client.sendTelemetry({ value: readSensor(variableId), variableId });
    } catch (error) {
      console.error((error as Error).message);
    }
  }
}, SEND_EVERY_MS);

process.on('SIGTERM', () => {
  client.close().finally(() => process.exit(0));
});

if (client.config.twin) loadTwin();
else console.error('this module has no twin: it has no variables, so it sends nothing');
// Returns once started; the SDK keeps (re)connecting, and isConnected() tells when it is ready.
await client.connect();
