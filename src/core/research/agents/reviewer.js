// The reviewer (§39): a second pass that asks whether the research is actually
// finished, before anyone is shown an answer.
//
// The checks are the ones §39 lists, and every one of them is answered from the
// record rather than from a model's impression of the record. That matters: a
// reviewer that asks a model "did we do a good job?" gets an agreeable answer,
// which is worth nothing. These read the claims, the citations, the trace of
// what was searched and what failed, and produce findings a replan can act on.
//
// The one check that genuinely needs judgement — "did we answer the question
// that was asked, or a nearby one?" — is offered to a model when one is wired,
// and its verdict can only *add* a finding, never clear one.

const { VERIFICATION } = require('../schemas/claim');
const { QUERY_STATUS } = require('../schemas/researchQuery');
const { SOURCE_TYPES } = require('../schemas/source');
const { tokenSet, coverage } = require('../text');

const VERDICT = Object.freeze({
  ACCEPT: 'accept',
  ACCEPT_WITH_CAVEATS: 'accept_with_caveats',
  NEEDS_MORE_RESEARCH: 'needs_more_research',
  REJECT: 'reject',
});

const CHECK = Object.freeze({
  ANSWERS_QUESTION: 'answers_question',
  ENOUGH_RESEARCH: 'enough_research',
  CLAIMS_SUPPORTED: 'claims_supported',
  CITATIONS_VALID: 'citations_valid',
  SOURCES_TRUSTWORTHY: 'sources_trustworthy',
  OBVIOUS_SOURCE_MISSED: 'obvious_source_missed',
  NO_HALLUCINATION: 'no_hallucination',
  CONFLICTS_HANDLED: 'conflicts_handled',
});

class Reviewer {
  constructor({ provider = null, logger = null } = {}) {
    this._provider = provider;
    this._logger = logger;
  }

