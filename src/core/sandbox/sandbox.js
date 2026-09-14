// A Sandbox: one authorized workspace, its limits, and the processes inside it.
//
// This is the object an agent actually runs inside. It owns the two guarantees
// §21 asks for and that the rest of the platform relies on:
//
//   * **Workspace boundary.** Every path an execution touches is checked
//     against the authorized root with the same containment logic the tool
//     layer already uses (tools/path-guard.js) — lexical *and* symlink-aware.
//     `readPaths`/`writePaths` narrow that further; nothing widens it.
//   * **Process ownership.** Every handle spawned through the sandbox is
//     recorded with the full §23 chain, so stop, cancel, cleanup and recovery
//     all reach the same set of processes.
//
// And the one thing it refuses to do: invent numbers. Memory and CPU usage are
// reported as `null` when the backend cannot observe them, because a UI that
// shows a made-up "1.4 GB / 4 GB" is worse than one that shows a limit and says
// usage is unavailable (§39).

const path = require('node:path');
const { resolveWithin, realContains } = require('../tools/path-guard');
const { clampLimits, labelFor, describeClamp } = require('./limits');
const { enforcementLabel } = require('./capabilities');

const SANDBOX_STATES = Object.freeze({
  CREATED: 'created',
  STARTED: 'started',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

class SandboxPathError extends Error {
  constructor(message, { sandboxId = null, requested = null, root = null } = {}) {
    super(message);
    this.name = 'SandboxPathError';
    this.code = 'SANDBOX_PATH_DENIED';
    this.sandboxId = sandboxId;
    this.requested = requested;
    this.root = root;
  }
}

class SandboxLimitError extends Error {
  constructor(message, { sandboxId = null } = {}) {
    super(message);
    this.name = 'SandboxLimitError';
    this.code = 'SANDBOX_LIMIT';
    this.sandboxId = sandboxId;
  }
}

function createSandbox({
  id,
  workspaceRoot,
  limits = {},
  ceiling = undefined,
  backend,
  taskId = null,
  workspaceId = null,
  agentId = null,
  harnessId = null,
  sessionId = null,
  traceId = null,
  envAllowlist = null,
  readPaths = [],
  writePaths = [],
  realpathSync = undefined,
  logger = null,
} = {}) {
  if (!id) throw new Error('sandbox requires an id');
  if (!workspaceRoot) throw new Error('sandbox requires a workspace root');
  if (!backend) throw new Error('sandbox requires a backend');

  const root = path.resolve(workspaceRoot);
  const effective = clampLimits(limits, ceiling);
  const clampNotes = describeClamp(limits, effective);
  const state = {
    id,
    state: SANDBOX_STATES.CREATED,
    taskId,
    workspaceId: workspaceId || root,
    agentId,
    harnessId,
    sessionId,
    traceId,
    root,
    limits: effective,
    createdAt: Date.now(),
    startedAt: null,
    stoppedAt: null,
    failure: null,
  };
  const processes = new Map(); // refId -> { refId, kind, pid, ownerId, handle, startedAt }
  let seq = 0;

  function pathAllowed(target, mode = 'read') {
    if (effective.filesystemMode === 'none') {
      return { ok: false, resolved: null, reason: 'filesystem access is disabled by sandbox limits' };
    }
    if (mode === 'write' && effective.filesystemMode === 'readonly') {
      return { ok: false, resolved: null, reason: 'the sandbox is read-only' };
    }
    const resolved = resolveWithin(root, target);
    if (resolved === null) {
      return { ok: false, resolved: null, reason: `"${target}" escapes the authorized workspace` };
    }
    // Symlink-aware check unless the caller (or a test) opted out.
    if (realpathSync !== false && typeof (realpathSync || require('node:fs').realpathSync) === 'function') {
      const real = realContains(root, resolved, realpathSync || require('node:fs').realpathSync);
      if (!real) return { ok: false, resolved: null, reason: `"${target}" escapes the authorized workspace through a symlink` };
    }
    const extra = mode === 'write' ? writePaths : readPaths;
    if (extra.length > 0 && !extra.some((p) => resolveWithin(root, p) === resolved || resolved.startsWith(path.join(root, p, path.sep)))) {
      return { ok: false, resolved: null, reason: `"${target}" is outside the sandbox's ${mode} allowlist` };
    }
    return { ok: true, resolved, reason: null };
  }

  function assertPath(target, mode = 'read') {
    const verdict = pathAllowed(target, mode);
    if (!verdict.ok) throw new SandboxPathError(verdict.reason, { sandboxId: id, requested: target, root: root });
    return verdict.resolved;
  }

  function assertRunning() {
    if (state.state === SANDBOX_STATES.STOPPED || state.state === SANDBOX_STATES.FAILED) {
      throw new SandboxLimitError(`sandbox ${id} is ${state.state}`, { sandboxId: id });
    }
  }

  async function start(ctx = {}) {
    state.state = SANDBOX_STATES.STARTED;
    state.startedAt = Date.now();
    try {
      const detail = await backend.start({ ...ctx, root, limits: effective });
      return { ok: true, detail: detail || null };
    } catch (err) {
      state.state = SANDBOX_STATES.FAILED;
      state.failure = err.message;
      throw err;
    }
  }

  // The only sanctioned way to start a process inside this sandbox.
  function spawn(spec = {}) {
    assertRunning();
    const cwd = spec.cwd ? assertPath(spec.cwd, 'read') : root;
    const handle = backend.spawn({ ...spec, cwd, env: environmentFor(spec.env) });
    const ref = registerProcess({
      kind: spec.kind || 'process',
      pid: handle && handle.pid,
      ownerId: spec.ownerId || agentId || taskId || null,
      handle,
      command: spec.command || null,
    });
    return { handle, refId: ref.refId, pid: ref.pid, cwd };
  }

  function registerProcess({ kind = 'process', pid = null, ownerId = null, handle = null, command = null, harnessId: hId = null, runId = null, stop = null } = {}) {
    const refId = `proc-${(++seq).toString(36)}`;
    const record = {
      refId,
      kind,
      pid: pid === undefined ? null : pid,
      ownerId,
      command,
      harnessId: hId || harnessId,
      runId,
      handle,
      stop,
      startedAt: Date.now(),
    };
    processes.set(refId, record);
    if (handle && typeof handle.onExit === 'function') {
      handle.onExit(() => processes.delete(refId));
    }
    return { ...record };
  }

  function releaseProcess({ refId = null, runId = null, pid = null } = {}) {
    const removed = [];
    for (const [key, record] of [...processes.entries()]) {
      const match = (refId && key === refId) || (runId && record.runId === runId) || (pid !== null && record.pid === pid);
      if (match) {
        processes.delete(key);
        removed.push(record.refId);
      }
    }
    return removed;
  }

  function listProcesses() {
    return [...processes.values()].map((r) => ({
      refId: r.refId,
      kind: r.kind,
      pid: r.pid,
      ownerId: r.ownerId,
      harnessId: r.harnessId,
      runId: r.runId,
      startedAt: r.startedAt,
    }));
  }

  // Kill everything this sandbox owns. Always safe to call twice, which matters
  // because cancellation, cleanup and shutdown all converge here.
  async function killAll(reason = 'cleanup') {
    const killed = [];
    for (const record of [...processes.values()]) {
      try {
        if (typeof record.stop === 'function') await record.stop();
        else if (record.handle) await backend.kill(record.handle, reason);
        killed.push(record.refId);
      } catch (err) {
        if (logger) logger.warn(`sandbox ${id}: kill failed for ${record.refId}`, { error: err.message });
      }
      processes.delete(record.refId);
    }
    return killed;
  }

  async function stop(reason = 'requested') {
    if (state.state === SANDBOX_STATES.STOPPED) return snapshot();
    state.state = SANDBOX_STATES.STOPPING;
    const killed = await killAll(reason);
    try {
      await backend.stop();
    } catch (err) {
      state.failure = err.message;
      if (logger) logger.warn(`sandbox ${id}: backend stop failed`, { error: err.message });
    }
    state.state = SANDBOX_STATES.STOPPED;
    state.stoppedAt = Date.now();
    return { ...snapshot(), killed };
  }

  function environmentFor(_requested) {
    if (effective.environmentPolicy === 'minimal') return {};
    if (effective.environmentPolicy === 'inherit') return { ...(envAllowlist || {}) };
    // allowlist: exactly the granted keys, nothing implied.
    const out = {};
    for (const key of Object.keys(envAllowlist || {})) out[key] = String(envAllowlist[key]);
    return out;
  }

  // §39's panel, built only from values this sandbox actually knows. `used` is
  // null wherever the backend cannot observe it.
  function snapshot() {
    const enforcement = enforcementLabel({ enforcement: backend.enforcement });
    return {
      id: state.id,
      state: state.state,
      label: labelFor(effective),
      enforcement: backend.enforcement,
      enforcementLabel: enforcement,
      backend: backend.id,
      taskId: state.taskId,
      workspaceId: state.workspaceId,
      agentId: state.agentId,
      harnessId: state.harnessId,
      sessionId: state.sessionId,
      traceId: state.traceId,
      root,
      filesystem: {
        mode: effective.filesystemMode,
        label: effective.filesystemMode === 'workspace' ? 'Workspace only'
          : effective.filesystemMode === 'readonly' ? 'Read-only' : 'Disabled',
        readPaths: [...readPaths],
        writePaths: [...writePaths],
      },
      network: {
        mode: effective.networkMode,
        label: effective.networkMode === 'deny' ? 'Restricted' : effective.networkMode === 'loopback' ? 'Loopback only' : 'Allowed',
      },
      processes: {
        count: processes.size,
        limit: effective.maxProcesses,
      },
      memoryMb: {
        limit: effective.memoryMb,
        used: null, // never fabricated
      },
      cpuTimeMs: { limit: effective.cpuTimeMs, used: null },
      timeoutMs: effective.timeoutMs,
      environmentPolicy: effective.environmentPolicy,
      limits: effective,
      clampNotes,
      createdAt: state.createdAt,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      failure: state.failure,
      ownership: {
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        agentId: state.agentId,
        harnessId: state.harnessId,
        sessionId: state.sessionId,
        traceId: state.traceId,
      },
      processList: listProcesses(),
    };
  }

  return Object.freeze({
    id,
    root,
    limits: effective,
    get state() {
      return state.state;
    },
    backendId: backend.id,
    backend,
    start,
    stop,
    spawn,
    registerProcess,
    releaseProcess,
    listProcesses,
    killAll,
    pathAllowed,
    assertPath,
    snapshot,
    label: () => labelFor(effective),
  });
}

module.exports = { createSandbox, SandboxPathError, SandboxLimitError, SANDBOX_STATES };
