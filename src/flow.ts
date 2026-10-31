// Newboot's common module flow observability: the 17 series the console's data-flow view reads
// from a module's /metrics; the rendering is byte for byte the reference's.
// Ported from Newboot's reference implementation of the module flow-metrics contract and
// contributed by Newboot under Apache-2.0; conformance vector at revision 589be4b6, identical in
// every SDK.

/** The Prometheus text content type to serve `render()` with. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export const FLOW_METRICS = {
  connected: 'newboot_flow_mqtt_connected',
  lastError: 'newboot_flow_last_error_timestamp_seconds',
  lastSuccess: 'newboot_flow_last_success_timestamp_seconds',
  operations: 'newboot_flow_operations_total',
} as const;

/** The fixed operations; the SDK records all but `acquire` (a protocol read, the module's own). */
export const FLOW_OPERATIONS = ['acquire', 'receive', 'process', 'enqueue'] as const;
export type FlowOperation = (typeof FLOW_OPERATIONS)[number];

type Counters = { error: number; lastError: number; lastSuccess: number; success: number };
const UNKNOWN_CONNECTION = -1;

/**
 * Counts each operation's successes and errors with the time of the last of each, and the MQTT
 * connection state. In memory: counters reset when the process restarts. No labels but the
 * operation and outcome: never a variable id, topic, value or error.
 */
export class Flow {
  private connected = UNKNOWN_CONNECTION;
  private readonly clock: () => number;
  private readonly operations = new Map<FlowOperation, Counters>(
    FLOW_OPERATIONS.map((operation) => [
      operation,
      { error: 0, lastError: 0, lastSuccess: 0, success: 0 },
    ]),
  );

  /** `clock`: Unix seconds; defaults to now. For tests. */
  constructor({ clock = () => Date.now() / 1000 }: { clock?: () => number } = {}) {
    this.clock = clock;
  }

  /** The MQTT connection went up (true) or down (false); `-1` until first called. */
  connection(connected: boolean): void {
    if (typeof connected !== 'boolean') throw new TypeError('connected must be boolean');
    this.connected = Number(connected);
  }

  /** One operation finished. Call it once per operation, after it succeeded or failed. */
  record({ operation, success }: { operation: FlowOperation; success: boolean }): void {
    const values = this.operations.get(operation);
    if (!values || typeof success !== 'boolean') throw new TypeError('invalid flow observation');
    const now = this.clock();
    if (!Number.isFinite(now) || now < 0) throw new RangeError('invalid flow timestamp');
    if (success) {
      values.success++;
      values.lastSuccess = Math.max(values.lastSuccess, now);
    } else {
      values.error++;
      values.lastError = Math.max(values.lastError, now);
    }
  }

  /** The 17 series in the Prometheus text format, for `GET /metrics`. */
  render(): string {
    const lines = [
      `# TYPE ${FLOW_METRICS.connected} gauge`,
      `${FLOW_METRICS.connected} ${this.connected}`,
    ];
    for (const [metric, kind] of [
      [FLOW_METRICS.operations, 'counter'],
      [FLOW_METRICS.lastSuccess, 'gauge'],
      [FLOW_METRICS.lastError, 'gauge'],
    ] as const) {
      lines.push(`# TYPE ${metric} ${kind}`);
      for (const [operation, values] of this.operations) {
        if (metric === FLOW_METRICS.operations) {
          for (const outcome of ['success', 'error'] as const) {
            lines.push(
              `${metric}{operation="${operation}",outcome="${outcome}"} ${values[outcome]}`,
            );
          }
        } else {
          lines.push(
            `${metric}{operation="${operation}"} ${metric === FLOW_METRICS.lastSuccess ? values.lastSuccess : values.lastError}`,
          );
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
