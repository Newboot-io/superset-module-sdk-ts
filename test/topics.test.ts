import assert from 'node:assert/strict';
import { it } from 'node:test';
import { topicsFor } from '../src/topics.js';
import { TARGET } from './fixtures.js';

it('builds the module topics from its target', () => {
  assert.deepEqual(topicsFor(TARGET), {
    command: 'input/directmethod/tenant-a/cluster-a/my-module',
    commandFilter: 'input/directmethod/tenant-a/cluster-a/my-module/+/+',
    reply: 'output/directmethod/tenant-a/cluster-a/my-module/res',
    telemetry: 'output/telemetry/tenant-a/node-a/my-module/v',
  });
});
