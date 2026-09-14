// HarnessManager: selection + run bookkeeping for the harness layer.
//
// The registry knows what exists; this owns what is *running*. Every start is
// recorded as a run keyed by runId and stamped with the full ownership chain
// from §23 — taskId, workspaceId, agentId, harnessId, traceId, sessionId,
// sandboxId — so any of `stop`, `pause`, `cancel`, `cleanup` and `recovery` can
// find the exact process tree without guessing.
//
// Two boundaries this file holds:
//
//   * Selection is a *decision*, not a search: it asks the registry, it never
//     starts a candidate to find out whether it works.
//   * Environment is granted, not inherited. `resolveEnvironment()` returns the
//     allowlisted subset the host may pass; a harness can never widen it, and a
//     credential value never passes through this module — only a name.

const { currentPlatform, HarnessError } = require('./adapter');
const { TYPES } = require('../events/event-bus');
const { isPlainObject } = require('../schema/validate');

class HarnessManager {
  constructor({ registry, bus = null, logger = null, sandbox = null, policy = null } = {}) {
    if (!registry) throw new Error('HarnessManager requires a HarnessRegistry');
    this._registry = registry;
    this._bus = bus;
    this._logger = logger;
    this._sandbox = sandbox; // optional SandboxManager: process ownership
    this._policy = policy;   // optional PolicyManager: environment/harness grants
    this._runs = new Map();  // runId -> run record
    this._byTask = new Map(); // taskId -> Set<runId>
    this._seq = 0;
  }

  get registry() {
    return this._registry;
  }

  // --- selection ------------------------------------------------------------

  // Ask the registry for a backend, then let policy veto it. Denial is reported
  // as a decision with reasons, never as a silent fallback to a backend the
  // policy would also have refused.
  async select({ agentId = null, capabilities = [], harnessId = null, model = null, platform = currentPlatform(), installedOnly = false, context = {} } = {}) {
    const resolved = this._registry.resolve({ id: harnessId, capabilities, platform, model, installedOnly });
    const reasons = [...resolved.reasons];
    let harness = resolved.harness;
    let allowed = true;

    if (harness && this._policy) {
      const decision = await this._policy.evaluate({
        action: 'harness.select',
        context: { ...context, agentId, harnessId: harness.id, capabilities, platform },
      });
      if (!decision.allowed) {
        allowed = false;
        reasons.push(decision.reason);
        harness = null;
      }
    }

    const decision = {
      harness,
      harnessId: harness ? harness.id : null,
      capabilities,
      platform,
      candidates: resolved.candidates,
      allowed,
      reasons,
    };
    if (this._bus) {
      this._bus.emit(TYPES.HARNESS_SELECTED, { agentId, harnessId: decision.harnessId, taskId: context.taskId || null, sessionId: context.sessionId || null }, {
        allowed,
        candidates: resolved.candidates,
        reasons: reasons.slice(0, 8),
      });
    }
    return decision;
  }

  // --- runs -----------------------------------------------------------------

  // Start a run. `ctx` carries the ownership chain and whatever the host
  // transport needs (cwd, signal). Returns the run record; the caller drives
  // whatever comes next through send()/stop().
  async start({ harnessId, ctx = {} } = {}) {
    const harness = this._registry.get(harnessId);
    if (!harness) throw new HarnessError(`no harness registered with id "${harnessId}"`, { code: 'HARNESS_UNKNOWN', harnessId });

    const env = await this.resolveEnvironment(harness, { granted: ctx.envAllowlist || null });
    if (env.denied.length > 0 && this._logger) {
      this._logger.info(`harness ${harness.id}: environment keys denied`, { denied: env.denied });
    }

    const runId = `run-${(++this._seq).toString(36)}-${Date.now().toString(36)}`;
    const record = {
      runId,
      harnessId: harness.id,
      // the §23 ownership chain
      taskId: ctx.taskId || null,
      workspaceId: ctx.workspaceId || null,
      agentId: ctx.agentId || null,
      traceId: ctx.traceId || null,
      sessionId: ctx.sessionId || null,
      sandboxId: ctx.sandboxId || null,
      delegationId: ctx.delegationId || null,
      startedAt: null,
      stoppedAt: null,
      status: 'starting',
    };

    const status = await harness.start({
      ...ctx,
      env: env.env,
      envMode: env.mode,
      runId,
    });

    record.startedAt = Date.now();
    record.status = 'running';
    this._runs.set(runId, record);
    if (!this._byTask.has(record.taskId)) this._byTask.set(record.taskId, new Set());
    this._byTask.get(record.taskId).add(runId);

    // Process ownership: the harness's backend process belongs to a sandbox, so
    // cleanup can kill the right tree.
    if (this._sandbox && record.sandboxId && typeof this._sandbox.registerProcess === 'function') {
      this._sandbox.registerProcess(record.sandboxId, {
        kind: 'harness',
        harnessId: harness.id,
        runId,
        ownerId: record.agentId || record.taskId,
        stop: () => this.stop(runId, 'sandbox cleanup'),
      });
    }

    // `status` stays the run record's own string; the harness's status object
    // rides along as `harnessStatus` so the two are never confused.
    return { ...record, status: 'running', harnessStatus: status, envMode: env.mode };
  }

  get(runId) {
    return this._runs.get(runId) || null;
  }

