// The Planner: deterministic, structured (model-backed) and autonomous modes.
//
//   - simple/deterministic: templates for known capability sets
//     (repository_analysis, code). No model needed.
//   - structured: asks the AI provider for a plan object, validates it, falls
//     back to deterministic on any failure.
//   - autonomous: returns a single self-driving step whose action picks a tool
//     per cycle through the Reasoner and executes it — a mini agent loop made
//     of parts the rest of the platform already owns.
//
// Everything funnels into createPlan/createStep, so one validation gate covers
// every produced plan.

const crypto = require('node:crypto');
const { createPlan, createStep } = require('./plan');
const { TYPES } = require('../events/event-bus');

// Deterministic plans are *analysis skeletons* that run productively offline:
// they scan, read, search and report — never pretend to write code. The
// mutating "implement → test → fix → verify" steps come from the model-backed
// structured planner, where the request's real intent can be honored.
//
// Step `tool.input` may be a function: it runs with { task, context, agent } at
// execution time so a step can consume the output of an earlier step
// (data-driven grounding) instead of hard-coding paths.

const REPO_ANALYSIS_STEPS = [
  { id: 'scan',   title: 'Scan repository structure', tool: { id: 'fs:list', input: { path: '.', recursive: true, maxDepth: 3 } }, capability: 'read' },
  { id: 'read',   title: 'Read key files',           tool: { id: 'fs:read', input: firstFileInput },                         capability: 'read' },
  { id: 'search', title: 'Search for relevant code', tool: { id: 'search:grep', input: { pattern: 'TODO|FIXME', maxResults: 20 } }, capability: 'code_search' },
  { id: 'report', title: 'Produce analysis report',  capability: 'report' },
];

const CODE_STEPS = [
  { id: 'analyze', title: 'Analyze the request',       tool: { id: 'fs:list', input: { path: '.', recursive: true, maxDepth: 3 } }, capability: 'read' },
  { id: 'read',    title: 'Read key files',            tool: { id: 'fs:read', input: firstFileInput },                              capability: 'read' },
  { id: 'plan',    title: 'Design an implementation plan', capability: 'code' },
  { id: 'report',  title: 'Report the outcome',        capability: 'report' },
];

// At execution time, pick the first text-ish file from the scan step's output
// (falling back to README.md) so the "read" step is always grounded.
function firstFileInput({ context, task }) {
  const planSteps = (task && task.plan && task.plan.steps) || [];
  const scanStep = planSteps.find((s) => s.tool && s.tool.id === 'fs:list');
  const entries = scanStep && scanStep.output && scanStep.output.ok && scanStep.output.data
    ? scanStep.output.data.entries || []
    : [];
  const files = entries.filter((e) => e.type === 'file');
  const file = files.find((e) => /readme|\.md$/i.test(e.name || e.path || ''))
    || files[0]
    || { path: 'README.md' };
  return { path: file.path || 'README.md' };
}

const TEMPLATES = {
  repository_analysis: REPO_ANALYSIS_STEPS,
  code: CODE_STEPS,
};

class Planner {
  constructor({ bus, toolManager, provider, reasoner, logger }) {
    this._bus = bus;
    this._tools = toolManager;
    this._provider = provider || null;
    this._reasoner = reasoner || null;
    this._logger = logger || null;
  }

  async buildPlan({ request, context, agent, mode = 'auto', signal }) {
    if (mode === 'autonomous') {
      return createPlan({
        id: genId(),
        objective: request,
        mode: 'autonomous',
        steps: [
          createStep({
            id: 'autonomous',
            title: 'Execute autonomously',
            capability: agent && agent.capabilities[0],
            action: this._autonomousAction(),
          }),
        ],
      });
    }
    if (mode === 'simple') return this._deterministic({ request, agent });
    const fromProvider = this._fromProvider ? await this._fromProvider({ request, agent, signal }) : null;
    if (mode === 'structured') return fromProvider || this._deterministic({ request, agent });
    return fromProvider || this._deterministic({ request, agent });
  }

  async replan(task, reason = 'step failed', signal) {
    if (!task.plan) throw new Error('replan requires an existing plan');
    if (this._logger) this._logger.info(`replanning task ${task.id}`, { reason });
    this._bus.emit(TYPES.TASK_REPLANNED, { taskId: task.id, agentId: task.agentId }, { reason });

    const completedIds = new Set(task.plan.steps.filter((s) => s.status === 'completed').map((s) => s.id));
    let plan = this._deterministic({ request: task.request, agent: task.agentId != null ? task.agent : null });
    if (this._provider) {
      const fromProvider = await this._fromProvider({ request: task.request, agent: task.agent, signal });
      if (fromProvider) plan = fromProvider;
    }
    // A replan must not re-run completed work: regenerate only what's left.
    plan.steps = plan.steps.filter((s) => !completedIds.has(s.id));
    if (plan.steps.length === 0) {
      plan.steps.push(createStep({ id: 'finalize', title: 'Finalize', action: null }));
    }
    return plan;
  }

