// Text normalization for research, built on core/memory/relevance.js's
// tokenizer rather than beside it.
//
// Why this exists. `relevance.tokenize` keeps `.`, `/` and `-` inside tokens on
// purpose: memory entries are full of paths and module names, and splitting
// `src/core/index.js` into four tokens would make them unfindable. Research text
// is prose, and there the same rule is a bug — a sentence ending "…supports
// stdio and HTTP transports." yields the token `transports.`, which never
// matches the query's `transports`, so the best sentence on the page scores
// zero.
//
// So: same tokenizer, one extra pass that trims boundary punctuation and keeps
// internal punctuation intact. `modelcontextprotocol.io` and `v1.2.0` survive;
// `transports.` becomes `transports`.

const { tokenize: baseTokenize, STOP_WORDS } = require('../memory/relevance');

// Interrogatives carry no search value and dilute every coverage ratio they
// appear in: "what transports does MCP support" has four content-ish tokens, of
// which one is `what`, so a perfect sentence can only score 0.75.
const QUESTION_WORDS = Object.freeze(new Set([
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'tell', 'explain', 'describe', 'give', 'show', 'list', 'find',
]));

// The lightest possible stemmer: plural and third-person `-s`.
//
// Without it "what transports does MCP support" misses "It supports stdio and
// HTTP transports", which is the sentence the question is about — the two most
// informative tokens differ only by an `s`. A full stemmer (Porter et al) is a
// dependency and a source of surprising collisions; this handles the one
// inflection that actually costs recall here and stops.
//
// Guarded so it cannot eat a real word: `ss` (class, address), `us` (status,
// bus), `is` (analysis), `-ss`-like endings, anything under four characters,
// and anything containing internal punctuation (a path, a version, a domain).
function stem(token) {
  if (token.length < 4) return token;
  if (/[./_-]/.test(token)) return token;
  if (/(?:ss|us|is|as|os)$/.test(token)) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('es') && /(?:ch|sh|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

// Leading/trailing punctuation only. An internal dot or slash is part of the
// token and is left alone.
function trimBoundaries(token) {
  return token.replace(/^[./_-]+/, '').replace(/[./_-]+$/, '');
}

// The research tokenizer. Same shape as relevance.tokenize so it can be
// swapped in anywhere that one is used.
function tokenize(text, { dropQuestionWords = true, stemming = true } = {}) {
  const out = [];
  for (const raw of baseTokenize(text)) {
    const trimmed = trimBoundaries(raw);
    if (trimmed.length < 2) continue;
    if (STOP_WORDS.has(trimmed)) continue;
    if (dropQuestionWords && QUESTION_WORDS.has(trimmed)) continue;
    const t = stemming ? stem(trimmed) : trimmed;
    // Stemming can produce a stop word ("does" -> "doe" does not, but "was" ->
    // "wa" would slip through), so the check runs on both forms.
    if (t.length < 2 || STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function tokenSet(text, opts) {
  return new Set(tokenize(text, opts));
}

// How much of `queryTokens` is present in `textTokens`. Same definition as
// relevance.overlap, restated here so both sides use the same token shape.
function coverage(queryTokens, textTokens) {
  if (queryTokens.size === 0 || textTokens.size === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (textTokens.has(t)) hits += 1;
  return hits / queryTokens.size;
}

module.exports = { tokenize, tokenSet, coverage, stem, trimBoundaries, QUESTION_WORDS };
