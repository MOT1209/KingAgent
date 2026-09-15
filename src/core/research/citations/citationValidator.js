// Citation validation (§20): the gate an answer has to clear before it ships.
//
// This is where the whole evidence chain is checked end to end, because every
// link in it is a place a plausible-looking fabrication could enter:
//
//   claim → evidence → source → the quote is really in that source
//
// The last check is the one that catches the failure nobody else can. A
// citation can name a real source, quote a real-looking sentence, and still be
// wrong about which one — so the quote's digest is recomputed from the stored
// source text and compared. A citation whose quote is not in its source is
// rejected, not downgraded.
//
// Findings are graded. `error` blocks the answer; `warning` is reported in the
// quality record and shown to the user. The distinction is not cosmetic: a
// material claim with no citation is an error, and a well-cited claim from a
// single weak source is a warning, and treating them the same would either
// block everything or block nothing.

const { digestOf, normalizeForDigest } = require('../schemas/evidence');
const { VERIFICATION } = require('../schemas/claim');
const { CitationIntegrityError } = require('../errors/researchErrors');

const SEVERITY = Object.freeze({ ERROR: 'error', WARNING: 'warning' });

const FINDING = Object.freeze({
  MISSING_CITATION: 'missing_citation',
  UNSUPPORTED_CLAIM: 'unsupported_claim',
  BROKEN_CITATION: 'broken_citation',
  QUOTE_MISMATCH: 'quote_mismatch',
  UNRETRIEVED_SOURCE: 'unretrieved_source',
  FABRICATED_URL: 'fabricated_url',
  WEAK_EVIDENCE: 'weak_evidence',
  UNRESOLVED_CONFLICT: 'unresolved_conflict',
  SINGLE_SOURCE: 'single_source',
  STALE_SOURCE: 'stale_source',
});

const WEAK_EVIDENCE_THRESHOLD = 0.3;
const STALE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

// Validate one citation against the store. Returns findings (possibly empty).
function validateCitationRecord(citation, { store, retrievedUrls = null }) {
  const findings = [];

  const evidence = store.evidence(citation.evidenceId);
  if (!evidence) {
    findings.push(finding(FINDING.BROKEN_CITATION, SEVERITY.ERROR, citation,
      `citation ${citation.id} points at evidence ${citation.evidenceId}, which does not exist`));
    return findings;
  }

  const source = store.source(citation.sourceId);
  if (!source) {
    findings.push(finding(FINDING.UNRETRIEVED_SOURCE, SEVERITY.ERROR, citation,
      `citation ${citation.id} names source ${citation.sourceId}, which is not in the retrieved set`));
    return findings;
  }

  if (evidence.sourceId !== citation.sourceId) {
    findings.push(finding(FINDING.BROKEN_CITATION, SEVERITY.ERROR, citation,
      `citation ${citation.id} attributes evidence from ${evidence.sourceId} to ${citation.sourceId}`));
  }

  // The URL must be one we actually fetched. A URL that appears nowhere in the
  // retrieved set is a fabrication, whatever produced it.
  if (citation.url) {
    if (source.url !== citation.url && source.canonicalUrl !== citation.url) {
      findings.push(finding(FINDING.FABRICATED_URL, SEVERITY.ERROR, citation,
        `citation ${citation.id} carries a url that is not the one its source was retrieved from`));
    } else if (retrievedUrls && !retrievedUrls.has(citation.url) && !retrievedUrls.has(source.canonicalUrl)) {
      findings.push(finding(FINDING.FABRICATED_URL, SEVERITY.ERROR, citation,
        `citation ${citation.id} carries a url that was never retrieved in this task`));
    }
  }

  // The quote check. Digest first (cheap, and it is what the evidence recorded),
  // then a direct containment check against the stored source text.
  if (citation.quoteDigest && citation.quoteDigest !== evidence.digest) {
    findings.push(finding(FINDING.QUOTE_MISMATCH, SEVERITY.ERROR, citation,
      `citation ${citation.id} quotes text that does not match the evidence it cites`));
  }
  if (digestOf(citation.quote) !== evidence.digest) {
    findings.push(finding(FINDING.QUOTE_MISMATCH, SEVERITY.ERROR, citation,
      `citation ${citation.id}'s quote is not the evidence span verbatim`));
  }
  const haystack = normalizeForDigest(`${source.content || ''} ${source.snippet || ''}`);
  if (!haystack.includes(normalizeForDigest(citation.quote))) {
    findings.push(finding(FINDING.QUOTE_MISMATCH, SEVERITY.ERROR, citation,
      `citation ${citation.id} quotes text that does not appear in ${source.url || source.title}`));
  }

  if ((evidence.strength ?? 0) < WEAK_EVIDENCE_THRESHOLD) {
    findings.push(finding(FINDING.WEAK_EVIDENCE, SEVERITY.WARNING, citation,
      `citation ${citation.id} rests on evidence scored ${(evidence.strength ?? 0).toFixed(2)}`));
  }

  const stamp = source.updatedAt || source.publishedAt;
  if (stamp && Date.now() - stamp > STALE_MS) {
    findings.push(finding(FINDING.STALE_SOURCE, SEVERITY.WARNING, citation,
      `citation ${citation.id} cites a source last updated ${new Date(stamp).toISOString().slice(0, 10)}`));
  }

  return findings;
}

