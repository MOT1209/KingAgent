// ContextManager: assembling the packet an agent runs against.
//
// This is the module that decides what the model sees, and the one place where
// "do not inject the repository" is actually enforced. The pipeline is fixed
// and each stage is a module that can be tested alone:
//
//   gather  → layers.js    (which value wins, and from where)
//   select  → selector.js  (required / relevant / optional / irrelevant)
//   budget  → budget.js    (dedupe, trim, fit, account)
//   freeze  → packet.js    (serializable, deterministic, versioned)
//
// Memory arrives through MemoryManager.search — a ranked handful for *this*
// objective — never a dump. Files arrive as paths plus whatever content a
// caller already read; the manager does not go and read a tree on its own.

const { TYPES } = require('../events/event-bus');
const { identityRefs } = require('../workspace/identity');
const { LAYERS, createLayerStack } = require('./layers');
const { select, RELEVANCE } = require('./selector');
const { createBudget } = require('./budget');
const { createContextPacket, summarizePacket, samePacket } = require('./packet');
const { describeProject } = require('../project/metadata');

class ContextManager {
  constructor({ bus = null, memory = null, projects = null, toolManager = null, logger = null, budget = {}, maxPackets = 200 } = {}) {
    this._bus = bus;
    this._memory = memory;       // MemoryManager, optional
    this._projects = projects;   // ProjectIndexer, optional
    this._tools = toolManager;
    this._logger = logger;
    this._budget = createBudget(budget);
    this._packets = new Map();   // packetId -> packet (bounded)
    this._maxPackets = maxPackets;
  }

  get budget() { return this._budget; }

  // The whole job, in one call.
  //
  // `files` and `previousResults` are supplied by the caller (the orchestrator
  // knows what the last steps produced); `memories` are retrieved here so the
  // "search, don't dump" rule cannot be bypassed by a caller passing its own.
  async build({
    request,
    task = null,
    step = null,
    agent = null,
    workspace = null,
    project = null,
    files = [],
    previousResults = [],
    constraints = [],
    executionState = null,
    skills = [],
    memoryQuery = null,
    memoryLimit = 8,
    globals = {},
  } = {}) {
    const identity = workspace ? workspace.identity : {};
    const objective = String(request || (task && task.request) || '');

    // --- layers ------------------------------------------------------------
    const stack = createLayerStack();
    stack.setAll(LAYERS.GLOBAL, globals);
    if (project) {
      stack.setAll(LAYERS.PROJECT, {
        projectId: project.projectId, projectRoot: project.root, projectType: project.type,
        languages: project.languages, packageManager: project.packageManager,
      });
    }
    if (workspace) {
      stack.setAll(LAYERS.WORKSPACE, {
        workspaceId: workspace.workspaceId, root: workspace.root, cwd: workspace.cwd,
        allowNetwork: workspace.policy.allowNetwork, allowDestructive: workspace.policy.allowDestructive,
      });
    }
    if (agent) {
      stack.setAll(LAYERS.AGENT, {
        agentId: agent.id, agentName: agent.name, capabilities: agent.capabilities || [],
        model: agent.model ? `${agent.model.provider}/${agent.model.id}` : null,
      });
    }
    if (task) stack.setAll(LAYERS.TASK, { taskId: task.id, mode: task.mode, phase: task.phase });
    if (step) stack.setAll(LAYERS.STEP, { stepId: step.id, stepTitle: step.title });
    if (constraints.length) stack.set(LAYERS.TASK, 'constraints', constraints);

    // --- memory ------------------------------------------------------------
    let memories = [];
    if (this._memory && workspace) {
      try {
        memories = await this._memory.search(
          { query: memoryQuery || objective, limit: memoryLimit },
          { policy: workspace.memoryPolicy(), refs: identityRefs(identity) },
        );
      } catch (err) {
        // A memory failure must not take down the task it was meant to help.
        if (this._logger) this._logger.warn('context: memory search failed', { error: err.message });
        memories = [];
      }
    }

    // --- tools -------------------------------------------------------------
    const tools = this._availableTools(agent, workspace);

    // --- candidate items ---------------------------------------------------
    const candidates = [
      { kind: 'task', id: 'objective', content: objective, required: true },
      ...(step ? [{ kind: 'step', id: step.id, content: `${step.title}${step.capability ? ` (${step.capability})` : ''}`, required: true }] : []),
      ...(agent && agent.systemPrompt ? [{ kind: 'agent', id: agent.id, content: agent.systemPrompt, required: true }] : []),
      ...(constraints.length ? [{ kind: 'task', id: 'constraints', content: constraints.join('\n'), required: true }] : []),
      ...(project ? [{ kind: 'project', id: project.projectId, content: describeProject(project), at: project.detectedAt }] : []),
      ...files.map((f, i) => ({
        kind: 'file',
        id: f.path || `file-${i}`,
        content: f.content !== undefined && f.content !== null ? `${f.path}\n${f.content}` : String(f.path || ''),
        at: f.at,
        score: f.score,
        required: Boolean(f.required),
      })),
      ...previousResults.map((r, i) => ({
        kind: 'tool-result',
        id: r.id || r.stepId || `result-${i}`,
        content: typeof r.content === 'string' ? r.content : r,
        at: r.at,
      })),
      ...memories.map((m) => ({ kind: 'memory', id: m.id, content: m.content, score: m.score, at: m.updatedAt })),
      ...(executionState ? [{ kind: 'workflow', id: 'execution-state', content: executionState }] : []),
    ];

    const { selected, dropped: irrelevant } = select(candidates, {
      task: objective,
      step: step ? step.title : '',
    });
    const fitted = this._budget.fit(selected);

    const packet = createContextPacket({
      identity,
      objective,
      task: task ? { id: task.id, request: task.request, mode: task.mode, phase: task.phase, state: task.state } : null,
      step: step ? { id: step.id, title: step.title, capability: step.capability || null } : null,
      agent: agent ? { id: agent.id, name: agent.name, capabilities: agent.capabilities || [], model: agent.model || null } : null,
      project: project ? { projectId: project.projectId, root: project.root, name: project.name, type: project.type, languages: project.languages, packageManager: project.packageManager, hasGit: project.hasGit } : null,
      workspace: workspace ? { workspaceId: workspace.workspaceId, root: workspace.root, cwd: workspace.cwd, status: workspace.status } : null,
      files: files.map((f) => ({ path: f.path, bytes: f.bytes ?? null, reason: f.reason || null })),
      tools,
      skills,
      memories: memories.map((m) => ({ id: m.id, scope: m.scope, importance: m.importance, score: m.score })),
      previousResults: previousResults.map((r) => ({ id: r.id || r.stepId || null, ok: r.ok ?? null })),
      environment: workspace ? workspace.environment.toJSON() : null,
      constraints,
      executionState,
      layers: stack.toJSON(),
      items: fitted.items,
      budget: {
        usedChars: fitted.usedChars, usedTokens: fitted.usedTokens,
        maxChars: fitted.maxChars, utilization: fitted.utilization, overBudget: fitted.overBudget,
      },
      dropped: [...irrelevant, ...fitted.dropped],
    });

    this._remember(packet);
    if (workspace && typeof workspace.attachContext === 'function') workspace.attachContext(packet.id);
    if (this._bus) this._bus.emit(TYPES.CONTEXT_CREATED, identityRefs(identity), summarizePacket(packet));
    return packet;
  }

