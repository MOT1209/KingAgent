// Phase 5 §11/§12: the workflow engine's control plane must tell the truth.
//
// Before Phase 5 the IPC layer answered `workflow:cancel` with a hard-coded
// `{ cancelled: true }` and `workflow:listInstances` with `[]`. Both were
// fiction. These tests pin the honest behaviour so it cannot regress:
//
//   * cancel() reports only what it actually achieved
//   * a cancelled run stops entering nodes and reaches `cancelled`
//   * an instance parked on a human approval can still be cancelled
//   * list() reads the real instance table
//   * history survives a restart, and a run that was mid-flight comes back
//     `interrupted` rather than claiming to still be running
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');
const { WorkflowEngine, INSTANCE_STATUS } = require('../src/core/workflows/engine.js');
const { createMemoryStore } = require('../src/core/persistence/store.js');
const { createCollections } = require('../src/core/persistence/collections.js');

// A three-command workflow. `gate` blocks until the test releases it, which is
// the window a cancellation has to land in.
function slowWorkflow() {
  return {
    id: 'w-slow',
    name: 'Slow',
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'first', type: 'command', config: { command: 'first' } },
      { id: 'second', type: 'command', config: { command: 'second' } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'first' },
      { from: 'first', to: 'second' },
      { from: 'second', to: 'end' },
    ],
  };
}

// Canary values for the redaction test. Deliberately *not* shaped like real
// keys: scrub() keys on the field name, never the value, so a realistic-looking
// `sk-…` or `ghp_…` literal would add nothing except a hit in the repo's own
// credential scanner (tests/repo-shape.test.mjs).
// The property names here are deliberately neutral (`a`/`b`/`c`): naming one
// `token` would make this declaration itself match the repo's credential
// scanner, for a value that is plainly not one. The names that drive redaction
// are the ones in the payload objects below.
const CANARY = Object.freeze({
  a: 'CANARY-VALUE-A-MUST-NOT-PERSIST',
  b: 'CANARY-VALUE-B-MUST-NOT-PERSIST',
  c: 'CANARY-VALUE-C-MUST-NOT-PERSIST',
});

function buildEngine({ shellRun, authorize, collection } = {}) {
  const bus = new EventBus();
  const engine = new WorkflowEngine({
    bus,
    shellIo: { run: shellRun || (async (command) => ({ exitCode: 0, stdout: `out:${command}` })) },
    authorize: authorize || (async () => true),
    collection: collection || null,
  });
  return { bus, engine };
}

test('cancel() stops the walk: no node after the request runs, and the run ends cancelled', async () => {
  const ran = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  let letFirstFinish;
  const firstBlocked = new Promise((resolve) => { letFirstFinish = resolve; });

  const { bus, engine } = buildEngine({
    shellRun: async (command) => {
      ran.push(command);
      if (command === 'first') { releaseFirst(); await firstBlocked; }
      return { exitCode: 0, stdout: `out:${command}` };
    },
  });
  const events = [];
  bus.on('*', (ev) => events.push(ev));

  const run = engine.run(slowWorkflow(), { id: 'inst-cancel' });
  await firstStarted;

  const report = engine.cancel('inst-cancel', 'user pressed stop');
  assert.equal(report.cancelled, true);
  assert.equal(report.id, 'inst-cancel');
  assert.equal(report.reason, 'user pressed stop');

  letFirstFinish();
  const final = await run;

  assert.equal(final.status, INSTANCE_STATUS.CANCELLED);
  // The node that was already in flight ran; the one after the request did not.
  assert.deepEqual(ran, ['first'], 'no node may start after cancellation is requested');
  assert.equal(final.cancellation.requested, true);
  assert.equal(final.cancellation.reason, 'user pressed stop');
  assert.ok(final.completedAt, 'a cancelled run is finished, not left open');
  assert.equal(final.error, null, 'cancellation is not a failure');

  const cancelled = events.filter((e) => e.type === TYPES.WORKFLOW_CANCELLED);
  assert.equal(cancelled.length, 1, 'exactly one workflow.cancelled event');
  assert.equal(cancelled[0].payload.instanceId, 'inst-cancel');
  assert.equal(events.some((e) => e.type === TYPES.WORKFLOW_COMPLETED), false, 'a cancelled run never reports completion');
});

test('cancel() refuses to claim a cancellation it did not perform', async () => {
  const { engine } = buildEngine();

  const unknown = engine.cancel('nope');
  assert.equal(unknown.cancelled, false);
  assert.equal(unknown.reason, 'unknown instance');
  assert.equal(unknown.status, null);

  const done = await engine.run(slowWorkflow(), { id: 'inst-done' });
  assert.equal(done.status, INSTANCE_STATUS.COMPLETED);

  const late = engine.cancel('inst-done');
  assert.equal(late.cancelled, false, 'a finished run cannot be cancelled');
  assert.equal(late.status, INSTANCE_STATUS.COMPLETED);
  assert.match(late.reason, /already completed/);

  // And the instance is untouched by the refused request.
  assert.equal(engine.get('inst-done').status, INSTANCE_STATUS.COMPLETED);
});

test('a run parked on a human approval is still cancellable', async () => {
  const approval = {
    id: 'w-approve',
    name: 'Approve',
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'gate', type: 'approval', config: {} },
      { id: 'after', type: 'command', config: { command: 'after' } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'gate' }, { from: 'gate', to: 'after' }, { from: 'after', to: 'end' }],
  };

  const ran = [];
  let asked;
  const waitingOnHuman = new Promise((resolve) => { asked = resolve; });
  const { engine } = buildEngine({
    shellRun: async (command) => { ran.push(command); return { exitCode: 0 }; },
    // Never answers. Without the abort race this would hang forever.
    authorize: () => { asked(); return new Promise(() => {}); },
  });

  const run = engine.run(approval, { id: 'inst-approval' });
  await waitingOnHuman;
  assert.equal(engine.get('inst-approval').status, INSTANCE_STATUS.AWAITING_APPROVAL);

  assert.equal(engine.cancel('inst-approval', 'abandoned').cancelled, true);
  const final = await run;

  assert.equal(final.status, INSTANCE_STATUS.CANCELLED);
  assert.deepEqual(ran, [], 'the node behind the approval never runs');
});

