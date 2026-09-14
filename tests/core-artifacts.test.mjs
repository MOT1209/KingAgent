// Artifacts are how agents exchange structured output instead of re-parsed
// prose. The property under test everywhere here is ownership: an artifact is
// readable and writable only by the workspace that produced it, until that
// workspace explicitly shares it — never by "same session" or "same task".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ArtifactManager, ArtifactAccessError, ARTIFACT_TYPES, MAX_INLINE_BYTES,
  validateArtifact, artifactRef, canReadArtifact, canWriteArtifact,
} = require('../src/core/artifacts/index.js');
const { WorkspaceManager } = require('../src/core/workspace/index.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

function fixture() {
  const bus = new EventBus();
  const wm = new WorkspaceManager({ bus });
  const owner = wm.create({ root: process.cwd(), identity: { agentId: 'coder' } });
  const stranger = wm.create({ root: process.cwd(), identity: { agentId: 'analyst' } });
  const manager = new ArtifactManager({ bus });
  return { bus, wm, owner, stranger, manager };
}

// --- validation ----------------------------------------------------------------

test('artifact: requires a name and either content or a path', () => {
  assert.equal(validateArtifact({ name: 'x', content: {}, workspaceId: 'w1' }).ok, true);
  assert.equal(validateArtifact({ content: {}, workspaceId: 'w1' }).ok, false);
  assert.equal(validateArtifact({ name: 'x', workspaceId: 'w1' }).ok, false, 'neither content nor path');
  assert.equal(validateArtifact({ name: 'x', content: {} }).ok, false, 'no owning workspace');
});

test('artifact: refuses inline content over the size ceiling', () => {
  const result = validateArtifact({ name: 'big', content: 'x'.repeat(MAX_INLINE_BYTES + 1), workspaceId: 'w1' });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /exceeds/);
});

test('artifactRef never carries content', () => {
  const { artifact } = validateArtifact({ name: 'x', content: { secret: 1 }, workspaceId: 'w1' });
  const ref = artifactRef(artifact);
  assert.ok(!('content' in ref));
  assert.equal(ref.id, artifact.id);
});

// --- manager: ownership ----------------------------------------------------------

test('manager: the producing workspace can always read its own artifact', async () => {
  const { manager, owner } = fixture();
  const artifact = await manager.create({ type: ARTIFACT_TYPES.REPORT, name: 'findings', content: { n: 1 } }, { workspace: owner });
  const got = await manager.get(artifact.id, { workspace: owner });
  assert.equal(got.name, 'findings');
  assert.equal(got.workspaceId, owner.workspaceId);
});

test('manager: a different workspace is denied, not given an empty result', async () => {
  const { manager, owner, stranger } = fixture();
  const artifact = await manager.create({ type: ARTIFACT_TYPES.REPORT, name: 'private', content: {} }, { workspace: owner });
  await assert.rejects(
    () => manager.get(artifact.id, { workspace: stranger }),
    (err) => err instanceof ArtifactAccessError && err.code === 'ARTIFACT_DENIED',
  );
});

test('manager: share() is additive and makes the artifact readable, not writable', async () => {
  const { manager, owner, stranger } = fixture();
  const artifact = await manager.create({ type: ARTIFACT_TYPES.DIFF, name: 'changes', content: {} }, { workspace: owner });
  await manager.share(artifact.id, [stranger.workspaceId], { workspace: owner });

  const seen = await manager.get(artifact.id, { workspace: stranger });
  assert.equal(seen.name, 'changes');
  await assert.rejects(() => manager.update(artifact.id, { name: 'renamed' }, { workspace: stranger }), ArtifactAccessError);
});

test('manager: only the owner can share, update or delete', async () => {
  const { manager, owner, stranger } = fixture();
  const artifact = await manager.create({ type: ARTIFACT_TYPES.REPORT, name: 'x', content: {} }, { workspace: owner });
  await assert.rejects(() => manager.share(artifact.id, [stranger.workspaceId], { workspace: stranger }), ArtifactAccessError);
  await assert.rejects(() => manager.delete(artifact.id, { workspace: stranger }), ArtifactAccessError);
});

test('manager: list only returns what the asker owns or was shared', async () => {
  const { manager, owner, stranger } = fixture();
  const mine = await manager.create({ type: ARTIFACT_TYPES.REPORT, name: 'mine', content: {} }, { workspace: owner });
  await manager.create({ type: ARTIFACT_TYPES.REPORT, name: 'also-mine', content: {} }, { workspace: owner });
  const theirs = await manager.create({ type: ARTIFACT_TYPES.REPORT, name: 'theirs', content: {} }, { workspace: stranger });

  const strangerList = await manager.list({ workspace: stranger });
  assert.deepEqual(strangerList.map((a) => a.id).sort(), [theirs.id].sort());

  await manager.share(mine.id, [stranger.workspaceId], { workspace: owner });
  const afterShare = await manager.list({ workspace: stranger });
  assert.ok(afterShare.some((a) => a.id === mine.id));
  assert.equal(afterShare.length, 2);
});

test('manager: creating an artifact attaches it to the producing workspace', async () => {
  const { manager, owner } = fixture();
  const artifact = await manager.create({ type: ARTIFACT_TYPES.TEST_RESULT, name: 'report', content: {} }, { workspace: owner });
  assert.ok(owner.artifactIds.includes(artifact.id));
});

test('manager: emits correlated artifact events', async () => {
  const { manager, owner, bus } = fixture();
  const seen = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('artifact.')) seen.push(ev); });
  const artifact = await manager.create({ type: ARTIFACT_TYPES.REPORT, name: 'x', content: {} }, { workspace: owner });
  await manager.delete(artifact.id, { workspace: owner });
  assert.deepEqual(seen.map((e) => e.type), [TYPES.ARTIFACT_CREATED, TYPES.ARTIFACT_DELETED]);
  assert.equal(seen[0].workspaceId, owner.workspaceId);
});

// --- convenience constructors ------------------------------------------------

test('manager: recordDiff and recordTestResult produce typed artifacts', async () => {
  const { manager, owner } = fixture();
  const diffArtifact = await manager.recordDiff([{ path: 'a.js', operation: 'modify' }], { workspace: owner });
  assert.equal(diffArtifact.type, ARTIFACT_TYPES.DIFF);
  const testArtifact = await manager.recordTestResult({ passed: true, exitCode: 0 }, { workspace: owner });
  assert.equal(testArtifact.type, ARTIFACT_TYPES.TEST_RESULT);
  assert.equal(testArtifact.metadata.passed, true);
});

// --- pure access predicates ------------------------------------------------------

test('canReadArtifact / canWriteArtifact agree with the manager\'s enforcement', () => {
  const artifact = { workspaceId: 'w1', metadata: { sharedWith: ['w2'] } };
  assert.equal(canReadArtifact(artifact, { workspaceId: 'w1' }), true);
  assert.equal(canReadArtifact(artifact, { workspaceId: 'w2' }), true);
  assert.equal(canReadArtifact(artifact, { workspaceId: 'w3' }), false);
  assert.equal(canWriteArtifact(artifact, { workspaceId: 'w2' }), false, 'sharing grants read, not write');
});
