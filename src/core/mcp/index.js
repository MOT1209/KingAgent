// The MCP capability layer's public surface.
//
// Three modules with one boundary between them:
//
//   classify   judges what a tool does, from its own description, sceptically
//   registry   remembers servers and their judged tools
//   bridge     puts those tools on the platform's tool surface, where the
//              ToolManager and the PolicyEngine already gate everything
//   inspector  reports on a server before anyone connects it
//
// Nothing here speaks the MCP protocol. The host owns the client, its transport
// and its credentials (src/main/), and injects an `invoke` callback — which
// keeps this layer testable without a server and keeps credentials out of the
// core entirely.

const { CLASSES, CLASS_POLICY, classifyTool, classifyServer, sanitize } = require('./classify');
const { McpServerRegistry, McpRegistryError, SERVER_STATES, TRANSPORTS, serverView } = require('./registry');
const { McpToolBridge, McpBridgeError, toolIdFor, normalizeSchema } = require('./bridge');
const { inspect, testPlan } = require('./inspector');

// Wire the layer onto an existing platform. Returns the pieces so a host can
// register servers as it discovers them.
function createMcpLayer({ tools, bus = null, logger = null, collection = null, policy = null } = {}) {
  const registry = new McpServerRegistry({ bus, logger, collection });
  const bridge = tools ? new McpToolBridge({ tools, registry, bus, logger }) : null;
  return {
    registry,
    bridge,
    inspect,
    testPlan,
    classifyTool,
    classifyServer,
    // Register a server and put its tools on the tool surface in one step,
    // which is the only order that is ever correct: classification first, then
    // exposure.
    async connect({ id, name, transport, url, origin, tools: advertised = [], invoke, trusted = false }) {
      const server = registry.register({ id, name, transport, url, origin, tools: advertised, trusted });
      const registered = bridge ? bridge.registerServer(id, { invoke }) : [];
      registry.setState(id, 'connected', { reason: 'tools registered' });
      return { server, tools: registered, report: inspect({ serverId: id, name, transport, url, tools: advertised }) };
    },
    disconnect(id, { reason = 'disconnected' } = {}) {
      const removed = bridge ? bridge.unregisterServer(id) : [];
      if (registry.has(id)) registry.setState(id, 'registered', { reason });
      return removed;
    },
    // Take a server out of service *and* off the tool surface. The order
    // matters: unregistering first means no call can slip through between the
    // decision and the effect.
    quarantine(id, { reason }) {
      const removed = bridge ? bridge.unregisterServer(id) : [];
      registry.setState(id, 'quarantined', { reason });
      return { removed, id, reason };
    },
    explain: bridge ? (id, opts = {}) => bridge.explain(id, { policy, ...opts }) : async () => ({ explained: false, reason: 'no tool bridge' }),
    controlView() {
      return {
        servers: registry.list(),
        stats: registry.stats(),
        surface: bridge ? bridge.surface() : [],
      };
    },
  };
}

module.exports = {
  CLASSES,
  CLASS_POLICY,
  classifyTool,
  classifyServer,
  sanitize,
  McpServerRegistry,
  McpRegistryError,
  SERVER_STATES,
  TRANSPORTS,
  serverView,
  McpToolBridge,
  McpBridgeError,
  toolIdFor,
  normalizeSchema,
  inspect,
  testPlan,
  createMcpLayer,
};
