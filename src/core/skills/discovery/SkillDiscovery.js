// SkillDiscovery: which capabilities does *this* task actually need?
//
// The rule the phase brief states and this module exists to enforce: do not
// load every skill. Loading everything is not merely wasteful — it fills the
// context window with instructions for work that is not happening, which makes
// the agent worse, not better. So discovery is a narrowing pass: request text
// in, a small ranked set of taxonomy categories out, and only the skills that
// cover those categories are ever considered.
//
// It is deliberately deterministic and dependency-free: a phrase table plus
// token matching over the taxonomy (core/skills/taxonomy.js). No model call, no
// embedding, no network. That matters for three reasons — discovery runs on
// every request and must be fast; a routing decision has to be explainable
// after the fact ("these words selected these categories"); and a platform that
// cannot discover skills without an LLM cannot discover them offline.
//
// An optional `provider` can *widen* the result (an LLM proposing categories a
// keyword never would), but it can never replace the deterministic pass and its
// suggestions are filtered through the taxonomy like any other input.

const { KEYWORD_PHRASES, KEYWORDS, CATEGORIES, isCategory, groupOf, impliedBy } = require('../taxonomy');

// Weights. Explicit constants rather than inline numbers because these are the
// knobs someone will want to tune, and they should be tunable in one place.
const WEIGHT = Object.freeze({
  PHRASE: 1.0,        // "mcp server" -> mcp-builder
  EXACT_CATEGORY: 1.2, // the request literally names the category
  ALL_TOKENS: 0.7,    // every word of "code review" appears somewhere
  // What the matched work implies but the request did not say: testing after
  // implementation, a security pass after an API. Above MIN_SCORE so it is
  // acted on, below every direct signal so it is what gets trimmed first.
  IMPLIED: 0.65,
  PROVIDER: 0.5,      // an LLM proposed it; never enough on its own to win
});

