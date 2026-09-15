// Observation: what the agent learned, as a value.
//
// The loop Phase 3 is built around is context → plan → action → observation →
// evaluation → next action. Before this, the "observation" half was an ad-hoc
// object shaped by whichever tool produced it, which meant nothing downstream —
// the evaluator, the trace, the memory candidate scorer — could rely on it.
//
// An observation is a *result*, never a rationale. It carries what happened and
// a short factual summary, so it is safe to persist, safe to show a user, and
// carries no private deliberation.

const crypto = require('node:crypto');

const SOURCES = Object.freeze({
  TOOL: 'tool',
  BROWSER: 'browser',
  TERMINAL: 'terminal',
  FILESYSTEM: 'filesystem',
  WORKFLOW: 'workflow',
  HUMAN: 'human',
  SYSTEM: 'system',
  AGENT: 'agent',
});

const OBSERVATION_TYPES = Object.freeze({
  RESULT: 'result',
  ERROR: 'error',
  FILE_CHANGE: 'file_change',
  OUTPUT: 'output',
  STATE: 'state',
  MESSAGE: 'message',
});

const MAX_SUMMARY = 240;
const MAX_DATA_CHARS = 20_000;

function newObservationId() {
  return `obs-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function boundData(data) {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') return data.length > MAX_DATA_CHARS ? `${data.slice(0, MAX_DATA_CHARS)}…` : data;
  try {
    const text = JSON.stringify(data);
    if (text.length <= MAX_DATA_CHARS) return data;
    return { truncated: true, chars: text.length, preview: text.slice(0, MAX_DATA_CHARS) };
  } catch {
    return { unserializable: true };
  }
}

function createObservation({
  id = null,
  type = OBSERVATION_TYPES.RESULT,
  source = SOURCES.SYSTEM,
  summary = '',
  data = null,
  ok = null,
  identity = {},
  stepId = null,
  toolId = null,
  parentEventId = null,
  metadata = {},
} = {}) {
  return Object.freeze({
    id: id || newObservationId(),
    type,
    source,
    summary: String(summary).slice(0, MAX_SUMMARY),
    data: boundData(data),
    ok,
    stepId,
    toolId,
    taskId: identity.taskId || null,
    workspaceId: identity.workspaceId || null,
    agentId: identity.agentId || null,
    projectId: identity.projectId || null,
    sessionId: identity.sessionId || null,
    traceId: identity.traceId || null,
    parentEventId,
    metadata: { ...metadata },
    timestamp: Date.now(),
  });
}

// The common case: a ToolManager result (or failure) becomes an observation.
function observationFromToolResult(result, { identity, stepId = null, toolId = null, error = null }) {
  if (error) {
    return createObservation({
      type: OBSERVATION_TYPES.ERROR,
      source: SOURCES.TOOL,
      summary: `${toolId || 'tool'} failed: ${String(error.message || error).slice(0, 180)}`,
      data: { code: error.code || null },
      ok: false,
      identity, stepId, toolId,
    });
  }
  const data = result && result.data !== undefined ? result.data : result;
  return createObservation({
    type: OBSERVATION_TYPES.RESULT,
    source: SOURCES.TOOL,
    summary: summarizeToolData(toolId, data),
    data,
    ok: result ? result.ok !== false : true,
    identity, stepId, toolId,
  });
}

// Factual one-liners only — counts, paths, exit codes. Never an interpretation.
function summarizeToolData(toolId, data) {
  if (data === null || data === undefined) return `${toolId || 'tool'} returned nothing`;
  if (typeof data === 'string') return `${toolId || 'tool'}: ${data.slice(0, 120)}`;
  if (Array.isArray(data)) return `${toolId || 'tool'} returned ${data.length} items`;
  if (typeof data === 'object') {
    if (Array.isArray(data.entries)) return `${toolId}: ${data.entries.length} entries`;
    if (Array.isArray(data.matches)) return `${toolId}: ${data.matches.length} matches`;
    if (typeof data.exitCode === 'number') return `${toolId}: exit ${data.exitCode}`;
    if (typeof data.path === 'string') return `${toolId}: ${data.path}`;
  }
  return `${toolId || 'tool'} completed`;
}

module.exports = { SOURCES, OBSERVATION_TYPES, createObservation, observationFromToolResult, summarizeToolData, newObservationId };
