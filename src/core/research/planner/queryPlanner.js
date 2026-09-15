// Query planning (§7): turn one question into the set of searches that will
// actually answer it, without asking the same thing twice.
//
// The decomposition is template-driven and deterministic, with an optional
// model-backed expansion on top. That ordering matters: the deterministic plan
// is always produced first and always survives, so a research task works with
// no model provider configured, and a model can only *add* queries — never
// remove the ones that establish the baseline facts.
//
// Deduplication is not an afterthought. §7 is explicit that redundant queries
// must be avoided, and a decomposition that emits "MCP support in X" for five
// values of X plus "MCP support" is four wasted provider calls. Every candidate
// goes through `queryKey` (word-set normalized) before it is admitted.

const { normalizeQuery, QUERY_INTENT, queryKey } = require('../schemas/researchQuery');
const { SOURCE_TYPES } = require('../schemas/source');
const { CATEGORY } = require('./queryClassifier');
const { tokenize } = require('../text');

// Facet templates per category. Each entry is `[suffix, intent, sourceTypes]`.
// The suffix is appended to the subject, not to the whole question: "X
// licensing" searches better than "compare A and B licensing".
const FACETS = Object.freeze({
  [CATEGORY.COMPARISON]: [
    ['overview', QUERY_INTENT.DEFINITION, [SOURCE_TYPES.WEB, SOURCE_TYPES.DOCUMENTATION]],
    ['features and capabilities', QUERY_INTENT.DISCOVERY, [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.WEB]],
    ['limitations and known issues', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DISCUSSION, SOURCE_TYPES.GITHUB]],
    ['pricing and licensing', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.WEB, SOURCE_TYPES.DOCUMENTATION]],
  ],
  [CATEGORY.DEEP_RESEARCH]: [
    ['overview', QUERY_INTENT.DEFINITION, [SOURCE_TYPES.WEB, SOURCE_TYPES.DOCUMENTATION]],
    ['architecture and design', QUERY_INTENT.DISCOVERY, [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB]],
    ['tool calling support', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB]],
    ['memory and state handling', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DOCUMENTATION]],
    ['security and sandboxing', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB]],
    ['licensing', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.GITHUB, SOURCE_TYPES.WEB]],
    ['repository activity and maintenance', QUERY_INTENT.RECENCY, [SOURCE_TYPES.GITHUB]],
    ['criticism and limitations', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DISCUSSION]],
  ],
  [CATEGORY.GITHUB_RESEARCH]: [
    ['README and project description', QUERY_INTENT.DEFINITION, [SOURCE_TYPES.GITHUB]],
    ['architecture and module layout', QUERY_INTENT.DISCOVERY, [SOURCE_TYPES.GITHUB]],
    ['open issues and pull requests', QUERY_INTENT.DISCOVERY, [SOURCE_TYPES.GITHUB]],
    ['releases and changelog', QUERY_INTENT.RECENCY, [SOURCE_TYPES.GITHUB]],
    ['dependencies and license', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.GITHUB]],
  ],
  [CATEGORY.DOCUMENTATION]: [
    ['official documentation', QUERY_INTENT.DEFINITION, [SOURCE_TYPES.DOCUMENTATION]],
    ['API reference', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DOCUMENTATION]],
    ['configuration options', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DOCUMENTATION]],
  ],
  [CATEGORY.PRODUCT_RESEARCH]: [
    ['overview', QUERY_INTENT.DEFINITION, [SOURCE_TYPES.WEB]],
    ['pricing', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.WEB]],
    ['reviews and user experience', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DISCUSSION]],
    ['alternatives', QUERY_INTENT.DISCOVERY, [SOURCE_TYPES.WEB]],
  ],
  [CATEGORY.ACADEMIC_RESEARCH]: [
    ['recent papers', QUERY_INTENT.DISCOVERY, [SOURCE_TYPES.ACADEMIC]],
    ['survey or review', QUERY_INTENT.DEFINITION, [SOURCE_TYPES.ACADEMIC]],
    ['results and limitations', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.ACADEMIC]],
  ],
  [CATEGORY.TECHNICAL_RESEARCH]: [
    ['how it works', QUERY_INTENT.DEFINITION, [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.WEB]],
    ['implementation details', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.GITHUB, SOURCE_TYPES.DOCUMENTATION]],
    ['benchmarks and performance', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.WEB, SOURCE_TYPES.ACADEMIC]],
  ],
  [CATEGORY.CURRENT_INFORMATION]: [
    ['latest', QUERY_INTENT.RECENCY, [SOURCE_TYPES.WEB, SOURCE_TYPES.NEWS]],
    ['recent changes', QUERY_INTENT.RECENCY, [SOURCE_TYPES.NEWS, SOURCE_TYPES.WEB]],
  ],
  [CATEGORY.NEWS]: [
    ['news', QUERY_INTENT.RECENCY, [SOURCE_TYPES.NEWS]],
    ['announcement', QUERY_INTENT.RECENCY, [SOURCE_TYPES.NEWS, SOURCE_TYPES.WEB]],
  ],
  [CATEGORY.MIXED_RESEARCH]: [
    ['overview', QUERY_INTENT.DEFINITION, [SOURCE_TYPES.WEB]],
    ['detail and evidence', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.WEB]],
    ['criticism and caveats', QUERY_INTENT.EVIDENCE, [SOURCE_TYPES.DISCUSSION]],
  ],
});

