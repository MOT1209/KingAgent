// The router: what shape should this request take?
//
// Five outcomes — one agent, several agents, a workflow, a single tool call, or
// stop and ask a human. The routing is deterministic and explainable by
// default, because an orchestrator that can only route with a model is an
// orchestrator that does not work offline and cannot be tested. A provider, when
// present, refines the decision; it never gets to bypass the policy check.
//
// Routing produces a *decision*, not an execution: it names the mode, the
// capabilities the work needs, a suggested agent and a human-readable reason.
// The orchestrator owns what happens next.

const { EXECUTION_MODES } = require('./policies');

// Capability signals. Order matters only in that every match contributes; the
// set of matched capabilities is what drives agent selection.
const SIGNALS = [
  [/\b(?:analy[sz]e|inspect|review|audit|understand|explore|investigate|explain)\b/i, 'repository_analysis'],
  [/\b(?:read|open|show|list|find|search|grep|locate|where)\b/i, 'read'],
  [/\b(?:write|edit|modify|change|implement|refactor|add|create|fix|patch|update)\b/i, 'write'],
  [/\b(?:code|function|class|module|api|bug|implement|refactor)\b/i, 'code'],
  [/\b(?:test|tests|spec|suite|coverage|failing|pytest|jest)\b/i, 'run_tests'],
  [/\b(?:git|commit|branch|diff|merge|history|blame)\b/i, 'git'],
  [/\b(?:report|summari[sz]e|document|write up|explain what)\b/i, 'report'],
  [/\b(?:research|compare|evaluate|investigate|look up|survey)\b/i, 'research'],
];

// Requests that should stop at a human before an agent touches anything.
const APPROVAL_SIGNALS = [
  /\b(?:delete|remove|rm\s+-rf|drop|wipe|destroy|purge)\b/i,
  /\b(?:push|deploy|publish|release)\b/i,
  /\b(?:install|npm\s+i\b|pip\s+install)\b/i,
];

// A request that is literally one tool call does not need a plan around it.
const TOOL_SIGNALS = [
  [/^\s*(?:read|show|cat|open)\s+\S+\s*$/i, 'fs:read'],
  [/^\s*(?:list|ls)\s*\S*\s*$/i, 'fs:list'],
  [/^\s*git\s+status\s*$/i, 'git:status'],
];

function detectCapabilities(request) {
  const found = new Set();
  for (const [re, cap] of SIGNALS) if (re.test(request)) found.add(cap);
  return [...found];
}

function detectTool(request) {
  for (const [re, toolId] of TOOL_SIGNALS) if (re.test(request)) return toolId;
  return null;
}

function needsApproval(request) {
  return APPROVAL_SIGNALS.some((re) => re.test(request));
}

class Router {
  constructor({ policies, agents = null, workflows = null, provider = null, logger = null } = {}) {
    this._policies = policies;
    this._agents = agents;
    this._workflows = workflows;
    this._provider = provider;
    this._logger = logger;
  }

  // `hint` lets a caller force a mode ("run this as a workflow") without the
  // router having to guess. An explicit hint always wins over inference.
  route({ request, agentId = null, workflowId = null, mode = 'auto', capabilities = null } = {}) {
    const text = String(request || '');
    const caps = capabilities && capabilities.length ? capabilities : detectCapabilities(text);

    if (workflowId) {
      return decision(EXECUTION_MODES.WORKFLOW, { workflowId, capabilities: caps, reason: 'a workflow was named explicitly' });
    }
    if (mode && mode !== 'auto' && Object.values(EXECUTION_MODES).includes(mode)) {
      return decision(mode, { agentId, capabilities: caps, reason: `mode "${mode}" was requested` });
    }

    if (needsApproval(text)) {
      return decision(EXECUTION_MODES.APPROVAL, {
        agentId, capabilities: caps,
        reason: 'the request names an irreversible or outward-facing operation',
        requiresApproval: true,
      });
    }

    const tool = detectTool(text);
    if (tool) {
      return decision(EXECUTION_MODES.TOOL, { toolId: tool, capabilities: caps, reason: 'the request is a single tool call' });
    }

    const multi = this._policies.allows(EXECUTION_MODES.MULTI_AGENT, { capabilities: caps });
    if (multi.ok && this._spansRoles(caps)) {
      return decision(EXECUTION_MODES.MULTI_AGENT, {
        agentId, capabilities: caps,
        reason: `the request spans ${caps.length} capabilities across more than one agent role`,
      });
    }

    return decision(EXECUTION_MODES.SINGLE_AGENT, {
      agentId, capabilities: caps,
      reason: caps.length ? `capabilities [${caps.join(', ')}] fit one agent` : 'no capability signal; default agent',
    });
  }

  // Multi-agent is only worth it when no single enabled agent covers the work.
  // Otherwise it is coordination overhead for its own sake.
  _spansRoles(capabilities) {
    if (capabilities.length < 2 || !this._agents) return false;
    const enabled = this._agents.list({ enabled: true });
    if (enabled.length < 2) return false;
    return !enabled.some((a) => {
      const have = new Set(a.capabilities || []);
      return capabilities.every((c) => have.has(c));
    });
  }
}

function decision(mode, extra = {}) {
  return Object.freeze({
    mode,
    agentId: extra.agentId || null,
    workflowId: extra.workflowId || null,
    toolId: extra.toolId || null,
    capabilities: extra.capabilities || [],
    requiresApproval: Boolean(extra.requiresApproval),
    reason: extra.reason || '',
    at: Date.now(),
  });
}

module.exports = { Router, detectCapabilities, detectTool, needsApproval, EXECUTION_MODES, SIGNALS };
