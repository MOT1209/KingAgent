// Approval is the last line between an agent and an irreversible action. These
// tests check the whole lifecycle — request, approve, reject, expire — and the
// property that makes it safe under a pause: a pending request is a record,
// not a closure, so it survives being waited on from somewhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ApprovalManager, APPROVAL_STATUS, RISK, requiresApproval, createApprovalRequest } = require('../src/core/approval/index.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

test('request: risk defaults from the dangerous-action table', () => {
  const req = createApprovalRequest({ action: 'file.delete', identity: {} });
  assert.equal(req.risk, RISK.HIGH);
  assert.equal(req.status, APPROVAL_STATUS.PENDING);
});

test('requiresApproval: policy allow overrides the default table; require is exhaustive', () => {
  assert.equal(requiresApproval('file.delete'), true, 'on the default dangerous list');
  assert.equal(requiresApproval('file.delete', { allow: ['file.delete'] }), false);
  assert.equal(requiresApproval('file.delete', { require: ['git.push'] }), false, 'an explicit require list is exhaustive');
  assert.equal(requiresApproval('git.push', { require: ['git.push'] }), true);
});

test('manager: approve settles the pending decision', async () => {
  const mgr = new ApprovalManager({});
  const { request, decision } = mgr.requestApproval({ action: 'file.delete', identity: { taskId: 't1' } });
  assert.equal(mgr.getPendingApprovals({ taskId: 't1' }).length, 1);
  mgr.approve(request.id, { decidedBy: 'user' });
  const resolved = await decision;
  assert.equal(resolved.status, APPROVAL_STATUS.APPROVED);
  assert.equal(mgr.getPendingApprovals({ taskId: 't1' }).length, 0);
});

test('manager: reject settles it as rejected, with a note', async () => {
  const mgr = new ApprovalManager({});
  const { request, decision } = mgr.requestApproval({ action: 'command.run' });
  mgr.reject(request.id, { note: 'too risky' });
  const resolved = await decision;
  assert.equal(resolved.status, APPROVAL_STATUS.REJECTED);
  assert.equal(resolved.decisionNote, 'too risky');
});

test('manager: an unanswered request expires on its own', async () => {
  const mgr = new ApprovalManager({ ttlMs: 20 });
  const { request, decision } = mgr.requestApproval({ action: 'git.push' });
  const resolved = await decision;
  assert.equal(resolved.status, APPROVAL_STATUS.EXPIRED);
  assert.equal(mgr.get(request.id).status, APPROVAL_STATUS.EXPIRED);
  mgr.dispose();
});

test('manager: settling twice is idempotent — the first decision wins', async () => {
  const mgr = new ApprovalManager({});
  const { request, decision } = mgr.requestApproval({ action: 'git.push' });
  mgr.approve(request.id);
  mgr.reject(request.id);
  assert.equal((await decision).status, APPROVAL_STATUS.APPROVED);
});

test('manager: sweep expires anything past its deadline on demand', async () => {
  const mgr = new ApprovalManager({ ttlMs: 100_000 });
  mgr.requestApproval({ action: 'git.push', identity: {}, ttlMs: -1 }); // already expired
  const n = mgr.sweep();
  assert.equal(n, 1);
  mgr.dispose();
});

test('manager: emits both the Phase 3 and Phase 2 approval events', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('approval.')) seen.push(ev.type); });
  const mgr = new ApprovalManager({ bus });
  const { request, decision } = mgr.requestApproval({ action: 'file.delete', toolId: 'fs:delete', identity: { taskId: 't1' } });
  mgr.approve(request.id);
  await decision;
  assert.ok(seen.includes(TYPES.APPROVAL_REQUESTED));
  assert.ok(seen.includes(TYPES.APPROVAL_REQUIRED), 'the Phase 2 event the existing renderer listens to');
  assert.ok(seen.includes(TYPES.APPROVAL_APPROVED));
  assert.ok(seen.includes(TYPES.APPROVAL_GRANTED));
});

test('toolAuthorizer: a DESTRUCTIVE tool becomes a request; approving it resolves true', async () => {
  const mgr = new ApprovalManager({});
  const authorize = mgr.toolAuthorizer({ identity: { taskId: 't1' } });
  const tool = { id: 'fs:delete', permissions: { level: 'destructive', requiresAuth: true, note: 'irreversible' } };
  const agent = { id: 'coder' };

  const authPromise = authorize({ agent, tool, input: { path: 'x' }, taskId: 't1' });
  const pending = mgr.getPendingApprovals({ taskId: 't1' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolId, 'fs:delete');
  mgr.approve(pending[0].id);
  assert.equal(await authPromise, true);
});

test('toolAuthorizer: rejecting resolves false', async () => {
  const mgr = new ApprovalManager({});
  const authorize = mgr.toolAuthorizer({ identity: { taskId: 't1' } });
  const tool = { id: 'terminal:run', permissions: { level: 'destructive', requiresAuth: true } };
  const authPromise = authorize({ agent: { id: 'coder' }, tool, input: {}, taskId: 't1' });
  const [pending] = mgr.getPendingApprovals({ taskId: 't1' });
  mgr.reject(pending.id);
  assert.equal(await authPromise, false);
});

test('toolAuthorizer: a safe tool never becomes an approval request', async () => {
  const mgr = new ApprovalManager({});
  const authorize = mgr.toolAuthorizer({ identity: { taskId: 't1' } });
  const tool = { id: 'fs:read', permissions: { level: 'read_only', requiresAuth: false } };
  const result = await authorize({ agent: { id: 'coder' }, tool, input: {}, taskId: 't1' });
  assert.equal(result, true);
  assert.equal(mgr.getPendingApprovals({ taskId: 't1' }).length, 0);
});

test('manager: dispose settles every outstanding request', async () => {
  const mgr = new ApprovalManager({});
  const a = mgr.requestApproval({ action: 'file.delete' });
  const b = mgr.requestApproval({ action: 'git.push' });
  mgr.dispose();
  assert.equal((await a.decision).status, APPROVAL_STATUS.EXPIRED);
  assert.equal((await b.decision).status, APPROVAL_STATUS.EXPIRED);
});