  async review({ task, store, claims, citations, conflicts = [], quality, strategy = null, answer = null, signal = null }) {
    const findings = [];
    const material = claims.filter((c) => c.material);

    // 1. Did we answer the question?
    const coverageScore = quality.detail.completeness.subjectCoverage;
    if (coverageScore < 1) {
      const missing = quality.detail.completeness.subjects.filter((s) => !s.covered).map((s) => s.subject);
      findings.push(fail(CHECK.ANSWERS_QUESTION, `no findings for: ${missing.join(', ')}`, { subjects: missing, blocking: coverageScore < 0.5 }));
    } else if (material.length === 0) {
      findings.push(fail(CHECK.ANSWERS_QUESTION, 'no material claim was established at all', { blocking: true }));
    }

    // 2. Did we research enough for the mode we claimed?
    if (strategy && !quality.targetsMet) {
      findings.push(fail(CHECK.ENOUGH_RESEARCH, `${strategy.mode} research did not reach its own bar: ${quality.targetMisses.join('; ')}`, {
        blocking: false,
      }));
    }
    const dead = task.queries.filter((q) => q.status === QUERY_STATUS.FAILED || q.status === QUERY_STATUS.SKIPPED);
    if (dead.length && dead.length >= task.queries.length / 2) {
      findings.push(fail(CHECK.ENOUGH_RESEARCH, `${dead.length} of ${task.queries.length} planned queries produced nothing`, { blocking: false }));
    }

    // 3. Are the important claims supported?
    const unsupported = material.filter((c) => c.verificationStatus === VERIFICATION.UNVERIFIED
      || c.verificationStatus === VERIFICATION.INSUFFICIENT_EVIDENCE);
    if (unsupported.length) {
      findings.push(fail(CHECK.CLAIMS_SUPPORTED, `${unsupported.length} material claim(s) are not supported by the evidence`, {
        claims: unsupported.map((c) => ({ id: c.id, text: c.text })),
        blocking: unsupported.length === material.length,
      }));
    }

    // 4. Are the citations valid? (The validator already decided; the reviewer
    //    reports it, because a blocking citation error must reach the verdict.)
    if (quality.blocking.length) {
      findings.push(fail(CHECK.CITATIONS_VALID, `${quality.blocking.length} citation integrity error(s)`, {
        detail: quality.blocking.slice(0, 5), blocking: true,
      }));
    }

    // 5. Are the sources trustworthy? Measured over the sources actually
    //    *cited*, not everything retrieved: a run that pulled thirty weak pages
    //    and cited the three good ones did the right thing, and judging it on
    //    the thirty would punish thorough searching.
    const sources = store.sources();
    const citedIds = new Set(citations.map((c) => store.canonicalIdFor(c.sourceId)));
    const cited = sources.filter((s) => citedIds.has(store.canonicalIdFor(s.id)));
    const judged = cited.length ? cited : sources;
    const weak = judged.filter((s) => (s.qualityScore ?? 0) < 0.35);
    if (judged.length && weak.length / judged.length > 0.6) {
      findings.push(fail(CHECK.SOURCES_TRUSTWORTHY,
        `${weak.length} of the ${judged.length} ${cited.length ? 'cited' : 'retrieved'} sources scored below 0.35 for quality`,
        { blocking: false }));
    }
    const injected = judged.filter((s) => s.safety && s.safety.injectionAttempts > 0);
    if (injected.length) {
      findings.push(fail(CHECK.SOURCES_TRUSTWORTHY,
        `${injected.length} source(s) carried instruction-shaped text; their content was defanged and their weight reduced`,
        { blocking: false, informational: true }));
    }

    // 6. Did we miss an obvious source? Structural, not speculative: a question
    //    about a documented product with no documentation source, or about a
    //    repository with no repository source, has a hole in it.
    const usedTypes = new Set(sources.map((s) => s.type));
    const classification = task.classification;
    if (classification) {
      const expect = [];
      if (classification.needsGithub && !usedTypes.has(SOURCE_TYPES.GITHUB)) expect.push('the repository itself');
      if (classification.category === 'documentation' && !usedTypes.has(SOURCE_TYPES.DOCUMENTATION)) expect.push('official documentation');
      if (classification.needsFiles && !usedTypes.has(SOURCE_TYPES.FILE)) expect.push('the provided files');
      if (expect.length) {
        findings.push(fail(CHECK.OBVIOUS_SOURCE_MISSED, `nothing was retrieved from ${expect.join(' or ')}`, { blocking: false }));
      }
    }
    if (sources.length && !sources.some((s) => s.primary)) {
      findings.push(fail(CHECK.OBVIOUS_SOURCE_MISSED, 'no primary source was consulted; everything is commentary', { blocking: false }));
    }

    // 7. Hallucination check. Every sentence in the answer that asserts
    //    something must trace to a claim. The deterministic answer is built from
    //    claims so it passes by construction; model prose is what this catches.
    if (answer && answer.prose) {
      const stray = strayAssertions(answer.prose, claims);
      if (stray.length) {
        findings.push(fail(CHECK.NO_HALLUCINATION, `${stray.length} sentence(s) in the written answer do not trace to any claim`, {
          detail: stray.slice(0, 3), blocking: true,
        }));
      }
    }

    // 8. Conflicts.
    const unresolved = conflicts.filter((c) => c.resolution === 'unresolved');
    if (unresolved.length) {
      const surfaced = answer && answer.sections && answer.sections.conflicting.length > 0;
      findings.push(fail(CHECK.CONFLICTS_HANDLED,
        surfaced
          ? `${unresolved.length} conflict(s) remain unresolved and are stated in the answer`
          : `${unresolved.length} conflict(s) are unresolved and the answer does not mention them`,
        { blocking: !surfaced, informational: surfaced }));
    }

    // The judgement call, offered to a model when one is wired.
    if (this._provider && answer) {
      const drift = await this._questionDrift({ task, answer, signal }).catch(() => null);
      if (drift && drift.answersDifferentQuestion) {
        findings.push(fail(CHECK.ANSWERS_QUESTION, `a review pass judged the answer to address a different question: ${drift.reason}`, { blocking: false }));
      }
    }

    const blocking = findings.filter((f) => f.blocking);
    const actionable = findings.filter((f) => !f.blocking && !f.informational);

    const verdict = blocking.length
      ? (quality.blocking.length || unsupported.length === material.length ? VERDICT.REJECT : VERDICT.NEEDS_MORE_RESEARCH)
      : actionable.length
        ? VERDICT.ACCEPT_WITH_CAVEATS
        : VERDICT.ACCEPT;

    return Object.freeze({
      verdict,
      findings,
      blocking: blocking.length,
      // What another round should go after. Consumed by ResearchPlanner.replan.
      gaps: gapsFrom(findings, claims, quality),
      reviewedAt: Date.now(),
    });
  }

