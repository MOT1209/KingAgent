// Dynamic agents are how KingAgent grows a specialist at runtime, and the one
// way it could fork-bomb itself. These tests hold both halves: that a valid
// specialist can be created and later promoted or destroyed, and that every
// limit refuses the spawn that would run away — before a human is ever asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentRegistry } = require('../src/core/agents/registry.js');
const { AgentGovernor, SPAWN_CODES } = require('../src/core/agents/governor.js');
const { AgentFactory } = require('../src/core/agents/factory.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

function fixture({ governorConfig = {}, spawnPolicy = {}, withGovernor = true } = {}) {
  const bus = new EventBus();
  const registry = new AgentRegistry({});
  const governor = withGovernor ? new AgentGovernor({ config: governorConfig }) : null;
  const factory = new AgentFactory({ registry, governor, bus, spawnPolicy });
  return { bus, registry, governor, factory };
}

// --- run budgets ------------------------------------------------------------------

// A process restart is the easiest way to "reset" an in-memory budget, which is
// why the run's spend comes from the durable record instead.
test('governor: a run over its budget is caught even though the new agent spent nothing yet', () => {
  const usage = new Map([['run-1', { tokens: 5_000, cost: 3 }]]);
  const governor = new AgentGovernor({ config: { maxRunTokens: 1_000, maxRunCost: 2 } });
  governor.attachUsage((runId) => usage.get(runId) || null);
  governor.register({ agentId: 'agent-2', role: 'react-specialist', runId: 'run-1' });

  const breaches = governor.sweep();
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].code, 'RUN_TOKEN_BUDGET_EXCEEDED');
  assert.match(breaches[0].reason, /run-1/);
  assert.equal(governor.get('agent-2').tokens, 0, 'the agent itself spent nothing');
});

test('governor: the cost ceiling is checked separately from tokens', () => {
  const governor = new AgentGovernor({ config: { maxRunTokens: 1_000_000, maxRunCost: 2 } });
  governor.attachUsage(() => ({ tokens: 10, cost: 9 }));
  governor.register({ agentId: 'agent-3', role: 'auditor', runId: 'run-2' });
  assert.equal(governor.sweep()[0].code, 'RUN_COST_BUDGET_EXCEEDED');
});

test('governor: an agent with no run is not judged against a run budget', () => {
  const governor = new AgentGovernor({ config: { maxRunTokens: 1 } });
  governor.attachUsage(() => ({ tokens: 1_000_000, cost: 0 }));
  governor.register({ agentId: 'loose', role: 'researcher' });
  assert.deepEqual(governor.sweep(), []);
});

test('governor: a provider that cannot answer leaves the per-agent caps intact', () => {
  const governor = new AgentGovernor({ config: { maxTokenBudget: 100, maxRunTokens: 50 } });
  governor.attachUsage(() => null);
  governor.register({ agentId: 'agent-4', role: 'coder', runId: 'run-3' });
  const verdict = governor.noteUsage('agent-4', { tokens: 150 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'AGENT_TOKEN_BUDGET_EXCEEDED', 'the agent cap still applies');
});

// --- proposal --------------------------------------------------------------------

test('factory: a proposal is a valid definition that is not yet registered', () => {
  const { factory, registry } = fixture();
  const result = factory.propose({ role: 'react-specialist', id: 'dyn-react-1', capabilities: ['code'] });
  assert.equal(result.ok, true);
  assert.equal(registry.count(), 0, 'proposing has no side effects');
  const meta = result.definition.metadata;
  assert.equal(meta.dynamic, true);
  assert.equal(meta.role, 'react-specialist');
  assert.equal(meta.lineage.createdBy, 'rashid');
});

test('factory: a proposal without a role is refused with a reason', () => {
  const { factory } = fixture();
  const result = factory.propose({});
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /role/);
});

// --- creation and risk policy -----------------------------------------------------

