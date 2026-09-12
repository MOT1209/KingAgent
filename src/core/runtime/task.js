// The task model: a task is what a user request becomes inside the runtime.
//
// Pure factory + helper functions (no side effects). The TaskManager owns
// mutation; these functions define the shape so IPC payloads, persistence and
// the trace code all agree on what a task looks like.

const { STATES } = require('./states');

function createTask({
  id,
  request,
  agentId = null,
  workspace = null,
  mode = 'auto', // 'auto' | 'simple' | 'structured' | 'autonomous'
  options = {},
}) {
  if (!id) throw new Error('Task requires an id');
  if (typeof request !== 'string' || request.trim() === '') throw new Error('Task requires a non-empty request');

  return {
    id,
    request,
    agentId,
    workspace, // { root, cwd, env? } resolved by the platform (never a hardcoded OS path)
    mode,
    options,
    state: STATES.CREATED,
    plan: null,
    phase: 'created', // human label: analyzing | planning | executing | done | failed
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    updatedAt: Date.now(),
    steps: [], // plan steps mirrored here as they execute
    stepLog: [], // chronological { stepId, action, at } audit trail
    attempts: {}, // stepId -> retry count
    trace: [], // events already appended (bounded)
    outcome: null, // set at terminal state: { status, summary?, error?, result? }
    cancellation: { requestedAt: null, reason: null },
  };
}

// A snapshot safe to send over IPC / store: plain data only, no functions.
function snapshot(task) {
  return {
    id: task.id,
    request: task.request,
    agentId: task.agentId,
    workspace: task.workspace,
    mode: task.mode,
    state: task.state,
    phase: task.phase,
    plan: task.plan,
    steps: task.steps,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    outcome: task.outcome,
    cancellation: task.cancellation,
  };
}

function addStepLog(task, entry) {
  task.stepLog.push({ ...entry, at: Date.now() });
  if (task.stepLog.length > 2000) task.stepLog.splice(0, task.stepLog.length - 2000);
}

function recordAttempt(task, stepId) {
  task.attempts[stepId] = (task.attempts[stepId] || 0) + 1;
  return task.attempts[stepId];
}

function appendTrace(task, event) {
  task.trace.push(event);
  if (task.trace.length > 500) task.trace.splice(0, task.trace.length - 500);
}

// Compact view for list screens and log lines.
function summarize(task) {
  return {
    id: task.id,
    request: task.request.slice(0, 120),
    agentId: task.agentId,
    state: task.state,
    phase: task.phase,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    error: task.outcome && task.outcome.error ? task.outcome.error : null,
  };
}

module.exports = { createTask, snapshot, addStepLog, recordAttempt, appendTrace, summarize };