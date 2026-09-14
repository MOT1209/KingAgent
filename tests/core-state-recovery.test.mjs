// Pause, resume, and picking up after a crash. The rule under test everywhere
// here: never blindly replay a destructive action. A snapshot that ended mid a
// mutating action with no recorded outcome must come back asking a human, not
// guessing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  StateRecoveryManager, RECOVERY_ACTIONS, AgentStateStore,
  createAgentStateSnapshot, isInterrupted, endedMidMutation, SNAPSHOT_REASONS,
} = require('../src/core/state/index.js');
const { WorkspaceManager } = require('../src/core/workspace/index.js');
const { createAction, ACTION_TYPES } = require('../src/core/runtime/action.js');
const { createObservation } = require('../src/core/runtime/observation.js');
const { createCollections } = require('../src/core/persistence/collections.js');
const { createMemoryStore } = require('../src/core/persistence/store.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

// --- snapshot ------------------------------------------------------------------

test('snapshot: carries references, never the content of what it refers to', () => {
  const snap = createAgentStateSnapshot({
    identity: { taskId: 't1', workspaceId: 'ws1' },
    status: 'executing',
    memoryRefs: ['mem-1'],
    contextRefs: ['ctx-1'],
    artifactRefs: ['art-1'],
  });
  assert.deepEqual(snap.memoryRefs, ['mem-1']);
  assert.ok(!('content' in snap), 'no field carries memory content');
  assert.equal(snap.taskId, 't1');
});

test('snapshot: isInterrupted is true only for a non-terminal status', () => {
  assert.equal(isInterrupted({ status: 'executing' }), true);
  assert.equal(isInterrupted({ status: 'paused' }), true);
  assert.equal(isInterrupted({ status: 'completed' }), false);
  assert.equal(isInterrupted({ status: 'failed' }), false);
});

test('snapshot: endedMidMutation is true only when a mutating action has no observation', () => {
  const mutatingNoResult = { lastAction: { mutating: true }, lastObservation: null };
  const mutatingWithResult = { lastAction: { mutating: true }, lastObservation: { id: 'o1' } };
  const readOnly = { lastAction: { mutating: false }, lastObservation: null };
  assert.equal(endedMidMutation(mutatingNoResult), true);
  assert.equal(endedMidMutation(mutatingWithResult), false);
  assert.equal(endedMidMutation(readOnly), false);
});

// --- store -----------------------------------------------------------------

test('store: latest() and history() track snapshots per task, bounded', async () => {
  const store = new AgentStateStore({ options: { keepPerTask: 3 } });
  for (let i = 0; i < 5; i += 1) {
    await store.put(createAgentStateSnapshot({ identity: { taskId: 't1' }, status: 'executing', currentStep: `s${i}` }));
  }
  assert.equal(store.history('t1').length, 3, 'bounded to keepPerTask');
  assert.equal(store.latest('t1').currentStep, 's4');
});

test('store: listInterrupted merges live and persisted, live wins on duplicates', async () => {
  const collections = createCollections(createMemoryStore());
  const store = new AgentStateStore({ collection: collections.agentState });
  await store.put(createAgentStateSnapshot({ identity: { taskId: 't1' }, status: 'executing' }));
  await store.put(createAgentStateSnapshot({ identity: { taskId: 't2' }, status: 'completed' }));
  const interrupted = await store.listInterrupted();
  assert.deepEqual(interrupted.map((s) => s.taskId), ['t1']);
});

// --- recovery manager --------------------------------------------------------

function fixture() {
  const bus = new EventBus();
  const workspaces = new WorkspaceManager({ bus });
  const recovery = new StateRecoveryManager({ workspaces, bus });
  const workspace = workspaces.create({ root: process.cwd(), identity: { agentId: 'coder' } });
  return { bus, workspaces, recovery, workspace };
}

test('recovery: decide asks a human when the last action was mutating with no result', () => {
  const { recovery } = fixture();
  const snap = createAgentStateSnapshot({
    identity: { taskId: 't1' }, status: 'executing', currentStep: 's1',
    lastAction: { type: 'delete_file', target: 'x.js', mutating: true },
    lastObservation: null,
  });
  const decision = recovery.decide(snap);
  assert.equal(decision.action, RECOVERY_ACTIONS.ASK);
  assert.match(decision.reason, /delete_file/);
});

test('recovery: decide continues a read-only step that was in flight', () => {
  const { recovery } = fixture();
  const snap = createAgentStateSnapshot({
    identity: { taskId: 't1' }, status: 'executing', currentStep: 's1',
    lastAction: { type: 'read_file', mutating: false },
    lastObservation: { id: 'o1' },
  });
  assert.equal(recovery.decide(snap).action, RECOVERY_ACTIONS.CONTINUE);
});

test('recovery: decide replans after a mutating action that did complete', () => {
  const { recovery } = fixture();
  const snap = createAgentStateSnapshot({
    identity: { taskId: 't1' }, status: 'executing', currentStep: 's1',
    lastAction: { type: 'write_file', mutating: true },
    lastObservation: { id: 'o1' },
  });
  assert.equal(recovery.decide(snap).action, RECOVERY_ACTIONS.REPLAN);
});

test('recovery: decide asks when approvals were outstanding', () => {
  const { recovery } = fixture();
  const snap = createAgentStateSnapshot({ identity: { taskId: 't1' }, status: 'executing', pendingApprovals: ['apr-1'] });
  assert.equal(recovery.decide(snap).action, RECOVERY_ACTIONS.ASK);
});

test('recovery: decide discards a task that already ended', () => {
  const { recovery } = fixture();
  const snap = createAgentStateSnapshot({ identity: { taskId: 't1' }, status: 'completed' });
  assert.equal(recovery.decide(snap).action, RECOVERY_ACTIONS.DISCARD);
});

test('recovery: capture records a real Action/Observation-shaped snapshot', async () => {
  const { recovery, workspace } = fixture();
  const action = createAction({ type: ACTION_TYPES.WRITE_FILE, target: 'a.js', identity: workspace.identity });
  const observation = createObservation({ summary: 'wrote a.js', ok: true, identity: workspace.identity });
  const snap = await recovery.capture({
    workspace, task: { state: 'executing', steps: [], plan: null },
    currentStep: 's1', lastAction: action, lastObservation: observation, reason: SNAPSHOT_REASONS.STEP,
  });
  assert.equal(snap.lastAction.type, ACTION_TYPES.WRITE_FILE);
  assert.equal(snap.lastAction.mutating, true);
  assert.equal(snap.lastObservation.summary, 'wrote a.js');
});

test('recovery: pause suspends the workspace and preserves its identity', async () => {
  const { recovery, workspace, workspaces } = fixture();
  await recovery.pause({ workspace, task: { state: 'paused', steps: [], plan: null } });
  assert.equal(workspaces.get(workspace.workspaceId).status, 'suspended');
});

test('recovery: resume reactivates the workspace and returns a decision', async () => {
  const { recovery, workspace, workspaces } = fixture();
  await recovery.capture({ workspace, task: { state: 'paused', steps: [], plan: null }, reason: SNAPSHOT_REASONS.PAUSE });
  workspaces.suspend(workspace.workspaceId);
  const result = await recovery.resume(workspace.taskId);
  assert.equal(result.ok, true);
  assert.equal(result.action, RECOVERY_ACTIONS.CONTINUE);
  assert.equal(workspaces.get(workspace.workspaceId).status, 'active');
});

test('recovery: resume with no snapshot reports discard, not a crash', async () => {
  const { recovery } = fixture();
  const result = await recovery.resume('never-existed');
  assert.equal(result.ok, false);
  assert.equal(result.action, RECOVERY_ACTIONS.DISCARD);
});

test('recovery: listInterrupted decides every task at once', async () => {
  const { recovery, workspaces } = fixture();
  const ws1 = workspaces.create({ root: process.cwd(), identity: { agentId: 'coder' } });
  const ws2 = workspaces.create({ root: process.cwd(), identity: { agentId: 'coder' } });
  await recovery.capture({ workspace: ws1, task: { state: 'executing', steps: [], plan: null }, currentStep: 's1', lastAction: { type: 'delete_file', mutating: true } });
  await recovery.capture({ workspace: ws2, task: { state: 'completed', steps: [], plan: null } });
  const list = await recovery.listInterrupted();
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, ws1.taskId);
  assert.equal(list[0].decision.action, RECOVERY_ACTIONS.ASK);
});

test('recovery: capture emits a correlated state.snapshot.created event', async () => {
  const { recovery, workspace, bus } = fixture();
  const seen = [];
  bus.on(TYPES.STATE_SNAPSHOT_CREATED, (ev) => seen.push(ev));
  await recovery.capture({ workspace, task: { state: 'executing', steps: [], plan: null } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].workspaceId, workspace.workspaceId);
  assert.equal(seen[0].traceId, workspace.traceId);
});
