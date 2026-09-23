// A run is the human's unit of work: one objective, and everything it touched.
// The properties under test are that its state machine is guarded (a completed
// run cannot start running again), that its aggregation is bounded and
// deduplicated (a thousand tool events cannot bloat it), and that spend is
// additive so nothing can zero what a run cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const {
  RunManager, RUN_STATES, canTransitionRun, assertRunTransition,
  isTerminalRun, validateRun, createRun,
} = require('../src/core/runs/index.js');
const { createMemoryStore } = require('../src/core/persistence/store.js');
const { createCollections } = require('../src/core/persistence/collections.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ka-runs-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  return dir;
}

function fixture({ caps = {} } = {}) {
  const bus = new EventBus();
  const collections = createCollections(createMemoryStore());
  const manager = new RunManager({ collection: collections.runs, bus, caps });
  return { bus, manager, collections };
}

// --- state machine ---------------------------------------------------------------

test('run: transitions are guarded and terminal states are absorbing', () => {
  assert.equal(canTransitionRun(RUN_STATES.CREATED, RUN_STATES.RUNNING), true);
  assert.equal(canTransitionRun(RUN_STATES.CREATED, RUN_STATES.COMPLETED), false, 'cannot finish before starting');
  assert.equal(canTransitionRun(RUN_STATES.COMPLETED, RUN_STATES.RUNNING), false, 'a finished run never restarts');
  assert.throws(() => assertRunTransition(RUN_STATES.STOPPED, RUN_STATES.RUNNING), /Invalid run state transition/);
  assert.equal(isTerminalRun(RUN_STATES.COMPLETED), true);
  assert.equal(isTerminalRun(RUN_STATES.RUNNING), false);
});

test('run: a run without an objective is invalid', async () => {
  const { manager } = fixture();
  await assert.rejects(() => manager.start({}), /invalid run/);
  assert.equal(validateRun({ id: 'run-1', status: RUN_STATES.CREATED, objective: '' }).ok, false);
  assert.equal(createRun({ objective: 'x' }).status, RUN_STATES.CREATED);
});

// --- lifecycle -------------------------------------------------------------------

test('run: start begins running and emits run.started', async () => {
  const { manager, bus } = fixture();
  const seen = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('run.')) seen.push(ev); });
  const run = await manager.start({ objective: 'build a SaaS app', projectId: 'proj-1' });
  assert.equal(run.status, RUN_STATES.RUNNING);
  assert.equal(run.projectId, 'proj-1');
  assert.equal(seen[0].type, TYPES.RUN_STARTED);
});

test('run: pause, resume, then complete; endedAt is set once terminal', async () => {
  const { manager } = fixture();
  const { id } = await manager.start({ objective: 'ship it' });
  await manager.pause(id);
  assert.equal((await manager.get(id)).status, RUN_STATES.PAUSED);
  await manager.resume(id);
  assert.equal((await manager.get(id)).status, RUN_STATES.RUNNING);
  const done = await manager.complete(id, { result: { ok: true } });
  assert.equal(done.status, RUN_STATES.COMPLETED);
  assert.ok(done.endedAt >= done.startedAt);
  await assert.rejects(() => manager.resume(id), /Invalid run state transition/);
});

test('run: stop() on an already terminal run is a no-op, not an error', async () => {
  const { manager } = fixture();
  const { id } = await manager.start({ objective: 'x' });
  await manager.complete(id);
  const again = await manager.stop(id);
  assert.equal(again.status, RUN_STATES.COMPLETED);
});

test('run: fail records the error and an error entry', async () => {
  const { manager } = fixture();
  const { id } = await manager.start({ objective: 'x' });
  const run = await manager.fail(id, { error: new Error('tool exploded') });
  assert.equal(run.status, RUN_STATES.FAILED);
  assert.equal(run.error, 'tool exploded');
  const detail = await manager.inspect(id);
  assert.equal(detail.errors.at(-1).message, 'tool exploded');
});

test('run: retry is a new run that names its predecessor, never a resurrection', async () => {
  const { manager } = fixture();
  const first = await manager.start({ objective: 'build', conversationId: 'c1' });
  await manager.fail(first.id, { error: 'nope' });
  const second = await manager.retry(first.id);
  assert.notEqual(second.id, first.id);
  assert.equal(second.retryOf, first.id);
  assert.equal(second.objective, 'build');
  assert.equal(second.status, RUN_STATES.RUNNING);
  // The failed attempt survives intact.
  assert.equal((await manager.get(first.id)).status, RUN_STATES.FAILED);
});

// --- aggregation -----------------------------------------------------------------

test('run: noting the same tool twice is a no-op', async () => {
  const { manager } = fixture();
  const { id } = await manager.start({ objective: 'x' });
  await manager.addTool(id, 'fs:read');
  await manager.addTool(id, { id: 'fs:read', name: 'Read' });
  const run = await manager.get(id);
  assert.equal(run.tools.length, 1);
});

