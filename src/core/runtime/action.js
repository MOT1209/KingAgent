// Action: what the agent is about to do, as a value.
//
// The mirror of observation.js. An action is declared before it runs, so the
// trace records intent-then-outcome rather than only outcome, and so a pause or
// an approval has something concrete to hold.
//
// It carries parameters, not reasoning. "Why the agent chose this" is exactly
// the private deliberation that must not be persisted or shown, so the field
// does not exist — the most a caller may attach is a short factual `intent`
// string, which is bounded and user-facing by design.

const crypto = require('node:crypto');

const ACTION_TYPES = Object.freeze({
  READ_FILE: 'read_file',
  WRITE_FILE: 'write_file',
  DELETE_FILE: 'delete_file',
  RUN_COMMAND: 'run_command',
  OPEN_BROWSER: 'open_browser',
  SEARCH_WEB: 'search_web',
  CALL_MCP: 'call_mcp',
  RUN_TEST: 'run_test',
  REQUEST_APPROVAL: 'request_approval',
  DELEGATE_AGENT: 'delegate_agent',
  SEND_MESSAGE: 'send_message',
  CREATE_ARTIFACT: 'create_artifact',
  TOOL_CALL: 'tool_call',
});

// Actions that change something outside the process and are not trivially
// undoable. The approval manager uses this; recovery uses it to refuse to
// replay an interrupted action blindly.
const MUTATING = new Set([
  ACTION_TYPES.WRITE_FILE, ACTION_TYPES.DELETE_FILE, ACTION_TYPES.RUN_COMMAND,
  ACTION_TYPES.CALL_MCP, ACTION_TYPES.DELEGATE_AGENT, ACTION_TYPES.CREATE_ARTIFACT,
]);

const MAX_INTENT = 200;

function newActionId() {
  return `act-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function createAction({
  id = null,
  type = ACTION_TYPES.TOOL_CALL,
  target = null,
  parameters = {},
  toolId = null,
  stepId = null,
  identity = {},
  parentEventId = null,
  intent = '',
  metadata = {},
} = {}) {
  return Object.freeze({
    id: id || newActionId(),
    type,
    target,
    parameters: { ...parameters },
    toolId,
    stepId,
    taskId: identity.taskId || null,
    workspaceId: identity.workspaceId || null,
    agentId: identity.agentId || null,
    projectId: identity.projectId || null,
    sessionId: identity.sessionId || null,
    traceId: identity.traceId || null,
    parentEventId,
    intent: String(intent).slice(0, MAX_INTENT),
    mutating: MUTATING.has(type),
    metadata: { ...metadata },
    timestamp: Date.now(),
  });
}

// Tool id → action type, so a tool call lands in the trace as the thing it
// actually is rather than as a generic "tool_call".
const TOOL_ACTION = Object.freeze({
  'fs:read': ACTION_TYPES.READ_FILE,
  'fs:list': ACTION_TYPES.READ_FILE,
  'fs:exists': ACTION_TYPES.READ_FILE,
  'fs:write': ACTION_TYPES.WRITE_FILE,
  'fs:mkdir': ACTION_TYPES.WRITE_FILE,
  'fs:delete': ACTION_TYPES.DELETE_FILE,
  'terminal:run': ACTION_TYPES.RUN_COMMAND,
  'search:grep': ACTION_TYPES.READ_FILE,
});

function actionForTool(toolId, input, { identity, stepId = null, intent = '' } = {}) {
  return createAction({
    type: TOOL_ACTION[toolId] || ACTION_TYPES.TOOL_CALL,
    target: (input && (input.path || input.command || input.dir)) || null,
    parameters: input || {},
    toolId,
    stepId,
    identity,
    intent,
  });
}

function isMutating(action) {
  return Boolean(action && action.mutating);
}

module.exports = { ACTION_TYPES, MUTATING, createAction, actionForTool, isMutating, TOOL_ACTION, newActionId };
