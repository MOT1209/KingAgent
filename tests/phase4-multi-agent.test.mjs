// Phase 4: multi-agent coordination (delegation, messages, handoff, parallel, review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { IS_WINDOWS } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const {
  createAgentCoordinator,
  createFileLockManager,
  createMessage,
  replyTo,
  validateMessage,
  createHandoff,
  validateHandoff,
  containment,
  TEAM_TEMPLATES,
  ROLES,
  DelegationDeniedError,
} = require('../src/core/orchestrator');
const { AgentRegistry } = require('../src/core/agents/registry');
const { EventBus, TYPES } = require('../src/core/events/event-bus');

function registry() {
  const agents = new AgentRegistry();
  agents.register({
    id: 'lead',
    name: 'Lead',
    capabilities: ['code', 'read', 'write', 'run_tests'],
    permissions: { levels: ['read_only', 'safe', 'moderate'], allowDestructive: false },
  });
  agents.register({
    id: 'analyst',
    name: 'Analyst',
    capabilities: ['read'],
    permissions: { levels: ['read_only', 'safe'], allowDestructive: false },
  });
  agents.register({
    id: 'reviewer',
    name: 'Reviewer',
    capabilities: ['read', 'review'],
    permissions: { levels: ['read_only'], allowDestructive: false },
  });
  return agents;
}

function makeCoordinator({ agents = registry(), bus = null, locks = null, artifacts = null, policy = null, sessions = null, harnesses = null, sandboxes = null, runDelegate = null } = {}) {
  return createAgentCoordinator({ bus, agentRegistry: agents, locks, artifacts, policy, sessions, harnesses, sandboxes, runDelegate });
}

test('delegation: a child cannot be granted more than its parent holds', () => {
  const denied = containment(
    { permissions: { levels: ['read_only', 'safe'], allowDestructive: false } },
    { permissions: { levels: ['read_only', 'safe', 'destructive'], allowDestructive: true } },
  );
  assert.equal(denied.ok, false);
  assert.match(denied.reasons.join(' '), /destructive/);
  assert.match(denied.reasons.join(' '), /child allows destructive/);

  const allowed = containment(
    { permissions: { levels: ['read_only', 'safe', 'moderate'], allowDestructive: true } },
    { permissions: { levels: ['read_only', 'safe'], allowDestructive: false } },
  );
  assert.equal(allowed.ok, true);
});

test('delegation: path scope is contained too, and an undeclared parent scope constrains nothing', () => {
  const outside = containment(
    { permissions: { levels: ['read_only'] }, scope: { paths: ['/ws/project'] } },
    { permissions: { levels: ['read_only'] }, scope: { paths: ['/ws/secrets'] } },
  );
  assert.equal(outside.ok, false);
  assert.match(outside.reasons.join(' '), /outside the parent scope/);

  const inside = containment(
    { permissions: { levels: ['read_only'] }, scope: { paths: ['/ws'] } },
    { permissions: { levels: ['read_only'] }, scope: { paths: ['/ws/project/src'] } },
  );
  assert.equal(inside.ok, true);

  const undeclared = containment({ permissions: { levels: ['read_only'] } }, { permissions: { levels: ['read_only'] }, scope: { paths: ['/anywhere'] } });
  assert.equal(undeclared.ok, true, 'without a declared parent scope there is nothing to widen');
});

