// IPC guard: the only shape renderer → main traffic may take.
//
// Every channel the preload can invoke is listed here with its payload schema.
// The platform's IPC wiring routes through validatePayload before touching any
// subsystem, so a compromised renderer cannot smuggle a larger object graph
// into agent create/change code.

const { isString, isBoolean, validId } = require('../schema/validate');

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

  // --- Phase 4: the Agent Control Center -------------------------------------
  // Everything here is read-only except `agent:route` (a dry run that creates
  // nothing) and `agent:cancelTask` (which stops work the user already asked
  // for). There is deliberately no channel that can raise a permission, add a
  // policy or widen a sandbox: those only ever come from a human in the app's
  // own flows, never from a renderer payload.
  'agent:controlCenter': { sessionId: { check: isString }, taskId: { check: isString } },
  'agent:harnesses': {},
  'agent:harnessDetect': { id: { check: isString } },
  'agent:sandboxes': {},
  'agent:sandbox': { id: { required: true, check: isString } },
  'agent:policies': {},
  'agent:policyAudit': { limit: { check: isString } },
  'agent:explainPolicy': {
    action: { required: true, check: isString },
    agentId: { check: validId },
    taskId: { check: isString },
    toolId: { check: isString },
    harnessId: { check: isString },
    workspaceId: { check: isString },
  },
  'agent:sessions': {},
  'agent:session': { id: { required: true, check: isString } },
  'agent:artifacts': { taskId: { check: isString }, sessionId: { check: isString }, type: { check: isString }, limit: { check: isString } },
  'agent:artifact': { id: { required: true, check: isString } },
  'agent:delegations': { taskId: { required: true, check: isString } },
  'agent:route': { request: { required: true, check: isString }, strategy: { check: isString }, agentId: { check: validId }, harnessId: { check: isString } },
  'agent:cancelTask': { taskId: { required: true, check: isString }, sessionId: { check: isString } },
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

module.exports = { CHANNELS, PUSH_CHANNELS, validatePayload, allowedChannel };