// Evidence extraction (§15): find the passages in a source that actually bear
// on the question, and record where they are.
//
// The rule this module exists to enforce: **evidence is quoted, not
// paraphrased.** Every span it emits is a verbatim substring of the source's
// stored text, with the character offsets to prove it, and citationValidator
// later re-derives the digest from the source to confirm nothing drifted. A
// summariser that returned "the page says X" would defeat the whole citation
// chain, because nothing downstream could check X against anything.
//
// Extraction is deterministic. A model provider can be supplied to *select*
// among the extracted spans and to label their stance, but it never authors the
// text of a span — it may only point at one. That keeps a hallucinated quote
// structurally impossible rather than merely discouraged.

const { normalizeEvidence, EVIDENCE_KIND, STANCE, MAX_EVIDENCE_CHARS } = require('../schemas/evidence');
const { tokenSet, coverage: tokenCoverage } = require('../text');
const { contradictsValues } = require('../values');
const { ResearchValidationError } = require('../errors/researchErrors');

// Sentence splitting that survives the things that break naive `split('.')`:
// abbreviations, decimals, version numbers, ellipses, and URLs.
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|cf|approx|fig|no|vol|ch|sec|dr|mr|mrs|ms|st|inc|ltd|co|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.$/i;

function splitSentences(text) {
  const out = [];
  const body = String(text || '');
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\n') continue;
    if (ch === '.') {
      const before = body.slice(Math.max(0, i - 12), i + 1);
      if (ABBREV.test(before)) continue;
      // A decimal or version number: 1.2, v3.0.1
      if (/\d$/.test(body[i - 1] || '') && /\d/.test(body[i + 1] || '')) continue;
      if (body[i + 1] === '.' || body[i - 1] === '.') continue; // ellipsis
    }
    // A sentence end needs whitespace or end-of-text after it, else it is
    // punctuation inside a token (a URL path, a filename).
    const next = body[i + 1];
    if (ch !== '\n' && next && !/\s/.test(next)) continue;
    const end = i + 1;
    if (end - start > 1) out.push({ text: body.slice(start, end).trim(), start, end });
    start = end;
  }
  if (body.length - start > 1) out.push({ text: body.slice(start).trim(), start, end: body.length });
  return out.filter((s) => s.text.length > 0);
}

