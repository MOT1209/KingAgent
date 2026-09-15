// Phase 4: the agent router (classification, matching, policy, determinism).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentRouter, classifyTask, requiredTagsFor, ROUTING_STRATEGIES } = require('../src/core/harness-orchestrator');
const { AgentRegistry } = require('../src/core/agents/registry');
const { builtinAgents } = require('../src/core/agents/presets/builtin');
const { HarnessRegistry, registerBuiltinHarnesses } = require('../src/core/harness');
const { PolicyManager } = require('../src/core/policy');
const { EventBus } = require('../src/core/events/event-bus');

function makeAgents() {
  const registry = new AgentRegistry();
  for (const def of builtinAgents()) registry.register(def);
  return registry;
}

function makeHarnesses({ probe = null, extra = [] } = {}) {
  const registry = new HarnessRegistry({ probe });
  registerBuiltinHarnesses(registry);
  for (const manifest of extra) registry.register(manifest);
  return registry;
}

test('router: task classification is keyword-based and never needs a model', () => {
  assert.equal(classifyTask('Fix the login bug and run the tests').type, 'test');
  assert.equal(classifyTask('Review this TypeScript repository').type, 'review');
  assert.equal(classifyTask('Research how the cache is invalidated').type, 'research');
  assert.equal(classifyTask('Document the config loader').type, 'document');
  assert.equal(classifyTask('Implement a new settings pane').type, 'code');
  assert.equal(classifyTask('').type, 'code', 'an unclassifiable request defaults to code');
  assert.deepEqual(classifyTask('Review the diff').required, ['review']);
});

test('router: required tags translate an agent capability into harness tags', () => {
  const tags = requiredTagsFor({ capabilities: ['code', 'read', 'write', 'run_tests', 'git'] }, 'code');
  assert.ok(tags.includes('coding'));
  assert.ok(tags.includes('files'));
  assert.ok(tags.includes('terminal'));
  assert.ok(tags.includes('git'));
  assert.deepEqual(tags, [...tags].sort());
});

test('router: capability strategy picks a backend that can actually do the work', async () => {
  const router = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: makeHarnesses() });
  const decision = await router.route({ request: 'Review this TypeScript repository' });

  assert.equal(decision.strategy, 'capability');
  assert.equal(decision.deterministic, true);
  assert.ok(decision.agentId);
  assert.ok(decision.harnessId);
  const winner = decision.candidates.find((c) => c.agentId === decision.agentId && c.harnessId === decision.harnessId);
  assert.equal(winner.eligible, true);
  assert.match(winner.reasons.join(' '), /declares/);
});

test('router: platform is part of the decision', async () => {
  const registry = makeHarnesses({ extra: [
    { id: 'macos-only', name: 'macOS only', type: 'cli', platforms: ['macos'], capabilities: ['coding', 'files', 'terminal', 'git', 'review', 'research', 'planning', 'structured_events', 'pause', 'parallel'] },
  ] });
  const router = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: registry, platform: 'windows' });
  const onWindows = await router.route({ request: 'Fix the bug' });
  assert.notEqual(onWindows.harnessId, 'macos-only');

  const onMac = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: registry, platform: 'macos' });
  const decision = await onMac.route({ request: 'Fix the bug' });
  assert.ok(decision.candidates.every((c) => c.harnessId !== 'macos-only' || c.eligible));
});

test('router: best_available prefers a backend the machine actually has', async () => {
  const probe = async ({ id }) => ({ installed: id === 'coder' || id === 'claude-code', version: '1' });
  const registry = makeHarnesses({ probe });
  await registry.detect();
  const router = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: registry, strategy: 'best_available' });

  const decision = await router.route({ request: 'Fix the bug', strategy: 'best_available' });
  assert.equal(decision.strategy, 'best_available');
  const winner = decision.candidates.find((c) => c.harnessId === decision.harnessId && c.agentId === decision.agentId);
  assert.match(winner.reasons.join(' '), /detected on this machine|always available/);
});

test('router: policy filtering removes a candidate rather than ranking it lower', async () => {
  const policy = new PolicyManager();
  policy.register({
    id: 'no-external',
    scope: 'harness',
    scopeId: 'claude-code',
    rules: [{ id: 'r', action: 'agent.route', effect: 'deny', reason: 'external agents are disabled for this workspace' }],
  }, { source: 'system' });

  const router = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: makeHarnesses(), policy });
  const decision = await router.route({ request: 'Fix the bug' });
  assert.notEqual(decision.harnessId, 'claude-code');
  const blocked = decision.candidates.find((c) => c.harnessId === 'claude-code');
  assert.equal(blocked.eligible, false);
  assert.match(blocked.reasons.join(' '), /policy: deny/);
});

test('router: a policy that denies everything produces an explained refusal', async () => {
  const policy = new PolicyManager({ defaultEffect: 'allow' });
  policy.register({ id: 'shut', scope: 'global', rules: [{ id: 'r', action: 'agent.route', effect: 'deny', reason: 'routing is locked down' }] }, { source: 'system' });
  const router = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: makeHarnesses(), policy });
  const decision = await router.route({ request: 'Fix the bug' });
  assert.equal(decision.agentId, null);
  assert.equal(decision.harnessId, null);
  assert.match(decision.reasons.join(' '), /denied|no candidates|policy/);
});

