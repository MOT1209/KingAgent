// Phase 4: sessions (lifecycle, attachments, pause/resume, recovery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SessionManager,
  SESSION_STATES,
  canTransition,
  isTerminal,
  isActive,
  createSession,
  snapshot,
} = require('../src/core/session');
const { EventBus, TYPES } = require('../src/core/events/event-bus');

test('session lifecycle: the state graph forbids the impossible moves', () => {
  assert.equal(canTransition(SESSION_STATES.CREATED, SESSION_STATES.RUNNING), false, 'a session is initialized before it runs');
  assert.equal(canTransition(SESSION_STATES.CREATED, SESSION_STATES.INITIALIZING), true);
  assert.equal(canTransition(SESSION_STATES.RUNNING, SESSION_STATES.PAUSED), true);
  assert.equal(canTransition(SESSION_STATES.PAUSED, SESSION_STATES.COMPLETED), false, 'a paused session resumes or stops');
  assert.equal(canTransition(SESSION_STATES.STOPPED, SESSION_STATES.RUNNING), false, 'terminal is terminal');
  assert.equal(isTerminal(SESSION_STATES.COMPLETED), true);
  assert.equal(isActive(SESSION_STATES.WAITING), true, 'waiting on a human is still an open session');
  assert.equal(isActive(SESSION_STATES.PAUSED), false);
});

test('session manager: create → start → wait → resume → complete emits the full event set', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => seen.push(ev));
  const sessions = new SessionManager({ bus, idFactory: () => 'sess-1' });

  const created = sessions.create({ workspaceId: '/ws', workspaceRoot: '/ws', agentIds: ['coder'] });
  assert.equal(created.state, 'created');
  assert.equal(created.id, 'sess-1');

  const started = sessions.start('sess-1');
  assert.equal(started.state, 'running');
  assert.ok(started.startedAt);

  sessions.wait('sess-1', 'awaiting approval');
  assert.equal(sessions.view('sess-1').state, 'waiting');
  sessions.resume('sess-1');
  sessions.complete('sess-1', 'all done');

  const final = sessions.view('sess-1');
  assert.equal(final.state, 'completed');
  assert.ok(final.completedAt);

  const types = seen.map((e) => e.type);
  for (const type of [TYPES.SESSION_CREATED, TYPES.SESSION_STARTED, TYPES.SESSION_COMPLETED]) {
    assert.ok(types.includes(type), `missing ${type}`);
  }
  const startedEvent = seen.find((e) => e.type === TYPES.SESSION_STARTED);
  assert.equal(startedEvent.sessionId, 'sess-1');
  assert.equal(startedEvent.workspaceId, '/ws');
});

test('session manager: pause and stop are idempotent, and illegal moves throw', () => {
  const sessions = new SessionManager({ idFactory: (() => { let n = 0; return () => `s-${++n}`; })() });
  sessions.create({ workspaceId: '/ws' });
  assert.throws(() => sessions.pause('s-1'), /cannot move from created to paused/);

  sessions.start('s-1');
  sessions.pause('s-1', 'user');
  assert.equal(sessions.view('s-1').state, 'paused');
  sessions.resume('s-1');
  assert.equal(sessions.view('s-1').state, 'running');

  sessions.stop('s-1', 'user');
  assert.equal(sessions.view('s-1').state, 'stopped');
  assert.equal(sessions.stop('s-1').state, 'stopped', 'stopping a stopped session is a no-op');
  assert.equal(sessions.fail('s-1', new Error('too late')).state, 'stopped', 'a finished session cannot fail afterwards');
});

