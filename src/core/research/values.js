// Quantitative values inside a passage, and whether two of them disagree.
//
// Lives outside evidence/ and citations/ so both the stance detector and the
// conflict detector can use it without importing each other. That matters for
// correctness, not tidiness: stance and conflict have to agree about what
// "different numbers" means, or a passage saying "v1.2.0" can be recorded as
// *supporting* a claim that says "v0.9.0" while the conflict detector
// simultaneously reports the two as contradictory.

// Numbers with a unit or a currency, and version strings. A bare integer in
// prose is too noisy to compare, so it is deliberately not matched.
const VALUE_PATTERNS = Object.freeze([
  { kind: 'version', re: /\bv?(\d+\.\d+(?:\.\d+)?)\b/g },
  { kind: 'currency', re: /(?:[$£€]\s?|\b(?:USD|EUR|GBP)\s)(\d+(?:[.,]\d+)?)\b/gi },
  { kind: 'percent', re: /\b(\d+(?:\.\d+)?)\s?(?:%|percent)\b/gi },
  { kind: 'duration', re: /\b(\d+(?:\.\d+)?)\s?(ms|milliseconds?|s|seconds?|minutes?|hours?|days?)\b/gi },
  { kind: 'size', re: /\b(\d+(?:\.\d+)?)\s?(kb|mb|gb|tb)\b/gi },
  { kind: 'count', re: /\b(\d+(?:,\d{3})*)\s+(?:users?|stars?|contributors?|requests?|tokens?|models?)\b/gi },
]);

function valuesIn(text) {
  const out = [];
  for (const { kind, re } of VALUE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of String(text).matchAll(re)) {
      const raw = m[1];
      const unit = (m[2] || '').toLowerCase();
      const num = parseFloat(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(num) && kind !== 'version') continue;
      out.push({ kind, unit, raw: String(raw), num: Number.isFinite(num) ? num : null, text: m[0] });
    }
  }
  return out;
}

// Two values conflict when they measure the same thing and differ by more than
// rounding. 2% tolerance: "about 50ms" and "51ms" are one claim written twice.
function valuesDisagree(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'version' && a.unit !== b.unit) return false;
  if (a.kind === 'version') return a.raw !== b.raw;
  if (a.num === null || b.num === null) return false;
  const scale = Math.max(Math.abs(a.num), Math.abs(b.num)) || 1;
  return Math.abs(a.num - b.num) / scale > 0.02;
}

// Does `text` state a value that contradicts one stated in `reference`?
// Used by the stance detector: a passage whose numbers disagree with the claim
// is evidence against it, however affirmatively it is phrased.
function contradictsValues(text, reference) {
  const mine = valuesIn(text);
  if (mine.length === 0) return false;
  const theirs = valuesIn(reference);
  if (theirs.length === 0) return false;
  return theirs.some((t) => mine.some((m) => valuesDisagree(m, t)));
}

module.exports = { VALUE_PATTERNS, valuesIn, valuesDisagree, contradictsValues };
