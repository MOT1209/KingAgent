// Core factory: wiring every subsystem together.
//
// The renderer never talks to this directly. The main process constructs a
// platform here, attaches its own IPC layer (see src/main/agent-platform.js)
// and the preload's `window.kingagent.agentPlatform` API, and that is the
// boundary the UI sees. All I/O (fs, shell, workspace) arrives through `io` so
// the factory is fully host-agnostic and unit-testable.

const { EventBus } = require('./events/event-bus');
const { createLogger } = require('./logging/logger');
const { createProviderRegistry } = require('./ai/provider');
const { createMemory } = require('./memory/memory');
const { AgentRegistry } = require('./agents/registry');
const { builtinAgents } = require('./agents/presets/builtin');
const { ToolManager, ToolDeniedError } = require('./tools/manager');
const { registerBuiltinTools } = require('./tools/builtin');
const { createMemoryStore, createJsonStore } = require('./persistence/store');
const { Planner } = require('./planning/planner');
const { Reasoner } = require('./reasoning/reasoning');
const { AgentRuntime } = require('./runtime/runtime');
const { WorkflowEngine } = require('./workflows/engine');
const { buildTaskContext } = require('./context/context');
const { CodeExecutor } = require('./execution/code-exec');

function createPlatform({
  io = {}, // { fs, root, cwd, runShell }
  loggerOptions = {},
  storeDir = null,
  autoRegisterBuiltinAgents = true,
}) {
  const bus = new EventBus();
  const logger = createLogger({ scope: 'platform', ...loggerOptions });

  // Persistence: real JSON store when the platform gives a directory, else
  // in-memory (tests, unsaved sessions).
  const fs = io.fs || require('node:fs/promises');
  const store = storeDir
    ? createJsonStore({ dir: storeDir, name: 'platform.json', fs })
    : createMemoryStore();

  const providers = createProviderRegistry();
  const memory = createMemory();

  const agents = new AgentRegistry({ store });
  if (autoRegisterBuiltinAgents) {
    for (const def of builtinAgents()) agents.register(def);
  }

  const tools = new ToolManager({ bus, logger: logger.child('tools'), authorize: io.authorize || null });
  registerBuiltinTools(tools, {
    fs,
    root: io.root || null,
    cwd: io.cwd || (() => process.cwd()),
    runShell: io.runShell || null,
  });

  const codeExec = new CodeExecutor();

  const provider = (() => {
    // The host may wire a real provider (see src/main/agent-platform.js).
    // `null` = "no AI": every subsystem already has deterministic fallbacks.
    return io.provider || null;
  })();

  const reasoner = new Reasoner({ provider, bus, logger: logger.child('reasoning') });
  const planner = new Planner({ bus, toolManager: tools, provider, reasoner, logger: logger.child('planning') });

  const runtime = new AgentRuntime({
    bus,
    agentRegistry: agents,
    toolManager: tools,
    planner,
    reasoner,
    provider,
    contextBuilder: buildTaskContext,
    memory,
    logger: logger.child('runtime'),
    config: { taskStore: store, maxRetries: 2 },
  });

  const workflows = new WorkflowEngine({
    bus,
    toolManager: tools,
    runtime,
    shellIo: io.runShell
      ? { run: async (command, opts) => io.runShell({ command, cwd: opts.cwd || io.root || process.cwd(), timeoutMs: opts.timeoutMs, ...opts }) }
      : null,
    execIo: codeExec,
    logger: logger.child('workflows'),
  });

  return {
    bus,
    logger,
    providers,
    memory,
    agents,
    tools,
    codeExec,
    planner,
    reasoner,
    runtime,
    workflows,
    ToolDeniedError,
  };
}

module.exports = { createPlatform };