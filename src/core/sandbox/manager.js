// SandboxManager: creates sandboxes, owns their lifetime, and cleans up.
//
// Every execution in Phase 4 happens inside a sandbox, including the ones that
// only read. The manager is the single place sandboxes come from, which gives
// the platform the properties the Definition of Done asks for:
//
//   * workspace restriction — a sandbox cannot be created without a root, and
//     the root is only ever the workspace the user authorized
//   * process ownership    — registerProcess/releaseProcess are the hooks the
//     harness manager and the execution path use, so `stop`, `cancel` and
//     shutdown all reach the same table
//   * cleanup              — `cleanup()` kills every process in every sandbox
//     and is safe to call at any time, including twice
//
// Backend choice is a *decision with a reason*, not a default: selectBackend()
// reports what is available on this platform and what is merely planned, and a
// request for a feature no available backend can provide fails loudly rather
// than quietly running unconfined.

const { createSandbox } = require('./sandbox');
const { createAdvisoryBackend, createNullBackend, isBackend } = require('./backend');
const { selectBackend, listBackends, platformName, RECOMMENDED_BACKEND } = require('./capabilities');
const { DEFAULT_CEILING } = require('./limits');
const { TYPES } = require('../events/event-bus');

class SandboxDeniedError extends Error {
  constructor(message, { decision = null } = {}) {
    super(message);
    this.name = 'SandboxDeniedError';
    this.code = 'SANDBOX_DENIED';
    this.decision = decision;
  }
}

class SandboxManager {
  constructor({
    bus = null,
    logger = null,
    spawn = null,
    kill = null,
    killTree = null,
    backend = null,
    backendFactory = null,
    ceiling = DEFAULT_CEILING,
    policy = null,
    store = null,
    platform = process.platform,
  } = {}) {
    this._bus = bus;
    this._logger = logger;
    this._ceiling = ceiling;
    this._policy = policy;
    this._store = store;
    this._platform = platformName(platform);
    this._sandboxes = new Map(); // id -> sandbox
    this._byTask = new Map();    // taskId -> Set<id>
    this._seq = 0;
    this._io = { spawn, kill, killTree };
    this._explicitBackend = backend;
    this._backendFactory = backendFactory;
  }

  // Which backend this manager will use, and why. Computed lazily so the
  // decision reflects the requested feature set.
  resolveBackend({ required = [], prefer = null } = {}) {
    if (isBackend(this._explicitBackend)) {
      return { backend: this._explicitBackend, decision: { backend: this._explicitBackend.id, available: true, satisfied: true, reasons: [], considered: [this._explicitBackend.id] } };
    }
    if (this._backendFactory) {
      const decision = selectBackend({ platform: this._platform, required, prefer: prefer || RECOMMENDED_BACKEND[this._platform] || null });
      if (!decision.available) return { backend: createNullBackend(), decision };
      const backend = this._backendFactory({ id: decision.backend.id, io: this._io, decision, platform: this._platform });
      if (!isBackend(backend)) throw new Error('backendFactory did not return a sandbox backend');
      return { backend, decision };
    }
    const decision = selectBackend({ platform: this._platform, required, prefer: prefer || RECOMMENDED_BACKEND[this._platform] || null });
    if (decision.available && decision.backend.id === 'advisory') {
      // The advisory backend needs limits at construction time for its process
      // ceiling; it gets them from the sandbox that owns it at spawn time, so a
      // permissive placeholder here is safe — Sandbox.spawn consults the
      // effective limits through the sandbox, and the backend stays a thin
      // process table.
      return { backend: createAdvisoryBackend({ io: this._io, limits: {}, logger: this._logger }), decision };
    }
    return { backend: createNullBackend(), decision };
  }

  backendInfo({ required = [] } = {}) {
    const { backend, decision } = this.resolveBackend({ required });
    return {
      platform: this._platform,
      selected: backend.id,
      name: backend.name,
      enforcement: backend.enforcement,
      declared: listBackends(),
      decision,
      supportedFeatures: [...backend.features],
    };
  }

