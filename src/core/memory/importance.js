// How much a memory is worth keeping.
//
// The failure mode this exists to prevent: an agent that remembers everything.
// Every tool result persisted as a memory turns retrieval into noise within one
// session and into a privacy problem within a week. So an observation is scored
// first, and only what clears the bar is even proposed for persistence.
//
// The scale is deliberately coarse — five levels a human can reason about —
// and `temporary` carries a TTL so scratch state expires on its own.

const IMPORTANCE = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low',
  TEMPORARY: 'temporary',
});

const ORDER = Object.freeze(['temporary', 'low', 'normal', 'high', 'critical']);
const RANK = Object.freeze(Object.fromEntries(ORDER.map((l, i) => [l, i])));

// null = no expiry. Temporary memory is scratch: it survives the task it was
// made in and little else.
const TTL_MS = Object.freeze({
  [IMPORTANCE.CRITICAL]: null,
  [IMPORTANCE.HIGH]: null,
  [IMPORTANCE.NORMAL]: 90 * 24 * 60 * 60 * 1000,
  [IMPORTANCE.LOW]: 7 * 24 * 60 * 60 * 1000,
  [IMPORTANCE.TEMPORARY]: 60 * 60 * 1000,
});

// Below this, a candidate is not proposed for persistence at all. NORMAL is
// the bar on purpose: `low` and `temporary` are exactly the high-volume,
// low-signal observations (a directory listing, a passing check) that make a
// memory store useless when they are kept.
const PERSIST_THRESHOLD = IMPORTANCE.NORMAL;

function isImportance(v) {
  return typeof v === 'string' && v in RANK;
}

function rank(level) {
  return RANK[level] === undefined ? -1 : RANK[level];
}

function atLeast(level, minimum) {
  return rank(level) >= rank(minimum);
}

function ttlFor(level) {
  return TTL_MS[level] === undefined ? TTL_MS[IMPORTANCE.NORMAL] : TTL_MS[level];
}

function expiresAt(level, from = Date.now()) {
  const ttl = ttlFor(level);
  return ttl === null ? null : from + ttl;
}

function isExpired(entry, now = Date.now()) {
  return Boolean(entry && entry.expiresAt && entry.expiresAt <= now);
}

// Deterministic scoring, used when nothing explicitly set an importance. It
// rewards durable facts (a decision, a user instruction, a discovered
// constraint) and discounts the high-volume, low-signal stuff (a directory
// listing, a passing test's stdout).
const SIGNAL = [
  [IMPORTANCE.CRITICAL, /\b(?:never|must not|do not|security|credential|breaking change|data loss|irreversible)\b/i],
  [IMPORTANCE.HIGH, /\b(?:decided|convention|always|requires|depends on|architecture|invariant|constraint|prefers?)\b/i],
  [IMPORTANCE.LOW, /\b(?:listed|scanned|printed|no changes|ok|passed)\b/i],
];

const LOW_SIGNAL_SOURCES = new Set(['fs:list', 'search:grep', 'git:status', 'fs:exists']);

function scoreImportance(candidate = {}) {
  if (isImportance(candidate.importance)) return candidate.importance;
  const type = candidate.type || 'observation';
  const text = typeof candidate.content === 'string'
    ? candidate.content
    : JSON.stringify(candidate.content || '');

  if (type === 'preference' || type === 'instruction') return IMPORTANCE.CRITICAL;
  if (type === 'decision' || type === 'constraint') return IMPORTANCE.HIGH;
  if (type === 'summary') return IMPORTANCE.NORMAL;

  for (const [level, re] of SIGNAL) {
    if (re.test(text)) return level;
  }
  if (LOW_SIGNAL_SOURCES.has(candidate.source)) return IMPORTANCE.TEMPORARY;
  if (candidate.failed) return IMPORTANCE.HIGH; // a failure is what a rerun needs to know
  return IMPORTANCE.NORMAL;
}

// Score → weight used by relevance ranking. Not a probability; just a nudge so
// a critical memory outranks a normal one at equal textual relevance.
function weight(level) {
  return 1 + rank(level) * 0.25;
}

module.exports = {
  IMPORTANCE, ORDER, RANK, TTL_MS, PERSIST_THRESHOLD,
  isImportance, rank, atLeast, ttlFor, expiresAt, isExpired, scoreImportance, weight,
};
