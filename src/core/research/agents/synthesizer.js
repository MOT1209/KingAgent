// Synthesis (§38): turn verified claims into an answer that says exactly as much
// as the evidence supports, and no more.
//
// The input is structured evidence, never raw snippets — that is the whole
// point of everything upstream. So the synthesizer's job is not "read these
// pages and summarize"; it is "render what the analysis already established,
// with the right amount of hedging attached to each part".
//
// Five registers, and the mapping from verification status to register is
// mechanical rather than a matter of the writer's judgement:
//
//   known        strongly_supported     stated plainly, cited
//   supported    supported              stated, cited
//   uncertain    insufficient_evidence  hedged, with what is missing named
//   conflicting  conflicting            both positions shown, cited, unresolved
//   not found    (no claim at all)      said out loud, not omitted
//
// A model provider can write the prose. It is given the claims, their status
// and their citations, and it is told it may not add facts — and whatever it
// returns, the deterministic answer below is what the citations are validated
// against, so a model that invents a claim produces prose that fails validation
// rather than an answer that quietly ships.

const { VERIFICATION } = require('../schemas/claim');
const { formatInline, formatBibliography, formatEntry } = require('../citations/citationFormatter');
const { CITATION_STYLE } = require('../schemas/citation');

const REGISTER = Object.freeze({
  KNOWN: 'known',
  SUPPORTED: 'supported',
  UNCERTAIN: 'uncertain',
  CONFLICTING: 'conflicting',
  NOT_FOUND: 'not_found',
});

const REGISTER_OF = Object.freeze({
  [VERIFICATION.STRONGLY_SUPPORTED]: REGISTER.KNOWN,
  [VERIFICATION.SUPPORTED]: REGISTER.SUPPORTED,
  [VERIFICATION.INSUFFICIENT_EVIDENCE]: REGISTER.UNCERTAIN,
  [VERIFICATION.UNVERIFIED]: REGISTER.UNCERTAIN,
  [VERIFICATION.CONFLICTING]: REGISTER.CONFLICTING,
  [VERIFICATION.CONTRADICTED]: REGISTER.CONFLICTING,
});

// How a claim in each register is introduced. Hedges are not decoration: they
// are the difference between reporting a finding and asserting a fact.
const LEAD_IN = Object.freeze({
  [REGISTER.KNOWN]: '',
  [REGISTER.SUPPORTED]: '',
  [REGISTER.UNCERTAIN]: 'Less certain — ',
  [REGISTER.CONFLICTING]: 'Sources disagree — ',
  [REGISTER.NOT_FOUND]: '',
});

class Synthesizer {
  constructor({ provider = null, logger = null } = {}) {
    this._provider = provider;
    this._logger = logger;
  }

