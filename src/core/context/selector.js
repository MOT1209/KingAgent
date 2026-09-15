// Deciding what the model is allowed to see.
//
// A context manager that forwards everything it has is just an expensive way to
// blow a context window: the important thing gets buried, cost scales with
// repository size, and two unrelated tasks look identical to the model.
//
// So every candidate is classified — required / relevant / optional /
// irrelevant — and then ordered by a fixed priority that reflects what actually
// helps: what am I doing right now, what did I just learn, what is this project.
// Budgeting (budget.js) then cuts from the bottom. Irrelevant items never reach
// the budget at all.

const RELEVANCE = Object.freeze({
  REQUIRED: 'required',
  RELEVANT: 'relevant',
  OPTIONAL: 'optional',
  IRRELEVANT: 'irrelevant',
});

const RELEVANCE_RANK = Object.freeze({ required: 0, relevant: 1, optional: 2, irrelevant: 3 });

// The kinds of thing a packet can carry, in the order Phase 3 specifies. Lower
// index = kept longer when the budget bites.
const KIND_PRIORITY = Object.freeze([
  'task',            // 1. what we were asked to do
  'step',            // 2. the step being executed
  'file',            // 3. relevant files
  'tool-result',     // 4. recent tool results
  'memory',          // 5. relevant memories
  'agent',           // 6. agent instructions
  'workflow',        // 7. workflow / execution state
  'project',         // 8. project metadata
  'history',         //    older historical information, last
]);

function kindRank(kind) {
  const i = KIND_PRIORITY.indexOf(kind);
  return i === -1 ? KIND_PRIORITY.length : i;
}

// An item is `{ kind, id, content, tags?, at?, score?, required?, relevance? }`.
// An explicit `relevance` or `required` always wins: a caller that knows
// something must be present should not have to phrase it as a keyword.
function classify(item, { task = '', step = '', now = Date.now(), recentWindowMs = 5 * 60 * 1000 } = {}) {
  if (!item) return RELEVANCE.IRRELEVANT;
  if (item.relevance && item.relevance in RELEVANCE_RANK) return item.relevance;
  if (item.required === true) return RELEVANCE.REQUIRED;

  // The objective, the current step and the agent's own instructions are the
  // frame the model reasons in; without them the rest is uninterpretable.
  if (item.kind === 'task' || item.kind === 'step' || item.kind === 'agent') return RELEVANCE.REQUIRED;

  const text = textOf(item).toLowerCase();
  const words = keywords(`${task} ${step}`);
  const hit = words.length > 0 && words.some((w) => text.includes(w));
  const fresh = typeof item.at === 'number' && now - item.at <= recentWindowMs;
  const scored = typeof item.score === 'number' && item.score > 0.2;

  if (hit || scored) return RELEVANCE.RELEVANT;
  if (fresh) return RELEVANCE.RELEVANT;
  if (item.kind === 'project') return RELEVANCE.RELEVANT; // small, and orients everything else
  if (item.kind === 'history') return RELEVANCE.OPTIONAL;
  if (!text.trim()) return RELEVANCE.IRRELEVANT;
  return RELEVANCE.OPTIONAL;
}

function textOf(item) {
  if (typeof item.content === 'string') return item.content;
  if (item.content === null || item.content === undefined) return '';
  try { return JSON.stringify(item.content); } catch { return String(item.content); }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'please', 'then', 'run', 'fix', 'all']);

function keywords(text) {
  return [...new Set(String(text).toLowerCase().split(/[^a-z0-9_./-]+/))]
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 24);
}

// Classify, drop the irrelevant, and order by (relevance, kind priority, score,
// recency). Deterministic: equal items keep their input order via the index
// tiebreak, so a packet built twice from the same inputs is byte-identical.
function select(items, opts = {}) {
  const classified = (items || [])
    .filter(Boolean)
    .map((item, index) => ({ ...item, relevance: classify(item, opts), index }));

  const kept = classified.filter((i) => i.relevance !== RELEVANCE.IRRELEVANT);
  kept.sort((a, b) =>
    (RELEVANCE_RANK[a.relevance] - RELEVANCE_RANK[b.relevance])
    || (kindRank(a.kind) - kindRank(b.kind))
    || ((b.score || 0) - (a.score || 0))
    || ((b.at || 0) - (a.at || 0))
    || (a.index - b.index));

  return {
    selected: kept.map(({ index: _index, ...rest }) => rest),
    dropped: classified
      .filter((i) => i.relevance === RELEVANCE.IRRELEVANT)
      .map((i) => ({ kind: i.kind, id: i.id, reason: 'irrelevant' })),
  };
}

module.exports = { RELEVANCE, RELEVANCE_RANK, KIND_PRIORITY, kindRank, classify, select, keywords, textOf };
