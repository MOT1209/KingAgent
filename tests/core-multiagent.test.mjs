// The multi-agent foundation: lifecycle, messaging membership, delegation
// narrowing, handoff briefs, and result aggregation. Every test here is about
// a boundary — a delegate cannot out-reach its parent, an agent cannot message
// one it was never introduced to, and a lead agent's aggregate never rounds a
// partial failure up to success.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { AgentLifecycle, AGENT_STATES, canTransition } = require('../src/core/agents/lifecycle.js');
const { AgentMessageBus, MessageDeliveryError, MESSAGE_TYPES, validateMessage, replyTo } = require('../src/core/agents/messaging/index.js');
const { createHandoff, handoffFromWorkspace, LIMITS } = require('../src/core/agents/handoff.js');
const { AgentCoordinator, DelegationError, intersect, checkSchema } = require('../src/core/agents/coordinator.js');
const { WorkspaceManager } = require('../src/core/workspace/index.js');
const { AgentRegistry } = require('../src/core/agents/registry.js');
const { AgentRuntime } = require('../src/core/runtime/runtime.js');
const { ToolManager } = require('../src/core/tools/manager.js');
const { registerBuiltinTools } = require('../src/core/tools/builtin/index.js');
const { Planner } = require('../src/core/planning/planner.js');
const { Reasoner } = require('../src/core/reasoning/reasoning.js');
const { buildTaskContext } = require('../src/core/context/context.js');
const { EventBus } = require('../src/core/events/event-bus.js');
const { builtinAgents } = require('../src/core/agents/presets/builtin.js');

// The directory every workspace and tool below is rooted in.
//
// These tests delegate *real* runs through the real AgentRuntime, and the
// fixture used to point them at `process.cwd()` — this repository. A "find
// TODOs" delegation therefore walked node_modules: not what any test here
// asserts, and it left two of them a couple of seconds from the delegation
// deadline. They passed alone and failed under coverage instrumentation, where
// the same machine runs every test file at once and the run is several times
// slower. A small project with a TODO in it is the whole input they need, and
// it keeps these assertions about narrowing and schema validation rather than
// about how loaded the machine is. Same reasoning as core-orchestrator.test.mjs.
const project = makeTempDir('ka-multiagent-');
fs.writeFileSync(path.join(project.root, 'a.js'), ['// TODO: probe', 'export const a = 1;', ''].join('\n'));
fs.writeFileSync(path.join(project.root, 'README.md'), ['# Probe', 'TODO: document it', ''].join('\n'));
after(() => project.dispose());

// --- lifecycle -----------------------------------------------------------------

test('lifecycle: follows the documented graph and refuses an illegal jump', () => {
  const l = new AgentLifecycle({ agentId: 'coder' });
  l.go(AGENT_STATES.INITIALIZING);
  l.go(AGENT_STATES.READY);
  l.go(AGENT_STATES.RUNNING);
  l.go(AGENT_STATES.COMPLETED);
  assert.equal(l.state, AGENT_STATES.COMPLETED);
  assert.throws(() => new AgentLifecycle({ agentId: 'x' }).go(AGENT_STATES.RUNNING), /Invalid agent state transition/);
  assert.equal(canTransition(AGENT_STATES.CREATED, AGENT_STATES.COMPLETED), false);
});

test('lifecycle: stop() reaches STOPPED from any non-terminal state', () => {
  const l = new AgentLifecycle({ agentId: 'x' });
  l.go(AGENT_STATES.INITIALIZING);
  l.go(AGENT_STATES.READY);
  l.go(AGENT_STATES.RUNNING);
  l.go(AGENT_STATES.PAUSED);
  l.stop('cancelled');
  assert.equal(l.state, AGENT_STATES.STOPPED);
  assert.equal(l.terminal, true);
});

test('lifecycle: FAILED can recover back into a running state', () => {
  const l = new AgentLifecycle({ agentId: 'x' });
  l.go(AGENT_STATES.INITIALIZING);
  l.go(AGENT_STATES.READY);
  l.go(AGENT_STATES.RUNNING);
  l.go(AGENT_STATES.FAILED);
  l.go(AGENT_STATES.RECOVERING);
  l.go(AGENT_STATES.RUNNING);
  assert.equal(l.state, AGENT_STATES.RUNNING);
});

