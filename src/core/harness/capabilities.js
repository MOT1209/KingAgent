// Harness capabilities: the vocabulary a harness declares and the router reads.
//
// Two shapes exist on purpose, because both are useful and conflating them
// caused the mess this file exists to prevent:
//
//   * `tags`     — plain words a manifest author writes ("git", "streaming").
//                  Cheap to declare, easy to read in YAML.
//   * `supports` — normalised booleans the rest of the platform tests before it
//                  calls `pause()`, `send()`, or expects structured events.
//
// `deriveSupports(tags)` is the single translation between them, so a manifest
// only ever needs the tags and every consumer tests the booleans. Nothing here
// guesses: a tag that is not in the vocabulary is a validation error, not a
// silently-ignored typo that makes a harness look more capable than it is.

// Every tag a manifest may declare. Adding one here is how a new harness gets
// to advertise a new ability — the router matches against these strings.
const CAPABILITY_TAGS = Object.freeze([
  'coding',            // edits code in a workspace
  'terminal',          // runs shell commands
  'files',             // reads/writes files
  'git',               // git operations
  'streaming',         // emits incremental output
  'review',            // can act as a reviewer of another agent's diff
  'planning',          // produces plans
  'research',          // read-only investigation
  'browser',           // can drive a browser
  'mcp',               // speaks MCP
  'model_selection',   // model can be chosen per run
  'structured_events', // emits normalised lifecycle events, not raw stdout
  'pause',             // supports pause/resume
  'parallel',          // safe to run several instances at once
]);

const CAPABILITY_SET = new Set(CAPABILITY_TAGS);

// tag -> the supports* boolean(s) it turns on. The reverse direction does not
// exist on purpose: supports flags are derived, never authoritative.
const SUPPORT_MAP = Object.freeze({
  pause: ['supportsPause', 'supportsResume'],
  streaming: ['supportsStreaming'],
  files: ['supportsFiles'],
  terminal: ['supportsTerminal'],
  browser: ['supportsBrowser'],
  mcp: ['supportsMCP'],
  model_selection: ['supportsModelSelection'],
  structured_events: ['supportsStructuredEvents'],
});

// Public description of what a normalised capability object contains.
const SUPPORT_FLAGS = Object.freeze([
  'supportsPause',
  'supportsResume',
  'supportsStreaming',
  'supportsFiles',
  'supportsTerminal',
  'supportsBrowser',
  'supportsMCP',
  'supportsModelSelection',
  'supportsStructuredEvents',
]);

// Dedupe, sort, and reject anything outside the vocabulary. Sorted output means
// two manifests declaring the same abilities produce byte-identical arrays, so
// routing decisions and snapshots are comparable.
function normalizeCapabilities(tags = []) {
  if (!Array.isArray(tags)) throw new TypeError('capabilities must be an array of tags');
  const out = new Set();
  for (const tag of tags) {
    if (typeof tag !== 'string' || !CAPABILITY_SET.has(tag)) {
      throw new Error(`unknown harness capability: ${JSON.stringify(tag)}`);
    }
    out.add(tag);
  }
  return Object.freeze([...out].sort());
}

function deriveSupports(tags) {
  const supports = Object.fromEntries(SUPPORT_FLAGS.map((f) => [f, false]));
  for (const tag of tags) {
    for (const flag of SUPPORT_MAP[tag] || []) supports[flag] = true;
  }
  return Object.freeze(supports);
}

// A capability record: `{ tags, supports, models }`. `models` is the model ids
// the harness can drive, which the router uses to honour an agent's model
// binding without knowing anything about the vendor.
function createCapabilities({ tags = [], models = [] } = {}) {
  const list = normalizeCapabilities(tags);
  return Object.freeze({
    tags: list,
    supports: deriveSupports(list),
    models: Object.freeze([...new Set((Array.isArray(models) ? models : []).filter((m) => typeof m === 'string' && m))].sort()),
  });
}

// Does a capability record satisfy every tag a task requires?
function satisfies(caps, required = []) {
  if (!required || required.length === 0) return true;
  const have = new Set(caps.tags);
  return required.every((tag) => have.has(tag));
}

function describe(caps) {
  return Object.entries(caps.supports).filter(([, on]) => on).map(([flag]) => flag.replace(/^supports/, '').toLowerCase());
}

module.exports = {
  CAPABILITY_TAGS,
  SUPPORT_FLAGS,
  normalizeCapabilities,
  deriveSupports,
  createCapabilities,
  satisfies,
  describe,
};
