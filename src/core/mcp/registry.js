// McpServerRegistry: the MCP servers this install knows about, and what their
// tools were judged to be.
//
// Separate from the skill registry on purpose. A skill is a capability package
// KingAgent loads; an MCP server is a *process or endpoint* that exposes tools.
// They meet in one place — a skill may declare that it works with a server
// (`mcp.servers` in its manifest) — and that declaration names a server, it
// never configures or starts one. Wiring a server is a host action with a human
// behind it.
//
// What this registry is responsible for:
//
//   * the record: id, transport, origin, state, trust, when it was last seen
//   * the *classification* of its advertised tools (mcp/classify.js), recorded
//     at registration so a server that changes its tool list later is visible
//     as a change rather than absorbed silently
//   * the audit trail of that change
//
// What it deliberately does not do: connect, spawn, authenticate, or hold a
// credential. Those belong to the host's MCP client wiring.

const { classifyServer } = require('./classify');
const { isString, validId } = require('../schema/validate');
const { TYPES } = require('../events/event-bus');

const SERVER_STATES = Object.freeze(['registered', 'connected', 'failed', 'disabled', 'quarantined']);
const TRANSPORTS = Object.freeze(['stdio', 'http', 'sse']);

class McpRegistryError extends Error {
  constructor(message, { code = 'MCP_REGISTRY_ERROR', serverId = null } = {}) {
    super(message);
    this.name = 'McpRegistryError';
    this.code = code;
    this.serverId = serverId;
  }
}

class McpServerRegistry {
  constructor({ bus = null, logger = null, collection = null } = {}) {
    this._servers = new Map();
    this._bus = bus;
    this._logger = logger;
    this._collection = collection;
  }

