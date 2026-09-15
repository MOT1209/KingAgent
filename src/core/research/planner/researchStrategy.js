// Research strategy (§24, §40): how hard to work, translated into the concrete
// knobs the pipeline reads.
//
// The three modes are the user-facing vocabulary. This module turns a mode plus
// a classification plus what the install can actually do into a strategy object
// — and, importantly, *downgrades* it where reality does not support the
// ambition. A "deep" task on an install with one web provider and no fetch
// capability cannot do cross-verification against primary sources, and saying
// so up front is better than producing a deep-labelled report with shallow
// evidence.

const { RESEARCH_MODES, MODE_DEFAULTS } = require('../schemas/researchTask');
const { SOURCE_TYPES } = require('../schemas/source');
const { CATEGORY } = require('./queryClassifier');

// Which stages run, per mode. `false` here is a stage that is skipped entirely,
// not one that runs and returns nothing — the difference shows up in the
// quality report, which must not credit a task for a check it never ran.
const STAGES = Object.freeze({
  quick: Object.freeze({
    decompose: false, parallel: true, deduplicate: true, rerank: false,
    extractEvidence: true, analyzeClaims: false, verify: false,
    crossVerify: false, detectConflicts: false, validateCitations: true,
    evaluate: true, review: false,
  }),
  standard: Object.freeze({
    decompose: true, parallel: true, deduplicate: true, rerank: true,
    extractEvidence: true, analyzeClaims: true, verify: true,
    crossVerify: false, detectConflicts: true, validateCitations: true,
    evaluate: true, review: false,
  }),
  deep: Object.freeze({
    decompose: true, parallel: true, deduplicate: true, rerank: true,
    extractEvidence: true, analyzeClaims: true, verify: true,
    crossVerify: true, detectConflicts: true, validateCitations: true,
    evaluate: true, review: true,
  }),
});

// The quality bar a mode is expected to clear. The evaluator compares against
// these; a task that misses its own bar is reported as such rather than being
// quietly graded on a curve.
const TARGETS = Object.freeze({
  quick: Object.freeze({ minSources: 1, minIndependentSources: 1, minConfidence: 0.35, minCoverage: 0.4, minDistinctDomains: 1 }),
  standard: Object.freeze({ minSources: 3, minIndependentSources: 2, minConfidence: 0.55, minCoverage: 0.6, minDistinctDomains: 2 }),
  deep: Object.freeze({ minSources: 8, minIndependentSources: 3, minConfidence: 0.7, minCoverage: 0.75, minDistinctDomains: 4 }),
});

// Pick the mode, when the caller did not. The classifier's suggestion is the
// starting point; an explicit mode on the task always wins.
function chooseMode({ task, classification }) {
  if (task && task.mode && task.modeExplicit) return task.mode;
  if (classification && classification.suggestedMode) return classification.suggestedMode;
  return RESEARCH_MODES.STANDARD;
}