test('factory: a low-risk specialist is created and starts counting against limits', async () => {
  const { factory, registry, governor, bus } = fixture();
  const seen = [];
  bus.on('*', (ev) => { if (ev.type === TYPES.AGENT_CREATED) seen.push(ev); });
  const proposal = factory.propose({ role: 'react-specialist', id: 'dyn-react-1', capabilities: ['code'], risk: 'low' });
  const outcome = await factory.create(proposal);
  assert.equal(outcome.created, true);
  assert.equal(outcome.executionApprovalRequired, false);
  assert.equal(registry.get('dyn-react-1').metadata.dynamic, true);
  assert.equal(governor.liveCount, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentId, 'dyn-react-1');
});

test('factory: a medium-risk spawn is created but its first execution is gated', async () => {
  const { factory } = fixture();
  const proposal = factory.propose({ role: 'auditor', id: 'dyn-audit-1', risk: 'medium' });
  const outcome = await factory.create(proposal);
  assert.equal(outcome.created, true);
  assert.equal(outcome.executionApprovalRequired, true, 'execution needs a human, creation did not');
});

test('factory: a refused approval denies the creation and registers nothing', async () => {
  const { factory, registry } = fixture();
  const proposal = factory.propose({ role: 'auditor', id: 'dyn-audit-2', risk: 'high' });
  const outcome = await factory.create(proposal, { approver: async () => false });
  assert.equal(outcome.created, false);
  assert.equal(outcome.code, 'APPROVAL_REJECTED');
  assert.equal(registry.count(), 0);
});

test('factory: a high-risk spawn with no approver is denied, never silently allowed', async () => {
  const { factory } = fixture();
  const proposal = factory.propose({ role: 'deployer', id: 'dyn-deploy-1', risk: 'high' });
  const outcome = await factory.create(proposal);
  assert.equal(outcome.created, false);
  assert.equal(outcome.code, 'APPROVAL_UNAVAILABLE');
});

test('factory: an approved high-risk spawn proceeds', async () => {
  const { factory, registry } = fixture();
  const proposal = factory.propose({ role: 'deployer', id: 'dyn-deploy-2', risk: 'high' });
  const outcome = await factory.create(proposal, { approver: async () => true });
  assert.equal(outcome.created, true);
  assert.equal(outcome.executionApprovalRequired, true);
  assert.equal(registry.get('dyn-deploy-2').metadata.risk, 'high');
});

test('factory: policy can deny a whole risk level outright', async () => {
  const { factory } = fixture({ spawnPolicy: { low: 'deny' } });
  const proposal = factory.propose({ role: 'x', id: 'dyn-x-1', risk: 'low' });
  const outcome = await factory.create(proposal);
  assert.equal(outcome.created, false);
  assert.equal(outcome.code, 'SPAWN_POLICY_DENIED');
});

test('factory: a governor denial is reported, not thrown, and names its code', async () => {
  const { factory } = fixture({ governorConfig: { maxDepth: 1 } });
  const proposal = factory.propose({ role: 'deep', id: 'dyn-deep-1', risk: 'low' });
  const outcome = await factory.create(proposal, { depth: 4 });
  assert.equal(outcome.created, false);
  assert.equal(outcome.code, SPAWN_CODES.TOO_DEEP);
});

test('factory: a registry collision is surfaced as a spawn error', async () => {
  const { factory, bus } = fixture({ withGovernor: false });
  const first = factory.propose({ role: 'react', id: 'dyn-dup-1' });
  assert.equal((await factory.create(first)).created, true);
  const seen = [];
  bus.on('*', (ev) => { if (ev.type === TYPES.AGENT_SPAWN_DENIED) seen.push(ev); });
  const second = factory.propose({ role: 'react', id: 'dyn-dup-1' });
  const outcome = await factory.create(second);
  assert.equal(outcome.created, false);
  assert.equal(outcome.code, 'SPAWN_REGISTRY_ERROR');
  assert.equal(seen.length, 1);
});

// --- destroy / promote ------------------------------------------------------------

test('factory: destroying a dynamic agent releases it and removes the definition', async () => {
  const { factory, registry, governor } = fixture();
  const proposal = factory.propose({ role: 'temp', id: 'dyn-temp-1' });
  await factory.create(proposal);
  const outcome = await factory.destroy('dyn-temp-1');
  assert.equal(outcome.destroyed, true);
  assert.equal(registry.get('dyn-temp-1'), undefined);
  assert.equal(governor.get('dyn-temp-1'), null);
});

