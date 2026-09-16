// ResearchTask: the unit of research, and the budget it is allowed to spend.
//
// A research task is a *state machine with a wallet*. The state machine is what
// makes progress reportable and cancellation meaningful; the wallet is what
// stops a "compare every agent framework" request from quietly issuing ninety
// provider calls (§30). Both live on the task itself rather than in the engine,
// so a task can be inspected, persisted and resumed without the engine.
//
// Identity comes from core/workspace/identity.js — the same correlation keys
// every other Phase 3/4 record carries — so a research task joins to its trace,
// workspace and session with no translation layer.

const crypto = require('node:crypto');
const { isPlainObject, isString, nonEmptyString, fail } = require('../../schema/validate');
const { ALL_SOURCE_TYPES, SOURCE_TYPES } = require('./source');
const { ResearchBudgetError } = require('../errors/researchErrors');

const RESEARCH_STATUS = Object.freeze({
  CREATED: 'created',
  PLANNING: 'planning',
  SEARCHING: 'searching',
  RETRIEVING: 'retrieving',
  ANALYZING: 'analyzing',
  VERIFYING: 'verifying',
  SYNTHESIZING: 'synthesizing',
  EVALUATING: 'evaluating',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  RECOVERING: 'recovering',
});

// Which transitions are legal. A status field with no transition table is a
// label; this is what makes "cancelled" actually stick.
const TRANSITIONS = Object.freeze({
  created: ['planning', 'cancelled', 'failed'],
  planning: ['searching', 'synthesizing', 'cancelled', 'failed', 'recovering'],
  searching: ['retrieving', 'analyzing', 'cancelled', 'failed', 'recovering'],
  retrieving: ['analyzing', 'cancelled', 'failed', 'recovering'],
  analyzing: ['verifying', 'synthesizing', 'cancelled', 'failed', 'recovering'],
  verifying: ['synthesizing', 'planning', 'cancelled', 'failed', 'recovering'],
  synthesizing: ['evaluating', 'cancelled', 'failed', 'recovering'],
  evaluating: ['completed', 'planning', 'cancelled', 'failed', 'recovering'],
  // Recovery can re-enter any working phase, which is the point of it (§35).
  recovering: ['planning', 'searching', 'retrieving', 'analyzing', 'verifying', 'synthesizing', 'evaluating', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

const TERMINAL = Object.freeze(['completed', 'failed', 'cancelled']);

const RESEARCH_MODES = Object.freeze({
  QUICK: 'quick',
  STANDARD: 'standard',
  DEEP: 'deep',
});

// §40's three modes, as numbers rather than prose. These are ceilings, not
// targets: a quick task that finds its answer in one query stops at one.
const MODE_DEFAULTS = Object.freeze({
  quick: Object.freeze({
    maxQueries: 3, maxSources: 12, maxConcurrency: 3, maxToolCalls: 12,
    requireVerification: false, requireCitations: true, rerank: false,
    crossVerify: false, detectConflicts: false, review: false, timeoutMs: 30_000,
  }),
  standard: Object.freeze({
    maxQueries: 8, maxSources: 30, maxConcurrency: 4, maxToolCalls: 40,
    requireVerification: true, requireCitations: true, rerank: true,
    crossVerify: false, detectConflicts: true, review: false, timeoutMs: 90_000,
  }),
  deep: Object.freeze({
    maxQueries: 20, maxSources: 80, maxConcurrency: 6, maxToolCalls: 120,
    requireVerification: true, requireCitations: true, rerank: true,
    crossVerify: true, detectConflicts: true, review: true, timeoutMs: 300_000,
  }),
});

function newResearchTaskId() {
  return `res-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function validateResearchTask(def) {
  if (!isPlainObject(def)) return fail(['research task must be an object']);
  if (!nonEmptyString(def.question)) return fail(['research task requires a question']);
  if (def.mode !== undefined && !Object.values(RESEARCH_MODES).includes(def.mode)) {
    return fail([`unknown research mode: ${JSON.stringify(def.mode)}`]);
  }
  if (def.sourcePreferences !== undefined) {
    if (!Array.isArray(def.sourcePreferences)) return fail(['sourcePreferences must be an array']);
    const bad = def.sourcePreferences.find((t) => !ALL_SOURCE_TYPES.includes(t));
    if (bad) return fail([`unknown source type in sourcePreferences: ${JSON.stringify(bad)}`]);
  }
  for (const key of ['allowedDomains', 'excludedDomains']) {
    if (def[key] !== undefined && !Array.isArray(def[key])) return fail([`${key} must be an array`]);
  }
  return { ok: true, task: createResearchTask(def) };
}

function createResearchTask(def = {}) {
  const mode = Object.values(RESEARCH_MODES).includes(def.mode) ? def.mode : RESEARCH_MODES.STANDARD;
  const defaults = MODE_DEFAULTS[mode];
  const limits = Object.freeze({
    maxQueries: posInt(def.maxQueries, defaults.maxQueries),
    maxSources: posInt(def.maxSources, defaults.maxSources),
    maxConcurrency: posInt(def.maxConcurrency, defaults.maxConcurrency),
    maxToolCalls: posInt(def.maxToolCalls, defaults.maxToolCalls),
    maxTokens: posInt(def.maxTokens, 0),      // 0 = not enforced by this layer
    maxCost: typeof def.maxCost === 'number' && def.maxCost > 0 ? def.maxCost : 0,
    timeoutMs: posInt(def.timeoutMs, defaults.timeoutMs),
  });

  const task = {
    id: isString(def.id) && def.id ? def.id : newResearchTaskId(),
    // Correlation. Supplied by the engine from the caller's identity; a research
    // task never mints its own session or trace.
    sessionId: def.sessionId || null,
    agentId: def.agentId || null,
    workspaceId: def.workspaceId || null,
    projectId: def.projectId || null,
    taskId: def.taskId || null,
    traceId: def.traceId || null,

    question: String(def.question).trim().slice(0, 2000),
    objective: isString(def.objective) ? def.objective.slice(0, 1000) : '',
    constraints: isString(def.constraints) ? def.constraints.slice(0, 1000) : '',
    mode,
    depth: mode, // §5 names it `depth`; kept as an alias of mode, not a second knob
    language: isString(def.language) ? def.language.slice(0, 16) : null,

    sourcePreferences: Array.isArray(def.sourcePreferences) && def.sourcePreferences.length
      ? [...new Set(def.sourcePreferences.filter((t) => ALL_SOURCE_TYPES.includes(t)))]
      : [],
    allowedDomains: normalizeDomains(def.allowedDomains),
    excludedDomains: normalizeDomains(def.excludedDomains),
    // §25: "use only these files" is a hard gate, not a preference. When true
    // the router refuses every non-file source regardless of what the classifier
    // would otherwise have chosen.
    filesOnly: def.filesOnly === true,
    files: Array.isArray(def.files) ? def.files.filter(isString).slice(0, 200) : [],
    allowWeb: def.allowWeb !== false && def.filesOnly !== true,

    requireCitations: def.requireCitations === undefined ? defaults.requireCitations : def.requireCitations !== false,
    requireVerification: def.requireVerification === undefined ? defaults.requireVerification : def.requireVerification !== false,
    limits,
    settings: defaults,

    status: RESEARCH_STATUS.CREATED,
    statusReason: '',
    history: [{ status: RESEARCH_STATUS.CREATED, at: Date.now(), reason: 'created' }],

    // Collected as the pipeline runs.
    classification: null,
    plan: null,
    queries: [],
    sources: [],
    claims: [],
    evidence: [],
    citations: [],
    conflicts: [],
    quality: null,
    answer: null,
    review: null,
    // Failures that did not stop the task. A research result with an empty
    // `question` but three entries here is a partial result, and the evaluator
    // and the UI both need to say so rather than presenting it as complete.
    failures: [],

    usage: { queries: 0, sources: 0, toolCalls: 0, providerCalls: 0, tokens: 0, cost: 0, cacheHits: 0 },
    deadline: typeof def.deadline === 'number' ? def.deadline : Date.now() + limits.timeoutMs,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
  };
  return task;
}

function normalizeDomains(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list
    .filter(isString)
    .map((d) => d.trim().toLowerCase().replace(/^\*?\./, '').replace(/^https?:\/\//, '').split('/')[0])
    .filter(Boolean))].slice(0, 500);
}

function posInt(v, fallback) {
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

// --- state machine ----------------------------------------------------------

function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function isTerminal(status) {
  return TERMINAL.includes(status);
}

// Returns the task (mutated) so callers can chain. Throws on an illegal
// transition rather than silently ignoring it: a pipeline that jumped a phase
// is a bug, and swallowing it produces a task whose history lies.
function transition(task, to, reason = '') {
  if (task.status === to) return task;
  if (!canTransition(task.status, to)) {
    const err = new Error(`illegal research transition ${task.status} -> ${to}`);
    err.code = 'RESEARCH_BAD_TRANSITION';
    throw err;
  }
  task.status = to;
  task.statusReason = String(reason).slice(0, 300);
  task.updatedAt = Date.now();
  task.history.push({ status: to, at: task.updatedAt, reason: task.statusReason });
  if (to === RESEARCH_STATUS.PLANNING && !task.startedAt) task.startedAt = Date.now();
  if (isTerminal(to)) task.completedAt = Date.now();
  return task;
}

// --- budget -----------------------------------------------------------------

// `spend` is the only way usage moves. It throws ResearchBudgetError at the
// ceiling rather than returning false, because every call site's correct
// response is the same — stop and summarize — and a boolean invites forgetting.
function spend(task, kind, amount = 1) {
  const capKey = {
    queries: 'maxQueries', sources: 'maxSources', toolCalls: 'maxToolCalls',
    tokens: 'maxTokens', cost: 'maxCost',
  }[kind];
  const cap = capKey ? task.limits[capKey] : 0;
  const next = (task.usage[kind] || 0) + amount;
  // Checked before the increment, so `usage` never reports more than the
  // ceiling allowed. A rejected spend did not happen and must not show up in
  // the report as if it had.
  if (cap > 0 && next > cap) throw new ResearchBudgetError(kind, task.usage[kind] || 0, cap);
  task.usage[kind] = next;
  task.updatedAt = Date.now();
  return task.usage[kind];
}

// How much is left before a ceiling. Used by the planner to size a decomposition
// to what the task can actually afford, rather than planning twenty queries and
// dying on the ninth.
function remaining(task, kind) {
  const capKey = { queries: 'maxQueries', sources: 'maxSources', toolCalls: 'maxToolCalls' }[kind];
  if (!capKey) return Infinity;
  const cap = task.limits[capKey];
  if (!cap) return Infinity;
  return Math.max(0, cap - (task.usage[kind] || 0));
}

function expired(task, now = Date.now()) {
  return typeof task.deadline === 'number' && now > task.deadline;
}

function recordFailure(task, { stage, sourceId = null, queryId = null, reason, code = null, fatal = false }) {
  task.failures.push({
    at: Date.now(), stage, sourceId, queryId,
    reason: String(reason || '').slice(0, 400), code, fatal: Boolean(fatal),
  });
  if (task.failures.length > 200) task.failures.splice(0, task.failures.length - 200);
  task.updatedAt = Date.now();
  return task;
}

// A task is "partial" when it produced an answer but not everything it set out
// to do. The UI and the report both say so; nothing presents a partial result
// as a complete one (§30).
function isPartial(task) {
  return task.failures.some((f) => !f.fatal)
    || task.statusReason.includes('budget')
    || task.statusReason.includes('deadline')
    // A plan is a statement of what the answer needs. A query that was skipped
    // or failed is a piece of that answer nobody got, and a run that spent its
    // whole budget before reaching them produced less than it set out to —
    // which the report has to say rather than presenting the remainder as the
    // complete picture.
    || task.queries.some((q) => q.status === 'failed' || q.status === 'skipped')
    || (task.limits.maxSources > 0 && task.usage.sources >= task.limits.maxSources)
    || (task.limits.maxQueries > 0 && task.usage.queries >= task.limits.maxQueries);
}

function researchTaskView(task) {
  return {
    id: task.id,
    question: task.question,
    objective: task.objective,
    mode: task.mode,
    status: task.status,
    statusReason: task.statusReason,
    partial: isPartial(task),
    filesOnly: task.filesOnly,
    counts: {
      queries: task.queries.length,
      sources: task.sources.length,
      evidence: task.evidence.length,
      claims: task.claims.length,
      citations: task.citations.length,
      conflicts: task.conflicts.length,
      failures: task.failures.length,
    },
    usage: { ...task.usage },
    limits: { ...task.limits },
    quality: task.quality,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
  };
}

module.exports = {
  RESEARCH_STATUS, RESEARCH_MODES, MODE_DEFAULTS, TRANSITIONS, TERMINAL, SOURCE_TYPES,
  newResearchTaskId, validateResearchTask, createResearchTask,
  canTransition, isTerminal, transition, spend, remaining, expired,
  recordFailure, isPartial, researchTaskView, normalizeDomains,
};
