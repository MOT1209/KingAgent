// Orchestration policies: the limits a run is allowed to operate inside.
//
// Routing decides *what shape* a request takes; policy decides what any shape is
// permitted to cost. Keeping them apart means the router can be changed (or
// replaced with a model-backed one) without loosening a single limit, because
// the limits are not in the router.
//
// Every number here exists because its absence is a failure mode: no concurrency
// cap is a fork bomb, no depth cap is infinite delegation, no task timeout is a
// task that never ends, no approval policy is an agent that deletes things.

const { DANGEROUS_ACTIONS } = require('../approval/request');

const EXECUTION_MODES = Object.freeze({
  SINGLE_AGENT: 'single-agent',
  MULTI_AGENT: 'multi-agent',
  WORKFLOW: 'workflow',
  TOOL: 'tool',
  APPROVAL: 'approval',
});

const DEFAULT_POLICIES = Object.freeze({
  maxConcurrentTasks: 3,
  maxDelegationDepth: 3,
  maxDelegationsPerTask: 6,
  taskTimeoutMs: 15 * 60 * 1000,
  delegationTimeoutMs: 5 * 60 * 1000,
  // Multi-agent is opt-in per request or per capability set: routing a simple
  // request to three agents is slower, costlier and harder to explain than
  // doing it once.
  allowMultiAgent: true,
  multiAgentMinCapabilities: 3,
  // Approvals: `require` null means "use the platform's dangerous-action list".
  approval: { require: null, allow: [], requireAll: false },
  // What a task's workspace may do unless the request narrows it further.
  workspace: { allowNetwork: false, allowDestructive: false },
  memory: { write: true, maxRetrieved: 8 },
  context: { maxChars: 48_000 },
});

function createPolicies(overrides = {}) {
  const merged = {
    ...DEFAULT_POLICIES,
    ...overrides,
    approval: { ...DEFAULT_POLICIES.approval, ...(overrides.approval || {}) },
    workspace: { ...DEFAULT_POLICIES.workspace, ...(overrides.workspace || {}) },
    memory: { ...DEFAULT_POLICIES.memory, ...(overrides.memory || {}) },
    context: { ...DEFAULT_POLICIES.context, ...(overrides.context || {}) },
  };

  return {
    ...merged,

    // The shape the ApprovalManager takes. `require: null` resolves to the
    // platform list here rather than being special-cased at every call site.
    approvalPolicy() {
      const { require: req, allow, requireAll } = merged.approval;
      return {
        require: req === null ? Object.keys(DANGEROUS_ACTIONS) : req,
        allow: allow || [],
        requireAll: Boolean(requireAll),
      };
    },

    // Is this execution mode permitted for this request?
    allows(mode, { capabilities = [] } = {}) {
      if (mode !== EXECUTION_MODES.MULTI_AGENT) return { ok: true };
      if (!merged.allowMultiAgent) return { ok: false, reason: 'multi-agent execution is disabled by policy' };
      if (capabilities.length < merged.multiAgentMinCapabilities) {
        return { ok: false, reason: `multi-agent needs at least ${merged.multiAgentMinCapabilities} distinct capabilities` };
      }
      return { ok: true };
    },

    withinDepth(depth) {
      return depth < merged.maxDelegationDepth;
    },

    // The workspace policy an orchestrated task starts from. Narrowed further
    // per-agent and per-delegation; never widened.
    workspacePolicy(extra = {}) {
      return {
        allowNetwork: merged.workspace.allowNetwork,
        allowDestructive: merged.workspace.allowDestructive,
        ...extra,
      };
    },
  };
}

module.exports = { EXECUTION_MODES, DEFAULT_POLICIES, createPolicies };
