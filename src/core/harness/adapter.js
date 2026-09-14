// The harness adapter: one normalized interface over every execution backend.
//
//   { id, capabilities, detect(), install(), start(), stop(), pause(),
//     resume(), send(), status(), dispose() }
//
// The hard rule this file enforces: **core never spawns a process**. A harness
// adapter is a shell around host-injected callbacks — `probe` to look for a
// binary, `installer` to obtain one, `transport` to actually talk to a running
// backend. In the Electron main process those callbacks wrap node-pty and the
// existing terminal (src/main/platform-shell.js); in tests they are fakes. That
// is what keeps the whole harness layer unit-testable and keeps this fork's
// terminal architecture untouched.
//
// And the second rule: not every harness supports every operation. Each method
// asks the manifest whether the operation is even claimed before it calls the
// transport, so an unsupported `pause()` is a typed, explainable refusal rather
// than a mysterious crash in a child process.

const { validateManifest, manifestView } = require('./manifest');
const { HarnessLifecycle, HARNESS_STATES, canTransition } = require('./lifecycle');
const { satisfies } = require('./capabilities');
const { TYPES } = require('../events/event-bus');
const { isPlainObject, isString } = require('../schema/validate');

class HarnessError extends Error {
  constructor(message, { code = 'HARNESS_FAILURE', harnessId = null, cause = null } = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.harnessId = harnessId;
    this.cause = cause;
  }
}

// The operation is real but this backend does not claim it.
class HarnessCapabilityError extends HarnessError {
  constructor(operation, harnessId) {
    super(`harness "${harnessId}" does not support ${operation}`, { code: 'HARNESS_UNSUPPORTED_OPERATION', harnessId });
    this.name = 'HarnessCapabilityError';
    this.operation = operation;
  }
}

// The backend claims the operation but the host wired no implementation.
class HarnessNotWiredError extends HarnessError {
  constructor(operation, harnessId) {
    super(`harness "${harnessId}" cannot ${operation}: no host adapter was wired`, { code: 'HARNESS_NOT_WIRED', harnessId });
    this.name = 'HarnessNotWiredError';
    this.operation = operation;
  }
}

// Which capability tag (if any) an operation depends on.
const OPERATION_TAGS = Object.freeze({
  pause: 'pause',
  resume: 'pause',
  send: 'streaming',
});

