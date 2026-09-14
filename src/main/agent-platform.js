// Main-process wiring for the Agent Platform.
//
// Everything the renderer can ask for crosses these three boundaries:
//   1. preload exposes `window.kingagent.agentPlatform` (src/main/preload.js)
//   2. every channel is vetted by core/security/ipc-guard.js
//   3. this module owns the ipcMain handlers and forwards bus events to every
//      BrowserWindow, so a fresh window sees the same agent platform stream.
//
// No top-level electron import: `ipcMain` and window access are injected so the
// module (and its tests) run in plain node.

const { createPlatform } = require('../core/index.js');
const { createRunShell } = require('./platform-shell');
const { validatePayload, CHANNELS, PUSH_CHANNELS } = require('../core/security/ipc-guard');
const { validateWorkflow } = require('../core/workflows/definition');
const { TYPES } = require('../core/events/event-bus');
const { serializeTrace, toActivityStream } = require('../core/trace/serializer');

// What the renderer is told about as it happens.
//
// Phase 4's high-volume signal is `policy.evaluated`, which fires on every
// gated call and is deliberately *not* forwarded: it would put a message on the
// wire for every tool call in every pane. The policy UI reads the audit ring
// over `agent:policyAudit` instead, and only the decisions a person needs to
// see live (denials, approval gates) stream.
const FORWARD_TYPES = new Set([
  TYPES.TASK_CREATED, TYPES.TASK_QUEUED, TYPES.TASK_STARTED, TYPES.TASK_ANALYZING,
  TYPES.TASK_PLANNING, TYPES.PLAN_CREATED, TYPES.STEP_STARTED, TYPES.STEP_COMPLETED,
  TYPES.STEP_FAILED, TYPES.TASK_FAILED, TYPES.TASK_REPLANNED, TYPES.TASK_CANCELLED,
  TYPES.TASK_COMPLETED, TYPES.TASK_PAUSED, TYPES.TASK_RESUMED, TYPES.AGENT_STARTED,
  TYPES.TOOL_CALLED, TYPES.TOOL_COMPLETED, TYPES.TOOL_FAILED, TYPES.WORKFLOW_STARTED,
  TYPES.WORKFLOW_COMPLETED, TYPES.WORKFLOW_FAILED, TYPES.WORKFLOW_CANCELLED,
  TYPES.APPROVAL_REQUIRED, TYPES.APPROVAL_GRANTED, TYPES.APPROVAL_DENIED,

  // Phase 3. These are what the activity stream is made of: a user watching a
  // run sees workspace, context, tool, file, artifact and delegation events —
  // never a model's deliberation, which has no event type by design.
  TYPES.CONTEXT_CREATED, TYPES.CONTEXT_UPDATED,
  TYPES.MEMORY_WRITE, TYPES.MEMORY_SEARCH, TYPES.MEMORY_UPDATED,
  TYPES.WORKSPACE_CREATED, TYPES.WORKSPACE_UPDATED,
  TYPES.WORKSPACE_FILE_ADDED, TYPES.WORKSPACE_FILE_REMOVED, TYPES.WORKSPACE_FILE_MODIFIED,
  TYPES.TRACE_STARTED, TYPES.TRACE_COMPLETED,
  TYPES.AGENT_OBSERVATION, TYPES.AGENT_ACTION, TYPES.AGENT_VALIDATION, TYPES.AGENT_RECOVERY,
  TYPES.ARTIFACT_CREATED, TYPES.ARTIFACT_UPDATED, TYPES.ARTIFACT_DELETED,
  TYPES.STATE_SNAPSHOT_CREATED, TYPES.STATE_SNAPSHOT_RESTORED,
  TYPES.AGENT_MESSAGE, TYPES.AGENT_DELEGATED, TYPES.AGENT_HANDOFF,
  TYPES.ORCHESTRATION_ROUTED, TYPES.ORCHESTRATION_COMPLETED, TYPES.ORCHESTRATION_FAILED,
  TYPES.PROJECT_DETECTED, TYPES.PROJECT_INDEXED,

  // Phase 4 / harness-orchestrator
  TYPES.HARNESS_SELECTED, TYPES.HARNESS_STARTED, TYPES.HARNESS_STOPPED, TYPES.HARNESS_FAILED,
  TYPES.POLICY_DENIED, TYPES.POLICY_APPROVAL_REQUIRED,
  TYPES.SANDBOX_CREATED, TYPES.SANDBOX_STARTED, TYPES.SANDBOX_STOPPED, TYPES.SANDBOX_FAILED, TYPES.SANDBOX_PROCESS_REGISTERED,
  TYPES.SESSION_CREATED, TYPES.SESSION_STARTED, TYPES.SESSION_PAUSED, TYPES.SESSION_RESUMED,
  TYPES.SESSION_COMPLETED, TYPES.SESSION_FAILED, TYPES.SESSION_STOPPED,
  TYPES.AGENT_ROUTED, TYPES.ORCHESTRATOR_STEP,
]);

