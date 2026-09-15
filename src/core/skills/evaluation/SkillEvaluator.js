// SkillEvaluator: what happened when a skill ran, and what follows from it.
//
// Three jobs, in the order they matter:
//
//   1. **Record honestly.** A run's outcome goes into the record as observed —
//      including the distinction between "failed" and "tripped a security
//      control", which are different problems with different consequences.
//   2. **Act on a pattern.** Three consecutive failures, or any security
//      incident, quarantines the skill. Automatically, because the alternative
//      is a skill that keeps being selected while it keeps failing; and
//      one-way, because releasing it is a human decision (SkillEnabler).
//   3. **Score, with reasons.** The quality score is recomputed and stored on
//      the record so ranking and the UI read the same explained number.
//
// Optionally it also writes what it learned into the platform's MemoryManager:
// "this skill worked well for this kind of task". That memory informs ranking —
// and it is explicitly *not* allowed to override security. A skill the scanner
// blocked stays blocked no matter how well it once performed.

const { score: computeScore } = require('./SkillQualityScore');
const { SKILL_STATES } = require('../lifecycle/states');
const { TYPES } = require('../../events/event-bus');

const MEMORY_TYPE = 'skill-outcome';

class SkillEvaluator {
  constructor({ registry, enabler = null, memory = null, bus = null, logger = null, benchmarks = null } = {}) {
    if (!registry) throw new Error('SkillEvaluator requires a SkillRegistry');
    this._registry = registry;
    this._enabler = enabler;
    this._memory = memory;
    this._bus = bus;
    this._logger = logger;
    this._benchmarks = benchmarks; // skillId -> { passRate, total }
  }

  // Record one completed run and decide what follows.
  //
  // `result` is a SkillResult (runtime/SkillResult.js) or a plain
  // `{ ok, durationMs, error, securityIncident, taskType }`.
  async record(record, result, { context = {}, policy = null, now = Date.now() } = {}) {
    if (!record) throw new Error('SkillEvaluator.record requires a skill record');
    const ok = result.ok === true;
    const securityIncident = result.securityIncident === true;

    record.recordRun({
      ok,
      durationMs: result.durationMs || 0,
      error: result.error || null,
      securityIncident,
      now,
    });

    // Score before any state change, so the quarantine event carries the score
    // that justified it.
    const quality = this.rescore(record, { now });

    const verdict = record.shouldQuarantine();
    let quarantined = false;
    if (verdict.quarantine && record.state !== SKILL_STATES.QUARANTINED) {
      quarantined = this._quarantine(record, verdict.reason);
    } else if (!ok && record.state === SKILL_STATES.RUNNING) {
      this._safeTransition(record, SKILL_STATES.FAILED, result.error || 'run failed');
    } else if (ok && (record.state === SKILL_STATES.RUNNING || record.state === SKILL_STATES.EVALUATING || record.state === SKILL_STATES.LOADED)) {
      // A successful run is how a skill becomes `active`: the state means
      // "has worked here", which is exactly what ranking should be able to see.
      this._safeTransition(record, SKILL_STATES.EVALUATING, 'evaluating result');
      this._safeTransition(record, SKILL_STATES.ACTIVE, 'completed successfully');
    }

    this._emit(TYPES.SKILL_EVALUATED, record, {
      ok,
      durationMs: result.durationMs || 0,
      securityIncident,
      quarantined,
      score: quality.score,
      grade: quality.grade,
      confidence: quality.confidence,
      consecutiveFailures: record.stats.consecutiveFailures,
    });

    await this._remember(record, { ok, result, context, policy, now });

    return {
      skillId: record.id,
      version: record.version,
      ok,
      state: record.state,
      quarantined,
      quality,
      stats: { ...record.stats },
    };
  }

  // Recompute and store the quality score. Separate from `record` because the
  // UI recomputes on demand (a benchmark ran, time passed) without a run.
  rescore(record, { now = Date.now() } = {}) {
    const benchmarks = this._benchmarks ? this._benchmarks[record.id] || null : null;
    const quality = computeScore(record, { benchmarks, now });
    record.quality = {
      ...(record.quality || {}),
      score: quality.score,
      grade: quality.grade,
      confidence: quality.confidence,
      summary: quality.summary,
      components: quality.components,
      caveats: quality.caveats,
      computedAt: quality.computedAt,
    };
    record.updatedAt = now;
    return quality;
  }