test('router: fixed strategy honours the agent harness binding', async () => {
  const agents = new AgentRegistry();
  agents.register({ id: 'bound', name: 'Bound', capabilities: ['code', 'read', 'write'], metadata: { harness: 'codex' } });
  agents.register({ id: 'free', name: 'Free', capabilities: ['code', 'read', 'write'] });
  const router = new AgentRouter({ agentRegistry: agents, harnessRegistry: makeHarnesses() });

  const decision = await router.route({ request: 'Fix the bug', strategy: 'fixed' });
  assert.equal(decision.agentId, 'bound');
  assert.equal(decision.harnessId, 'codex');
});

test('router: manual strategy validates the named pair and reports when it cannot run', async () => {
  const router = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: makeHarnesses() });
  const ok = await router.route({ request: 'Fix the bug', strategy: 'manual', agentId: 'coder', harnessId: 'codex' });
  assert.equal(ok.agentId, 'coder');
  assert.equal(ok.harnessId, 'codex');

  const missing = await router.route({ request: 'Fix the bug', strategy: 'manual', agentId: 'ghost', harnessId: 'codex' });
  assert.equal(missing.agentId, null);
  assert.match(missing.reasons.join(' '), /no enabled agents/);
});

test('router: cost_aware and performance_aware use the injected tables', async () => {
  const cheap = new AgentRouter({
    agentRegistry: makeAgents(),
    harnessRegistry: makeHarnesses(),
    costs: { 'claude-code': 10, codex: 1 },
  });
  const cheapDecision = await cheap.route({ request: 'Fix the bug', strategy: 'cost_aware' });
  const codex = cheapDecision.candidates.find((c) => c.harnessId === 'codex');
  const claude = cheapDecision.candidates.find((c) => c.harnessId === 'claude-code');
  assert.ok(codex.score > claude.score, 'the cheaper backend scores higher');
  assert.match(claude.reasons.join(' '), /cost 10/);

  const metrics = new Map([['coder:codex', { successRate: 0.99, avgDurationMs: 2000 }], ['coder:claude-code', { successRate: 0.2, avgDurationMs: 90_000 }]]);
  const fast = new AgentRouter({
    agentRegistry: makeAgents(),
    harnessRegistry: makeHarnesses(),
    metrics: { get: (agentId, harnessId) => metrics.get(`${agentId}:${harnessId}`) || null },
  });
  const fastDecision = await fast.route({ request: 'Fix the bug', strategy: 'performance_aware' });
  assert.notEqual(fastDecision.agentId, null);
  assert.match(fastDecision.candidates.map((c) => c.reasons.join(' ')).join(' | '), /observed success rate/);
});

test('router: the same inputs always produce the same decision', async () => {
  const build = () => new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: makeHarnesses() });
  const requests = ['Fix the failing test', 'Review this repository', 'Research the auth flow'];
  for (const request of requests) {
    const a = await build().route({ request });
    const b = await build().route({ request });
    assert.deepEqual(
      { agentId: a.agentId, harnessId: a.harnessId, score: a.score, candidates: a.candidates.map((c) => [c.agentId, c.harnessId, c.score]) },
      { agentId: b.agentId, harnessId: b.harnessId, score: b.score, candidates: b.candidates.map((c) => [c.agentId, c.harnessId, c.score]) },
      `routing for "${request}" must be stable across routers`,
    );
  }
});

test('router: the built-in runtime is the fallback when nothing external is installed', async () => {
  const router = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: makeHarnesses() });
  const decision = await router.route({ request: 'Fix the bug', strategy: 'best_available' });
  assert.equal(decision.harnessId, 'kingagent-runtime', 'the always-present backend wins by default');
  assert.equal(decision.agentId, 'coder');
});

test('router: with no agents or no harness registry the decision says exactly that', async () => {
  const noAgents = new AgentRouter({ agentRegistry: new AgentRegistry(), harnessRegistry: makeHarnesses() });
  const decision = await noAgents.route({ request: 'Fix the bug' });
  assert.equal(decision.agentId, null);
  assert.deepEqual(decision.reasons, ['no enabled agents are registered']);

  const noHarnesses = new AgentRouter({ agentRegistry: makeAgents() });
  const second = await noHarnesses.route({ request: 'Fix the bug' });
  assert.equal(second.agentId, null);
  assert.match(second.reasons.join(' '), /no harness registry/);
});

test('router: every declared strategy is accepted and an unknown one falls back', async () => {
  const bus = new EventBus();
  const routed = [];
  bus.on('*', (ev) => { if (ev.type === 'agent.routed') routed.push(ev); });
  const router = new AgentRouter({ agentRegistry: makeAgents(), harnessRegistry: makeHarnesses(), bus });

  for (const strategy of ROUTING_STRATEGIES) {
    const decision = await router.route({ request: 'Fix the bug', strategy });
    assert.equal(decision.strategy, strategy);
  }
  const unknown = await router.route({ request: 'Fix the bug', strategy: 'psychic' });
  assert.equal(unknown.strategy, 'capability');
  assert.equal(routed.length, ROUTING_STRATEGIES.length + 1);
  assert.equal(routed[0].agentId !== undefined, true);
});