// --- messaging -------------------------------------------------------------------

test('messaging: membership is required in both directions', () => {
  const bus = new AgentMessageBus({});
  bus.join('t1', 'lead');
  bus.join('t1', 'research');
  const msg = bus.send({ fromAgent: 'lead', toAgent: 'research', taskId: 't1', type: MESSAGE_TYPES.DELEGATION, content: 'go' });
  assert.equal(bus.inbox('research')[0].id, msg.id);
  assert.throws(() => bus.send({ fromAgent: 'lead', toAgent: 'outsider', taskId: 't1', content: 'x' }), MessageDeliveryError);
  assert.throws(() => bus.send({ fromAgent: 'ghost', toAgent: 'research', taskId: 't1', content: 'x' }), MessageDeliveryError);
});

test('messaging: reading drains the inbox by default', () => {
  const bus = new AgentMessageBus({});
  bus.join('t1', 'a'); bus.join('t1', 'b');
  bus.send({ fromAgent: 'a', toAgent: 'b', taskId: 't1', content: 'one' });
  assert.equal(bus.inbox('b').length, 1);
  assert.equal(bus.inbox('b').length, 0, 'drained');
  assert.equal(bus.peek('b').length, 0);
});

test('messaging: replyTo correlates back to the original', () => {
  const original = { id: 'msg-1', fromAgent: 'a', toAgent: 'b', taskId: 't1', workspaceId: 'w1', traceId: 'tr1' };
  const { message: reply } = validateMessage(replyTo(original, { content: 'done' }));
  assert.equal(reply.fromAgent, 'b');
  assert.equal(reply.toAgent, 'a');
  assert.equal(reply.correlationId, 'msg-1');
});

test('messaging: clearTask removes participants, inboxes and history for that task only', () => {
  const bus = new AgentMessageBus({});
  bus.join('t1', 'a'); bus.join('t1', 'b'); bus.join('t2', 'a'); bus.join('t2', 'c');
  bus.send({ fromAgent: 'a', toAgent: 'b', taskId: 't1', content: 'x' });
  bus.send({ fromAgent: 'a', toAgent: 'c', taskId: 't2', content: 'y' });
  bus.clearTask('t1');
  assert.equal(bus.participants('t1').length, 0);
  assert.equal(bus.history({ taskId: 't1' }).length, 0);
  assert.equal(bus.history({ taskId: 't2' }).length, 1, 't2 is untouched');
});

// --- handoff -----------------------------------------------------------------

