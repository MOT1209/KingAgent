// Serializing a trace — and scrubbing it on the way out.
//
// A trace is persisted, shipped over IPC and shown to users, so it is the most
// likely place for two things to leak: a model's private reasoning (which the
// platform promises never to expose) and a credential that rode along in a tool
// input or an environment map.
//
// Redaction happens here, at the boundary, rather than at every emit site —
// one place to audit, and a new emitter cannot forget it.

const { isForbiddenKey } = require('./events');

const SECRET_KEYS = ['apikey', 'api_key', 'token', 'secret', 'password', 'passwd', 'authorization', 'cookie', 'credential', 'privatekey'];
const REDACTED = '[redacted]';
const REMOVED = '[removed: private reasoning is never traced]';
const MAX_DEPTH = 8;
const MAX_STRING = 20_000;

function looksSecret(key) {
  const low = String(key).toLowerCase().replace(/[-\s]/g, '');
  return SECRET_KEYS.some((s) => low.includes(s.replace(/[-_]/g, '')) || low.includes(s));
}

function scrub(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) return '[truncated: too deep]';
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => scrub(v, depth + 1, seen));
  const out = {};
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) { out[key] = REMOVED; continue; }
    if (looksSecret(key)) { out[key] = REDACTED; continue; }
    out[key] = scrub(value[key], depth + 1, seen);
  }
  return out;
}

function serializeEvent(event) {
  return { ...event, payload: scrub(event.payload) };
}

function serializeTrace(trace) {
  const raw = typeof trace.toJSON === 'function' ? trace.toJSON() : trace;
  return {
    ...raw,
    events: (raw.events || []).map(serializeEvent),
  };
}

function deserializeTrace(text) {
  const raw = typeof text === 'string' ? JSON.parse(text) : text;
  if (!raw || typeof raw !== 'object') throw new Error('trace must be an object');
  if (!Array.isArray(raw.events)) throw new Error('trace must carry an events array');
  return raw;
}

// What a UI shows: ordered, compact, and already free of anything private.
function toActivityStream(trace, { limit = 200 } = {}) {
  const raw = typeof trace.toJSON === 'function' ? trace.toJSON() : trace;
  return (raw.events || [])
    .slice(-limit)
    .map((e) => ({
      at: e.timestamp,
      seq: e.seq,
      type: e.type,
      agentId: e.agentId,
      workspaceId: e.workspaceId,
      summary: summarize(e),
    }));
}

function summarize(event) {
  const p = event.payload || {};
  if (typeof p.summary === 'string') return p.summary.slice(0, 200);
  if (typeof p.title === 'string') return p.title.slice(0, 200);
  if (typeof p.path === 'string') return p.path;
  if (typeof p.toolId === 'string') return p.toolId;
  if (typeof p.error === 'string') return p.error.slice(0, 200);
  return event.type;
}

module.exports = { serializeTrace, deserializeTrace, serializeEvent, scrub, toActivityStream, looksSecret, REDACTED, REMOVED };
