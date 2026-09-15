// Handoff: transferring ownership of a task without transferring a transcript.
//
// §29 lists the eight fields and §29 also gives the constraint that makes them
// work: "Keep handoffs minimal and scoped." A handoff that carries the whole
// conversation is just delegation with extra steps — the receiving agent would
// have to re-read everything and would inherit every wrong turn.
//
// So this module defines the eight fields, validates them, and then *bounds*
// them: files are capped, memory references are names (not values), results are
// summaries rather than raw output. What is deliberately absent is any field for
// a prompt or a message history. There is nowhere to put one.
//
//   objective          what is being handed over
//   currentState       where the work actually is
//   relevantFiles      what the receiver needs to open
//   constraints        what must not change
//   results            what has been established so far
//   memoryRefs         keys into the shared memory, never the values
//   artifacts          ids of artifacts the receiver should read
//   outstandingIssues  what is still open

const { isPlainObject, isString, isArray, fail } = require('../schema/validate');

const HANDOFF_FIELDS = Object.freeze([
  'objective',
  'currentState',
  'relevantFiles',
  'constraints',
  'results',
  'memoryRefs',
  'artifacts',
  'outstandingIssues',
]);

const FILE_LIMIT = 40;
const REF_LIMIT = 40;
const RESULT_LIMIT = 20;

function createHandoff(input = {}) {
  const handoff = {
    objective: input.objective || '',
    currentState: input.currentState || '',
    relevantFiles: slice(input.relevantFiles, FILE_LIMIT),
    constraints: slice(input.constraints, REF_LIMIT),
    results: slice(input.results, RESULT_LIMIT),
    // Memory references are *keys*, so a receiver reads the value through the
    // memory manager, where the value's own scoping and lifetime apply.
    memoryRefs: slice(input.memoryRefs, REF_LIMIT),
    artifacts: slice(input.artifacts, REF_LIMIT),
    outstandingIssues: slice(input.outstandingIssues, REF_LIMIT),
    from: input.from || null,
    to: input.to || null,
    taskId: input.taskId || null,
    delegationId: input.delegationId || null,
    traceId: input.traceId || null,
    at: Date.now(),
  };
  const { ok, errors } = validateHandoff(handoff);
  if (!ok) throw new Error(`invalid handoff: ${errors.join('; ')}`);
  return Object.freeze(handoff);
}

function validateHandoff(handoff) {
  if (!isPlainObject(handoff)) return fail(['handoff must be an object']);
  if (!isString(handoff.objective) || handoff.objective.trim() === '') return fail(['handoff requires an objective']);
  if (!isString(handoff.currentState)) return fail(['handoff currentState must be a string']);
  for (const key of ['relevantFiles', 'constraints', 'results', 'memoryRefs', 'artifacts', 'outstandingIssues']) {
    if (handoff[key] !== undefined && !isArray(handoff[key])) return fail([`handoff ${key} must be an array`]);
  }
  return { ok: true, errors: [] };
}

function slice(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((v) => (isString(v) ? v.slice(0, 400) : isPlainObject(v) ? truncateObject(v) : String(v)))
    .filter((v) => (isString(v) ? v.length > 0 : true));
}

function truncateObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 12)) {
    out[k] = isString(v) ? v.slice(0, 300) : v;
  }
  return out;
}

// The compact form carried inside an agent message. A handoff is already
// minimal, so this drops nulls and empties and nothing else.
function summarizeHandoff(handoff) {
  const out = {};
  for (const field of HANDOFF_FIELDS) {
    const value = handoff[field];
    if (value === undefined || value === null) continue;
    if (isString(value) && value === '') continue;
    if (isArray(value) && value.length === 0) continue;
    out[field] = value;
  }
  return out;
}

// Does a received handoff give the receiver enough to start? Deliberately
// shallow: an objective and a state are required, and anything else missing is
// reported so the receiver can ask one specific question instead of guessing.
function readyToAccept(handoff) {
  const missing = [];
  if (!handoff || !handoff.objective) missing.push('objective');
  if (!handoff || !handoff.currentState) missing.push('currentState');
  return { ok: missing.length === 0, missing };
}

module.exports = { HANDOFF_FIELDS, FILE_LIMIT, createHandoff, validateHandoff, summarizeHandoff, readyToAccept };