function createMainPlatform({
  storeDir, cwd, askAuthorization, runShellOverride, root = null, policyApprover, harnessRunner,
}) {
  const runShell = runShellOverride || createRunShell({ defaultCwd: typeof cwd === 'function' ? cwd() : cwd });
  // `askAuthorization` is optional now. When the host does not supply one, the
  // platform's ApprovalManager becomes the gate — a listable, auditable record
  // rather than a closure — and the renderer answers it over `approval:decide`.
  return createPlatform({
    io: {
      runShell,
      root,
      cwd: typeof cwd === 'function' ? cwd : () => process.cwd(),
      ...(askAuthorization ? { authorize: askAuthorization } : {}),
      // The only host variables an agent's environment may inherit. Everything
      // else — and anything credential-shaped even here — is refused by
      // core/workspace/environment.js.
      inheritEnv: ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'SystemRoot', 'ComSpec'],
      hostEnv: process.env,
      // Phase 4. Both are optional: without them the policy engine denies what
      // it cannot get approval for, and an external harness reports that it has
      // no runner. Neither changes the pre-Phase-4 behaviour of the tool gate.
      ...(policyApprover ? { policy: { approver: policyApprover } } : {}),
      ...(harnessRunner ? { harness: { runner: harnessRunner } } : {}),
    },
    storeDir,
  });
}

// Serializable, renderer-safe view of a task (no functions / no class instances).
function taskView(task) {
  return {
    id: task.id,
    request: task.request,
    agentId: task.agentId,
    state: task.state,
    phase: task.phase,
    mode: task.mode,
    plan: task.plan
      ? { id: task.plan.id, objective: task.plan.objective, mode: task.plan.mode, stepCount: task.plan.steps.length }
      : null,
    steps: (task.steps || []).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      attempts: s.attempts,
      toolId: (s.tool && s.tool.id) || null,
      error: (s.output && s.output.error) || null,
    })),
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    cancellation: task.cancellation,
    outcome: task.outcome,
  };
}