  list(filter = {}) {
    let all = [...this._runs.values()];
    if (filter.taskId) all = all.filter((r) => r.taskId === filter.taskId);
    if (filter.harnessId) all = all.filter((r) => r.harnessId === filter.harnessId);
    if (filter.sessionId) all = all.filter((r) => r.sessionId === filter.sessionId);
    return all.map((r) => ({ ...r }));
  }

  runsForTask(taskId) {
    const ids = this._byTask.get(taskId);
    return ids ? [...ids] : [];
  }

  async stop(runId, reason = 'requested') {
    const record = this._runs.get(runId);
    if (!record) return null;
    const harness = this._registry.get(record.harnessId);
    if (harness) {
      try {
        await harness.stop(reason);
      } catch (err) {
        if (this._logger) this._logger.warn(`harness ${record.harnessId} stop failed`, { error: err.message });
      }
    }
    record.status = 'stopped';
    record.stoppedAt = Date.now();
    this._runs.delete(runId);
    const set = this._byTask.get(record.taskId);
    if (set) {
      set.delete(runId);
      if (set.size === 0) this._byTask.delete(record.taskId);
    }
    if (this._sandbox && record.sandboxId && typeof this._sandbox.releaseProcess === 'function') {
      this._sandbox.releaseProcess(record.sandboxId, { runId });
    }
    return { ...record };
  }

  // Cancellation is the coordinator's job to request; this makes sure every run
  // belonging to a task is actually gone before the task is marked cancelled.
  async stopTask(taskId, reason = 'task cancelled') {
    const ids = this.runsForTask(taskId);
    const stopped = [];
    for (const runId of ids) {
      const rec = await this.stop(runId, reason);
      if (rec) stopped.push(rec.runId);
    }
    return stopped;
  }

  async pause(runId) {
    const record = this._runs.get(runId);
    if (!record) throw new HarnessError(`no run "${runId}"`, { code: 'HARNESS_UNKNOWN_RUN' });
    const harness = this._registry.get(record.harnessId);
    if (!harness) throw new HarnessError(`harness "${record.harnessId}" is no longer registered`, { code: 'HARNESS_UNKNOWN', harnessId: record.harnessId });
    const status = await harness.pause();
    record.status = 'paused';
    return status;
  }

  async resume(runId) {
    const record = this._runs.get(runId);
    if (!record) throw new HarnessError(`no run "${runId}"`, { code: 'HARNESS_UNKNOWN_RUN' });
    const harness = this._registry.get(record.harnessId);
    if (!harness) throw new HarnessError(`harness "${record.harnessId}" is no longer registered`, { code: 'HARNESS_UNKNOWN', harnessId: record.harnessId });
    const status = await harness.resume();
    record.status = 'running';
    return status;
  }

  async send(runId, message) {
    const record = this._runs.get(runId);
    if (!record) throw new HarnessError(`no run "${runId}"`, { code: 'HARNESS_UNKNOWN_RUN' });
    const harness = this._registry.get(record.harnessId);
    if (!harness) throw new HarnessError(`harness "${record.harnessId}" is no longer registered`, { code: 'HARNESS_UNKNOWN', harnessId: record.harnessId });
    return harness.send(message);
  }

  // The per-run view the control center shows: harness, model, state, ownership.
  controlView(filter = {}) {
    return this.list(filter).map((r) => {
      const harness = this._registry.get(r.harnessId);
      return {
        runId: r.runId,
        harnessId: r.harnessId,
        harnessName: harness ? harness.name : r.harnessId,
        state: r.status,
        taskId: r.taskId,
        sessionId: r.sessionId,
        agentId: r.agentId,
        sandboxId: r.sandboxId,
        startedAt: r.startedAt,
      };
    });
  }

  // --- environment ----------------------------------------------------------

  // What environment may this harness see? `minimal` (the default) grants
  // nothing beyond the platform minimum, `inherit` is an explicit host opt-in,
  // `allowlist` grants exactly the manifest's named keys from a host-supplied
  // source. Secret-named variables are recorded as `secrets` *names* and are
  // never read or returned here — the host injects values, if policy allows.
  async resolveEnvironment(harness, { granted = null, hostEnv = process.env } = {}) {
    const mode = harness.environmentPolicy.mode;
    const allowlist = harness.environmentPolicy.allowlist;
    const env = {};
    const denied = [];

    const source = isPlainObject(granted) ? granted : null;
    const keys = mode === 'inherit' ? Object.keys(hostEnv)
      : mode === 'allowlist' ? allowlist
        : [];

    for (const key of keys) {
      if (source && key in source) { env[key] = String(source[key]); continue; }
      if (mode === 'inherit' && key in hostEnv) { env[key] = String(hostEnv[key]); continue; }
      denied.push(key);
    }

    // A policy grant can widen the list, but only by name, and only if the
    // policy engine says so — a harness (or an agent) cannot do it itself.
    const secrets = [];
    if (this._policy && harness.manifest.secretEnv.length > 0) {
      for (const name of harness.manifest.secretEnv) {
        const decision = await this._policy.evaluate({ action: `credential.${name}`, context: { harnessId: harness.id } });
        if (decision.allowed) secrets.push(name);
        else denied.push(name);
      }
    }

    return { env, mode, denied, secrets };
  }

  async dispose() {
    for (const runId of [...this._runs.keys()]) {
      await this.stop(runId, 'shutdown').catch(() => {});
    }
  }
}

module.exports = { HarnessManager };
