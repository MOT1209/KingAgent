// Phase 4: the policy engine (scopes, rules, evaluation, approval, audit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PolicyManager,
  createClosedPolicyManager,
  evaluateChain,
  matchesAction,
  scopeChain,
  scopeKey,
  POLICY_SCOPES,
  mostRestrictive,
  PolicyDeniedError,
  PolicyApprovalRequiredError,
  validatePolicy,
  validateRule,
} = require('../src/core/policy');
const { EventBus, TYPES } = require('../src/core/events/event-bus');

const policy = (id, scope, rules, scopeId = null) => ({ id, name: id, scope, scopeId, rules });

test('policy scopes: the chain runs broadest to narrowest, wildcard before instance', () => {
  assert.deepEqual(POLICY_SCOPES, ['global', 'project', 'workspace', 'workflow', 'harness', 'agent', 'task', 'tool']);
  const chain = scopeChain({ workspaceId: '/ws', agentId: 'coder', toolId: 'fs:read' });
  assert.deepEqual(chain, ['global:*', 'workspace:*', 'workspace:/ws', 'agent:*', 'agent:coder', 'tool:*', 'tool:fs:read']);
  assert.equal(scopeKey('agent', null), 'agent:*');
  assert.throws(() => scopeKey('galaxy'), /unknown policy scope/);
});

test('policy rules: action patterns match one segment, all segments, or exactly', () => {
  assert.equal(matchesAction('git.push', 'git.push'), true);
  assert.equal(matchesAction('git.*', 'git.push'), true);
  assert.equal(matchesAction('git.*', 'git.push.force'), false, '* is one segment, not a prefix');
  assert.equal(matchesAction('filesystem.**', 'filesystem.read.deep'), true);
  assert.equal(matchesAction('**', 'anything.at.all'), true);
  assert.equal(matchesAction('git.push', 'git.pull'), false);
  assert.equal(matchesAction('tool.call.*', 'tool.call.fs:read'), true);
});

test('policy rules: a rule must carry a known effect and a sane pattern', () => {
  assert.equal(validateRule({ action: 'git.push', effect: 'deny' }).ok, true);
  assert.equal(validateRule({ action: 'git.push', effect: 'maybe' }).ok, false);
  assert.equal(validateRule({ effect: 'deny' }).ok, false);
  assert.equal(validateRule({ action: 'git push', effect: 'deny' }).ok, false);
  assert.equal(validateRule({ action: 'git.push', effect: 'deny', constraints: 'nope' }).ok, false);
});

test('policy document: an unknown source or an empty rule list is refused', () => {
  assert.equal(validatePolicy({ id: 'p', scope: 'global', rules: [] }, { source: 'system' }).ok, false);
  assert.equal(validatePolicy({ id: 'p', scope: 'nowhere', rules: [{ action: 'a', effect: 'allow' }] }, { source: 'system' }).ok, false);
  assert.equal(validatePolicy({ id: 'p', scope: 'global', rules: [{ action: 'a', effect: 'allow' }] }).ok, false, 'source is mandatory');
  assert.equal(validatePolicy({ id: 'p', scope: 'global', rules: [{ action: 'a', effect: 'allow' }] }, { source: 'agent' }).ok, false);
});

test('policy document: duplicate rule ids inside one document are refused', () => {
  const duplicated = {
    id: 'p',
    scope: 'global',
    rules: [
      { id: 'r', action: 'a.b', effect: 'allow' },
      { id: 'r', action: 'a.c', effect: 'deny' },
    ],
  };
  assert.equal(validatePolicy(duplicated, { source: 'system' }).ok, false);
});

