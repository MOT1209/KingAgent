// Turning a routing decision into concrete, bounded delegation specs.
//
// The router says "this needs analysis, code and tests, and no single agent
// covers it". Something still has to decide *which* sub-tasks exist, who gets
// each one, in what order, and with what reach. Doing that inside the
// orchestrator would bury the most security-relevant arithmetic in the platform
// — permission narrowing — inside a control-flow function.
//
// So it lives here, as a pure planner: routing decision in, delegation specs
// out, nothing executed. That makes "can a delegate be handed more than its
// parent has?" a question a test can answer directly.

const { EXECUTION_MODES } = require('./policies');

// Capability → the phase it belongs to, and what that phase needs to reach.
// Phases run in this order; a phase with no matched capability is skipped.
const PHASES = [
  {
    id: 'analysis',
    capabilities: ['repository_analysis', 'read', 'code_search', 'research'],
    label: 'Analyze',
    // Read-only work gets read-only reach. Stated here rather than inherited,
    // so widening it is a visible edit.
    policy: { allowDestructive: false, allowNetwork: false },
    resultSchema: { type: 'object', properties: { taskId: { type: 'string' } } },
  },
  {
    id: 'implementation',
    capabilities: ['code', 'write'],
    label: 'Implement',
    policy: { allowDestructive: false },
    dependsOn: ['analysis'],
  },
  {
    id: 'verification',
    capabilities: ['run_tests', 'shell'],
    label: 'Test',
    policy: { allowDestructive: false },
    dependsOn: ['implementation'],
  },
  {
    id: 'review',
    capabilities: ['report', 'git'],
    label: 'Review',
    policy: { allowDestructive: false, allowNetwork: false },
    dependsOn: ['verification'],
  },
];

// A delegate never receives more than its parent holds. Two-sided intersection,
// with `null` meaning "unrestricted on that side" — the same rule the workspace
// uses, applied one level earlier so a bad plan is caught before a workspace
// exists.
function narrow(parentPolicy, phasePolicy) {
  const parent = parentPolicy || {};
  const out = { ...phasePolicy };
  for (const flag of ['allowNetwork', 'allowDestructive']) {
    out[flag] = Boolean(parent[flag] && (phasePolicy[flag] ?? parent[flag]));
  }
  if (Array.isArray(parent.tools)) {
    out.tools = Array.isArray(phasePolicy.tools) ? phasePolicy.tools.filter((t) => parent.tools.includes(t)) : [...parent.tools];
  } else if (Array.isArray(phasePolicy.tools)) {
    out.tools = [...phasePolicy.tools];
  }
  if (Array.isArray(parent.memoryScopes)) {
    out.memoryScopes = Array.isArray(phasePolicy.memoryScopes)
      ? phasePolicy.memoryScopes.filter((s) => parent.memoryScopes.includes(s))
      : [...parent.memoryScopes];
  }
  return out;
}

// Build the ordered specs for a multi-agent run. Pure: no agent is selected
// here (the coordinator owns selection), no workspace is created.
function planDelegations({
  request,
  decision,
  parentPolicy = {},
  maxDelegations = 6,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  if (!decision || decision.mode !== EXECUTION_MODES.MULTI_AGENT) return [];
  const caps = new Set(decision.capabilities || []);
  const specs = [];

  for (const phase of PHASES) {
    const matched = phase.capabilities.filter((c) => caps.has(c));
    if (matched.length === 0) continue;
    specs.push({
      id: phase.id,
      label: phase.label,
      request: `${phase.label}: ${request}`,
      capabilities: matched,
      policy: narrow(parentPolicy, phase.policy),
      dependsOn: (phase.dependsOn || []).filter((d) => specs.some((s) => s.id === d)),
      timeoutMs,
      resultSchema: phase.resultSchema || null,
    });
    if (specs.length >= maxDelegations) break;
  }
  return specs;
}

// Which specs can run now, given what has finished. Dependencies come from the
// phase table, so a verification step cannot start before implementation did.
function readyDelegations(specs, completedIds = []) {
  const done = new Set(completedIds);
  return specs.filter((s) => !done.has(s.id) && s.dependsOn.every((d) => done.has(d)));
}

// A last check before anything executes: no spec may carry a permission its
// parent lacks. Returns the violations, so the orchestrator can refuse loudly
// rather than silently dropping them.
function auditDelegations(specs, parentPolicy = {}) {
  const problems = [];
  for (const spec of specs) {
    for (const flag of ['allowNetwork', 'allowDestructive']) {
      if (spec.policy[flag] && !parentPolicy[flag]) {
        problems.push(`delegation "${spec.id}" would grant ${flag} that the parent does not hold`);
      }
    }
    if (Array.isArray(parentPolicy.tools) && Array.isArray(spec.policy.tools)) {
      const extra = spec.policy.tools.filter((t) => !parentPolicy.tools.includes(t));
      if (extra.length) problems.push(`delegation "${spec.id}" would grant tools the parent lacks: ${extra.join(', ')}`);
    }
  }
  return problems;
}

module.exports = { PHASES, planDelegations, readyDelegations, auditDelegations, narrow };
