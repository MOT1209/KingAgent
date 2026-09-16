// Research policies: research-shaped actions for the *existing* policy engine
// (§32). There is no second policy engine here, and no evaluation logic — this
// file contributes action names and a baseline document, and core/policy/
// decides everything.
//
// Two rules govern how these compose with what is already there:
//
//   * The policy merge is most-restrictive-wins, so nothing in this document
//     can loosen the platform baseline. In particular `network.request` stays
//     `approval` — a web search is a network request and is gated as one, in
//     addition to its research-specific action.
//   * Research actions are *additional* gates, not replacements. `evaluateSource`
//     below asks for both, and the stricter answer is the answer.

const { SOURCE_TYPES } = require('../schemas/source');

// The action vocabulary. Dotted and lowercase so the existing rule matcher's
// `research.**` / `research.source.*` patterns work unchanged.
const RESEARCH_ACTION = Object.freeze({
  START: 'research.start',
  PLAN: 'research.plan',
  SEARCH: 'research.search',
  FETCH: 'research.fetch',
  SOURCE_WEB: 'research.source.web',
  SOURCE_ACADEMIC: 'research.source.academic',
  SOURCE_GITHUB: 'research.source.github',
  SOURCE_DOCUMENTATION: 'research.source.documentation',
  SOURCE_DISCUSSION: 'research.source.discussion',
  SOURCE_NEWS: 'research.source.news',
  SOURCE_FILE: 'research.source.file',
  SOURCE_MCP: 'research.source.mcp',
  SOURCE_LOCAL: 'research.source.local',
  MEMORY_WRITE: 'research.memory.write',
  BROWSER: 'research.browser',
});

const SOURCE_ACTION = Object.freeze({
  [SOURCE_TYPES.WEB]: RESEARCH_ACTION.SOURCE_WEB,
  [SOURCE_TYPES.ACADEMIC]: RESEARCH_ACTION.SOURCE_ACADEMIC,
  [SOURCE_TYPES.GITHUB]: RESEARCH_ACTION.SOURCE_GITHUB,
  [SOURCE_TYPES.DOCUMENTATION]: RESEARCH_ACTION.SOURCE_DOCUMENTATION,
  [SOURCE_TYPES.DISCUSSION]: RESEARCH_ACTION.SOURCE_DISCUSSION,
  [SOURCE_TYPES.NEWS]: RESEARCH_ACTION.SOURCE_NEWS,
  [SOURCE_TYPES.FILE]: RESEARCH_ACTION.SOURCE_FILE,
  [SOURCE_TYPES.MCP]: RESEARCH_ACTION.SOURCE_MCP,
  [SOURCE_TYPES.LOCAL]: RESEARCH_ACTION.SOURCE_LOCAL,
});

// Which source types reach the network. These get the platform's
// `network.request` gate on top of their own action.
const NETWORKED_TYPES = Object.freeze([
  SOURCE_TYPES.WEB, SOURCE_TYPES.ACADEMIC, SOURCE_TYPES.GITHUB,
  SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.DISCUSSION, SOURCE_TYPES.NEWS,
]);

function actionForSourceType(type) {
  return SOURCE_ACTION[type] || RESEARCH_ACTION.SEARCH;
}

function isNetworked(type) {
  return NETWORKED_TYPES.includes(type);
}

