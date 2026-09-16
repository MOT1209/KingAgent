// ResearchQuery: one search the engine intends to run, against named sources.
//
// A query is planned before it is executed, and the plan is the audit trail:
// "why did we search that?" is answered by `rationale` and `parentQueryId`,
// not reconstructed from logs.

const crypto = require('node:crypto');
const { isString } = require('../../schema/validate');
const { ALL_SOURCE_TYPES, SOURCE_TYPES } = require('./source');

const QUERY_STATUS = Object.freeze({
  PLANNED: 'planned',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
});

// What a query is *for*. The router reads this alongside the classification to
// pick sources, and the evaluator reads it to check coverage (§37): a task whose
// `verification` queries all failed has not been verified, however many
// `discovery` queries succeeded.
const QUERY_INTENT = Object.freeze({
  DISCOVERY: 'discovery',       // find out what exists
  DEFINITION: 'definition',     // what is X
  COMPARISON: 'comparison',     // X vs Y
  EVIDENCE: 'evidence',         // find support for a specific claim
  VERIFICATION: 'verification', // cross-check a claim against another source
  RECENCY: 'recency',           // what changed / what is current
});

const MAX_QUERY_CHARS = 400;

function newQueryId() {
  return `rq-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// Two queries that differ only by word order, case or punctuation are the same
// search. The planner uses this to drop redundant decompositions (§7) before
// any of them costs a provider call.
function queryKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function normalizeQuery(def = {}) {
  const text = String(def.text).trim().slice(0, MAX_QUERY_CHARS);
  return {
    id: isString(def.id) && def.id ? def.id : newQueryId(),
    text,
    key: queryKey(text),
    intent: Object.values(QUERY_INTENT).includes(def.intent) ? def.intent : QUERY_INTENT.DISCOVERY,
    sourceTypes: Array.isArray(def.sourceTypes) && def.sourceTypes.length
      ? [...new Set(def.sourceTypes.filter((t) => ALL_SOURCE_TYPES.includes(t)))]
      : [SOURCE_TYPES.WEB],
    rationale: isString(def.rationale) ? def.rationale.slice(0, 300) : '',
    parentQueryId: isString(def.parentQueryId) ? def.parentQueryId : null,
    claimId: isString(def.claimId) ? def.claimId : null,
    priority: typeof def.priority === 'number' && Number.isFinite(def.priority) ? def.priority : 0.5,
    maxResults: Number.isInteger(def.maxResults) && def.maxResults > 0 ? Math.min(def.maxResults, 50) : 10,
    // Mutable execution record. A query is planned once and then annotated;
    // the identity fields above never change.
    status: QUERY_STATUS.PLANNED,
    startedAt: null,
    completedAt: null,
    resultCount: 0,
    errors: [],
  };
}

function queryView(query) {
  return {
    id: query.id,
    text: query.text,
    intent: query.intent,
    sourceTypes: [...query.sourceTypes],
    rationale: query.rationale,
    status: query.status,
    resultCount: query.resultCount,
    errors: query.errors.map((e) => ({ sourceId: e.sourceId, reason: e.reason, code: e.code || null })),
  };
}

module.exports = {
  QUERY_STATUS, QUERY_INTENT, MAX_QUERY_CHARS,
  newQueryId, queryKey, normalizeQuery, queryView,
};
