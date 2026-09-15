// ResearchPlanner: classification + strategy + queries, as one reviewable plan.
//
// The plan is produced before any provider is called and is written into the
// trace, so "why did this research do what it did?" is answerable from the
// record rather than reconstructed from what happened. A replan (§39) produces
// a *new* plan with a `parentPlanId`, never an edit of the old one — an audit
// trail that can be rewritten is not one.

const crypto = require('node:crypto');
const { classify } = require('./queryClassifier');
const { buildStrategy } = require('./researchStrategy');
const { planQueries, planVerificationQueries, expandWithProvider } = require('./queryPlanner');
const { queryView } = require('../schemas/researchQuery');

function newPlanId() {
  return `rpl-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

class ResearchPlanner {
  constructor({ provider = null, logger = null, refineClassification = null } = {}) {
    this._provider = provider;
    this._logger = logger;
    this._refine = refineClassification;
  }

  // The first plan for a task. `capabilities`/`available` come from the
  // SourceManager, so the plan is shaped by what this install can actually do.
  async plan({ task, capabilities = [], available = null, signal = null }) {
    const classification = classify(task.question, { task, refine: this._refine });

    // The classifier's mode suggestion applies only when the caller did not
    // choose one. `modeExplicit` is set by the engine from the caller's input.
    if (!task.modeExplicit && classification.suggestedMode && classification.suggestedMode !== task.mode) {
      applyMode(task, classification.suggestedMode);
    }

    const strategy = buildStrategy({ task, classification, capabilities, available });
    let queries = classification.needsResearch
      ? planQueries({ task, classification, available: strategy.sourceTypes })
      : [];

    // Model expansion is additive, optional, and never blocks: a provider that
    // errors or hangs leaves the deterministic plan exactly as it was.
    if (strategy.stages.decompose && this._provider && queries.length < task.limits.maxQueries) {
      const extra = await expandWithProvider({
        task, classification, existing: queries, provider: this._provider,
        available: strategy.sourceTypes,
        limit: Math.min(4, task.limits.maxQueries - queries.length),
      }).catch(() => []);
      if (!signal || !signal.aborted) queries = queries.concat(extra);
    }

    return this._assemble({ task, classification, strategy, queries, reason: 'initial plan', parentPlanId: null });
  }

  // Round two, driven by the evaluator or the reviewer (§39). Takes the gaps
  // that were found and asks only about those — a replan that re-ran the
  // original plan would spend the same budget to learn the same things.
  replan({ task, gaps = [], available = null, capabilities = [] }) {
    const classification = task.classification || classify(task.question, { task });
    const strategy = buildStrategy({ task, classification, capabilities, available });

    const queries = [];
    const budget = Math.max(0, task.limits.maxQueries - task.usage.queries);
    for (const gap of gaps) {
      if (queries.length >= budget) break;
      if (gap.claim) {
        queries.push(...planVerificationQueries({
          task,
          claim: gap.claim,
          usedSourceTypes: gap.usedSourceTypes || [],
          available: strategy.sourceTypes,
          limit: Math.min(2, budget - queries.length),
        }));
      } else if (gap.query) {
        queries.push(...planQueries({
          task,
          classification: { ...classification, suggestedQueries: Math.min(2, budget - queries.length) },
          available: strategy.sourceTypes,
          limit: Math.min(2, budget - queries.length),
        }));
      }
    }

    // Drop anything already searched. A replan must not resubmit a query the
    // first round already spent budget on.
    const already = new Set(task.queries.map((q) => q.key));
    const fresh = queries.filter((q) => !already.has(q.key));

    return this._assemble({
      task, classification, strategy, queries: fresh,
      reason: gaps.length ? `replan for ${gaps.length} gap(s)` : 'replan',
      parentPlanId: task.plan ? task.plan.id : null,
      gaps: gaps.map((g) => ({ kind: g.claim ? 'claim' : 'coverage', detail: g.reason || '' })),
    });
  }

  _assemble({ task, classification, strategy, queries, reason, parentPlanId, gaps = [] }) {
    const plan = Object.freeze({
      id: newPlanId(),
      parentPlanId,
      taskId: task.id,
      reason,
      createdAt: Date.now(),
      classification,
      strategy,
      queries: Object.freeze(queries.map(queryView)),
      gaps: Object.freeze(gaps),
      // What a reader needs to judge the plan without reading the code.
      summary: {
        category: classification.category,
        mode: strategy.mode,
        queryCount: queries.length,
        sourceTypes: [...strategy.sourceTypes],
        unavailableSourceTypes: [...strategy.unavailableSourceTypes],
        degraded: strategy.degraded,
        needsVerification: strategy.requireVerification,
        needsCitations: strategy.requireCitations,
      },
    });
    // The live query objects go on the task (they are mutated as they run); the
    // plan keeps immutable views of them.
    return { plan, queries };
  }
}

// Re-derive the mode-dependent limits when the classifier picks a different
// mode than the task was created with. Caller-supplied explicit limits are
// preserved — the mode changes the defaults, never an instruction.
function applyMode(task, mode) {
  const { MODE_DEFAULTS } = require('../schemas/researchTask');
  const defaults = MODE_DEFAULTS[mode];
  if (!defaults) return task;
  const explicit = task.explicitLimits || {};
  task.mode = mode;
  task.depth = mode;
  task.settings = defaults;
  task.limits = Object.freeze({
    ...task.limits,
    maxQueries: explicit.maxQueries ?? defaults.maxQueries,
    maxSources: explicit.maxSources ?? defaults.maxSources,
    maxConcurrency: explicit.maxConcurrency ?? defaults.maxConcurrency,
    maxToolCalls: explicit.maxToolCalls ?? defaults.maxToolCalls,
    timeoutMs: explicit.timeoutMs ?? defaults.timeoutMs,
  });
  return task;
}

module.exports = { ResearchPlanner, applyMode, newPlanId };
