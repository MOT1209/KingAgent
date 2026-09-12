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

const FORWARD_TYPES = new Set([
  TYPES.TASK_CREATED, TYPES.TASK_QUEUED, TYPES.TASK_STARTED, TYPES.TASK_ANALYZING,
  TYPES.TASK_PLANNING, TYPES.PLAN_CREATED, TYPES.STEP_STARTED, TYPES.STEP_COMPLETED,
  TYPES.STEP_FAILED, TYPES.TASK_FAILED, TYPES.TASK_REPLANNED, TYPES.TASK_CANCELLED,
  TYPES.TASK_COMPLETED, TYPES.TASK_PAUSED, TYPES.TASK_RESUMED, TYPES.AGENT_STARTED,
  TYPES.TOOL_CALLED, TYPES.TOOL_COMPLETED, TYPES.TOOL_FAILED, TYPES.WORKFLOW_STARTED,
  TYPES.WORKFLOW_COMPLETED, TYPES.WORKFLOW_FAILED, TYPES.WORKFLOW_CANCELLED,
  TYPES.APPROVAL_REQUIRED, TYPES.APPROVAL_GRANTED, TYPES.APPROVAL_DENIED,
]);

function createMainPlatform({ storeDir, cwd, askAuthorization, runShellOverride }) {
  const runShell = runShellOverride || createRunShell({ defaultCwd: typeof cwd === 'function' ? cwd() : cwd });
  const authorize = askAuthorization || (async () => false);
  return createPlatform({
    io: { runShell, cwd: typeof cwd === 'function' ? cwd : () => process.cwd(), authorize },
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
  handle('workflow:listInstances', () => []);
  handle('workflow:cancel', ({ id }) => ({ cancelled: true, id }));

  // --- authorizations ----------------------------------------------------------
  ipcMain.handle('agent:authorizeResponse', (event, payload) => {
    const args = validatePayload('agent:authorizeResponse', payload);
    const pending = platform._pendingAuth && platform._pendingAuth.get(args.requestId);
    if (pending) pending(args.approved);
    return { ok: true };
  });
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
  const askAuthorization = (opts) => new Promise((resolve) => {
    const requestId = `auth-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    pendingAuth.set(requestId, resolve);
    const payload = { requestId, tool: opts.tool.id, agent: opts.agent.id, note: opts.tool.permissions.note || '' };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(PUSH_CHANNELS[2], { type: 'approval.required', requestId, payload });
    }
    setTimeout(() => { if (pendingAuth.delete(requestId)) resolve(false); }, 60_000);
  });

  const platform = createMainPlatform({
    storeDir,
    cwd: () => path.join(app.getPath('home')),
    askAuthorization,
  });
  platform._pendingAuth = pendingAuth;

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
};