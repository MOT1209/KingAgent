// ExecutionTraceStore: where traces live, and how many of them.
//
// Traces are the platform's most write-heavy record — one event per tool call,
// per step, per observation — so the store's job is as much about *limits* as
// about lookup. Unbounded event persistence is how a local-first app quietly
// fills a user's disk.
//
// The backing store is injected (persistence/collections.js), so the same code
// keeps a trace in memory during a test and in the atomic JSON store in the
// app. Writes are debounced: a live trace is flushed on completion and on a
// bounded interval, not on every appended event.

const { ExecutionTrace, STATUS } = require('./trace');
const { serializeTrace } = require('./serializer');
const { TYPES } = require('../events/event-bus');
const { identityRefs } = require('../workspace/identity');

const DEFAULTS = Object.freeze({
  maxEvents: 5000,     // per trace
  maxLiveTraces: 50,   // in memory at once
  maxStoredTraces: 500, // on disk; oldest completed are pruned past this
  flushEveryMs: 2000,
});

class ExecutionTraceStore {
  constructor({ collection = null, bus = null, logger = null, options = {} } = {}) {
    this._collection = collection;
    this._bus = bus;
    this._logger = logger;
    this._opts = { ...DEFAULTS, ...options };
    this._live = new Map(); // traceId -> ExecutionTrace
    this._lastFlush = new Map(); // traceId -> ts
  }

  createTrace({ identity, label = '' } = {}) {
    const trace = new ExecutionTrace({
      traceId: identity && identity.traceId,
      identity: identity || {},
      maxEvents: this._opts.maxEvents,
      label,
    });
    this._live.set(trace.traceId, trace);
    this._evictLive();
    this._flush(trace, { force: true });
    if (this._bus) this._bus.emit(TYPES.TRACE_STARTED, identityRefs(trace.identity), { traceId: trace.traceId, label });
    return trace;
  }

  // Appending is the hot path: it must not await the store on every call.
  appendEvent(traceId, type, payload = null, opts = {}) {
    const trace = this._live.get(traceId);
    if (!trace) return null;
    const event = trace.append(type, payload, opts);
    this._flush(trace, { force: false });
    return event;
  }

  getTrace(traceId) {
    return this._live.get(traceId) || null;
  }

  async loadTrace(traceId) {
    const live = this._live.get(traceId);
    if (live) return live;
    if (!this._collection) return null;
    const raw = await this._collection.get(traceId);
    return raw ? ExecutionTrace.fromJSON(raw, { maxEvents: this._opts.maxEvents }) : null;
  }

  listTraces({ status = null, taskId = null, limit = 50 } = {}) {
    return [...this._live.values()]
      .filter((t) => (!status || t.status === status) && (!taskId || t.identity.taskId === taskId))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((t) => this.summarize(t));
  }

  async listPersisted({ limit = 100 } = {}) {
    if (!this._collection) return [];
    const all = await this._collection.list();
    return all
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, limit)
      .map((raw) => ({
        traceId: raw.traceId,
        taskId: raw.identity ? raw.identity.taskId : null,
        label: raw.label || '',
        status: raw.status,
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
        events: (raw.events || []).length,
      }));
  }

  async completeTrace(traceId, summary = null) {
    const trace = this._live.get(traceId);
    if (!trace) return null;
    trace.complete(summary);
    await this._flush(trace, { force: true });
    if (this._bus) {
      this._bus.emit(TYPES.TRACE_COMPLETED, identityRefs(trace.identity), {
        traceId, status: trace.status, ...trace.stats(),
      });
    }
    await this._prune();
    return trace;
  }

  async failTrace(traceId, error) {
    const trace = this._live.get(traceId);
    if (!trace) return null;
    trace.fail(error);
    await this._flush(trace, { force: true });
    if (this._bus) {
      this._bus.emit(TYPES.TRACE_COMPLETED, identityRefs(trace.identity), { traceId, status: trace.status });
    }
    return trace;
  }

  async cancelTrace(traceId, reason) {
    const trace = this._live.get(traceId);
    if (!trace) return null;
    trace.cancel(reason);
    await this._flush(trace, { force: true });
    return trace;
  }

  async deleteTrace(traceId) {
    this._live.delete(traceId);
    this._lastFlush.delete(traceId);
    if (this._collection) await this._collection.delete(traceId);
    return true;
  }

  summarize(trace) {
    const stats = trace.stats();
    return {
      traceId: trace.traceId,
      taskId: trace.identity.taskId,
      workspaceId: trace.identity.workspaceId,
      agentId: trace.identity.agentId,
      label: trace.label,
      status: trace.status,
      startedAt: trace.startedAt,
      completedAt: trace.completedAt,
      events: stats.events,
      tools: stats.tools,
      files: stats.files,
      agents: stats.agents,
      durationMs: stats.durationMs,
    };
  }

  // Serialization scrubs: nothing private and nothing credential-shaped reaches
  // the store, even if an emitter passed it.
  async _flush(trace, { force }) {
    if (!this._collection) return;
    const last = this._lastFlush.get(trace.traceId) || 0;
    if (!force && Date.now() - last < this._opts.flushEveryMs) return;
    this._lastFlush.set(trace.traceId, Date.now());
    try {
      await this._collection.put(trace.traceId, serializeTrace(trace));
    } catch (err) {
      if (this._logger) this._logger.warn('trace flush failed', { traceId: trace.traceId, error: err.message });
    }
  }

  _evictLive() {
    if (this._live.size <= this._opts.maxLiveTraces) return;
    const finished = [...this._live.values()]
      .filter((t) => t.terminal)
      .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
    for (const t of finished) {
      if (this._live.size <= this._opts.maxLiveTraces) break;
      this._live.delete(t.traceId);
      this._lastFlush.delete(t.traceId);
    }
  }

  // Bounded history on disk: oldest *completed* traces go first; a running one
  // is never pruned out from under its task.
  async _prune() {
    if (!this._collection) return 0;
    const ids = await this._collection.ids();
    if (ids.length <= this._opts.maxStoredTraces) return 0;
    const all = await this._collection.list();
    const victims = all
      .filter((t) => t.status && t.status !== STATUS.RUNNING)
      .sort((a, b) => (a.completedAt || a.startedAt || 0) - (b.completedAt || b.startedAt || 0))
      .slice(0, ids.length - this._opts.maxStoredTraces);
    for (const v of victims) await this._collection.delete(v.traceId);
    return victims.length;
  }
}

module.exports = { ExecutionTraceStore, DEFAULTS };
