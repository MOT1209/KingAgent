// WorkspaceManager: creating, finding, persisting and reviving workspaces.
//
// Every task gets exactly one workspace, and the manager is the only thing that
// mints them — so "which workspace is this task running in?" has one answer,
// and a crash can be recovered from because the answer was written down.
//
// Persistence is the serializable view only (workspace.toJSON()). A revived
// workspace deliberately does NOT carry its parent's live file handles or the
// real values of its environment: recovery restores identity, policy and the
// record of what happened, and the host re-grants anything privileged.

const { AgentWorkspace, STATUS, derivePolicy } = require('./workspace');
const { createIdentity, childIdentity, identityRefs } = require('./identity');
const { createEnvironment } = require('./environment');

class WorkspaceManager {
  constructor({ bus = null, collection = null, logger = null, realpathSync = null, maxOpen = 200 } = {}) {
    this._bus = bus;
    this._collection = collection; // persistence/collections.js workspace collection
    this._logger = logger;
    this._realpathSync = realpathSync;
    this._maxOpen = maxOpen;
    this._byId = new Map();
    this._byTask = new Map();
  }

  create({
    identity = {},
    root = null,
    cwd = null,
    policy = {},
    environment = null,
    skills = [],
    metadata = {},
  } = {}) {
    const id = identity && identity.workspaceId ? identity : createIdentity(identity);
    const ws = new AgentWorkspace({
      identity: id,
      root,
      cwd,
      policy,
      environment: environment || createEnvironment({}),
      bus: this._bus,
      skills,
      metadata,
      realpathSync: this._realpathSync,
    });
    this._register(ws);
    this._persist(ws);
    return ws;
  }

  // A delegated agent's workspace. It inherits the parent's root and *cannot*
  // widen the parent's policy (derivePolicy intersects), which is the whole
  // reason delegation can be handed to a model-chosen agent.
  createChild(parent, { agentId = null, policy = {}, root = null, metadata = {}, traceId = null } = {}) {
    if (!parent) throw new Error('createChild requires a parent workspace');
    const id = childIdentity(parent.identity, { agentId, traceId });
    const ws = new AgentWorkspace({
      identity: id,
      root: root || parent.root,
      cwd: parent.cwd,
      policy: derivePolicy(parent.policy, policy),
      environment: parent.environment,
      bus: this._bus,
      skills: parent.skills,
      metadata: { ...metadata, parentWorkspaceId: parent.workspaceId },
      realpathSync: this._realpathSync,
    });
    this._register(ws);
    this._persist(ws);
    return ws;
  }

  get(workspaceId) {
    return this._byId.get(workspaceId) || null;
  }

  forTask(taskId) {
    const id = this._byTask.get(taskId);
    return id ? this.get(id) : null;
  }

  list({ status = null, projectId = null } = {}) {
    return [...this._byId.values()].filter((w) =>
      (!status || w.status === status) && (!projectId || w.projectId === projectId));
  }

  children(parentWorkspaceId) {
    return [...this._byId.values()].filter((w) => w.identity.parentWorkspaceId === parentWorkspaceId);
  }

  suspend(workspaceId) {
    const ws = this.get(workspaceId);
    if (!ws) return null;
    ws.suspend();
    this._persist(ws);
    return ws;
  }

  reactivate(workspaceId) {
    const ws = this.get(workspaceId);
    if (!ws) return null;
    ws.reactivate();
    this._persist(ws);
    return ws;
  }

  close(workspaceId) {
    const ws = this.get(workspaceId);
    if (!ws) return null;
    ws.close();
    this._persist(ws);
    this._byTask.delete(ws.taskId);
    return ws;
  }

  async persist(workspaceId) {
    const ws = this.get(workspaceId);
    if (!ws || !this._collection) return null;
    await this._collection.put(ws.workspaceId, ws.toJSON());
    return ws.toJSON();
  }

  async loadPersisted(workspaceId) {
    if (!this._collection) return null;
    return this._collection.get(workspaceId);
  }

  async listPersisted({ status = null } = {}) {
    if (!this._collection) return [];
    return this._collection.list({ filter: (rec) => !status || rec.status === status });
  }

  // Revive a persisted workspace into a live one. The record's file history and
  // attachment lists come back; the environment does not — it is rebuilt from
  // whatever the host grants now, because the persisted form is redacted.
  async restore(workspaceId, { environment = null, bus = null } = {}) {
    const rec = await this.loadPersisted(workspaceId);
    if (!rec) return null;
    const existing = this.get(workspaceId);
    if (existing) return existing;
    const ws = new AgentWorkspace({
      identity: rec.identity,
      root: rec.root,
      cwd: rec.cwd,
      policy: rec.policy,
      environment: environment || createEnvironment({}),
      bus: bus || this._bus,
      skills: rec.skills || [],
      metadata: { ...(rec.metadata || {}), restored: true },
      realpathSync: this._realpathSync,
    });
    ws.status = rec.status === STATUS.CLOSED ? STATUS.CLOSED : STATUS.SUSPENDED;
    ws.artifactIds = [...(rec.artifactIds || [])];
    ws.memoryRefs = [...(rec.memoryRefs || [])];
    ws.contextRefs = [...(rec.contextRefs || [])];
    ws.createdAt = rec.createdAt || Date.now();
    for (const change of (rec.files && rec.files.changes) || []) {
      // Replayed as history only — restoring never re-performs an operation.
      ws.files.recordRead(change.path, { summary: change.summary || '' });
    }
    this._register(ws);
    return ws;
  }

  _register(ws) {
    this._byId.set(ws.workspaceId, ws);
    if (ws.taskId) this._byTask.set(ws.taskId, ws.workspaceId);
    if (this._byId.size > this._maxOpen) this._evictClosed();
    return ws;
  }

  // Bounded memory: closed workspaces are dropped from the live map first; they
  // stay readable through the store.
  _evictClosed() {
    for (const [id, ws] of this._byId) {
      if (this._byId.size <= this._maxOpen) break;
      if (ws.status === STATUS.CLOSED) this._byId.delete(id);
    }
  }

  _persist(ws) {
    if (!this._collection) return;
    this._collection.put(ws.workspaceId, ws.toJSON()).catch((err) => {
      if (this._logger) this._logger.warn('workspace persist failed', { workspaceId: ws.workspaceId, error: err.message });
    });
  }

  refs(workspaceId) {
    const ws = this.get(workspaceId);
    return ws ? identityRefs(ws.identity) : {};
  }
}

module.exports = { WorkspaceManager };
