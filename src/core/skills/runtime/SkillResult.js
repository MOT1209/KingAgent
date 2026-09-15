// SkillResult: constructors for every way a skill run can end.
//
// One factory per outcome, rather than a single builder with flags, because the
// distinctions are the point: `denied` is not `failed`, and `prepared` is not
// `completed`. Code that has to pass a flag to say "this did not actually run"
// eventually forgets to, and a skill that never ran ends up with a perfect
// success rate.

const { normalizeResult, validateResult, resultView } = require('../schemas/SkillResultSchema');

function base(record, extra = {}) {
  return {
    skillId: record ? record.id : null,
    version: record ? record.version : null,
    startedAt: extra.startedAt || null,
    completedAt: extra.completedAt || Date.now(),
    durationMs: extra.durationMs || 0,
    ...extra,
  };
}

// The skill ran and did what it was asked.
function completed(record, { summary = '', durationMs = 0, startedAt = null, toolCalls = [], artifacts = [], metadata = {}, sandboxed = false, sandboxId = null, taskType = null } = {}) {
  return normalizeResult(base(record, { outcome: 'completed', summary, durationMs, startedAt, toolCalls, artifacts, metadata, sandboxed, sandboxId, taskType }));
}

// The skill ran and did not succeed. `securityIncident` is set only by the
// executor, when a control refused something during the run.
function failed(record, { error, summary = '', durationMs = 0, startedAt = null, toolCalls = [], securityIncident = false, sandboxed = false, sandboxId = null, taskType = null } = {}) {
  return normalizeResult(base(record, { outcome: 'failed', error, summary, durationMs, startedAt, toolCalls, securityIncident, sandboxed, sandboxId, taskType }));
}

// A control stopped it before it ran: policy, permissions, approval, trust.
// Counted separately from a failure — a denied skill is working as designed,
// and penalising its reliability score would teach the ranker the wrong lesson.
function denied(record, { reason, deniedBy = 'policy', durationMs = 0, startedAt = null } = {}) {
  return normalizeResult(base(record, { outcome: 'denied', error: reason, summary: reason, deniedBy, durationMs, startedAt }));
}

// Everything was assembled — validated, permitted, loaded — and no runner was
// wired to execute it. The honest outcome for a host that uses the skill system
// to *prepare* context for its own agent loop, which is the common case.
function prepared(record, { summary = '', payload = null, durationMs = 0, startedAt = null, sandboxed = false, sandboxId = null } = {}) {
  return normalizeResult(base(record, {
    outcome: 'prepared',
    summary: summary || `${record.id} prepared: instructions, permissions and sandbox are ready; no runner executed it`,
    durationMs,
    startedAt,
    sandboxed,
    sandboxId,
    metadata: payload ? { payloadBytes: payload.length } : {},
  }));
}

function skipped(record, { reason = '' } = {}) {
  return normalizeResult(base(record, { outcome: 'skipped', summary: reason }));
}

function timeout(record, { timeoutMs, durationMs = 0, startedAt = null }) {
  return normalizeResult(base(record, { outcome: 'timeout', error: `the skill run exceeded ${timeoutMs}ms`, durationMs, startedAt }));
}

module.exports = { completed, failed, denied, prepared, skipped, timeout, validateResult, resultView };
