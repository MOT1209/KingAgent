// Agent definition schema + normalization.
//
// An agent is a named persona with capabilities, tools and a model binding. The
// platform starts from a few built-ins (see presets/) but every field here can
// be overridden — that is the point of an agent registry.

const { isPlainObject, isString, nonEmptyString, validId, pickKnown, fail } = require('../schema/validate');

const AGENT_FIELDS = [
  'id', 'name', 'description', 'systemPrompt', 'model', 'capabilities', 'tools', 'permissions', 'enabled', 'metadata',
];

const DEFAULT_PERMISSIONS = {
  levels: ['read_only', 'safe', 'moderate'], // granted permission levels
  allowDestructive: false, // DESTRUCTIVE tools need per-call authorization
};

function validateAgentDefinition(def) {
  if (!isPlainObject(def)) return fail(['agent definition must be an object']);
  if (!validId(def.id)) return fail([`invalid agent id: ${JSON.stringify(def.id)}`]);
  if (!nonEmptyString(def.name)) return fail(['agent requires a non-empty name']);
  if (def.capabilities !== undefined && (!Array.isArray(def.capabilities) || def.capabilities.some((c) => !isString(c)))) {
    return fail(['capabilities must be an array of strings']);
  }
  if (def.tools !== undefined && (!Array.isArray(def.tools) || def.tools.some((t) => !isString(t)))) {
    return fail(['tools must be an array of tool ids']);
  }
  if (def.permissions !== undefined) {
    if (!isPlainObject(def.permissions)) return fail(['permissions must be an object']);
    if (def.permissions.levels !== undefined && (!Array.isArray(def.permissions.levels) || def.permissions.levels.some((l) => !isString(l)))) {
      return fail(['permissions.levels must be an array of level names']);
    }
    if (def.permissions.allowDestructive !== undefined && typeof def.permissions.allowDestructive !== 'boolean') {
      return fail(['permissions.allowDestructive must be a boolean']);
    }
  }
  if (def.model !== undefined) {
    if (!isPlainObject(def.model)) return fail(['model must be an object']);
    if (def.model.provider !== undefined && !isString(def.model.provider)) return fail(['model.provider must be a string']);
    if (def.model.id !== undefined && !isString(def.model.id)) return fail(['model.id must be a string']);
  }
  return { ok: true, agent: normalizeAgent(def) };
}

function normalizeAgent(def) {
  const base = pickKnown(def, AGENT_FIELDS);
  const agent = {
    id: base.id,
    name: base.name,
    description: base.description || '',
    systemPrompt: base.systemPrompt || '',
    model: {
      provider: (base.model && base.model.provider) || 'unset',
      id: (base.model && base.model.id) || 'default',
      ...(isPlainObject(base.model) ? base.model : {}),
    },
    capabilities: base.capabilities || [],
    tools: base.tools || [],
    permissions: {
      ...DEFAULT_PERMISSIONS,
      ...(isPlainObject(base.permissions) ? base.permissions : {}),
    },
    enabled: base.enabled !== false,
    metadata: isPlainObject(base.metadata) ? base.metadata : {},
  };
  agent.createdAt = agent.createdAt || Date.now();
  return Object.freeze(agent);
}

module.exports = { AGENT_FIELDS, DEFAULT_PERMISSIONS, validateAgentDefinition, normalizeAgent };