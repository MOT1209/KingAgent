// SkillRuntime: the pipeline from a user's sentence to skill results.
//
// This is §11 of the phase brief, assembled from the modules that each own one
// step rather than reimplemented here:
//
//   request
//     -> analysis + discovery      (discovery/SkillDiscovery.js)
//     -> ranking                   (discovery/SkillRanking.js)
//     -> working set + pipeline    (discovery/SkillRecommendation.js)
//     -> dependency resolution     (loader/SkillDependencyResolver.js)
//     -> security validation       (already done at install; re-checked on load)
//     -> policy + approval         (security/SkillPermissions.js, ApprovalManager)
//     -> load                      (loader/SkillLoader.js)
//     -> execute                   (runtime/SkillExecutor.js)
//     -> evaluate                  (evaluation/SkillEvaluator.js)
//     -> recovery                  (an alternative skill, or an honest stop)
//     -> result
//
// Two composition rules that are easy to get wrong and expensive to get wrong:
//
//   * **Permissions never widen across a pipeline.** Each skill runs with its
//     own granted set. Skill three does not inherit the shell access skill one
//     was approved for.
//   * **A failed skill does not silently disappear.** Recovery tries the next
//     ranked skill for the same categories, once, and the result records both
//     attempts. A pipeline that quietly substitutes capabilities is a pipeline
//     nobody can debug.

const { recommend } = require('../discovery/SkillRecommendation');
const { resolve: resolveDependencies } = require('../loader/SkillDependencyResolver');
const { rankAll } = require('../discovery/SkillRanking');
const { discover } = require('../discovery/SkillDiscovery');
const { postureFor } = require('../security/SkillTrust');
const { describe: describeSandbox } = require('../security/SkillSandbox');
const { TYPES } = require('../../events/event-bus');
const SkillResult = require('./SkillResult');

const MAX_PIPELINE_SKILLS = 8;

class SkillRuntime {
  constructor({
    registry,
    loader,
    executor,
    evaluator = null,
    sandboxes = null,
    bus = null,
    logger = null,
    platform = null,
    maxSkills = MAX_PIPELINE_SKILLS,
  } = {}) {
    if (!registry) throw new Error('SkillRuntime requires a SkillRegistry');
    if (!loader) throw new Error('SkillRuntime requires a SkillLoader');
    if (!executor) throw new Error('SkillRuntime requires a SkillExecutor');
    this._registry = registry;
    this._loader = loader;
    this._executor = executor;
    this._evaluator = evaluator;
    this._sandboxes = sandboxes;
    this._bus = bus;
    this._logger = logger;
    this._platform = platform;
    this._maxSkills = maxSkills;
  }

  // Everything the platform would do, without doing any of it.
  //
  // This is what the orchestrator calls to decide whether skills are worth
  // loading for a task, what the UI shows as "these skills will be used", and
  // what makes the selection explainable before rather than after the fact.
  plan({ request, maxSkills = null, providerCategories = [] } = {}) {
    const recommendation = recommend({
      request,
      registry: this._registry,
      platform: this._platform,
      maxSkills: maxSkills || this._maxSkills,
      providerCategories,
    });

    const roots = recommendation.selected.map((s) => ({ id: s.skillId, range: `=${s.version}` }));
    const dependencies = resolveDependencies({ roots, registry: this._registry, platform: this._platform });

    const steps = recommendation.selected.map((selection) => {
      const record = this._registry.getExact(selection.skillId, selection.version);
      const posture = postureFor(record);
      return {
        skillId: selection.skillId,
        version: selection.version,
        phase: selection.phase,
        covers: selection.coversCategories,
        score: selection.score,
        why: selection.explanation,
        permissions: [...record.manifest.permissions],
        risk: record.manifest.riskLevel,
        trust: record.trust.tier,
        // Said up front, because "this will ask you to approve something" is
        // the single most useful thing a plan can tell a user.
        willRequestApproval: posture.approval,
        willBeSandboxed: posture.sandbox,
        sandbox: describeSandbox(record, { sandboxes: this._sandboxes }),
        dependencies: record.manifest.dependencies.map((d) => `${d.id}@${d.range}`),
      };
    });

    return {
      request,
      categories: recommendation.categories,
      steps,
      pipeline: recommendation.pipeline,
      gaps: recommendation.gaps,
      rejected: recommendation.rejected,
      dependencies: {
        ok: dependencies.ok,
        order: dependencies.order.map((r) => `${r.id}@${r.version}`),
        missing: dependencies.missing,
        conflicts: dependencies.conflicts,
        cycle: dependencies.cycle,
        reason: dependencies.reason,
      },
      // An honest summary line for a log or a status bar.
      summary: steps.length
        ? `${steps.length} skill(s) selected: ${steps.map((s) => s.skillId).join(', ')}${recommendation.gaps.length ? `; ${recommendation.gaps.length} capability gap(s)` : ''}`
        : 'no installed skill matched this request',
    };
  }