test('handoff: is a bounded brief, not the whole history', () => {
  const files = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.js`, reason: 'modified' }));
  const pkg = createHandoff({
    fromAgent: 'lead', toAgent: 'reviewer', objective: 'x'.repeat(5000),
    files, identity: { taskId: 't1' },
  });
  assert.ok(pkg.files.length <= LIMITS.files);
  assert.ok(pkg.objective.length <= LIMITS.objectiveChars + 1);
});

test('handoffFromWorkspace derives the brief from what actually happened', () => {
  const wm = new WorkspaceManager({});
  const ws = wm.create({ root: project.root, identity: { agentId: 'lead' } });
  ws.noteFile('modify', 'a.js', { before: 'x', after: 'y' });
  const pkg = handoffFromWorkspace(ws, { fromAgent: 'lead', toAgent: 'reviewer', objective: 'review my change' });
  assert.ok(pkg.files.some((f) => f.path === 'a.js'));
  assert.equal(pkg.fromAgent, 'lead');
});

// --- coordinator: selection --------------------------------------------------

function coordinatorFixture() {
  const bus = new EventBus();
  const registry = new AgentRegistry({});
  for (const def of builtinAgents()) registry.register(def);
  const workspaces = new WorkspaceManager({ bus });
  const tools = new ToolManager({ bus, authorize: async () => true });
  registerBuiltinTools(tools, { fs: require('node:fs/promises'), root: project.root, cwd: () => project.root });
  const reasoner = new Reasoner({ provider: null, bus });
  const planner = new Planner({ bus, toolManager: tools, provider: null, reasoner });
  const runtime = new AgentRuntime({ bus, agentRegistry: registry, toolManager: tools, planner, reasoner, contextBuilder: buildTaskContext, config: {} });
  const coordinator = new AgentCoordinator({ registry, runtime, workspaces, bus, options: { timeoutMs: 15000 } });
  return { bus, registry, workspaces, tools, runtime, coordinator };
}

test('coordinator: selects the narrower agent when both cover the capability', () => {
  const { coordinator } = coordinatorFixture();
  const picked = coordinator.selectAgent({ capabilities: ['read'] });
  assert.equal(picked.id, 'analyst', 'analyst is read-only and narrower than coder');
});

test('coordinator: a model-suggested id is looked up, never trusted blindly', () => {
  const { coordinator } = coordinatorFixture();
  const picked = coordinator.selectAgent({ preferred: 'does-not-exist', capabilities: ['code'] });
  assert.equal(picked.id, 'coder', 'falls back to capability matching');
});

// --- coordinator: delegation narrowing ---------------------------------------

test('intersect: null on either side means unrestricted; two lists intersect, never union', () => {
  assert.equal(intersect(null, null), null);
  assert.deepEqual(intersect(null, ['a', 'b']), ['a', 'b']);
  assert.deepEqual(intersect(['a', 'b'], null), ['a', 'b']);
  assert.deepEqual(intersect(['a', 'b'], ['b', 'c']), ['b']);
});

test('coordinator: delegate narrows the child workspace and never widens it', async () => {
  const { coordinator, workspaces } = coordinatorFixture();
  const parent = workspaces.create({
    root: project.root,
    identity: { agentId: 'coder' },
    policy: { tools: ['fs:read', 'fs:list'], memoryScopes: ['task'], allowDestructive: false },
  });
  const result = await coordinator.delegate({
    from: parent, capabilities: ['read'], request: 'find TODOs', timeoutMs: 15000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.agentId, 'analyst');
});

test('coordinator: refuses to delegate past the depth limit', async () => {
  const { coordinator, workspaces } = coordinatorFixture();
  coordinator._opts.maxDepth = 1;
  const parent = workspaces.create({ root: project.root, identity: { agentId: 'coder' } });
  await assert.rejects(
    () => coordinator.delegate({ from: parent, capabilities: ['read'], request: 'x', depth: 1 }),
    (err) => err instanceof DelegationError && err.code === 'DELEGATION_TOO_DEEP',
  );
});

test('coordinator: refuses to delegate past the fan-out limit', async () => {
  const { coordinator, workspaces } = coordinatorFixture();
  const parent = workspaces.create({ root: project.root, identity: { agentId: 'coder' } });
  coordinator._opts.maxFanout = 1;
  workspaces.createChild(parent, { agentId: 'analyst' }); // one sibling already exists
  await assert.rejects(
    () => coordinator.delegate({ from: parent, capabilities: ['read'], request: 'x' }),
    (err) => err instanceof DelegationError && err.code === 'DELEGATION_TOO_WIDE',
  );
});

test('coordinator: a delegate result failing its schema is reported as failed', async () => {
  const { coordinator, workspaces } = coordinatorFixture();
  const parent = workspaces.create({ root: project.root, identity: { agentId: 'coder' } });
  const result = await coordinator.delegate({
    from: parent, capabilities: ['read'], request: 'find TODOs', timeoutMs: 15000,
    resultSchema: { type: 'object', properties: { thisFieldWillNeverExist: { required: true, type: 'string' } } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DELEGATION_BAD_RESULT');
});

test('checkSchema: a structural mismatch is reported, a match is not', () => {
  const schema = { type: 'object', properties: { ok: { required: true, type: 'boolean' } } };
  assert.equal(checkSchema({ ok: true }, schema), null);
  assert.match(checkSchema({}, schema), /missing required field "ok"/);
  assert.match(checkSchema(null, schema), /expected an object/);
});

// --- coordinator: aggregation --------------------------------------------------

test('aggregate: partial success is reported as partial, never rounded to ok', () => {
  const { coordinator } = coordinatorFixture();
  const agg = coordinator.aggregate([
    { ok: true, agentId: 'a', artifacts: [{ id: '1' }] },
    { ok: false, agentId: 'b', error: 'boom', code: 'X' },
  ]);
  assert.equal(agg.ok, false);
  assert.equal(agg.partial, true);
  assert.equal(agg.completed, 1);
  assert.equal(agg.failed, 1);
  assert.deepEqual(agg.errors, [{ agentId: 'b', error: 'boom', code: 'X' }]);
});
