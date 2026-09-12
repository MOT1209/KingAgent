// Phase 2 security: IPC guard, channel whitelist, provider registry defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CHANNELS, PUSH_CHANNELS, validatePayload, allowedChannel } = require('../src/core/security/ipc-guard.js');
const { createProviderRegistry, nullProvider } = require('../src/core/ai/provider.js');

test('ipc-guard: every preload agentPlatform method maps to an allowed channel', () => {
  for (const c of [
    'agent:listAgents', 'agent:get', 'agent:listTools', 'agent:runTask',
    'agent:listTasks', 'agent:task', 'agent:history', 'agent:pause',
    'agent:resume', 'agent:cancel', 'agent:authorizeResponse',
    'workflow:list', 'workflow:run', 'workflow:get', 'workflow:cancel',
  ]) {
    assert.equal(allowedChannel(c), true, `channel ${c} must be allowed`);
  }
});

test('ipc-guard: unknown channels are forbidden', () => {
  assert.equal(allowedChannel('agent:runSomethingEvil'), false);
  assert.equal(allowedChannel('shell:exec'), false);
  assert.throws(() => validatePayload('fs:delete', {}), /forbidden channel/);
});

test('ipc-guard: payload validation enforces required fields and types', () => {
  assert.deepEqual(validatePayload('agent:runTask', { request: 'scan' }), { request: 'scan' });
  assert.throws(() => validatePayload('agent:runTask', { request: 42 }), /invalid "request"/);
  assert.throws(() => validatePayload('agent:runTask', {}), /missing required field "request"/);
  assert.throws(() => validatePayload('agent:get', { id: 'UPPER' }), /invalid "id"/);
  // extra fields are dropped — renderer can never smuggle a bigger shape
  assert.deepEqual(validatePayload('agent:runTask', { request: 'x', agentId: 'coder', evil: { a: 1 } }), { request: 'x', agentId: 'coder' });
});

test('ipc-guard: authorizeResponse requires a boolean decision', () => {
  assert.deepEqual(validatePayload('agent:authorizeResponse', { requestId: 'auth-1', approved: true }), { requestId: 'auth-1', approved: true });
  assert.throws(() => validatePayload('agent:authorizeResponse', { requestId: 'auth-1', approved: 'yes' }), /invalid "approved"/);
  assert.throws(() => validatePayload('agent:authorizeResponse', { approved: true }), /missing required field "requestId"/);
});

test('ipc-guard: push channels are a fixed triple the preload subscribes to', () => {
  assert.deepEqual(PUSH_CHANNELS, ['agent:event', 'workflow:event', 'approval:event']);
});

test('provider: registry registers, resolves defaults and reports itself', () => {
  const reg = createProviderRegistry();
  assert.equal(reg.get('null'), nullProvider);
  const probe = { id: 'probe', label: 'Probe', generate() {} };
  reg.register('probe', probe);
  assert.equal(reg.get('probe'), probe);
  // re-register overwrites (last writer wins) — no throw
  const probe2 = { id: 'probe', label: 'Probe 2', generate() {} };
  reg.register('probe', probe2);
  assert.equal(reg.get('probe'), probe2);
  // resolve() falls through to the first non-null provider
  assert.equal(reg.resolve({ model: { provider: 'unset' } }), probe2);
  assert.ok(Array.isArray(reg.list()));
});

test('provider: nullProvider throws a ModelError (nothing to generate from)', async () => {
  await assert.rejects(
    nullProvider.generate({ structured: true, messages: [] }),
    (err) => err.code === 'MODEL_FAILURE' && err.provider === 'null',
  );
});