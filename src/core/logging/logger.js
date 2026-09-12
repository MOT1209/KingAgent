// Structured, redacting logger.
//
// One sink, leveled, with a `child(scope)` to tag a subsystem. Every entry is a
// JSON object so a future observer (file, log viewer, cloud) can consume it
// unchanged. Uses the console by default; the main process decides where lines
// actually go.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Keys whose values must never reach a log. Something shaped like a secret,
// a path, or an entire message can be listed; everything is matched by name.
const SECRET_KEYS = ['apikey', 'api_key', 'token', 'secret', 'password', 'authorization', 'cookie', 'key'];

function redacted(value, seen = new Set()) {
  if (Array.isArray(value)) return value.map((v) => redacted(v, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const k of Object.keys(value)) {
      const low = k.toLowerCase();
      out[k] = SECRET_KEYS.some((s) => low.includes(s)) ? '[redacted]' : redacted(value[k], seen);
    }
    return out;
  }
  return value;
}

function createLogger({ level = 'info', sink = console, scope = 'core' } = {}) {
  const threshold = LEVELS[level] == null ? LEVELS.info : LEVELS[level];

  function write(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const row = { ts: new Date().toISOString(), level: lvl, scope, msg };
    if (fields !== undefined) {
      for (const [k, v] of Object.entries(fields)) row[k] = v;
      if (fields.payload) row.payload = redacted(fields.payload);
    }
    const line = JSON.stringify(row);
    const fn = sink[lvl] || sink.info || sink.log;
    fn.call(sink, line);
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    redact: redacted,
    child(childScope) {
      return createLogger({ level, sink, scope: `${scope}:${childScope}` });
    },
  };
}

module.exports = { createLogger, redacted };