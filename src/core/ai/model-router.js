// ModelRouter: models are infrastructure, not the interface.
//
// A person using KingAgent should be thinking "what do I want my AI organization
// to accomplish", not "which model should I use". So the platform decides: a
// *kind* of work maps to a set of requirements, and the router turns those into a
// concrete provider + model, balancing reasoning, cost, latency, capability and
// privacy.
//
// Two rules match the rest of the core:
//
//   * **No provider is hardcoded.** The registry (ai/provider.js) is the only
//     place a real adapter lives; the router only names ids. Nothing here
//     imports an SDK, and adding a provider later does not touch this file.
//   * **Deterministic by default.** With no providers wired, `route()` still
//     returns a decision with a reason — it never throws and never returns
//     nothing, because every caller (the orchestrator included) must keep
//     working with no AI configured.
//
// The selection is recorded on the run, so "which model did that actually use?"
// is answerable after the fact rather than reconstructed from a config file.

// What a task is *for*. These map from the orchestrator's execution modes and
// from what an agent is about to do, not from a model's name.
const TASK_KINDS = Object.freeze({
  PLANNING: 'planning',
  ARCHITECTURE: 'architecture',
  CODING: 'coding',
  RESEARCH: 'research',
  VISION: 'vision',
  CLASSIFICATION: 'classification',
  REVIEW: 'review',
  SINGLE_AGENT: 'single-agent',
  MULTI_AGENT: 'multi-agent',
  WORKFLOW: 'workflow',
  TOOL: 'tool',
  APPROVAL: 'approval',
  DEFAULT: 'default',
});

const REASONING_LEVELS = Object.freeze(['none', 'low', 'medium', 'high']);

// The default table. Each entry is a *requirement set*, not a model name: the
// router resolves it against whatever providers exist.
const DEFAULT_ROUTES = Object.freeze({
  [TASK_KINDS.PLANNING]: { reasoning: 'high', requires: ['reasoning'], maxTokens: 8_000 },
  [TASK_KINDS.ARCHITECTURE]: { reasoning: 'high', requires: ['reasoning'], maxTokens: 16_000 },
  [TASK_KINDS.CODING]: { reasoning: 'medium', requires: ['tools'], maxTokens: 16_000 },
  [TASK_KINDS.RESEARCH]: { reasoning: 'medium', requires: ['reasoning'], maxTokens: 12_000 },
  [TASK_KINDS.VISION]: { reasoning: 'low', requires: ['vision'], maxTokens: 4_000 },
  [TASK_KINDS.CLASSIFICATION]: { reasoning: 'low', requires: ['fast'], maxTokens: 1_000 },
  [TASK_KINDS.REVIEW]: { reasoning: 'high', requires: ['reasoning'], maxTokens: 8_000 },
  [TASK_KINDS.SINGLE_AGENT]: { reasoning: 'medium', requires: [], maxTokens: 12_000 },
  [TASK_KINDS.MULTI_AGENT]: { reasoning: 'high', requires: ['reasoning'], maxTokens: 16_000 },
  [TASK_KINDS.WORKFLOW]: { reasoning: 'medium', requires: [], maxTokens: 8_000 },
  [TASK_KINDS.TOOL]: { reasoning: 'low', requires: ['fast'], maxTokens: 2_000 },
  [TASK_KINDS.APPROVAL]: { reasoning: 'low', requires: [], maxTokens: 1_000 },
  [TASK_KINDS.DEFAULT]: { reasoning: 'medium', requires: [], maxTokens: 8_000 },
});

const COST_POLICIES = Object.freeze(['balanced', 'cost', 'performance', 'quality']);

