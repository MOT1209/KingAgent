// Task context builder: shapes what the runtime, planner and tools can see.
//
// Context is an immutable snapshot of the world at the start of a task run.
// The platform injects adapters that can probe the real workspace (package.json,
// git, etc.) without putting OS-specific logic in core.

function buildTaskContext({ task, agent, workspace, adapters, tools, toolManager }) {
  const probe = adapters && adapters.workspaceProbe ? adapters.workspaceProbe : defaultProbe;
  return {
    request: task.request,
    workspace: { root: workspace ? workspace.root : process.cwd(), cwd: workspace ? (workspace.cwd || workspace.root) : process.cwd() },
    agent: { id: agent.id, name: agent.name, capabilities: [...agent.capabilities], model: { ...agent.model } },
    availableTools: toolManager ? toolManager.list({ capability: null }) : (tools || []),
    phase: task.phase,
    constraints: task.options && task.options.constraints ? task.options.constraints : [],
    memory: { taskMemoryAvailable: Boolean(adapters && adapters.memory) },
    project: probe(workspace),
  };
}

function summarizeContext(ctx) {
  return {
    request: ctx.request.slice(0, 120),
    workspace: ctx.workspace ? ctx.workspace.root : process.cwd(),
    toolCount: (ctx.availableTools || []).length,
    capabilities: ctx.agent.capabilities,
    phase: ctx.phase,
  };
}

function defaultProbe(_workspace) {
  return { hasGit: false, hasPackageJson: false, name: null };
}

module.exports = { buildTaskContext, summarizeContext };