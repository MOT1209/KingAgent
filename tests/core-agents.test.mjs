// Phase 2 core: agent definitions, registry, presets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateAgentDefinition, normalizeAgent, DEFAULT_PERMISSIONS } = require('../src/core/agents/definition.js');
const { AgentRegistry } = require('../src/core/agents/registry.js');
const { builtinAgents, AGENTS_DEFAULT_IDS } = require('../src/core/agents/presets/builtin.js');
const { createMemoryStore } = require('../src/core/persistence/store.js');

test('definition: accepts a valid agent and normalizes defaults', () => {
  const { ok, agent } = validateAgentDefinition({
    id: 'coder',
    name: 'Coder',
    description: 'writes code',
    capabilities: ['read', 'write', 'code'],
    model: { provider: 'anthropic', id: 'claude-x' },
  });
  assert.equal(ok, true);
  assert.equal(agent.id, 'coder');
  assert.deepEqual(agent.permissions.levels, DEFAULT_PERMISSIONS.levels);
  assert.equal(agent.permissions.allowDestructive, false);
  assert.equal(agent.enabled, true);
  assert.equal(Object.isFrozen(agent), true);
});

test('definition: rejects bad ids, missing names, and bad capabilities', () => {
  assert.equal(validateAgentDefinition({ id: 'Bad Id', name: 'x' }).ok, false);
  assert.equal(validateAgentDefinition({ id: 'ok', name: '  ' }).ok, false);
  assert.equal(validateAgentDefinition({ id: 'ok', name: 'x', capabilities: ['read', 42] }).ok, false);
  assert.equal(validateAgentDefinition({ id: 'ok', name: 'x', permissions: { allowDestructive: 'yes' } }).ok, false);
  assert.equal(validateAgentDefinition(null).ok, false);
});

test('definition: accepts multi-token ids (namespaced agents)', () => {
  const { ok } = validateAgentDefinition({ id: 'org.king:builder-v2', name: 'Builder V2' });
  assert.equal(ok, true);
});

test('registry: register, list, update, enable/disable and unregister', async () => {
  const store = createMemoryStore();
  const reg = new AgentRegistry({ store });
  const { agent } = validateAgentDefinition({ id: 'coder', name: 'Coder', capabilities: ['code'] });
  reg.register(agent);
  assert.equal(reg.get('coder').name, 'Coder');
  assert.equal(reg.count(), 1);

  const updated = reg.update('coder', { description: 'the best coder' });
  assert.equal(updated.description, 'the best coder');
  assert.equal(reg.get('coder').description, 'the best coder');

  reg.disable('coder');
  assert.deepEqual(reg.list({ enabled: true }), []);
  assert.equal(reg.list({ enabled: false })[0].id, 'coder');
  reg.enable('coder');
  assert.equal(reg.list({ enabled: true })[0].id, 'coder');

  reg.unregister('coder');
  assert.equal(reg.count(), 0);
});

test('registry: duplicate ids throw a clear error', () => {
  const reg = new AgentRegistry();
  const { agent } = validateAgentDefinition({ id: 'coder', name: 'Coder' });
  reg.register(agent);
  assert.throws(() => reg.register(agent), /already registered|duplicate/i);
});

test('presets: ships a coder and an analyst with working capabilities', () => {
  const agents = builtinAgents();
  assert.ok(agents.length >= 2);
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  assert.ok(byId.coder, 'expected a coder preset');
  assert.ok(byId.analyst, 'expected an analyst preset');
  assert.ok(byId.coder.capabilities.includes('code'));
  assert.ok(byId.analyst.capabilities.includes('read'));
  assert.deepEqual(AGENTS_DEFAULT_IDS, ['coder', 'analyst']);
});