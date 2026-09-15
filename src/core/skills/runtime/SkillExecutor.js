// SkillExecutor: running one skill, with the controls actually in the path.
//
// The sequence is fixed and every step can stop the run:
//
//   permissions -> approval -> sandbox -> context -> runner -> result
//
// Two things this module refuses to do, both of which would be easier:
//
//   1. **It does not execute skill content.** A skill is instructions; there is
//      nothing here that evals, spawns or interprets a manifest. Execution is a
//      *runner* the host supplies (an agent loop, a model call), and everything
//      that runner does with tools goes through the ToolManager, which already
//      owns permissions, authorization and timeouts. A skill system that ran
//      its own content would be a second, weaker tool layer.
//   2. **It does not report a run that did not happen as a success.** With no
//      runner wired the outcome is `prepared` — assembled, permitted, loaded,
//      not executed — which keeps success rates meaning what they say.
//
// The tool surface handed to a runner is an allowlist derived from the skill's
// manifest and the tools that actually exist. A call outside it is refused and
// recorded as a security incident: a skill reaching for a tool it never
// declared is exactly the signal the evaluator should act on.

const { enforcePermissions, SkillPermissionError } = require('../security/SkillPermissions');
const { createFor: createSandbox, SkillSandboxError } = require('../security/SkillSandbox');
const { postureFor } = require('../security/SkillTrust');
const { createSkillContext, toPayload, contextView } = require('./SkillContext');
const SkillResult = require('./SkillResult');
const { SKILL_STATES } = require('../lifecycle/states');
const { TYPES } = require('../../events/event-bus');

const DEFAULT_TIMEOUT_MS = 120_000;

