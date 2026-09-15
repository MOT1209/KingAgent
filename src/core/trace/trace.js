// ExecutionTrace: the ordered, correlated record of one execution.
//
// The Phase 2 task already kept a small `trace` array, but it was per-task,
// in-memory, unbounded in shape and invisible to anything but the task itself.
// An ExecutionTrace is addressable (by traceId), correlated (every event
// carries the full identity), ordered (a per-trace sequence, so two events in
// the same millisecond still sort), bounded (it cannot grow until it is the
// thing that runs the machine out of disk), and persistable.
//
// It is telemetry about *operations*: what ran, what it produced, what failed.
// Never a model's private reasoning — serializer.js scrubs on the way out and
// the event schema has no field for it.

const { TRACE_EVENTS, createTraceEvent } = require('./events');

const STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const DEFAULT_MAX_EVENTS = 5000;

class ExecutionTrace {
  constructor({ traceId, identity = {}, maxEvents = DEFAULT_MAX_EVENTS, label = '' } = {}) {
    this.traceId = traceId || identity.traceId;
    if (!this.traceId) throw new Error('ExecutionTrace requires a traceId');
    this.identity = { ...identity, traceId: this.traceId };
    this.label = label;
    this.status = STATUS.RUNNING;
    this.startedAt = Date.now();
    this.completedAt = null;
    this.events = [];
    this.droppedEvents = 0;
    this._seq = 0;
    this._maxEvents = maxEvents;
  }

  // `identity` on an event defaults to the trace's own, so a caller only passes
  // what differs — a delegate's agentId and workspaceId, typically.
  append(type, payload = null, { identity = null, parentEventId = null, level = 'info' } = {}) {
    this._seq += 1;
    const event = createTraceEvent({
      type,
      identity: { ...this.identity, ...(identity || {}), traceId: this.traceId },
      parentEventId,
      payload,
      seq: this._seq,
      level,
    });
    this.events.push(event);
    if (this.events.length > this._maxEvents) {
      // Drop the oldest rather than refusing new ones: a live run's recent
      // history is what recovery and the UI need. The count is kept so a
      // truncated trace never reads as a complete one.
      const overflow = this.events.length - this._maxEvents;
      this.events.splice(0, overflow);
      this.droppedEvents += overflow;
    }
    return event;
  }

  // Events fathered by `parentEventId` — the delegation tree, one level at a time.
  childrenOf(parentEventId) {
    return this.events.filter((e) => e.parentEventId === parentEventId);
  }

  byType(type) {
    return this.events.filter((e) => e.type === type);
  }

  byAgent(agentId) {
    return this.events.filter((e) => e.agentId === agentId);
  }

  byWorkspace(workspaceId) {
    return this.events.filter((e) => e.workspaceId === workspaceId);
  }

  last(n = 1) {
    return this.events.slice(-n);
  }

  get size() { return this.events.length; }
  get durationMs() { return (this.completedAt || Date.now()) - this.startedAt; }

  complete(summary = null) {
    if (this.status !== STATUS.RUNNING) return this;
    this.status = STATUS.COMPLETED;
    this.completedAt = Date.now();
    this.append(TRACE_EVENTS.COMPLETION, { summary, durationMs: this.durationMs });
    return this;
  }

  fail(error) {
    if (this.status !== STATUS.RUNNING) return this;
    this.status = STATUS.FAILED;
    this.completedAt = Date.now();
    this.append(TRACE_EVENTS.FAILURE, {
      error: String((error && error.message) || error).slice(0, 400),
      durationMs: this.durationMs,
    }, { level: 'error' });
    return this;
  }

  cancel(reason = 'cancelled') {
    if (this.status !== STATUS.RUNNING) return this;
    this.status = STATUS.CANCELLED;
    this.completedAt = Date.now();
    this.append(TRACE_EVENTS.CANCELLED, { reason });
    return this;
  }

  get terminal() {
    return this.status !== STATUS.RUNNING;
  }

  // A counted view for the UI: tools used, files touched, steps run.
  stats() {
    const counts = {};
    for (const e of this.events) counts[e.type] = (counts[e.type] || 0) + 1;
    const tools = new Set();
    const files = new Set();
    const agents = new Set();
    for (const e of this.events) {
      if (e.agentId) agents.add(e.agentId);
      const p = e.payload || {};
      if (p.toolId) tools.add(p.toolId);
      if (p.path) files.add(p.path);
    }
    return {
      events: this.events.length,
      dropped: this.droppedEvents,
      counts,
      tools: [...tools],
      files: [...files],
      agents: [...agents],
      durationMs: this.durationMs,
      status: this.status,
    };
  }

  toJSON() {
    return {
      traceId: this.traceId,
      identity: { ...this.identity },
      label: this.label,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      droppedEvents: this.droppedEvents,
      events: this.events.slice(),
    };
  }

  static fromJSON(raw, { maxEvents = DEFAULT_MAX_EVENTS } = {}) {
    const trace = new ExecutionTrace({ traceId: raw.traceId, identity: raw.identity || {}, maxEvents, label: raw.label || '' });
    trace.status = raw.status || STATUS.RUNNING;
    trace.startedAt = raw.startedAt || Date.now();
    trace.completedAt = raw.completedAt || null;
    trace.droppedEvents = raw.droppedEvents || 0;
    trace.events = Array.isArray(raw.events) ? [...raw.events] : [];
    trace._seq = trace.events.reduce((max, e) => Math.max(max, e.seq || 0), 0);
    return trace;
  }
}

module.exports = { ExecutionTrace, STATUS, DEFAULT_MAX_EVENTS, TRACE_EVENTS };
