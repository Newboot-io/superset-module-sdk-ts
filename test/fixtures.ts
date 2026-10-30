/** A module configuration as Newboot renders it, for the tests. */
export const TARGET = {
  clusterId: 'cluster-a',
  moduleId: 'my-module',
  nodeId: 'node-a',
  tenantConfigId: 'tenant-a',
};

export const INPUT = 'output/telemetry/tenant-a/node-a/sensor/v';

export const rendered = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
  brokerUrl: 'tcps://broker:8883',
  configuration: { inputs: [INPUT], secretFiles: ['/vault/material/device-password.json'] },
  mqtt: {
    ca: '/etc/newboot/ca/mqtt-ca.crt',
    identity: '/vault/material/mqtt-client.pem',
    mode: 'mutual-tls',
  },
  target: TARGET,
  twin: {
    ca: '/etc/newboot/ca/twin-ca.crt',
    endpoint: 'https://twin/twin',
    identity: '/vault/material/twin-client.pem',
  },
  ...override,
});
