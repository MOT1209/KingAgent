// Turning raw history into something worth remembering.
//
// Two hard rules, both learned from how this goes wrong:
//
//   1. **Summarizing never deletes.** The summary is a *new* entry that points
//      back at its sources. Raw history is the only thing that can settle a
//      disagreement about what actually happened, so it is never collapsed
//      automatically — a caller that wants it gone has to say so explicitly.
//   2. **It works without a model.** A provider produces a better summary; the
//      deterministic path produces a correct one. The platform must stay useful
//      offline, so the model is an upgrade, not a dependency.

const { TYPES } = require('./entry');
const { IMPORTANCE, rank: importanceRank } = require('./importance');

const DEFAULT_MAX_CHARS = 1200;

// Sentences that state something durable, in rough order of usefulness.
const FACT_PATTERNS = [
  /\b(?:decided|chose|uses|requires|depends on|must|never|always|convention|expects)\b/i,
  /\b(?:failed|broke|error|regression|fix(?:ed)?)\b/i,
  /\b(?:added|created|removed|renamed|modified)\b/i,
];

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pull the durable statements out of a pile of entries, most important first,
// de-duplicated so a fact repeated across five steps is remembered once.
function extractFacts(entries, { maxFacts = 12 } = {}) {
  const seen = new Set();
  const scored = [];
  const ordered = [...entries].sort((a, b) =>
    (importanceRank(b.importance) - importanceRank(a.importance)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));

  for (const entry of ordered) {
    for (const sentence of sentences(entry.content)) {
      const norm = sentence.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(norm)) continue;
      const matched = FACT_PATTERNS.findIndex((re) => re.test(sentence));
      if (matched === -1 && entry.type !== TYPES.DECISION && entry.type !== TYPES.CONSTRAINT) continue;
      seen.add(norm);
      scored.push({ text: sentence.slice(0, 240), weight: matched === -1 ? 0 : FACT_PATTERNS.length - matched, from: entry.id });
      if (scored.length >= maxFacts * 3) break;
    }
  }
  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, maxFacts);
}

function deterministicSummary(entries, maxChars) {
  const facts = extractFacts(entries);
  const head = `${entries.length} entries; ${facts.length} durable facts.`;
  const body = facts.map((f) => `- ${f.text}`).join('\n');
  const text = `${head}\n${body}`.slice(0, maxChars);
  return { summary: text, facts: facts.map((f) => f.text), sources: entries.map((e) => e.id) };
}

// `provider` is the platform's AI provider (ai/provider.js) or null. A provider
// failure is never fatal: the deterministic summary is always computed first and
// returned on any error, so summarization cannot break a task.
async function summarizeEntries(entries, { provider = null, maxChars = DEFAULT_MAX_CHARS, signal = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const base = deterministicSummary(list, maxChars);
  if (!provider || list.length === 0) return base;
  try {
    const joined = list.map((e) => `[${e.importance}] ${e.content}`).join('\n').slice(0, 8000);
    const res = await provider.generate({
      system: 'Summarize these notes into durable facts. Return { summary: string, facts: string[] }. No prose, no reasoning.',
      messages: [{ role: 'user', content: joined }],
      structured: true,
      maxTokens: 500,
      signal,
    });
    const v = res && res.structured;
    if (!v || typeof v.summary !== 'string' || !v.summary.trim()) return base;
    return {
      summary: v.summary.slice(0, maxChars),
      facts: Array.isArray(v.facts) ? v.facts.slice(0, 20).map((f) => String(f).slice(0, 240)) : base.facts,
      sources: base.sources,
    };
  } catch {
    return base;
  }
}

// The summary as a memory entry definition, ready for MemoryManager.store().
// It records its sources so the raw entries it came from stay reachable.
function summaryEntry(summary, { scope, scopeId, source = 'summarizer', tags = [] }) {
  return {
    type: TYPES.SUMMARY,
    content: summary.summary,
    scope,
    scopeId,
    source,
    importance: IMPORTANCE.NORMAL,
    tags: [...new Set(['summary', ...tags])],
    metadata: { facts: summary.facts, sources: summary.sources, summarizedCount: summary.sources.length },
  };
}

module.exports = { summarizeEntries, deterministicSummary, extractFacts, summaryEntry, sentences, DEFAULT_MAX_CHARS };
