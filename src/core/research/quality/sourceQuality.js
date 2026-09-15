// Source quality (§11): how much should this source count for?
//
// The rule §11 states, implemented: **do not blindly trust search ranking.**
// A provider's first result is a popularity signal, not a reliability one, and
// the reranker only gives it a decaying nudge. Everything here is derived from
// what the source *is* — who published it, whether it is the thing itself or
// commentary about the thing, how specific it is, whether it is current.
//
// Deliberately not included: a hard-coded list of "good domains". A reputation
// allowlist in the source tree is a maintenance burden that ages badly and
// smuggles an editorial position into a research engine. The structural signals
// below — is this the project's own repository, is this the vendor's own
// documentation, does it carry a DOI — get most of the way there and are true
// by construction rather than by opinion.

const { SOURCE_TYPES, clamp01 } = require('../schemas/source');

// Baseline authority by what kind of thing a source is. These are starting
// points; the modifiers below move them a long way in both directions.
const TYPE_AUTHORITY = Object.freeze({
  [SOURCE_TYPES.DOCUMENTATION]: 0.82,
  [SOURCE_TYPES.ACADEMIC]: 0.8,
  [SOURCE_TYPES.GITHUB]: 0.75,
  [SOURCE_TYPES.FILE]: 0.7,
  [SOURCE_TYPES.LOCAL]: 0.65,
  [SOURCE_TYPES.MCP]: 0.55,
  [SOURCE_TYPES.WEB]: 0.45,
  [SOURCE_TYPES.NEWS]: 0.45,
  [SOURCE_TYPES.DISCUSSION]: 0.32,
});

// Structural markers of an authoritative host. Suffix-matched on label
// boundaries, so `gov.uk` matches `www.gov.uk` but never `notgov.uk`.
const INSTITUTIONAL_SUFFIXES = Object.freeze(['.gov', '.gov.uk', '.mil', '.edu', '.ac.uk', '.int', '.who.int']);
const STANDARDS_SUFFIXES = Object.freeze(['ietf.org', 'w3.org', 'iso.org', 'rfc-editor.org', 'unicode.org', 'ecma-international.org']);

// Hosts where anyone can publish under someone else's brand. A page on a
// content platform is the author's, not the platform's, so the platform lends
// it no authority.
const OPEN_PLATFORMS = Object.freeze([
  'medium.com', 'substack.com', 'dev.to', 'hashnode.dev', 'blogspot.com',
  'wordpress.com', 'wixsite.com', 'quora.com', 'answers.com',
]);

// Aggregators and content farms: they restate other people's work, so they are
// by definition secondary however confident they sound.
const AGGREGATOR_HINTS = /\b(?:top-?\d+|best-?\d+|listicle|roundup|comparison-?table|vs-?guide)\b/i;

function domainEndsWith(domain, suffix) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  const s = suffix.toLowerCase().replace(/^\./, '');
  return d === s || d.endsWith(`.${s}`);
}

// Is this source the thing being asked about, rather than commentary on it?
//
// The strongest available signal, and it is computable: if the question names a
// project and this source *is* that project's repository or documentation site,
// it is primary for this question specifically.
function isSubjectOwned(source, { subjects = [] } = {}) {
  if (!subjects.length) return false;
  const haystack = `${source.domain || ''} ${source.url || ''} ${source.publisher || ''}`.toLowerCase();
  return subjects.some((s) => {
    const key = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    return key.length >= 3 && haystack.replace(/[^a-z0-9]/g, '').includes(key);
  });
}

