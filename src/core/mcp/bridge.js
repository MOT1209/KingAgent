// McpToolBridge: MCP tools become KingAgent tools, or they do not run.
//
// The rule the phase brief states — "all MCP tools must pass through
// KingAgent's Tool Manager and Policy Engine" — is implemented here by having
// no other path. There is no `invokeMcpTool` helper anywhere in the platform;
// an MCP tool reaches an agent only by being *registered as a tool*, at which
// point it inherits everything the ToolManager already enforces: the agent's
// permission level, the DESTRUCTIVE authorization gate, the policy evaluation
// in front of `authorize`, timeouts, and the event stream.
//
// Registration carries the classification (mcp/classify.js) into the two fields
// that decide how a call is gated:
//
//   permissions.level  -> whether the agent may call it at all
//   policyAction       -> which policy rule matches it
//
// so a deployment can write `mcp.tool.destructive.**: deny` and have it apply
// to every destructive tool of every server, present and future, without
// enumerating them.
//
// Tool ids are `mcp:<server>:<tool>` with the tool name sanitized to the id
// alphabet the ToolManager accepts; the original name is kept for the call, so
// a server's `list_issues` is invoked as `list_issues` and appears as
// `mcp:github:list-issues`.

const { sanitize, CLASS_POLICY } = require('./classify');
const { TYPES } = require('../events/event-bus');

const ID_PREFIX = 'mcp';
const DEFAULT_TIMEOUT_MS = 60_000;

class McpBridgeError extends Error {
  constructor(message, { code = 'MCP_BRIDGE_ERROR', serverId = null, tool = null } = {}) {
    super(message);
    this.name = 'McpBridgeError';
    this.code = code;
    this.serverId = serverId;
    this.tool = tool;
  }
}

function toolIdFor(serverId, toolName) {
  return `${ID_PREFIX}:${sanitize(serverId)}:${sanitize(toolName)}`;
}

class McpToolBridge {
  constructor({ tools, registry, bus = null, logger = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!tools) throw new Error('McpToolBridge requires the platform ToolManager');
    this._tools = tools;
    this._registry = registry;
    this._bus = bus;
    this._logger = logger;
    this._timeoutMs = timeoutMs;
    this._registered = new Map(); // toolId -> { serverId, toolName }
  }

  // Register every tool of a server. `invoke({ server, tool, input })` is the
  // host's MCP client call — the bridge never speaks the protocol itself, which
  // keeps transport, authentication and connection lifetime in the host where
  // the credentials already live.
  registerServer(serverId, { invoke, replace = true } = {}) {
    if (typeof invoke !== 'function') {
      throw new McpBridgeError(`registering MCP server "${serverId}" needs an invoke function from the host`, { code: 'MCP_NO_CLIENT', serverId });
    }
    const server = this._registry ? this._registry.get(serverId) : null;
    if (!server) throw new McpBridgeError(`no MCP server "${serverId}" is registered`, { code: 'MCP_UNKNOWN_SERVER', serverId });
    if (server.state === 'disabled' || server.state === 'quarantined') {
      throw new McpBridgeError(`MCP server "${serverId}" is ${server.state}`, { code: 'MCP_SERVER_UNAVAILABLE', serverId });
    }

    const registered = [];
    for (const tool of server.tools) {
      const id = toolIdFor(serverId, tool.name);
      if (this._tools.get(id)) {
        if (!replace) continue;
        this._tools.unregister(id);
      }
      const policy = CLASS_POLICY[tool.class];
      this._tools.register({
        id,
        name: `${server.name}: ${tool.name}`,
        description: descriptionFor(server, tool),
        category: 'mcp',
        capabilities: ['mcp', `mcp.${sanitize(serverId)}`, `mcp.class.${tool.class.toLowerCase()}`],
        // The two fields that decide how this call is gated. Both come from the
        // classification, never from the server's own claims.
        permissions: {
          level: policy.toolPermission,
          requiresAuth: policy.requiresAuth,
          note: `${tool.class} tool on MCP server "${serverId}" (${tool.risk} risk). ${tool.evidence.join('; ')}`,
        },
        policyAction: tool.qualifiedAction || policy.policyAction,
        inputSchema: normalizeSchema(tool.inputSchema),
        timeoutMs: this._timeoutMs,
        execute: async (input) => {
          const startedAt = Date.now();
          try {
            const output = await invoke({ server: serverId, tool: tool.name, input });
            if (this._registry) this._registry.recordCall(serverId, { ok: true });
            this._emit(TYPES.MCP_TOOL_INVOKED, serverId, { tool: tool.name, class: tool.class, ok: true, durationMs: Date.now() - startedAt });
            return output;
          } catch (err) {
            if (this._registry) this._registry.recordCall(serverId, { ok: false });
            this._emit(TYPES.MCP_TOOL_INVOKED, serverId, { tool: tool.name, class: tool.class, ok: false, error: err.message, durationMs: Date.now() - startedAt });
            throw err;
          }
        },
      });
      this._registered.set(id, { serverId, toolName: tool.name, class: tool.class });
      registered.push({ id, name: tool.name, class: tool.class, risk: tool.risk, policyAction: tool.qualifiedAction });
    }

    if (this._logger) {
      this._logger.info(`registered ${registered.length} MCP tools from ${serverId}`, {
        destructive: registered.filter((t) => t.class === 'DESTRUCTIVE').length,
        system: registered.filter((t) => t.class === 'SYSTEM').length,
        privileged: registered.filter((t) => t.class === 'PRIVILEGED').length,
      });
    }
    return registered;
  }

