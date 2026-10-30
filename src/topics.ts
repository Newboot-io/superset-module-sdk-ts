import type { Target } from './config.js';

/** The topics a module publishes and subscribes to, built from its target. */
export interface Topics {
  /** Commands arrive on `<command>/<delivery>/<name>`. */
  command: string;
  /** The filter that subscribes to every command for this module. */
  commandFilter: string;
  /** Replies go to `<reply>/<correlationId>`. */
  reply: string;
  /** This module's own telemetry. */
  telemetry: string;
}

export function topicsFor(target: Target): Topics {
  const { clusterId, moduleId, nodeId, tenantConfigId } = target;
  const command = `input/directmethod/${tenantConfigId}/${clusterId}/${moduleId}`;
  return {
    command,
    commandFilter: `${command}/+/+`,
    reply: `output/directmethod/${tenantConfigId}/${clusterId}/${moduleId}/res`,
    telemetry: `output/telemetry/${tenantConfigId}/${nodeId}/${moduleId}/v`,
  };
}