test('session manager: fail records the reason and cannot be overwritten', () => {
  const sessions = new SessionManager({ idFactory: () => 'sess-x' });
  sessions.create({});
  sessions.start('sess-x');
  const failed = sessions.fail('sess-x', new Error('harness died'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure, 'harness died');
  assert.equal(sessions.fail('sess-x', new Error('again')).failure, 'harness died');
});

test('session manager: attachments tie tasks, agents, harnesses, sandboxes and artifacts together', () => {
  const sessions = new SessionManager({ idFactory: () => 'sess-a' });
  sessions.create({ workspaceId: '/ws' });

  sessions.attachTask('sess-a', 'task-1');
  sessions.attachTask('sess-a', 'task-1');
  sessions.attachTask('sess-a', 'task-2');
  sessions.attachArtifact('sess-a', 'art-1');
  sessions.attachSandbox('sess-a', 'sandbox-1');
  sessions.attachHarness('sess-a', 'claude-code');
  sessions.attachAgent('sess-a', 'coder');
  sessions.countMessages('sess-a');
  sessions.countDelegation('sess-a');

  const view = sessions.view('sess-a');
  assert.deepEqual(view.taskIds, ['task-1', 'task-2'], 'attaching twice does not duplicate');
  assert.deepEqual(view.artifactIds, ['art-1']);
  assert.deepEqual(view.sandboxIds, ['sandbox-1']);
  assert.deepEqual(view.harnessIds, ['claude-code']);
  assert.deepEqual(view.agentIds, ['coder']);
  assert.equal(view.messages, 1);
  assert.equal(view.delegations, 1);
  assert.equal(view.workspaceId, '/ws');
});

test('session manager: an approval decision is recorded on the session', () => {
  const sessions = new SessionManager({ idFactory: () => 'sess-r' });
  sessions.create({});
  sessions.recordApproval('sess-r', { requestId: 'req-1', action: 'filesystem.delete', granted: false });
  const view = sessions.view('sess-r');
  assert.equal(view.approvals.length, 1);
  assert.equal(view.approvals[0].granted, false);
  assert.equal(view.approvals[0].action, 'filesystem.delete');
});

test('session manager: list and stats report what is actually open', () => {
  const sessions = new SessionManager();
  sessions.create({ workspaceId: '/a' });
  sessions.create({ workspaceId: '/b' });
  const [second] = sessions.list();
  sessions.start(second.id);
  sessions.stop(second.id);

  assert.equal(sessions.list().length, 2);
  assert.equal(sessions.list({ active: true }).length, 1, 'the stopped session is not active');
  assert.equal(sessions.stats().total, 2);
  assert.equal(sessions.stats().byState.stopped, 1);
  assert.equal(sessions.list()[0].taskCount, 0);
});

test('session manager: recovery parks in-flight work and finishes opening sessions', () => {
  const sessions = new SessionManager();
  const running = sessions.create({ workspaceId: '/a' });
  const opening = sessions.create({ workspaceId: '/b' });
  const done = sessions.create({ workspaceId: '/c' });
  sessions.start(running.id);
  sessions.initialize(opening.id);
  sessions.start(done.id);
  sessions.complete(done.id);

  const recovered = sessions.recover({ reason: 'platform restarted' });
  assert.equal(sessions.view(running.id).state, 'paused', 'work in flight comes back parked, never resumed unseen');
  assert.equal(sessions.view(opening.id).state, 'ready', 'a session that never started is simply opened');
  assert.equal(sessions.view(done.id).state, 'completed', 'a finished session is left alone');
  assert.deepEqual(recovered.map((r) => r.id).sort(), [running.id, opening.id].sort());
});

test('session manager: the opening steps are reachable and ordered', () => {
  const sessions = new SessionManager({ idFactory: () => 'sess-o' });
  sessions.create({ workspaceId: '/ws' });
  assert.equal(sessions.initialize('sess-o').state, 'initializing');
  assert.equal(sessions.ready('sess-o').state, 'ready');
  assert.equal(sessions.start('sess-o').state, 'running');
  assert.throws(() => sessions.ready('sess-o'), /cannot move from running to ready/);
});

test('session model: snapshots are serializable and clones are independent', () => {
  const session = createSession({ id: 'sess-z', workspaceId: '/ws', agentIds: ['coder', 'coder'], metadata: { note: 'x' } });
  const view = snapshot(session);
  view.agentIds.push('evil');
  assert.deepEqual(snapshot(session).agentIds, ['coder']);
  assert.equal(JSON.parse(JSON.stringify(view)).id, 'sess-z');
  assert.equal(Object.values(view).some((v) => typeof v === 'function'), false);
});

test('session manager: sessions persist through the injected store', async () => {
  const written = new Map();
  const store = {
    async set(key, value) { written.set(key, value); },
    async get(key) { return written.get(key) || null; },
    async delete(key) { return written.delete(key); },
    async keys() { return [...written.keys()]; },
  };
  const sessions = new SessionManager({ store, idFactory: () => 'sess-p' });
  sessions.create({ workspaceId: '/ws' });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(written.has('session:sess-p'));
  assert.equal(written.get('session:sess-p').state, 'created');
});
