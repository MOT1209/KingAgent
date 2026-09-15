// The shape a skill run reports back, and the validation that keeps it honest.
//
// A result crosses three boundaries — the evaluator that scores it, the IPC
// layer that shows it, and the memory that learns from it — so it is a schema
// rather than an ad-hoc object. Two fields carry weight beyond their type:
//
//   `ok`               is the skill's own claim about the outcome. It is not
//                      inferred from the absence of an exception, because a
//                      runner that returns "done" after failing every step is
//                      exactly the failure this platform must not launder.
//   `securityIncident` is never set by the skill. Only the executor sets it,
//                      when a control (policy, permission, sandbox, path guard)
//                      actually refused something. A skill cannot declare
//                      itself innocent, and it cannot frame another skill.

const { isPlainObject, isString, isBoolean } = require('../../schema/validate');

const OUTCOMES = Object.freeze(['completed', 'failed', 'denied', 'prepared', 'skipped', 'timeout']);

// Outcomes that count as a successful run for statistics. `prepared` is
// deliberately not one: it means the platform assembled everything and no
// runner executed it, which must not inflate a skill's success rate.
const SUCCESS_OUTCOMES = Object.freeze(['completed']);
const NEUTRAL_OUTCOMES = Object.freeze(['prepared', 'skipped']);

const MAX_SUMMARY = 2000;
const MAX_ARTIFACTS = 100;

function validateResult(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ['skill result must be an object'] };
  const outcome = input.outcome || (input.ok === true ? 'completed' : 'failed');
  if (!OUTCOMES.includes(outcome)) return { ok: false, errors: [`unknown skill outcome: ${JSON.stringify(input.outcome)}`] };
  if (input.summary !== undefined && !isString(input.summary)) return { ok: false, errors: ['summary must be a string'] };
  if (input.ok !== undefined && !isBoolean(input.ok)) return { ok: false, errors: ['ok must be a boolean'] };
  if (input.toolCalls !== undefined && !Array.isArray(input.toolCalls)) return { ok: false, errors: ['toolCalls must be an array'] };
  if (input.artifacts !== undefined && !Array.isArray(input.artifacts)) return { ok: false, errors: ['artifacts must be an array'] };
  return { ok: true, result: normalizeResult({ ...input, outcome }) };
}

function normalizeResult(input) {
  const outcome = input.outcome;
  return Object.freeze({
    skillId: isString(input.skillId) ? input.skillId : null,
    version: isString(input.version) ? input.version : null,
    outcome,
    ok: SUCCESS_OUTCOMES.includes(outcome),
    neutral: NEUTRAL_OUTCOMES.includes(outcome),
    summary: isString(input.summary) ? input.summary.slice(0, MAX_SUMMARY) : '',
    error: input.error ? String(input.error).slice(0, 1000) : null,
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0,
    startedAt: Number.isFinite(input.startedAt) ? input.startedAt : null,
    completedAt: Number.isFinite(input.completedAt) ? input.completedAt : null,
    // Set by the executor only (see the module comment).
    securityIncident: input.securityIncident === true,
    deniedBy: isString(input.deniedBy) ? input.deniedBy : null,
    toolCalls: Object.freeze((input.toolCalls || []).slice(0, 200).map((c) => Object.freeze({
      toolId: isString(c.toolId) ? c.toolId : String(c.toolId || ''),
      ok: c.ok === true,
      durationMs: Number.isFinite(c.durationMs) ? c.durationMs : 0,
      error: c.error ? String(c.error).slice(0, 300) : null,
    }))),
    artifacts: Object.freeze((input.artifacts || []).slice(0, MAX_ARTIFACTS).map((a) => Object.freeze({
      id: isString(a.id) ? a.id : null,
      type: isString(a.type) ? a.type : 'file',
      name: isString(a.name) ? a.name : '',
      ref: isString(a.ref) ? a.ref : null,
    }))),
    // Free-form, bounded, and never trusted: a runner may attach whatever the
    // caller finds useful, and nothing in the platform branches on it.
    metadata: isPlainObject(input.metadata) ? Object.freeze({ ...input.metadata }) : Object.freeze({}),
    sandboxed: input.sandboxed === true,
    sandboxId: isString(input.sandboxId) ? input.sandboxId : null,
    taskType: isString(input.taskType) ? input.taskType : null,
  });
}

// A result view safe to send over IPC: same shape, plain objects.
function resultView(result) {
  return {
    skillId: result.skillId,
    version: result.version,
    outcome: result.outcome,
    ok: result.ok,
    summary: result.summary,
    error: result.error,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    securityIncident: result.securityIncident,
    deniedBy: result.deniedBy,
    toolCalls: result.toolCalls.map((c) => ({ ...c })),
    artifacts: result.artifacts.map((a) => ({ ...a })),
    sandboxed: result.sandboxed,
    sandboxId: result.sandboxId,
    taskType: result.taskType,
  };
}

module.exports = { OUTCOMES, SUCCESS_OUTCOMES, NEUTRAL_OUTCOMES, validateResult, normalizeResult, resultView };
