// The workspace is the execution boundary, so what it *refuses* matters more
// than what it allows. These tests are written from that side: identity is
// mandatory, paths cannot escape, a child cannot out-reach its parent, and the
// environment refuses a credential even when asked nicely.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { symlinksSupported } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const {
  AgentWorkspace, WorkspaceManager, createEnvironment, createFileContext,
  createIdentity, childIdentity, identityRefs, validateIdentity, derivePolicy, isChildOf,
} = require('../src/core/workspace/index.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');
const { createCollections } = require('../src/core/persistence/collections.js');
const { createMemoryStore } = require('../src/core/persistence/store.js');

// --- identity ----------------------------------------------------------------

test('identity: mints every correlation key and validates', () => {
  const id = createIdentity({ agentId: 'coder' });
  assert.ok(id.workspaceId.startsWith('ws-'));
  assert.ok(id.taskId.startsWith('task-'));
  assert.ok(id.sessionId.startsWith('sess-'));
  assert.ok(id.traceId.startsWith('trace-'));
  assert.equal(id.agentId, 'coder');
  assert.equal(validateIdentity(id).ok, true);
  assert.equal(validateIdentity({ workspaceId: 'x' }).ok, false);
});

test('identity: a child keeps project/session/trace lineage and records its parent', () => {
  const parent = createIdentity({ agentId: 'lead', projectId: 'proj-1' });
  const child = childIdentity(parent, { agentId: 'research' });
  assert.equal(child.projectId, parent.projectId);
  assert.equal(child.sessionId, parent.sessionId);
  assert.equal(child.traceId, parent.traceId);
  assert.notEqual(child.workspaceId, parent.workspaceId);
  assert.notEqual(child.taskId, parent.taskId);
  assert.equal(child.agentId, 'research');
  assert.ok(isChildOf(child, parent));
  assert.ok(!isChildOf(parent, child));
});

test('identity: identityRefs carries every key the event bus correlates on', () => {
  const refs = identityRefs(createIdentity({ agentId: 'coder', projectId: 'p' }));
  for (const key of ['taskId', 'agentId', 'workspaceId', 'projectId', 'sessionId', 'traceId']) {
    assert.ok(key in refs, `identityRefs is missing ${key}`);
  }
});

// --- environment -------------------------------------------------------------

test('environment: nothing is inherited from the host unless allow-listed', () => {
  const env = createEnvironment({
    base: { PROJECT: 'demo' },
    inherit: ['PATH'],
    hostEnv: { PATH: '/bin', HOME: '/home/x', EDITOR: 'vim' },
  });
  assert.deepEqual(env.names(), ['PATH', 'PROJECT']);
  assert.ok(env.blockedNames().includes('HOME'));
  assert.ok(env.blockedNames().includes('EDITOR'));
});

test('environment: a credential-shaped name is refused even when allow-listed', () => {
  const env = createEnvironment({
    inherit: ['*'],
    hostEnv: { AWS_SECRET_ACCESS_KEY: 'x', OPENAI_API_KEY: 'y', GITHUB_TOKEN: 'z', PATH: '/bin' },
  });
  assert.deepEqual(env.names(), ['PATH']);
  assert.equal(env.get('OPENAI_API_KEY'), undefined);
  assert.throws(() => env.set('MY_API_KEY', 'secret'), /credential-shaped/);
});

test('environment: the serialized view never carries a secret value', () => {
  const env = createEnvironment({ base: { PATH: '/bin' }, allowSecrets: true, inherit: ['*'], hostEnv: { NPM_TOKEN: 'hunter2' } });
  assert.equal(env.get('NPM_TOKEN'), 'hunter2', 'allowSecrets admits it for a process spawn');
  const json = JSON.stringify(env.toJSON());
  assert.ok(!json.includes('hunter2'), 'but it must never be serialized');
  assert.match(json, /\[redacted\]/);
});

// --- file context ------------------------------------------------------------

test('file-context: reads, writes and deletes fold into one diff row per path', () => {
  const fc = createFileContext();
  fc.recordRead('a.js');
  fc.recordCreate('b.js', { after: 'one' });
  fc.recordModify('b.js', { before: 'one', after: 'two' });
  fc.recordDelete('c.js', { before: 'gone' });

  const diff = fc.diff();
  assert.equal(diff.length, 2, 'a read is not a change');
  assert.equal(diff.find((d) => d.path === 'b.js').operation, 'create', 'create → modify stays a create');
  assert.equal(diff.find((d) => d.path === 'c.js').operation, 'delete');
  assert.deepEqual(fc.summary(), {
    filesRead: 1, filesCreated: 1, filesModified: 0, filesDeleted: 1,
    filesRenamed: 0, changed: 2, active: 0,
  });
});

