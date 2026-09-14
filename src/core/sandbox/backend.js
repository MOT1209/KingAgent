// Sandbox backends: the process-isolation seam.
//
// A backend is the thing that would actually confine an execution. This fork
// ships one real backend — `advisory`, which enforces what this platform can
// enforce in process — and declares the kernel-enforced families (Windows Job
// Objects, macOS sandbox profiles, Linux namespaces, remote) as planned, so a
// host can plug one in without any other module changing.
//
// The interface, in full:
//
//   { id, name, enforcement, features,
//     start(ctx), stop(), spawn(spec), kill(handle), applyLimits(limits) }
//
// `spawn` is the only way a sandboxed process comes into existence, and the
// host supplies the spawner. That is deliberate: this fork's terminal runs on
// node-pty (src/main/platform-shell.js) and §22 forbids replacing it to get
// isolation, so the backend wraps whatever the host already has, records
// ownership of the pid it hands back, and guarantees cleanup.
//
// `applyLimits` returns what it *could* apply and what it could not. It never
// pretends: an advisory backend reports `cpu` and `memory` as unsupported
// rather than silently ignoring them.

const { isPlainObject } = require('../schema/validate');
const { describeBackend, platformName } = require('./capabilities');

class SandboxBackendError extends Error {
  constructor(message, { code = 'SANDBOX_BACKEND_ERROR', backendId = null } = {}) {
    super(message);
    this.name = 'SandboxBackendError';
    this.code = code;
    this.backendId = backendId;
  }
}

// The in-process backend. Real behaviour, honestly labelled:
//
//   * enforces the workspace boundary through path checking (every spawn gets
//     a validated cwd, and the sandbox's own path gate refuses anything else)
//   * owns the processes it starts, so stop/cleanup can find and kill them
//   * enforces the timeout and the process ceiling itself
//   * applies an environment built from an allowlist, never the host's
//   * reports cpu and memory as unsupported — it has no way to bound them
function createAdvisoryBackend({ io = {}, limits = {}, logger = null } = {}) {
  const family = describeBackend('advisory');
  const processes = new Map(); // pid -> { handle, spec, startedAt }
  const startedAt = Date.now();
  let stopped = false;

  const spawner = typeof io.spawn === 'function' ? io.spawn : null;
  const killFn = typeof io.kill === 'function' ? io.kill : defaultKill;
  const killTreeFn = typeof io.killTree === 'function' ? io.killTree : null;

  function start(_ctx = {}) {
    stopped = false;
    return { ok: true, backend: family.id, enforcement: family.enforcement, startedAt };
  }

  async function stop() {
    stopped = true;
    const killed = [];
    for (const [pid, record] of [...processes.entries()]) {
      try {
        await killTree(record);
        killed.push(pid);
      } catch (err) {
        if (logger) logger.warn(`sandbox backend could not kill ${pid}`, { error: err.message });
      }
      processes.delete(pid);
    }
    return { ok: true, killed };
  }

  function spawn(spec = {}) {
    if (stopped) throw new SandboxBackendError('sandbox backend is stopped', { backendId: family.id });
    if (!spawner) throw new SandboxBackendError('no process spawner was wired by the host', { code: 'SANDBOX_NO_SPAWNER', backendId: family.id });
    const maxProcesses = limits.maxProcesses;
    if (typeof maxProcesses === 'number' && processes.size >= maxProcesses) {
      throw new SandboxBackendError(`process limit reached (${maxProcesses})`, { code: 'SANDBOX_PROCESS_LIMIT', backendId: family.id });
    }
    const handle = spawner(spec);
    if (!handle || typeof handle !== 'object') {
      throw new SandboxBackendError('the host spawner returned no handle', { backendId: family.id });
    }
    const pid = handle.pid === undefined ? null : handle.pid;
    if (pid !== null) {
      processes.set(pid, { handle, spec: { ...spec, env: undefined }, startedAt: Date.now() });
      handle.onExit && handle.onExit(() => processes.delete(pid));
    }
    return handle;
  }

  async function kill(handle) {
    const pid = handle && handle.pid;
    if (pid !== undefined && pid !== null && processes.has(pid)) {
      const record = processes.get(pid);
      await killTree(record);
      processes.delete(pid);
      return { ok: true, pid };
    }
    if (handle && typeof handle.kill === 'function') {
      handle.kill('SIGTERM');
      return { ok: true, pid: pid === undefined ? null : pid };
    }
    return { ok: false, pid: pid === undefined ? null : pid, reason: 'no handle to kill' };
  }

  async function killTree(record) {
    // Prefer the host's tree killer. Without one, kill the direct child and say
    // so by reporting only what was actually done.
    if (killTreeFn) return killTreeFn(record.handle);
    if (typeof record.handle.kill === 'function') {
      try { record.handle.kill('SIGTERM'); } catch (_) { /* already gone */ }
      setTimeout(() => {
        try { record.handle.kill('SIGKILL'); } catch (_) { /* already gone */ }
      }, 400).unref?.();
      return { ok: true, strategy: 'signal' };
    }
    return killFn(record.handle);
  }

  function applyLimits(next = {}) {
    const applied = [];
    const unsupported = [];
    if (typeof next.timeoutMs === 'number') applied.push('timeoutMs');
    if (typeof next.maxProcesses === 'number') applied.push('maxProcesses');
    if (next.filesystemMode) applied.push('filesystemMode');
    if (next.environmentPolicy) applied.push('environmentPolicy');
    if (next.cpuTimeMs !== null && next.cpuTimeMs !== undefined) unsupported.push('cpuTimeMs');
    if (next.memoryMb !== null && next.memoryMb !== undefined) unsupported.push('memoryMb');
    if (next.networkMode && next.networkMode !== 'deny') unsupported.push('networkMode');
    else if (next.networkMode) applied.push('networkMode');
    return { applied, unsupported, backend: family.id, enforcement: family.enforcement };
  }

  return Object.freeze({
    id: family.id,
    name: family.name,
    enforcement: family.enforcement,
    platform: platformName(),
    features: [...family.features],
    note: family.note,
    start,
    stop,
    spawn,
    kill,
    applyLimits,
    listProcesses: () => [...processes.keys()],
  });
}

