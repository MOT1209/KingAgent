// Permission checks between an agent and a tool.
//
// Three rules, applied in order when a ToolManager is about to execute:
//   1. level fit     — the tool's level must be within the agent's granted levels
//   2. explicit deny — opt-out by tool id
//   3. authorization — MODERATE tools are granted by the agent's level list;
//                      DESTRUCTIVE tools additionally need a per-invocation
//                      authorization callback to resolve true
//
// returns { ok, reason? } — the manager turns a non-ok into a denial.

const { levelRank } = require('./definition');
const { PERMISSIONS } = require('./definition');

function canUseTool(agent, tool) {
  if (!agent || !tool) return { ok: false, reason: 'missing agent or tool' };
  if (tool.permissions.level === PERMISSIONS.SYSTEM) return { ok: false, reason: 'system tools are not callable by agents' };

  const { levels = [], denyTools = [] } = agent.permissions || {};
  const denied = (agent.permissions && Array.isArray(agent.permissions.denyTools) && agent.permissions.denyTools)
    ? agent.permissions.denyTools
    : denyTools;
  if (denied.includes(tool.id)) return { ok: false, reason: `tool ${tool.id} is denied for agent ${agent.id}` };

  const grantedLevels = Array.isArray(levels) ? levels : [];
  if (grantedLevels.length === 0) return { ok: false, reason: `agent ${agent.id} has no granted permission levels` };

  const toolRank = levelRank(tool.permissions.level);
  const maxGranted = Math.max(...grantedLevels.map(levelRank));
  if (toolRank > maxGranted) {
    return { ok: false, reason: `tool ${tool.id} needs level ${tool.permissions.level}; agent ${agent.id} grants up to ${grantedLevels.join(', ')}` };
  }

  // DESTRUCTIVE is never covered by the level grant alone.
  if (tool.permissions.level === PERMISSIONS.DESTRUCTIVE && !agent.permissions.allowDestructive) {
    return { ok: false, reason: `tool ${tool.id} is destructive and agent ${agent.id} is not allowed destructive tools` };
  }

  return { ok: true };
}

// Does this call need a human/driver authorization to proceed?
//
// DESTRUCTIVE tools ALWAYS need a per-invocation authorization decision,
// regardless of allowDestructive. The flag only lets the tool through the
// level gate (canUseTool); it must never skip the human loop for an
// irreversible action.
function needsAuthorization(agent, tool) {
  if (tool.permissions.level === PERMISSIONS.DESTRUCTIVE) return true;
  return Boolean(tool.permissions.requiresAuth);
}

const result = { canUseTool, needsAuthorization };
module.exports = result;