  // "Is this an answer to the question that was asked?" — the one check worth
  // a model call, because it is about meaning rather than bookkeeping.
  async _questionDrift({ task, answer, signal }) {
    const text = answer.prose || (answer.sections
      ? [...answer.sections.known, ...answer.sections.supported].map((e) => e.text).join(' ')
      : '');
    if (!text) return null;
    const out = await this._provider.generate({
      signal,
      maxTokens: 150,
      messages: [{
        role: 'user',
        content: [
          'Does the ANSWER address the QUESTION, or does it answer something adjacent?',
          'Reply with exactly one line: "yes" or "no: <one short reason>".',
          '',
          `QUESTION: ${task.question}`,
          `ANSWER: ${text.slice(0, 2000)}`,
        ].join('\n'),
      }],
    });
    const raw = (typeof out === 'string' ? out : (out && (out.text || out.content)) || '').trim().toLowerCase();
    if (raw.startsWith('no')) {
      return { answersDifferentQuestion: true, reason: raw.replace(/^no:?\s*/, '').slice(0, 200) || 'unspecified' };
    }
    return { answersDifferentQuestion: false, reason: '' };
  }
}

// Sentences in the prose that share too little vocabulary with any claim to have
// come from one. Deliberately lenient — the aim is to catch a whole invented
// paragraph, not to police paraphrase.
function strayAssertions(prose, claims, { threshold = 0.25 } = {}) {
  const claimTokens = claims.map((c) => tokenSet(c.text));
  const out = [];
  for (const raw of String(prose).split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim();
    if (sentence.length < 40) continue;
    if (/^(?:however|this|these|in (?:short|summary)|overall|note that)\b/i.test(sentence)) continue;
    const st = tokenSet(sentence);
    if (st.size < 4) continue;
    const best = claimTokens.reduce((acc, ct) => Math.max(acc, coverage(st, ct)), 0);
    if (best < threshold) out.push(sentence.slice(0, 200));
  }
  return out;
}

function gapsFrom(findings, claims, quality) {
  const out = [];
  for (const f of findings) {
    if (f.check === CHECK.CLAIMS_SUPPORTED && f.claims) {
      for (const c of f.claims) {
        const claim = claims.find((k) => k.id === c.id);
        if (claim) out.push({ claim, reason: f.message });
      }
    }
    if (f.check === CHECK.ANSWERS_QUESTION && f.subjects) {
      for (const s of f.subjects) out.push({ query: s, reason: `no findings for "${s}"` });
    }
  }
  if (out.length === 0 && quality.detail.completeness.missingSourceTypes.length) {
    out.push({ query: null, reason: `no results from ${quality.detail.completeness.missingSourceTypes.join(', ')}` });
  }
  return out;
}

function fail(check, message, extra = {}) {
  return Object.freeze({ check, message, blocking: false, informational: false, ...extra });
}

module.exports = { Reviewer, VERDICT, CHECK, strayAssertions };