// Validate the whole answer: every claim has what it needs, every citation
// resolves, nothing is cited that was not retrieved.
function validateAll({ claims, citations, store, conflicts = [], requireCitations = true }) {
  const findings = [];
  const retrievedUrls = new Set();
  for (const s of store.sources()) {
    if (s.url) retrievedUrls.add(s.url);
    if (s.canonicalUrl) retrievedUrls.add(s.canonicalUrl);
  }

  for (const c of citations) {
    findings.push(...validateCitationRecord(c, { store, retrievedUrls }));
  }

  const byClaim = new Map();
  for (const c of citations) {
    if (!byClaim.has(c.claimId)) byClaim.set(c.claimId, []);
    byClaim.get(c.claimId).push(c);
  }

  for (const claim of claims) {
    const cited = byClaim.get(claim.id) || [];

    if (claim.material && requireCitations && cited.length === 0) {
      findings.push(claimFinding(FINDING.MISSING_CITATION, SEVERITY.ERROR, claim,
        `material claim "${short(claim.text)}" has no citation`));
    }
    if (claim.material && claim.supportingEvidence.length === 0
      && claim.verificationStatus !== VERIFICATION.CONTRADICTED) {
      findings.push(claimFinding(FINDING.UNSUPPORTED_CLAIM, SEVERITY.ERROR, claim,
        `material claim "${short(claim.text)}" has no supporting evidence`));
    }
    if (claim.material && claim.independentSourceCount <= 1
      && claim.verificationStatus === VERIFICATION.SUPPORTED) {
      findings.push(claimFinding(FINDING.SINGLE_SOURCE, SEVERITY.WARNING, claim,
        `claim "${short(claim.text)}" rests on a single independent source`));
    }
    if (claim.verificationStatus === VERIFICATION.CONFLICTING) {
      const unresolved = conflicts.filter((k) => k.claimId === claim.id && k.resolution === 'unresolved');
      if (unresolved.length) {
        findings.push(claimFinding(FINDING.UNRESOLVED_CONFLICT, SEVERITY.WARNING, claim,
          `claim "${short(claim.text)}" has ${unresolved.length} unresolved conflict(s); the answer must say so`));
      }
    }
  }

  const errors = findings.filter((f) => f.severity === SEVERITY.ERROR);
  return {
    ok: errors.length === 0,
    findings,
    errors,
    warnings: findings.filter((f) => f.severity === SEVERITY.WARNING),
    // Of the material claims, how many carry at least one citation. This is the
    // number §37's citationCompleteness is built from.
    citedMaterialClaims: claims.filter((c) => c.material && (byClaim.get(c.id) || []).length > 0).length,
    materialClaims: claims.filter((c) => c.material).length,
  };
}

// The throwing form, for the point where an answer is about to be returned.
function assertValid(result) {
  if (result.ok) return result;
  const first = result.errors[0];
  throw new CitationIntegrityError(
    `${result.errors.length} citation integrity error(s); the first is: ${first.message}`,
    { citationId: first.citationId || null, sourceId: first.sourceId || null },
  );
}

function finding(type, severity, citation, message) {
  return { type, severity, message, citationId: citation.id, claimId: citation.claimId, sourceId: citation.sourceId };
}

function claimFinding(type, severity, claim, message) {
  return { type, severity, message, citationId: null, claimId: claim.id, sourceId: null };
}

function short(text) {
  return String(text).replace(/\s+/g, ' ').slice(0, 90);
}

module.exports = {
  SEVERITY, FINDING, WEAK_EVIDENCE_THRESHOLD,
  validateCitationRecord, validateAll, assertValid,
};
