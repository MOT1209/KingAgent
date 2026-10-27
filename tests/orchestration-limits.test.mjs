import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ORCHESTRATION_LIMITS: L } = require('../src/core/orchestration-limits');
const { DEFAULT_POLICIES } = require('../src/core/orchestrator/policies');
const { MAX_DEPTH } = require('../src/core/harness-orchestrator/coordinator');

test('the limits table is deeply frozen', () => {
  assert.ok(Object.isFrozen(L));
  for (const group of Object.values(L)) assert.ok(Object.isFrozen(group));
});

test('each orchestration layer reads its limits from the shared table', () => {
  assert.equal(DEFAULT_POLICIES.maxDelegationDepth, L.orchestrator.maxDelegationDepth);
  assert.equal(DEFAULT_POLICIES.taskTimeoutMs, L.orchestrator.taskTimeoutMs);
  assert.equal(DEFAULT_POLICIES.delegationTimeoutMs, L.orchestrator.delegationTimeoutMs);
  assert.equal(MAX_DEPTH, L.harness.maxDelegationDepth);
});

test('values are unchanged from before the consolidation', () => {
  assert.deepEqual(
    [L.orchestrator.maxDelegationDepth, L.harness.maxDelegationDepth, L.agents.maxDepth],
    [3, 4, 3],
  );
  assert.deepEqual([L.orchestrator.pollMs, L.harness.pollMs, L.agents.pollMs], [40, 25, 50]);
  assert.equal(L.agents.maxFanout, 6);
});
