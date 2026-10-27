import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ORCHESTRATION_LIMITS: L } = require('../src/core/orchestration-limits.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the recorded limits are what each module used before they were centralised', () => {
  assert.deepEqual(L.delegationDepth, { task: 3, coordinator: 3, harness: 4 });
  assert.deepEqual(L.taskTimeoutMs, { task: 900000, harness: 600000 });
  assert.deepEqual(L.delegationTimeoutMs, { task: 300000, coordinator: 300000 });
  assert.deepEqual(L.pollMs, { task: 40, coordinator: 50, harness: 25 });
  assert.equal(L.maxFanout, 6);
  assert.ok(Object.isFrozen(L) && Object.isFrozen(L.pollMs));
});

test('the task policies read their numbers from it', () => {
  const { DEFAULT_POLICIES, createPolicies } = require('../src/core/orchestrator/policies.js');
  const p = createPolicies ? createPolicies() : DEFAULT_POLICIES;
  assert.equal(p.maxDelegationDepth, L.delegationDepth.task);
  assert.equal(p.taskTimeoutMs, L.taskTimeoutMs.task);
  assert.equal(p.delegationTimeoutMs, L.delegationTimeoutMs.task);
});

test('no orchestration module carries its own copy of a limit again', () => {
  for (const f of ['orchestrator/policies.js', 'orchestrator/orchestrator.js', 'agents/coordinator.js', 'harness-orchestrator/coordinator.js', 'harness-orchestrator/orchestrator.js']) {
    assert.match(read(f), /require\('\.\.\/orchestration-limits'\)/, f);
  }
  assert.doesNotMatch(read('harness-orchestrator/orchestrator.js'), /taskTimeoutMs: 10 \* 60/);
  assert.doesNotMatch(read('harness-orchestrator/coordinator.js'), /MAX_DEPTH = 4/);
  assert.doesNotMatch(read('agents/coordinator.js'), /maxDepth: 3,/);
});