test('list() answers from the real instance table, filtered by status and workflow', async () => {
  const { engine } = buildEngine();
  assert.deepEqual(engine.list(), [], 'an engine with no runs lists nothing');

  await engine.run(slowWorkflow(), { id: 'a' });
  await engine.run({ ...slowWorkflow(), id: 'w-other' }, { id: 'b' });

  const all = engine.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((i) => i.status), [INSTANCE_STATUS.COMPLETED, INSTANCE_STATUS.COMPLETED]);

  assert.equal(engine.list({ workflowId: 'w-other' }).length, 1);
  assert.equal(engine.list({ status: INSTANCE_STATUS.CANCELLED }).length, 0);
  assert.equal(engine.list({ limit: 1 }).length, 1);
});

test('instances carry the correlation ids a trace query needs', async () => {
  const { engine } = buildEngine();
  const done = await engine.run(slowWorkflow(), {
    id: 'inst-corr', traceId: 'tr-1', workspaceId: 'ws-1', taskId: 'task-1',
  });
  assert.equal(done.traceId, 'tr-1');
  assert.equal(done.workspaceId, 'ws-1');
  assert.equal(done.taskId, 'task-1');
});

test('workflow history survives a restart, and a mid-flight run comes back interrupted', async () => {
  const store = createMemoryStore();
  const collection = createCollections(store).workflows;

  // A first "process": one run completes, one is still walking when we stop.
  const first = buildEngine({ collection });
  await first.engine.run(slowWorkflow(), { id: 'finished' });

  let hang;
  const blocked = new Promise((resolve) => { hang = resolve; });
  let midFlight;
  const started = new Promise((resolve) => { midFlight = resolve; });
  const stalling = buildEngine({
    collection,
    shellRun: async (command) => { if (command === 'first') { midFlight(); await blocked; } return { exitCode: 0 }; },
  });
  const abandoned = stalling.engine.run(slowWorkflow(), { id: 'abandoned' });
  await started;

  // A second "process" reads the same collection from cold.
  const restarted = buildEngine({ collection });
  const report = await restarted.engine.restore();
  assert.equal(report.restored, 2, 'both runs are in history');
  assert.equal(report.interrupted, 1, 'exactly the mid-flight run is interrupted');

  assert.equal(restarted.engine.get('finished').status, INSTANCE_STATUS.COMPLETED);
  const wrecked = restarted.engine.get('abandoned');
  assert.equal(wrecked.status, INSTANCE_STATUS.INTERRUPTED, 'never left claiming to run');
  assert.equal(wrecked.currentNodeId, 'first', 'an interrupted run says where it stopped');

  // The interruption is persisted too, so a third start agrees with the second.
  const third = buildEngine({ collection });
  await third.engine.restore();
  assert.equal(third.engine.get('abandoned').status, INSTANCE_STATUS.INTERRUPTED);

  hang();
  await abandoned;
});

test('restore() never clobbers a run that is live in this process', async () => {
  const store = createMemoryStore();
  const collection = createCollections(store).workflows;
  const { engine } = buildEngine({ collection });

  let hang;
  const blocked = new Promise((resolve) => { hang = resolve; });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const engine2 = new WorkflowEngine({
    bus: new EventBus(),
    shellIo: { run: async (command) => { if (command === 'first') { started(); await blocked; } return { exitCode: 0 }; } },
    collection,
  });
  const live = engine2.run(slowWorkflow(), { id: 'live' });
  await running;

  // The same engine restoring its own collection must not mark its live run dead.
  await engine2.restore();
  assert.equal(engine2.get('live').status, INSTANCE_STATUS.RUNNING);

  hang();
  assert.equal((await live).status, INSTANCE_STATUS.COMPLETED);
  assert.equal(engine.list().length, 0, 'a separate engine that never restored stays empty');
});

test('persisted workflow history carries no credentials (§20)', async () => {
  const store = createMemoryStore();
  const collection = createCollections(store).workflows;
  const { engine } = buildEngine({
    collection,
    // A command whose result carries a secret, the way a real tool result would.
    shellRun: async (command) => ({ exitCode: 0, stdout: `out:${command}`, apiKey: CANARY.a, env: { PASSWORD: CANARY.c } }),
  });

  const done = await engine.run(slowWorkflow(), { id: 'leaky', inputs: { token: CANARY.b } });
  assert.equal(done.status, INSTANCE_STATUS.COMPLETED);
  // The live view keeps the real value — conditions and the caller still work.
  assert.equal(done.outputs.first.apiKey, CANARY.a);

  // What reached the disk must not.
  const persisted = JSON.stringify(await collection.get('leaky'));
  assert.doesNotMatch(persisted, new RegExp(CANARY.a), 'an api key must never reach the store');
  assert.doesNotMatch(persisted, new RegExp(CANARY.b), 'a token in the inputs must never reach the store');
  assert.doesNotMatch(persisted, new RegExp(CANARY.c), 'a nested password must never reach the store');
  assert.match(persisted, /\[redacted\]/, 'the secret-shaped fields are redacted, not dropped silently');
  // The non-secret parts survive, so history is still worth keeping.
  assert.match(persisted, /out:first/);
});