function registerIpcHandlers({ ipcMain, platform, forward }) {
  const { agents, tools, runtime, workflows, bus } = platform;
  const emit = forward || (() => {});

  // Event → renderer forwarding.
  bus.on('*', (ev) => {
    if (FORWARD_TYPES.has(ev.type)) emit(ev);
    else if (ev.type.startsWith('approval.')) emit(ev);
  });

  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, payload) => {
      const args = validatePayload(channel, payload);
      return { ok: true, data: await fn(args, event) };
    });
  }

  // --- agents ---------------------------------------------------------------
  handle('agent:listAgents', () =>
    agents.list({ enabled: true }).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
      tools: a.tools,
      model: { provider: a.model.provider, id: a.model.id },
    })),
  );

  handle('agent:get', ({ id }) => {
    const a = agents.get(id);
    return a ? { id: a.id, name: a.name, description: a.description, capabilities: a.capabilities, tools: a.tools } : null;
  });

  handle('agent:listTools', () => tools.list());
  handle('agent:listTasks', () => runtime.listTasks());
  handle('agent:task', ({ id }) => {
    const t = runtime.get(id);
    return t ? taskView(t) : null;
  });
  handle('agent:history', ({ id }) => runtime.history(id));

  handle('agent:runTask', async ({ request, agentId, workspace, mode }) => {
    const task = await runtime.runAgentTask({
      request,
      agentId: agentId || undefined,
      workspace: typeof workspace === 'string' ? { root: workspace, cwd: workspace } : workspace || null,
      options: {},
    }, { mode: mode || 'auto' });
    return taskView(runtime.get(task.id));
  });

  handle('agent:pause', ({ id }) => taskView(runtime.pause(id)));
  handle('agent:resume', ({ id }) => taskView(runtime.resume(id)));
  handle('agent:cancel', ({ id }) => taskView(runtime.cancel(id)));

  // --- workflows --------------------------------------------------------------
  handle('workflow:list', () => [...workflowRegistry.values()].map((w) => w._meta));
  handle('workflow:run', async ({ workflowId, inputs }) => {
    const wf = workflowRegistry.get(workflowId);
    if (!wf) throw new Error(`unknown workflow "${workflowId}"`);
    const instance = await workflows.run(wf.definition, { inputs: inputs || {} });
    return summarizeInstance(instance);
  });
  handle('workflow:get', ({ id }) => {
    const inst = workflows.get(id);
    return inst ? summarizeInstance(inst) : null;
  });
  // Real instances, not an empty list. `list()` reads the engine's own instance
  // table, which since Phase 5 survives a restart (see workflows/engine.js).
  handle('workflow:listInstances', () => workflows.list().map(summarizeInstance));
  // Real cancellation, not a fabricated `{ cancelled: true }`. The engine
  // reports what it actually achieved — an unknown or already-finished instance
  // comes back `cancelled: false` with the reason — and this forwards it
  // verbatim so the UI cannot claim a cancellation that never happened.
  handle('workflow:cancel', ({ id }) => workflows.cancel(id, 'cancelled from the UI'));

  // --- authorizations ----------------------------------------------------------
  ipcMain.handle('agent:authorizeResponse', (event, payload) => {
    const args = validatePayload('agent:authorizeResponse', payload);
    const pending = platform._pendingAuth && platform._pendingAuth.get(args.requestId);
    if (pending) pending(args.approved);
    return { ok: true };
  });

  registerPhase3Handlers({ handle, platform });
  registerPhase4Handlers({ handle, platform });
}