test('delegation: every §27 field is carried and the record is auditable on its own', async () => {
  const bus = new EventBus();
  const events = [];
  bus.on('*', (ev) => events.push(ev));
  const coordinator = makeCoordinator({ bus });

  const delegation = await coordinator.delegate({
    parentTaskId: 'task-1',
    parentAgentId: 'lead',
    childAgentId: 'analyst',
    role: ROLES.RESEARCH,
    objective: 'Map the authentication flow',
    workspaceId: '/ws',
    timeoutMs: 30_000,
    resultSchema: { findings: 'array' },
    traceId: 'trace-1',
    sessionId: 'sess-1',
    harnessId: 'claude-code',
    scope: { paths: ['/ws/src'] },
  });

  assert.ok(delegation.id);
  assert.equal(delegation.parentTaskId, 'task-1');
  assert.equal(delegation.parentAgentId, 'lead');
  assert.equal(delegation.childAgentId, 'analyst');
  assert.equal(delegation.workspaceId, '/ws');
  assert.equal(delegation.timeoutMs, 30_000);
  assert.deepEqual(delegation.resultSchema, { findings: 'array' });
  assert.equal(delegation.traceId, 'trace-1');
  assert.equal(delegation.status, 'pending');

  const delegated = events.find((e) => e.type === TYPES.AGENT_DELEGATED);
  assert.equal(delegated.delegationId, delegation.id);
  assert.equal(delegated.taskId, 'task-1');
  assert.equal(delegated.agentId, 'analyst');

  const messages = coordinator.messages({ taskId: 'task-1' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'DELEGATION');
  assert.equal(messages[0].from, 'lead');
  assert.equal(messages[0].to, 'analyst');
});

test('delegation: an escalation attempt is refused before any work starts', async () => {
  const coordinator = makeCoordinator();
  await assert.rejects(
    () => coordinator.delegate({
      parentTaskId: 'task-1',
      parentAgentId: 'lead',
      childAgentId: 'analyst',
      objective: 'Delete the build directory',
      permissions: { levels: ['read_only', 'safe', 'destructive'], allowDestructive: true },
    }),
    (err) => err instanceof DelegationDeniedError && /widen permissions/.test(err.message),
  );
  assert.equal(coordinator.stats().delegations, 0, 'a refused delegation leaves no trace to clean up');

  await assert.rejects(
    () => coordinator.delegate({ parentTaskId: 't', parentAgentId: 'lead', childAgentId: 'ghost', objective: 'x' }),
    /unknown child agent/,
  );
});

test('delegation: depth is bounded and the tree is reconstructable', async () => {
  const coordinator = makeCoordinator();
  const root = await coordinator.delegate({ parentTaskId: 'task-1', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'root' });
  const child = await coordinator.delegate({
    parentTaskId: 'task-1',
    parentAgentId: 'analyst',
    childAgentId: 'reviewer',
    objective: 'child',
    parentDelegationId: root.id,
    depth: 2,
  });
  assert.equal(child.parentDelegationId, root.id);
  await coordinator.delegate({ parentTaskId: 'task-1', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'too deep', depth: 5, parentDelegationId: child.id })
    .then(() => assert.fail('should have refused'))
    .catch((err) => assert.match(err.message, /depth/));

  const tree = coordinator.tree('task-1');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, root.id);
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].id, child.id);

  const view = coordinator.controlView('task-1');
  assert.equal(view.subAgents.length, 2);
  assert.deepEqual(view.subAgents.map((s) => s.role), ['worker', 'worker']);
});

test('delegation: a policy denial stops the delegation', async () => {
  const policy = { evaluate: async () => ({ effect: 'deny', reason: 'delegation is disabled' }) };
  const coordinator = makeCoordinator({ policy });
  await assert.rejects(
    () => coordinator.delegate({ parentTaskId: 't', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'x' }),
    /denied by policy: delegation is disabled/,
  );
});

test('messages: the protocol validates shape and replies inherit correlation', () => {
  const message = createMessage({
    type: 'REQUEST',
    from: 'lead',
    to: 'analyst',
    taskId: 'task-1',
    delegationId: 'del-1',
    traceId: 'trace-1',
    payload: { objective: 'review the diff', prompt: 'ignored: not a protocol key' },
  });
  assert.equal(validateMessage(message).ok, true);
  assert.equal(message.payload.prompt, undefined, 'unknown payload keys are dropped, so a prompt cannot ride along');

  const reply = replyTo(message, { type: 'RESULT', payload: { result: { ok: true } } });
  assert.equal(reply.to, 'lead', 'a reply goes back to the sender');
  assert.equal(reply.inReplyTo, message.id);
  assert.equal(reply.taskId, 'task-1');
  assert.equal(reply.delegationId, 'del-1');
  assert.equal(reply.traceId, 'trace-1');

  assert.equal(validateMessage({ ...message, type: 'CHAT' }).ok, false);
  assert.equal(validateMessage({ ...message, from: '' }).ok, false);
});