// The document a host registers with PolicyManager.register(doc, { source: 'system' }).
//
// Reading the effects: local research (files already in the workspace, the
// research memory) is allowed; anything that leaves the machine is gated on
// approval, matching how the baseline already treats `network.request`. A host
// that wants unattended web research replaces this document with its own —
// which is a deliberate, human act, exactly as §32 requires.
function researchBaselinePolicy({ allowNetworkedSources = false } = {}) {
  const networkedEffect = allowNetworkedSources ? 'allow' : 'approval';
  return {
    id: 'baseline-research',
    name: 'Research (baseline)',
    description: 'Default governance for the research engine. Local research is allowed; anything leaving the machine is gated.',
    scope: 'global',
    source: 'system',
    rules: [
      { id: 'allow-research-start', action: RESEARCH_ACTION.START, effect: 'allow', reason: 'starting a research task is local work' },
      { id: 'allow-research-plan', action: RESEARCH_ACTION.PLAN, effect: 'allow', reason: 'planning does not leave the machine' },
      { id: 'allow-source-file', action: RESEARCH_ACTION.SOURCE_FILE, effect: 'allow', reason: 'files already in the workspace' },
      { id: 'allow-source-local', action: RESEARCH_ACTION.SOURCE_LOCAL, effect: 'allow', reason: 'local index and prior research' },
      { id: 'allow-research-memory', action: RESEARCH_ACTION.MEMORY_WRITE, effect: 'allow', reason: 'memory writes are scoped by the memory policy' },
      { id: 'gate-search', action: RESEARCH_ACTION.SEARCH, effect: networkedEffect, reason: 'a search sends the question to a third party' },
      { id: 'gate-fetch', action: RESEARCH_ACTION.FETCH, effect: networkedEffect, reason: 'fetching a page is an outbound request' },
      { id: 'gate-source-web', action: RESEARCH_ACTION.SOURCE_WEB, effect: networkedEffect, reason: 'web research leaves the machine' },
      { id: 'gate-source-academic', action: RESEARCH_ACTION.SOURCE_ACADEMIC, effect: networkedEffect, reason: 'academic search leaves the machine' },
      { id: 'gate-source-github', action: RESEARCH_ACTION.SOURCE_GITHUB, effect: networkedEffect, reason: 'GitHub research leaves the machine' },
      { id: 'gate-source-documentation', action: RESEARCH_ACTION.SOURCE_DOCUMENTATION, effect: networkedEffect, reason: 'documentation lookup leaves the machine' },
      { id: 'gate-source-discussion', action: RESEARCH_ACTION.SOURCE_DISCUSSION, effect: networkedEffect, reason: 'discussion search leaves the machine' },
      { id: 'gate-source-news', action: RESEARCH_ACTION.SOURCE_NEWS, effect: networkedEffect, reason: 'news search leaves the machine' },
      // MCP is gated harder than the rest on purpose: an MCP server is code
      // someone else configured, and §23 requires every MCP operation to pass
      // through governance rather than inheriting a blanket research grant.
      { id: 'gate-source-mcp', action: RESEARCH_ACTION.SOURCE_MCP, effect: 'approval', reason: 'an MCP research tool is third-party code' },
      { id: 'gate-browser', action: RESEARCH_ACTION.BROWSER, effect: 'approval', reason: 'browser automation acts as the user' },
    ],
  };
}

// Register the baseline into an existing PolicyManager. Idempotent: the manager
// replaces by id at the same scope.
function loadResearchPolicies(policyManager, { allowNetworkedSources = false } = {}) {
  if (!policyManager || typeof policyManager.register !== 'function') return null;
  return policyManager.register(researchBaselinePolicy({ allowNetworkedSources }), { source: 'system' });
}

// The two-gate evaluation §32 describes, as one call.
//
// Returns the policy engine's own decision object, with the *stricter* of the
// research-specific and network verdicts. A caller never has to remember that a
// web source is also a network request.
async function evaluateSource(policyManager, { type, context = {}, askApproval = true } = {}) {
  if (!policyManager || typeof policyManager.evaluate !== 'function') {
    // No policy engine wired: fail closed for anything networked, allow local.
    return Object.freeze({
      action: actionForSourceType(type),
      effect: isNetworked(type) ? 'deny' : 'allow',
      allowed: !isNetworked(type),
      approved: false,
      reason: isNetworked(type)
        ? 'no policy engine is wired; networked research is denied'
        : 'no policy engine is wired; local research is allowed',
      policyId: null, scope: null, scopeId: null, ruleId: null, requiresApproval: false,
    });
  }
  const own = await policyManager.evaluate({ action: actionForSourceType(type), context, askApproval });
  if (!isNetworked(type)) return own;
  if (own.effect === 'deny' || !own.allowed) return own;
  const net = await policyManager.evaluate({ action: 'network.request', context, askApproval });
  return net.allowed ? own : net;
}

module.exports = {
  RESEARCH_ACTION, SOURCE_ACTION, NETWORKED_TYPES,
  actionForSourceType, isNetworked, researchBaselinePolicy, loadResearchPolicies, evaluateSource,
};