  // Every installed skill's current standing — what the skills UI's overview
  // table and `kingagent skills audit` both read.
  report({ limit = 0 } = {}) {
    const rows = this._registry.list().map((record) => {
      const quality = this.rescore(record);
      return {
        id: record.id,
        version: record.version,
        state: record.state,
        trust: record.trust.tier,
        risk: record.manifest.riskLevel,
        runs: record.stats.runs,
        successRate: record.successRate(),
        averageDurationMs: record.averageDurationMs(),
        consecutiveFailures: record.stats.consecutiveFailures,
        securityIncidents: record.stats.securityIncidents,
        score: quality.score,
        grade: quality.grade,
        confidence: quality.confidence,
        summary: quality.summary,
        lastError: record.stats.lastError,
      };
    }).sort((a, b) => (b.score || 0) - (a.score || 0));
    return limit ? rows.slice(0, limit) : rows;
  }

  // Which skills the platform would stop using, and why. Deliberately a
  // reportable list rather than a silent filter.
  concerns() {
    return this._registry.list()
      .map((record) => ({ record, verdict: record.shouldQuarantine() }))
      .filter((r) => r.verdict.quarantine || r.record.stats.consecutiveFailures > 0 || r.record.security.findings.length > 0)
      .map((r) => ({
        id: r.record.id,
        version: r.record.version,
        state: r.record.state,
        shouldQuarantine: r.verdict.quarantine,
        reason: r.verdict.reason || (r.record.stats.consecutiveFailures ? `${r.record.stats.consecutiveFailures} consecutive failure(s)` : 'scanner findings'),
        findings: r.record.security.findings.map((f) => ({ id: f.id, severity: f.severity, summary: f.summary })),
      }));
  }

  _quarantine(record, reason) {
    try {
      if (this._enabler) this._enabler.quarantine(record.id, { version: record.version, actor: 'system', reason });
      else this._registry.transition(record, SKILL_STATES.QUARANTINED, { reason, actor: 'system' });
      if (this._logger) this._logger.warn(`skill ${record.id} quarantined`, { reason });
      return true;
    } catch (err) {
      if (this._logger) this._logger.warn(`could not quarantine ${record.id}`, { error: err.message, reason });
      return false;
    }
  }

  _safeTransition(record, to, reason) {
    try {
      this._registry.transition(record, to, { reason, actor: 'evaluator' });
    } catch (err) {
      // An illegal transition here means the record moved underneath us (a
      // concurrent disable, say). That is not worth failing a completed run for.
      if (this._logger) this._logger.debug(`skill ${record.id} could not move to ${to}: ${err.message}`);
    }
  }

  // Write the outcome into scoped memory so future ranking can learn
  // "this skill works for this kind of task". Failures are stored too — a
  // memory that only records successes is a recommendation engine for
  // survivors.
  async _remember(record, { ok, result, context, policy, now }) {
    if (!this._memory || !policy) return null;
    try {
      return await this._memory.store({
        type: MEMORY_TYPE,
        scope: context.scope || 'project',
        content: `skill ${record.id}@${record.version} ${ok ? 'succeeded' : 'failed'} on ${result.taskType || context.taskType || 'a task'}`
          + (ok ? '' : `: ${String(result.error || 'unknown failure').slice(0, 200)}`),
        tags: ['skill', record.id, ok ? 'success' : 'failure', ...(result.taskType ? [result.taskType] : [])],
        importance: ok ? 'normal' : 'high',
        metadata: {
          skillId: record.id,
          version: record.version,
          ok,
          durationMs: result.durationMs || 0,
          taskId: context.taskId || null,
          at: now,
        },
      }, { policy, refs: { skillId: record.id, taskId: context.taskId || null } });
    } catch (err) {
      // Memory is an enhancement here, never a gate: a failed write must not
      // lose the evaluation that already happened.
      if (this._logger) this._logger.debug(`could not store skill outcome memory: ${err.message}`);
      return null;
    }
  }

  _emit(type, record, payload) {
    if (this._bus) this._bus.emit(type, { skillId: record.id }, { skill: record.id, version: record.version, ...payload });
  }
}

module.exports = { SkillEvaluator, MEMORY_TYPE };