test('evaluate: the most restrictive matching effect wins', () => {
  const allow = { key: 'global:*', policy: policy('g', 'global', [{ id: 'a', action: 'filesystem.*', effect: 'allow' }]) };
  const gate = { key: 'workspace:*', policy: policy('w', 'workspace', [{ id: 'b', action: 'filesystem.delete', effect: 'approval' }]) };
  const deny = { key: 'agent:*', policy: policy('a', 'agent', [{ id: 'c', action: 'filesystem.**', effect: 'deny' }]) };

  assert.equal(evaluateChain({ policies: [allow], action: 'filesystem.read', defaultEffect: 'deny' }).effect, 'allow');
  const gated = evaluateChain({ policies: [allow, gate], action: 'filesystem.delete', defaultEffect: 'deny' });
  assert.equal(gated.effect, 'approval');
  assert.equal(gated.allowed, true);
  assert.equal(gated.requiresApproval, true);
  const denied = evaluateChain({ policies: [allow, gate, deny], action: 'filesystem.delete', defaultEffect: 'allow' });
  assert.equal(denied.effect, 'deny');
  assert.equal(denied.allowed, false);
  assert.equal(denied.policyId, 'a');
  assert.equal(denied.scope, 'agent');
  assert.equal(mostRestrictive('allow', 'approval'), 'approval');
  assert.equal(mostRestrictive('approval', 'deny'), 'deny');
});

test('evaluate: with nothing matching, the default effect decides and says so', () => {
  const open = evaluateChain({ policies: [], action: 'filesystem.read', defaultEffect: 'allow' });
  assert.equal(open.matched, false);
  assert.equal(open.allowed, true);
  assert.match(open.reason, /no policy matched/);

  const closed = evaluateChain({ policies: [], action: 'filesystem.read', defaultEffect: 'deny' });
  assert.equal(closed.allowed, false);
  assert.match(closed.reason, /denies by default/);
});