  // Remove a server's tools from the tool surface. Called when a server is
  // disabled, quarantined or removed — a tool that outlives its server is a
  // call that will fail at best and hit a stale client at worst.
  unregisterServer(serverId) {
    const removed = [];
    for (const [id, entry] of [...this._registered.entries()]) {
      if (entry.serverId !== serverId) continue;
      this._tools.unregister(id);
      this._registered.delete(id);
      removed.push(id);
    }
    return removed;
  }

  registeredFor(serverId) {
    return [...this._registered.entries()]
      .filter(([, entry]) => entry.serverId === serverId)
      .map(([id, entry]) => ({ id, ...entry }));
  }

  // Every MCP tool currently on the tool surface, with the gate each one sits
  // behind. This is what the MCP pane lists and what an audit answers from.
  surface() {
    return [...this._registered.entries()].map(([id, entry]) => {
      const peek = this._tools.peek(id);
      return {
        id,
        serverId: entry.serverId,
        tool: entry.toolName,
        class: entry.class,
        level: peek ? peek.permissions.level : null,
        requiresAuth: peek ? peek.permissions.requiresAuth : null,
        policyAction: peek ? peek.policyAction : null,
      };
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // What policy would decide for each of a server's tools right now, without
  // calling any of them. The honest way to answer "what can this server do
  // here?" before connecting it to anything.
  async explain(serverId, { policy, context = {} } = {}) {
    if (!policy) return { serverId, explained: false, reason: 'no policy engine is wired' };
    const rows = [];
    for (const entry of this.registeredFor(serverId)) {
      const peek = this._tools.peek(entry.id);
      const decision = policy.explain({ action: peek.policyAction, context: { ...context, toolId: entry.id } });
      rows.push({
        id: entry.id,
        tool: entry.toolName,
        class: entry.class,
        action: peek.policyAction,
        effect: decision.effect,
        requiresApproval: decision.requiresApproval,
        reason: decision.reason,
      });
    }
    return {
      serverId,
      explained: true,
      tools: rows,
      denied: rows.filter((r) => r.effect === 'deny').map((r) => r.tool),
      gated: rows.filter((r) => r.requiresApproval).map((r) => r.tool),
    };
  }

  _emit(type, serverId, payload) {
    if (this._bus) this._bus.emit(type, { mcpServerId: serverId, toolId: payload.tool }, { server: serverId, ...payload });
  }
}

function descriptionFor(server, tool) {
  const base = tool.description || `Tool "${tool.name}" exposed by the MCP server "${server.name}".`;
  // The class is appended to the description an agent reads, so the model sees
  // the same judgement the policy engine is acting on.
  return `${base} [${tool.class}, ${tool.risk} risk]`;
}

// The ToolManager validates inputs against a small schema subset. An MCP
// server's JSON Schema is passed through when it is object-shaped and replaced
// with a permissive object otherwise — the server remains responsible for
// validating its own arguments, and the tool gate never becomes the only check.
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object' };
  if (schema.type && schema.type !== 'object') return { type: 'object' };
  const properties = {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    if (!prop || typeof prop !== 'object') continue;
    properties[key] = {
      type: ['string', 'boolean', 'array', 'number', 'object'].includes(prop.type) ? prop.type : undefined,
      required: required.includes(key),
    };
  }
  return { type: 'object', properties };
}

module.exports = { McpToolBridge, McpBridgeError, toolIdFor, normalizeSchema, ID_PREFIX };
