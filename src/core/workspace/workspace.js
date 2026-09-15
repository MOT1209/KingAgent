// The AgentWorkspace: the execution boundary a task runs inside.
//
// Before Phase 3 an agent's "world" was whatever the tools happened to be able
// to reach. A workspace makes that world explicit and *narrow*: a root the
// filesystem tools may not escape, a tool allow-list, the memory scopes this
// agent may read, an environment it was granted, and the running record of what
// it touched. Everything a task produces quotes the workspace identity, so a
// trace, an artifact and a memory entry can be tied back to one execution.
//
// The workspace is a boundary, not an enforcer of last resort: path containment
// still goes through tools/path-guard.js (which also defeats symlink escapes)
// and tool permissions still go through tools/permissions.js. What the
// workspace adds is a *second*, per-execution narrowing that a delegated agent
// cannot widen — see policy intersection in `derivePolicy`.

const path = require('node:path');
const { assertWithin } = require('../tools/path-guard');
const { createFileContext } = require('./file-context');
const { createEnvironment } = require('./environment');
const { createIdentity, identityRefs, validateIdentity } = require('./identity');
const { SCOPES } = require('../memory/scopes');
const { TYPES } = require('../events/event-bus');

const STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
});

// The default is deliberately tight: read-ish scopes, no destructive reach, and
// only the memory an agent owns plus the project it was opened on.
const DEFAULT_POLICY = Object.freeze({
  tools: null, // null = "whatever the agent's own permissions allow"; an array narrows further
  capabilities: null, // same shape, for capability-based selection
  memoryScopes: Object.freeze([SCOPES.TASK, SCOPES.SESSION, SCOPES.AGENT, SCOPES.WORKSPACE, SCOPES.PROJECT]),
  allowNetwork: false,
  allowDestructive: false,
  maxFileBytes: 2 * 1024 * 1024,
});

// Narrowing only. A delegated workspace may drop permissions its parent had and
// may never add one back, which is what makes delegation safe to hand to an
// agent chosen by a model.
function derivePolicy(parentPolicy, requested = {}) {
  const parent = { ...DEFAULT_POLICY, ...(parentPolicy || {}) };
  const out = { ...parent };

  for (const key of ['tools', 'capabilities']) {
    const want = requested[key];
    if (!Array.isArray(want)) continue;
    out[key] = Array.isArray(parent[key]) ? want.filter((v) => parent[key].includes(v)) : [...want];
  }
  if (Array.isArray(requested.memoryScopes)) {
    out.memoryScopes = requested.memoryScopes.filter((s) => parent.memoryScopes.includes(s));
  }
  // A boolean the parent does not hold cannot be granted by asking for it; a
  // boolean the parent does hold can still be dropped.
  for (const flag of ['allowNetwork', 'allowDestructive']) {
    const want = requested[flag] === undefined ? parent[flag] : Boolean(requested[flag]);
    out[flag] = Boolean(parent[flag] && want);
  }
  if (typeof requested.maxFileBytes === 'number') out.maxFileBytes = Math.min(parent.maxFileBytes, requested.maxFileBytes);
  return Object.freeze(out);
}

class AgentWorkspace {
  constructor({
    identity,
    root,
    cwd = null,
    policy = {},
    environment = null,
    bus = null,
    skills = [],
    metadata = {},
    realpathSync = null,
  } = {}) {
    const id = identity && identity.workspaceId ? identity : createIdentity(identity || {});
    const check = validateIdentity(id);
    if (!check.ok) throw new Error(`invalid workspace identity: ${check.errors.join('; ')}`);

    this.identity = id;
    this.root = root ? path.resolve(root) : null;
    this.cwd = cwd ? path.resolve(cwd) : this.root;
    this.policy = derivePolicy(DEFAULT_POLICY, policy);
    this.status = STATUS.ACTIVE;
    this.files = createFileContext();
    this.environment = environment || createEnvironment({});
    this.skills = [...skills];
    this.metadata = { ...metadata };
    this.artifactIds = [];
    this.memoryRefs = [];
    this.contextRefs = [];
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this._bus = bus;
    this._realpathSync = realpathSync;

    if (this._bus) this._bus.emit(TYPES.WORKSPACE_CREATED, identityRefs(this.identity), { root: this.root });
  }

  get workspaceId() { return this.identity.workspaceId; }
  get taskId() { return this.identity.taskId; }
  get traceId() { return this.identity.traceId; }
  get agentId() { return this.identity.agentId; }
  get projectId() { return this.identity.projectId; }
  get sessionId() { return this.identity.sessionId; }

  // The only way to turn a relative path into an absolute one inside a
  // workspace. Throws — loudly — when the target escapes the root lexically or
  // through a symlink.
  resolve(rel) {
    this._assertOpen();
    if (!this.root) return path.resolve(rel || '.');
    const opts = this._realpathSync ? { realpathSync: this._realpathSync } : {};
    return assertWithin(this.root, rel || '.', opts);
  }

