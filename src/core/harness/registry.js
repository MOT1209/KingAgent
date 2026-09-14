// HarnessRegistry: the execution backends this install knows about.
//
// Deliberately a *sibling* of AgentRegistry, not a replacement or a merge. The
// two answer different questions and the whole Agent → Harness → Model chain
// depends on keeping them separate:
//
//   AgentRegistry   — who is working (identity, persona, capabilities, model
//                     binding). Owned by the runtime; unchanged by Phase 4.
//   HarnessRegistry — what can execute work (backend, platform, lifecycle).
//
// A registry does not run anything. `detect()` asks each adapter to look for
// itself through its injected probe; `resolve()` answers "which backend could
// take this job" deterministically, so the router can be explained after the
// fact. Starting, stopping and streaming belong to HarnessManager.

const { createHarness, currentPlatform } = require('./adapter');
const { PLATFORMS } = require('./manifest');
const { isPlainObject, isString } = require('../schema/validate');

class HarnessRegistry {
  constructor({ bus = null, logger = null, probe = null, installer = null, transports = {} } = {}) {
    this._harnesses = new Map(); // id -> adapter
    this._bus = bus;
    this._logger = logger;
    // Host injection points, shared by every harness registered from a manifest.
    // Per-harness overrides are allowed at register() time.
    this._probe = probe;
    this._installer = installer;
    this._transports = isPlainObject(transports) ? { ...transports } : {};
    this._detected = new Map(); // id -> verdict
  }

  // Accepts either a manifest (which gets wrapped in a fresh adapter) or an
  // object that already implements the adapter interface.
  register(spec, opts = {}) {
    const harness = isHarness(spec)
      ? spec
      : createHarness(spec, {
        transport: opts.transport || this._transports[spec && spec.id] || null,
        probe: opts.probe || this._probe,
        installer: opts.installer || this._installer,
        bus: this._bus,
        logger: this._logger,
      });
    if (!isString(harness.id) || !harness.id) throw new Error('harness must have an id');
    if (this._harnesses.has(harness.id)) throw new Error(`harness "${harness.id}" is already registered`);
    this._harnesses.set(harness.id, harness);
    return harness;
  }

  unregister(id) {
    return this._harnesses.delete(id);
  }

  get(id) {
    return this._harnesses.get(id) || null;
  }

  has(id) {
    return this._harnesses.has(id);
  }

  count() {
    return this._harnesses.size;
  }

  // Serializable specs for the UI. Filters never mutate the registry.
  list({ capability = null, platform = null, type = null } = {}) {
    let all = [...this._harnesses.values()];
    if (capability) all = all.filter((h) => h.supports(capability));
    if (platform) all = all.filter((h) => h.supportsPlatform(platform));
    if (type) all = all.filter((h) => h.type === type);
    return all.map((h) => h.spec()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  ids() {
    return [...this._harnesses.keys()].sort();
  }

  // Probe one harness or all of them. Results are cached per id because probing
  // means shelling out on the host; `refresh` forces a re-probe.
  async detect({ id = null, platform = currentPlatform(), refresh = false } = {}) {
    const targets = id ? [this.get(id)].filter(Boolean) : [...this._harnesses.values()];
    const out = {};
    for (const harness of targets) {
      if (!refresh && this._detected.has(harness.id)) {
        out[harness.id] = this._detected.get(harness.id);
        continue;
      }
      const verdict = await harness.detect({ platform });
      const record = { ...verdict, platform, at: Date.now() };
      this._detected.set(harness.id, record);
      out[harness.id] = record;
    }
    return out;
  }

  detected(id) {
    return this._detected.get(id) || null;
  }

  // Which harness should take this job? Deterministic and explainable:
  //
  //   1. drop anything that cannot run here (platform, lifecycle) or cannot do
  //      the work (required capability tags)
  //   2. drop anything whose declared model list excludes a required model
  //   3. break ties by *fewest surplus capabilities* (the most specific backend
  //      that can still do the job), then by id — never by registration order,
  //      so two identical registries resolve identically
  //
  // Returns the chosen harness plus the alternatives and the reasons, so the
  // router can say why and the UI can show what else was available.
  resolve({ id = null, capabilities = [], platform = currentPlatform(), model = null, type = null, installedOnly = false } = {}) {
    if (id) {
      const exact = this.get(id);
      if (!exact) return { harness: null, candidates: [], reasons: [`no harness registered with id "${id}"`] };
      const verdict = exact.compatible({ required: capabilities, platform });
      return { harness: exact, candidates: [exact.id], reasons: verdict.ok ? [] : verdict.reasons };
    }

    const rejected = [];
    const candidates = [...this._harnesses.values()].filter((h) => {
      const verdict = h.compatible({ required: capabilities, platform });
      if (!verdict.ok) { rejected.push({ id: h.id, reasons: verdict.reasons }); return false; }
      if (type && h.type !== type) { rejected.push({ id: h.id, reasons: [`type is ${h.type}, wanted ${type}`] }); return false; }
      if (model && h.supportedModels.length > 0 && !h.supportedModels.includes(model)) {
        rejected.push({ id: h.id, reasons: [`does not declare model "${model}"`] });
        return false;
      }
      if (installedOnly) {
        const seen = this._detected.get(h.id);
        if (seen && seen.installed === false) { rejected.push({ id: h.id, reasons: [seen.reason || 'not installed'] }); return false; }
      }
      return true;
    });

    const scored = candidates
      .map((h) => ({ harness: h, surplus: surplusCount(h, capabilities) }))
      .sort((a, b) => (a.surplus - b.surplus) || (a.harness.id < b.harness.id ? -1 : 1));

    if (scored.length === 0) {
      return { harness: null, candidates: [], reasons: rejected.map((r) => `${r.id}: ${r.reasons.join('; ')}`), rejected };
    }
    return {
      harness: scored[0].harness,
      candidates: scored.map((s) => s.harness.id),
      reasons: [],
      rejected,
    };
  }

  async disposeAll() {
    for (const harness of [...this._harnesses.values()]) {
      try { await harness.dispose(); } catch (_) { /* best effort on shutdown */ }
    }
    this._harnesses.clear();
    this._detected.clear();
  }
}

function isHarness(v) {
  return Boolean(v) && isString(v.id) && typeof v.detect === 'function' && typeof v.start === 'function' && typeof v.status === 'function';
}

function surplusCount(harness, required) {
  return Math.max(0, harness.capabilities.tags.length - required.length);
}

function isKnownPlatform(p) {
  return PLATFORMS.includes(p);
}

module.exports = { HarnessRegistry, isHarness, isKnownPlatform };
