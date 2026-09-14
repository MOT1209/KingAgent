// Core factory: wiring every subsystem together.
//
// The renderer never talks to this directly. The main process constructs a
// platform here, attaches its own IPC layer (see src/main/agent-platform.js)
// and the preload's `window.kingagent.agentPlatform` API, and that is the
// boundary the UI sees. All I/O (fs, shell, workspace) arrives through `io` so
// the factory is fully host-agnostic and unit-testable.
//
// Phase 3 adds a layer *above* the runtime rather than inside it. The runtime,
// planner, tool manager, workflow engine and event bus are constructed exactly
// as before; what is new is the world a run happens inside — a workspace with
// an identity, a budgeted context packet, scoped memory, an execution trace,
// artifacts, approvals, state snapshots and an orchestrator that composes them.
// Nothing Phase 2 built was replaced to get there.

const { EventBus } = require('./events/event-bus');
const { createLogger } = require('./logging/logger');
const { createProviderRegistry } = require('./ai/provider');
const { createMemory } = require('./memory/memory');
const { AgentRegistry } = require('./agents/registry');
const { builtinAgents } = require('./agents/presets/builtin');
const { ToolManager, ToolDeniedError } = require('./tools/manager');
const { registerBuiltinTools } = require('./tools/builtin');
const { createMemoryStore, createJsonStore } = require('./persistence/store');
const { createCollections } = require('./persistence/collections');
const { Planner } = require('./planning/planner');
const { Reasoner } = require('./reasoning/reasoning');
const { AgentRuntime } = require('./runtime/runtime');
const { WorkflowEngine } = require('./workflows/engine');
const { buildTaskContext } = require('./context/context');
const { CodeExecutor } = require('./execution/code-exec');

// --- Phase 3 subsystems ------------------------------------------------------
const { WorkspaceManager } = require('./workspace/manager');
const { createEnvironment } = require('./workspace/environment');
const { ContextManager } = require('./context/manager');
const { MemoryManager } = require('./memory/manager');
const { createInMemoryProvider, createStoreProvider } = require('./memory/provider');
const { ProjectIndexer } = require('./project/indexer');
const { ExecutionTraceStore } = require('./trace/store');
const { ArtifactManager } = require('./artifacts/manager');
const { ApprovalManager } = require('./approval/manager');
const { AgentMessageBus } = require('./agents/messaging/bus');
const { AgentCoordinator } = require('./agents/coordinator');
const { AgentStateStore } = require('./state/store');
const { StateRecoveryManager } = require('./state/recovery');
const { Orchestrator } = require('./orchestrator/orchestrator');

function createPlatform({
  io = {}, // { fs, root, cwd, runShell, authorize, hostEnv, inheritEnv }
  loggerOptions = {},
  storeDir = null,
  autoRegisterBuiltinAgents = true,
  policies = {},
  approvalOptions = {},
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

  // --- approvals ------------------------------------------------------------
  // Constructed before the ToolManager because it supplies the authorization
  // callback: the Phase 2 per-call gate and the Phase 3 approval record are one
  // decision, not two systems that can disagree.
  const approvals = new ApprovalManager({
    bus,
    logger: logger.child('approval'),
    ...approvalOptions,
  });

  const tools = new ToolManager({
    bus,
    logger: logger.child('tools'),
    // An explicit host callback still wins; otherwise every gated call becomes
    // a listable, auditable approval request.
    authorize: io.authorize || approvals.toolAuthorizer(),
  });
  registerBuiltinTools(tools, {
    fs,
    root: io.root || null,
    cwd: io.cwd || (() => process.cwd()),
    runShell: io.runShell || null,
  });

  // Code execution is a capability that has to be opted into: the executor is
  // created with no engines registered (registerDefaults is false by default),
  // so a `code` node fails loudly unless the host explicitly enables an engine
  // that fits its threat model. Turn it on with `codeExec.register('js', runJavaScript)`.
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

  // --- Phase 3: the world a run happens inside ------------------------------
  //
  // Each of these takes its storage as a *collection* (persistence/collections.js)
  // rather than a store, so the whole set moves to SQLite or a remote backend by
  // changing one construction here.
  const collections = createCollections(store);

  const workspaces = new WorkspaceManager({
    bus,
    collection: collections.workspaces,
    logger: logger.child('workspace'),
  });

  const memoryManager = new MemoryManager({
    bus,
    logger: logger.child('memory'),
    provider: storeDir
      ? createStoreProvider({ collection: collections.memory })
      : createInMemoryProvider(),
  });

  const projects = new ProjectIndexer({
    fs,
    bus,
    collection: collections.projects,
    logger: logger.child('project'),
  });

  const traces = new ExecutionTraceStore({
    collection: collections.traces,
    bus,
    logger: logger.child('trace'),
  });

  const artifacts = new ArtifactManager({
    collection: collections.artifacts,
    bus,
    logger: logger.child('artifacts'),
  });

  const contextManager = new ContextManager({
    bus,
    memory: memoryManager,
    projects,
    toolManager: tools,
    logger: logger.child('context'),
    budget: (policies.context && policies.context.maxChars) ? { maxChars: policies.context.maxChars } : {},
  });

  const messages = new AgentMessageBus({ bus, logger: logger.child('messaging') });

  const coordinator = new AgentCoordinator({
    registry: agents,
    runtime,
    workspaces,
    messageBus: messages,
    traces,
    artifacts,
    bus,
    logger: logger.child('coordinator'),
  });

  const agentState = new AgentStateStore({ collection: collections.agentState });
  const recovery = new StateRecoveryManager({
    store: agentState,
    workspaces,
    traces,
    approvals,
    bus,
    logger: logger.child('recovery'),
  });

  const orchestrator = new Orchestrator({
    runtime,
    coordinator,
    workspaces,
    contextManager,
    memory: memoryManager,
    traces,
    artifacts,
    approvals,
    projects,
    workflows,
    agents,
    tools,
    bus,
    logger: logger.child('orchestrator'),
    provider,
    policies,
  });
  orchestrator.attachRecovery(recovery);
  approvals.setPolicy(orchestrator.policies.approvalPolicy());

  // The environment a workspace starts from. Nothing is inherited from the host
  // unless `io.inheritEnv` names it, and credential-shaped names are refused
  // even then (see workspace/environment.js).
  const environment = createEnvironment({
    base: io.baseEnv || {},
    inherit: io.inheritEnv || [],
    hostEnv: io.hostEnv || null,
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

    // Phase 3
    collections,
    workspaces,
    memoryManager,
    contextManager,
    projects,
    traces,
    artifacts,
    approvals,
    messages,
    coordinator,
    agentState,
    recovery,
    orchestrator,
    environment,

    // Release every timer and in-flight decision a host is holding. Called when
    // the app quits, so a pending approval cannot keep a process alive.
    dispose() {
      approvals.dispose();
      orchestrator.scheduler.cancelAll('platform disposed');
      return true;
    },
  };
}

module.exports = { createPlatform };