function createModelRouter({
  providers = null,       // the provider registry (ai/provider.js)
  catalog = {},           // provider descriptors: id -> { capabilities, models, cost, latencyMs, privacy }
  routes = {},            // overrides merged over DEFAULT_ROUTES
  policy = {},            // { costPolicy, maxCost, maxLatencyMs, privacy, reasoning }
} = {}) {
  const table = { ...DEFAULT_ROUTES, ...routes };
  const settings = {
    costPolicy: COST_POLICIES.includes(policy.costPolicy) ? policy.costPolicy : 'balanced',
    maxCost: Number.isFinite(policy.maxCost) ? policy.maxCost : null,
    maxLatencyMs: Number.isFinite(policy.maxLatencyMs) ? policy.maxLatencyMs : null,
    privacy: policy.privacy || null,
  };
  const descriptors = normalizeCatalog(catalog);

  function kindOf(kind) {
    if (!kind) return TASK_KINDS.DEFAULT;
    const k = String(kind);
    if (k in table) return k;
    if (k in TASK_KINDS) return TASK_KINDS[k];
    return TASK_KINDS.DEFAULT;
  }

  // Decide a provider + model for one piece of work. Always returns an object.
  function route({ kind = null, requirements = {}, complexity = null } = {}) {
    const resolvedKind = kindOf(kind);
    const template = table[resolvedKind] || table[TASK_KINDS.DEFAULT];

    const requires = new Set([...(template.requires || []), ...(requirements.requires || [])]);
    if (requirements.requiresVision) requires.add('vision');
    if (requirements.requiresTools) requires.add('tools');

    let reasoning = template.reasoning || 'medium';
    if (complexity === 'high' && REASONING_LEVELS.indexOf(reasoning) < REASONING_LEVELS.indexOf('high')) reasoning = 'high';
    if (complexity === 'low' && reasoning === 'high') reasoning = 'medium';
    if (settings.reasoning && REASONING_LEVELS.includes(settings.reasoning)) reasoning = settings.reasoning;

    const maxCost = pickNumber(requirements.maxCost, settings.maxCost);
    const maxLatencyMs = pickNumber(requirements.maxLatencyMs, settings.maxLatencyMs);
    const privacy = requirements.privacy || settings.privacy;

    const candidates = descriptors
      .filter((d) => satisfies(d, requires))
      .filter((d) => (maxCost === null ? true : (d.cost ?? 0) <= maxCost))
      .filter((d) => (maxLatencyMs === null ? true : (d.latencyMs ?? 0) <= maxLatencyMs))
      .filter((d) => (privacy ? (d.privacy || 'standard') === privacy : true))
      .sort((a, b) => compare(a, b, settings.costPolicy));

    const chosen = candidates[0] || null;
    const model = chosen
      ? (preferredModel(chosen, requires) || chosen.models[0] || 'default')
      : (template.model || 'default');

    return {
      kind: resolvedKind,
      provider: chosen ? chosen.id : (template.provider || null),
      model,
      reasoning,
      maxTokens: template.maxTokens || 8_000,
      requires: [...requires],
      reason: chosen
        ? `selected ${chosen.id} for ${resolvedKind} (${settings.costPolicy})`
        : describeEmpty(requires, maxCost, maxLatencyMs, privacy, descriptors.length > 0),
      candidates: candidates.map((c) => c.id),
      deterministic: chosen === null,
    };
  }

  // Resolve against the live registry, so a descriptor for a provider that is
  // not actually registered is never selected.
  function isAvailable(id) {
    if (!providers) return true;
    if (typeof providers.get !== 'function') return true;
    const found = providers.get(id);
    return Boolean(found && found.id !== 'null');
  }

  function describe() {
    return {
      kinds: Object.keys(table),
      routes: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, { ...v }])),
      providers: descriptors.map((d) => ({ id: d.id, capabilities: [...d.capabilities], cost: d.cost ?? 0, latencyMs: d.latencyMs ?? 0 })),
      policy: { ...settings },
    };
  }

  return {
    route,
    describe,
    isAvailable,
    kindOf,
    // A human override: pin a kind to a provider/model without rewriting config.
    setRoute(kind, patch) {
      const key = kindOf(kind);
      table[key] = { ...table[key], ...patch };
      return { ...table[key] };
    },
  };
}

function satisfies(descriptor, requires) {
  if (requires.size === 0) return true;
  const has = new Set(descriptor.capabilities);
  for (const need of requires) if (!has.has(need)) return false;
  return true;
}

function preferredModel(descriptor, requires) {
  for (const model of descriptor.modelList) {
    if (requires.size === 0) return model.id;
    const caps = new Set(model.capabilities || []);
    let ok = true;
    for (const need of requires) if (!caps.has(need)) { ok = false; break; }
    if (ok) return model.id;
  }
  return null;
}

function compare(a, b, costPolicy) {
  if (costPolicy === 'performance' || costPolicy === 'quality') {
    return (a.latencyMs ?? 0) - (b.latencyMs ?? 0) || (a.cost ?? 0) - (b.cost ?? 0) || a.id.localeCompare(b.id);
  }
  if (costPolicy === 'cost') {
    return (a.cost ?? 0) - (b.cost ?? 0) || (a.latencyMs ?? 0) - (b.latencyMs ?? 0) || a.id.localeCompare(b.id);
  }
  // balanced: quality first, then cost — a cheaper model that cannot do the job
  // is not cheaper.
  return (b.quality ?? 0) - (a.quality ?? 0) || (a.cost ?? 0) - (b.cost ?? 0) || a.id.localeCompare(b.id);
}

function normalizeCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return [];
  return Object.entries(catalog).map(([id, def]) => {
    const d = def && typeof def === 'object' ? def : {};
    const modelList = Array.isArray(d.models)
      ? d.models.map((m) => (typeof m === 'string' ? { id: m, capabilities: d.capabilities || [] } : m))
      : [];
    return {
      id,
      label: d.label || id,
      capabilities: [...(d.capabilities || [])],
      models: modelList.map((m) => m.id),
      modelList,
      cost: Number.isFinite(d.cost) ? d.cost : 0,
      latencyMs: Number.isFinite(d.latencyMs) ? d.latencyMs : 0,
      quality: Number.isFinite(d.quality) ? d.quality : 0,
      privacy: d.privacy || 'standard',
    };
  });
}

function describeEmpty(requires, maxCost, maxLatencyMs, privacy, hasProviders) {
  // The common, honest case: nothing is configured at all. Listing the
  // requirements would be noise — there was never a candidate to compare them to.
  if (!hasProviders) return 'no provider configured — using deterministic defaults';
  const wanted = [...requires];
  const constraints = [];
  if (wanted.length) constraints.push(`capabilities [${wanted.join(', ')}]`);
  if (maxCost !== null) constraints.push(`cost <= ${maxCost}`);
  if (maxLatencyMs !== null) constraints.push(`latency <= ${maxLatencyMs}ms`);
  if (privacy) constraints.push(`privacy ${privacy}`);
  return constraints.length
    ? `no configured provider satisfies ${constraints.join('; ')} — using deterministic defaults`
    : 'no provider configured — using deterministic defaults';
}

function pickNumber(a, b) {
  if (Number.isFinite(a)) return a;
  if (Number.isFinite(b)) return b;
  return null;
}

module.exports = { createModelRouter, TASK_KINDS, DEFAULT_ROUTES, REASONING_LEVELS, COST_POLICIES };
