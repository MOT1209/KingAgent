// Reranking (§14).
//
// Provider ranking optimizes for clicks, not for evidence. A reranker that just
// reordered by "relevance" would inherit that. So the score here is explicitly a
// *research* score, and it includes two terms a search engine has no reason to
// care about:
//
//   * **evidence density** — does this page contain quotable, checkable
//     statements (numbers, dates, versions, definitions), or is it prose about
//     the subject? A page that cannot be quoted cannot be cited.
//   * **source diversity** — a ranked list whose top eight results are all from
//     one domain is one source. Diversity is applied as a post-pass penalty on
//     repeats, so the list stays ordered by merit but stops stacking.
//
// Relevance reuses core/memory/relevance.js's tokenizer and overlap rather than
// introducing a second text-similarity implementation, and there is no vector
// database: §14 asks to reuse embeddings *if they already exist*, and in this
// repository they do not. A host that has one supplies `semanticScore` and only
// the relevance term changes.

const { tokenSet, coverage } = require('../text');
const { clamp01 } = require('../schemas/source');

// Weights sum to 1 before the diversity pass. Ordered by how much each term
// deserves to move a result, which is an editorial judgement and is stated here
// rather than buried in the arithmetic.
const WEIGHTS = Object.freeze({
  relevance: 0.32,
  authority: 0.22,
  evidenceDensity: 0.18,
  freshness: 0.12,
  quality: 0.10,
  corroboration: 0.06,
});

// A repeat from a domain already represented costs this much, compounding.
const DIVERSITY_PENALTY = 0.12;
// Provider rank is a weak prior, worth a nudge and nothing more.
const PROVIDER_RANK_WEIGHT = 0.05;

// Shapes that make a passage quotable: figures, versions, dates, definitional
// phrasing, code. Counting them is a proxy for "is there anything here to
// cite?" — crude, but it is measuring the right thing.
const EVIDENCE_SHAPES = Object.freeze([
  /\b\d+(?:\.\d+)?\s?(?:%|percent|ms|s\b|kb|mb|gb|tb|x\b)/gi,
  /\bv?\d+\.\d+(?:\.\d+)?\b/g,
  /\b(?:19|20)\d{2}\b/g,
  /\b(?:is|are|means|refers to|defined as|consists of|requires|supports|returns|provides)\b/gi,
  /`[^`\n]{2,80}`|```/g,
  /\b(?:according to|reported|measured|benchmark|study found|documented)\b/gi,
]);

// Below this, a passage is a snippet rather than a document and its density is
// not measurable — three common words in 100 characters would otherwise
// out-score a whole specification page.
const DENSITY_FLOOR_CHARS = 600;

function evidenceDensity(text) {
  const body = String(text || '');
  if (body.length < 80) return 0;
  let hits = 0;
  for (const re of EVIDENCE_SHAPES) {
    re.lastIndex = 0;
    const m = body.match(re);
    if (m) hits += m.length;
  }
  // Per thousand characters, saturating, with a length floor. Without the floor
  // the denominator goes to zero for short text and every snippet scores 1.0.
  const perK = hits / (Math.max(body.length, DENSITY_FLOOR_CHARS) / 1000);
  return clamp01(perK / 12);
}

// Recency, on a curve chosen by how fast the subject moves. A 2019 RFC is not
// stale; a 2019 pricing page is worthless.
const HALF_LIFE_DAYS = Object.freeze({
  static: 3650, slow: 540, moderate: 180, fast: 30, realtime: 2,
});

function freshnessScore(source, { freshness = 'moderate', now = Date.now() } = {}) {
  const stamp = source.updatedAt || source.publishedAt;
  // Unknown date is neither fresh nor stale. Scoring it zero would bury every
  // page that does not publish a date, which is most reference documentation.
  if (!stamp) return 0.5;
  const days = Math.max(0, (now - stamp) / 86_400_000);
  const halfLife = HALF_LIFE_DAYS[freshness] ?? HALF_LIFE_DAYS.moderate;
  return clamp01(Math.pow(0.5, days / halfLife));
}