class SkillExecutor {
  constructor({
    registry,
    tools = null,
    policy = null,
    approvals = null,
    sandboxes = null,
    bus = null,
    logger = null,
    runner = null,          // async ({ context, payload, callTool }) => result
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this._registry = registry;
    this._tools = tools;
    this._policy = policy;
    this._approvals = approvals;
    this._sandboxes = sandboxes;
    this._bus = bus;
    this._logger = logger;
    this._runner = runner;
    this._timeoutMs = timeoutMs;
  }

  get hasRunner() { return typeof this._runner === 'function'; }

  // Which tools this skill may call: what it declared, intersected with what is
  // registered. A declared tool that does not exist is dropped (and reported),
  // never silently substituted.
  allowedTools(record, { agent = null } = {}) {
    const declared = record.manifest.tools;
    if (!this._tools) return { allowed: [], missing: [...declared] };
    const registered = new Set(this._tools.list({ includeHidden: false }).map((t) => t.id));
    const allowed = declared.filter((id) => registered.has(id));
    const missing = declared.filter((id) => !registered.has(id));
    // An agent's own tool restrictions still apply on top: a skill cannot widen
    // what its agent may call.
    if (agent && Array.isArray(agent.tools) && agent.tools.length) {
      return { allowed: allowed.filter((id) => agent.tools.includes(id)), missing };
    }
    return { allowed, missing };
  }

  // Execute one skill. `loaded` is what SkillLoader returned.
  async execute(loaded, {
    request = '',
    taskType = null,
    agent = null,
    taskId = null,
    workspaceId = null,
    workspaceRoot = null,
    sessionId = null,
    traceId = null,
    projectId = null,
    grantedPermissions = null,
    pipeline = [],
    previousResults = [],
    timeoutMs = null,
    runner = null,
    approve = null,
  } = {}) {
    const record = loaded.record;
    const startedAt = Date.now();
    const context = { taskId, agentId: agent && agent.id, workspaceId, sessionId, projectId };

    // 1. Permissions, through the platform's own policy engine, with the human
    // loop open. A denial here ends the run before anything is created.
    try {
      await enforcePermissions({ policy: this._policy, manifest: record.manifest, context });
    } catch (err) {
      if (err instanceof SkillPermissionError) {
        return this._finish(record, SkillResult.denied(record, { reason: err.message, deniedBy: 'policy', startedAt, durationMs: Date.now() - startedAt }));
      }
      throw err;
    }

    // 2. Approval, when trust x risk (or a scanner finding) calls for it. This
    // is per *run*, not per install: a high-risk skill approved once is not
    // approved forever.
    const posture = postureFor(record);
    const approvals = [];
    if (posture.approval) {
      const granted = await this._askApproval(record, posture, { approve, context });
      record.recordApproval({ granted });
      approvals.push({ action: 'skill.run', granted, at: Date.now() });
      if (!granted) {
        return this._finish(record, SkillResult.denied(record, { reason: `running ${record.id} was not approved`, deniedBy: 'approval', startedAt, durationMs: Date.now() - startedAt }));
      }
    }

    // 3. Sandbox, if the posture requires it. A required sandbox that cannot be
    // created stops the run — it never degrades to an unconfined one.
    let sandbox;
    try {
      const created = await createSandbox(record, {
        sandboxes: this._sandboxes,
        workspaceRoot,
        taskId,
        workspaceId,
        agentId: agent && agent.id,
        sessionId,
        traceId,
      });
      sandbox = created.sandbox;
    } catch (err) {
      if (err instanceof SkillSandboxError) {
        return this._finish(record, SkillResult.denied(record, { reason: err.message, deniedBy: 'sandbox', startedAt, durationMs: Date.now() - startedAt }));
      }
      throw err;
    }

    // 4. Context: the narrow view the runner gets.
    const { allowed, missing } = this.allowedTools(record, { agent });
    if (missing.length && this._logger) {
      this._logger.warn(`skill ${record.id} declares tools that are not registered`, { missing });
    }
    const skillContext = createSkillContext({
      record,
      instructions: loaded.instructions,
      resources: loaded.resources,
      request,
      taskType,
      taskId,
      agentId: agent && agent.id,
      workspaceId,
      workspaceRoot,
      sessionId,
      traceId,
      projectId,
      grantedPermissions: grantedPermissions || record.manifest.permissions,
      allowedTools: allowed,
      sandbox,
      approvals,
      pipeline,
      previousResults,
      timeoutMs: timeoutMs || this._timeoutMs,
    });

    this._emit(TYPES.SKILL_STARTED, record, { taskId, sandboxed: Boolean(sandbox), tools: allowed.length, posture: { sandbox: posture.sandbox, approval: posture.approval } });
    this._safeTransition(record, SKILL_STATES.RUNNING, 'executing');

    // 5. Run — or report honestly that nothing did.
    const activeRunner = runner || this._runner;
    if (typeof activeRunner !== 'function') {
      const result = SkillResult.prepared(record, {
        payload: toPayload(skillContext),
        startedAt,
        durationMs: Date.now() - startedAt,
        sandboxed: Boolean(sandbox),
        sandboxId: sandbox ? sandbox.id : null,
      });
      await this._releaseSandbox(sandbox);
      return this._finish(record, result, { context: skillContext });
    }

    const toolCalls = [];
    let securityIncident = false;
    const callTool = async (toolId, input) => {
      if (!this._tools) throw new Error('no tool manager is wired');
      if (!allowed.includes(toolId)) {
        // The interesting failure: a skill reaching past what it declared.
        securityIncident = true;
        toolCalls.push({ toolId, ok: false, durationMs: 0, error: 'tool is not in this skill\'s declared surface' });
        this._emit(TYPES.SKILL_FAILED, record, { reason: 'undeclared tool call', toolId });
        throw new Error(`skill ${record.id} may not call "${toolId}" — it is not declared in its manifest`);
      }
      const startedTool = Date.now();
      try {
        const out = await this._tools.execute({ id: toolId, input, agent, taskId });
        toolCalls.push({ toolId, ok: true, durationMs: Date.now() - startedTool, error: null });
        return out;
      } catch (err) {
        // A denial by the tool gate is a control working, and it is recorded as
        // an incident so a skill that keeps hitting the wall is visible.
        if (err && (err.code === 'TOOL_DENIED' || err.name === 'ToolDeniedError')) securityIncident = true;
        toolCalls.push({ toolId, ok: false, durationMs: Date.now() - startedTool, error: err.message });
        throw err;
      }
    };

    try {
      const raw = await withTimeout(
        Promise.resolve(activeRunner({ context: skillContext, payload: toPayload(skillContext), callTool, record })),
        skillContext.timeoutMs,
      );
      const result = raw && raw.outcome
        ? SkillResult.validateResult({ ...raw, skillId: record.id, version: record.version, toolCalls, securityIncident, sandboxed: Boolean(sandbox), sandboxId: sandbox ? sandbox.id : null, durationMs: Date.now() - startedAt, startedAt, taskType }).result
        : SkillResult.completed(record, {
          summary: (raw && raw.summary) || `${record.id} completed`,
          durationMs: Date.now() - startedAt,
          startedAt,
          toolCalls,
          artifacts: (raw && raw.artifacts) || [],
          metadata: (raw && raw.metadata) || {},
          sandboxed: Boolean(sandbox),
          sandboxId: sandbox ? sandbox.id : null,
          taskType,
        });
      await this._releaseSandbox(sandbox);
      return this._finish(record, securityIncident && result.ok
        // A run that tripped a control is not reported as clean, whatever the
        // runner claims about it.
        ? SkillResult.failed(record, { error: 'a security control refused an action during this run', summary: result.summary, durationMs: result.durationMs, startedAt, toolCalls, securityIncident: true, sandboxed: Boolean(sandbox), sandboxId: sandbox ? sandbox.id : null, taskType })
        : result, { context: skillContext });
    } catch (err) {
      await this._releaseSandbox(sandbox);
      const timedOut = err && err.code === 'SKILL_TIMEOUT';
      const result = timedOut
        ? SkillResult.timeout(record, { timeoutMs: skillContext.timeoutMs, durationMs: Date.now() - startedAt, startedAt })
        : SkillResult.failed(record, {
          error: err.message,
          durationMs: Date.now() - startedAt,
          startedAt,
          toolCalls,
          securityIncident,
          sandboxed: Boolean(sandbox),
          sandboxId: sandbox ? sandbox.id : null,
          taskType,
        });
      return this._finish(record, result, { context: skillContext });
    }
  }

  async _askApproval(record, posture, { approve, context }) {
    const summary = `Run skill "${record.manifest.name}" (${record.id}@${record.version})`;
    const detail = {
      skillId: record.id,
      version: record.version,
      trust: posture.tier,
      risk: posture.risk,
      permissions: [...record.manifest.permissions],
      reasons: posture.reasons,
      findings: record.security.findings.map((f) => ({ id: f.id, severity: f.severity, summary: f.summary })),
    };
    if (typeof approve === 'function') return (await approve({ record, summary, detail, posture })) === true;
    if (!this._approvals) return false; // fail closed
    const { decision } = this._approvals.requestApproval({
      action: 'skill.run',
      summary,
      reason: posture.reasons.join('; '),
      risk: posture.risk === 'critical' ? 'high' : posture.risk,
      parameters: detail,
      identity: { taskId: context.taskId, agentId: context.agentId, workspaceId: context.workspaceId },
      metadata: { skillId: record.id, version: record.version },
    });
    const outcome = await decision;
    return outcome === true || (outcome && outcome.approved === true);
  }

  async _releaseSandbox(sandbox) {
    if (!sandbox || !this._sandboxes) return;
    try {
      await this._sandboxes.stop(sandbox.id, 'skill run finished');
    } catch (err) {
      // Best effort: SandboxManager.cleanup() is the backstop, and failing to
      // tear one down must not turn a completed run into a failed one.
      if (this._logger) this._logger.debug(`could not release sandbox ${sandbox.id}: ${err.message}`);
    }
  }

  _finish(record, result, { context = null } = {}) {
    this._emit(result.ok ? TYPES.SKILL_COMPLETED : TYPES.SKILL_FAILED, record, {
      outcome: result.outcome,
      durationMs: result.durationMs,
      error: result.error,
      securityIncident: result.securityIncident,
      deniedBy: result.deniedBy,
      toolCalls: result.toolCalls.length,
    });
    return { result, context: context ? contextView(context) : null };
  }

  _safeTransition(record, to, reason) {
    try {
      this._registry.transition(record, to, { reason, actor: 'executor' });
    } catch (err) {
      if (this._logger) this._logger.debug(`skill ${record.id} could not move to ${to}: ${err.message}`);
    }
  }

  _emit(type, record, payload) {
    if (this._bus) this._bus.emit(type, { skillId: record.id, taskId: payload.taskId || null }, { skill: record.id, version: record.version, ...payload });
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`skill run exceeded ${ms}ms`);
      err.code = 'SKILL_TIMEOUT';
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

module.exports = { SkillExecutor, DEFAULT_TIMEOUT_MS };