// Shapes that make a sentence worth extracting, and what kind of evidence it is.
// Ordered: the first match wins, most specific first.
const KIND_PATTERNS = Object.freeze([
  { kind: EVIDENCE_KIND.CODE, re: /`[^`\n]{2,}`|^\s{4,}\S|\b(?:function|class|const|import|SELECT|curl)\b\s/ },
  { kind: EVIDENCE_KIND.STATISTIC, re: /\b\d+(?:[.,]\d+)?\s?(?:%|percent|ms|seconds?|minutes?|hours?|x faster|times|users|requests|tokens|MB|GB|KB)\b/i },
  { kind: EVIDENCE_KIND.DEFINITION, re: /\b(?:is|are)\s+(?:an?|the)\b|\b(?:refers to|is defined as|means that|stands for|is a protocol|consists of)\b/i },
  { kind: EVIDENCE_KIND.EXAMPLE, re: /\b(?:for example|for instance|such as|e\.g\.)\b/i },
]);

function kindOf(sentence) {
  for (const { kind, re } of KIND_PATTERNS) if (re.test(sentence)) return kind;
  return EVIDENCE_KIND.QUOTE;
}

// Sentences that are never evidence however well they match: navigation, legal
// boilerplate, cookie banners, and the untrusted-instruction markers the
// security layer left behind.
const BOILERPLATE = /^(?:cookie|privacy policy|terms of|all rights reserved|sign in|subscribe|share this|advertisement|skip to|related articles?|read more|back to top)\b|\[untrusted-instruction-text:|\[redacted-/i;

// Score a sentence against the question. Lexical overlap plus a bonus for
// evidence shape — a sentence that mentions the subject *and* asserts something
// about it beats one that only mentions it.
function scoreSentence(sentence, queryTokens) {
  const tokens = tokenSet(sentence);
  if (tokens.size === 0) return 0;
  const coverage = tokenCoverage(queryTokens, tokens);
  const assertive = /\b(?:is|are|was|were|has|have|supports?|requires?|provides?|returns?|means|allows?|does not|cannot|must|should)\b/i.test(sentence) ? 0.15 : 0;
  // Very short sentences carry little and very long ones are usually
  // run-together navigation.
  const lengthFit = sentence.length < 40 ? 0.5 : sentence.length > 600 ? 0.6 : 1;
  return Math.min(1, (coverage + assertive) * lengthFit);
}

// Group adjacent high-scoring sentences into one span, so a definition split
// across two sentences is quoted whole rather than truncated mid-thought.
function windowSpans(sentences, keepIdx, { maxChars = MAX_EVIDENCE_CHARS }) {
  const spans = [];
  const sorted = [...keepIdx].sort((a, b) => a - b);
  let run = null;
  for (const i of sorted) {
    if (run && i === run.lastIndex + 1 && (sentences[i].end - run.start) <= maxChars) {
      run.lastIndex = i;
      run.end = sentences[i].end;
      run.indices.push(i);
      continue;
    }
    if (run) spans.push(run);
    run = { start: sentences[i].start, end: sentences[i].end, lastIndex: i, indices: [i] };
  }
  if (run) spans.push(run);
  return spans;
}

class EvidenceExtractor {
  constructor({ provider = null, logger = null, minScore = 0.2, maxPerSource = 4 } = {}) {
    this._provider = provider;
    this._logger = logger;
    this._minScore = minScore;
    this._maxPerSource = maxPerSource;
  }

  // Extract from one source. Returns Evidence[] — always verbatim spans of
  // `source.content` (or `source.snippet` when that is all we have).
  extract({ source, question, claim = null, queryId = null, maxItems = null }) {
    // A source that was never screened must not become evidence: the security
    // layer stamps `safety` on everything it passes, so a null here means the
    // document reached this point around the boundary.
    if (!source.safety) {
      throw new ResearchValidationError(`source ${source.id} was never security-screened; refusing to extract evidence from it`, { field: 'safety' });
    }
    const body = source.content && source.content.length >= 40 ? source.content : source.snippet;
    if (!body) return [];

    const target = claim ? `${claim.text} ${question}` : question;
    const askedTokens = tokenSet(target);
    const sentences = splitSentences(body);
    if (sentences.length === 0) return [];

    // Score sentences against the query terms this document *can* speak to.
    //
    // The document was already judged relevant — that is why it was retrieved.
    // Scoring its sentences against the whole question re-litigates that
    // decision and loses: "Analyze the github repository acme/widget and
    // explain its architecture" has six terms, five of which appear nowhere in
    // a README, so the one sentence that actually describes the architecture
    // scored 1/6 and fell under the bar. Intersecting with the document's own
    // vocabulary asks the right question — which sentence here is most on
    // point — and falls back to the full query when there is no overlap at all.
    const docTokens = tokenSet(body);
    const answerable = new Set([...askedTokens].filter((t) => docTokens.has(t)));
    const queryTokens = answerable.size ? answerable : askedTokens;

    const scored = sentences
      .map((s, i) => ({ i, s, score: BOILERPLATE.test(s.text) ? 0 : scoreSentence(s.text, queryTokens) }))
      .filter((r) => r.score >= this._minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, (maxItems || this._maxPerSource) * 2);

    if (scored.length === 0) return [];

    const spans = windowSpans(sentences, scored.map((r) => r.i), {})
      .slice(0, maxItems || this._maxPerSource);

    return spans.map((span) => {
      // The span is taken from the body by offset — this is what makes it
      // verbatim by construction rather than by promise.
      const text = body.slice(span.start, span.end).trim();
      const best = Math.max(...span.indices.map((i) => {
        const row = scored.find((r) => r.i === i);
        return row ? row.score : 0;
      }));
      return normalizeEvidence({
        sourceId: source.id,
        claimId: claim ? claim.id : null,
        queryId,
        kind: kindOf(text),
        stance: claim ? this._stanceFor(text, claim) : STANCE.NEUTRAL,
        text,
        context: contextAround(body, span.start, span.end),
        location: locationFor(source, span, body),
        relevance: best,
        // Strength is set by evidenceRanker, which can see the source's quality.
        strength: null,
        extractor: 'deterministic',
      });
    });
  }

  // Extract across many sources, keeping per-source caps so one long page
  // cannot supply every piece of evidence in the task.
  extractAll({ sources, question, claim = null, queryId = null, onError = null }) {
    const out = [];
    for (const source of sources) {
      try {
        out.push(...this.extract({ source, question, claim, queryId }));
      } catch (err) {
        if (onError) onError({ sourceId: source.id, reason: err.message, code: err.code || null });
      }
    }
    return out;
  }

  // Stance toward a claim. Delegates to the module-level `stanceToward` so the
  // claim analyzer uses the identical rule — having two places decide what
  // "contradicts" means is how a passage ends up supporting a claim it refutes.
  _stanceFor(text, claim) {
    return stanceToward(text, claim.text);
  }

  // Optional model pass: given already-extracted spans, let a provider pick the
  // most on-point ones and label stance. It may reorder and drop; it may not
  // add, and the text it returns is ignored — only the indices are read.
  async refine({ evidence, claim, provider = this._provider, limit = 4 }) {
    if (!provider || typeof provider.generate !== 'function' || evidence.length <= 1) return evidence;
    let text;
    try {
      const out = await provider.generate({
        messages: [{
          role: 'user',
          content: [
            `CLAIM: ${claim.text}`,
            '',
            'Numbered passages follow. Reply with the numbers of the passages that',
            `bear on the claim, best first, at most ${limit}, comma-separated, and`,
            'nothing else. Then a second line: for each number, "n:supports",',
            '"n:contradicts" or "n:neutral".',
            '',
            ...evidence.map((e, i) => `${i + 1}. ${e.text.slice(0, 400)}`),
          ].join('\n'),
        }],
        maxTokens: 200,
      });
      text = typeof out === 'string' ? out : (out && (out.text || out.content)) || '';
    } catch {
      return evidence;
    }

    const lines = String(text).split(/\r?\n/);
    const picked = (lines[0].match(/\d+/g) || [])
      .map((n) => parseInt(n, 10) - 1)
      .filter((i) => i >= 0 && i < evidence.length);
    if (picked.length === 0) return evidence;

    const stances = new Map();
    for (const m of String(lines[1] || '').matchAll(/(\d+)\s*:\s*(supports|contradicts|neutral)/gi)) {
      stances.set(parseInt(m[1], 10) - 1, m[2].toLowerCase());
    }

    const seen = new Set();
    const out = [];
    for (const i of picked) {
      if (seen.has(i)) continue;
      seen.add(i);
      const item = evidence[i];
      const stance = stances.get(i);
      out.push(stance && stance !== item.stance
        // The span's text, offsets and digest are carried through untouched.
        // Only the label changes, and only to one of three known values.
        ? normalizeEvidence({ ...item, stance, extractor: `${item.extractor}+model` })
        : item);
      if (out.length >= limit) break;
    }
    return out;
  }
}

// Stance, from value disagreement and from negation markers near the claim's
// terms. Deliberately conservative: anything unclear is NEUTRAL, because a
// mis-labelled "contradicts" invents a conflict and a mis-labelled "supports"
// invents corroboration, and both are worse than "we are not sure".
//
// Exported, and used by claimAnalyzer as well as by the extractor, because
// every path that attaches evidence to a claim has to agree about the sign.
const NEGATED = /\b(?:not|never|no longer|cannot|can't|doesn't|does not|isn't|is not|unsupported|unavailable|removed|deprecated|false|incorrect|contrary)\b/i;
const AFFIRMED = /\b(?:supports?|provides?|includes?|costs?|does|is|are|available|implemented|confirmed|true)\b/i;

function stanceToward(text, claimText, { minOnTopic = 0.35 } = {}) {
  const claimTokens = tokenSet(claimText);
  const onTopic = tokenCoverage(claimTokens, tokenSet(text));
  if (onTopic < minOnTopic) return STANCE.NEUTRAL;
  // A passage stating a different version, price or measurement contradicts the
  // claim however affirmatively it is worded. Without this, "the current version
  // is v1.2.0" reads as *supporting* a claim that says v0.9.0: both sentences
  // are affirmative and only the numbers disagree.
  if (contradictsValues(text, claimText)) return STANCE.CONTRADICTS;
  const negated = NEGATED.test(text);
  const affirmed = AFFIRMED.test(text);
  if (negated && !affirmed) return STANCE.CONTRADICTS;
  if (negated && affirmed) return STANCE.NEUTRAL; // mixed: not our call to make
  if (affirmed) return STANCE.SUPPORTS;
  return STANCE.NEUTRAL;
}

function contextAround(body, start, end, pad = 200) {
  return body.slice(Math.max(0, start - pad), Math.min(body.length, end + pad)).trim();
}

function locationFor(source, span, body) {
  if (source.path) {
    const before = body.slice(0, span.start);
    const line = before.split('\n').length;
    const lines = body.slice(span.start, span.end).split('\n').length;
    return { kind: 'line', path: source.path, line, endLine: line + lines - 1, start: span.start, end: span.end };
  }
  return { kind: 'char', start: span.start, end: span.end };
}

module.exports = { EvidenceExtractor, stanceToward, splitSentences, scoreSentence, kindOf, BOILERPLATE };