// Score one source against the question. `authority` and `quality` come from
// quality/sourceQuality.js — they are inputs here, not recomputed, so the two
// modules cannot drift into disagreeing about what a source is worth.
function scoreSource(source, {
  queryTokens, freshness = 'moderate', now = Date.now(),
  authority = null, quality = null, semanticScore = null, corroboration = 0,
} = {}) {
  const text = `${source.title} ${source.snippet} ${source.content}`;
  const lexical = coverage(queryTokens, tokenSet(text));
  const relevance = typeof semanticScore === 'number'
    ? clamp01(semanticScore * 0.7 + lexical * 0.3)
    : lexical;

  const terms = {
    relevance,
    authority: clamp01(authority ?? source.authorityScore ?? (source.primary ? 0.7 : 0.45)),
    evidenceDensity: evidenceDensity(source.content || source.snippet),
    freshness: freshnessScore(source, { freshness, now }),
    quality: clamp01(quality ?? source.qualityScore ?? 0.5),
    corroboration: clamp01(corroboration),
  };

  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) score += terms[k] * w;
  return { score: clamp01(score), terms };
}

// Rerank a source list. Returns [{ source, score, terms, rank, penalties }],
// best first.
function rerank(sources, {
  query = '', freshness = 'moderate', now = Date.now(), limit = null,
  authorityOf = null, qualityOf = null, semanticOf = null,
  clusterSizes = null, providerRankOf = null,
  diversityPenalty = DIVERSITY_PENALTY,
} = {}) {
  const queryTokens = tokenSet(query);

  const scored = sources.map((source) => {
    // How many distinct retrievals found this document. Capped low: being found
    // twice is meaningful, being found nine times mostly means it ranks well.
    const hits = (clusterSizes && clusterSizes.get(source.id)) || source.metadata.queryHits || 1;
    const corroboration = clamp01((hits - 1) / 3);
    const { score, terms } = scoreSource(source, {
      queryTokens, freshness, now, corroboration,
      authority: authorityOf ? authorityOf(source) : null,
      quality: qualityOf ? qualityOf(source) : null,
      semanticScore: semanticOf ? semanticOf(source) : null,
    });
    const providerRank = providerRankOf ? providerRankOf(source) : null;
    // A tiny nudge toward what the provider put first, decaying fast.
    const prior = Number.isInteger(providerRank)
      ? PROVIDER_RANK_WEIGHT * Math.pow(0.7, providerRank)
      : 0;
    return { source, score: clamp01(score + prior), terms, penalties: [] };
  });

  scored.sort((a, b) => b.score - a.score);

  // Diversity post-pass. Applied after ordering so it demotes repeats rather
  // than distorting the merit score itself, and the penalty is recorded so a
  // reader can see why a result moved.
  const seenDomain = new Map();
  const seenType = new Map();
  for (const row of scored) {
    const domain = row.source.domain || `#${row.source.id}`;
    const dCount = seenDomain.get(domain) || 0;
    const tCount = seenType.get(row.source.type) || 0;
    if (dCount > 0) {
      const p = Math.min(0.5, diversityPenalty * dCount);
      row.score = clamp01(row.score - p);
      row.penalties.push({ kind: 'domain-repeat', amount: p, domain });
    }
    // A much gentler nudge for source *type*, so an all-web list leaves room
    // for the one documentation hit rather than burying it at rank nine.
    if (tCount >= 3) {
      const p = Math.min(0.15, diversityPenalty * 0.4 * (tCount - 2));
      row.score = clamp01(row.score - p);
      row.penalties.push({ kind: 'type-repeat', amount: p, type: row.source.type });
    }
    seenDomain.set(domain, dCount + 1);
    seenType.set(row.source.type, tCount + 1);
  }

  scored.sort((a, b) => b.score - a.score);
  const out = limit && limit > 0 ? scored.slice(0, limit) : scored;
  return out.map((row, i) => ({ ...row, rank: i + 1 }));
}

module.exports = {
  WEIGHTS, DIVERSITY_PENALTY, HALF_LIFE_DAYS, DENSITY_FLOOR_CHARS,
  rerank, scoreSource, evidenceDensity, freshnessScore,
};
