// The audit found five maps that only ever grew (C8, S14). Each now has a cap
// on history that never touches live work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TaskManager } = require('../src/core/runtime/task-manager.js');
const { Orchestrator } = require('../src/core/orchestrator/orchestrator.js');

test('TaskManager evicts the oldest finished tasks past MAX_TASKS and never a live one', () => {
  const tm = Object.create(TaskManager.prototype);
  tm._tasks = new Map(); tm._machines = new Map();
  const add = (id, terminal, state = terminal ? 'completed' : 'executing') => {
    tm._tasks.set(id, { id, state }); tm._machines.set(id, { terminal });
  };
  add('live-old', false);                                  // oldest of all, but still running
  for (let i = 0; i < TaskManager.MAX_TASKS + 5; i++) add('done' + i, true);
  add('failed', false, 'failed');                         // failed is finished too
  tm._evict();
  assert.equal(tm._tasks.size, TaskManager.MAX_TASKS);
  assert.ok(tm._tasks.has('live-old'), 'a live task survives however old');
  assert.ok(!tm._tasks.has('done0') && !tm._tasks.has('done5'), 'the oldest finished go first');
  assert.ok(!tm._machines.has('done0'), 'its state machine goes with it');
});

test('Orchestrator.MAX_RUNS bounds finished runs but not queued or running ones', () => {
  const o = Object.create(Orchestrator.prototype);
  o._runs = new Map();
  for (let i = 0; i < Orchestrator.MAX_RUNS + 10; i++) o._runs.set('r' + i, { id: 'r' + i, status: i < 3 ? 'running' : 'completed' });
  o._pruneRuns();
  assert.equal(o._runs.size, Orchestrator.MAX_RUNS);
  for (const id of ['r0', 'r1', 'r2']) assert.ok(o._runs.has(id), id + ' is running and must stay');
  assert.ok(!o._runs.has('r3'), 'the oldest finished run goes first');
});
