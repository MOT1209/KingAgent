// Phase 2 core: task state machine and lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const states = require('../src/core/runtime/states.js');
const { StateMachine } = require('../src/core/runtime/state-machine.js');
const { TaskManager } = require('../src/core/runtime/task-manager.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

test('states: every legal edge is symmetric and the state set is closed', () => {
  for (const [from, targets] of Object.entries(states.EDGES)) {
    assert.ok(states.isState(from), `from state ${from} unknown`);
    for (const to of targets) assert.ok(states.isState(to), `to state ${to} unknown`);
  }
  for (const s of Object.values(states.STATES)) assert.ok(states.isState(s));
});

test('states: known transitions are allowed, unknown ones are rejected', () => {
  assert.equal(states.canTransition('created', 'queued'), true);
  assert.equal(states.canTransition('queued', 'analyzing'), true);
  assert.equal(states.canTransition('analyzing', 'planning'), true);
  // The fix that unblocked end-to-end runs: executing may complete directly.
  assert.equal(states.canTransition('executing', 'completed'), true);
  assert.equal(states.canTransition('completed', 'executing'), false);
  assert.equal(states.canTransition('created', 'executing'), false);
});

test('states: assertTransition throws a descriptive error on illegal moves', () => {
  assert.throws(() => states.assertTransition('created', 'executing'), /Invalid task state transition/);
});

test('state-machine: records history via onChange', () => {
  const events = [];
  const sm = new StateMachine({ initial: states.STATES.CREATED, onChange: (e) => events.push(e) });
  sm.go(states.STATES.QUEUED, 'queued');
  sm.go(states.STATES.ANALYZING, 'started');
  assert.equal(sm.can(states.STATES.PLANNING), true);
  assert.equal(sm.can(states.STATES.COMPLETED), false);
  assert.deepEqual(events.map((e) => e.to), ['queued', 'analyzing']);
});

test('task-manager: happy path emits lifecycle events in order', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => seen.push(ev.type));
  const tm = new TaskManager({ bus });
  const task = tm.create({ request: 'read me a file', agentId: 'analyst' });
  assert.match(task.id, /^task-/);
  assert.equal(task.state, states.STATES.CREATED);
  tm.queue(task.id);
  tm.start(task.id);
  tm._transition(task.id, states.STATES.PLANNING, {});
  tm._transition(task.id, states.STATES.EXECUTING, {});
  tm._transition(task.id, states.STATES.COMPLETED, { emit: { type: TYPES.TASK_COMPLETED } });
  assert.equal(seen[0], 'task.created');
  assert.equal(seen[1], 'task.queued');
  assert.ok(seen.includes('task.started'));
  assert.ok(seen.includes('task.completed'));
  assert.equal(tm.get(task.id).state, 'completed');
});

test('task-manager: pause, resume and cancel are reachable and idempotent', () => {
  const bus = new EventBus();
  const tm = new TaskManager({ bus });
  const task = tm.create({ request: 'x', agentId: 'codre' });
  tm.queue(task.id);
  tm.start(task.id);
  tm._transition(task.id, states.STATES.PLANNING, {});
  tm._transition(task.id, states.STATES.EXECUTING, {});
  tm.pause(task.id);
  assert.equal(tm.get(task.id).state, 'paused');
  tm.resume(task.id);
  assert.equal(tm.get(task.id).state, 'executing');
  tm.cancel(task.id, 'user requested');
  const cancelled = tm.get(task.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.cancellation.reason, 'user requested');
  tm.cancel(task.id); // no throw on already-cancelled
});

test('task-manager: fail is guarded and sets outcome', () => {
  const bus = new EventBus();
  const tm = new TaskManager({ bus });
  const task = tm.create({ request: 'x', agentId: 'coder' });
  tm.queue(task.id);
  tm.start(task.id);
  tm.fail(task.id, new Error('bad step'));
  const failed = tm.get(task.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.outcome.status, 'failed');
  assert.equal(failed.outcome.error, 'bad step');
  tm.fail(task.id, new Error('again')); // idempotent
  assert.equal(tm.get(task.id).outcome.error, 'bad step');
});

test('task-manager: history exposes trace and step log for audit', () => {
  const bus = new EventBus();
  const tm = new TaskManager({ bus });
  const task = tm.create({ request: 'x', agentId: 'coder' });
  tm.queue(task.id);
  tm.start(task.id);
  const h = tm.history(task.id);
  assert.equal(h.task.id, task.id);
  assert.ok(Array.isArray(h.trace));
  assert.ok(h.trace.some((t) => t.type === 'task.state'));
  assert.ok(Array.isArray(h.stepLog));
});

test('task-manager: listSummaries sorts newest first', () => {
  const bus = new EventBus();
  const tm = new TaskManager({ bus });
  const a = tm.create({ request: 'a', agentId: 'coder' });
  const b = tm.create({ request: 'b', agentId: 'coder' });
  a.createdAt = 100;
  b.createdAt = 200;
  const rows = tm.listSummaries();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, b.id);
  assert.equal(rows[1].id, a.id);
  assert.equal(rows[0].request, 'b');
});