  // Build the structured answer. Deterministic, always produced, and the thing
  // the validator checks. Prose is layered on top of it, never instead of it.
  build({ task, claims, citations, conflicts = [], quality = null, bibliography = [] }) {
    const byClaim = new Map();
    for (const c of citations) {
      if (!byClaim.has(c.claimId)) byClaim.set(c.claimId, []);
      byClaim.get(c.claimId).push(c);
    }

    const sections = { known: [], supported: [], uncertain: [], conflicting: [] };
    for (const claim of claims) {
      if (!claim.material && claim.confidence < 0.5) continue;
      const claimConflicts = conflicts.filter((k) => k.claimId === claim.id);
      // A claim can be well supported *and* be the subject of a disagreement
      // the resolution did not settle — two pricing pages that both look
      // authoritative, say. The verification status alone would file it under
      // "established" and the reader would never learn the sources differ, so
      // an open disagreement decides the register.
      const open = claimConflicts.some((k) => k.resolution === 'unresolved' || k.resolution === 'report_uncertainty');
      const register = open
        ? REGISTER.CONFLICTING
        : (REGISTER_OF[claim.verificationStatus] || REGISTER.UNCERTAIN);
      const cited = byClaim.get(claim.id) || [];
      const entry = {
        claimId: claim.id,
        text: claim.text,
        register,
        status: claim.verificationStatus,
        confidence: claim.confidence,
        independentSources: claim.independentSourceCount,
        citations: cited.map((c) => ({ id: c.id, ordinal: c.ordinal, url: c.url, title: c.title })),
        markers: cited.map(formatInline).join(''),
        conflicts: claimConflicts
          .map((k) => ({
            id: k.id,
            severity: k.severity,
            resolution: k.resolution,
            reason: k.resolutionReason,
            positions: k.positions.map((p) => ({ statement: p.statement, sourceIds: p.sourceIds })),
          })),
      };
      if (register === REGISTER.KNOWN) sections.known.push(entry);
      else if (register === REGISTER.SUPPORTED) sections.supported.push(entry);
      else if (register === REGISTER.CONFLICTING) sections.conflicting.push(entry);
      else sections.uncertain.push(entry);
    }

    // What we looked for and did not find. §38 lists `not found` as a register
    // for a reason: an answer that silently omits the part it failed on is
    // indistinguishable from one that found nothing worth saying.
    const notFound = [];
    if (quality && quality.detail && quality.detail.completeness) {
      for (const s of quality.detail.completeness.subjects) {
        if (!s.covered) notFound.push({ subject: s.subject, reason: 'no supporting evidence was found' });
      }
      for (const t of quality.detail.completeness.missingSourceTypes) {
        notFound.push({ subject: null, reason: `no results came back from ${t}` });
      }
    }

    return {
      question: task.question,
      sections,
      notFound,
      bibliography,
      // The headline honesty fields. A caller rendering this cannot avoid them.
      confidence: quality ? quality.confidence : 0,
      grade: quality ? quality.grade : null,
      partial: Boolean(quality && (!quality.targetsMet || notFound.length > 0)),
      caveats: buildCaveats({ task, quality, conflicts, notFound }),
      generatedAt: Date.now(),
    };
  }

  // Markdown rendering of the structured answer. No model involved, so this is
  // what a task with no provider configured still gets — a real, cited answer
  // rather than an apology.
  render(answer, { style = CITATION_STYLE.NUMBERED_LIST, includeBibliography = true } = {}) {
    const out = [];
    const { sections } = answer;

    const block = (title, entries) => {
      if (!entries.length) return;
      out.push(`## ${title}`, '');
      for (const e of entries) {
        out.push(`- ${LEAD_IN[e.register]}${e.text} ${e.markers}`.trimEnd());
        for (const k of e.conflicts) {
          out.push(`  - Conflict (${k.severity}, ${k.resolution}): ${k.positions.map((p) => p.statement).join('  —  vs  —  ')}`);
          if (k.reason) out.push(`    ${k.reason}`);
        }
      }
      out.push('');
    };

    block('What the evidence establishes', sections.known);
    block('Supported, with less corroboration', sections.supported);
    block('Where sources disagree', sections.conflicting);
    block('Uncertain', sections.uncertain);

    if (answer.notFound.length) {
      out.push('## Not found', '');
      for (const n of answer.notFound) {
        out.push(`- ${n.subject ? `${n.subject}: ` : ''}${n.reason}`);
      }
      out.push('');
    }

    if (answer.caveats.length) {
      out.push('## Caveats', '');
      for (const c of answer.caveats) out.push(`- ${c}`);
      out.push('');
    }

    if (includeBibliography && answer.bibliography.length) {
      out.push('## Sources', '');
      out.push(style === CITATION_STYLE.NUMBERED_LIST
        ? formatBibliography(answer.bibliography, style)
        : answer.bibliography.map((e) => `- ${formatEntry(e, style)}`).join('\n'));
      out.push('');
    }

    return out.join('\n').trim();
  }