  // Register a server the host has configured. `origin` records where the
  // configuration came from (a config file, the UI, a test) — provenance for a
  // server is as much a security property as it is for a skill.
  register({ id, name = null, transport = 'stdio', url = null, origin = 'host', tools = [], trusted = false } = {}) {
    if (!validId(id)) throw new McpRegistryError(`invalid MCP server id: ${JSON.stringify(id)}`, { code: 'MCP_INVALID_ID' });
    if (!TRANSPORTS.includes(transport)) throw new McpRegistryError(`unknown MCP transport: ${JSON.stringify(transport)}`, { serverId: id });
    if (url !== null && !(isString(url) && /^https?:\/\//.test(url))) {
      throw new McpRegistryError('an MCP server url must be http(s)', { serverId: id });
    }
    if (transport !== 'stdio' && !url) throw new McpRegistryError(`the ${transport} transport needs a url`, { serverId: id });

    const classification = classifyServer({ serverId: id, tools });
    const record = {
      id,
      name: name || id,
      transport,
      url,
      origin,
      // Trust is a host decision and defaults to false. A server that arrived
      // from a config file nobody reviewed is not trusted because it is present.
      trusted: trusted === true,
      state: 'registered',
      tools: classification.tools,
      risk: classification.risk,
      highestClass: classification.highestClass,
      byClass: classification.byClass,
      conflicts: classification.conflicts,
      allWriting: classification.allWriting,
      registeredAt: Date.now(),
      lastSeenAt: null,
      stats: { calls: 0, failures: 0, denials: 0 },
      history: [],
    };
    this._servers.set(id, record);
    this._persist(record);
    this._emit(TYPES.MCP_SERVER_REGISTERED, record, {
      transport,
      origin,
      tools: record.tools.length,
      risk: record.risk,
      byClass: record.byClass,
      conflicts: record.conflicts,
    });
    if (record.conflicts.length && this._logger) {
      this._logger.warn(`MCP server ${id} annotates tools inconsistently`, { conflicts: record.conflicts });
    }
    return record;
  }

  // The tool list a server advertises can change between connections. That is
  // not automatically wrong, but it must never be silent: the diff is recorded,
  // the new tools are classified, and an added DESTRUCTIVE/SYSTEM/PRIVILEGED
  // tool is surfaced as the significant event it is.
  updateTools(id, tools = []) {
    const record = this._require(id);
    const before = new Map(record.tools.map((t) => [t.name, t]));
    const classification = classifyServer({ serverId: id, tools });
    const added = classification.tools.filter((t) => !before.has(t.name));
    const removed = [...before.keys()].filter((name) => !classification.tools.some((t) => t.name === name));
    const reclassified = classification.tools
      .filter((t) => before.has(t.name) && before.get(t.name).class !== t.class)
      .map((t) => ({ name: t.name, from: before.get(t.name).class, to: t.class }));

    record.tools = classification.tools;
    record.risk = classification.risk;
    record.highestClass = classification.highestClass;
    record.byClass = classification.byClass;
    record.conflicts = classification.conflicts;
    record.lastSeenAt = Date.now();

    const escalations = added.filter((t) => ['DESTRUCTIVE', 'SYSTEM', 'PRIVILEGED'].includes(t.class));
    if (added.length || removed.length || reclassified.length) {
      record.history.push({ at: Date.now(), added: added.map((t) => t.name), removed, reclassified });
      if (record.history.length > 50) record.history.splice(0, record.history.length - 50);
      this._emit(TYPES.MCP_TOOL_CLASSIFIED, record, {
        added: added.map((t) => ({ name: t.name, class: t.class })),
        removed,
        reclassified,
        escalations: escalations.map((t) => t.name),
      });
      if (escalations.length && this._logger) {
        this._logger.warn(`MCP server ${id} added high-risk tools`, { tools: escalations.map((t) => `${t.name} (${t.class})`) });
      }
    }
    this._persist(record);
    return { added, removed, reclassified, escalations };
  }

  setState(id, state, { reason = '' } = {}) {
    if (!SERVER_STATES.includes(state)) throw new McpRegistryError(`unknown MCP server state: ${state}`, { serverId: id });
    const record = this._require(id);
    record.state = state;
    record.history.push({ at: Date.now(), state, reason });
    this._persist(record);
    return record;
  }

  recordCall(id, { ok, denied = false } = {}) {
    const record = this._servers.get(id);
    if (!record) return null;
    record.stats.calls += 1;
    if (!ok) record.stats.failures += 1;
    if (denied) record.stats.denials += 1;
    record.lastSeenAt = Date.now();
    return record.stats;
  }

  get(id) { return this._servers.get(id) || null; }
  has(id) { return this._servers.has(id); }
  ids() { return [...this._servers.keys()].sort(); }

  list({ state = null, transport = null, minRisk = null } = {}) {
    let rows = [...this._servers.values()];
    if (state) rows = rows.filter((r) => r.state === state);
    if (transport) rows = rows.filter((r) => r.transport === transport);
    if (minRisk) {
      const order = ['low', 'medium', 'high', 'critical'];
      rows = rows.filter((r) => order.indexOf(r.risk) >= order.indexOf(minRisk));
    }
    return rows.map(serverView).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  tool(serverId, toolName) {
    const record = this._servers.get(serverId);
    if (!record) return null;
    return record.tools.find((t) => t.name === toolName) || null;
  }

  remove(id) {
    const existed = this._servers.delete(id);
    if (existed && this._collection) this._collection.delete(id).catch(() => {});
    if (existed) this._emit(TYPES.MCP_SERVER_REMOVED, { id }, {});
    return existed;
  }

  async load() {
    if (!this._collection) return 0;
    const rows = await this._collection.list();
    for (const row of rows) {
      if (row && row.id) this._servers.set(row.id, { history: [], stats: { calls: 0, failures: 0, denials: 0 }, ...row });
    }
    return rows.length;
  }

  stats() {
    const rows = [...this._servers.values()];
    return {
      servers: rows.length,
      tools: rows.reduce((n, r) => n + r.tools.length, 0),
      byState: count(rows, (r) => r.state),
      byRisk: count(rows, (r) => r.risk),
      byTransport: count(rows, (r) => r.transport),
      highRiskTools: rows.reduce((n, r) => n + r.tools.filter((t) => ['DESTRUCTIVE', 'SYSTEM', 'PRIVILEGED'].includes(t.class)).length, 0),
      conflicts: rows.reduce((n, r) => n + r.conflicts.length, 0),
    };
  }

  _require(id) {
    const record = this._servers.get(id);
    if (!record) throw new McpRegistryError(`no MCP server "${id}" is registered`, { code: 'MCP_UNKNOWN_SERVER', serverId: id });
    return record;
  }

  _persist(record) {
    if (!this._collection) return;
    this._collection.put(record.id, serverView(record, { includeHistory: true })).catch((err) => {
      if (this._logger) this._logger.warn(`could not persist MCP server ${record.id}`, { error: err && err.message });
    });
  }

  _emit(type, record, payload) {
    if (this._bus) this._bus.emit(type, { mcpServerId: record.id }, { server: record.id, ...payload });
  }
}

function serverView(record, { includeHistory = false } = {}) {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    url: record.url,
    origin: record.origin,
    trusted: record.trusted,
    state: record.state,
    risk: record.risk,
    highestClass: record.highestClass,
    byClass: { ...record.byClass },
    allWriting: record.allWriting,
    conflicts: [...record.conflicts],
    tools: record.tools.map((t) => ({
      name: t.name,
      class: t.class,
      risk: t.risk,
      policyAction: t.qualifiedAction || t.policyAction,
      requiresAuth: t.requiresAuth,
      idempotent: t.idempotent,
      evidence: [...t.evidence],
      conflicts: [...t.conflicts],
    })),
    stats: { ...record.stats },
    registeredAt: record.registeredAt,
    lastSeenAt: record.lastSeenAt,
    ...(includeHistory ? { history: record.history.slice(-50) } : {}),
  };
}

function count(rows, fn) {
  const out = {};
  for (const row of rows) {
    const key = fn(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = { McpServerRegistry, McpRegistryError, SERVER_STATES, TRANSPORTS, serverView };
