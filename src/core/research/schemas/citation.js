// Citation: the binding between a claim, the evidence for it, and the source
// the evidence came from (§19).
//
// A citation cannot be constructed from a URL and a title. It requires an
// `evidenceId` that exists in the evidence store and a `sourceId` that exists
// in the source set, and citationValidator re-checks both plus the quote digest
// before an answer ships. That is the mechanism that makes "never invent a URL"
// an invariant instead of an instruction.

const crypto = require('node:crypto');
const { isPlainObject, isString, nonEmptyString, fail } = require('../../schema/validate');

const CITATION_STYLE = Object.freeze({
  INLINE: 'inline',       // [1]
  FOOTNOTE: 'footnote',   // [^1]
  MARKDOWN: 'markdown',   // [title](url)
  APA: 'apa',
  NUMBERED_LIST: 'numbered_list',
});

function newCitationId() {
  return `cit-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function validateCitation(def) {
  if (!isPlainObject(def)) return fail(['citation must be an object']);
  if (!nonEmptyString(def.sourceId)) return fail(['citation requires a sourceId']);
  if (!nonEmptyString(def.evidenceId)) return fail(['citation requires an evidenceId; a citation without evidence is a guess']);
  if (!nonEmptyString(def.claimId)) return fail(['citation requires a claimId']);
  return { ok: true, citation: normalizeCitation(def) };
}

function normalizeCitation(def = {}) {
  return Object.freeze({
    id: isString(def.id) && def.id ? def.id : newCitationId(),
    claimId: def.claimId,
    evidenceId: def.evidenceId,
    sourceId: def.sourceId,
    // Denormalized for display only. The validator never trusts these: it
    // resolves sourceId against the retrieved set and compares (§20).
    url: isString(def.url) ? def.url : null,
    title: isString(def.title) ? def.title.slice(0, 400) : '',
    publisher: isString(def.publisher) ? def.publisher.slice(0, 200) : null,
    author: isString(def.author) ? def.author.slice(0, 200) : null,
    publishedAt: typeof def.publishedAt === 'number' ? def.publishedAt : null,
    retrievedAt: typeof def.retrievedAt === 'number' ? def.retrievedAt : null,
    location: isPlainObject(def.location) ? Object.freeze({ ...def.location }) : null,
    quote: isString(def.quote) ? def.quote.slice(0, 1500) : '',
    quoteDigest: isString(def.quoteDigest) ? def.quoteDigest : null,
    confidence: typeof def.confidence === 'number' ? def.confidence : 0,
    // Assigned by the engine when the bibliography is ordered, so `[3]` in the
    // prose and the third entry in the list are the same citation.
    ordinal: Number.isInteger(def.ordinal) ? def.ordinal : null,
    createdAt: typeof def.createdAt === 'number' ? def.createdAt : Date.now(),
  });
}

function citationView(citation) {
  return {
    id: citation.id,
    ordinal: citation.ordinal,
    claimId: citation.claimId,
    sourceId: citation.sourceId,
    evidenceId: citation.evidenceId,
    url: citation.url,
    title: citation.title,
    publisher: citation.publisher,
    publishedAt: citation.publishedAt,
    quote: citation.quote,
    confidence: citation.confidence,
  };
}

module.exports = {
  CITATION_STYLE, newCitationId, validateCitation, normalizeCitation, citationView,
};
