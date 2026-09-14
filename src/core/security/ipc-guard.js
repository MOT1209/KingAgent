// IPC guard: the only shape renderer → main traffic may take.
//
// Every channel the preload can invoke is listed here with its payload schema.
// The platform's IPC wiring routes through validatePayload before touching any
// subsystem, so a compromised renderer cannot smuggle a larger object graph
// into agent create/change code.

const { isString, isBoolean, validId } = require('../schema/validate');

// A renderer-supplied id is an untrusted string used as a store key and a map
// lookup, so it is shape-checked before it reaches a subsystem. Phase 3 ids are
// prefixed and hex-suffixed (`ws-…`, `trace-…`, `art-…`); this accepts that
// alphabet and nothing else — no separators, no traversal, no length to abuse.
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
function isOpaqueId(v) {
  return typeof v === 'string' && OPAQUE_ID.test(v);
}

// Free text from the renderer (a memory query, a decision note). Bounded so a
// compromised renderer cannot push a megabyte through a channel that expects a
// phrase.
function isShortText(v) {
  return typeof v === 'string' && v.length <= 2000;
}

const CHANNELS = Object.freeze({
  'agent:listAgents': {},
  'agent:get': { id: { required: true, check: validId } },
  'agent:runTask': { request: { required: true, check: isString }, agentId: { check: validId }, workspace: {}, mode: { check: isString } },
  'agent:pause': { id: { required: true, check: isString } },
  'agent:resume': { id: { required: true, check: isString } },
  'agent:cancel': { id: { required: true, check: isString } },
  'agent:listTasks': {},
  'agent:task': { id: { required: true, check: isString } },
  'agent:history': { id: { required: true, check: isString } },
  'agent:listTools': {},
  'workflow:list': {},
  'workflow:run': { workflowId: { required: true, check: isString }, inputs: {} },
  'workflow:get': { id: { required: true, check: isString } },
  'workflow:cancel': { id: { required: true, check: isString } },
  'workflow:listInstances': {},
'agent:authorizeResponse': { requestId: { required: true, check: isString }, approved: { required: true, check: isBoolean } },

  // --- Phase 3 ---------------------------------------------------------------
  // Orchestration
  'orchestrator:run': {
    request: { required: true, check: isShortText },
    agentId: { check: validId },
    workspace: {},
    mode: { check: isString },
    sessionId: { check: isOpaqueId },
  },
  'orchestrator:route': { request: { required: true, check: isShortText }, agentId: { check: validId }, mode: { check: isString } },
  'orchestrator:get': { id: { required: true, check: isOpaqueId } },
  'orchestrator:list': {},
  'orchestrator:cancel': { id: { required: true, check: isOpaqueId } },
  'orchestrator:policies': {},

  // Workspaces
  'workspace:get': { id: { required: true, check: isOpaqueId } },
  'workspace:list': {},
  'workspace:files': { id: { required: true, check: isOpaqueId } },

  // Execution traces
  'trace:get': { id: { required: true, check: isOpaqueId } },
  'trace:list': {},
  'trace:activity': { id: { required: true, check: isOpaqueId } },

  // Artifacts. Reads are scoped to the owning workspace on the main side; the
  // renderer names a workspace, it never names "all artifacts".
  'artifact:list': { workspaceId: { check: isOpaqueId }, taskId: { check: isOpaqueId }, type: { check: isString } },
  'artifact:get': { id: { required: true, check: isOpaqueId }, workspaceId: { required: true, check: isOpaqueId } },

  // Memory. There is no "read any memory" channel: a query is answered under
  // the named workspace's policy, so the renderer cannot widen a scope.
  'memory:search': { workspaceId: { required: true, check: isOpaqueId }, query: { check: isShortText }, limit: {} },
  'memory:list': { workspaceId: { required: true, check: isOpaqueId }, scope: { check: isString } },

  // Approvals
  'approval:pending': { taskId: { check: isOpaqueId } },
  'approval:decide': {
    id: { required: true, check: isOpaqueId },
    approved: { required: true, check: isBoolean },
    note: { check: isShortText },
  },

  // State / recovery
  'state:interrupted': {},
  'state:resume': { taskId: { required: true, check: isOpaqueId } },
  'state:snapshot': { taskId: { required: true, check: isOpaqueId } },

  // Project
  'project:detect': { root: { required: true, check: isString } },

  // Multi-agent
  'agents:lifecycles': { taskId: { check: isOpaqueId } },
  'agents:messages': { taskId: { required: true, check: isOpaqueId } },
});

const PUSH_CHANNELS = Object.freeze(['agent:event', 'workflow:event', 'approval:event']);

function validatePayload(channel, payload) {
  const schema = CHANNELS[channel];
  if (schema === undefined) {
    throw new Error(`forbidden channel: ${channel}`);
  }
  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (payload === undefined || payload === null) {
      if (rule.required) throw new Error(`channel ${channel}: missing required field "${key}"`);
      continue;
    }
    const val = payload[key];
    if (val === undefined) {
      if (rule.required) throw new Error(`channel ${channel}: missing required field "${key}"`);
      continue;
    }
    if (rule.check && !rule.check(val)) throw new Error(`channel ${channel}: invalid "${key}"`);
    out[key] = val;
  }
  return out;
}

function allowedChannel(channel) {
  return channel in CHANNELS;
}

module.exports = { CHANNELS, PUSH_CHANNELS, validatePayload, allowedChannel, isOpaqueId, isShortText };