test('messages: the coordinator records every exchange and reports results', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on(TYPES.AGENT_MESSAGE, (ev) => seen.push(ev.payload));
  const coordinator = makeCoordinator({ bus });
  const delegation = await coordinator.delegate({ parentTaskId: 'task-1', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'map it' });

  coordinator.markRunning(delegation.id);
  coordinator.send({ type: 'STATUS', from: 'analyst', to: 'lead', taskId: 'task-1', delegationId: delegation.id, payload: { progress: 0.5 } });
  const done = coordinator.markComplete(delegation.id, { status: 'completed', summary: 'mapped', artifactIds: ['art-1'] });

  assert.equal(done.status, 'completed');
  assert.deepEqual(done.artifactIds, ['art-1']);
  assert.equal(seen.length, 3, 'delegation, status and result all went through the protocol');
  assert.deepEqual(seen.map((s) => s.type), ['DELEGATION', 'STATUS', 'RESULT']);
  assert.equal(coordinator.stats().messages, 3);
});

test('handoff: the eight fields are required, bounded, and carry no transcript', () => {
  const record = createHandoff({
    objective: 'Finish the migration',
    currentState: 'Schema updated, data untouched',
    relevantFiles: ['src/db/schema.ts'],
    constraints: ['no downtime'],
    results: ['tests pass locally'],
    memoryRefs: ['task:t1:schema'],
    artifacts: ['art-1'],
    outstandingIssues: ['rollback untested'],
    from: 'lead',
    to: 'analyst',
  });
  assert.deepEqual(Object.keys(record).filter((k) => ['objective', 'currentState', 'relevantFiles', 'constraints', 'results', 'memoryRefs', 'artifacts', 'outstandingIssues'].includes(k)).sort(),
    ['artifacts', 'constraints', 'currentState', 'memoryRefs', 'objective', 'outstandingIssues', 'relevantFiles', 'results'].sort());
  assert.equal(Object.hasOwn(record, 'transcript'), false);
  assert.equal(Object.hasOwn(record, 'messages'), false);

  assert.equal(validateHandoff({ ...record, objective: '' }).ok, false);
  assert.equal(validateHandoff({ ...record, relevantFiles: 'src/x.ts' }).ok, false);

  const long = createHandoff({ objective: 'x', currentState: 'y', relevantFiles: Array.from({ length: 100 }, (_, i) => `f${i}.ts`) });
  assert.equal(long.relevantFiles.length, 40, 'handoffs are bounded so they stay handoffs');
});

