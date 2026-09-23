// RunManager: the one door a run goes through.
//
// Every mutation is persisted and every state change is an event, because the
// question a Run exists to answer — "what happened in that run?" — has to be
// answerable after a restart and from the event stream, not only from memory.
//
// Two rules keep it honest:
//
//   * Arrays are deduplicated and bounded. An agent that emits a thousand tool
//     events must not turn a run record into an unbounded log; the detail lives
//     in the ExecutionTraceStore and the run keeps a capped index of it.
//   * Usage only ever moves in one direction. Tokens and cost are *noted*, not
//     set, so no caller can accidentally reset a run's spend to zero and hide
//     what it cost.

const { TYPES } = require('../events/event-bus');
const { identityRefs } = require('../workspace/identity');
const {
  RUN_STATES, RUN_COLLECTIONS, TERMINAL_STATES,
  isTerminal, assertTransition, createRun, validateRun, runRef,
} = require('./run');

// How many entries of each kind a run keeps. Enough to reconstruct the shape of
// a run, small enough that a runaway agent cannot bloat the store.
const DEFAULT_CAPS = Object.freeze({
  agents: 64,
  tasks: 256,
  tools: 256,
  workflows: 32,
  models: 32,
  providers: 32,
  browserSessions: 32,
  artifacts: 512,
  events: 500,
  errors: 128,
});

class RunManager {
  constructor({ collection = null, bus = null, logger = null, clock = null, caps = {} } = {}) {
    this._collection = collection;
    this._bus = bus;
    this._logger = logger;
    this._now = clock || (() => Date.now());
    this._caps = { ...DEFAULT_CAPS, ...caps };
    this._runs = new Map(); // id -> in-memory record (collection is the durable copy)
  }

  // Records every event that declares a `runId` onto that run's timeline. The
  // event bus is the one stream every subsystem already reports on, so this is
  // how a run becomes a complete index without a single subsystem knowing a Run
  // exists. Returns an unsubscribe function.
  attachBus(bus = this._bus) {
    if (!bus) return () => {};
    return bus.on('*', (ev) => {
      if (!ev || !ev.runId || !this._runs.has(ev.runId)) return;
      this.note(ev.runId, 'events', {
        at: ev.timestamp || this._now(),
        type: ev.type,
        summary: summariseEvent(ev),
        refs: { agentId: ev.agentId || null, taskId: ev.taskId || null, toolId: ev.toolId || null },
      }).catch(() => {});
    });
  }

  // --- lifecycle -----------------------------------------------------------

  // Starts a run. `objective` is required — a run with no stated objective is
  // the thing this whole subsystem exists to prevent.
  async start(def = {}) {
    const run = createRun({ ...def, now: this._now() });
    const { ok, errors } = validateRun(run);
    if (!ok) throw new Error(`invalid run: ${errors.join('; ')}`);
    run.status = RUN_STATES.RUNNING;
    await this._persist(run);
    this._emit(TYPES.RUN_STARTED, run, { objective: run.objective, createdBy: run.createdBy });
    return this.get(run.id);
  }

  get(id) {
    const run = this._runs.get(id);
    return run ? { ...run } : null;
  }

  async load(id) {
    if (this._runs.has(id)) return this.get(id);
    if (!this._collection) return null;
    const record = await this._collection.get(id);
    if (!record) return null;
    this._runs.set(id, record);
    return { ...record };
  }

