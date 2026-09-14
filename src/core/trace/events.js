// Trace event types and the correlation envelope every one of them carries.
//
// A single-agent run reads fine as a log. A run with a lead agent, two
// delegates and a workflow does not: the lines interleave and nothing says
// which execution a line belongs to. So every trace event carries the full
// identity — trace, task, workspace, agent, project, session — plus a parent
// event id and a monotonic sequence number.
//
// That is what makes the trace reconstructable: filter by traceId to get a run,
// by workspaceId to get one agent's part of it, and follow parentEventId to get
// the tree. The sequence number is per-trace and assigned by the trace itself,
// so ordering survives events that share a millisecond.

const crypto = require('node:crypto');

const TRACE_EVENTS = Object.freeze({
  TASK_CREATED: 'task.created',
  CONTEXT_CREATED: 'context.created',
  PLAN_CREATED: 'plan.created',
  STEP_STARTED: 'step.started',
  STEP_COMPLETED: 'step.completed',
  STEP_FAILED: 'step.failed',
  ACTION: 'action',
  TOOL_CALLED: 'tool.called',
  TOOL_RESULT: 'tool.result',
  OBSERVATION: 'observation',
  EVALUATION: 'evaluation',
  RECOVERY: 'recovery',
  REPLAN: 'replan',
  VALIDATION: 'validation',
  FILE_CHANGED: 'file.changed',
  ARTIFACT_CREATED: 'artifact.created',
  MEMORY_WRITTEN: 'memory.written',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',
  AGENT_MESSAGE: 'agent.message',
  DELEGATION: 'delegation',
  HANDOFF: 'handoff',
  SNAPSHOT: 'snapshot',
  COMPLETION: 'completion',
  FAILURE: 'failure',
  CANCELLED: 'cancelled',
});

const ALL_TRACE_EVENTS = Object.freeze(Object.values(TRACE_EVENTS));

// Keys that must never be written into a trace, whatever a caller passes. The
// trace is operational telemetry — what ran, what it produced — and is
// persisted and shown to users; private deliberation belongs in neither.
const FORBIDDEN_KEYS = Object.freeze([
  'chainofthought', 'chain_of_thought', 'reasoning', 'thoughts', 'thought',
  'deliberation', 'scratchpad', 'internalmonologue', 'rawprompt', 'systemprompt',
]);

function isForbiddenKey(key) {
  const norm = String(key).toLowerCase().replace(/[-_\s]/g, '');
  return FORBIDDEN_KEYS.some((f) => norm === f.replace(/[-_]/g, ''));
}

function newTraceEventId() {
  return `tev-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function createTraceEvent({
  type,
  identity = {},
  parentEventId = null,
  payload = null,
  seq = 0,
  level = 'info',
} = {}) {
  if (!type) throw new Error('a trace event requires a type');
  return Object.freeze({
    eventId: newTraceEventId(),
    type,
    seq,
    level,
    timestamp: Date.now(),
    traceId: identity.traceId || null,
    taskId: identity.taskId || null,
    workspaceId: identity.workspaceId || null,
    agentId: identity.agentId || null,
    projectId: identity.projectId || null,
    sessionId: identity.sessionId || null,
    parentEventId,
    payload: payload === undefined ? null : payload,
  });
}

// The fields a caller must be able to correlate on; used by tests and by the
// IPC layer to check that nothing is emitting half-identified events.
const CORRELATION_FIELDS = Object.freeze([
  'eventId', 'taskId', 'workspaceId', 'agentId', 'projectId', 'sessionId',
  'traceId', 'parentEventId', 'timestamp',
]);

function isCorrelated(event) {
  return Boolean(event && event.eventId && event.traceId && typeof event.timestamp === 'number');
}

module.exports = {
  TRACE_EVENTS, ALL_TRACE_EVENTS, CORRELATION_FIELDS, FORBIDDEN_KEYS,
  createTraceEvent, newTraceEventId, isCorrelated, isForbiddenKey,
};
