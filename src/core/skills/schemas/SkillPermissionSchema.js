// Skill permissions: the closed set of things a skill may ask for, and the
// policy action each one is actually evaluated as.
//
// The critical property is that a permission is a *request*, never a grant. A
// manifest saying `"permissions": ["process.execute"]` does not give the skill
// a shell; it declares that running this skill will reach for one, so the
// platform can (a) refuse to install it where policy forbids that, (b) route
// the run through the sandbox, and (c) show a human an accurate prompt before
// anything happens.
//
// Every permission maps onto a policy action string the existing PolicyManager
// already understands (core/policy/rules.js ACTION). That mapping is the whole
// integration: there is no second permission engine, and a rule written as
// `filesystem.delete: deny` blocks a skill exactly as it blocks a tool.

const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
const RISK_RANK = Object.freeze(Object.fromEntries(RISK_LEVELS.map((r, i) => [r, i])));

// permission -> { action, risk, description }
//
// `risk` is the *floor* this permission puts under a skill's risk level. A
// manifest that asks for `process.execute` and declares itself "low" is
// corrected upward (see SkillManifest.normalize) rather than believed: risk is
// derived from what the skill can do, not from what it says about itself.
const PERMISSIONS = Object.freeze({
  'filesystem.read': { action: 'filesystem.read', risk: 'low', description: 'Read files inside the authorized workspace.' },
  'filesystem.write': { action: 'filesystem.write', risk: 'medium', description: 'Create or modify files inside the authorized workspace.' },
  'filesystem.delete': { action: 'filesystem.delete', risk: 'high', description: 'Delete files inside the authorized workspace.' },
  'process.execute': { action: 'command.run', risk: 'high', description: 'Run a command or start a process.' },
  'network.request': { action: 'network.request', risk: 'medium', description: 'Make outbound network requests.' },
  'credential.read': { action: 'credential', risk: 'critical', description: 'Read a named credential. Granted per credential by policy, never by the manifest.' },
  'mcp.connect': { action: 'mcp.connect', risk: 'medium', description: 'Connect to an MCP server.' },
  'mcp.tool.invoke': { action: 'mcp.tool.invoke', risk: 'medium', description: 'Invoke a tool exposed by an MCP server.' },
  'agent.delegate': { action: 'agent.delegate', risk: 'medium', description: 'Delegate work to another agent.' },
  'memory.write': { action: 'memory.write', risk: 'low', description: 'Persist entries into scoped memory.' },
  'sandbox.exec': { action: 'sandbox.exec', risk: 'high', description: 'Execute inside a sandbox it requested itself.' },
  'system.modify': { action: 'system.modify', risk: 'critical', description: 'Change state outside the workspace (system settings, global installs).' },
});

const PERMISSION_NAMES = Object.freeze(Object.keys(PERMISSIONS).sort());
const PERMISSION_SET = new Set(PERMISSION_NAMES);

function isPermission(value) {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

function unknownPermissions(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => !isPermission(p));
}

function actionFor(permission) {
  const entry = PERMISSIONS[permission];
  return entry ? entry.action : null;
}

// Every policy action a permission set implies, deduplicated and sorted, so the
// caller evaluates each action exactly once.
function actionsFor(permissions = []) {
  const out = new Set();
  for (const p of permissions) {
    const action = actionFor(p);
    if (action) out.add(action);
  }
  return [...out].sort();
}

function riskRank(level) {
  return RISK_RANK[level] === undefined ? -1 : RISK_RANK[level];
}

function maxRisk(a, b) {
  if (!RISK_LEVELS.includes(a)) return RISK_LEVELS.includes(b) ? b : 'low';
  if (!RISK_LEVELS.includes(b)) return a;
  return riskRank(a) >= riskRank(b) ? a : b;
}

// The lowest risk level a skill with these permissions can honestly claim.
function derivedRisk(permissions = []) {
  let risk = 'low';
  for (const p of permissions) {
    const entry = PERMISSIONS[p];
    if (entry) risk = maxRisk(risk, entry.risk);
  }
  return risk;
}

// Human-readable lines for an approval prompt or the skill detail pane. A
// person approving a skill should see what it can do, not a list of enum
// strings.
function describePermissions(permissions = []) {
  return permissions
    .filter(isPermission)
    .map((p) => ({ permission: p, action: PERMISSIONS[p].action, risk: PERMISSIONS[p].risk, description: PERMISSIONS[p].description }));
}

module.exports = {
  RISK_LEVELS,
  RISK_RANK,
  PERMISSIONS,
  PERMISSION_NAMES,
  isPermission,
  unknownPermissions,
  actionFor,
  actionsFor,
  riskRank,
  maxRisk,
  derivedRisk,
  describePermissions,
};