test('file-context: a large file is captured by reference, not duplicated', () => {
  const fc = createFileContext({ maxContentBytes: 64 });
  const big = 'x'.repeat(5000);
  fc.recordModify('big.txt', { before: big, after: `${big}!` });
  const row = fc.diff()[0];
  assert.equal(row.before.inline, false);
  assert.equal(row.before.truncated, true);
  assert.equal(row.before.bytes, 5000);
  assert.ok(row.before.digest, 'a reference still identifies the content');
  assert.ok(!('text' in row.before), 'the content itself is not carried');
});

test('file-context: attention is tracked separately from change', () => {
  const fc = createFileContext();
  fc.markActive('src/a.js');
  fc.addRelated('src/b.js', 'imported by a.js');
  fc.recordCreate('out.js', { after: '' });
  assert.deepEqual(fc.activeFiles(), ['src/a.js']);
  assert.deepEqual(fc.relatedFiles(), [{ path: 'src/b.js', reason: 'imported by a.js' }]);
  assert.deepEqual(fc.generatedFiles(), ['out.js']);
});

// --- workspace ---------------------------------------------------------------

test('workspace: resolve refuses a path that escapes the root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ka-ws-'));
  try {
    const ws = new AgentWorkspace({ identity: createIdentity({}), root });
    // resolve() goes through the symlink-safe path guard, which returns the
    // *real* path (fs.realpathSync) of the root. On macOS os.tmpdir() is
    // itself a symlink (/var/folders/... -> /private/var/folders/...), so the
    // expected value has to be the real path too, or this assertion is
    // comparing two different — if textually similar — directories.
    assert.equal(ws.resolve('.'), realpathSync(path.resolve(root)));
    assert.throws(() => ws.resolve('../outside'), /escapes the workspace root/);
    assert.equal(ws.contains('inside/file.txt'), true);
    assert.equal(ws.contains('../outside'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace: a symlink out of the root is refused too', async (t) => {
  if (!(await symlinksSupported())) return t.skip('symlinks unavailable on this host');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ka-ws-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ka-ws-out-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escapee'), 'file');
    const ws = new AgentWorkspace({ identity: createIdentity({}), root });
    assert.throws(() => ws.resolve('escapee'), /symlink/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('workspace: a closed workspace refuses to do anything', () => {
  const ws = new AgentWorkspace({ identity: createIdentity({}), root: process.cwd() });
  ws.close();
  assert.throws(() => ws.resolve('.'), /is closed/);
  assert.throws(() => ws.noteFile('create', 'x.js'), /is closed/);
  assert.throws(() => ws.reactivate(), /closed workspace cannot be reactivated/);
});

test('workspace: derivePolicy narrows and never widens', () => {
  const parent = { tools: ['fs:read', 'fs:write'], memoryScopes: ['task', 'project'], allowNetwork: false, allowDestructive: true, maxFileBytes: 1000 };
  const child = derivePolicy(parent, {
    tools: ['fs:read', 'terminal:run'],   // terminal:run is not the parent's to give
    memoryScopes: ['project', 'global'],  // global is not the parent's to give
    allowNetwork: true,                   // asking does not grant it
    allowDestructive: false,              // dropping one is allowed
    maxFileBytes: 5000,                   // a bigger ceiling is not
  });
  assert.deepEqual(child.tools, ['fs:read']);
  assert.deepEqual(child.memoryScopes, ['project']);
  assert.equal(child.allowNetwork, false);
  assert.equal(child.allowDestructive, false);
  assert.equal(child.maxFileBytes, 1000);
});

test('workspace: tool and scope grants are enforced, not advisory', () => {
  const ws = new AgentWorkspace({
    identity: createIdentity({ agentId: 'analyst' }),
    root: process.cwd(),
    policy: { tools: ['fs:read'], memoryScopes: ['task'] },
  });
  assert.equal(ws.canUseTool('fs:read'), true);
  assert.equal(ws.canUseTool('fs:delete'), false);
  assert.equal(ws.canAccessScope('task'), true);
  assert.equal(ws.canAccessScope('global'), false);
});

test('workspace: an artifact belongs to its producer until explicitly shared', () => {
  const a = new AgentWorkspace({ identity: createIdentity({ agentId: 'one' }), root: process.cwd() });
  const b = new AgentWorkspace({ identity: createIdentity({ agentId: 'two' }), root: process.cwd() });
  const artifact = { id: 'art-1', workspaceId: a.workspaceId, metadata: {} };
  assert.equal(a.canAccessArtifact(artifact), true);
  assert.equal(b.canAccessArtifact(artifact), false);
  artifact.metadata.sharedWith = [b.workspaceId];
  assert.equal(b.canAccessArtifact(artifact), true);
});

test('workspace: file operations become correlated events', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => seen.push(ev));
  const ws = new AgentWorkspace({ identity: createIdentity({ agentId: 'coder' }), root: process.cwd(), bus });
  ws.noteFile('create', 'new.js', { after: 'x' });
  ws.noteFile('read', 'other.js');

  const added = seen.find((e) => e.type === TYPES.WORKSPACE_FILE_ADDED);
  assert.ok(added, 'a create emits workspace.file.added');
  assert.equal(added.workspaceId, ws.workspaceId);
  assert.equal(added.traceId, ws.traceId);
  assert.equal(seen.filter((e) => e.type.startsWith('workspace.file')).length, 1, 'a read is not a file change event');
});

test('workspace: the serialized form carries no environment values', () => {
  const ws = new AgentWorkspace({
    identity: createIdentity({}),
    root: process.cwd(),
    environment: createEnvironment({ base: { PATH: '/bin' }, allowSecrets: true, inherit: ['*'], hostEnv: { CI_TOKEN: 'abc123' } }),
  });
  const json = JSON.stringify(ws.toJSON());
  assert.ok(!json.includes('abc123'));
  assert.ok(json.includes('[redacted]'));
});

// --- manager -----------------------------------------------------------------

test('manager: one workspace per task, findable by task id', () => {
  const mgr = new WorkspaceManager({});
  const ws = mgr.create({ root: process.cwd(), identity: { agentId: 'coder' } });
  assert.equal(mgr.forTask(ws.taskId).workspaceId, ws.workspaceId);
  assert.equal(mgr.get(ws.workspaceId).workspaceId, ws.workspaceId);
});

test('manager: children are tracked and inherit a narrowed policy', () => {
  const mgr = new WorkspaceManager({});
  const parent = mgr.create({ root: process.cwd(), identity: { agentId: 'lead' }, policy: { memoryScopes: ['task', 'project'] } });
  const child = mgr.createChild(parent, { agentId: 'research', policy: { memoryScopes: ['task', 'global'] } });
  assert.deepEqual(mgr.children(parent.workspaceId).map((w) => w.workspaceId), [child.workspaceId]);
  assert.deepEqual(child.policy.memoryScopes, ['task'], 'global was not the parent\'s to give');
  assert.equal(child.root, parent.root);
});

test('manager: a persisted workspace comes back suspended, with its history', async () => {
  const collections = createCollections(createMemoryStore());
  const mgr = new WorkspaceManager({ collection: collections.workspaces });
  const ws = mgr.create({ root: process.cwd(), identity: { agentId: 'coder' } });
  ws.noteFile('create', 'x.js', { after: 'hello' });
  ws.attachArtifact('art-1');
  await mgr.persist(ws.workspaceId);

  const fresh = new WorkspaceManager({ collection: collections.workspaces });
  const revived = await fresh.restore(ws.workspaceId);
  assert.ok(revived, 'the workspace came back');
  assert.equal(revived.workspaceId, ws.workspaceId);
  assert.equal(revived.status, 'suspended', 'a revived workspace never wakes up already running');
  assert.deepEqual(revived.artifactIds, ['art-1']);
  assert.equal(revived.metadata.restored, true);
});

test('manager: restoring never re-performs a recorded operation', async () => {
  const collections = createCollections(createMemoryStore());
  const mgr = new WorkspaceManager({ collection: collections.workspaces });
  const ws = mgr.create({ root: process.cwd(), identity: { agentId: 'coder' } });
  ws.noteFile('delete', 'gone.js', { before: 'x' });
  await mgr.persist(ws.workspaceId);

  const fresh = new WorkspaceManager({ collection: collections.workspaces });
  const revived = await fresh.restore(ws.workspaceId);
  assert.deepEqual(revived.files.diff(), [], 'replayed history is read-only; no delete is re-recorded');
  assert.ok(revived.files.readFiles().includes('gone.js'), 'but the path is still known');
});