  // Run the whole pipeline for a request.
  //
  // `stopOnFailure` defaults to false: a failed testing skill should not
  // prevent the deployment skill from at least being *considered*, and the
  // caller sees every outcome. Set it when the phases are strictly dependent.
  async run({
    request,
    agent = null,
    taskId = null,
    workspaceId = null,
    workspaceRoot = null,
    sessionId = null,
    traceId = null,
    projectId = null,
    taskType = null,
    maxSkills = null,
    stopOnFailure = false,
    recover = true,
    runner = null,
    approve = null,
    memoryPolicy = null,
    timeoutMs = null,
  } = {}) {
    const startedAt = Date.now();
    const plan = this.plan({ request, maxSkills });
    this._emit(TYPES.SKILL_SELECTED, { id: 'pipeline' }, {
      taskId,
      request: String(request || '').slice(0, 200),
      skills: plan.steps.map((s) => s.skillId),
      gaps: plan.gaps.map((g) => g.category),
    });

    if (!plan.dependencies.ok) {
      return {
        ok: false,
        plan,
        results: [],
        reason: `dependencies do not resolve: ${plan.dependencies.reason}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const results = [];
    const previousResults = [];
    let failed = false;

    for (const step of plan.steps) {
      if (failed && stopOnFailure) {
        const record = this._registry.getExact(step.skillId, step.version);
        const skipped = SkillResult.skipped(record, { reason: 'an earlier skill in the pipeline failed' });
        results.push({ step, result: skipped, recovered: null });
        continue;
      }

      const outcome = await this._runStep(step, {
        request, agent, taskId, workspaceId, workspaceRoot, sessionId, traceId, projectId,
        taskType, runner, approve, timeoutMs, previousResults, pipeline: plan.steps, memoryPolicy,
      });
      results.push(outcome);
      previousResults.push(outcome.result);

      if (!outcome.result.ok && !outcome.result.neutral) {
        failed = true;
        // Recovery: one alternative for the same categories, then stop trying.
        // Unbounded substitution is how a pipeline burns a context window
        // rediscovering that nothing works.
        if (recover) {
          const alternative = this._findAlternative(step, results.map((r) => r.step.skillId));
          if (alternative) {
            if (this._logger) this._logger.info(`skill ${step.skillId} failed; trying ${alternative.skillId}`, { taskId });
            const retry = await this._runStep(alternative, {
              request, agent, taskId, workspaceId, workspaceRoot, sessionId, traceId, projectId,
              taskType, runner, approve, timeoutMs, previousResults, pipeline: plan.steps, memoryPolicy,
            });
            results[results.length - 1].recovered = { step: alternative, result: retry.result };
            previousResults.push(retry.result);
            if (retry.result.ok) failed = false;
          }
        }
      }
    }

    const ran = results.filter((r) => !r.result.neutral);
    const ok = ran.length > 0 && ran.every((r) => r.result.ok || (r.recovered && r.recovered.result.ok));

    return {
      ok,
      plan,
      results: results.map((r) => ({
        skillId: r.step.skillId,
        version: r.step.version,
        phase: r.step.phase,
        result: r.result,
        recovered: r.recovered ? { skillId: r.recovered.step.skillId, result: r.recovered.result } : null,
        evaluation: r.evaluation || null,
      })),
      gaps: plan.gaps,
      durationMs: Date.now() - startedAt,
      reason: ok ? 'every selected skill completed' : summarizeFailures(results),
    };
  }

  // Run one selected skill: dependencies first, then load, execute, evaluate.
  async _runStep(step, opts) {
    const record = this._registry.getExact(step.skillId, step.version);
    if (!record) {
      return { step, result: SkillResult.skipped({ id: step.skillId, version: step.version }, { reason: 'the skill is no longer installed' }), recovered: null };
    }

    // Dependencies are loaded, not executed: a dependency contributes its
    // instructions to the run, which is what "skill A requires skill B" means
    // for a capability package.
    const deps = resolveDependencies({ roots: [{ id: record.id, range: `=${record.version}` }], registry: this._registry, platform: this._platform });
    if (!deps.ok) {
      return { step, result: SkillResult.denied(record, { reason: `dependencies do not resolve: ${deps.reason}`, deniedBy: 'dependency' }), recovered: null };
    }

    let loaded;
    try {
      const all = await this._loader.loadAll(deps.order);
      if (!all.ok) {
        return { step, result: SkillResult.failed(record, { error: `could not load ${all.failed.skillId}: ${all.failed.error}` }), recovered: null };
      }
      loaded = all.loaded[all.loaded.length - 1];
      // Dependency instructions ride along as resources, clearly labelled, so
      // the runner can see where each piece came from.
      for (const dep of all.loaded.slice(0, -1)) {
        loaded.resources = { ...loaded.resources, [`dependency:${dep.record.id}`]: dep.instructions };
      }
    } catch (err) {
      return { step, result: SkillResult.failed(record, { error: err.message }), recovered: null };
    }

    const { result } = await this._executor.execute(loaded, {
      request: opts.request,
      taskType: opts.taskType,
      agent: opts.agent,
      taskId: opts.taskId,
      workspaceId: opts.workspaceId,
      workspaceRoot: opts.workspaceRoot,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      projectId: opts.projectId,
      // Each skill runs with its own declared permissions — never the union of
      // the pipeline's.
      grantedPermissions: record.manifest.permissions,
      pipeline: opts.pipeline,
      previousResults: opts.previousResults,
      runner: opts.runner,
      approve: opts.approve,
      timeoutMs: opts.timeoutMs,
    });

    let evaluation = null;
    if (this._evaluator && !result.neutral) {
      evaluation = await this._evaluator.record(record, result, {
        context: { taskId: opts.taskId, taskType: opts.taskType, agentId: opts.agent && opts.agent.id },
        policy: opts.memoryPolicy,
      });
    }

    return { step, result, recovered: null, evaluation };
  }

  // The next-best installed skill covering the same categories, excluding
  // anything already tried in this run.
  _findAlternative(step, tried) {
    const candidates = [];
    for (const category of step.covers) {
      for (const record of this._registry.byCategory(category)) {
        if (tried.includes(record.id)) continue;
        candidates.push({ record, relevance: 1.5, matchedCategories: [category] });
      }
    }
    if (candidates.length === 0) return null;
    const best = rankAll(candidates, { platform: this._platform, registry: this._registry }).find((r) => r.eligible);
    if (!best) return null;
    return {
      skillId: best.skillId,
      version: best.version,
      phase: step.phase,
      covers: best.matchedCategories,
      score: best.score,
      why: `recovery for ${step.skillId}: ${best.explanation}`,
    };
  }

  // What the skills pane shows: installed skills, their standing, and what the
  // platform would pick for a request if one is supplied.
  controlView({ request = null } = {}) {
    const skills = this._registry.list().map((r) => r.view());
    return {
      skills,
      stats: this._registry.stats(),
      plan: request ? this.plan({ request }) : null,
      runnerWired: this._executor.hasRunner,
    };
  }

  // The categories a request needs, without touching the registry — used by the
  // orchestrator to decide whether to involve skills at all.
  analyze(request) {
    return discover({ request, registry: this._registry, platform: this._platform });
  }

  _emit(type, record, payload) {
    if (this._bus) this._bus.emit(type, { skillId: record.id, taskId: payload.taskId || null }, payload);
  }
}

function summarizeFailures(results) {
  const failures = results
    .filter((r) => !r.result.ok && !r.result.neutral)
    .map((r) => `${r.step.skillId}: ${r.result.error || r.result.outcome}${r.recovered ? ` (recovery ${r.recovered.result.ok ? 'succeeded' : 'also failed'})` : ''}`);
  return failures.length ? failures.join('; ') : 'nothing ran';
}

module.exports = { SkillRuntime, MAX_PIPELINE_SKILLS };