// --- Phase 3 -----------------------------------------------------------------
//
// One rule governs every handler below: the renderer names a *workspace*, and
// the main process reads under that workspace's own policy. It never gets a
// channel that means "give me everything" — no global memory read, no global
// artifact list — because those are exactly the channels a compromised renderer
// would want. A workspace it cannot name is a workspace it cannot reach.
function registerPhase3Handlers({ handle, platform }) {
  const {
    orchestrator, workspaces, traces, artifacts, memoryManager,
    approvals, recovery, projects, coordinator, messages,
  } = platform;

  const need = (subsystem, name) => {
    if (!subsystem) throw new Error(`${name} is not available in this platform`);
    return subsystem;
  };

  // --- orchestration ---------------------------------------------------------
  handle('orchestrator:run', async ({ request, agentId, workspace, mode, sessionId }) => {
    const run = await need(orchestrator, 'orchestrator').handle({
      request,
      agentId: agentId || null,
      mode: mode || 'auto',
      sessionId: sessionId || null,
      workspace: typeof workspace === 'string' ? { root: workspace, cwd: workspace } : workspace || null,
    });
    // `run.result` is a promise and never crosses IPC; the renderer polls
    // `orchestrator:get` or watches the event stream.
    return orchestrator.get(run.id);
  });

  handle('orchestrator:route', ({ request, agentId, mode }) =>
    need(orchestrator, 'orchestrator').route({ request, agentId: agentId || null, mode: mode || 'auto' }));
  handle('orchestrator:get', ({ id }) => need(orchestrator, 'orchestrator').get(id));
  handle('orchestrator:list', () => need(orchestrator, 'orchestrator').list());
  handle('orchestrator:cancel', ({ id }) => ({ cancelled: need(orchestrator, 'orchestrator').cancel(id) }));
  handle('orchestrator:policies', () => {
    const p = need(orchestrator, 'orchestrator').policies;
    return {
      maxConcurrentTasks: p.maxConcurrentTasks,
      maxDelegationDepth: p.maxDelegationDepth,
      maxDelegationsPerTask: p.maxDelegationsPerTask,
      allowMultiAgent: p.allowMultiAgent,
      taskTimeoutMs: p.taskTimeoutMs,
      contextMaxChars: p.context.maxChars,
    };
  });

  // --- workspaces ------------------------------------------------------------
  handle('workspace:get', ({ id }) => {
    const ws = need(workspaces, 'workspaces').get(id);
    return ws ? ws.toJSON() : null;
  });
  handle('workspace:list', () => need(workspaces, 'workspaces').list().map(workspaceView));
  handle('workspace:files', ({ id }) => {
    const ws = need(workspaces, 'workspaces').get(id);
    return ws ? ws.files.toJSON() : null;
  });

  // --- traces ----------------------------------------------------------------
  handle('trace:list', () => need(traces, 'traces').listTraces());
  handle('trace:get', ({ id }) => {
    const trace = need(traces, 'traces').getTrace(id);
    // serializeTrace scrubs on the way out, so nothing private or
    // credential-shaped can reach a renderer even if an emitter passed it.
    return trace ? serializeTrace(trace) : null;
  });
  handle('trace:activity', ({ id }) => {
    const trace = need(traces, 'traces').getTrace(id);
    return trace ? toActivityStream(trace) : [];
  });

  // --- artifacts -------------------------------------------------------------
  handle('artifact:list', async ({ workspaceId, taskId, type }) => {
    const ws = workspaceId ? need(workspaces, 'workspaces').get(workspaceId) : null;
    if (workspaceId && !ws) return [];
    const rows = await need(artifacts, 'artifacts').list({ workspace: ws, taskId: taskId || null, type: type || null });
    return rows.map(artifactView);
  });
  handle('artifact:get', async ({ id, workspaceId }) => {
    const ws = need(workspaces, 'workspaces').get(workspaceId);
    if (!ws) return null;
    const found = await need(artifacts, 'artifacts').get(id, { workspace: ws });
    return found ? artifactView(found, { includeContent: true }) : null;
  });

  // --- memory ----------------------------------------------------------------
  handle('memory:search', async ({ workspaceId, query, limit }) => {
    const ws = need(workspaces, 'workspaces').get(workspaceId);
    if (!ws) return [];
    const hits = await need(memoryManager, 'memory').search(
      { query: query || '', limit: Math.min(Number(limit) || 10, 50) },
      { policy: ws.memoryPolicy() },
    );
    return hits.map(memoryView);
  });
  handle('memory:list', async ({ workspaceId, scope }) => {
    const ws = need(workspaces, 'workspaces').get(workspaceId);
    if (!ws) return [];
    const rows = await need(memoryManager, 'memory').list(
      { scope: scope || 'task', limit: 50 },
      { policy: ws.memoryPolicy() },
    );
    return rows.map(memoryView);
  });

  // --- approvals -------------------------------------------------------------
  handle('approval:pending', ({ taskId }) =>
    need(approvals, 'approvals').getPendingApprovals({ taskId: taskId || null }).map(approvalView));
  handle('approval:decide', ({ id, approved, note }) => {
    const mgr = need(approvals, 'approvals');
    const result = approved ? mgr.approve(id, { note: note || null }) : mgr.reject(id, { note: note || null });
    return result ? approvalView(result) : null;
  });

  // --- state / recovery ------------------------------------------------------
  handle('state:interrupted', () => need(recovery, 'recovery').listInterrupted());
  handle('state:resume', ({ taskId }) => need(recovery, 'recovery').resume(taskId).then(resumeView));
  handle('state:snapshot', async ({ taskId }) => {
    const snap = await need(recovery, 'recovery').store.loadLatest(taskId);
    return snap || null;
  });

  // --- project ---------------------------------------------------------------
  handle('project:detect', ({ root }) => need(projects, 'projects').detect(root));

  // --- multi-agent -----------------------------------------------------------
  handle('agents:lifecycles', ({ taskId }) => need(coordinator, 'coordinator').lifecycles({ taskId: taskId || null }));
  handle('agents:messages', ({ taskId }) =>
    need(messages, 'messaging').history({ taskId }).map(messageView));
}

