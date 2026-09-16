// Research memory (§28): what is worth remembering from a research run, and for
// how long.
//
// Built on the existing MemoryManager. There is no second memory store, no
// second scope model and no second persistence path — this module decides
// *what* becomes a memory entry and *when it expires*, and hands it to the
// manager that already owns scoping, importance and retrieval.
//
// The rule §28 states and this enforces: **do not automatically store every web
// result.** A research run produces dozens of sources and one or two things
// worth remembering. What gets stored is a verified conclusion, with its
// citations and an expiry chosen by how fast its subject moves; what does not
// get stored is raw retrieval, unverified claims, and anything from a
// time-sensitive question, which would be wrong before it was read.

const { SCOPES } = require('../../memory/scopes');
const { TYPES: MEMORY_TYPES } = require('../../memory/entry');
const { IMPORTANCE } = require('../../memory/importance');
const { VERIFICATION } = require('../schemas/claim');
const { MEMORY_TTL_MS } = require('../router/researchRouter');
const { tokenSet, coverage } = require('../text');

// §28's lifecycle, as the values actually written to an entry's tags.
const LIFECYCLE = Object.freeze({
  CANDIDATE: 'candidate',
  VALIDATED: 'validated',
  STORED: 'stored',
  UPDATED: 'updated',
  EXPIRED: 'expired',
  ARCHIVED: 'archived',
});

const TAG = 'research';

// Only these statuses are ever remembered. A claim we could not verify is not a
// fact, and storing it would mean the next run treats our own uncertainty as
// established background.
const REMEMBERABLE = Object.freeze([VERIFICATION.SUPPORTED, VERIFICATION.STRONGLY_SUPPORTED]);

const MIN_CONFIDENCE_TO_STORE = 0.6;

class ResearchMemory {
  constructor({ memory, logger = null, emit = null } = {}) {
    this._memory = memory || null;
    this._logger = logger;
    this._emit = typeof emit === 'function' ? emit : () => {};
  }

  get available() { return Boolean(this._memory); }

  // What a completed run offers up for storage. Returns candidates; nothing is
  // written until `commit` is called, mirroring the MemoryManager's own
  // candidate/commit split rather than inventing a second convention.
  candidates({ task, claims, citations, quality }) {
    if (!this._memory) return [];
    const freshness = task.classification ? task.classification.freshness : 'moderate';
    const ttl = MEMORY_TTL_MS[freshness] ?? MEMORY_TTL_MS.moderate;

    // A realtime question has a zero TTL: nothing from it is worth remembering
    // as fact, because it is about to be false.
    if (ttl === 0) return [];
    // Research the evaluator would not stand behind does not become memory.
    if (quality && quality.grade === 'insufficient') return [];

    const byClaim = new Map();
    for (const c of citations) {
      if (!byClaim.has(c.claimId)) byClaim.set(c.claimId, []);
      byClaim.get(c.claimId).push(c);
    }

    const out = [];
    for (const claim of claims) {
      if (!claim.material) continue;
      if (!REMEMBERABLE.includes(claim.verificationStatus)) continue;
      if (claim.confidence < MIN_CONFIDENCE_TO_STORE) continue;
      const cited = byClaim.get(claim.id) || [];
      if (task.requireCitations && cited.length === 0) continue;

      out.push({
        lifecycle: LIFECYCLE.VALIDATED,
        claimId: claim.id,
        def: {
          type: MEMORY_TYPES.FACT,
          content: claim.text,
          source: 'research',
          // Project scope by default: a verified fact about a library is useful
          // to the next task in the same project and meaningless outside it.
          // A caller can widen to global, but never silently.
          scope: task.projectId ? SCOPES.PROJECT : SCOPES.SESSION,
          scopeId: task.projectId || task.sessionId,
          importance: claim.confidence >= 0.8 ? IMPORTANCE.HIGH : IMPORTANCE.NORMAL,
          tags: [TAG, `freshness:${freshness}`, `status:${claim.verificationStatus}`],
          expiresAt: Date.now() + ttl,
          metadata: {
            researchTaskId: task.id,
            question: task.question,
            confidence: claim.confidence,
            independentSources: claim.independentSourceCount,
            verificationStatus: claim.verificationStatus,
            // Citations travel with the fact. A remembered claim that cannot be
            // re-cited is an unattributable assertion the next run would have
            // to take on trust.
            citations: cited.map((c) => ({
              url: c.url, title: c.title, quote: c.quote.slice(0, 300),
              publisher: c.publisher, retrievedAt: c.retrievedAt,
            })),
            verifiedAt: Date.now(),
            expiresAt: Date.now() + ttl,
          },
        },
      });
    }
    return out;
  }

