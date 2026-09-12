// Reasoning abstraction: analyze → decide → evaluate → diagnose.
//
// Every method returns only the keys the caller needs — the `rationale` field
// is always a short string and never the raw chain of thought. When no provider
// is configured, deterministic rules give valid results so the runtime still
// makes progress.

const { TYPES } = require('../events/event-bus');

class Reasoner {
  constructor({ provider, bus, logger }) {
    this._provider = provider;
    this._bus = bus;
    this._logger = logger || null;
  }

  async analyze(task, context) {
    this._bus.emit(TYPES.TASK_ANALYZING, { taskId: task.id, agentId: task.agentId });
    if (!this._provider) return deterministicAnalyze(task);
    try {
      const result = await this._provider.generate({
        system:
          'Analyze the user request and workspace state. Return a JSON object with exactly ' +
          'keys: { interpretation: string, goal: string, constraints: string[], risks: string[] }.',
        messages: [{ role: 'user', content: task.request }],
        structured: true,
        maxTokens: 600,
        signal: task._signal,
      });
      const v = result.structured;
      return {
        interpretation: typeof v.interpretation === 'string' ? v.interpretation.slice(0, 500) : task.request,
        goal: typeof v.goal === 'string' ? v.goal.slice(0, 500) : task.request,
        constraints: Array.isArray(v.constraints) ? v.constraints.slice(0, 10) : [],
        risks: Array.isArray(v.risks) ? v.risks.slice(0, 10) : [],
      };
    } catch (err) {
      if (this._logger) this._logger.warn('reasoning.analyze failed', { error: err.message });
      return deterministicAnalyze(task);
    }
  }

  async decide(task, options) {
    if (this._provider && options.length) {
      const list = options.map((o) => `- id: ${o.id}, name: ${o.name || o.id}, description: ${(o.description || '').slice(0, 80)}`).join('\n');
      try {
        const result = await this._provider.generate({
          system:
            `You are choosing the next action for task ${task.id}. Return a JSON object with exactly ` +
            'keys: { decision: string, rationale: string, actions: [{ id, confidence: 0-1 }] }.',
          messages: [{ role: 'user', content: `Request: ${task.request}\n\nOptions:\n${list}` }],
          structured: true,
          maxTokens: 400,
          signal: task._signal,
        });
        const v = result.structured;
        return {
          decision: v.decision || options[0].id,
          rationale: typeof v.rationale === 'string' ? v.rationale.slice(0, 200) : '',
          actions: Array.isArray(v.actions) ? v.actions.slice(0, 5) : options.map((o) => ({ id: o.id, confidence: 0.5 })),
        };
      } catch {
        /* deterministic below */
      }
    }
    return deterministicDecide(task, options);
  }

  async evaluateStep(task, step, result) {
    if (this._provider) {
      try {
        const r = await this._provider.generate({
          system:
            'Evaluate the step result. Return { passed: boolean, reason: string, next: "continue"|"replan"|"fail" }.',
          messages: [
            { role: 'user', content: `step: ${step.title}\nresult ok: ${result.ok}\noutput: ${JSON.stringify(result.data || '').slice(0, 300)}` },
          ],
          structured: true,
          maxTokens: 200,
          signal: task._signal,
        });
        const v = r.structured;
        return { passed: Boolean(v.passed), reason: String(v.reason || '').slice(0, 200), next: v.next || 'continue' };
      } catch { /* deterministic below */ }
    }
    return deterministicEvaluate(step, result);
  }

  async diagnose(task, error) {
    const msg = error && error.message ? error.message : String(error);
    if (this._provider) {
      try {
        const r = await this._provider.generate({
          system: 'Return { cause: string, category: string, proposedFix: string }. No prose.',
          messages: [{ role: 'user', content: `error: ${msg}\nrequest: ${task.request}` }],
          structured: true,
          maxTokens: 300,
          signal: task._signal,
        });
        const v = r.structured;
        return {
          cause: String(v.cause || msg).slice(0, 400),
          category: v.category || 'unknown',
          proposedFix: String(v.proposedFix || '').slice(0, 400),
        };
      } catch { /* deterministic below */ }
    }
    return deterministicDiagnose(error);
  }
}

// --- deterministic fallbacks -------------------------------------------------

function deterministicAnalyze(task) {
  const workspace = task.workspace && task.workspace.root ? ` in ${task.workspace.root}` : '';
  return {
    interpretation: `The user wants: ${task.request}${workspace}`,
    goal: task.request,
    constraints: task.options && task.options.constraints ? task.options.constraints : [],
    risks: [],
  };
}

function deterministicDecide(task, options) {
  return {
    decision: options.length ? options[0].id : null,
    rationale: options.length ? 'chose first available option' : 'no options',
    actions: options.slice(0, 5).map((o) => ({ id: o.id, confidence: 0.5 })),
  };
}

function deterministicEvaluate(step, result) {
  const passed = Boolean(result && result.ok);
  return {
    passed,
    reason: passed ? 'tool reported success' : 'tool reported failure',
    next: passed ? 'continue' : 'replan',
  };
}

function deterministicDiagnose(error) {
  const msg = error && error.message ? error.message : String(error);
  const category = /timeout/i.test(msg)
    ? 'timeout'
    : /permission|denied|eacces|eperm/i.test(msg)
      ? 'permission'
      : 'unknown';
  return {
    cause: msg.slice(0, 400),
    category,
    proposedFix: category === 'timeout' ? 'increase timeout or simplify the operation' : 'retry or check permissions',
  };
}

module.exports = { Reasoner };