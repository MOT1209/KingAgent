// Core factory: wiring every subsystem together.
//
// The renderer never talks to this directly. The main process constructs a
// platform here, attaches its own IPC layer (see src/main/agent-platform.js)
// and the preload's `window.kingagent.agentPlatform` API, and that is the
// boundary the UI sees. All I/O (fs, shell, workspace) arrives through `io` so
// the factory is fully host-agnostic and unit-testable.
//
// Phase 4 adds the governance and execution layers around the Phase 2 runtime:
//
//   harnesses   execution backends (this runtime, Claude Code, Codex, …)
//   policy      the governance seam every sensitive operation passes through
//   sandboxes   authorized workspaces, limits and process ownership
//   sessions    the container a person's work lives in
//   artifacts   the products of a run, with provenance
//   orchestrator  routing + coordination on top of all of the above
//
// Nothing here executes work at construction time. Registering a harness,
// loading the baseline policies and building the orchestrator are all inert;
// a fresh install can be constructed on a machine with no agents installed.
//
// `io` additions for Phase 4 (all optional):
//
//   io.authorize            the human approval callback the tool gate already used
//   io.policy.approver      approval callback for policy decisions
//   io.policy.defaultEffect 'allow' (default) or 'deny' for a locked-down install
//   io.harness.probe        host probe: ({ id, command }) -> { installed, version, path }
//   io.harness.transports   harness id -> transport ({ start, stop, send, … }), or
//                           io.harness.perHarness for per-harness overrides
//   io.harness.runner       drives a conversation on an external harness
//   io.sandbox.spawn/kill/killTree   the process owner (node-pty / child_process)
//   io.sandbox.backend      an explicit backend, bypassing selection
//   io.costs / io.metrics   routing inputs for cost_aware / performance_aware

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

// Phase 4
const { HarnessRegistry, HarnessManager, registerBuiltinHarnesses } = require('./harness');
const { PolicyManager, actionForTool } = require('./policy');
const { SandboxManager, DEFAULT_CEILING } = require('./sandbox');
const { SessionManager } = require('./session');
const { createArtifactStore } = require('./artifacts');
const {
  AgentRouter,
  createAgentCoordinator,
  createFileLockManager,
  Orchestrator,
} = require('./orchestrator');

function createPlatform({
  io = {}, // { fs, root, cwd, runShell, authorize, policy, harness, sandbox, costs, metrics }
  loggerOptions = {},
  storeDir = null,
  autoRegisterBuiltinAgents = true,
  autoRegisterBuiltinHarnesses = true,
  loadBaselinePolicies = true,
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

  // --- policy ----------------------------------------------------------------
  // Built before the tools, because the tool gate consults it. The default
  // effect is 'allow' so a fresh install behaves exactly as it did before Phase
  // 4 unless a host opts into 'deny'; either way the baseline documents are
  // loaded, and because the merge is most-restrictive-wins a host policy can
  // only ever tighten them.
  const policy = new PolicyManager({
    bus,
    logger: logger.child('policy'),
    store,
    defaultEffect: (io.policy && io.policy.defaultEffect) || 'allow',
    approver: (io.policy && io.policy.approver) || null,
  });
  if (loadBaselinePolicies) policy.loadBaseline();

  // --- tools -----------------------------------------------------------------
  const hostAuthorize = typeof io.authorize === 'function' ? io.authorize : null;
  const tools = new ToolManager({
    bus,
    logger: logger.child('tools'),
    authorize: composeAuthorize({ policy, hostAuthorize }),
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

  // --- Phase 4 layers ---------------------------------------------------------
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
  const artifacts = createArtifactStore({ bus, store, logger: logger.child('artifacts') });
  const locks = createFileLockManager({ logger: logger.child('locks'), bus });

  const router = new AgentRouter({
    agentRegistry: agents,
    harnessRegistry: harnesses,
    policy,
    bus,
    logger: logger.child('router'),
    costs: io.costs || {},
    metrics: io.metrics || null,
  });

  const coordinator = createAgentCoordinator({
    bus,
    logger: logger.child('coordinator'),
    agentRegistry: agents,
    policy,
    locks,
    artifacts,
    sessions,
    harnesses: harnessManager,
    sandboxes,
  });

  const orchestrator = new Orchestrator({
    bus,
    logger: logger.child('orchestrator'),
    agents,
    runtime,
    router,
    harnesses: harnessManager,
    policy,
    sandboxes,
    sessions,
    coordinator,
    artifacts,
    memory,
    harnessRunner: harnessOptions.runner || null,
    evaluate: harnessOptions.evaluate || null,
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

    // Phase 4
    policy,
    harnesses,
    harnessManager,
    sandboxes,
    sessions,
    artifacts,
    locks,
    router,
    coordinator,
    orchestrator,
  };
}

// The tool gate's authorize callback, with the policy engine in front of it.
//
// Order matters and is the whole point:
//   1. a policy `deny` is final — the human loop is never reached, so a human
//      cannot accidentally approve what the policy forbids
//   2. a policy `approval` falls through to the host's approval callback
//   3. otherwise the host's callback still runs, because the tool-level gate
//      (DESTRUCTIVE / requiresAuth) is unchanged by Phase 4
//
// With no host callback wired the answer is `false`, which is exactly what the
// ToolManager did before: nothing irreversible happens unattended.
function composeAuthorize({ policy, hostAuthorize }) {
  return async ({ agent, tool, input, taskId }) => {
    const action = actionForTool(tool);
    const decision = await policy.evaluate({
      action,
      askApproval: false, // the host's human loop below is the approval route
      context: { agentId: agent && agent.id, toolId: tool && tool.id, taskId },
    });
    if (decision.effect === 'deny') return false;
    if (!hostAuthorize) return false;
    return (await hostAuthorize({ agent, tool, input, taskId, policy: decision })) === true;
  };
}

module.exports = { createPlatform, composeAuthorize };
