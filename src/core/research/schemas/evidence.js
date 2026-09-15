// Evidence: a quoted span from a source that bears on a claim (§15).
//
// The distinction this file exists to enforce: a *source* is a document we
// retrieved; *evidence* is a specific passage inside it, with the offsets that
// prove the passage is really there. A citation engine that cites sources can
// be fooled by a plausible-sounding summary. One that cites evidence cannot,
// because the quote is checked back against the stored source text (§20).

const crypto = require('node:crypto');
const { isPlainObject, isString, nonEmptyString, fail } = require('../../schema/validate');

const EVIDENCE_KIND = Object.freeze({
  QUOTE: 'quote',           // verbatim span from the source
  STATISTIC: 'statistic',   // a number with its surrounding sentence
  DEFINITION: 'definition',
  EXAMPLE: 'example',
  CODE: 'code',
  METADATA: 'metadata',     // e.g. a repository's license field, a release date
});

const STANCE = Object.freeze({
  SUPPORTS: 'supports',
  CONTRADICTS: 'contradicts',
  NEUTRAL: 'neutral',
});

const MAX_EVIDENCE_CHARS = 1_500;

function newEvidenceId() {
  return `ev-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function validateEvidence(def) {
  if (!isPlainObject(def)) return fail(['evidence must be an object']);
  if (!nonEmptyString(def.text)) return fail(['evidence requires text']);
  if (!nonEmptyString(def.sourceId)) return fail(['evidence requires a sourceId']);
  if (def.stance !== undefined && !Object.values(STANCE).includes(def.stance)) {
    return fail([`unknown evidence stance: ${JSON.stringify(def.stance)}`]);
  }
  if (def.kind !== undefined && !Object.values(EVIDENCE_KIND).includes(def.kind)) {
    return fail([`unknown evidence kind: ${JSON.stringify(def.kind)}`]);
  }
  return { ok: true, evidence: normalizeEvidence(def) };
}

function normalizeEvidence(def = {}) {
  const text = String(def.text).trim().slice(0, MAX_EVIDENCE_CHARS);
  return Object.freeze({
    id: isString(def.id) && def.id ? def.id : newEvidenceId(),
    sourceId: def.sourceId,
    claimId: isString(def.claimId) ? def.claimId : null,
    queryId: isString(def.queryId) ? def.queryId : null,
    kind: Object.values(EVIDENCE_KIND).includes(def.kind) ? def.kind : EVIDENCE_KIND.QUOTE,
    stance: Object.values(STANCE).includes(def.stance) ? def.stance : STANCE.NEUTRAL,
    text,
    // `location` is how a reader finds the passage again: a character range for
    // web text, a line range for a file, a path for structured metadata.
    location: normalizeLocation(def.location),
    // The sentence(s) around the quote. Extraction that hands a model a bare
    // number is how "42%" becomes attached to the wrong subject.
    context: isString(def.context) ? def.context.slice(0, MAX_EVIDENCE_CHARS) : '',
    // 0..1, set by evidenceRanker. How strongly this passage bears on the claim
    // — not how much we trust the source, which is the source's own score.
    strength: clamp01OrNull(def.strength),
    relevance: clamp01OrNull(def.relevance),
    // Proof the quote is really in the source: a digest of the exact span.
    // citationValidator recomputes this against the stored source (§20).
    digest: isString(def.digest) ? def.digest : digestOf(text),
    extractedAt: typeof def.extractedAt === 'number' ? def.extractedAt : Date.now(),
    extractor: isString(def.extractor) ? def.extractor : 'deterministic',
    metadata: isPlainObject(def.metadata) ? Object.freeze({ ...def.metadata }) : Object.freeze({}),
  });
}

function normalizeLocation(loc) {
  if (!isPlainObject(loc)) return Object.freeze({ kind: 'unknown' });
  const out = { kind: isString(loc.kind) ? loc.kind : 'char' };
  if (Number.isInteger(loc.start)) out.start = loc.start;
  if (Number.isInteger(loc.end)) out.end = loc.end;
  if (Number.isInteger(loc.line)) out.line = loc.line;
  if (Number.isInteger(loc.endLine)) out.endLine = loc.endLine;
  if (isString(loc.path)) out.path = loc.path;
  if (isString(loc.section)) out.section = loc.section.slice(0, 200);
  return Object.freeze(out);
}

function digestOf(text) {
  return crypto.createHash('sha256').update(normalizeForDigest(text)).digest('hex').slice(0, 16);
}

// Whitespace inside a retrieved page is not stable — a re-fetch can collapse a
// newline into a space — so the digest is taken over normalized whitespace.
// Everything else (words, punctuation, case) must match exactly, or the
// validator would happily accept a paraphrase.
function normalizeForDigest(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function evidenceView(evidence) {
  return {
    id: evidence.id,
    sourceId: evidence.sourceId,
    claimId: evidence.claimId,
    kind: evidence.kind,
    stance: evidence.stance,
    text: evidence.text,
    location: evidence.location,
    strength: evidence.strength,
  };
}

function clamp01OrNull(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

module.exports = {
  EVIDENCE_KIND, STANCE, MAX_EVIDENCE_CHARS,
  newEvidenceId, validateEvidence, normalizeEvidence, normalizeLocation,
  digestOf, normalizeForDigest, evidenceView,
};
