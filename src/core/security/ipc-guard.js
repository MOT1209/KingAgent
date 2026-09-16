// IPC guard: the only shape renderer → main traffic may take.
//
// Every channel the preload can invoke is listed here with its payload schema.
// The platform's IPC wiring routes through validatePayload before touching any
// subsystem, so a compromised renderer cannot smuggle a larger object graph
// into agent create/change code.

const { isString, isBoolean, isPlainObject, validId } = require('../schema/validate');

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

// A taxonomy category, a lifecycle state, a source type, a git ref: short,
// lowercase-ish tokens. Deliberately narrower than free text — these values end
// up in filters, action strings and (for a ref) a URL path.
const SKILL_TERM = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,120}$/;
function isSkillTerm(v) {
  return typeof v === 'string' && SKILL_TERM.test(v) && !v.includes('..');
}

// `owner/repo`, with no segment that is `.` or `..`.
const REPOSITORY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
function isRepository(v) {
  return typeof v === 'string' && REPOSITORY.test(v);
}

// A relative path inside a source. The source adapters check this again; a
// renderer payload should not even reach them with a traversal in it.
function isRelPath(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 300) return false;
  if (v.startsWith('/') || v.startsWith('\\') || /^[A-Za-z]:/.test(v)) return false;
  return v.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

// A research question is longer than a memory query and shorter than a
// document. 4000 characters is generous for a question and still bounded.
function isQuestion(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 4000;
}

// A bounded list of short strings: file paths, domains, source types. Every
// research channel that takes a list takes one of these, so a compromised
// renderer cannot push an unbounded array through.
function isShortList(max = 200, maxLen = 1024) {
  return (v) => Array.isArray(v) && v.length <= max
    && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= maxLen);
}

// Numeric caps a renderer may tighten but never loosen — the main side clamps
// them against the configured ceilings before they reach the engine.
function isLimits(v) {
  if (!isPlainObject(v)) return false;
  const allowed = ['maxQueries', 'maxSources', 'maxConcurrency', 'timeoutMs'];
  return Object.entries(v).every(([k, n]) => allowed.includes(k) && Number.isInteger(n) && n > 0 && n <= 1_000_000);
}

const RESEARCH_MODES = ['quick', 'standard', 'deep'];
const isResearchMode = (v) => typeof v === 'string' && RESEARCH_MODES.includes(v);
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

  // --- Phase 4: the Agent Control Center (src/core/harness-orchestrator/) ---
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

  // --- Phase 6: skills (src/core/skills/) and the MCP capability layer -------
  //
  // Unlike the Phase 4 block above, some of these channels *do* change state —
  // installing, enabling and removing a skill are things a user does from the
  // skills pane. Each one is still a request, never a grant: the main side runs
  // the same validation, policy evaluation and approval flow the CLI does, and
  // there is deliberately no channel that can raise a skill's trust, skip its
  // scan, or release it from quarantine without the app's own flow (see
  // `skill:release`, which takes no actor from the renderer — the main process
  // supplies the signed-in user).
  'skill:list': { category: { check: isSkillTerm }, state: { check: isSkillTerm }, query: { check: isShortText }, sourceType: { check: isSkillTerm } },
  'skill:get': { id: { required: true, check: validId }, version: { check: isSkillTerm } },
  'skill:content': { id: { required: true, check: validId } },
  'skill:search': { query: { required: true, check: isShortText }, includeRemote: { check: isBoolean }, limit: {} },
  'skill:discover': { request: { required: true, check: isShortText } },
  'skill:plan': { request: { required: true, check: isShortText } },
  'skill:sources': {},
  'skill:audit': {},
  'skill:benchmark': {},
  // Installation names a source and an identifier. The repository/ref/path
  // shapes are validated again on the main side by the source adapters, which
  // is where traversal and ref-injection are actually refused.
  'skill:inspect': {
    source: { required: true, check: isSkillTerm },
    id: { check: validId },
    repository: { check: isRepository },
    ref: { check: isSkillTerm },
    path: { check: isRelPath },
  },
  'skill:install': {
    source: { required: true, check: isSkillTerm },
    id: { check: validId },
    repository: { check: isRepository },
    ref: { check: isSkillTerm },
    path: { check: isRelPath },
  },
  'skill:update': { id: { required: true, check: validId } },
  'skill:updates': {},
  'skill:remove': { id: { required: true, check: validId }, force: { check: isBoolean } },
  'skill:enable': { id: { required: true, check: validId } },
  'skill:disable': { id: { required: true, check: validId } },
  'skill:quarantine': { id: { required: true, check: validId }, reason: { required: true, check: isShortText } },
  // No `actor` field on purpose: releasing a quarantine is attributed to the
  // signed-in user by the main process, not to a name the renderer chose.
  'skill:release': { id: { required: true, check: validId }, note: { check: isShortText } },

  'mcp:list': {},
  'mcp:get': { id: { required: true, check: validId } },
  'mcp:inspect': { id: { required: true, check: validId } },
  'mcp:explain': { id: { required: true, check: validId } },
  'mcp:testPlan': { id: { required: true, check: validId } },
  'mcp:remove': { id: { required: true, check: validId } },
  'mcp:quarantine': { id: { required: true, check: validId }, reason: { required: true, check: isShortText } },

  // --- Phase 7: research (src/core/research/) -------------------------------
  //
  // `research:start` is the only channel here that spends anything, and every
  // field on it *narrows*: a renderer can restrict research to files, block
  // domains or lower a limit, and there is deliberately no field that can widen
  // a domain allowlist past the configured policy, raise a ceiling, or name a
  // provider. Those come from settings and policy, never from a payload.
  'research:start': {
    question: { required: true, check: isQuestion },
    mode: { check: isResearchMode },
    files: { check: isShortList(200, 4096) },
    filesOnly: { check: isBoolean },
    allowWeb: { check: isBoolean },
    sourcePreferences: { check: isShortList(16, 32) },
    allowedDomains: { check: isShortList(500, 253) },
    excludedDomains: { check: isShortList(500, 253) },
    limits: { check: isLimits },
    workspaceId: { check: isOpaqueId },
    sessionId: { check: isOpaqueId },
  },
  'research:status': { id: { required: true, check: isOpaqueId } },
  'research:cancel': { id: { required: true, check: isOpaqueId }, reason: { check: isShortText } },
  'research:get': { id: { required: true, check: isOpaqueId } },
  'research:list': {},
  'research:sources': { id: { required: true, check: isOpaqueId } },
  'research:evidence': { id: { required: true, check: isOpaqueId }, claimId: { check: isOpaqueId } },
  'research:report': { id: { required: true, check: isOpaqueId }, format: { check: isString } },
  'research:capabilities': {},
});

const PUSH_CHANNELS = Object.freeze(['agent:event', 'workflow:event', 'approval:event', 'research:event']);

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

module.exports = {
  CHANNELS, PUSH_CHANNELS, validatePayload, allowedChannel,
  isOpaqueId, isShortText, isSkillTerm, isRepository, isRelPath,
  isQuestion, isShortList, isLimits, isResearchMode, RESEARCH_MODES,
};
