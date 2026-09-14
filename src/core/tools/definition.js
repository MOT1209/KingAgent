// Tool definition schema.
//
// A tool is a capability with an execute() function. Everything the runtime
// knows about a tool — description, capability tags, permission level, input
// schema — lives here so the ToolManager can guard, document, list and call it
// without needing to know about any concrete implementation.

const { isPlainObject, isString, nonEmptyString, validId, pickKnown, fail } = require('../schema/validate');

const PERMISSIONS = Object.freeze({
  READ_ONLY: 'read_only', // safe: scanning, reading, listing
  SAFE: 'safe', // causes no lasting change
  MODERATE: 'moderate', // changes files/state, reversible by scope
  DESTRUCTIVE: 'destructive', // irreversible without explicit per-call authorization
  SYSTEM: 'system', // runtime-internal only; never granted to agents
});

// Ordered weakest -> strongest; permission checks compare by rank.
const LEVEL_ORDER = Object.freeze(['read_only', 'safe', 'moderate', 'destructive', 'system']);
const LEVEL_RANK = Object.freeze(Object.fromEntries(LEVEL_ORDER.map((l, i) => [l, i])));

const TOOL_FIELDS = [
  'id', 'name', 'description', 'category', 'capabilities', 'inputSchema', 'outputSchema',
  'permissions', 'timeoutMs', 'execute', 'hidden', 'policyAction',
];

function validateToolDefinition(def) {
  if (!isPlainObject(def)) return fail(['tool definition must be an object']);
  if (!validId(def.id)) return fail([`invalid tool id: ${JSON.stringify(def.id)}`]);
  if (!nonEmptyString(def.name)) return fail(['tool requires a non-empty name']);
  if (!nonEmptyString(def.description)) return fail(['tool requires a description']);
  if (typeof def.execute !== 'function') return fail(['tool must provide an execute() function']);
  if (def.capabilities !== undefined && (!Array.isArray(def.capabilities) || def.capabilities.some((c) => !isString(c)))) {
    return fail(['capabilities must be an array of strings']);
  }
  // Optional: the policy action string this tool presents as (`git.push`,
  // `filesystem.delete`). A tool may *name* its action; the policy engine is
  // still what decides it (see core/policy/rules.js actionForTool).
  if (def.policyAction !== undefined && (!isString(def.policyAction) || !/^[a-z][a-z0-9._:*]*$/.test(def.policyAction))) {
    return fail(['policyAction must be a lowercase dotted action string']);
  }
  let level = (def.permissions && def.permissions.level) || PERMISSIONS.MODERATE;
  if (!(level in LEVEL_RANK)) return fail([`unknown permission level: ${JSON.stringify(level)}`]);
  if (level === PERMISSIONS.SYSTEM) return fail(['agents cannot be given SYSTEM-level tools']);
  return { ok: true, tool: normalizeTool(def) };
}

function normalizeTool(def) {
  const base = pickKnown(def, TOOL_FIELDS);
  const tool = {
    id: base.id,
    name: base.name,
    description: base.description,
    category: base.category || 'general',
    capabilities: base.capabilities || [],
    inputSchema: isPlainObject(base.inputSchema) ? base.inputSchema : { type: 'object' },
    outputSchema: isPlainObject(base.outputSchema) ? base.outputSchema : null,
    permissions: {
      level: (base.permissions && base.permissions.level) || PERMISSIONS.MODERATE,
      requiresAuth: Boolean(base.permissions && base.permissions.requiresAuth),
      note: (base.permissions && base.permissions.note) || '',
    },
    timeoutMs: base.timeoutMs || 30_000,
    policyAction: base.policyAction || null,
    execute: base.execute,
    hidden: Boolean(base.hidden),
  };
  return Object.freeze(tool);
}

function levelRank(level) {
  return LEVEL_RANK[level] === undefined ? -1 : LEVEL_RANK[level];
}

module.exports = { PERMISSIONS, LEVEL_ORDER, LEVEL_RANK, TOOL_FIELDS, validateToolDefinition, normalizeTool, levelRank };