// Words that carry no search value once the subject is extracted. Distinct from
// relevance.js's STOP_WORDS: those are for scoring text, these are for stripping
// the question's scaffolding ("compare the best ... for ...").
const SCAFFOLD = new Set([
  'compare', 'comparison', 'best', 'top', 'good', 'better', 'versus', 'vs',
  'please', 'tell', 'me', 'about', 'find', 'out', 'explain', 'describe',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'should', 'would',
  'research', 'investigate', 'summarize', 'analyze', 'analyse', 'give', 'list',
  'open-source', 'opensource', 'modern', 'current', 'latest', 'new',
  // Auxiliaries that survive the question mark: "what is MCP" must yield "MCP".
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
]);

// Pull the things being asked about out of the question.
//
// This is where a comparison becomes N subjects. Explicit list separators come
// first (they are unambiguous); a capitalized-name pass catches "Pinecone,
// Weaviate and Qdrant"; if neither fires, the whole cleaned question is one
// subject, which is the right answer for "what is MCP".
function extractSubjects(question, { max = 8 } = {}) {
  const text = String(question || '').trim().replace(/[?.!]+\s*$/, '');

  // "…frameworks: A, B and C" — a colon introducing a list is the list, and
  // everything before it is the framing. Checked before the verb split, because
  // "compare the best X for Y: A, B, C" matches both and the colon is the more
  // specific signal.
  const colon = /:\s*(.+)$/.exec(text);
  const colonList = colon && /(?:,|;|\bvs\.?\b|\bversus\b|\band\b|\bor\b)/i.test(colon[1]) ? colon[1] : null;

  // "compare A, B and C" / "A vs B" — split the whole line on list punctuation
  // and conjunctions, then let cleanSubject strip the scaffolding verb off the
  // first part. Splitting the tail after "compare" instead would drop the first
  // subject in "Rust vs Go", which is the one the question leads with.
  const parts = (colonList || text)
    .split(/\s*(?:,|;|\bvs\.?\b|\bversus\b|\band\b|\bor\b)\s*/i)
    .map((p) => cleanSubject(p))
    .filter((p) => p.length > 1);

  if (parts.length > 1) return dedupeStrings(parts).slice(0, max);

  // Proper nouns and dotted/hyphenated identifiers.
  const named = dedupeStrings(
    (text.match(/\b([A-Z][\w.+-]*(?:\s+[A-Z][\w.+-]*)?|[a-z]+[.-][\w.-]+)\b/g) || [])
      .map((n) => cleanSubject(n))
      // Two characters is a real name ("Go", "R", "C#" once cleaned); the bar
      // is "not empty", not "long enough to look impressive".
      .filter((n) => n.length >= 2 && !SCAFFOLD.has(n.toLowerCase())),
  );
  if (named.length > 1) return named.slice(0, max);

  const cleaned = cleanSubject(text);
  return [cleaned || text].slice(0, max);
}