test('evaluate: an unreadable action is refused rather than guessed', () => {
  const decision = evaluateChain({ policies: [], action: null, defaultEffect: 'allow' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.effect, 'deny');
});

test('evaluate: the decision names the rule, scope and a replayable trail', () => {
  const policies = [
    { key: 'global:*', policy: policy('g', 'global', [{ id: 'r1', action: 'filesystem.*', effect: 'allow', reason: 'reads are safe' }]) },
    { key: 'task:t1', policy: policy('t', 'task', [{ id: 'r2', action: 'filesystem.delete', effect: 'deny', reason: 'not in this task' }], 't1') },
  ];
  const decision = evaluateChain({ policies, action: 'filesystem.delete', defaultEffect: 'allow' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.ruleId, 'r2');
  assert.equal(decision.scope, 'task');
  assert.equal(decision.scopeId, 't1');
  assert.equal(decision.reason, 'not in this task');
  assert.equal(decision.trail.length, 2);
  assert.deepEqual(decision.trail.map((t) => t.ruleId), ['r1', 'r2']);
});

test('policy manager: registration requires a human or system source — never an agent', () => {
  const manager = new PolicyManager();
  assert.throws(
    () => manager.register(policy('p', 'global', [{ action: 'a.b', effect: 'allow' }]), { source: 'agent' }),
    /an agent may not author policies/,
  );
  assert.throws(() => manager.register(policy('p', 'global', [{ action: 'a.b', effect: 'allow' }])), /explicit source/);
  const registered = manager.register(policy('p', 'global', [{ action: 'a.b', effect: 'allow' }]), { source: 'human' });
  assert.equal(registered.source, 'human');
  assert.equal(manager.count(), 1);
});

test('policy manager: a workspace policy only applies to its own workspace instance', async () => {
  const manager = new PolicyManager({ defaultEffect: 'deny' });
  manager.register(policy('ws-a', 'workspace', [{ id: 'r', action: 'filesystem.write', effect: 'allow' }], '/ws/a'), { source: 'system' });
  manager.register(policy('agent-default', 'agent', [{ id: 'r', action: 'filesystem.read', effect: 'allow' }]), { source: 'system' });

  const inA = await manager.evaluate({ action: 'filesystem.write', context: { workspaceId: '/ws/a' } });
  assert.equal(inA.allowed, true);

  const inB = await manager.evaluate({ action: 'filesystem.write', context: { workspaceId: '/ws/b' } });
  assert.equal(inB.allowed, false, 'a policy scoped to workspace A must not authorize B');

  const anyWorkspace = await manager.evaluate({ action: 'filesystem.read', context: { workspaceId: '/ws/b', agentId: 'coder' } });
  assert.equal(anyWorkspace.allowed, true, 'the wildcard agent policy applies everywhere');
});

test('policy manager: more specific grants do not loosen a broader denial', async () => {
  const manager = new PolicyManager();
  manager.register(policy('global-deny', 'global', [{ id: 'r', action: 'filesystem.delete', effect: 'deny' }]), { source: 'system' });
  manager.register(policy('task-allow', 'task', [{ id: 'r', action: 'filesystem.delete', effect: 'allow' }], 't1'), { source: 'human' });

  const decision = await manager.evaluate({ action: 'filesystem.delete', context: { taskId: 't1' } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.policyId, 'global-deny');
  assert.equal(decision.scope, 'global');
});

test('policy manager: approval is asked, and an unwired approver denies rather than allows', async () => {
  const gated = new PolicyManager();
  gated.register(policy('gate', 'global', [{ id: 'r', action: 'network.request', effect: 'approval', reason: 'network needs approval' }]), { source: 'system' });

  const noApprover = await gated.evaluate({ action: 'network.request' });
  assert.equal(noApprover.allowed, false, 'an ungranted approval must never default to yes');
  assert.equal(noApprover.requiresApproval, true);
  assert.match(noApprover.reason, /no approver is wired/);

  gated.setApprover(async ({ action }) => action === 'network.request');
  const granted = await gated.evaluate({ action: 'network.request' });
  assert.equal(granted.allowed, true);
  assert.equal(granted.approved, true);

  gated.setApprover(async () => false);
  const refused = await gated.evaluate({ action: 'network.request' });
  assert.equal(refused.allowed, false);
  assert.match(refused.reason, /approval denied/);

  gated.setApprover(async () => { throw new Error('renderer gone'); });
  const failed = await gated.evaluate({ action: 'network.request' });
  assert.equal(failed.allowed, false, 'a broken approver fails closed');
  assert.match(failed.reason, /approval lookup failed/);
});

test('policy manager: enforce throws the typed error for its decision', async () => {
  const manager = new PolicyManager({ defaultEffect: 'deny' });
  manager.register(policy('allow-read', 'global', [{ id: 'r', action: 'filesystem.read', effect: 'allow' }]), { source: 'system' });
  manager.register(policy('gate-exec', 'global', [{ id: 'r', action: 'exec.**', effect: 'approval' }]), { source: 'system' });

  await assert.rejects(() => manager.enforce({ action: 'filesystem.delete' }), PolicyDeniedError);
  await assert.rejects(() => manager.enforce({ action: 'exec.run' }), PolicyApprovalRequiredError);
  const decision = await manager.enforce({ action: 'filesystem.read' });
  assert.equal(decision.allowed, true);
});

test('policy manager: evaluate without the approval round trip reports the gate closed', async () => {
  const manager = new PolicyManager();
  manager.register(policy('gate', 'global', [{ id: 'r', action: 'credential.**', effect: 'approval' }]), { source: 'system' });
  const decision = await manager.evaluate({ action: 'credential.ANTHROPIC_API_KEY', askApproval: false });
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /approval not requested/);
});

test('policy manager: the tool bridge derives an action and keeps inputs out of the audit', async () => {
  const manager = new PolicyManager();
  manager.register(policy('deny-git-push', 'global', [{ id: 'r', action: 'git.push', effect: 'deny', reason: 'external writes need approval' }]), { source: 'system' });

  const allowed = await manager.authorizeTool({
    agent: { id: 'coder' },
    tool: { id: 'fs:read', policyAction: null },
    input: { path: '.env', content: 'SECRET=1' },
    taskId: 't1',
  });
  assert.equal(allowed, true);

  const denied = await manager.authorizeTool({
    agent: { id: 'coder' },
    tool: { id: 'git:push', policyAction: 'git.push' },
    taskId: 't1',
  });
  assert.equal(denied, false);

  const audit = manager.audit({ limit: 10 });
  assert.equal(audit[0].action, 'git.push');
  assert.equal(audit[0].allowed, false);
  assert.equal(audit[0].policyId, 'deny-git-push');
  assert.equal(JSON.stringify(audit).includes('SECRET=1'), false, 'tool inputs must not reach the audit ring');
});

test('policy manager: every decision is auditable and explainable', async () => {
  const bus = new EventBus();
  const events = [];
  bus.on('*', (ev) => events.push(ev));
  const manager = new PolicyManager({ bus });
  manager.register(policy('g', 'global', [
    { id: 'r1', action: 'filesystem.read', effect: 'allow' },
    { id: 'r2', action: 'filesystem.delete', effect: 'deny', reason: 'irreversible' },
  ]), { source: 'system' });

  await manager.evaluate({ action: 'filesystem.delete', context: { agentId: 'coder', taskId: 't1' } });
  await manager.evaluate({ action: 'filesystem.read', context: { agentId: 'coder' } });

  const types = events.map((e) => e.type);
  assert.ok(types.includes(TYPES.POLICY_EVALUATED));
  assert.ok(types.includes(TYPES.POLICY_DENIED));
  const denied = events.find((e) => e.type === TYPES.POLICY_DENIED);
  assert.equal(denied.taskId, 't1');
  assert.equal(denied.agentId, 'coder');
  assert.equal(denied.policyId, 'g');

  const explain = manager.explain({ action: 'filesystem.delete', context: { agentId: 'coder' } });
  assert.equal(explain.effect, 'deny');
  assert.equal(explain.ruleId, 'r2');
  assert.match(explain.reason, /irreversible/);
  assert.deepEqual(explain.chain, ['global:*', 'agent:*', 'agent:coder']);
  assert.equal(explain.trail.length, 1);

  const stats = manager.stats();
  assert.equal(stats.evaluated, 2);
  assert.equal(stats.denied, 1);
  assert.equal(stats.policies, 1);
});

test('policy manager: the baseline gates new capabilities and can only be tightened', async () => {
  const manager = new PolicyManager();
  assert.equal(manager.loadBaseline(), 2);

  const deleteDecision = await manager.evaluate({ action: 'filesystem.delete', askApproval: false });
  assert.equal(deleteDecision.effect, 'approval', 'deletes ask first');

  const credential = await manager.evaluate({ action: 'credential.OPENAI_API_KEY', askApproval: false });
  assert.equal(credential.effect, 'approval');

  const readDecision = await manager.evaluate({ action: 'filesystem.read' });
  assert.equal(readDecision.allowed, true);

  // A narrow human policy can tighten a baseline allow…
  manager.register(policy('tight', 'agent', [{ id: 'r', action: 'filesystem.read', effect: 'deny', reason: 'read-only agent' }], 'auditor'), { source: 'human' });
  const tightened = await manager.evaluate({ action: 'filesystem.read', context: { agentId: 'auditor' } });
  assert.equal(tightened.allowed, false);
  // …and cannot loosen a baseline gate.
  manager.register(policy('loosen', 'agent', [{ id: 'r', action: 'filesystem.delete', effect: 'allow' }], 'auditor'), { source: 'human' });
  const stillGated = await manager.evaluate({ action: 'filesystem.delete', context: { agentId: 'auditor' }, askApproval: false });
  assert.equal(stillGated.effect, 'approval');
});

test('policy manager: a closed install denies everything it has no document for', async () => {
  const closed = createClosedPolicyManager();
  assert.equal(closed.defaultEffect, 'deny');
  const decision = await closed.evaluate({ action: 'filesystem.read' });
  assert.equal(decision.allowed, false);
  assert.equal(closed.policiesFor({}).length, 0);
});

test('policy manager: policies persist through the injected store', async () => {
  const written = new Map();
  const store = {
    async set(key, value) { written.set(key, value); },
    async get(key) { return written.get(key) || null; },
    async delete(key) { return written.delete(key); },
    async keys() { return [...written.keys()]; },
  };
  const manager = new PolicyManager({ store });
  manager.register(policy('p', 'global', [{ id: 'r', action: 'a.b', effect: 'allow' }]), { source: 'system' });
  assert.ok([...written.keys()].some((k) => k.startsWith('policy:')));
  const listed = manager.list({ scope: 'global' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].rules[0].action, 'a.b');
});
