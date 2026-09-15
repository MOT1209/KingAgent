// The citation engine (§19).
//
// A citation is built from three things that must all already exist: a claim, a
// piece of evidence in the store, and the source that evidence was extracted
// from. There is no code path that takes a URL and a title and produces a
// citation — which is what makes "never cite a source that was not actually
// retrieved" and "never invent URLs" structural facts rather than instructions
// a model is asked to follow.
//
// Ordinals are assigned here, once, so `[3]` in the prose and the third entry in
// the bibliography are the same citation by construction.

const { normalizeCitation, validateCitation } = require('../schemas/citation');
const { CitationIntegrityError } = require('../errors/researchErrors');
const { VERIFICATION } = require('../schemas/claim');

class CitationEngine {
  constructor({ store, logger = null, emit = null } = {}) {
    if (!store) throw new TypeError('CitationEngine requires an EvidenceStore');
    this._store = store;
    this._logger = logger;
    this._emit = typeof emit === 'function' ? emit : () => {};
    this._byId = new Map();
    this._ordinalBySource = new Map();
    this._nextOrdinal = 1;
  }

  // Build one citation. Throws rather than returning null: a caller that wanted
  // a citation and got nothing would silently ship an uncited claim.
  cite({ claimId, evidenceId }) {
    const claim = this._store.claim(claimId);
    if (!claim) throw new CitationIntegrityError(`cannot cite unknown claim ${claimId}`, { citationId: null });

    const evidence = this._store.evidence(evidenceId);
    if (!evidence) {
      throw new CitationIntegrityError(`cannot cite unknown evidence ${evidenceId}`, { citationId: null });
    }
    const source = this._store.source(evidence.sourceId);
    if (!source) {
      // Unreachable through the store's own write path, which rejects evidence
      // for an unretrieved source — kept because this is the invariant the whole
      // citation chain rests on, and it should fail loudly if it ever breaks.
      throw new CitationIntegrityError(
        `evidence ${evidenceId} points at source ${evidence.sourceId}, which is not in the retrieved set`,
        { sourceId: evidence.sourceId },
      );
    }

    // One ordinal per *source*, not per citation: three quotes from the
    // specification are all `[2]`, which is how a reader expects a bibliography
    // to work.
    const canonical = this._store.canonicalIdFor(source.id);
    if (!this._ordinalBySource.has(canonical)) {
      this._ordinalBySource.set(canonical, this._nextOrdinal++);
    }

    const { ok, citation, errors } = validateCitation({
      claimId,
      evidenceId,
      sourceId: source.id,
      // Every display field is copied from the retrieved source. Nothing here
      // is composed, inferred or defaulted to something plausible.
      url: source.url,
      title: source.title,
      publisher: source.publisher,
      author: source.author,
      publishedAt: source.publishedAt,
      retrievedAt: source.retrievedAt,
      location: evidence.location,
      quote: evidence.text,
      quoteDigest: evidence.digest,
      confidence: evidence.strength ?? 0,
      ordinal: this._ordinalBySource.get(canonical),
    });
    if (!ok) throw new CitationIntegrityError(`invalid citation: ${errors.join('; ')}`);

    this._byId.set(citation.id, citation);
    this._emit({ type: 'CITATION_CREATED', payload: { citationId: citation.id, claimId, sourceId: source.id, ordinal: citation.ordinal } });
    return citation;
  }

  // Cite a whole claim: its strongest supporting evidence, plus — and this is
  // the part that is easy to skip — its contradicting evidence, so a reader can
  // see what the claim is arguing against.
  citeClaim(claim, { maxPerClaim = 3, includeContradicting = true }) {
    const out = [];
    const supporting = claim.supportingEvidence
      .map((id) => this._store.evidence(id))
      .filter(Boolean)
      .sort((a, b) => (b.strength || 0) - (a.strength || 0));

    // One citation per distinct source: citing the same page three times adds
    // no evidence, only length.
    const seenSources = new Set();
    for (const e of supporting) {
      if (out.length >= maxPerClaim) break;
      const canonical = this._store.canonicalIdFor(e.sourceId);
      if (seenSources.has(canonical)) continue;
      seenSources.add(canonical);
      out.push(this.cite({ claimId: claim.id, evidenceId: e.id }));
    }

    if (includeContradicting) {
      for (const id of claim.contradictingEvidence) {
        const e = this._store.evidence(id);
        if (!e) continue;
        const canonical = this._store.canonicalIdFor(e.sourceId);
        if (seenSources.has(canonical)) continue;
        seenSources.add(canonical);
        out.push(this.cite({ claimId: claim.id, evidenceId: e.id }));
        break; // one dissenting citation is enough to signal the disagreement
      }
    }
    return out;
  }

  // Cite every claim worth citing. An unverified claim is deliberately *not*
  // cited — a citation on a claim the evidence does not support would give it
  // borrowed authority, which is the exact deception §20 is guarding against.
  citeAll(claims, { maxPerClaim = 3 } = {}) {
    const out = [];
    for (const claim of claims) {
      if (claim.verificationStatus === VERIFICATION.UNVERIFIED) continue;
      if (claim.supportingEvidence.length === 0 && claim.contradictingEvidence.length === 0) continue;
      out.push(...this.citeClaim(claim, { maxPerClaim }));
    }
    return out;
  }

  get(id) { return this._byId.get(id) || null; }
  all() { return [...this._byId.values()]; }

  // The bibliography: one entry per source, in ordinal order, with the claims
  // it was cited for.
  bibliography() {
    const bySource = new Map();
    for (const c of this._byId.values()) {
      const canonical = this._store.canonicalIdFor(c.sourceId);
      if (!bySource.has(canonical)) {
        const source = this._store.source(canonical) || this._store.source(c.sourceId);
        bySource.set(canonical, {
          ordinal: c.ordinal,
          sourceId: canonical,
          title: c.title,
          url: c.url,
          publisher: c.publisher,
          author: c.author,
          publishedAt: c.publishedAt,
          retrievedAt: c.retrievedAt,
          type: source ? source.type : null,
          primary: source ? source.primary : false,
          citationIds: [],
          claimIds: [],
        });
      }
      const entry = bySource.get(canonical);
      entry.citationIds.push(c.id);
      if (!entry.claimIds.includes(c.claimId)) entry.claimIds.push(c.claimId);
    }
    return [...bySource.values()].sort((a, b) => a.ordinal - b.ordinal);
  }

  // Re-key ordinals so the bibliography numbers run 1..n with no gaps, after
  // claims have been dropped. Returns the updated citations.
  renumber() {
    const order = [...new Set(
      [...this._byId.values()]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((c) => this._store.canonicalIdFor(c.sourceId)),
    )];
    this._ordinalBySource = new Map(order.map((id, i) => [id, i + 1]));
    this._nextOrdinal = order.length + 1;
    for (const [id, c] of [...this._byId.entries()]) {
      this._byId.set(id, normalizeCitation({ ...c, ordinal: this._ordinalBySource.get(this._store.canonicalIdFor(c.sourceId)) }));
    }
    return this.all();
  }

  // Drop citations for claims that did not make the final answer, then
  // renumber. Called before rendering so the bibliography matches the prose.
  retainClaims(claimIds) {
    const keep = new Set(claimIds);
    for (const [id, c] of [...this._byId.entries()]) {
      if (!keep.has(c.claimId)) this._byId.delete(id);
    }
    return this.renumber();
  }
}

module.exports = { CitationEngine };
