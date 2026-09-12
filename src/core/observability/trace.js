// Trace: derive a human-readable execution trace from a task's internal state.
//
// This is the object the UI and the docs should consume: an ordered log of what
// happened, what each step produced, and the final outcome. The trace never
// contains chain-of-thought strings from the model — only tool outputs, error
// messages, durations and outcomes the user asked for.

const { snapshot, summarize } = require('./task');

function buildTrace(task) {
  const steps = (task.steps || []).map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    attempts: s.attempts || 0,
    toolId: (s.tool && s.tool.id) || null,
    output: s.output ? { ok: s.output.ok, durationMs: s.output.durationMs, error: s.output.error || null } : null,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
  }));

  const events = (task.trace || []).map((ev) => ({
    type: ev.type || ev.action || 'event',
    stepId: ev.stepId || ev.nodeId || ev.toolId || null,
    at: ev.at || ev.timestamp || null,
    payload: ev.payload || ev,
  }));

  return {
    task: summarize(task),
    plan: task.plan
      ? { id: task.plan.id, objective: task.plan.objective, mode: task.plan.mode, stepCount: task.plan.steps.length }
      : null,
    steps,
    events: events.slice(-500),
    outcome: task.outcome,
    durationMs: task.completedAt && task.startedAt ? task.completedAt - task.startedAt : null,
  };
}

module.exports = { buildTrace };