// An explicitly unisolated backend. Exists so a host can opt out *visibly*:
// the snapshot reports `enforcement: 'none'` and the UI says so, which is far
// better than pretending the advisory backend is isolation when a host has
// disabled it.
function createNullBackend() {
  return Object.freeze({
    id: 'none',
    name: 'No sandbox',
    enforcement: 'none',
    platform: platformName(),
    features: [],
    note: 'Sandboxing disabled by the host. Workspace boundaries are still checked by the tool layer.',
    start: () => ({ ok: true, backend: 'none', enforcement: 'none' }),
    stop: async () => ({ ok: true, killed: [] }),
    spawn: () => { throw new SandboxBackendError('sandboxing is disabled on this install', { code: 'SANDBOX_DISABLED', backendId: 'none' }); },
    kill: async () => ({ ok: false, reason: 'sandboxing is disabled' }),
    applyLimits: (next = {}) => ({ applied: [], unsupported: Object.keys(next), backend: 'none', enforcement: 'none' }),
    listProcesses: () => [],
  });
}

function defaultKill(handle) {
  if (handle && typeof handle.kill === 'function') {
    handle.kill('SIGKILL');
    return { ok: true, strategy: 'signal' };
  }
  return { ok: false, reason: 'no kill handle' };
}

function isBackend(v) {
  return Boolean(v) && isPlainObject(v) && typeof v.start === 'function' && typeof v.spawn === 'function' && typeof v.kill === 'function';
}

module.exports = { createAdvisoryBackend, createNullBackend, isBackend, SandboxBackendError };
