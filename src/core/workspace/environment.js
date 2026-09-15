// The controlled environment an agent runs inside.
//
// `process.env` is the single easiest way to hand a model an API key it was
// never meant to see: one `env` spread into a tool call and the whole parent
// environment — cloud credentials, signing tokens, the user's shell secrets —
// is in a prompt and then in a trace on disk. So a workspace never inherits an
// environment. It is *given* one: an explicit base, plus whatever the host
// deliberately allow-lists by name or prefix.
//
// Two gates, applied in order:
//   1. allow-list — nothing is inherited from the host unless it matches.
//   2. secret shape — a name that looks like a credential is refused even when
//      it matched the allow-list, unless the host passes allowSecrets. Reading
//      is the dangerous direction, so this errs closed.
//
// `toJSON()` (which is what traces, snapshots and IPC payloads serialize) is
// always the redacted view, so a value that did make it in cannot leak through
// persistence by accident.

const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|APIKEY|SESSION|COOKIE|PRIVATE)(?:_|$)/i;
const REDACTED = '[redacted]';

function looksSecret(name) {
  return SECRET_NAME.test(String(name)) || /api[_-]?key/i.test(String(name));
}

function matches(name, patterns) {
  for (const p of patterns) {
    if (p instanceof RegExp) { if (p.test(name)) return true; continue; }
    const s = String(p);
    if (s.endsWith('*')) { if (name.startsWith(s.slice(0, -1))) return true; continue; }
    if (s === name) return true;
  }
  return false;
}

// `base` is what the host decided this workspace needs (PATH, HOME, a project
// flag). `inherit` names what may additionally be copied from `hostEnv`.
function createEnvironment({
  base = {},
  inherit = [],
  deny = [],
  allowSecrets = false,
  hostEnv = null,
} = {}) {
  const allowList = Array.isArray(inherit) ? inherit : [];
  const denyList = Array.isArray(deny) ? deny : [];
  const vars = new Map();
  const blocked = [];

  function admit(name, value, { fromHost }) {
    if (matches(name, denyList)) { blocked.push(name); return false; }
    if (!allowSecrets && looksSecret(name)) { blocked.push(name); return false; }
    if (fromHost && !matches(name, allowList)) { blocked.push(name); return false; }
    vars.set(name, String(value));
    return true;
  }

  for (const [k, v] of Object.entries(base || {})) {
    if (v === undefined || v === null) continue;
    admit(k, v, { fromHost: false });
  }
  if (allowList.length && hostEnv) {
    for (const [k, v] of Object.entries(hostEnv)) {
      if (v === undefined || v === null) continue;
      admit(k, v, { fromHost: true });
    }
  }

  return {
    get(name) {
      return vars.has(name) ? vars.get(name) : undefined;
    },
    // Setting is the host's / a tool's own doing, so it skips the inherit gate
    // but keeps the secret gate: nothing shaped like a credential lands in an
    // environment that will be serialized into a trace.
    set(name, value) {
      if (!name) throw new Error('environment.set requires a name');
      const ok = admit(name, value, { fromHost: false });
      if (!ok) throw new Error(`environment refuses "${name}": denied or credential-shaped`);
      return value;
    },
    has(name) {
      return vars.has(name);
    },
    delete(name) {
      return vars.delete(name);
    },
    names() {
      return [...vars.keys()].sort();
    },
    // The real values. Only a host adapter that is about to spawn a process
    // should call this; everything observable goes through toJSON().
    materialize() {
      return Object.fromEntries(vars);
    },
    // Names that were offered and refused — useful when a command fails because
    // the variable it wanted was never admitted.
    blockedNames() {
      return [...new Set(blocked)].sort();
    },
    redacted() {
      const out = {};
      for (const [k, v] of vars) out[k] = looksSecret(k) ? REDACTED : v;
      return out;
    },
    toJSON() {
      return { names: [...vars.keys()].sort(), values: this.redacted(), blocked: [...new Set(blocked)].sort() };
    },
  };
}

module.exports = { createEnvironment, looksSecret, SECRET_NAME, REDACTED };