  resolveTools(step, agent) {
    if (step.tool) return [step.tool.id];
    if (step.action) return null;
    const caps = step.capability ? [step.capability] : agent.capabilities || [];
    return this._tools.discover(agent, { capabilities: caps });
  }

  buildStepGraph(plan) {
    const index = new Map(plan.steps.map((s) => [s.id, s]));
    const adjacency = new Map(plan.steps.map((s) => [s.id, []]));
    for (const s of plan.steps) {
      for (const dep of s.dependsOn) {
        if (adjacency.has(dep)) adjacency.get(dep).push(s.id);
      }
    }
    return { index, adjacency };
  }

  // --- deterministic template ------------------------------------------------
  _deterministic({ request, agent }) {
    const caps = new Set((agent && agent.capabilities) || []);
    let templateKey = 'repository_analysis';
    if (caps.has('code') && caps.has('write')) templateKey = 'code';
    const steps = TEMPLATES[templateKey].map((t) => {
      // Narrative steps (plan/report) run a tiny handler instead of a tool so a
      // provider-less run still produces a useful outcome.
      let action = null;
      if (t.id === 'plan') action = () => ({ ok: true, data: { phase: 'planned' } });
      if (t.id === 'report') action = compileReport;
      return createStep({ ...t, tool: t.tool ? { ...t.tool } : null, action });
    });
    this._bus.emit(TYPES.PLAN_CREATED, {}, { mode: 'deterministic', stepCount: steps.length, template: templateKey });
    return createPlan({ id: genId(), objective: request, mode: 'deterministic', steps });
  }

  // Ask the provider for a structured plan; return null when unavailable.
  async _fromProvider({ request, agent, signal }) {
    if (!this._provider) return null;
    try {
      const result = await this._provider.generate({
        system:
          'Return a JSON object with "steps": array. Each step must have id, title, ' +
          'tool: {id}, and optionally verify:{pattern:string}. No prose.',
        messages: [{ role: 'user', content: request }],
        structured: true,
        maxTokens: 1200,
        signal,
      });
      const stepsRaw = result && Array.isArray(result.structured) ? result.structured : null;
      if (!stepsRaw || stepsRaw.length === 0) return null;
      const steps = stepsRaw.map((s) =>
        createStep({
          id: s.id || genId(),
          title: s.title || s.id || 'step',
          tool: s.tool ? { id: s.tool.id || s.tool, input: s.tool.input || s.input || {} } : undefined,
          capability: s.capability,
          verify: s.verify ? { type: 'output', pattern: new RegExp(s.verify.pattern || '.', 'i') } : null,
        }),
      );
      this._bus.emit(TYPES.PLAN_CREATED, {}, { mode: 'structured', stepCount: steps.length });
      return createPlan({ id: genId(), objective: request, mode: 'structured', steps });
    } catch {
      return null;
    }
  }

  // --- autonomous: one step whose action is a mini tool-choice loop ----------
  _autonomousAction() {
    const tools = this._tools;
    const reasoner = this._reasoner;
    return async function autonomousCycle({ task, context, agent, abort }) {
      const options = tools.discover(agent).map((id) => tools.peek(id)).filter(Boolean);
      const decision = await reasoner.decide(task, options);
      if (!decision.decision) return { ok: false, note: 'no tools available to the agent' };
      const picked = tools.get(decision.decision);
      if (!picked) return { ok: false, note: `tool ${decision.decision} not found` };
      const res = await tools.execute({ id: picked.id, input: {}, agent, taskId: task.id, signal: abort });
      return { ok: res.ok, decision: decision.decision, rationale: decision.rationale, data: res.data };
    };
  }
}

function genId() {
  return `plan-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// Deterministic report step: compile whatever the executed steps produced into
// a single object the task outcome can carry. Uses only verified performed
// outputs (task.steps) — never chain-of-thought.
function compileReport({ task }) {
  const rows = (task.steps || [])
    .filter((s) => s.status === 'completed')
    .map((s) => ({
      step: s.id,
      title: s.title,
      tool: s.tool ? s.tool.id : null,
      ok: s.output ? s.output.ok : null,
      note: s.output && s.output.data && IsObject(s.output.data)
        ? (s.output.data.stdout || s.output.data.note || s.output.data.content || '')
        : (s.output && s.output.data ? String(s.output.data).slice(0, 120) : ''),
    }));
  return {
    ok: true,
    data: {
      request: task.request,
      steps: rows,
      fallback: 'deterministic plan; configure a model provider for richer planning',
    },
  };
}

function IsObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = { Planner, TEMPLATES };