function cleanSubject(s) {
  return String(s)
    .split(/\s+/)
    .filter((w) => w && !SCAFFOLD.has(w.toLowerCase().replace(/[^a-z0-9-]/g, '')))
    .join(' ')
    .replace(/^[^\w(]+|[^\w)]+$/g, '')
    // A leading article survives the scaffold filter (it is a real word in the
    // middle of a name) but is noise at the start of a search subject.
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim();
}

function dedupeStrings(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// --- the planner ------------------------------------------------------------

// Build the query set for a task. Returns normalized ResearchQuery objects,
// already deduplicated and capped at the task's remaining query budget.
//
// `available` is the set of source types this install can actually serve, from
// SourceManager.allowedTypes(task). Planning queries against a source type with
// no provider produces a plan that looks thorough and retrieves nothing.
function planQueries({ task, classification, available = null, limit = null }) {
  if (!classification || !classification.needsResearch) return [];

  const allowed = available && available.length ? new Set(available) : null;
  const cap = Math.max(1, Math.min(
    limit || classification.suggestedQueries || 1,
    task.limits.maxQueries,
  ));

  const seen = new Set();
  const out = [];

  const admit = (text, intent, sourceTypes, rationale, priority) => {
    if (out.length >= cap) return false;
    const trimmed = String(text || '').trim();
    if (trimmed.length < 3) return false;
    const key = queryKey(trimmed);
    if (!key || seen.has(key)) return false;
    // Drop a source type nothing can serve rather than planning into a void.
    // When a facet's preferred types are all unavailable, fall back to whatever
    // the task *can* reach rather than dropping the facet: "licensing" asked of
    // the only available source still beats not asking.
    const preferred = (sourceTypes || classification.sourceTypes).filter((t) => !allowed || allowed.has(t));
    const types = preferred.length ? preferred : (allowed ? [...allowed] : []);
    if (types.length === 0) return false;
    seen.add(key);
    out.push(normalizeQuery({
      text: trimmed, intent, sourceTypes: types, rationale, priority,
      maxResults: Math.max(3, Math.ceil(task.limits.maxSources / cap)),
    }));
    return true;
  };

  // 1. The question itself, always. Whatever the decomposition does, the thing
  //    the user actually typed gets searched — a plan that only searches its own
  //    paraphrases can miss the obvious page.
  admit(
    task.question,
    classification.category === CATEGORY.SIMPLE_FACT ? QUERY_INTENT.DEFINITION : QUERY_INTENT.DISCOVERY,
    classification.sourceTypes,
    'the question as asked',
    1,
  );

  // 2. Facet decomposition, subject by subject.
  const subjects = extractSubjects(task.question);
  const facets = FACETS[classification.category] || [];
  if (facets.length && out.length < cap) {
    // Breadth before depth: every subject gets its first facet before any
    // subject gets its second, so a truncated plan still covers everything
    // being compared instead of exhausting its budget on subject one.
    for (let f = 0; f < facets.length && out.length < cap; f += 1) {
      const [suffix, intent, types] = facets[f];
      for (const subject of subjects) {
        if (out.length >= cap) break;
        admit(`${subject} ${suffix}`, intent, types, `${classification.category}: ${suffix}`, 0.8 - f * 0.05);
      }
    }
  }

  // 3. Recency pass. A time-sensitive question that only searches evergreen
  //    phrasing gets evergreen answers.
  if (classification.timeSensitive && out.length < cap) {
    for (const subject of subjects) {
      if (out.length >= cap) break;
      admit(`${subject} latest release`, QUERY_INTENT.RECENCY,
        [SOURCE_TYPES.NEWS, SOURCE_TYPES.WEB], 'time-sensitive question', 0.7);
    }
  }

  // 4. Keyword fallback, for a question the templates did not cover.
  if (out.length === 0) {
    const kw = tokenize(task.question).slice(0, 8).join(' ');
    admit(kw, QUERY_INTENT.DISCOVERY, classification.sourceTypes, 'keyword fallback', 0.5);
  }

  return out;
}

// Follow-up queries for a claim that did not reach the confidence bar (§18,
// §39). These are the *second* round: targeted at one claim, aimed at a
// different source type than the ones that already answered, so a re-search is
// not the same search again.
function planVerificationQueries({ task, claim, usedSourceTypes = [], available = null, limit = 2 }) {
  const allowed = available && available.length ? available : [SOURCE_TYPES.WEB];
  // Prefer a type we have not used for this claim; primary types first.
  const preference = [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB, SOURCE_TYPES.ACADEMIC,
    SOURCE_TYPES.WEB, SOURCE_TYPES.NEWS, SOURCE_TYPES.DISCUSSION];
  const fresh = preference.filter((t) => allowed.includes(t) && !usedSourceTypes.includes(t));
  const types = fresh.length ? fresh.slice(0, 2) : allowed.slice(0, 2);

  const subject = cleanSubject(claim.text).slice(0, 160) || claim.text.slice(0, 160);
  // Verification queries come out of the same budget as everything else, so a
  // task with one query left gets one follow-up, not two.
  const room = Math.max(0, Math.min(limit, task.limits.maxQueries - task.usage.queries));
  const out = [];
  const seen = new Set();
  for (const [text, intent] of [
    [subject, QUERY_INTENT.VERIFICATION],
    [`${subject} official documentation`, QUERY_INTENT.EVIDENCE],
  ]) {
    if (out.length >= room) break;
    const key = queryKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeQuery({
      text, intent, sourceTypes: types, claimId: claim.id, priority: 0.9,
      rationale: `cross-check "${claim.text.slice(0, 80)}"`,
      maxResults: 5,
    }));
  }
  return out;
}