// Build the strategy, then reconcile it with what the install can serve.
//
// `capabilities` is SourceManager.capabilities() — the adapters and whether
// anything is behind them.
function buildStrategy({ task, classification, capabilities = [], available = null }) {
  const mode = task.mode;
  const defaults = MODE_DEFAULTS[mode];
  const stages = { ...STAGES[mode] };
  const targets = { ...TARGETS[mode] };
  const downgrades = [];

  const usable = new Set(
    available && available.length
      ? available
      : capabilities.filter((c) => c.available).map((c) => c.type),
  );
  const suggested = classification ? classification.sourceTypes : [];
  let wanted = suggested.filter((t) => usable.has(t));
  const unavailable = suggested.filter((t) => !usable.has(t));

  // Reconcile ambition with reality.
  if (wanted.length === 0 && usable.size > 0) {
    // The classifier's suggestion and what this task can reach do not overlap.
    // That is not a dead end: a task that explicitly asked for a source type
    // (sourcePreferences, filesOnly) or an install that only has one has *told*
    // us where to look, and refusing because the classifier would have
    // preferred the open web would be obeying a guess over an instruction.
    wanted = [...usable];
    downgrades.push({
      what: 'sourceTypes',
      why: `the question suggests ${suggested.join(', ') || 'no particular source'}, which this task cannot reach; using ${wanted.join(', ')} instead`,
    });
  } else if (wanted.length === 0) {
    downgrades.push({
      what: 'sources',
      why: unavailable.length
        ? `none of the source types this question needs (${unavailable.join(', ')}) has a configured provider`
        : 'no source type is available for this task',
    });
  }
  if (wanted.length < 2) {
    if (stages.crossVerify) {
      stages.crossVerify = false;
      downgrades.push({ what: 'crossVerify', why: 'cross-verification needs at least two independent source types' });
    }
    if (targets.minDistinctDomains > 1) {
      targets.minDistinctDomains = 1;
      downgrades.push({ what: 'minDistinctDomains', why: 'only one source type is available' });
    }
  }
  // File-only research has no second opinion to fetch; conflict detection still
  // runs (two documents can disagree), but cross-verification cannot.
  if (task.filesOnly && stages.crossVerify) {
    stages.crossVerify = false;
    downgrades.push({ what: 'crossVerify', why: 'this task is restricted to its files; there is nothing external to cross-check against' });
  }

  const freshness = classification ? classification.freshness : 'moderate';

  return Object.freeze({
    mode,
    stages: Object.freeze(stages),
    targets: Object.freeze(targets),
    sourceTypes: Object.freeze(wanted),
    unavailableSourceTypes: Object.freeze(unavailable),
    // Ordered best-first, so a budget that runs out cuts the least valuable
    // source type rather than an arbitrary one.
    sourceOrder: Object.freeze(orderSources(wanted, classification)),
    concurrency: Math.max(1, Math.min(task.limits.maxConcurrency, defaults.maxConcurrency)),
    freshness,
    // Per-provider timeout. Sized under the task's own deadline so a slow
    // source cannot consume the whole window (§46).
    sourceTimeoutMs: Math.max(3_000, Math.floor(task.limits.timeoutMs / 4)),
    requireCitations: task.requireCitations,
    requireVerification: task.requireVerification && stages.verify,
    downgrades: Object.freeze(downgrades),
    degraded: downgrades.length > 0,
  });
}

// Which source type is worth reaching for first, given what is being asked.
// Primary-source preference (§11) is the rule: for a documentation question the
// docs go first, for a repository question the repository does.
function orderSources(types, classification) {
  const category = classification ? classification.category : null;
  const preference = {
    [CATEGORY.DOCUMENTATION]: [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB, SOURCE_TYPES.WEB, SOURCE_TYPES.DISCUSSION],
    [CATEGORY.GITHUB_RESEARCH]: [SOURCE_TYPES.GITHUB, SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.WEB, SOURCE_TYPES.DISCUSSION],
    [CATEGORY.ACADEMIC_RESEARCH]: [SOURCE_TYPES.ACADEMIC, SOURCE_TYPES.WEB, SOURCE_TYPES.DOCUMENTATION],
    [CATEGORY.NEWS]: [SOURCE_TYPES.NEWS, SOURCE_TYPES.WEB],
    [CATEGORY.CURRENT_INFORMATION]: [SOURCE_TYPES.NEWS, SOURCE_TYPES.WEB, SOURCE_TYPES.DOCUMENTATION],
    [CATEGORY.FILE_RESEARCH]: [SOURCE_TYPES.FILE, SOURCE_TYPES.LOCAL],
    [CATEGORY.CODEBASE_RESEARCH]: [SOURCE_TYPES.FILE, SOURCE_TYPES.LOCAL, SOURCE_TYPES.GITHUB],
  }[category] || [
    SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB, SOURCE_TYPES.ACADEMIC,
    SOURCE_TYPES.FILE, SOURCE_TYPES.WEB, SOURCE_TYPES.NEWS,
    SOURCE_TYPES.MCP, SOURCE_TYPES.DISCUSSION, SOURCE_TYPES.LOCAL,
  ];
  const rank = new Map(preference.map((t, i) => [t, i]));
  return [...types].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
}

module.exports = { STAGES, TARGETS, buildStrategy, chooseMode, orderSources };
