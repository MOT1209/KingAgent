// The executor: walks plan steps against the tool manager.
//
// Each step either calls a tool (via toolManager.execute) or runs an injected
// action function. The executor runs steps in topological order, skips parallel
// groups correctly, collects outputs and hands them back to the runtime for
// evaluation.

const { recordAttempt, addStepLog } = require('../runtime/task');
const { TYPES } = require('../events/event-bus');

class Executor {
  constructor({ toolManager, bus, logger }) {
    this._tools = toolManager;
    this._bus = bus;
    this._logger = logger || null;
  }

  // `agent` is the normalized agent object (definition.js); `context` is from
  // buildTaskContext; `task` is the task instance. Returns { stepId, ok, data, error, durationMs }
  async runStep(task, step, { agent, context, signal }) {
    const attempt = recordAttempt(task, step.id);
    step.attempts = attempt;
    step.status = 'executing';
    step.startedAt = Date.now();
    addStepLog(task, { stepId: step.id, action: 'start', attempt });
    this._bus.emit(TYPES.STEP_STARTED, { taskId: task.id, agentId: agent.id, nodeId: step.id }, { attempt });

    if (signal && signal.aborted) { return this._fail(task, step, { message: 'aborted', code: 'ABORTED' }); }

    try {
      let data;
      if (typeof step.action === 'function') {
        data = await step.action({ task, step, context, agent, abort: signal });
      } else {
        const toolInput = step.tool && step.tool.input;
        const input = typeof toolInput === 'function'
          ? await toolInput({ task, step, context, agent })
          : (toolInput || {});
        data = await this._tools.execute({ id: step.tool.id, input, agent, taskId: task.id, signal });
      }
      step.status = 'completed';
      step.completedAt = Date.now();
      step.output = { ok: true, data, durationMs: step.completedAt - step.startedAt };
      addStepLog(task, { stepId: step.id, action: 'complete', attempt });
      this._bus.emit(TYPES.STEP_COMPLETED, { taskId: task.id, agentId: agent.id, nodeId: step.id }, { attempt, durationMs: step.output.durationMs });
      return step.output;
    } catch (err) {
      return this._fail(task, step, err);
    }
  }

  // Convenience: execute a subset of steps that have no unmet dependencies.
  // The runtime uses this in the main execution loop.
  async readySteps(plan, _agent, _context, _task, _signal) {
    const completed = new Set(plan.steps.filter((s) => s.status === 'completed').map((s) => s.id));
    return plan.steps.filter((s) => s.status === 'pending' && s.dependsOn.every((d) => completed.has(d)));
  }

  _fail(task, step, err) {
    step.status = 'failed';
    step.completedAt = Date.now();
    const error = err instanceof Error ? err : new Error(String(err));
    step.output = { ok: false, error: error.message, code: err.code, durationMs: step.completedAt - step.startedAt };
    addStepLog(task, { stepId: step.id, action: 'fail', attempt: step.attempts, error: error.message, code: err.code });
    this._bus.emit(TYPES.STEP_FAILED, { taskId: task.id, agentId: task.agentId, nodeId: step.id }, { error: error.message, code: err.code });
    return step.output;
  }
}

module.exports = { Executor };