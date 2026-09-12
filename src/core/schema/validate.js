// Tiny, dependency-free validation helpers.
//
// The whole core subsystem builds on plain objects with known shapes. There is
// no JSON-schema engine in the dependency tree and none is needed yet: every
// definition is small, so a handful of explicit predicates keeps the schemas
// readable, typed in one place, and cheap to run on every IPC or `execute`.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isString(v) {
  return typeof v === 'string';
}

function isArray(v) {
  return Array.isArray(v);
}

function isBoolean(v) {
  return typeof v === 'boolean';
}

function isInteger(v) {
  return Number.isInteger(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// id: [a-z][a-z0-9._:-]* — used for agents, tools, workflows, tasks.
function validId(v) {
  return typeof v === 'string' && /^[a-z][a-z0-9._:-]*$/.test(v);
}

// Returns a copy of `obj` containing only the listed keys. Useful for turning
// an untrusted payload into an object with a known shape instead of trusting
// the caller's object graph.
function pickKnown(obj, keys) {
  if (!isPlainObject(obj)) return null;
  const out = {};
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}

// Collect the first error into `{ ok:false, errors:[...] }` (v1: stop at first).
function fail(errors) {
  return { ok: false, errors: errors.slice(0, 1) };
}

module.exports = {
  isPlainObject,
  isString,
  isArray,
  isBoolean,
  isInteger,
  nonEmptyString,
  validId,
  pickKnown,
  fail,
};