// A category needs this much evidence to be considered part of the task.
// Below it, the match was a single weak token and acting on it would broaden
// the run rather than narrow it.
const MIN_SCORE = 0.6;
// Wide enough for a genuinely multi-part request ("build it, test it, deploy
// it" is three groups before a single technology is named), narrow enough that
// a vague one does not pull in half the taxonomy.
const MAX_CATEGORIES = 20;

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Token set of the request, with punctuation stripped but dots and dashes kept
// inside words ("next.js", "ci/cd" -> "ci", "cd").
function tokenize(text) {
  return new Set(
    normalize(text)
      .split(/[^a-z0-9.+#/-]+/)
      .map((t) => t.replace(/^[.\-/]+|[.\-/]+$/g, ''))
      .filter((t) => t.length > 1),
  );
}

// Phrase matching with the one bit of morphology that actually matters:
// "vulnerabilities" must match the "vulnerability" entry, and "tests" the
// "test" one. A stemmer would be overkill and would create matches nobody
// wrote; plural forms are the case that recurs.
function containsPhrase(text, phrase) {
  if (text.includes(phrase)) return true;
  if (text.includes(`${phrase}s`)) return true;
  if (phrase.endsWith('y') && text.includes(`${phrase.slice(0, -1)}ies`)) return true;
  return false;
}

// The core pass: text -> scored categories with the evidence that produced them.
function analyze(request, { provider = null, providerCategories = [] } = {}) {
  const text = normalize(request);
  const tokens = tokenize(request);
  const scores = new Map(); // category -> { score, evidence[] }

  const add = (category, weight, evidence) => {
    if (!isCategory(category)) return;
    const entry = scores.get(category) || { score: 0, evidence: [] };
    entry.score += weight;
    if (!entry.evidence.includes(evidence)) entry.evidence.push(evidence);
    scores.set(category, entry);
  };

  // 1. Phrase table, longest phrase first so "mcp server" beats "mcp".
  const consumed = [];
  for (const phrase of KEYWORD_PHRASES) {
    if (!containsPhrase(text, phrase)) continue;
    // Skip a phrase already covered by a longer one that matched at the same
    // place — otherwise "mcp server" also scores everything "mcp" implies.
    if (consumed.some((longer) => longer.includes(phrase))) continue;
    consumed.push(phrase);
    for (const category of KEYWORDS[phrase]) add(category, WEIGHT.PHRASE, `phrase "${phrase}"`);
  }

  // 2. The taxonomy names itself. "code-review", "code review" and "codereview"
  // in a request are all the user naming a category directly.
  for (const category of CATEGORIES) {
    const words = category.split('-');
    if (text.includes(category) || text.includes(words.join(' '))) {
      add(category, WEIGHT.EXACT_CATEGORY, `names "${category}"`);
      continue;
    }
    if (words.length > 1 && words.every((w) => tokens.has(w))) {
      add(category, WEIGHT.ALL_TOKENS, `mentions ${words.map((w) => `"${w}"`).join(' + ')}`);
    }
  }

  // 3. One level of implication from what matched directly. Snapshot the
  // direct matches first so implications cannot imply further implications —
  // that transitive walk is how a two-word request ends up selecting forty
  // categories.
  for (const [category, entry] of [...scores.entries()]) {
    if (entry.score < MIN_SCORE) continue;
    for (const implied of impliedBy(category)) {
      if (scores.has(implied)) continue; // a direct match already scored it higher
      add(implied, WEIGHT.IMPLIED, `implied by "${category}"`);
    }
  }

  // 4. Optional model suggestions, filtered through the taxonomy. A provider
  // cannot invent a category, and its weight alone never clears MIN_SCORE, so a
  // hallucinated suggestion cannot pull a skill into a run by itself.
  for (const category of providerCategories) {
    add(category, WEIGHT.PROVIDER, 'proposed by the model');
  }

  const ranked = [...scores.entries()]
    .map(([category, { score, evidence }]) => ({
      category,
      group: groupOf(category),
      score: Math.round(score * 100) / 100,
      evidence,
    }))
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || (a.category < b.category ? -1 : 1))
    .slice(0, MAX_CATEGORIES);

  return {
    request: String(request || ''),
    categories: ranked,
    groups: [...new Set(ranked.map((c) => c.group).filter(Boolean))],
    matchedPhrases: consumed,
    usedProvider: Boolean(provider) && providerCategories.length > 0,
  };
}

// Discovery against a registry: the categories a task needs, and the installed
// skills that cover them.
//
// `missing` is the interesting half of the answer and is reported rather than
// hidden: a category the task needs and nothing installed covers is exactly
// what the recommendation pass turns into "search skills.sh for this".
function discover({ request, registry, provider = null, providerCategories = [], platform = null } = {}) {
  const analysis = analyze(request, { provider, providerCategories });
  const covered = [];
  const missing = [];
  const seen = new Map(); // skill key -> { record, categories[], score }

  for (const entry of analysis.categories) {
    const records = registry ? registry.byCategory(entry.category) : [];
    const usable = platform ? records.filter((r) => r.manifest.supportedPlatforms.includes(platform)) : records;
    if (usable.length === 0) {
      missing.push(entry);
      continue;
    }
    covered.push(entry);
    for (const record of usable) {
      const key = `${record.id}@${record.version}`;
      const hit = seen.get(key) || { record, categories: [], score: 0 };
      hit.categories.push(entry.category);
      hit.score += entry.score;
      seen.set(key, hit);
    }
  }

  return {
    ...analysis,
    covered,
    missing,
    // Candidates carry their *discovery* score only. Ranking (SkillRanking) is
    // a separate pass that folds in trust, quality and history — keeping them
    // apart is what lets the UI explain "relevant because…" and "chosen
    // because…" as two different sentences.
    candidates: [...seen.values()]
      .map((h) => ({ record: h.record, matchedCategories: h.categories.sort(), relevance: Math.round(h.score * 100) / 100 }))
      .sort((a, b) => b.relevance - a.relevance || (a.record.id < b.record.id ? -1 : 1)),
  };
}

module.exports = { WEIGHT, MIN_SCORE, MAX_CATEGORIES, normalize, tokenize, containsPhrase, analyze, discover };