// --- renderer-safe views -------------------------------------------------------
// Each of these exists so a class instance, a function or a raw payload can
// never reach `webContents.send`. IPC carries plain data only.

function workspaceView(ws) {
  return {
    workspaceId: ws.workspaceId,
    taskId: ws.taskId,
    agentId: ws.agentId,
    projectId: ws.projectId,
    traceId: ws.traceId,
    root: ws.root,
    status: ws.status,
    files: ws.files.summary(),
    artifacts: ws.artifactIds.length,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
  };
}

// The one Artifact shape the renderer sees (§6).
//
// Two stores produce artifacts and both are kept, because their ownership rules
// genuinely differ: the workspace-owned ArtifactManager reads under a
// workspace's own policy, while the harness store carries execution provenance
// for runs that may span workspaces. What must NOT differ is the shape the UI
// has to understand, so both go through here and come out as one model:
//
//   identity     id, type, name, summary
//   provenance   taskId, workspaceId, agentId, harnessId, sessionId, traceId,
//                delegationId  — absent ones are null, never missing
//   storage      a single `storage` reference, whichever store produced it
//
// The pre-Phase-5 top-level fields (path/bytes/digest) are still emitted so
// existing readers keep working; `storage` is the field new code should read.
function artifactView(a, { includeContent = false } = {}) {
  const bytes = a.bytes ?? a.size ?? null;
  return {
    // identity
    id: a.id, type: a.type, name: a.name, summary: a.summary || '',
    // provenance — the same key set regardless of which store this came from
    taskId: a.taskId ?? null,
    workspaceId: a.workspaceId ?? null,
    agentId: a.agentId ?? null,
    harnessId: a.harnessId ?? null,
    sessionId: a.sessionId ?? null,
    traceId: a.traceId ?? null,
    delegationId: a.delegationId ?? null,
    // storage reference
    storage: {
      ref: a.ref ?? a.path ?? null,
      path: a.path ?? null,
      bytes,
      digest: a.digest ?? null,
      truncated: a.truncated === true,
    },
    createdAt: a.createdAt ?? null,
    updatedAt: a.updatedAt ?? a.createdAt ?? null,
    // Retained for readers written before Phase 5 unified the shape.
    path: a.path ?? null, bytes, digest: a.digest ?? null,
    ...(includeContent ? { content: a.content ?? null } : {}),
  };
}

