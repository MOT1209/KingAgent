// Evaluator: decide whether a step or a whole task succeeded and what next.
//
// The evaluator is called after every step execution. By default it trusts the
// tool's own `ok` flag plus an optional verify rule; when a provider is
// available, a lightweight LLM-as-judge pass replaces the heuristic.

const { isPlainObject } = require('../schema/validate');

class Evaluator {
  constructor({ provider = null, logger = null } = {}) {
    this._provider = provider;
    this._logger = logger;
  }

  async evaluateStep(task, step, result, context) {
    if (this._provider) {
      try {
        const r = await this._provider.generate({
          system: 'Return { passed:boolean, reason:string, next:"continue"|"replan"|"fail" }. No prose.',
          messages: [{ role: 'user', content: formatForJudge(task, step, result) }],
          structured: true,
          maxTokens: 200,
        });
        const v = r.structured;
        return {
          passed: Boolean(v.passed),
          reason: String(v.reason || '').slice(0, 200),
          next: v.next || (v.passed ? 'continue' : 'replan'),
        };
      } catch { /* fall through */ }
    }
    return defaultEvaluate(step, result);
  }

  async evaluateTask(task, plan) {
    const allPass = plan.steps.every((s) => s.status === 'completed');
    return {
      passed: allPass,
      summary: allPass
        ? `all ${plan.steps.length} steps completed`
        : `failed at step ${failedStep(plan)}`,
    };
  }
}

function defaultEvaluate(step, result) {
  const ok = isPlainObject(result) ? Boolean(result.ok) : false;
  let pass = ok;
  // Verify: step.verify.pattern is a regex applied to the textual output.
  if (ok && step.verify && step.verify.pattern) {
    const data = isPlainObject(result.data) ? result.data : result;
    const text = typeof data.stdout === 'string' ? data.stdout : typeof data === 'string' ? data : JSON.stringify(data);
    pass = new RegExp(step.verify.pattern).test(text);
  }
  return {
    passed: pass,
    reason: pass ? (step.verify ? 'verify passed' : 'tool reported success') : (result.error ? result.error.slice(0, 120) : 'tool reported failure'),
    next: pass ? 'continue' : 'replan',
  };
}

function failedStep(plan) {
  const idx = plan.steps.findIndex((s) => s.status === 'failed');
  return idx >= 0 ? plan.steps[idx].id : 'unknown';
}

function formatForJudge(task, step, result) {
  return `task: ${task.id}\nstep: ${step.title}\nresult ok: ${result.ok}\n` +
    `output: ${JSON.stringify(result.data || result.error || '').slice(0, 300)}`;
}

module.exports = { Evaluator };