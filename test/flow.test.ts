import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FLOW_OPERATIONS, Flow, type FlowOperation, METRICS_CONTENT_TYPE } from '../src/flow.js';
import { series } from './helpers.js';

/**
 * The conformance vector every implementation of the module flow-metrics contract passes, copied
 * verbatim. Ported from Newboot's reference implementation of the module flow-metrics contract
 * and contributed by Newboot under Apache-2.0; conformance vector at revision 589be4b6, identical
 * in every SDK.
 */
const CONFORMANCE = JSON.parse(
  readFileSync(new URL('../../test/flow-conformance.json', import.meta.url), 'utf8'),
) as {
  events: { operation: FlowOperation; success: boolean; timestampSeconds: number }[];
  expected: Record<string, string>;
  seriesCount: number;
};

describe('Flow', () => {
  it('passes the conformance vector', () => {
    let now = 0;
    const flow = new Flow({ clock: () => now });
    for (const { operation, success, timestampSeconds } of CONFORMANCE.events) {
      now = timestampSeconds;
      flow.record({ operation, success });
    }
    const rendered = series(flow.render());
    assert.equal(rendered.size, CONFORMANCE.seriesCount);
    for (const [name, value] of Object.entries(CONFORMANCE.expected)) {
      assert.equal(rendered.get(name), value, name);
    }
  });

  it('renders the 17 series, zero and unknown before any observation', () => {
    const text = new Flow().render();
    assert.ok(text.endsWith('\n'));
    assert.equal(
      text.split('\n')[0],
      '# TYPE newboot_flow_mqtt_connected gauge',
      'the connection comes first',
    );
    assert.equal(
      text.match(/^# TYPE .*$/gm)?.join('\n'),
      [
        '# TYPE newboot_flow_mqtt_connected gauge',
        '# TYPE newboot_flow_operations_total counter',
        '# TYPE newboot_flow_last_success_timestamp_seconds gauge',
        '# TYPE newboot_flow_last_error_timestamp_seconds gauge',
      ].join('\n'),
    );
    const rendered = series(text);
    assert.equal(rendered.size, 17);
    assert.equal(rendered.get('newboot_flow_mqtt_connected'), '-1');
    for (const operation of FLOW_OPERATIONS) {
      for (const outcome of ['success', 'error']) {
        assert.equal(
          rendered.get(
            `newboot_flow_operations_total{operation="${operation}",outcome="${outcome}"}`,
          ),
          '0',
        );
      }
      for (const kind of ['success', 'error']) {
        const name = `newboot_flow_last_${kind}_timestamp_seconds{operation="${operation}"}`;
        assert.equal(rendered.get(name), '0');
      }
    }
    assert.equal(METRICS_CONTENT_TYPE, 'text/plain; version=0.0.4; charset=utf-8');
  });

  it('follows the connection, and keeps the latest timestamp', () => {
    let now = 10;
    const flow = new Flow({ clock: () => now });
    flow.connection(true);
    assert.equal(series(flow.render()).get('newboot_flow_mqtt_connected'), '1');
    flow.connection(false);
    assert.equal(series(flow.render()).get('newboot_flow_mqtt_connected'), '0');
    flow.record({ operation: 'acquire', success: true });
    now = 5; // a clock stepping back never moves the last success back
    flow.record({ operation: 'acquire', success: true });
    const rendered = series(flow.render());
    assert.equal(
      rendered.get('newboot_flow_last_success_timestamp_seconds{operation="acquire"}'),
      '10',
    );
    assert.equal(
      rendered.get('newboot_flow_operations_total{operation="acquire",outcome="success"}'),
      '2',
    );
  });

  it('refuses an unknown operation, a non-boolean outcome and an invalid clock', () => {
    const flow = new Flow();
    const unknown = { operation: 'publish' as FlowOperation, success: true };
    assert.throws(() => flow.record(unknown), TypeError);
    assert.throws(
      () => flow.record({ operation: 'receive', success: 1 as unknown as boolean }),
      TypeError,
    );
    assert.throws(() => flow.connection('yes' as unknown as boolean), TypeError);
    for (const now of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const broken = new Flow({ clock: () => now });
      assert.throws(() => broken.record({ operation: 'receive', success: true }), RangeError);
    }
  });
});