// Optional model-backed expansion. Additive only, and every candidate still
// goes through the same dedup and source filtering as a template query.
async function expandWithProvider({ task, classification, existing, provider, available = null, limit = 4 }) {
  if (!provider || typeof provider.generate !== 'function') return [];
  const room = Math.max(0, Math.min(limit, task.limits.maxQueries - existing.length));
  if (room === 0) return [];

  let text;
  try {
    const out = await provider.generate({
      messages: [{
        role: 'user',
        content: [
          'Produce additional search queries for this research question.',
          'Rules: one query per line, no numbering, no commentary, at most',
          `${room} lines. Each must search for something the existing queries do not.`,
          '',
          `QUESTION: ${task.question}`,
          `EXISTING QUERIES:\n${existing.map((q) => `- ${q.text}`).join('\n')}`,
        ].join('\n'),
      }],
      maxTokens: 300,
    });
    text = typeof out === 'string' ? out : (out && (out.text || out.content)) || '';
  } catch {
    // A model that will not answer costs the plan nothing: the deterministic
    // queries are already in `existing`.
    return [];
  }

  const seen = new Set(existing.map((q) => q.key));
  const allowed = available && available.length ? new Set(available) : null;
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (out.length >= room) break;
    const line = raw.replace(/^\s*(?:[-*\d.)\]]+\s*)+/, '').trim();
    if (line.length < 4 || line.length > 300) continue;
    const key = queryKey(line);
    if (!key || seen.has(key)) continue;
    const types = classification.sourceTypes.filter((t) => !allowed || allowed.has(t));
    if (!types.length) continue;
    seen.add(key);
    out.push(normalizeQuery({
      text: line, intent: QUERY_INTENT.DISCOVERY, sourceTypes: types,
      rationale: 'model-suggested expansion', priority: 0.6, maxResults: 5,
    }));
  }
  return out;
}

module.exports = {
  FACETS, SCAFFOLD, planQueries, planVerificationQueries, expandWithProvider,
  extractSubjects, cleanSubject,
};
