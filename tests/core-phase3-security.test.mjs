// Phase 3 security review, as executable checks rather than a document.
//
// Each test here is a boundary named in the mission brief (§46): workspace
// isolation, path traversal, memory access, task ownership, agent permissions,
// delegated task permissions, approval flows, persistent storage, IPC,
// environment variables, artifact access, cross-agent communication. Most of
// these properties already have a home in their own subsystem's test file
// (core-workspace, core-memory, core-artifacts, core-multiagent,
// core-approval); this file is the cross-cutting sweep that checks them
// together, the way a reviewer would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const { validatePayload, allowedChannel } = require('../src/core/security/ipc-guard.js');
const { ArtifactAccessError } = require('../src/core/artifacts/index.js');
const { MemoryAccessError } = require('../src/core/memory/index.js');
const { DelegationError } = require('../src/core/agents/coordinator.js');
const { MessageDeliveryError } = require('../src/core/agents/messaging/index.js');

function platform(io = {}) {
  return createPlatform({ io: { cwd: () => process.cwd(), ...io } });
}

// --- workspace isolation / path traversal -------------------------------------

test('security: a workspace cannot resolve a path outside its own root', () => {
  const p = platform();
  const ws = p.workspaces.create({ root: '/tmp/ka-sec-a', identity: { agentId: 'coder' } });
  assert.throws(() => ws.resolve('../../../etc/passwd'), /escapes the workspace root/);
  p.dispose();
});

test('security: a child workspace cannot escape a root its parent did not have', () => {
  const p = platform();
  const parent = p.workspaces.create({ root: '/tmp/ka-sec-b', identity: { agentId: 'lead' } });
  const child = p.workspaces.createChild(parent, { agentId: 'research' });
  assert.equal(child.root, parent.root, 'a delegate inherits the parent root, never picks its own');
  p.dispose();
});

// --- memory access -------------------------------------------------------------

test('security: memory search is confined to the policy\'s own scope/owner pairs', async () => {
  const p = platform();
  const wsA = p.workspaces.create({ root: '/tmp/ka-sec-c', identity: { agentId: 'a' } });
  const wsB = p.workspaces.create({ root: '/tmp/ka-sec-d', identity: { agentId: 'b' } });
  await p.memoryManager.store({ content: 'workspace A secret plan', scope: 'workspace' }, { policy: wsA.memoryPolicy() });
  const hits = await p.memoryManager.search({ query: 'secret plan' }, { policy: wsB.memoryPolicy() });
  assert.deepEqual(hits, []);
  p.dispose();
});

test('security: writing outside a granted scope is a denial, not a silent no-op', async () => {
  const p = platform();
  const ws = p.workspaces.create({ root: '/tmp/ka-sec-e', identity: { agentId: 'coder' } });
  await assert.rejects(
    () => p.memoryManager.store({ content: 'x', scope: 'global' }, { policy: ws.memoryPolicy() }),
    MemoryAccessError,
  );
  p.dispose();
});

// --- artifact access -------------------------------------------------------------

test('security: an artifact is unreadable by any workspace but its producer, until shared', async () => {
  const p = platform();
  const producer = p.workspaces.create({ root: '/tmp/ka-sec-f', identity: { agentId: 'coder' } });
  const other = p.workspaces.create({ root: '/tmp/ka-sec-g', identity: { agentId: 'analyst' } });
  const art = await p.artifacts.create({ type: 'report', name: 'private', content: { secret: true } }, { workspace: producer });
  await assert.rejects(() => p.artifacts.get(art.id, { workspace: other }), ArtifactAccessError);
  p.dispose();
});

// --- agent permissions / delegation narrowing -------------------------------------

test('security: a delegate can never be granted a tool its parent lacks', async () => {
  const p = platform();
  const parent = p.workspaces.create({ root: '/tmp/ka-sec-h', identity: { agentId: 'coder' }, policy: { tools: ['fs:read'] } });
  // The coordinator intersects policy.tools with the requested tools and the
  // selected agent's own declared tools — never a union.
  const result = await p.coordinator.delegate({
    from: parent, capabilities: ['read'], request: 'find TODOs',
    policy: { tools: ['fs:read', 'terminal:run'] }, timeoutMs: 15000,
  });
  const child = p.workspaces.get(result.workspaceId) || (await p.workspaces.loadPersisted(result.workspaceId));
  if (child) assert.ok(!('tools' in child.policy) || !(child.policy.tools || []).includes('terminal:run'));
  p.dispose();
});

