// The browser subsystem: a governed browser an agent can be given, or not.
//
// Two pieces, one boundary:
//
//   BrowserControl  — who is driving a session (agent or human), and the refusal
//                     that makes "take control" mean something
//   browser:* tools — the actions themselves, registered against the existing
//                     ToolManager so the existing permission, policy and
//                     approval gates apply with no second system
//
// Everything that touches a real engine goes through the injected `host`
// adapter (see the contract in tools.js). That is what keeps this module
// Electron-free and testable in plain node, the same trade every other core
// subsystem makes.

const { BrowserControl, BrowserControlError, OWNERS } = require('./control');
const {
  registerBrowserTools,
  browserToolCatalog,
  BrowserUnavailableError,
  HOST_METHODS,
} = require('./tools');

function createBrowserSubsystem({ toolManager = null, bus = null, logger = null, host = null } = {}) {
  const control = new BrowserControl({ bus, logger });

  // Registered even with no host: a planner that cannot see the browser tools
  // would plan around a capability that exists on the machine, and a tool that
  // fails with BROWSER_UNAVAILABLE is a far better answer than a tool that is
  // not there at all.
  const tools = toolManager
    ? registerBrowserTools(toolManager, { host, control, bus })
    : [];

  return {
    control,
    tools,
    catalog: browserToolCatalog(),

    // False only means "no engine adapter wired yet", never "no session".
    available: typeof host === 'function' ? false : Boolean(host),

    // A host calls this the moment it opens a tab.
    open: (sessionId, options) => control.open(sessionId, options),
    close: (sessionId, options) => control.close(sessionId, options),
    list: (options) => control.list(options),
    get: (sessionId) => control.get(sessionId),

    // The human side of §23. Not tools: an agent must not be able to hand
    // control to itself, and taking control is a person's act, so it is reached
    // from the host/UI, not from the tool registry.
    takeControl: (sessionId, options) => control.takeControl(sessionId, options),
    returnControl: (sessionId, options) => control.returnControl(sessionId, options),

    // Serializable view for a renderer: sessions and the tool catalogue, never
    // a host object and never a credential.
    snapshot() {
      return {
        available: typeof host === 'function' ? false : Boolean(host),
        sessions: control.list(),
        tools: browserToolCatalog(),
      };
    },
  };
}

module.exports = {
  createBrowserSubsystem,
  BrowserControl,
  BrowserControlError,
  BrowserUnavailableError,
  browserToolCatalog,
  OWNERS,
  HOST_METHODS,
};