  // Create and start a sandbox for one unit of work.
  async create({
    taskId = null,
    workspaceId = null,
    agentId = null,
    harnessId = null,
    sessionId = null,
    traceId = null,
    delegationId = null,
    workspaceRoot,
    limits = {},
    readPaths = [],
    writePaths = [],
    envAllowlist = null,
    requiredFeatures = [],
  } = {}) {
    if (!workspaceRoot) throw new SandboxDeniedError('a sandbox requires the authorized workspace root');

    if (this._policy) {
      const decision = await this._policy.evaluate({
        action: 'sandbox.create',
        context: { taskId, workspaceId: workspaceId || workspaceRoot, agentId, harnessId, sessionId },
      });
      if (!decision.allowed) {
        throw new SandboxDeniedError(`sandbox creation denied: ${decision.reason}`, { decision });
      }
    }

    const { backend } = this.resolveBackend({ required: requiredFeatures });

    const id = `sandbox-${(++this._seq).toString(36)}-${Date.now().toString(36)}`;
    const sandbox = createSandbox({
      id,
      workspaceRoot,
      limits,
      ceiling: this._ceiling,
      backend,
      taskId,
      workspaceId,
      agentId,
      harnessId: harnessId || backend.id,
      sessionId,
      traceId,
      envAllowlist,
      readPaths,
      writePaths,
      logger: this._logger,
    });

    this._sandboxes.set(id, sandbox);
    if (taskId) {
      if (!this._byTask.has(taskId)) this._byTask.set(taskId, new Set());
      this._byTask.get(taskId).add(id);
    }

    const refs = { taskId, agentId, harnessId, sessionId, sandboxId: id, workspaceId: workspaceId || workspaceRoot, delegationId };
    this._emit(TYPES.SANDBOX_CREATED, refs, {
      backend: backend.id,
      enforcement: backend.enforcement,
      limits: sandbox.limits,
      label: sandbox.label(),
    });

    try {
      await sandbox.start({ taskId, agentId, sessionId });
    } catch (err) {
      this._emit(TYPES.SANDBOX_FAILED, refs, { error: err.message, phase: 'start' });
      this._sandboxes.delete(id);
      throw err;
    }
    this._emit(TYPES.SANDBOX_STARTED, refs, { backend: backend.id, label: sandbox.label(), limits: sandbox.limits });
    if (this._store) this._store.set(`sandbox:${id}`, sandbox.snapshot()).catch(() => {});
    return sandbox;
  }

  get(id) {
    return this._sandboxes.get(id) || null;
  }

  list(filter = {}) {
    let all = [...this._sandboxes.values()];
    if (filter.taskId) all = all.filter((s) => s.snapshot().taskId === filter.taskId);
    if (filter.state) all = all.filter((s) => s.state === filter.state);
    return all;
  }

  forTask(taskId) {
    const ids = this._byTask.get(taskId);
    return ids ? [...ids].map((id) => this._sandboxes.get(id)).filter(Boolean) : [];
  }

  // Process ownership surface, used by the harness manager and execution path.
  registerProcess(sandboxId, ref) {
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`no sandbox "${sandboxId}"`);
    const record = sandbox.registerProcess(ref);
    this._emit(TYPES.SANDBOX_PROCESS_REGISTERED, { sandboxId, taskId: record.ownerId, harnessId: record.harnessId }, { refId: record.refId, pid: record.pid, kind: record.kind });
    return record;
  }

  releaseProcess(sandboxId, filter) {
    const sandbox = this._sandboxes.get(sandboxId);
    if (!sandbox) return [];
    return sandbox.releaseProcess(filter || {});
  }

  async stop(id, reason = 'requested') {
    const sandbox = this._sandboxes.get(id);
    if (!sandbox) return null;
    const result = await sandbox.stop(reason);
    this._emit(TYPES.SANDBOX_STOPPED, { sandboxId: id, taskId: sandbox.snapshot().taskId }, { reason, killed: result.killed || [] });
    this._sandboxes.delete(id);
    for (const set of this._byTask.values()) set.delete(id);
    return result;
  }

  async stopTask(taskId, reason = 'task ended') {
    const stopped = [];
    for (const sandbox of this.forTask(taskId)) {
      await this.stop(sandbox.id, reason);
      stopped.push(sandbox.id);
    }
    return stopped;
  }

  // Kill everything, everywhere. Called on shutdown and by recovery.
  async cleanup(reason = 'cleanup') {
    const ids = [...this._sandboxes.keys()];
    for (const id of ids) {
      try {
        await this.stop(id, reason);
      } catch (err) {
        if (this._logger) this._logger.warn(`sandbox ${id} cleanup failed`, { error: err.message });
      }
    }
    this._byTask.clear();
    return ids;
  }

  snapshot(id) {
    const sandbox = this._sandboxes.get(id);
    return sandbox ? sandbox.snapshot() : null;
  }

  controlView() {
    return {
      backends: this.backendInfo(),
      sandboxes: [...this._sandboxes.values()].map((s) => {
        const snap = s.snapshot();
        return {
          id: snap.id,
          label: snap.label,
          enforcement: snap.enforcement,
          backend: snap.backend,
          state: snap.state,
          taskId: snap.taskId,
          agentId: snap.agentId,
          filesystem: snap.filesystem,
          network: snap.network,
          processes: snap.processes,
          memoryMb: snap.memoryMb,
          clampNotes: snap.clampNotes,
        };
      }),
    };
  }

  _emit(type, refs, payload) {
    if (this._bus) this._bus.emit(type, refs, payload);
  }
}

module.exports = { SandboxManager, SandboxDeniedError };