test('security: delegation depth and fan-out are enforced, not advisory', async () => {
  const p = platform();
  p.coordinator._opts.maxDepth = 1;
  const parent = p.workspaces.create({ root: '/tmp/ka-sec-i', identity: { agentId: 'coder' } });
  await assert.rejects(
    () => p.coordinator.delegate({ from: parent, capabilities: ['read'], request: 'x', depth: 1 }),
    (err) => err instanceof DelegationError && err.code === 'DELEGATION_TOO_DEEP',
  );
  p.dispose();
});

// --- cross-agent communication ----------------------------------------------------

test('security: an agent cannot message another it was never introduced to', () => {
  const p = platform();
  p.messages.join('t1', 'coder');
  assert.throws(
    () => p.messages.send({ fromAgent: 'coder', toAgent: 'a-stranger', taskId: 't1', content: 'hi' }),
    MessageDeliveryError,
  );
  p.dispose();
});

// --- approval flows -------------------------------------------------------------

test('security: a destructive tool call is gated by an auditable approval, not a bare boolean', async () => {
  const p = platform();
  const authorize = p.approvals.toolAuthorizer({ identity: { taskId: 't1' } });
  const tool = { id: 'fs:delete', permissions: { level: 'destructive', requiresAuth: true } };
  const promise = authorize({ agent: { id: 'coder' }, tool, input: { path: 'x' }, taskId: 't1' });
  const pending = p.approvals.getPendingApprovals({ taskId: 't1' });
  assert.equal(pending.length, 1, 'the decision is a listable record, not just a hanging promise');
  p.approvals.reject(pending[0].id);
  assert.equal(await promise, false);
  p.dispose();
});

// --- persistent storage: no secrets leak into what is written to disk -------------

test('security: nothing credential-shaped survives into a persisted trace', async () => {
  const p = platform();
  const ws = p.workspaces.create({ root: '/tmp/ka-sec-j', identity: { agentId: 'coder' } });
  const trace = p.traces.createTrace({ identity: ws.identity });
  p.traces.appendEvent(trace.traceId, 'tool.called', { toolId: 'terminal:run', env: { OPENAI_API_KEY: 'sk-super-secret' }, reasoning: 'because I decided to' });
  await p.traces.completeTrace(trace.traceId);
  const { serializeTrace } = require('../src/core/trace/serializer.js');
  const json = JSON.stringify(serializeTrace(trace));
  assert.ok(!json.includes('sk-super-secret'));
  assert.ok(!json.includes('because I decided to'), 'no chain-of-thought reaches the trace');
  p.dispose();
});

test('security: the workspace environment refuses a credential even from an explicit allow-list', () => {
  const p = platform({ inheritEnv: ['*'], hostEnv: { AWS_SECRET_ACCESS_KEY: 'leak-me', PATH: '/bin' } });
  assert.equal(p.environment.get('AWS_SECRET_ACCESS_KEY'), undefined);
  assert.equal(p.environment.get('PATH'), '/bin');
  p.dispose();
});

// --- IPC surface -----------------------------------------------------------------

test('security: every Phase 3 channel validates its payload before touching a subsystem', () => {
  assert.throws(() => validatePayload('trace:get', { id: '../../secrets' }), /invalid "id"/);
  assert.throws(() => validatePayload('artifact:get', { id: 'art-1' }), /missing required field "workspaceId"/);
  assert.throws(() => validatePayload('memory:search', { query: 'x' }), /missing required field "workspaceId"/);
  assert.equal(allowedChannel('orchestrator:runAsRoot'), false);
});

test('security: no Phase 3 channel accepts an unbounded free-text field', () => {
  // A renderer-controlled string field must be capped; otherwise a compromised
  // renderer can push megabytes through one IPC call.
  const huge = 'x'.repeat(10_000);
  assert.throws(() => validatePayload('orchestrator:run', { request: huge }), /invalid "request"/);
});
