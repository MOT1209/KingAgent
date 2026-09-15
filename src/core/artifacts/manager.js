// ArtifactManager: the one door artifacts go through.
//
// Ownership is checked on every read and every write. This is not ceremony: as
// soon as a lead agent delegates, two agents are writing into the same store
// under different policies, and "whoever asks, gets" is how a delegate reads a
// sibling's private output or overwrites the lead's report.
//
// Sharing is explicit and additive (`share()`), never implied by being in the
// same session.

const { TYPES } = require('../events/event-bus');
const { identityRefs } = require('../workspace/identity');
const { validateArtifact, artifactRef, canRead, canWrite, ARTIFACT_TYPES } = require('./artifact');
const { ArtifactStore } = require('./store');

class ArtifactAccessError extends Error {
  constructor(message, { artifactId } = {}) {
    super(message);
    this.name = 'ArtifactAccessError';
    this.code = 'ARTIFACT_DENIED';
    this.artifactId = artifactId;
  }
}

class ArtifactManager {
  constructor({ store = null, collection = null, bus = null, logger = null } = {}) {
    this._store = store || new ArtifactStore({ collection });
    this._bus = bus;
    this._logger = logger;
  }

  get store() { return this._store; }

  // `workspace` is the producer. Its identity stamps the artifact, so ownership
  // is never something a caller can claim in the payload.
  async create(def, { workspace = null } = {}) {
    const identity = workspace ? workspace.identity : {};
    const merged = {
      ...def,
      workspaceId: workspace ? workspace.workspaceId : def.workspaceId,
      taskId: def.taskId || (workspace ? workspace.taskId : null),
      agentId: def.agentId || (workspace ? workspace.agentId : null),
      traceId: def.traceId || (workspace ? workspace.traceId : null),
      projectId: def.projectId || (workspace ? workspace.projectId : null),
    };
    const { ok, artifact, errors } = validateArtifact(merged);
    if (!ok) throw new Error(`invalid artifact: ${errors.join('; ')}`);

    await this._store.put(artifact);
    if (workspace && typeof workspace.attachArtifact === 'function') workspace.attachArtifact(artifact.id);
    if (this._bus) {
      this._bus.emit(TYPES.ARTIFACT_CREATED, identityRefs(identity), {
        id: artifact.id, type: artifact.type, name: artifact.name, bytes: artifact.bytes,
      });
    }
    return artifact;
  }

  // Reading someone else's artifact is a denial, not an empty result: silence
  // would read as "it doesn't exist" and hide a permissions bug.
  async get(id, { workspace = null, agentId = null } = {}) {
    const artifact = await this._store.get(id);
    if (!artifact) return null;
    const asker = { workspaceId: workspace ? workspace.workspaceId : null, agentId: agentId || (workspace ? workspace.agentId : null) };
    if (!canRead(artifact, asker)) {
      throw new ArtifactAccessError(`artifact ${id} is not readable by ${asker.workspaceId || asker.agentId || 'anonymous'}`, { artifactId: id });
    }
    return artifact;
  }

  async update(id, patch, { workspace = null } = {}) {
    const artifact = await this._store.get(id);
    if (!artifact) return null;
    if (!canWrite(artifact, { workspaceId: workspace ? workspace.workspaceId : null })) {
      throw new ArtifactAccessError(`artifact ${id} is not writable by ${workspace ? workspace.workspaceId : 'anonymous'}`, { artifactId: id });
    }
    const merged = { ...artifact, ...patch, id: artifact.id, workspaceId: artifact.workspaceId, createdAt: artifact.createdAt, updatedAt: Date.now() };
    const { ok, artifact: next, errors } = validateArtifact(merged);
    if (!ok) throw new Error(`invalid artifact update: ${errors.join('; ')}`);
    next.createdAt = artifact.createdAt;
    await this._store.put(next);
    if (this._bus) this._bus.emit(TYPES.ARTIFACT_UPDATED, identityRefs(workspace ? workspace.identity : {}), { id, type: next.type });
    return next;
  }

  async delete(id, { workspace = null } = {}) {
    const artifact = await this._store.get(id);
    if (!artifact) return false;
    if (!canWrite(artifact, { workspaceId: workspace ? workspace.workspaceId : null })) {
      throw new ArtifactAccessError(`artifact ${id} is not deletable by ${workspace ? workspace.workspaceId : 'anonymous'}`, { artifactId: id });
    }
    await this._store.delete(id);
    if (this._bus) this._bus.emit(TYPES.ARTIFACT_DELETED, identityRefs(workspace ? workspace.identity : {}), { id });
    return true;
  }

  // The only way one workspace's artifact becomes readable by another. Additive
  // and recorded on the artifact, so "who can see this?" has an answer on disk.
  async share(id, targets, { workspace = null } = {}) {
    const artifact = await this._store.get(id);
    if (!artifact) return null;
    if (!canWrite(artifact, { workspaceId: workspace ? workspace.workspaceId : null })) {
      throw new ArtifactAccessError(`artifact ${id} cannot be shared by ${workspace ? workspace.workspaceId : 'anonymous'}`, { artifactId: id });
    }
    const list = Array.isArray(targets) ? targets : [targets];
    const shared = new Set([...(artifact.metadata.sharedWith || []), ...list.filter(Boolean)]);
    const next = { ...artifact, metadata: { ...artifact.metadata, sharedWith: [...shared] }, updatedAt: Date.now() };
    await this._store.put(next);
    if (this._bus) this._bus.emit(TYPES.ARTIFACT_UPDATED, identityRefs(workspace ? workspace.identity : {}), { id, sharedWith: [...shared] });
    return next;
  }

  // Listing is scoped to what the asker owns or was shared, so an enumeration
  // cannot be used to discover someone else's artifacts.
  async list({ workspace = null, agentId = null, taskId = null, type = null, limit = 100 } = {}) {
    const asker = { workspaceId: workspace ? workspace.workspaceId : null, agentId: agentId || (workspace ? workspace.agentId : null) };
    const rows = await this._store.list({ taskId, type });
    return rows.filter((a) => canRead(a, asker)).slice(0, limit);
  }

  async refs(filter) {
    return (await this.list(filter)).map(artifactRef);
  }

  // Convenience constructors for the two artifacts almost every task produces.
  async recordDiff(diffRows, { workspace, name = 'changes', producedBy = null } = {}) {
    return this.create({
      type: ARTIFACT_TYPES.DIFF,
      name,
      content: { files: diffRows.length, changes: diffRows },
      producedBy,
      metadata: { paths: diffRows.map((d) => d.path).slice(0, 200) },
    }, { workspace });
  }

  async recordTestResult(result, { workspace, name = 'test-report', producedBy = null } = {}) {
    return this.create({
      type: ARTIFACT_TYPES.TEST_RESULT,
      name,
      content: result,
      producedBy,
      metadata: { passed: result && result.passed === true, exitCode: result ? result.exitCode ?? null : null },
    }, { workspace });
  }
}

module.exports = { ArtifactManager, ArtifactAccessError };