// Authority: who is speaking, and do they have standing on this?
function authorityOf(source, { subjects = [] } = {}) {
  let score = TYPE_AUTHORITY[source.type] ?? 0.45;
  const reasons = [];

  for (const suffix of STANDARDS_SUFFIXES) {
    if (domainEndsWith(source.domain, suffix)) { score += 0.18; reasons.push('standards body'); break; }
  }
  for (const suffix of INSTITUTIONAL_SUFFIXES) {
    if (domainEndsWith(source.domain, suffix)) { score += 0.15; reasons.push('institutional domain'); break; }
  }
  if (isSubjectOwned(source, { subjects })) { score += 0.12; reasons.push('the subject speaking about itself'); }
  if (source.metadata.official === true) { score += 0.1; reasons.push('marked official'); }

  if (source.type === SOURCE_TYPES.ACADEMIC) {
    if (source.metadata.doi) { score += 0.06; reasons.push('has a DOI'); }
    if (source.metadata.peerReviewed) { score += 0.08; reasons.push('peer reviewed'); }
    // Citation counts are a real signal but a slow and gameable one; worth a
    // nudge, never worth a tier.
    const cites = source.metadata.citationCount;
    if (typeof cites === 'number' && cites > 50) { score += 0.05; reasons.push(`${cites} citations`); }
  }

  if (source.type === SOURCE_TYPES.GITHUB) {
    if (source.metadata.archived) { score -= 0.2; reasons.push('archived repository'); }
    const stars = source.metadata.stars;
    if (typeof stars === 'number' && stars > 1000) { score += 0.04; reasons.push('widely used repository'); }
  }

  if (OPEN_PLATFORMS.some((p) => domainEndsWith(source.domain, p))) {
    score -= 0.12;
    reasons.push('open publishing platform; the author, not the host, is the authority');
  }
  if (source.url && AGGREGATOR_HINTS.test(source.url)) { score -= 0.1; reasons.push('reads as an aggregator page'); }
  if (!source.author && !source.publisher && source.type === SOURCE_TYPES.WEB) {
    score -= 0.08;
    reasons.push('no named author or publisher');
  }
  // A source that tried to inject instructions has told us something about
  // itself. Not excluded — see researchSecurity — but not trusted either.
  if (source.safety && source.safety.injectionAttempts > 0) {
    score -= 0.25;
    reasons.push('carries instruction-shaped text aimed at an agent');
  }

  return { score: clamp01(score), reasons };
}

// Specificity: is this about the question, or about the general area?
// A page that mentions the subject once in a list is not a source about it.
function specificityOf(source) {
  const body = `${source.content || source.snippet || ''}`;
  if (body.length < 200) return 0.4;
  const title = (source.title || '').toLowerCase();
  const listish = /\b(?:top|best|\d+\s+(?:tools|ways|things|alternatives))\b/.test(title);
  const deep = body.length > 2500;
  let score = 0.55;
  if (deep) score += 0.15;
  if (listish) score -= 0.2;
  if (source.metadata.surface === 'reference' || source.metadata.surface === 'specification') score += 0.2;
  if (source.metadata.surface === 'changelog') score += 0.1;
  return clamp01(score);
}

// Freshness relative to how fast the subject moves. Shares its curve with the
// reranker rather than defining a second one.
const { freshnessScore } = require('../retrieval/reranker');

// The composite §11 asks for. Returns the score plus its parts, because a bare
// number nobody can interrogate is how a ranking becomes folklore.
function scoreSource(source, { subjects = [], freshness = 'moderate', now = Date.now(), relevance = null } = {}) {
  const authority = authorityOf(source, { subjects });
  const specificity = specificityOf(source);
  const fresh = freshnessScore(source, { freshness, now });
  const primary = source.primary ? 0.85 : 0.45;
  const rel = relevance === null ? 0.5 : clamp01(relevance);

  // Evidence strength, at the source level: does this document contain
  // checkable statements at all?
  const hasBody = (source.content || '').length > 400;
  const evidenceStrength = hasBody ? 0.75 : (source.snippet || '').length > 120 ? 0.45 : 0.2;

  // Consistency: a source whose own metadata contradicts itself (a "2024
  // update" on a page published 2019 with no update stamp) is suspect. Only
  // computable where both stamps exist, so the default is neutral.
  const consistency = source.publishedAt && source.updatedAt && source.updatedAt < source.publishedAt ? 0.3 : 0.7;

  const parts = {
    authority: authority.score,
    relevance: rel,
    freshness: fresh,
    specificity,
    evidenceStrength,
    consistency,
    primary,
  };

  const score = clamp01(
    parts.authority * 0.28
    + parts.relevance * 0.18
    + parts.primary * 0.16
    + parts.evidenceStrength * 0.14
    + parts.specificity * 0.12
    + parts.freshness * 0.08
    + parts.consistency * 0.04,
  );

  return { score, parts, reasons: authority.reasons };
}

// Apply scores to a list, returning new Source records with the score fields
// filled in. Sources are frozen, so this produces replacements.
function scoreSources(sources, opts = {}) {
  const { normalizeSource } = require('../schemas/source');
  return sources.map((source) => {
    const { score, parts } = scoreSource(source, opts);
    return normalizeSource({
      ...source,
      authorityScore: parts.authority,
      freshnessScore: parts.freshness,
      relevanceScore: source.relevanceScore ?? parts.relevance,
      trustScore: clamp01(parts.authority * 0.6 + parts.consistency * 0.4),
      qualityScore: score,
    });
  });
}

module.exports = {
  TYPE_AUTHORITY, INSTITUTIONAL_SUFFIXES, STANDARDS_SUFFIXES, OPEN_PLATFORMS,
  scoreSource, scoreSources, authorityOf, specificityOf, isSubjectOwned, domainEndsWith,
};