  async list({ projectId = null, conversationId = null, status = null, limit = 100 } = {}) {
    // Prefer the in-memory index; fall back to the collection when a run was
    // created by a previous process.
    let rows = [...this._runs.values()];
    if (this._collection) {
      const seen = new Set(rows.map((r) => r.id));
      for (const record of await this._collection.list()) {
        if (!seen.has(record.id)) rows.push(record);
      }
    }
    rows = rows
      .filter((r) => (!projectId || r.projectId === projectId)
        && (!conversationId || r.conversationId === conversationId)
        && (!status || r.status === status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    return rows.map(runRef);
  }

  // Move a run to a new state through the guarded machine. Returns the run, or
  // null for an unknown / already-settled run. An illegal transition throws:
  // silently ignoring it would let a "completed" run start running again.
  async transition(id, to, { note = null, patch = {} } = {}) {
    const run = this._runs.get(id) || await this._materialize(id);
    if (!run) return null;
    if (run.status === to) return { ...run };
    assertTransition(run.status, to);
    const from = run.status;
    run.status = to;
    Object.assign(run, patch);
    if (to === RUN_STATES.PAUSED) run.pausedAt = this._now();
    if (isTerminal(to)) {
      run.endedAt = this._now();
      run.pausedAt = null;
    }
    if (from === RUN_STATES.PAUSED && to === RUN_STATES.RUNNING) run.pausedAt = null;
    await this._persist(run);
    const eventType = {
      [RUN_STATES.PAUSED]: TYPES.RUN_PAUSED,
      [RUN_STATES.RUNNING]: TYPES.RUN_RESUMED,
      [RUN_STATES.WAITING_FOR_APPROVAL]: TYPES.RUN_UPDATED,
      [RUN_STATES.COMPLETED]: TYPES.RUN_COMPLETED,
      [RUN_STATES.FAILED]: TYPES.RUN_FAILED,
      [RUN_STATES.CANCELLED]: TYPES.RUN_CANCELLED,
      [RUN_STATES.STOPPED]: TYPES.RUN_STOPPED,
    }[to] || TYPES.RUN_UPDATED;
    this._emit(eventType, run, { from, to, note });
    return { ...run };
  }

  pause(id, note = 'paused') { return this.transition(id, RUN_STATES.PAUSED, { note }); }
  resume(id, note = 'resumed') { return this.transition(id, RUN_STATES.RUNNING, { note }); }
  waitForApproval(id, { reason = null } = {}) {
    return this.transition(id, RUN_STATES.WAITING_FOR_APPROVAL, { note: reason });
  }

  async complete(id, { result = null, note = null } = {}) {
    return this.transition(id, RUN_STATES.COMPLETED, { note, patch: { result, error: null } });
  }

  async fail(id, { error = null, note = null } = {}) {
    const message = error instanceof Error ? error.message : (error === null ? 'run failed' : String(error));
    const run = await this.transition(id, RUN_STATES.FAILED, { note, patch: { error: message } });
    if (run) await this.addError(id, { message, code: 'RUN_FAILED' });
    return run;
  }

  cancel(id, { reason = 'cancelled' } = {}) {
    return this.transition(id, RUN_STATES.CANCELLED, { note: reason });
  }

  stop(id, { reason = 'stopped' } = {}) {
    const run = this._runs.get(id);
    if (run && isTerminal(run.status)) return { ...run };
    return this.transition(id, RUN_STATES.STOPPED, { note: reason });
  }

  // A retry is a *new* run that names its predecessor, never a resurrection of
  // the old one: the failed attempt's record has to survive intact, or "what
  // went wrong the first time" is unanswerable.
  async retry(id, { objective = null } = {}) {
    const previous = this._runs.get(id) || await this._materialize(id);
    if (!previous) throw new Error(`no run "${id}" to retry`);
    const next = await this.start({
      objective: objective || previous.objective,
      projectId: previous.projectId,
      conversationId: previous.conversationId,
      rootTaskId: previous.rootTaskId,
      sessionId: previous.sessionId,
      traceId: previous.traceId,
      agentId: previous.agentId,
      createdBy: previous.createdBy,
      metadata: { ...previous.metadata, retriedFrom: previous.id },
    });
    const record = this._runs.get(next.id);
    record.retryOf = previous.id;
    await this._persist(record);
    return { ...record };
  }

  // --- aggregation ---------------------------------------------------------

  // `kind` is one of RUN_COLLECTIONS. Values are deduplicated by their `id` (or
  // the value itself for strings) and capped, so noting the same tool twice is
  // a no-op and a thousand notes cannot grow the record without bound.
  async note(id, kind, value) {
    if (!RUN_COLLECTIONS.includes(kind)) throw new Error(`unknown run collection "${kind}"`);
    const run = this._runs.get(id) || await this._materialize(id);
    if (!run) return null;
    this._push(run, kind, value);
    if (kind === 'events') {
      run.updatedAt = this._now();
    }
    await this._persist(run);
    return { ...run };
  }

  async addAgent(id, agent) { return this.note(id, 'agents', normalizeRef(agent)); }
  async addTask(id, task) { return this.note(id, 'tasks', normalizeRef(task)); }
  async addTool(id, tool) { return this.note(id, 'tools', normalizeRef(tool)); }
  async addWorkflow(id, workflow) { return this.note(id, 'workflows', normalizeRef(workflow)); }
  async addModel(id, model) { return this.note(id, 'models', normalizeRef(model)); }
  async addProvider(id, provider) { return this.note(id, 'providers', normalizeRef(provider)); }
  async addBrowserSession(id, session) { return this.note(id, 'browserSessions', normalizeRef(session)); }
  async addArtifact(id, artifact) { return this.note(id, 'artifacts', normalizeRef(artifact)); }

  async addEvent(id, { type, summary = null, refs = null } = {}) {
    if (!type) throw new Error('run event requires a type');
    return this.note(id, 'events', { at: this._now(), type, summary, refs });
  }

  async addError(id, { message, code = 'RUN_ERROR', agentId = null, taskId = null } = {}) {
    if (!message) throw new Error('run error requires a message');
    return this.note(id, 'errors', { at: this._now(), message: String(message), code, agentId, taskId });
  }

  // Usage is additive by design: there is no setUsage(), so nothing can zero a
  // run's spend by accident.
  async noteUsage(id, { tokens = 0, cost = 0, toolCalls = 0, taskCount = 0 } = {}) {
    const run = this._runs.get(id) || await this._materialize(id);
    if (!run) return null;
    run.usage = {
      tokens: run.usage.tokens + Math.max(0, Number(tokens) || 0),
      cost: run.usage.cost + Math.max(0, Number(cost) || 0),
      toolCalls: run.usage.toolCalls + Math.max(0, Number(toolCalls) || 0),
      taskCount: run.usage.taskCount + Math.max(0, Number(taskCount) || 0),
    };
    run.updatedAt = this._now();
    await this._persist(run);
    return { ...run };
  }

  // --- inspection ----------------------------------------------------------

  // The aggregate a person or a UI asks for: counts, spend, duration and the
  // capped event/error lists — in one object, without reading five subsystems.
  async inspect(id) {
    const run = this._runs.get(id) || await this._materialize(id);
    if (!run) return null;
    return {
      ...runRef(run),
      result: run.result,
      error: run.error,
      usage: { ...run.usage },
      agents: run.agents.map((a) => ({ ...a })),
      tasks: run.tasks.map((t) => ({ ...t })),
      tools: run.tools.map((t) => ({ ...t })),
      workflows: run.workflows.map((w) => ({ ...w })),
      models: run.models.map((m) => ({ ...m })),
      providers: run.providers.map((p) => ({ ...p })),
      browserSessions: run.browserSessions.map((b) => ({ ...b })),
      artifacts: run.artifacts.map((a) => ({ ...a })),
      events: run.events.slice(-100).map((e) => ({ ...e })),
      errors: run.errors.map((e) => ({ ...e })),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      metadata: { ...run.metadata },
    };
  }

  // The execution timeline (prompt §34): every recorded event, oldest first,
  // with the elapsed offset so a slow step is visible without math.
  async timeline(id) {
    const run = this._runs.get(id) || await this._materialize(id);
    if (!run) return null;
    return run.events.map((e) => ({ ...e, offsetMs: e.at - run.startedAt }));
  }

  siblingRuns(id) {
    const run = this._runs.get(id);
    if (!run) return [];
    if (!run.retryOf) return [];
    return this.list({ conversationId: run.conversationId }).filter((r) => r.retryOf === run.retryOf || r.id === run.retryOf);
  }

  // --- internals -----------------------------------------------------------

  async _materialize(id) {
    if (this._runs.has(id)) return this._runs.get(id);
    if (!this._collection) return null;
    const record = await this._collection.get(id);
    if (record) this._runs.set(record.id, record);
    return record || null;
  }

  _push(run, kind, value) {
    if (value === null || value === undefined) return;
    const list = run[kind];
    const cap = this._caps[kind] || 256;
    const key = refKey(value);
    if (key !== null && list.some((entry) => refKey(entry) === key)) return;
    list.push(value);
    if (list.length > cap) list.splice(0, list.length - cap);
  }

  async _persist(run) {
    run.updatedAt = this._now();
    this._runs.set(run.id, run);
    if (this._collection) await this._collection.put(run.id, run);
    return run;
  }

  _emit(type, run, payload) {
    if (!this._bus) return;
    this._bus.emit(type, { ...identityRefs(run), runId: run.id }, payload);
  }
}

function normalizeRef(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return { id: value };
  if (typeof value === 'object') {
    if (value.id) return { id: value.id, ...(value.name ? { name: value.name } : {}), ...(value.role ? { role: value.role } : {}) };
    return { ...value };
  }
  return { id: String(value) };
}

// A short human-readable line for the timeline. Reads the payload's own summary
// when a subsystem supplied one and falls back to the event type — a timeline
// that renders `tool.completed` beats one that renders nothing.
function summariseEvent(ev) {
  const payload = ev.payload;
  if (payload && typeof payload === 'object') {
    if (typeof payload.summary === 'string' && payload.summary) return payload.summary;
    if (typeof payload.title === 'string' && payload.title) return payload.title;
    if (typeof payload.name === 'string' && payload.name) return payload.name;
  }
  return null;
}

function refKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'object') {
    if (value.id !== undefined) return `id:${value.id}`;
    // Events have no id: their identity is when they happened and what they
    // were, which is exactly what makes two identical events deduplicable.
    if (value.type !== undefined && value.at !== undefined) return `ev:${value.at}:${value.type}`;
    return `j:${JSON.stringify(value)}`;
  }
  return `v:${String(value)}`;
}

module.exports = { RunManager, DEFAULT_CAPS, TERMINAL_STATES };
