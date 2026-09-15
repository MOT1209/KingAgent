// The Verifier role (§21): re-check a set of claims that already exist.
//
// This exists as a separate entry point because verification is useful on its
// own — an agent handed claims from somewhere else (a prior run, a user's
// draft, another agent's output) can have them checked without re-running the
// research that produced them. The machinery is SourceVerifier's; this wraps it
// with claim creation so a caller can pass plain strings.

const { normalizeClaim } = require('../schemas/claim');
const { analyzeAll } = require('../evidence/claimAnalyzer');
const { detect, resolveAll } = require('../evidence/conflictDetector');
const { EvidenceStore } = require('../evidence/evidenceStore');
const { SourceVerifier } = require('../evidence/sourceVerifier');
const { EvidenceExtractor } = require('../evidence/evidenceExtractor');

class Verifier {
  constructor({ sourceManager, provider = null, logger = null } = {}) {
    if (!sourceManager) throw new TypeError('Verifier requires a SourceManager');
    this._sources = sourceManager;
    this._extractor = new EvidenceExtractor({ provider, logger });
    this._verifier = new SourceVerifier({ sourceManager, extractor: this._extractor, logger });
    this._logger = logger;
  }

  // `statements` is a list of strings or claim-shaped objects. Returns the
  // analyzed claims plus the verification report.
  async check({ task, statements, strategy, store = null, signal = null }) {
    const evidenceStore = store || new EvidenceStore();
    const claims = statements.map((s) => evidenceStore.addClaim(
      normalizeClaim(typeof s === 'string' ? { text: s } : s),
    ));

    const report = await this._verifier.verify({
      task, claims, store: evidenceStore, strategy, signal,
      maxClaims: claims.length,
    });

    const conflicts = resolveAll(detect({ store: evidenceStore, claims }), { store: evidenceStore });
    return {
      claims: analyzeAll({ store: evidenceStore, conflicts }),
      conflicts,
      report,
      store: evidenceStore,
    };
  }
}

module.exports = { Verifier };
