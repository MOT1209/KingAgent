// The context budget: a hard ceiling on what gets assembled.
//
// Without one, context size is a function of the repository and the length of
// the session, which means it only ever grows — until a task that worked last
// week overflows the window this week, mid-run, with no signal beforehand.
//
// The budget is enforced *before* anything reaches a model:
//   * de-duplicate — the same file read by three steps is one entry
//   * trim — a 200 KB test log becomes its head and tail, marked as trimmed
//   * fit — fill in the order selector.js produced, stop at the ceiling
//   * account — always report what was dropped, never drop silently
//
// Size is measured in characters. Tokens are model-specific and a tokenizer is
// a dependency; chars/4 is the standard approximation and it is applied in one
// place so a real tokenizer can replace it here alone.

const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
  maxChars: 48_000,       // ≈12k tokens: room to work inside a small window
  maxItems: 120,
  maxItemChars: 6_000,    // any single item is trimmed past this
  reserveChars: 2_000,    // headroom the assembler keeps for its own framing
  headLines: 40,
  tailLines: 20,
});

const CHARS_PER_TOKEN = 4;

function estimateChars(value) {
  if (typeof value === 'string') return value.length;
  if (value === null || value === undefined) return 0;
  try { return JSON.stringify(value).length; } catch { return String(value).length; }
}

function estimateTokens(value) {
  return Math.ceil(estimateChars(value) / CHARS_PER_TOKEN);
}

function digest(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

// Head + tail, because the interesting parts of a long output are at both ends:
// the command that ran and the failure that ended it.
function trimText(text, maxChars, { headLines = DEFAULTS.headLines, tailLines = DEFAULTS.tailLines } = {}) {
  const str = String(text);
  if (str.length <= maxChars) return { text: str, trimmed: false, originalChars: str.length };
  const lines = str.split('\n');
  if (lines.length > headLines + tailLines) {
    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(-tailLines).join('\n');
    const omitted = lines.length - headLines - tailLines;
    const joined = `${head}\n… ${omitted} lines omitted …\n${tail}`;
    if (joined.length <= maxChars) return { text: joined, trimmed: true, originalChars: str.length };
  }
  const keep = Math.max(0, maxChars - 24);
  return {
    text: `${str.slice(0, keep)}\n… ${str.length - keep} chars omitted …`,
    trimmed: true,
    originalChars: str.length,
  };
}

function contentText(item) {
  if (typeof item.content === 'string') return item.content;
  if (item.content === null || item.content === undefined) return '';
  try { return JSON.stringify(item.content); } catch { return String(item.content); }
}

// Identical content, whatever it is called, is carried once. The survivor keeps
// the earliest position (selector.js already ordered by importance).
function dedupe(items) {
  const seen = new Map();
  const out = [];
  const dropped = [];
  for (const item of items) {
    const key = `${item.kind}:${digest(contentText(item))}`;
    if (seen.has(key)) {
      dropped.push({ kind: item.kind, id: item.id, reason: 'duplicate', duplicateOf: seen.get(key) });
      continue;
    }
    seen.set(key, item.id);
    out.push(item);
  }
  return { items: out, dropped };
}

function createBudget(options = {}) {
  const limits = { ...DEFAULTS, ...options };

  return {
    limits,
    estimateChars,
    estimateTokens,

    // Items must already be ordered (selector.select). Required items are
    // admitted even when they exceed what is left — being over budget is
    // recoverable, silently losing the objective is not — but they are trimmed
    // first and the overflow is reported.
    fit(items) {
      const { items: unique, dropped: duplicates } = dedupe(items || []);
      const ceiling = Math.max(0, limits.maxChars - limits.reserveChars);
      const included = [];
      const dropped = [...duplicates];
      let used = 0;

      for (const item of unique) {
        if (included.length >= limits.maxItems) {
          dropped.push({ kind: item.kind, id: item.id, reason: 'item-limit' });
          continue;
        }
        const raw = contentText(item);
        const perItemCap = Math.min(limits.maxItemChars, Math.max(200, ceiling - used));
        const required = item.relevance === 'required';
        const cut = trimText(raw, required ? Math.min(limits.maxItemChars, raw.length) : perItemCap);
        const cost = cut.text.length;

        if (!required && used + cost > ceiling) {
          dropped.push({ kind: item.kind, id: item.id, reason: 'budget', chars: cost });
          continue;
        }
        included.push({
          ...item,
          content: cut.text,
          chars: cost,
          trimmed: cut.trimmed,
          ...(cut.trimmed ? { originalChars: cut.originalChars } : {}),
        });
        used += cost;
      }

      return {
        items: included,
        dropped,
        usedChars: used,
        usedTokens: Math.ceil(used / CHARS_PER_TOKEN),
        maxChars: limits.maxChars,
        reserveChars: limits.reserveChars,
        overBudget: used > ceiling,
        utilization: limits.maxChars > 0 ? Number((used / limits.maxChars).toFixed(3)) : 0,
      };
    },
  };
}

module.exports = { createBudget, trimText, dedupe, estimateChars, estimateTokens, digest, DEFAULTS, CHARS_PER_TOKEN };