test('factory: a promoted agent cannot be destroyed — promotion has to mean something', async () => {
  const { factory } = fixture();
  await factory.create(factory.propose({ role: 'keeper', id: 'dyn-keep-1' }));
  const promoted = factory.promote('dyn-keep-1');
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.agent.metadata.persistent, true);
  assert.equal(promoted.agent.metadata.dynamic, false);
  const outcome = await factory.destroy('dyn-keep-1');
  assert.equal(outcome.destroyed, false);
  assert.equal(outcome.code, 'AGENT_PERSISTENT');
});

test('factory: promoting a dynamic agent sets provenance and demote reverses it', async () => {
  const { factory, registry } = fixture();
  await factory.create(factory.propose({ role: 'analyst', id: 'dyn-an-1', parentAgentId: 'rashid', rootTaskId: 'task-9' }));
  const promoted = factory.promote('dyn-an-1', { promotedBy: 'king' });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.agent.metadata.createdBy, 'rashid', 'creation provenance is preserved');
  assert.equal(promoted.agent.metadata.lineage.rootTaskId, 'task-9');
  assert.equal(factory.listPersistent().length, 1);

  const demoted = factory.demote('dyn-an-1');
  assert.equal(demoted.demoted, true);
  assert.equal(registry.get('dyn-an-1').metadata.dynamic, true);
});

// --- governor limits --------------------------------------------------------------

test('governor: maxChildren bounds one agent\'s team', () => {
  const governor = new AgentGovernor({ config: { maxChildren: 1 } });
  governor.register({ agentId: 'lead', role: 'lead' });
  governor.register({ agentId: 'c1', parentAgentId: 'lead', role: 'a' });
  const verdict = governor.canSpawn({ parentAgentId: 'lead', depth: 1, role: 'b' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, SPAWN_CODES.TOO_WIDE);
});

test('governor: recursive spawn of the same role is refused', () => {
  const governor = new AgentGovernor();
  governor.register({ agentId: 'p', role: 'security' });
  const verdict = governor.canSpawn({ parentAgentId: 'p', depth: 1, role: 'security' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, SPAWN_CODES.RECURSIVE);
});

test('governor: an identical specialist created moments ago is a duplicate', () => {
  const governor = new AgentGovernor({ config: { duplicateWindowMs: 60_000 } });
  const fingerprint = governor.fingerprint({ role: 'react', capabilities: ['code'] });
  governor.register({ agentId: 'r1', role: 'react', fingerprint });
  const verdict = governor.canSpawn({ role: 'react', fingerprint });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, SPAWN_CODES.DUPLICATE);
});

test('governor: concurrency and per-run spawn counts are both bounded', () => {
  const governor = new AgentGovernor({ config: { maxConcurrentAgents: 1, maxSpawnsPerRun: 1 } });
  governor.register({ agentId: 'a1', role: 'a' });
  const verdict = governor.canSpawn({ role: 'b' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, SPAWN_CODES.TOO_MANY);
});

test('governor: usage past a budget is reported and marked on the record', () => {
  const governor = new AgentGovernor({ config: { maxTokenBudget: 100 } });
  governor.register({ agentId: 'a1', role: 'a' });
  assert.equal(governor.noteUsage('a1', { tokens: 50 }).ok, true);
  const over = governor.noteUsage('a1', { tokens: 80 });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'AGENT_TOKEN_BUDGET_EXCEEDED');
  assert.equal(governor.get('a1').exceeded.code, 'AGENT_TOKEN_BUDGET_EXCEEDED');
});

test('governor: sweep finds an agent past its runtime so a host can shut it down', () => {
  const governor = new AgentGovernor({ config: { maxRuntimeMs: 1000 } });
  governor.register({ agentId: 'stuck', role: 'a', startedAt: 0 });
  const overdue = governor.sweep(5000);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].agentId, 'stuck');
  assert.equal(overdue[0].code, 'AGENT_RUNTIME_EXCEEDED');
});