  // Also worth keeping: the run itself, as a summary. Not a fact — a record
  // that this question was researched, so a later run can see the shape of what
  // was already done instead of repeating it.
  summaryCandidate({ task, quality, claims }) {
    if (!this._memory) return null;
    const assertable = claims.filter((c) => c.material
      && REMEMBERABLE.includes(c.verificationStatus));
    return {
      lifecycle: LIFECYCLE.VALIDATED,
      def: {
        type: MEMORY_TYPES.SUMMARY,
        content: `Researched: ${task.question}\n${assertable.length} verified claim(s) from ${task.sources.length} source(s). Quality: ${quality ? quality.grade : 'unknown'}.`,
        source: 'research',
        scope: task.projectId ? SCOPES.PROJECT : SCOPES.SESSION,
        scopeId: task.projectId || task.sessionId,
        importance: IMPORTANCE.NORMAL,
        tags: [TAG, 'research-summary'],
        metadata: {
          researchTaskId: task.id,
          question: task.question,
          mode: task.mode,
          qualityScore: quality ? quality.score : null,
          claimIds: assertable.map((c) => c.id),
          verifiedAt: Date.now(),
        },
      },
    };
  }

  // Write. `policy` is the workspace's memory policy — required, exactly as the
  // MemoryManager requires it, so research cannot write outside the scopes the
  // workspace was granted.
  async commit(candidates, { policy, refs = {} } = {}) {
    if (!this._memory || !policy) return [];
    const stored = [];
    for (const candidate of candidates) {
      try {
        const entry = await this._memory.store(candidate.def, { policy, refs });
        stored.push({ ...candidate, lifecycle: LIFECYCLE.STORED, entryId: entry.id });
        this._emit({ type: 'MEMORY_STORED', payload: { entryId: entry.id, claimId: candidate.claimId || null, scope: entry.scope } });
      } catch (err) {
        // A memory denial is not a research failure. The answer is already
        // produced; remembering it is a bonus.
        if (this._logger) this._logger.debug('research memory write refused', { reason: err.message });
      }
    }
    return stored;
  }

  // The lookup researchRouter uses to decide whether a question is already
  // answered (§28 + §2's memory route). Returns the best match or null.
  //
  // Expiry is checked here *and* honoured by the MemoryManager, which already
  // drops expired entries on read — belt and braces, because serving a stale
  // fact is the one failure this whole module is designed to avoid.
  async findAnswer({ question, classification = null, policy, minOverlap = 0.6, refs = {} } = {}) {
    if (!this._memory || !policy) return null;
    const rows = await this._memory.search(
      { query: question, tags: [TAG], limit: 8, type: MEMORY_TYPES.FACT },
      { policy, refs },
    ).catch(() => []);
    if (!rows.length) return null;

    const qTokens = tokenSet(question);
    const now = Date.now();
    let best = null;
    for (const row of rows) {
      const meta = row.metadata || {};
      if (meta.expiresAt && meta.expiresAt < now) continue;
      // A remembered fact answers a *different* question only if it was
      // researched for a sufficiently similar one. Matching on the stored
      // claim text alone lets an incidental fact masquerade as the answer.
      const sim = Math.max(
        coverage(qTokens, tokenSet(row.content)),
        meta.question ? coverage(qTokens, tokenSet(meta.question)) : 0,
      );
      if (sim < minOverlap) continue;
      if (!best || sim > best.similarity) {
        best = {
          similarity: sim,
          answer: row.content,
          confidence: meta.confidence ?? 0,
          verifiedAt: meta.verifiedAt || row.updatedAt || row.createdAt,
          createdAt: row.createdAt,
          expiresAt: meta.expiresAt || null,
          citations: meta.citations || [],
          entryId: row.id,
          researchTaskId: meta.researchTaskId || null,
        };
      }
    }
    // Freshness is the router's call, not ours — it knows the classification.
    // Reported here so the decision can be made with the age in hand.
    if (best && classification && classification.timeSensitive) best.timeSensitive = true;
    return best;
  }

  // Mark a remembered fact as superseded by a new run. Never deletes: the entry
  // is updated with the new content and an `updated` tag, so the history of what
  // was believed when is recoverable.
  async supersede({ entryId, claim, citations = [], policy, refs = {} }) {
    if (!this._memory || !policy) return null;
    return this._memory.update(entryId, {
      content: claim.text,
      tags: [TAG, LIFECYCLE.UPDATED, `status:${claim.verificationStatus}`],
      metadata: {
        confidence: claim.confidence,
        verifiedAt: Date.now(),
        citations: citations.map((c) => ({ url: c.url, title: c.title, quote: c.quote.slice(0, 300) })),
        supersededAt: Date.now(),
      },
    }, { policy, refs }).catch(() => null);
  }
}

module.exports = { ResearchMemory, LIFECYCLE, TAG, REMEMBERABLE, MIN_CONFIDENCE_TO_STORE };
