// Core factory: wiring every subsystem together.
//
// The renderer never talks to this directly. The main process constructs a
// platform here, attaches its own IPC layer (see src/main/agent-platform.js)
// and the preload's `window.kingagent.agentPlatform` API, and that is the
// boundary the UI sees. All I/O (fs, shell, workspace) arrives through `io` so
// the factory is fully host-agnostic and unit-testable.
//
// Two independent layers sit on top of the unchanged Phase 2 runtime here,
// side by side rather than one replacing the other:
//
//   Phase 3 (src/core/{workspace,context,memory,project,trace,artifacts,
//   approval,agents,state,orchestrator}/) — a workspace with an identity, a
//   budgeted context packet, scoped memory, an execution trace, artifacts,
//   approvals, state snapshots and an orchestrator that composes them. This
//   is what `platform.orchestrator`, `platform.coordinator` and
//   `platform.artifacts` are. See docs/architecture.md.
//
//   Phase 4 / harness-orchestrator (src/core/{harness,policy,sandbox,session,
//   harness-orchestrator}/) — governance and execution-backend layers: which
//   external harness (Claude Code, Codex, …) runs a task, the policy engine
//   every sensitive operation passes through, sandboxed process ownership,
//   and a second, harness-aware orchestrator built on top of those. This is
//   `platform.policy`, `platform.harnesses`, `platform.sandboxes`,
//   `platform.sessions` and the `platform.harness*`-prefixed properties. See
//   docs/harness-orchestrator.md and docs/harness-multi-agent.md.
//
// They were built independently and reconciled rather than merged into one
// design: same-named concepts (an orchestrator, a coordinator, an artifact
// store) exist on both sides with different shapes, so each keeps its own
// module path and its own property name on the returned platform rather than
// one silently overwriting the other. The one seam that *is* shared is the
// tool-authorization gate (see `composeAuthorize` below): a policy `deny` is
// final, and everything else still goes through Phase 3's auditable
// ApprovalManager exactly as it did before Phase 4 existed.
//
// `io` additions for Phase 4 (all optional):
//
//   io.policy.approver      approval callback for policy decisions
//   io.policy.defaultEffect 'allow' (default) or 'deny' for a locked-down install
//   io.harness.probe        host probe: ({ id, command }) -> { installed, version, path }
//   io.harness.transports   harness id -> transport ({ start, stop, send, … }), or
//                           io.harness.perHarness for per-harness overrides
//   io.harness.runner       drives a conversation on an external harness
//   io.sandbox.spawn/kill/killTree   the process owner (node-pty / child_process)
//   io.sandbox.backend      an explicit backend, bypassing selection
//   io.costs / io.metrics   routing inputs for cost_aware / performance_aware
//
// `io` additions for Phase 7 (all optional; research degrades rather than
// failing when they are absent):
//
//   io.research.searchProviders  { id: { sourceTypes, search, fetch? } } — the
//                                only place anything reaches the network. Core
//                                imports no HTTP client, exactly as it imports
//                                no model SDK.
//   io.research.mcp              an MCP client ({ listTools, callTool }); without
//                                one the MCP source reports itself unavailable
//   io.research.extractText      ({ path, ext }) -> { text } for PDF/DOCX/images
//   policies.research            §50's settings (see research/index.js)

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

// --- Phase 4 / harness-orchestrator subsystems --------------------------------
const { HarnessRegistry, HarnessManager, registerBuiltinHarnesses } = require('./harness');
const { PolicyManager, actionForTool } = require('./policy');
const { SandboxManager, DEFAULT_CEILING } = require('./sandbox');
const { SessionManager } = require('./session');
const { createArtifactStore } = require('./harness-orchestrator/artifacts');
const {
  AgentRouter,
  createAgentCoordinator,
  createFileLockManager,
  Orchestrator: HarnessOrchestrator,
} = require('./harness-orchestrator');

// --- Phase 7: research -------------------------------------------------------
const { createResearchSubsystem } = require('./research');