  // A packet is frozen; "updating" one produces a successor that records what it
  // came from. That keeps the audit trail honest — the original is still what
  // the earlier step ran against.
  update(packet, patch = {}) {
    if (!packet) throw new Error('update requires a packet');
    const next = createContextPacket({
      ...packet,
      ...patch,
      id: null,
      identity: patch.identity || packet.identity,
    });
    this._remember(next);
    if (this._bus) {
      this._bus.emit(TYPES.CONTEXT_UPDATED, identityRefs(packet.identity), {
        ...summarizePacket(next), previousId: packet.id, changed: !samePacket(packet, next),
      });
    }
    return next;
  }

  get(packetId) {
    return this._packets.get(packetId) || null;
  }

  list({ taskId = null, limit = 50 } = {}) {
    const all = [...this._packets.values()]
      .filter((p) => !taskId || p.identity.taskId === taskId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return all.slice(0, limit).map(summarizePacket);
  }

  _availableTools(agent, workspace) {
    if (!this._tools) return [];
    let ids;
    if (agent && typeof this._tools.discover === 'function') ids = this._tools.discover(agent);
    else ids = this._tools.list().map((t) => t.id);
    const allowed = workspace ? ids.filter((id) => workspace.canUseTool(id)) : ids;
    return allowed.map((id) => {
      const t = typeof this._tools.peek === 'function' ? this._tools.peek(id) : { id };
      return t ? { id: t.id, name: t.name, description: (t.description || '').slice(0, 140), level: t.permissions ? t.permissions.level : null } : { id };
    });
  }

  _remember(packet) {
    this._packets.set(packet.id, packet);
    if (this._packets.size > this._maxPackets) {
      const oldest = [...this._packets.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this._packets.delete(oldest.id);
    }
  }
}

module.exports = { ContextManager, RELEVANCE };
