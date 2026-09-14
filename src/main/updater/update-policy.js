// How important is this update, really?
//
// Two vocabularies exist because two different readers need them. A release
// author writes one of four words into metadata.importance — optional,
// recommended, important, critical — because that is what fits in a release
// note. The dialog shows one of four other words — LOW, NORMAL, HIGH,
// CRITICAL — because that is what fits in a UI badge. This file is the
// mapping between them, plus the fallback that runs when an author did not
// say anything at all.
//
// Priority order for the fallback, straight out of the spec:
//   security issue → breaking change → major feature → stability → minor
//
// An explicit importance from the author is trusted, not second-guessed —
// this analyzer explains verified information, it does not overrule a
// human's judgment call. The one exception is a floor, not a ceiling: a
// release that ships a security fix is never shown as less than HIGH,
// whatever word the author picked, because presenting a security fix as
// optional is the one mistake this dialog cannot make silently.

const IMPORTANCE_LEVELS = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
const POLICY_LEVELS = ['optional', 'recommended', 'important', 'critical'];

const POLICY_TO_IMPORTANCE = Object.freeze({
  optional: 'LOW',
  recommended: 'NORMAL',
  important: 'HIGH',
  critical: 'CRITICAL',
});

function rank(level) { return IMPORTANCE_LEVELS.indexOf(level); }

function deriveImportance(analysis) {
  if (analysis.stats.securityFixes > 0) return 'CRITICAL';
  if (analysis.breakingChanges) return 'HIGH';
  if (analysis.stats.features > 0) return 'NORMAL';
  if (analysis.stats.bugFixes > 0) return 'NORMAL';
  if (analysis.category === 'performance') return 'NORMAL';
  return 'LOW';
}

function classifyImportance({ metadata, analysis }) {
  const explicit = metadata && POLICY_TO_IMPORTANCE[metadata.importance];
  if (!explicit) return deriveImportance(analysis);
  if (analysis.stats.securityFixes > 0 && rank(explicit) < rank('HIGH')) return 'HIGH';
  return explicit;
}

// The reverse direction, for anywhere a policy word is more useful than a
// badge word (product policy config, for instance).
function policyFor(importance) {
  const idx = rank(importance);
  return POLICY_LEVELS[idx === -1 ? 0 : idx];
}

module.exports = {
  classifyImportance,
  deriveImportance,
  policyFor,
  rank,
  IMPORTANCE_LEVELS,
  POLICY_LEVELS,
  POLICY_TO_IMPORTANCE,
};