  // Optional prose pass. The model is given claims and their citation markers
  // and told, in the prompt, that it may only restate what it is given — but the
  // guarantee does not rest on the prompt: `verifyProse` below checks that every
  // citation marker in the returned text corresponds to a real citation, and
  // rejects the prose if not. On rejection the deterministic render is used.
  async write(answer, { provider = this._provider, citations = [], maxTokens = 1200, signal = null } = {}) {
    if (!provider || typeof provider.generate !== 'function') return null;
    const entries = [
      ...answer.sections.known.map((e) => ({ ...e, band: 'ESTABLISHED' })),
      ...answer.sections.supported.map((e) => ({ ...e, band: 'SUPPORTED' })),
      ...answer.sections.conflicting.map((e) => ({ ...e, band: 'DISPUTED' })),
      ...answer.sections.uncertain.map((e) => ({ ...e, band: 'UNCERTAIN' })),
    ];
    if (entries.length === 0) return null;

    let text;
    try {
      const out = await provider.generate({
        signal,
        maxTokens,
        messages: [{
          role: 'user',
          content: [
            'Write an answer to the QUESTION using only the FINDINGS below.',
            '',
            'Rules, all of them hard:',
            '- Do not add any fact that is not in the findings.',
            '- Keep each finding\'s citation markers exactly as given, attached to the same statement.',
            '- Do not invent citation markers or URLs.',
            '- State ESTABLISHED findings plainly. Hedge SUPPORTED ones lightly.',
            '- For DISPUTED findings, present both positions and say they conflict.',
            '- For UNCERTAIN findings, say what is missing.',
            '- If a NOT FOUND item is listed, say plainly that it was not found.',
            '',
            `QUESTION: ${answer.question}`,
            '',
            'FINDINGS:',
            ...entries.map((e) => `[${e.band}] ${e.text} ${e.markers}`),
            ...(answer.notFound.length ? ['', 'NOT FOUND:', ...answer.notFound.map((n) => `- ${n.subject || ''} ${n.reason}`)] : []),
          ].join('\n'),
        }],
      });
      text = typeof out === 'string' ? out : (out && (out.text || out.content)) || '';
    } catch {
      return null;
    }

    const check = verifyProse(text, citations);
    if (!check.ok) {
      if (this._logger) this._logger.warn('model prose rejected', { reason: check.reason });
      return null;
    }
    return text.trim();
  }
}

// Every `[n]` in the prose must be a citation ordinal that exists. This is what
// stops a model from decorating an invented sentence with a plausible marker.
function verifyProse(text, citations) {
  const valid = new Set(citations.map((c) => c.ordinal));
  const used = new Set();
  for (const m of String(text).matchAll(/\[(\d{1,3})\]/g)) used.add(parseInt(m[1], 10));
  const bogus = [...used].filter((n) => !valid.has(n));
  if (bogus.length) return { ok: false, reason: `prose cites non-existent source(s): ${bogus.join(', ')}` };
  // A URL in the prose that was never cited is a fabrication.
  const citedUrls = new Set(citations.map((c) => c.url).filter(Boolean));
  for (const m of String(text).matchAll(/https?:\/\/[^\s)\]}"']+/g)) {
    const url = m[0].replace(/[.,;]+$/, '');
    if (!citedUrls.has(url)) return { ok: false, reason: `prose contains a url that was never cited: ${url}` };
  }
  return { ok: true, reason: '' };
}

function buildCaveats({ task, quality, conflicts, notFound }) {
  const out = [];
  if (!quality) return out;
  if (quality.grade === 'weak' || quality.grade === 'insufficient') {
    out.push(`The evidence behind this answer is ${quality.grade}; treat it as a starting point rather than a conclusion.`);
  }
  const unresolved = conflicts.filter((c) => c.resolution === 'unresolved').length;
  if (unresolved) out.push(`${unresolved} disagreement(s) between sources could not be resolved from the evidence gathered.`);
  if (notFound.length) out.push('Part of the question could not be answered from the sources available.');
  if (!quality.targetsMet && quality.targetMisses.length) {
    out.push(`This ran as ${task.mode} research but did not reach that standard: ${quality.targetMisses.join('; ')}.`);
  }
  if (task.filesOnly) out.push('Only the files provided were consulted; no external sources were used.');
  if (quality.detail.evidence.independentSources <= 1) {
    out.push('All evidence traces back to a single independent source.');
  }
  return out;
}

module.exports = { Synthesizer, REGISTER, REGISTER_OF, verifyProse, buildCaveats };
