// Query classification (§6): does this need research, how much, and from where?
//
// Deterministic by design. A classifier that needs a model call to decide
// whether a model call is needed has the cost problem backwards, and it makes
// the whole pipeline untestable. The signals here are lexical and structural —
// question shape, temporal words, named surfaces (a repo URL, a file name), and
// the count of distinct subjects — and they are combined into a category plus a
// set of requirements the planner and router read directly.
//
// A host that wants a model in the loop supplies `refine`, which may only
// *narrow*: it can turn `mixed_research` into `comparison`, and it can never
// turn `deep_research` into "no research needed". Letting a model talk the
// engine out of verifying is exactly the failure this layer exists to prevent.

const { SOURCE_TYPES } = require('../schemas/source');
const { FRESHNESS } = require('../retrieval/retrievalCache');
const { tokenize } = require('../../memory/relevance');

const CATEGORY = Object.freeze({
  SIMPLE_FACT: 'simple_fact',
  CURRENT_INFORMATION: 'current_information',
  DEEP_RESEARCH: 'deep_research',
  TECHNICAL_RESEARCH: 'technical_research',
  ACADEMIC_RESEARCH: 'academic_research',
  PRODUCT_RESEARCH: 'product_research',
  COMPARISON: 'comparison',
  NEWS: 'news',
  DOCUMENTATION: 'documentation',
  GITHUB_RESEARCH: 'github_research',
  CODEBASE_RESEARCH: 'codebase_research',
  FILE_RESEARCH: 'file_research',
  MIXED_RESEARCH: 'mixed_research',
  NO_RESEARCH: 'no_research',
});

// Signals. Each is a named predicate so a classification can explain itself —
// `reasons` on the result is what the UI shows and what the tests assert on,
// rather than a bare label nobody can argue with.
const SIGNALS = Object.freeze([
  { id: 'comparison', weight: 3, re: /\b(compare|comparison|versus|vs\.?|better than|difference between|pros and cons|trade-?offs?|alternatives? to|which (one )?should)\b/i },
  { id: 'recency', weight: 3, re: /\b(latest|newest|current|currently|recent|recently|today|this (week|month|year)|right now|as of|up[- ]to[- ]date|202[5-9]|nowadays)\b/i },
  { id: 'news', weight: 3, re: /\b(news|announced|announcement|released|launch(ed)?|breaking|headline|press release)\b/i },
  { id: 'academic', weight: 3, re: /\b(paper|papers|study|studies|research literature|peer[- ]reviewed|journal|arxiv|doi|citation|meta[- ]analysis|systematic review)\b/i },
  { id: 'documentation', weight: 3, re: /\b(api|endpoint|parameter|config(uration)?|docs?|documentation|reference|how do i (use|configure|set up)|changelog|release notes|migration guide|what changed in)\b/i },
  { id: 'github', weight: 4, re: /\b(github\.com\/[\w.-]+\/[\w.-]+|repository|repo\b|pull request|open issues|stargazers|this repo)\b/i },
  { id: 'product', weight: 2, re: /\b(pricing|price|cost|plan|tier|vendor|product|tool(s)? for|best .* (tool|library|framework|service)|market)\b/i },
  { id: 'technical', weight: 2, re: /\b(architecture|implementation|protocol|algorithm|benchmark|performance|latency|throughput|sdk|library|framework|runtime|compiler)\b/i },
  { id: 'files', weight: 5, re: /\b(uploaded|attached|these (files?|documents?)|this (pdf|document|file|spreadsheet)|only (the )?files?|in the (attached|provided))\b/i },
  { id: 'codebase', weight: 4, re: /\b(this (codebase|project|repo)|our code|src\/|the source code|in the repository)\b/i },
  { id: 'depth', weight: 3, re: /\b(deep dive|comprehensive|thorough|in depth|in-depth|full (analysis|review)|survey|landscape|everything about|evaluate)\b/i },
  { id: 'definition', weight: 1, re: /^\s*(what|who|when|where)\s+(is|are|was|were|does|do)\b/i },
  { id: 'howto', weight: 1, re: /\b(how (do|does|to|can)|steps to|guide to|tutorial)\b/i },
  { id: 'opinion', weight: 2, re: /\b(community|people (say|think)|reception|reviews?|experience(s)? with|complaints?|feedback|sentiment)\b/i },
  { id: 'verify', weight: 3, re: /\b(is it true|verify|fact[- ]check|confirm (that|whether)|really|actually|claim)\b/i },
  { id: 'multipart', weight: 2, re: /\b(and also|as well as|in addition|furthermore|;)\b/ },
]);

