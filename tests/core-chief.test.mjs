// The organization: Ahmad plans, Rashid executes, specialists are spawned
// through the governed factory. The property that matters most is that the two
// system agents are *not* delegation targets — otherwise a broad executive
// out-competes every narrow specialist and the organization is one agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentRegistry } = require('../src/core/agents/registry.js');
const { AgentCoordinator } = require('../src/core/agents/coordinator.js');
const { AgentGovernor } = require('../src/core/agents/governor.js');
const { AgentFactory } = require('../src/core/agents/factory.js');
const { ChiefSystem } = require('../src/core/agents/chief.js');
const { chiefAgents, CHIEF_AGENT_IDS } = require('../src/core/agents/presets/chief.js');
const { builtinAgents } = require('../src/core/agents/presets/builtin.js');
const { WorkspaceManager } = require('../src/core/workspace/index.js');

function roster() {
  const registry = new AgentRegistry({});
  for (const def of builtinAgents()) registry.register(def);
  for (const def of chiefAgents()) registry.register(def);
  return registry;
}

// --- the two system agents --------------------------------------------------------

test('chief: Ahmad and Rashid are valid, enabled, system agents', () => {
  const registry = roster();
  const ahmad = registry.get('ahmad');
  const rashid = registry.get('rashid');
  assert.equal(ahmad.name, 'Ahmad');
  assert.equal(rashid.name, 'Rashid');
  assert.equal(ahmad.metadata.system, true);
  assert.equal(rashid.metadata.system, true);
  assert.equal(ahmad.metadata.role, 'chief-planner');
  assert.equal(rashid.metadata.role, 'executive');
  assert.deepEqual(CHIEF_AGENT_IDS, ['ahmad', 'rashid']);
  // The delegable preset catalogue is unchanged by their existence.
  assert.deepEqual(builtinAgents().map((a) => a.id), ['coder', 'analyst']);
});

test('coordinator: system agents are never chosen as delegates by capability', () => {
  const registry = roster();
  const coordinator = new AgentCoordinator({ registry, workspaces: new WorkspaceManager({}) });
  // Rashid covers 'code' and 'write', but the narrow coder must win the job.
  const picked = coordinator.selectAgent({ capabilities: ['code', 'write'] });
  assert.equal(picked.id, 'coder');
  // A capability only Rashid has still does not hand him the job implicitly —
  // system agents orchestrate; they are not delegation targets.
  const coordination = coordinator.selectAgent({ capabilities: ['coordination'] });
  assert.notEqual(coordination.id, 'rashid');
});

test('coordinator: a system agent is selected when it is explicitly preferred', () => {
  const registry = roster();
  const coordinator = new AgentCoordinator({ registry, workspaces: new WorkspaceManager({}) });
  assert.equal(coordinator.selectAgent({ capabilities: ['code'], preferred: 'rashid' }).id, 'rashid');
  assert.equal(coordinator.selectAgent({ preferred: 'ahmad' }).id, 'ahmad');
});

// --- the facade -------------------------------------------------------------------

function fixture() {
  const registry = roster();
  const governor = new AgentGovernor();
  const factory = new AgentFactory({ registry, governor });
  const orchestrator = {
    route: ({ request }) => ({ mode: 'single-agent', capabilities: ['code'], reason: `routed "${request}"`, request }),
    handle: async ({ request, agentId }) => ({ id: 'ws-1', runId: 'run-1', request, agentId, status: 'queued' }),
  };
  const chief = new ChiefSystem({ registry, orchestrator, agentFactory: factory, governor });
  return { registry, governor, factory, chief, orchestrator };
}

test('chief: plan() routes through Ahmad and returns the decision', () => {
  const { chief } = fixture();
  const plan = chief.plan({ request: 'build a SaaS app' });
  assert.equal(plan.agent, 'ahmad');
  assert.equal(plan.decision.mode, 'single-agent');
});

test('chief: execute() runs as Rashid and reports the run', async () => {
  const { chief } = fixture();
  const record = await chief.execute({ request: 'build a SaaS app' });
  assert.equal(record.agentId, 'rashid');
  assert.equal(record.runId, 'run-1');
});

test('chief: Rashid can spawn a specialist, which carries his lineage', async () => {
  const { chief, registry, governor } = fixture();
  const outcome = await chief.spawnSpecialist({ role: 'db-optimizer', capabilities: ['code'], risk: 'low' });
  assert.equal(outcome.created, true);
  const specialist = registry.get(outcome.agent.id);
  assert.equal(specialist.metadata.createdBy, 'rashid');
  assert.equal(specialist.metadata.parentAgentId, 'rashid');
  assert.equal(specialist.metadata.dynamic, true);
  assert.equal(governor.liveCount, 1);
});

test('chief: roster lists the system agents and the live specialists', async () => {
  const { chief } = fixture();
  await chief.spawnSpecialist({ role: 'translator', capabilities: ['read'], risk: 'low' });
  const r = chief.roster();
  assert.deepEqual(r.system.map((a) => a.id).sort(), ['ahmad', 'rashid']);
  assert.equal(r.specialists.length, 1);
  assert.equal(r.live.length, 1);
});

test('chief: a specialist can be retired or promoted after its work', async () => {
  const { chief } = fixture();
  const a = await chief.spawnSpecialist({ role: 'auditor', capabilities: ['read'], risk: 'low' });
  const b = await chief.spawnSpecialist({ role: 'reviewer', capabilities: ['read'], risk: 'low' });

  assert.equal((await chief.retireSpecialist(a.agent.id)).destroyed, true);
  const promoted = await chief.promoteSpecialist(b.agent.id);
  assert.equal(promoted.promoted, true);
  assert.equal(chief.roster().persistent.length, 1);
});

test('chief: a medium-risk specialist is created but execution is gated', async () => {
  const { chief } = fixture();
  const outcome = await chief.spawnSpecialist({ role: 'pentester', capabilities: ['security'], risk: 'medium' });
  assert.equal(outcome.created, true);
  assert.equal(outcome.executionApprovalRequired, true);
});