  contains(rel) {
    try { this.resolve(rel); return true; } catch { return false; }
  }

  canUseTool(toolId) {
    if (this.status !== STATUS.ACTIVE) return false;
    if (!Array.isArray(this.policy.tools)) return true;
    return this.policy.tools.includes(toolId);
  }

  canUseCapability(capability) {
    if (this.status !== STATUS.ACTIVE) return false;
    if (!Array.isArray(this.policy.capabilities)) return true;
    return this.policy.capabilities.includes(capability);
  }

  canAccessScope(scope) {
    return this.policy.memoryScopes.includes(scope);
  }

  // An artifact belongs to the workspace that produced it. Reading someone
  // else's needs an explicit share (artifact.metadata.sharedWith), never an
  // ambient "same session" assumption.
  canAccessArtifact(artifact) {
    if (!artifact) return false;
    if (artifact.workspaceId === this.workspaceId) return true;
    const shared = artifact.metadata && artifact.metadata.sharedWith;
    return Array.isArray(shared) && (shared.includes(this.workspaceId) || shared.includes(this.agentId));
  }

  // The memory policy this workspace hands the MemoryManager.
  memoryPolicy() {
    return {
      scopes: [...this.policy.memoryScopes],
      ids: {
        [SCOPES.TASK]: this.taskId,
        [SCOPES.SESSION]: this.sessionId,
        [SCOPES.AGENT]: this.agentId,
        [SCOPES.WORKSPACE]: this.workspaceId,
        [SCOPES.PROJECT]: this.projectId,
      },
    };
  }

  attachArtifact(artifactId) {
    if (artifactId && !this.artifactIds.includes(artifactId)) this.artifactIds.push(artifactId);
    this._touch();
    return this.artifactIds;
  }

  attachMemory(memoryId) {
    if (memoryId && !this.memoryRefs.includes(memoryId)) this.memoryRefs.push(memoryId);
    this._touch();
    return this.memoryRefs;
  }

  attachContext(packetId) {
    if (packetId && !this.contextRefs.includes(packetId)) this.contextRefs.push(packetId);
    this._touch();
    return this.contextRefs;
  }

  // File bookkeeping funnels through here so every change also becomes an event
  // the UI and the trace can see, instead of being discoverable only by
  // inspecting the workspace afterwards.
  noteFile(operation, targetPath, detail = {}) {
    this._assertOpen();
    const fc = this.files;
    let entry;
    switch (operation) {
      case 'read': entry = fc.recordRead(targetPath, detail); break;
      case 'create': entry = fc.recordCreate(targetPath, detail); break;
      case 'modify': entry = fc.recordModify(targetPath, detail); break;
      case 'delete': entry = fc.recordDelete(targetPath, detail); break;
      case 'rename': entry = fc.recordRename(detail.from || targetPath, targetPath, detail); break;
      default: throw new Error(`unknown file operation "${operation}"`);
    }
    this._touch();
    if (this._bus) {
      const type = operation === 'create' ? TYPES.WORKSPACE_FILE_ADDED
        : operation === 'delete' ? TYPES.WORKSPACE_FILE_REMOVED
          : TYPES.WORKSPACE_FILE_MODIFIED;
      if (operation !== 'read') {
        this._bus.emit(type, identityRefs(this.identity), { path: targetPath, operation });
      }
    }
    return entry;
  }

  suspend() { this.status = STATUS.SUSPENDED; this._touch(); return this; }
  reactivate() { if (this.status === STATUS.CLOSED) throw new Error('a closed workspace cannot be reactivated'); this.status = STATUS.ACTIVE; this._touch(); return this; }
  close() { this.status = STATUS.CLOSED; this._touch(); return this; }

  _assertOpen() {
    if (this.status === STATUS.CLOSED) throw new Error(`workspace ${this.workspaceId} is closed`);
  }

  _touch() {
    this.updatedAt = Date.now();
    if (this._bus) this._bus.emit(TYPES.WORKSPACE_UPDATED, identityRefs(this.identity), { status: this.status });
  }

  // Serializable view: what persistence, IPC and snapshots carry. Never the
  // environment's real values (environment.toJSON redacts) and never a function.
  toJSON() {
    return {
      identity: { ...this.identity },
      root: this.root,
      cwd: this.cwd,
      status: this.status,
      policy: { ...this.policy, memoryScopes: [...this.policy.memoryScopes] },
      skills: [...this.skills],
      metadata: { ...this.metadata },
      environment: this.environment.toJSON(),
      files: this.files.toJSON(),
      artifactIds: [...this.artifactIds],
      memoryRefs: [...this.memoryRefs],
      contextRefs: [...this.contextRefs],
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = { AgentWorkspace, STATUS, DEFAULT_POLICY, derivePolicy };
