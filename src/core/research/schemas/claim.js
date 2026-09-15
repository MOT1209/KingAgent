// Claim: one assertion the research is trying to establish, plus the conflict
// record for when sources disagree (§16, §17).
//
// Verification status is *derived*, never set by a caller. That is the whole
// point: an engine that lets a synthesizer write `verificationStatus:
// 'strongly_supported'` on its own output has no verification, only a field.

const crypto = require('node:crypto');
const { isPlainObject, isString, nonEmptyString, fail } = require('../../schema/validate');
const { STANCE } = require('./evidence');

const VERIFICATION = Object.freeze({
  UNVERIFIED: 'unverified',
  SUPPORTED: 'supported',
  STRONGLY_SUPPORTED: 'strongly_supported',
  CONTRADICTED: 'contradicted',
  CONFLICTING: 'conflicting',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
});

const CONFLICT_SEVERITY = Object.freeze({
  MINOR: 'minor',       // different phrasing, compatible facts
  MATERIAL: 'material', // different values that both matter
  DIRECT: 'direct',     // flat contradiction
});

const CONFLICT_RESOLUTION = Object.freeze({
  UNRESOLVED: 'unresolved',
  PREFER_PRIMARY: 'prefer_primary',
  PREFER_RECENT: 'prefer_recent',
  BOTH_TRUE_IN_CONTEXT: 'both_true_in_context',
  REPORT_UNCERTAINTY: 'report_uncertainty',
});

const MAX_CLAIM_CHARS = 600;

function newClaimId() {
  return `clm-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function newConflictId() {
  return `cfl-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function validateClaim(def) {
  if (!isPlainObject(def)) return fail(['claim must be an object']);
  if (!nonEmptyString(def.text)) return fail(['claim requires text']);
  return { ok: true, claim: normalizeClaim(def) };
}

function normalizeClaim(def = {}) {
  return {
    id: isString(def.id) && def.id ? def.id : newClaimId(),
    text: String(def.text).trim().slice(0, MAX_CLAIM_CHARS),
    // Does the answer fall apart if this is wrong? Material claims are the ones
    // citation validation is strict about (§20); an aside is not.
    material: def.material !== false,
    subject: isString(def.subject) ? def.subject.slice(0, 200) : null,
    queryId: isString(def.queryId) ? def.queryId : null,
    // Evidence ids, not evidence objects: the store owns the objects, and a
    // claim that embedded them would go stale the moment one was re-scored.
    supportingEvidence: Array.isArray(def.supportingEvidence) ? [...def.supportingEvidence] : [],
    contradictingEvidence: Array.isArray(def.contradictingEvidence) ? [...def.contradictingEvidence] : [],
    conflictIds: Array.isArray(def.conflictIds) ? [...def.conflictIds] : [],
    // Derived by claimAnalyzer.analyze(). Present here so the shape is complete,
    // but a caller-supplied value is discarded on the next analysis pass.
    verificationStatus: VERIFICATION.UNVERIFIED,
    confidence: 0,
    sourceCount: 0,
    independentSourceCount: 0,
    sourceQuality: 0,
    createdAt: typeof def.createdAt === 'number' ? def.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
}

function normalizeConflict(def = {}) {
  return Object.freeze({
    id: isString(def.id) && def.id ? def.id : newConflictId(),
    claimId: isString(def.claimId) ? def.claimId : null,
    claimText: isString(def.claimText) ? def.claimText.slice(0, MAX_CLAIM_CHARS) : '',
    // Each position is one side of the disagreement, with the sources that
    // hold it. Never collapsed to a winner here — resolution is a separate,
    // explicit act and `unresolved` is a legitimate final state (§17).
    positions: Object.freeze((def.positions || []).map((p) => Object.freeze({
      statement: String(p.statement || '').slice(0, MAX_CLAIM_CHARS),
      sourceIds: [...(p.sourceIds || [])],
      evidenceIds: [...(p.evidenceIds || [])],
      weight: typeof p.weight === 'number' ? p.weight : 0,
    }))),
    sourceIds: Object.freeze([...new Set(def.sourceIds || [])]),
    severity: Object.values(CONFLICT_SEVERITY).includes(def.severity) ? def.severity : CONFLICT_SEVERITY.MATERIAL,
    resolution: Object.values(CONFLICT_RESOLUTION).includes(def.resolution) ? def.resolution : CONFLICT_RESOLUTION.UNRESOLVED,
    resolutionReason: isString(def.resolutionReason) ? def.resolutionReason.slice(0, 400) : '',
    confidence: typeof def.confidence === 'number' ? def.confidence : 0,
    detectedAt: typeof def.detectedAt === 'number' ? def.detectedAt : Date.now(),
  });
}

// Is a claim safe to state plainly in an answer?
//
// `supported` and `strongly_supported` are the only two that let a synthesizer
// assert. Everything else has to be hedged or dropped, and the synthesizer
// reads this rather than re-deciding (§38).
function isAssertable(claim) {
  return claim
    && (claim.verificationStatus === VERIFICATION.SUPPORTED
      || claim.verificationStatus === VERIFICATION.STRONGLY_SUPPORTED);
}

function claimView(claim) {
  return {
    id: claim.id,
    text: claim.text,
    material: claim.material,
    verificationStatus: claim.verificationStatus,
    confidence: claim.confidence,
    sourceCount: claim.sourceCount,
    independentSourceCount: claim.independentSourceCount,
    supporting: claim.supportingEvidence.length,
    contradicting: claim.contradictingEvidence.length,
    conflicts: claim.conflictIds.length,
  };
}

module.exports = {
  VERIFICATION, CONFLICT_SEVERITY, CONFLICT_RESOLUTION, STANCE, MAX_CLAIM_CHARS,
  newClaimId, newConflictId, validateClaim, normalizeClaim, normalizeConflict,
  isAssertable, claimView,
};
