// EvidenceStore: the in-task index of sources, evidence and claims.
//
// One design point is worth stating because getting it wrong is subtle and
// silent: **stance belongs to the claim↔evidence link, not to the evidence.**
// The same passage can support one claim and contradict another — a span
// reading "MCP supports stdio and HTTP transports. The current version is
// v1.2.0" supports a claim about transports and contradicts a claim that the
// version is v0.9.0. Storing one `stance` on the evidence record means the
// second link silently overwrites the first, and a claim ends up marked
// contradicted by a passage that in fact supports it. So the evidence keeps its
// origin stance for reference and the store owns a per-link stance table.
//
// Small on purpose. It is not a database and not a second ArtifactManager — it
// is the lookup table the analysis stages need (evidence by claim, evidence by
// source, which cluster a source belongs to) with the one integrity rule that
// matters attached to it: **nothing can reference a source that was never
// retrieved.** `addEvidence` for an unknown sourceId throws, which is where the
// "never cite a source that was not actually retrieved" rule of §19 is enforced
// at write time rather than discovered at validation time.

const { ResearchValidationError } = require('../errors/researchErrors');
const { STANCE } = require('../schemas/evidence');

class EvidenceStore {
  constructor() {
    this._sources = new Map();       // sourceId -> Source
    this._evidence = new Map();      // evidenceId -> Evidence
    this._claims = new Map();        // claimId -> Claim
    this._byClaim = new Map();       // claimId -> Set<evidenceId>
    this._linkStance = new Map();    // `claimId::evidenceId` -> stance
    this._bySource = new Map();      // sourceId -> Set<evidenceId>
    this._clusterOf = new Map();     // sourceId -> canonical sourceId
    this._clusters = new Map();      // canonical sourceId -> memberIds
  }

  // --- sources --------------------------------------------------------------

  addSources(sources) {
    for (const s of sources) this._sources.set(s.id, s);
    return this;
  }

  // Record the dedup clustering so independence questions have an answer.
  setClusters({ clusterOf = new Map(), clusters = [] } = {}) {
    this._clusterOf = new Map(clusterOf);
    for (const c of clusters) this._clusters.set(c.canonicalId, c.memberIds);
    return this;
  }

  source(id) { return this._sources.get(id) || null; }
  sources() { return [...this._sources.values()]; }
  hasSource(id) { return this._sources.has(id); }
  canonicalIdFor(id) { return this._clusterOf.get(id) || id; }

  // --- evidence -------------------------------------------------------------

  addEvidence(evidence) {
    if (!this._sources.has(evidence.sourceId)) {
      throw new ResearchValidationError(
        `evidence ${evidence.id} references source ${evidence.sourceId}, which was never retrieved`,
        { field: 'sourceId' },
      );
    }
    this._evidence.set(evidence.id, evidence);
    index(this._bySource, evidence.sourceId, evidence.id);
    if (evidence.claimId) index(this._byClaim, evidence.claimId, evidence.id);
    return evidence;
  }

  addAllEvidence(list) {
    const out = [];
    for (const e of list) out.push(this.addEvidence(e));
    return out;
  }

  // Replace an evidence record in place (a re-score, a stance relabel). The id,
  // the sourceId and the quote digest must not change — if they did it would be
  // a different piece of evidence wearing the same id.
  replaceEvidence(next) {
    const prev = this._evidence.get(next.id);
    if (!prev) throw new ResearchValidationError(`unknown evidence ${next.id}`, { field: 'id' });
    if (prev.sourceId !== next.sourceId || prev.digest !== next.digest) {
      throw new ResearchValidationError(
        `evidence ${next.id} cannot change its source or its quote; create a new record instead`,
        { field: 'digest' },
      );
    }
    this._evidence.set(next.id, next);
    return next;
  }

  evidence(id) { return this._evidence.get(id) || null; }
  allEvidence() { return [...this._evidence.values()]; }

  // The stance of one piece of evidence *toward one claim*. Falls back to the
  // evidence's own origin stance when the pair was never explicitly linked.
  stanceFor(claimId, evidenceId) {
    const key = `${claimId}::${evidenceId}`;
    if (this._linkStance.has(key)) return this._linkStance.get(key);
    const e = this._evidence.get(evidenceId);
    return e ? e.stance : STANCE.NEUTRAL;
  }

  // Evidence for a claim, each record carrying the stance it holds *toward that
  // claim*. Callers read `.stance` as they always did; it is now correct per
  // claim instead of being whichever link was written last.
  evidenceForClaim(claimId) {
    return ids(this._byClaim, claimId)
      .map((id) => this._evidence.get(id))
      .filter(Boolean)
      .map((e) => {
        const stance = this.stanceFor(claimId, e.id);
        return stance === e.stance ? e : Object.freeze({ ...e, stance, claimId });
      });
  }

  evidenceForSource(sourceId) { return ids(this._bySource, sourceId).map((id) => this._evidence.get(id)).filter(Boolean); }

  // --- claims ---------------------------------------------------------------

  addClaim(claim) {
    this._claims.set(claim.id, claim);
    if (!this._byClaim.has(claim.id)) this._byClaim.set(claim.id, new Set());
    return claim;
  }

  claim(id) { return this._claims.get(id) || null; }
  claims() { return [...this._claims.values()]; }

  // Attach evidence to a claim, recording the stance on both sides so the claim
  // can be read without walking the evidence table.
  link(claimId, evidenceId, stance = null) {
    const claim = this._claims.get(claimId);
    const evidence = this._evidence.get(evidenceId);
    if (!claim) throw new ResearchValidationError(`unknown claim ${claimId}`, { field: 'claimId' });
    if (!evidence) throw new ResearchValidationError(`unknown evidence ${evidenceId}`, { field: 'evidenceId' });

    const effective = stance || evidence.stance;
    // The stance goes on the link. The evidence record is untouched, so linking
    // this span to a second claim cannot change what it means for the first.
    this._linkStance.set(`${claimId}::${evidenceId}`, effective);
    index(this._byClaim, claimId, evidenceId);

    const bucket = effective === STANCE.CONTRADICTS ? 'contradictingEvidence' : 'supportingEvidence';
    const other = effective === STANCE.CONTRADICTS ? 'supportingEvidence' : 'contradictingEvidence';
    // Re-linking with a different stance moves the id between buckets rather
    // than leaving it in both.
    const stale = claim[other].indexOf(evidenceId);
    if (stale >= 0) claim[other].splice(stale, 1);
    if (effective !== STANCE.NEUTRAL && !claim[bucket].includes(evidenceId)) claim[bucket].push(evidenceId);
    claim.updatedAt = Date.now();
    return claim;
  }

  // The source ids behind a claim's evidence, canonicalized through the dedup
  // clusters — which is the set independence is measured over.
  sourceIdsForClaim(claimId, { stance = null } = {}) {
    const out = new Set();
    for (const e of this.evidenceForClaim(claimId)) {
      if (stance && e.stance !== stance) continue;
      out.add(this.canonicalIdFor(e.sourceId));
    }
    return [...out];
  }

  sourcesById() { return new Map(this._sources); }
  clusterMap() { return new Map(this._clusterOf); }

  stats() {
    return {
      sources: this._sources.size,
      evidence: this._evidence.size,
      claims: this._claims.size,
      clusters: this._clusters.size,
    };
  }
}

function index(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function ids(map, key) {
  return [...(map.get(key) || [])];
}

module.exports = { EvidenceStore };