function memoryView(m) {
  return {
    id: m.id, type: m.type, scope: m.scope, importance: m.importance,
    content: m.content, tags: m.tags, score: m.score ?? null,
    createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

function approvalView(a) {
  return {
    id: a.id, action: a.action, summary: a.summary, reason: a.reason, risk: a.risk,
    toolId: a.toolId, parameters: a.parameters, status: a.status,
    taskId: a.taskId, agentId: a.agentId,
    requestedAt: a.requestedAt, expiresAt: a.expiresAt, resolvedAt: a.resolvedAt,
  };
}

function messageView(m) {
  return {
    id: m.id, from: m.fromAgent, to: m.toAgent, type: m.type,
    taskId: m.taskId, attachments: m.attachments.length, timestamp: m.timestamp,
  };
}

function resumeView(r) {
  if (!r) return null;
  return {
    ok: r.ok,
    action: r.action,
    reason: r.reason,
    workspaceId: r.workspace ? r.workspace.workspaceId : null,
    resumeStep: r.resumeStep || null,
    pendingApprovals: r.pendingApprovals || [],
    contextRefs: r.contextRefs || [],
    artifactRefs: r.artifactRefs || [],
  };
}

// --- Phase 4: the Agent Control Center (src/core/harness-orchestrator/) ---------
//
// Read-only views plus two deliberate actions (`agent:route` is a dry run;
// `agent:cancelTask` stops work the caller already owns). Every handler is
// defensive about a platform built without the Phase 4 layers, so a host that
// disables them still gets a usable surface instead of a crashed window.
//
// Distinct from Phase 3's `registerPhase3Handlers` above: `orchestrator` here
// is `platform.harnessOrchestrator`, not the Phase 3 `platform.orchestrator`
// the renderer's `orchestrator:*` channels above already use — see the module
// comment at the top of src/core/index.js for why the two coexist.
function registerPhase4Handlers({ handle, platform }) {
  const {
    harnessOrchestrator: orchestrator, policy, harnesses, sandboxes, sessions,
    harnessArtifacts: artifacts, harnessCoordinator: coordinator, harnessRouter: router,
  } = platform;
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : fallback;
  };

  handle('agent:controlCenter', ({ sessionId, taskId }) =>
    orchestrator ? orchestrator.controlCenter({ sessionId: sessionId || null, taskId: taskId || null }) : null);

  handle('agent:harnesses', () => (harnesses ? { harnesses: harnesses.list(), backends: sandboxes ? sandboxes.backendInfo() : null } : { harnesses: [], backends: null }));

  handle('agent:harnessDetect', async ({ id }) => (harnesses ? harnesses.detect({ id: id || null }) : {}));

  handle('agent:sandboxes', () => (sandboxes ? sandboxes.controlView() : { backends: null, sandboxes: [] }));

  handle('agent:sandbox', ({ id }) => (sandboxes ? sandboxes.snapshot(id) : null));

  handle('agent:policies', () => (policy ? { policies: policy.list(), stats: policy.stats(), recent: policy.audit({ limit: 20 }) } : { policies: [], stats: null, recent: [] }));

  handle('agent:policyAudit', ({ limit }) => (policy ? policy.audit({ limit: num(limit, 50) }) : []));

  handle('agent:explainPolicy', ({ action, agentId, taskId, toolId, harnessId, workspaceId }) =>
    policy ? policy.explain({ action, context: { agentId, taskId, toolId, harnessId, workspaceId } }) : null);

  handle('agent:sessions', () => (sessions ? sessions.list() : []));

  handle('agent:session', ({ id }) => (sessions ? sessions.controlView(id) : null));

  // Same `artifactView` as the workspace-owned store above: one Artifact shape
  // reaches the renderer no matter which store produced the row (§6).
  handle('agent:artifacts', ({ taskId, sessionId, type, limit }) =>
    (artifacts ? artifacts.list({ taskId, sessionId, type, limit: num(limit, 100) }) : []).map((a) => artifactView(a)));

  // The content, fetched only when a view actually opens an artifact.
  handle('agent:artifact', ({ id }) => {
    const artifact = artifacts ? artifacts.get(id) : null;
    return artifact ? artifactView(artifact, { includeContent: true }) : null;
  });

  handle('agent:delegations', ({ taskId }) => (coordinator ? coordinator.controlView(taskId) : { taskId, delegations: [], subAgents: [], tree: [] }));

  // Dry-run routing: the same decision the orchestrator would make, with no
  // resources created. This is what makes "why that agent?" answerable in the UI
  // before anything runs.
  handle('agent:route', ({ request, strategy, agentId, harnessId }) =>
    router ? router.route({ request, strategy: strategy || 'capability', agentId, harnessId }) : null);

  handle('agent:cancelTask', async ({ taskId, sessionId }) =>
    orchestrator ? orchestrator.cancel({ sessionId: sessionId || null, taskId, reason: 'user cancelled' }) : { task: null, delegations: [], harnessRuns: [], sandboxes: [] });
}

// --- workflow registry + instance view -------------------------------------------

const workflowRegistry = (() => {
  const all = new Map();
  all.register = (def, _meta) => {
    const { ok, workflow, errors } = validateWorkflow(def);
    if (!ok) throw new Error(`invalid workflow: ${errors.join('; ')}`);
    all.set(workflow.id, { definition: workflow, _meta: { id: workflow.id, name: workflow.name, description: workflow.description } });
    return workflow;
  };
  return all;
})();

function summarizeInstance(inst) {
  return {
    id: inst.id,
    workflowId: inst.workflowId,
    status: inst.status,
    error: inst.error || null,
    nodes: (inst.nodes || []).map((n) => ({ id: n.id, type: n.type, status: n.status, error: n.error || null })),
    outputs: inst.outputs || {},
    // §12/§27: where the run stopped, why it stopped, and the ids that tie it
    // back to a trace. A restored run that was mid-flight reads `interrupted`.
    currentNodeId: inst.currentNodeId || null,
    cancellation: inst.cancellation || null,
    traceId: inst.traceId || null,
    workspaceId: inst.workspaceId || null,
    taskId: inst.taskId || null,
    startedAt: inst.startedAt,
    completedAt: inst.completedAt,
  };
}

// Installs everything into the running Electron app.
function installAgentPlatform({ app, ipcMain }) {
  const { BrowserWindow } = require('electron');
  const path = require('node:path');
  const fs = require('node:fs');

  const storeDir = path.join(app.getPath('userData'), 'agent-platform');
  fs.mkdirSync(storeDir, { recursive: true });

  const pendingAuth = new Map();

  // One approval modal, two callers: the tool gate (DESTRUCTIVE tools) and the
  // policy engine (anything a policy gated on approval). Both go out on the
  // same `approval:event` channel and come back on `agent:authorizeResponse`, so
  // the app shows exactly one kind of "may I?" prompt.
  const askApproval = (request) => new Promise((resolve) => {
    const requestId = `auth-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    pendingAuth.set(requestId, resolve);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(PUSH_CHANNELS[2], { type: 'approval.required', requestId, payload: { requestId, ...request } });
    }
    // An unanswered prompt is a refusal, never a silent yes.
    setTimeout(() => { if (pendingAuth.delete(requestId)) resolve(false); }, 60_000);
  });

  const askAuthorization = (opts) => askApproval({
    tool: opts.tool.id,
    agent: opts.agent.id,
    note: opts.tool.permissions.note || '',
  });

  const policyApprover = ({ action, decision, context }) => askApproval({
    tool: action,
    agent: (context && context.agentId) || '',
    note: decision.reason,
  });

  const platform = createMainPlatform({
    storeDir,
    cwd: () => path.join(app.getPath('home')),
    askAuthorization,
    policyApprover,
  });
  platform._pendingAuth = pendingAuth;

  // §12: workflow history outlives the process. Anything that was mid-flight
  // when the app last closed comes back as `interrupted` rather than claiming
  // to still be running. Failing to reload history must not stop the app from
  // starting, but it is logged rather than swallowed.
  platform.workflows.restore().catch((err) => {
    platform.logger.warn('workflow history could not be restored', { error: err && err.message });
  });

  registerIpcHandlers({
    ipcMain,
    platform,
    forward(ev) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents && !win.webContents.isDestroyed()) {
          const channel = ev.type.startsWith('wf-') || ev.workflowId ? PUSH_CHANNELS[1] : ev.type.startsWith('approval.') ? PUSH_CHANNELS[2] : PUSH_CHANNELS[0];
          win.webContents.send(channel, ev);
        }
      }
    },
  });

  return platform;
}

module.exports = {
  createMainPlatform,
  createIpcHandlers: registerIpcHandlers,
  installAgentPlatform,
  registerWorkflow: (def) => workflowRegistry.register(def),
  listWorkflows: () => [...workflowRegistry.values()].map((w) => w._meta),
  CHANNELS,
  PUSH_CHANNELS,
  validatePayload,
  taskView,
  workspaceView,
  artifactView,
  memoryView,
  approvalView,
};