function createPlatform({
  io = {}, // { fs, root, cwd, runShell, authorize, hostEnv, inheritEnv, policy, harness, sandbox, costs, metrics }
  loggerOptions = {},
  storeDir = null,
  autoRegisterBuiltinAgents = true,
  autoRegisterBuiltinHarnesses = true,
  loadBaselinePolicies = true,
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

  // Each subsystem takes its storage as a *collection*
  // (persistence/collections.js) rather than a store, so the whole set moves to
  // SQLite or a remote backend by changing one construction here.
  const collections = createCollections(store);

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

  // --- policy (Phase 4) -------------------------------------------------------
  // Built before the tools, because the tool gate consults it too. The default
  // effect is 'allow' so a fresh install behaves exactly as it did before this
  // layer existed unless a host opts into 'deny'; either way the baseline
  // documents are loaded, and because the merge is most-restrictive-wins a host
  // policy can only ever tighten them.
  const policy = new PolicyManager({
    bus,
    logger: logger.child('policy'),
    store,
    defaultEffect: (io.policy && io.policy.defaultEffect) || 'allow',
    approver: (io.policy && io.policy.approver) || null,
  });
  if (loadBaselinePolicies) policy.loadBaseline();

  // --- tools -----------------------------------------------------------------
  // Two gates in front of one call: a policy `deny` is final (the human loop
  // below is never reached, so a human cannot accidentally approve what policy
  // forbids); everything else still becomes a listable, auditable
  // ApprovalManager request exactly as it did before the policy layer existed,
  // unless the host supplies its own callback.
  const tools = new ToolManager({
    bus,
    logger: logger.child('tools'),
    authorize: composeAuthorize({ policy, hostAuthorize: io.authorize || approvals.toolAuthorizer() }),
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
    // §12: workflow instances outlive the process. Without a storeDir this is
    // the in-memory store, so tests and unsaved sessions behave as before.
    collection: collections.workflows,
    shellIo: io.runShell
      ? { run: async (command, opts) => io.runShell({ command, cwd: opts.cwd || io.root || process.cwd(), timeoutMs: opts.timeoutMs, ...opts }) }
      : null,
    execIo: codeExec,
    logger: logger.child('workflows'),
  });

  // --- Phase 3: the world a run happens inside ------------------------------
  //
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

  // --- Phase 4 / harness-orchestrator layers ------------------------------------
  const harnessOptions = io.harness || {};
  const harnesses = new HarnessRegistry({
    bus,
    logger: logger.child('harness'),
    probe: harnessOptions.probe || null,
    installer: harnessOptions.installer || null,
    transports: harnessOptions.transports || {},
  });
  if (autoRegisterBuiltinHarnesses) {
    registerBuiltinHarnesses(harnesses, { perHarness: harnessOptions.perHarness || {}, probe: harnessOptions.probe || null });
  }
  for (const extra of harnessOptions.manifests || []) {
    harnesses.register(extra.manifest || extra, extra);
  }

  const sandboxOptions = io.sandbox || {};
  const sandboxes = new SandboxManager({
    bus,
    logger: logger.child('sandbox'),
    spawn: sandboxOptions.spawn || null,
    kill: sandboxOptions.kill || null,
    killTree: sandboxOptions.killTree || null,
    backend: sandboxOptions.backend || null,
    backendFactory: sandboxOptions.backendFactory || null,
    ceiling: sandboxOptions.ceiling || DEFAULT_CEILING,
    policy,
    store,
  });

  const harnessManager = new HarnessManager({
    registry: harnesses,
    bus,
    logger: logger.child('harness'),
    sandbox: sandboxes,
    policy,
  });

  const sessions = new SessionManager({ bus, logger: logger.child('session'), store });
  // Distinct from Phase 3's `artifacts` (ArtifactManager, workspace-owned):
  // this one carries harness/session provenance instead. Neither replaces
  // the other; see the module comment above.
  const harnessArtifacts = createArtifactStore({ bus, store, logger: logger.child('harness-artifacts') });
  const locks = createFileLockManager({ logger: logger.child('locks'), bus });

  const harnessRouter = new AgentRouter({
    agentRegistry: agents,
    harnessRegistry: harnesses,
    policy,
    bus,
    logger: logger.child('harness-router'),
    costs: io.costs || {},
    metrics: io.metrics || null,
  });

  const harnessCoordinator = createAgentCoordinator({
    bus,
    logger: logger.child('harness-coordinator'),
    agentRegistry: agents,
    policy,
    locks,
    artifacts: harnessArtifacts,
    sessions,
    harnesses: harnessManager,
    sandboxes,
  });

  const harnessOrchestrator = new HarnessOrchestrator({
    bus,
    logger: logger.child('harness-orchestrator'),
    agents,
    runtime,
    router: harnessRouter,
    harnesses: harnessManager,
    policy,
    sandboxes,
    sessions,
    coordinator: harnessCoordinator,
    artifacts: harnessArtifacts,
    memory,
    harnessRunner: harnessOptions.runner || null,
    evaluate: harnessOptions.evaluate || null,
  });

  // --- Phase 7: the research subsystem ----------------------------------------
  //
  // Constructed last because it consumes almost everything above it and owns
  // none of it: the policy engine gates each source, the MemoryManager decides
  // what may be remembered, the trace store records the run, the ArtifactManager
  // holds the report, the ToolManager publishes the capabilities and the
  // AgentRegistry gets a normal read-only agent. No second manager of any kind.
  const research = createResearchSubsystem({
    policy,
    memory: memoryManager,
    traces,
    artifacts,
    toolManager: tools,
    agentRegistry: agents,
    bus,
    logger,
    collections,
    provider,
    io: {
      fs,
      root: io.root || null,
      ...(io.research || {}),
    },
    config: policies.research || {},
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

    // Phase 4 / harness-orchestrator
    policy,
    harnesses,
    harnessManager,
    sandboxes,
    sessions,
    locks,
    harnessArtifacts,
    harnessRouter,
    harnessCoordinator,
    harnessOrchestrator,

    // Phase 7
    research,

    // Release every timer, in-flight decision and spawned process a host is
    // holding. Called when the app quits, so a pending approval or a sandboxed
    // process cannot keep the app alive after the window closes.
    async dispose() {
      approvals.dispose();
      orchestrator.scheduler.cancelAll('platform disposed');
      // Research first: a live research task holds provider requests, and
      // cancelling it is what releases them. Disposing the harnesses out from
      // under it would leave those requests orphaned.
      await research.dispose().catch(() => {});
      await harnessManager.dispose().catch(() => {});
      await sandboxes.cleanup('platform disposed').catch(() => {});
      return true;
    },
  };
}

// The tool gate's authorize callback, with the policy engine in front of it.
//
// Order matters and is the whole point:
//   1. a policy `deny` is final — the human loop below is never reached, so a
//      human cannot accidentally approve what the policy forbids
//   2. a policy `approval` (or `allow`) falls through to `hostAuthorize` —
//      which is the host's own callback if it supplied one, or Phase 3's
//      ApprovalManager-backed authorizer otherwise, so every gated call still
//      becomes a listable, auditable record exactly as it did before this
//      policy layer existed
//
// With no `hostAuthorize` at all the answer is `false`: nothing irreversible
// happens unattended, same as before Phase 4.
function composeAuthorize({ policy, hostAuthorize }) {
  return async ({ agent, tool, input, taskId }) => {
    const action = actionForTool(tool);
    const decision = await policy.evaluate({
      action,
      askApproval: false, // the human loop below is the approval route
      context: { agentId: agent && agent.id, toolId: tool && tool.id, taskId },
    });
    if (decision.effect === 'deny') return false;
    if (!hostAuthorize) return false;
    return (await hostAuthorize({ agent, tool, input, taskId, policy: decision })) === true;
  };
}

module.exports = { createPlatform, composeAuthorize };