test('run: collections are capped, so a runaway agent cannot bloat the record', async () => {
  const { manager } = fixture({ caps: { events: 3 } });
  const { id } = await manager.start({ objective: 'x' });
  for (const type of ['a', 'b', 'c', 'd', 'e']) await manager.addEvent(id, { type });
  const run = await manager.get(id);
  assert.equal(run.events.length, 3);
  assert.deepEqual(run.events.map((e) => e.type), ['c', 'd', 'e'], 'the newest are kept');
});

test('run: usage is additive and has no way to be reset', async () => {
  const { manager } = fixture();
  const { id } = await manager.start({ objective: 'x' });
  await manager.noteUsage(id, { tokens: 100, cost: 1.5, toolCalls: 2 });
  await manager.noteUsage(id, { tokens: 50, cost: 0.5, taskCount: 1 });
  const run = await manager.get(id);
  assert.deepEqual(run.usage, { tokens: 150, cost: 2, toolCalls: 2, taskCount: 1 });
});

test('run: list filters by status and project', async () => {
  const { manager } = fixture();
  const a = await manager.start({ objective: 'one', projectId: 'p1' });
  await manager.start({ objective: 'two', projectId: 'p2' });
  await manager.complete(a.id);
  const completed = await manager.list({ status: RUN_STATES.COMPLETED });
  assert.deepEqual(completed.map((r) => r.id), [a.id]);
  const p2 = await manager.list({ projectId: 'p2' });
  assert.equal(p2.length, 1);
});

// --- inspection ------------------------------------------------------------------

test('run: inspect aggregates counts, spend, duration and a bounded timeline', async () => {
  const { manager } = fixture();
  const { id } = await manager.start({ objective: 'build' });
  await manager.addAgent(id, { id: 'coder', role: 'code' });
  await manager.addArtifact(id, { id: 'art-1', name: 'report' });
  await manager.noteUsage(id, { tokens: 10, cost: 0.1 });
  await manager.addEvent(id, { type: 'step.completed', summary: 'planned' });
  const detail = await manager.inspect(id);
  assert.equal(detail.objective, 'build');
  assert.equal(detail.agents.length, 1);
  assert.equal(detail.artifacts.length, 1);
  assert.equal(detail.usage.tokens, 10);
  assert.ok(detail.durationMs >= 0);

  const timeline = await manager.timeline(id);
  assert.equal(timeline.length, 1);
  assert.ok(timeline[0].offsetMs >= 0);
});

// --- bus integration -------------------------------------------------------------

test('run: attachBus folds any event carrying a runId onto the timeline', async () => {
  const { manager, bus } = fixture();
  manager.attachBus(bus);
  const { id } = await manager.start({ objective: 'x' });
  bus.emit(TYPES.TASK_STARTED, { runId: id, taskId: 't1' }, { title: 'analyze' });
  bus.emit(TYPES.TASK_COMPLETED, { runId: 'run-does-not-exist' }, {});
  await new Promise((r) => setTimeout(r, 20));
  const timeline = await manager.timeline(id);
  assert.ok(timeline.some((e) => e.type === TYPES.TASK_STARTED && e.summary === 'analyze'));
  assert.ok(!timeline.some((e) => e.refs && e.refs.taskId === undefined && e.type === TYPES.TASK_COMPLETED));
});

// --- integration: the orchestrator indexes the objective it ran -----------------

test('run indexing: the orchestrator creates a Run and records the model it chose', async (t) => {
  const dir = await tempProject();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const platform = createPlatform({
    io: {
      root: dir,
      cwd: () => dir,
      // A catalog is what lets the router actually choose rather than fall back.
      models: { providers: { premium: { capabilities: ['tools'], models: ['big'], cost: 1 } } },
    },
  });
  t.after(() => platform.dispose());

  const record = await platform.orchestrator.handle({
    request: 'read package.json',
    mode: 'single-agent',
    workspace: { root: dir },
  });
  await record.result;

  assert.ok(record.runId, 'the objective was indexed as a run');
  const runs = await platform.runs.list();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, record.runId);

  const detail = await platform.runs.inspect(record.runId);
  assert.ok(detail.agents.length >= 1, 'the responsible agent is recorded');
  assert.ok(detail.providers.some((p) => p.id === 'premium'), 'the chosen provider is recorded');
  assert.ok(detail.events.length >= 1, 'the timeline captured at least the routed event');
  assert.ok(['completed', 'failed'].includes(detail.status));
});

test('platform: chief runs work as Rashid and lists the roster', async (t) => {
  const dir = await tempProject();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const platform = createPlatform({ io: { root: dir, cwd: () => dir } });
  t.after(() => platform.dispose());

  const record = await platform.chief.execute({ request: 'read package.json', workspace: { root: dir } });
  await record.result;
  assert.equal(record.agentId, 'rashid', 'execution is attributed to the executive');

  const roster = platform.chief.roster();
  assert.deepEqual(roster.system.map((a) => a.id).sort(), ['ahmad', 'rashid']);
});