function createHarness(inputManifest, { transport = null, probe = null, installer = null, bus = null, logger = null, now = () => Date.now() } = {}) {
  const { ok, manifest, errors } = validateManifest(inputManifest);
  if (!ok) throw new HarnessError(`invalid harness manifest: ${errors.join('; ')}`, { code: 'HARNESS_INVALID_MANIFEST' });

  const lifecycle = new HarnessLifecycle({ initial: HARNESS_STATES.REGISTERED });
  const rx = normalizeTransport(transport);
  const state = {
    startedAt: null,
    stoppedAt: null,
    lastError: null,
    runs: 0,
    detail: null,
  };

  function emit(type, payload) {
    if (!bus) return;
    bus.emit(type, { harnessId: manifest.id }, payload);
  }

  function claims(tag) {
    return !tag || manifest.capabilities.tags.includes(tag);
  }

  function requireTransport(operation) {
    const tag = OPERATION_TAGS[operation];
    if (!claims(tag)) throw new HarnessCapabilityError(operation, manifest.id);
    const fn = rx[operation];
    if (typeof fn !== 'function') throw new HarnessNotWiredError(operation, manifest.id);
    return fn;
  }

  async function detect() {
    let verdict;
    if (typeof probe !== 'function') {
      // No probe is deliberately *not* a failure: an in-process or test harness
      // is present by definition. Anything that needs a real binary reports
      // honestly that this host could not look for it — and the lifecycle says
      // `installable`, so the UI never shows an absent backend as ready.
      verdict = manifest.type === 'in-process'
        ? { installed: true, version: manifest.version, path: null, reason: 'in-process harness' }
        : { installed: false, version: null, path: null, reason: 'host did not provide a detection probe' };
    } else {
      try {
        verdict = await probe({ id: manifest.id, type: manifest.type, command: manifest.command, detect: manifest.detect });
      } catch (err) {
        verdict = { installed: false, version: null, path: null, reason: `detection failed: ${err.message}` };
      }
    }
    const found = Boolean(verdict && verdict.installed);
    state.detail = verdict || null;
    if (lifecycle.can(found ? HARNESS_STATES.DETECTED : HARNESS_STATES.INSTALLABLE)) {
      lifecycle.go(found ? HARNESS_STATES.DETECTED : HARNESS_STATES.INSTALLABLE, 'detect');
    }
    return { installed: found, version: (verdict && verdict.version) || null, path: (verdict && verdict.path) || null, reason: (verdict && verdict.reason) || null };
  }

  async function install() {
    if (typeof installer !== 'function') {
      throw new HarnessNotWiredError('install', manifest.id);
    }
    // Installation changes the machine, so it is the host's decision and the
    // host's approval flow. The adapter only reports the outcome.
    const result = await installer({ manifest: manifestView(manifest), platform: currentPlatform() });
    if (result && result.ok) {
      if (lifecycle.can(HARNESS_STATES.DETECTED)) lifecycle.go(HARNESS_STATES.DETECTED, 'installed');
    }
    return result || { ok: false, reason: 'installer returned nothing' };
  }

  async function start(ctx = {}) {
    const run = requireTransport('start');
    if (!isPlainObject(ctx)) throw new HarnessError('start requires a context object', { code: 'HARNESS_INVALID_CONTEXT', harnessId: manifest.id });
    if (!canTransition(lifecycle.state, HARNESS_STATES.STARTING)) {
      throw new HarnessError(`cannot start harness "${manifest.id}" from state ${lifecycle.state}`, { code: 'HARNESS_BAD_STATE', harnessId: manifest.id });
    }
    lifecycle.go(HARNESS_STATES.STARTING, 'start');
    state.lastError = null;
    try {
      const detail = await run({ ...ctx, manifest: manifestView(manifest) });
      state.startedAt = now();
      state.runs += 1;
      state.detail = detail || null;
      lifecycle.go(HARNESS_STATES.RUNNING, 'started');
      emit(TYPES.HARNESS_STARTED, {
        taskId: ctx.taskId || null,
        sessionId: ctx.sessionId || null,
        sandboxId: ctx.sandboxId || null,
        workspaceId: ctx.workspaceId || null,
      }, { detail: summarizeDetail(detail) });
      return status();
    } catch (err) {
      state.lastError = err.message;
      state.detail = { error: err.message };
      if (lifecycle.can(HARNESS_STATES.FAILED)) lifecycle.go(HARNESS_STATES.FAILED, 'start failed');
      emit(TYPES.HARNESS_FAILED, { taskId: ctx.taskId || null, sessionId: ctx.sessionId || null }, { operation: 'start', error: err.message });
      if (logger) logger.warn(`harness ${manifest.id} failed to start`, { error: err.message });
      throw new HarnessError(`harness "${manifest.id}" failed to start: ${err.message}`, { code: 'HARNESS_START_FAILED', harnessId: manifest.id, cause: err });
    }
  }

  async function stop(reason = 'requested') {
    if (lifecycle.terminal) return status();
    if (!canTransition(lifecycle.state, HARNESS_STATES.STOPPING)) {
      // Stopping something that never started is a no-op, not an error: a
      // coordinator cleaning up a task must not have to know.
      if ([HARNESS_STATES.REGISTERED, HARNESS_STATES.DETECTED, HARNESS_STATES.INSTALLABLE, HARNESS_STATES.STOPPED].includes(lifecycle.state)) {
        return status();
      }
      throw new HarnessError(`cannot stop harness "${manifest.id}" from state ${lifecycle.state}`, { code: 'HARNESS_BAD_STATE', harnessId: manifest.id });
    }
    lifecycle.go(HARNESS_STATES.STOPPING, `stop: ${reason}`);
    try {
      if (typeof rx.stop === 'function') await rx.stop({ reason });
      state.stoppedAt = now();
      state.detail = null;
      lifecycle.go(HARNESS_STATES.STOPPED, 'stopped');
      emit(TYPES.HARNESS_STOPPED, {}, { reason });
    } catch (err) {
      state.lastError = err.message;
      if (lifecycle.can(HARNESS_STATES.FAILED)) lifecycle.go(HARNESS_STATES.FAILED, 'stop failed');
      emit(TYPES.HARNESS_FAILED, {}, { operation: 'stop', error: err.message });
      throw new HarnessError(`harness "${manifest.id}" failed to stop: ${err.message}`, { code: 'HARNESS_STOP_FAILED', harnessId: manifest.id, cause: err });
    }
    return status();
  }

  async function pause() {
    const run = requireTransport('pause');
    lifecycle.go(HARNESS_STATES.PAUSED, 'pause');
    try {
      await run({});
      return status();
    } catch (err) {
      if (lifecycle.can(HARNESS_STATES.RUNNING)) lifecycle.go(HARNESS_STATES.RUNNING, 'pause failed');
      throw new HarnessError(`harness "${manifest.id}" failed to pause: ${err.message}`, { code: 'HARNESS_PAUSE_FAILED', harnessId: manifest.id, cause: err });
    }
  }

  async function resume() {
    const run = requireTransport('resume');
    lifecycle.go(HARNESS_STATES.RUNNING, 'resume');
    try {
      await run({});
      return status();
    } catch (err) {
      if (lifecycle.can(HARNESS_STATES.PAUSED)) lifecycle.go(HARNESS_STATES.PAUSED, 'resume failed');
      throw new HarnessError(`harness "${manifest.id}" failed to resume: ${err.message}`, { code: 'HARNESS_RESUME_FAILED', harnessId: manifest.id, cause: err });
    }
  }

  async function send(message) {
    const run = requireTransport('send');
    if (!isPlainObject(message) || !isString(message.type)) {
      // Structured envelope only. §28: hidden prompt concatenation is not the
      // communication protocol, so a bare string is refused here rather than
      // being wrapped into one.
      throw new HarnessError('send requires a structured message with a type', { code: 'HARNESS_INVALID_MESSAGE', harnessId: manifest.id });
    }
    return run(message);
  }

  function status() {
    return {
      id: manifest.id,
      name: manifest.name,
      type: manifest.type,
      platform: currentPlatform(),
      state: lifecycle.state,
      running: lifecycle.state === HARNESS_STATES.RUNNING,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      runs: state.runs,
      lastError: state.lastError,
      capabilities: [...manifest.capabilities.tags],
      detail: summarizeDetail(state.detail),
    };
  }

  async function dispose() {
    if (lifecycle.state === HARNESS_STATES.RUNNING || lifecycle.state === HARNESS_STATES.PAUSED || lifecycle.state === HARNESS_STATES.READY) {
      await stop('dispose');
    }
    if (typeof rx.dispose === 'function') {
      try { await rx.dispose(); } catch (err) { if (logger) logger.warn(`harness ${manifest.id} dispose failed`, { error: err.message }); }
    }
    if (lifecycle.can(HARNESS_STATES.DISPOSED)) lifecycle.go(HARNESS_STATES.DISPOSED, 'dispose');
    return status();
  }

  // Can this harness take on a task that requires these tags, on this machine?
  function compatible({ required = [], platform = currentPlatform() } = {}) {
    const reasons = [];
    if (!manifest.platforms.includes(platform)) reasons.push(`not supported on ${platform}`);
    if (!satisfies(manifest.capabilities, required)) {
      const missing = required.filter((t) => !manifest.capabilities.tags.includes(t));
      reasons.push(`missing capabilities: ${missing.join(', ')}`);
    }
    if (lifecycle.state === HARNESS_STATES.DISPOSED) reasons.push('disposed');
    return { ok: reasons.length === 0, reasons };
  }

  return Object.freeze({
    id: manifest.id,
    name: manifest.name,
    type: manifest.type,
    manifest,
    capabilities: manifest.capabilities,
    platforms: manifest.platforms,
    version: manifest.version,
    command: manifest.command,
    environmentPolicy: manifest.environmentPolicy,
    workspacePolicy: manifest.workspacePolicy,
    supportedModels: manifest.capabilities.models,

    // the normalized interface
    detect,
    install,
    start,
    stop,
    pause,
    resume,
    send,
    status,
    dispose,

    // lifecycle + introspection
    get state() {
      return lifecycle.state;
    },
    get lifecycle() {
      return lifecycle;
    },
    compatible,
    supports: (tag) => manifest.capabilities.tags.includes(tag),
    supportsPlatform: (platform = currentPlatform()) => manifest.platforms.includes(platform),
    spec() {
      return { ...manifestView(manifest), state: lifecycle.state };
    },
    _transport: rx,
  });
}

function normalizeTransport(transport) {
  const t = isPlainObject(transport) ? transport : {};
  const out = {};
  for (const key of ['start', 'stop', 'pause', 'resume', 'send', 'dispose']) {
    if (typeof t[key] === 'function') out[key] = t[key];
  }
  return out;
}

function currentPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

// Never let a transport's return value reach a snapshot verbatim: it may hold
// handles, buffers or environment.
function summarizeDetail(detail) {
  if (!isPlainObject(detail)) return null;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (['string', 'number', 'boolean'].includes(typeof v) || v === null) out[k] = v;
  }
  return out;
}

module.exports = {
  createHarness,
  normalizeTransport,
  currentPlatform,
  HarnessError,
  HarnessCapabilityError,
  HarnessNotWiredError,
  OPERATION_TAGS,
};