// Things that plainly need no research: arithmetic, pure instruction to the
// agent about its own workspace, greetings. Being explicit here is what makes
// `no_research` a decision rather than a fallthrough.
const NO_RESEARCH = Object.freeze([
  /^\s*(hi|hello|hey|thanks|thank you|ok|okay)\b/i,
  /^\s*(write|create|refactor|rename|delete|move|fix|format|lint|run|build|test|commit|push)\b/i,
  /^\s*\d+\s*[-+*/^]\s*\d+/,
]);

const TIME_SENSITIVE = Object.freeze([CATEGORY.NEWS, CATEGORY.CURRENT_INFORMATION]);

// Is anything being asked? A question mark, or an interrogative opener, or a
// request-for-information verb. Used to separate "do this" from "tell me this".
function isInterrogative(text) {
  return /\?/.test(text)
    || /^\s*(what|who|whom|whose|when|where|why|which|how|is|are|was|were|do|does|did|can|could|should|would|will)\b/i.test(text)
    || /\b(tell me|explain|research|find out|look up|investigate|summarize|compare|analy[sz]e)\b/i.test(text);
}

function fired(question) {
  return SIGNALS.filter((s) => s.re.test(question));
}

// How many distinct things is this asking about? A comparison of five
// frameworks needs a wider plan than a comparison of two, and the count is the
// cheapest honest estimate of that. Conjunctions and list punctuation, not a
// model.
function subjectCount(question) {
  const listish = question.split(/\s*(?:,|;|\bvs\.?\b|\bversus\b|\band\b|\bor\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  // Capitalized or hyphenated multi-word names are the usual shape of a product
  // or framework name in a comparison question.
  const named = question.match(/\b([A-Z][\w.+-]{2,}(?:\s+[A-Z][\w.+-]{2,})?)\b/g) || [];
  return Math.max(1, Math.min(12, Math.max(listish.length > 1 ? listish.length : 1, new Set(named).size)));
}

function classify(question, { task = null, refine = null } = {}) {
  const text = String(question || '').trim();
  const reasons = [];

  if (!text) {
    return build({ category: CATEGORY.NO_RESEARCH, confidence: 1, reasons: ['empty question'], text, task });
  }
  // An imperative with no question in it is work to do, not something to look
  // up. `refactor src/core/index.js` mentions a path, which is a strong
  // codebase signal, and that must not turn a build instruction into a research
  // task — so the deciding test is whether anything is actually being *asked*.
  if (NO_RESEARCH.some((re) => re.test(text)) && !isInterrogative(text)) {
    return build({ category: CATEGORY.NO_RESEARCH, confidence: 0.8, reasons: ['reads as an instruction, not a question about the world'], text, task });
  }

  const hits = fired(text);
  const has = (id) => hits.some((h) => h.id === id);
  const score = (id) => (has(id) ? SIGNALS.find((s) => s.id === id).weight : 0);
  for (const h of hits) reasons.push(h.id);

  // A task that names files, or is flagged filesOnly, outranks every textual
  // signal: the user told us where to look.
  const hasFiles = (task && (task.filesOnly || (task.files && task.files.length > 0))) || has('files');
  const depth = score('depth') + score('comparison') + (subjectCount(text) >= 3 ? 2 : 0);

  let category;
  if (hasFiles && (task ? task.filesOnly : true) && !has('github')) category = CATEGORY.FILE_RESEARCH;
  else if (has('codebase')) category = CATEGORY.CODEBASE_RESEARCH;
  else if (has('github')) category = CATEGORY.GITHUB_RESEARCH;
  else if (has('news') && has('recency')) category = CATEGORY.NEWS;
  else if (has('academic')) category = CATEGORY.ACADEMIC_RESEARCH;
  else if (has('comparison') && depth >= 5) category = CATEGORY.DEEP_RESEARCH;
  else if (has('comparison')) category = CATEGORY.COMPARISON;
  else if (has('depth')) category = CATEGORY.DEEP_RESEARCH;
  else if (has('documentation')) category = CATEGORY.DOCUMENTATION;
  else if (has('product')) category = CATEGORY.PRODUCT_RESEARCH;
  else if (has('recency') || has('news')) category = CATEGORY.CURRENT_INFORMATION;
  else if (has('technical')) category = CATEGORY.TECHNICAL_RESEARCH;
  // Opinion questions are never simple facts. "What do people think about X"
  // opens like a definition and is answered by a spread of sources with a
  // spread of views — collapsing it to one lookup produces a confident answer
  // built from whichever page ranked first, which is the failure mode §11 and
  // §17 exist to prevent.
  else if (has('opinion')) category = CATEGORY.MIXED_RESEARCH;
  else if (has('definition') && hits.length <= 2) category = CATEGORY.SIMPLE_FACT;
  else if (hits.length >= 3) category = CATEGORY.MIXED_RESEARCH;
  else category = CATEGORY.SIMPLE_FACT;

  const result = build({
    category,
    confidence: confidenceFor(category, hits, text),
    reasons,
    text,
    task,
    subjects: subjectCount(text),
    signals: hits.map((h) => h.id),
  });

  if (typeof refine === 'function') return applyRefinement(result, refine(result));
  return result;
}

// The requirements every downstream stage reads. This is the classifier's real
// output — the category is a label for humans, these are the instructions.
function build({ category, confidence, reasons, text, task, subjects = 1, signals = [] }) {
  const needsResearch = category !== CATEGORY.NO_RESEARCH;
  const sources = sourcesFor(category, signals, task);
  const deep = category === CATEGORY.DEEP_RESEARCH;
  const comparison = category === CATEGORY.COMPARISON || deep;

  return Object.freeze({
    category,
    confidence,
    reasons: Object.freeze([...new Set(reasons)]),
    signals: Object.freeze(signals),
    subjects,
    question: text,
    needsResearch,
    // §6's questionnaire, answered.
    sourceTypes: Object.freeze(sources),
    suggestedQueries: needsResearch ? queryBudgetFor(category, subjects) : 0,
    parallel: needsResearch && sources.length > 1,
    needsVerification: needsResearch && (deep || comparison || signals.includes('verify') || signals.includes('recency')),
    needsCitations: needsResearch,
    needsFiles: sources.includes(SOURCE_TYPES.FILE),
    needsGithub: sources.includes(SOURCE_TYPES.GITHUB),
    needsMcp: sources.includes(SOURCE_TYPES.MCP),
    // Browser automation is never chosen by the classifier. It is an action
    // that acts as the user, and §23/§32 require it to be asked for explicitly.
    needsBrowser: false,
    timeSensitive: TIME_SENSITIVE.includes(category) || signals.includes('recency'),
    freshness: freshnessFor(category, signals),
    suggestedMode: modeFor(category, subjects),
    keywords: Object.freeze(tokenize(text).slice(0, 24)),
  });
}

function sourcesFor(category, signals, task) {
  if (task && task.filesOnly) return [SOURCE_TYPES.FILE];
  const s = new Set();
  switch (category) {
    case CATEGORY.FILE_RESEARCH: s.add(SOURCE_TYPES.FILE); break;
    case CATEGORY.CODEBASE_RESEARCH: s.add(SOURCE_TYPES.FILE); s.add(SOURCE_TYPES.LOCAL); break;
    case CATEGORY.GITHUB_RESEARCH: s.add(SOURCE_TYPES.GITHUB); s.add(SOURCE_TYPES.DOCUMENTATION); s.add(SOURCE_TYPES.WEB); break;
    case CATEGORY.DOCUMENTATION: s.add(SOURCE_TYPES.DOCUMENTATION); s.add(SOURCE_TYPES.WEB); break;
    case CATEGORY.ACADEMIC_RESEARCH: s.add(SOURCE_TYPES.ACADEMIC); s.add(SOURCE_TYPES.WEB); break;
    case CATEGORY.NEWS: s.add(SOURCE_TYPES.NEWS); s.add(SOURCE_TYPES.WEB); break;
    case CATEGORY.CURRENT_INFORMATION: s.add(SOURCE_TYPES.WEB); s.add(SOURCE_TYPES.NEWS); break;
    case CATEGORY.PRODUCT_RESEARCH: s.add(SOURCE_TYPES.WEB); s.add(SOURCE_TYPES.DOCUMENTATION); s.add(SOURCE_TYPES.DISCUSSION); break;
    case CATEGORY.TECHNICAL_RESEARCH: s.add(SOURCE_TYPES.DOCUMENTATION); s.add(SOURCE_TYPES.WEB); s.add(SOURCE_TYPES.GITHUB); break;
    case CATEGORY.COMPARISON: s.add(SOURCE_TYPES.WEB); s.add(SOURCE_TYPES.DOCUMENTATION); s.add(SOURCE_TYPES.DISCUSSION); break;
    case CATEGORY.DEEP_RESEARCH:
      s.add(SOURCE_TYPES.WEB); s.add(SOURCE_TYPES.DOCUMENTATION); s.add(SOURCE_TYPES.GITHUB);
      s.add(SOURCE_TYPES.ACADEMIC); s.add(SOURCE_TYPES.DISCUSSION); break;
    case CATEGORY.MIXED_RESEARCH: s.add(SOURCE_TYPES.WEB); s.add(SOURCE_TYPES.DOCUMENTATION); break;
    case CATEGORY.SIMPLE_FACT: s.add(SOURCE_TYPES.WEB); break;
    default: break;
  }
  if (signals.includes('opinion')) s.add(SOURCE_TYPES.DISCUSSION);
  if (signals.includes('github')) s.add(SOURCE_TYPES.GITHUB);
  if (task && task.files && task.files.length) s.add(SOURCE_TYPES.FILE);
  return [...s];
}

function queryBudgetFor(category, subjects) {
  switch (category) {
    case CATEGORY.SIMPLE_FACT: return 1;
    case CATEGORY.DOCUMENTATION:
    case CATEGORY.FILE_RESEARCH:
    case CATEGORY.CODEBASE_RESEARCH: return 3;
    case CATEGORY.NEWS:
    case CATEGORY.CURRENT_INFORMATION: return 4;
    case CATEGORY.COMPARISON: return Math.min(12, 2 + subjects * 2);
    case CATEGORY.DEEP_RESEARCH: return Math.min(20, 6 + subjects * 2);
    case CATEGORY.ACADEMIC_RESEARCH:
    case CATEGORY.PRODUCT_RESEARCH:
    case CATEGORY.GITHUB_RESEARCH:
    case CATEGORY.TECHNICAL_RESEARCH: return 6;
    case CATEGORY.MIXED_RESEARCH: return 5;
    default: return 0;
  }
}

function freshnessFor(category, signals) {
  if (category === CATEGORY.NEWS) return FRESHNESS.REALTIME;
  if (category === CATEGORY.CURRENT_INFORMATION || signals.includes('recency')) return FRESHNESS.FAST;
  if (category === CATEGORY.PRODUCT_RESEARCH || category === CATEGORY.COMPARISON) return FRESHNESS.MODERATE;
  if (category === CATEGORY.DOCUMENTATION || category === CATEGORY.GITHUB_RESEARCH) return FRESHNESS.SLOW;
  if (category === CATEGORY.SIMPLE_FACT || category === CATEGORY.ACADEMIC_RESEARCH) return FRESHNESS.STATIC;
  return FRESHNESS.MODERATE;
}

function modeFor(category, subjects) {
  if (category === CATEGORY.NO_RESEARCH) return null;
  if (category === CATEGORY.DEEP_RESEARCH) return 'deep';
  if (category === CATEGORY.SIMPLE_FACT) return 'quick';
  if (category === CATEGORY.COMPARISON && subjects >= 3) return 'deep';
  return 'standard';
}

function confidenceFor(category, hits, text) {
  const strong = hits.filter((h) => h.weight >= 3).length;
  const base = category === CATEGORY.SIMPLE_FACT && hits.length === 0 ? 0.4 : 0.5 + strong * 0.15;
  const lengthPenalty = text.length > 400 ? 0.1 : 0;
  return Math.max(0.2, Math.min(0.95, base - lengthPenalty));
}

// A host refinement may narrow the category and add source types. It may not
// clear `needsResearch`, drop verification, or drop citations.
function applyRefinement(base, refinement) {
  if (!refinement || typeof refinement !== 'object') return base;
  const category = Object.values(CATEGORY).includes(refinement.category) && refinement.category !== CATEGORY.NO_RESEARCH
    ? refinement.category
    : base.category;
  const extraSources = Array.isArray(refinement.sourceTypes) ? refinement.sourceTypes : [];
  return Object.freeze({
    ...base,
    category,
    refinedBy: 'host',
    sourceTypes: Object.freeze([...new Set([...base.sourceTypes, ...extraSources])]),
    needsResearch: base.needsResearch,
    needsVerification: base.needsVerification || refinement.needsVerification === true,
    needsCitations: base.needsCitations,
    confidence: typeof refinement.confidence === 'number'
      ? Math.max(base.confidence, Math.min(0.99, refinement.confidence))
      : base.confidence,
  });
}

module.exports = { CATEGORY, SIGNALS, classify, isInterrogative, subjectCount, queryBudgetFor, freshnessFor, modeFor, applyRefinement };