test('handoff: the coordinator posts it as a message and reports readiness', async () => {
  const bus = new EventBus();
  const events = [];
  bus.on(TYPES.AGENT_HANDOFF, (ev) => events.push(ev));
  const coordinator = makeCoordinator({ bus });
  const delegation = await coordinator.delegate({ parentTaskId: 'task-1', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'map it' });

  const result = coordinator.handoff({
    from: 'analyst',
    to: 'reviewer',
    taskId: 'task-1',
    delegationId: delegation.id,
    handoff: { objective: 'review the map', currentState: 'mapping complete' },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.ready, true);

  const incomplete = coordinator.handoff({ from: 'a', to: 'b', taskId: 'task-1', handoff: { objective: 'x' } });
  assert.equal(incomplete.ready, false);
  assert.deepEqual(incomplete.missing, ['currentState']);

  const messages = coordinator.messages({ taskId: 'task-1' });
  assert.equal(messages.filter((m) => m.type === 'HANDOFF').length, 2);
});

test('file locks: readers share, writers conflict, and normalisation is OS-aware', () => {
  const locks = createFileLockManager();
  const readerA = locks.acquire({ ownerId: 'a', paths: ['/ws/src/app.ts'], mode: 'read' });
  assert.equal(readerA.ok, true);
  const readerB = locks.acquire({ ownerId: 'b', paths: ['/ws/src/app.ts'], mode: 'read' });
  assert.equal(readerB.ok, true, 'two readers cannot corrupt each other');

  assert.equal(locks.size(), 2, 'both readers are held at once, not overwritten');
  assert.equal(locks.keyCount(), 1, 'one path, two holders');

  const writer = locks.acquire({ ownerId: 'c', paths: ['/ws/src/app.ts'], mode: 'write' });
  assert.equal(writer.ok, false);
  assert.equal(writer.conflicts.length, 2, 'the writer names every reader in its way');
  assert.deepEqual(writer.conflicts.map((c) => c.ownerId).sort(), ['a', 'b']);

  locks.release('a');
  locks.release('b');
  assert.equal(locks.acquire({ ownerId: 'c', paths: ['/ws/src/app.ts'], mode: 'write' }).ok, true);
  assert.equal(locks.acquire({ ownerId: 'd', paths: ['/ws/src/app.ts'], mode: 'write' }).ok, false);

  assert.equal(locks.ownerLocks('c').length, 1);
  assert.equal(locks.acquire({ ownerId: 'c', paths: ['/ws/src/app.ts'], mode: 'write' }).ok, true, 'the same owner re-acquires what it holds');
  assert.equal(IS_WINDOWS ? locks.normalizeKey('/ws/App.ts') === locks.normalizeKey('/ws/app.ts') : true, true);
  locks.clear();
  assert.equal(locks.size(), 0);
  assert.equal(locks.keyCount(), 0);
});

test('file locks: withLocks releases on success and on throw', async () => {
  const locks = createFileLockManager();
  const ok = await locks.withLocks({ ownerId: 'a', paths: ['/ws/x.ts'] }, async () => 'done');
  assert.equal(ok.ok, true);
  assert.equal(ok.result, 'done');
  assert.equal(locks.size(), 0);

  await assert.rejects(() => locks.withLocks({ ownerId: 'a', paths: ['/ws/x.ts'] }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(locks.size(), 0, 'a throwing agent must not leave a lock behind');

  locks.acquire({ ownerId: 'holder', paths: ['/ws/x.ts'] });
  const refused = await locks.withLocks({ ownerId: 'b', paths: ['/ws/x.ts'] }, async () => 'never');
  assert.equal(refused.ok, false);
  assert.equal(refused.result, null);
  assert.equal(refused.conflicts[0].ownerId, 'holder');
});

test('parallel: two children cannot write the same file, and the blocked one says why', async () => {
  const locks = createFileLockManager();
  const artifacts = { add: () => ({ id: 'art-1' }), list: () => [] };
  const coordinator = makeCoordinator({ locks, artifacts });

  const first = await coordinator.delegate({ parentTaskId: 'task-1', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'write A', scope: { paths: ['/ws/shared.ts'] } });
  const second = await coordinator.delegate({ parentTaskId: 'task-1', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'write B', scope: { paths: ['/ws/shared.ts'] } });

  const started = [];
  const results = await coordinator.runParallel([first.id, second.id], {
    runner: async (delegation) => {
      started.push(delegation.id);
      // hold the lock long enough for the second runner to be refused
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true };
    },
  });

  const blocked = results.filter((r) => r.status === 'blocked');
  assert.equal(blocked.length, 1, 'exactly one writer takes the file');
  assert.match(blocked[0].conflicts[0].path, /shared\.ts/);
  assert.equal(started.length, 1, 'the blocked child never started');
  assert.equal(locks.size(), 0, 'locks are released when the run finishes');
  assert.equal(coordinator.stats().locks, 0);
});

test('parallel: independent scopes run together and failures are contained', async () => {
  const locks = createFileLockManager();
  const coordinator = makeCoordinator({ locks });
  const a = await coordinator.delegate({ parentTaskId: 't', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'a', scope: { paths: ['/ws/a.ts'] } });
  const b = await coordinator.delegate({ parentTaskId: 't', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'b', scope: { paths: ['/ws/b.ts'] } });

  const results = await coordinator.runParallel([a.id, b.id], {
    runner: async (delegation) => {
      if (delegation.id === b.id) throw new Error('child b exploded');
      return { ok: true, note: 'a done' };
    },
  });
  const byId = Object.fromEntries(results.map((r) => [r.delegationId, r]));
  assert.equal(byId[a.id].status, 'completed');
  assert.equal(byId[b.id].status, 'failed');
  assert.match(byId[b.id].error, /exploded/);
  assert.equal(locks.size(), 0);
});

test('cancellation: cancelling a lead cancels its children and their runs', async () => {
  const stoppedTasks = [];
  const harnesses = { stopTask: async (taskId, reason) => { stoppedTasks.push([taskId, reason]); return ['run-1']; } };
  const sandboxes = { stopTask: async (taskId) => { stoppedTasks.push(['sandbox', taskId]); return ['sandbox-1']; } };
  const coordinator = makeCoordinator({ harnesses, sandboxes });

  const root = await coordinator.delegate({ parentTaskId: 'task-1', parentAgentId: 'lead', childAgentId: 'analyst', objective: 'root' });
  const child = await coordinator.delegate({
    parentTaskId: 'task-1', parentAgentId: 'analyst', childAgentId: 'reviewer', objective: 'child', parentDelegationId: root.id, depth: 2,
  });
  const grandchild = await coordinator.delegate({
    parentTaskId: 'task-1', parentAgentId: 'reviewer', childAgentId: 'analyst', objective: 'grandchild', parentDelegationId: child.id, depth: 3,
  });

  const cancelled = await coordinator.cancelTask('task-1', 'user cancelled');
  assert.deepEqual(cancelled.sort(), [root.id, child.id, grandchild.id].sort());
  assert.equal(coordinator.getDelegation(grandchild.id).status, 'cancelled');
  assert.equal(coordinator.getDelegation(root.id).cancellation.reason, 'user cancelled');
  assert.equal(coordinator.listDelegations({ taskId: 'task-1' }).every((d) => d.cancelled), true);
  assert.deepEqual(stoppedTasks, [['task-1', 'user cancelled'], ['sandbox', 'task-1']], 'harness runs and sandboxes are told to stop');

  const again = await coordinator.cancelTask('task-1', 'again');
  assert.deepEqual(again, [], 'cancelling twice is a no-op');
});

test('review: the reviewer receives evidence, not the task history', async () => {
  const storedArtifacts = [];
  const artifacts = {
    add: (a) => { storedArtifacts.push(a); return { id: `art-${storedArtifacts.length}` }; },
    list: () => [{ id: 'art-1', type: 'diff' }, { id: 'art-2', type: 'test-result' }],
  };
  const coordinator = makeCoordinator({ artifacts });

  const bundle = coordinator.buildReview({
    taskId: 'task-1',
    coderAgentId: 'coder',
    coderHarnessId: 'claude-code',
    reviewerAgentId: 'reviewer',
    diff: '--- a/x.ts\n+++ b/x.ts\n',
    testResults: { passed: 12, failed: 1 },
    constraints: ['no new dependencies'],
    files: ['src/x.ts'],
    context: 'Bug: the cache key ignores the workspace.',
  });

  assert.ok(bundle.reviewId);
  assert.equal(bundle.coder.harnessId, 'claude-code', 'cross-harness review is just data (§32)');
  assert.equal(bundle.taskDiff.includes('+++ b/x.ts'), true);
  assert.deepEqual(bundle.artifacts, ['art-1', 'art-2']);
  assert.equal(bundle.testResults.failed, 1);
  assert.deepEqual(bundle.constraints, ['no new dependencies']);
  assert.equal(Object.hasOwn(bundle, 'history'), false);
  assert.equal(Object.hasOwn(bundle, 'messages'), false);

  const decided = coordinator.recordReview(bundle.reviewId, { verdict: 'request_fix', notes: 'tests are failing', reviewerAgentId: 'reviewer' });
  assert.equal(decided.verdict.verdict, 'request_fix');
  assert.throws(() => coordinator.recordReview(bundle.reviewId, { verdict: 'looks fine' }), /unknown review verdict/);
});

test('teams: role templates are declarative and the control view lists what is running', async () => {
  const coordinator = makeCoordinator();
  assert.deepEqual(TEAM_TEMPLATES.code, ['research', 'worker', 'tester', 'reviewer']);
  assert.deepEqual(coordinator.teamFor('code'), ['research', 'worker', 'tester', 'reviewer']);
  assert.deepEqual(coordinator.teamFor('nonsense'), TEAM_TEMPLATES.code);

  await coordinator.delegate({ parentTaskId: 'task-9', parentAgentId: 'lead', childAgentId: 'analyst', role: ROLES.RESEARCH, objective: 'research' });
  const view = coordinator.controlView('task-9');
  assert.equal(view.taskId, 'task-9');
  assert.equal(view.subAgents[0].role, 'research');
  assert.equal(view.delegations[0].status, 'pending');
});
