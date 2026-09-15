// SkillQualityScore: a number, and the sentences that justify it.
//
// The brief's requirement — "do not expose a simplistic score without
// explaining why it was assigned" — is a design constraint, not a docs note. A
// bare 0.72 next to a skill tells a user nothing they can act on, and worse, it
// launders a small sample into an authoritative-looking figure. So every score
// produced here carries:
//
//   components  each input, its raw value, its weight, its contribution
//   confidence  how much evidence is behind it (runs, benchmarks)
//   caveats     what the number does *not* know
//   grade       a coarse label, because a coarse label is honest at low
//               confidence where two decimal places are not
//
// A skill with no history gets `score: null`, not zero. "Unknown" and "bad" are
// different, and collapsing them is how a new, well-built skill gets buried.

const { highestSeverity } = require('../security/SkillScanner');
const { trustRank, TRUST_TIERS } = require('../registry/SkillSource');

const WEIGHTS = Object.freeze({
  reliability: 0.35,
  security: 0.25,
  evaluation: 0.20,
  maintenance: 0.12,
  adoption: 0.08,
});

// Below this many runs, the observed success rate is reported but the overall
// score is labelled low-confidence and the grade is widened.
const CONFIDENT_RUNS = 10;

function clamp01(n) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function score(record, { benchmarks = null, now = Date.now() } = {}) {
  const components = [];
  const caveats = [];

  // --- reliability --------------------------------------------------------
  const runs = record.stats.runs;
  const successRate = runs > 0 ? record.stats.successes / runs : null;
  if (successRate === null) caveats.push('never run on this machine — reliability is unknown, not zero');
  components.push(component({
    name: 'reliability',
    value: successRate === null ? 0.6 : successRate,
    weight: WEIGHTS.reliability,
    explanation: successRate === null
      ? 'no runs yet; scored at the neutral prior (0.6) so an unproven skill is neither rewarded nor punished'
      : `${record.stats.successes} of ${runs} runs succeeded`,
  }));

  // --- security -----------------------------------------------------------
  const worst = highestSeverity(record.security.findings || []);
  const incidents = record.stats.securityIncidents;
  const securityValue = record.security.blocked || incidents > 0
    ? 0
    : worst === 'critical' ? 0 : worst === 'warn' ? 0.55 : record.security.scanned ? 1 : 0.6;
  if (!record.security.scanned) caveats.push('content has not been scanned');
  if (incidents > 0) caveats.push(`${incidents} security incident(s) recorded during execution`);
  components.push(component({
    name: 'security',
    value: securityValue,
    weight: WEIGHTS.security,
    explanation: incidents > 0
      ? `${incidents} security incident(s) — this alone caps the score`
      : record.security.scanned
        ? `scanner found ${(record.security.findings || []).length} finding(s), worst severity "${worst}"`
        : 'not scanned',
  }));

  // --- evaluation (benchmarks) -------------------------------------------
  const evaluation = benchmarks && Number.isFinite(benchmarks.passRate) ? benchmarks.passRate : null;
  if (evaluation === null) caveats.push('no benchmark has been run against this skill');
  components.push(component({
    name: 'evaluation',
    value: evaluation === null ? 0.5 : evaluation,
    weight: WEIGHTS.evaluation,
    explanation: evaluation === null
      ? 'no benchmark results; scored neutral'
      : `passed ${Math.round(evaluation * 100)}% of ${benchmarks.total} benchmark scenario(s)`,
  }));

  // --- maintenance --------------------------------------------------------
  const updatedAt = record.updatedAt || record.installedAt || null;
  const ageDays = updatedAt ? (now - updatedAt) / 86_400_000 : null;
  const maintenanceValue = record.manifest.deprecated
    ? 0.1
    : ageDays === null ? 0.5 : ageDays <= 30 ? 1 : ageDays >= 365 ? 0.2 : clamp01(1 - ((ageDays - 30) / 335) * 0.8);
  components.push(component({
    name: 'maintenance',
    value: maintenanceValue,
    weight: WEIGHTS.maintenance,
    explanation: record.manifest.deprecated
      ? 'marked deprecated by its publisher'
      : ageDays === null ? 'no update timestamp' : `last updated ${Math.round(ageDays)} day(s) ago`,
  }));

  // --- adoption -----------------------------------------------------------
  // Weighted least of all, and stated as what it is: a popularity signal, not a
  // quality one. It breaks ties; it does not decide.
  const installs = (record.quality && record.quality.installs) || 0;
  components.push(component({
    name: 'adoption',
    value: installs > 0 ? clamp01(Math.log10(installs + 1) / 5) : 0,
    weight: WEIGHTS.adoption,
    explanation: installs > 0
      ? `${installs} reported install(s) — a popularity signal, weighted lowest on purpose`
      : 'no install count reported',
  }));

  const total = components.reduce((sum, c) => sum + c.contribution, 0);
  const confidence = confidenceOf({ runs, benchmarks });
  const trust = trustRank(record.trust.tier) / (TRUST_TIERS.length - 1);

  return {
    score: Math.round(total * 1000) / 1000,
    grade: gradeOf(total, confidence),
    confidence,
    confidenceLabel: confidence >= 0.7 ? 'high' : confidence >= 0.35 ? 'moderate' : 'low',
    components,
    caveats,
    successRate,
    runs,
    trust: record.trust.tier,
    trustFactor: Math.round(trust * 100) / 100,
    installs: installs || null,
    computedAt: now,
    // One sentence a UI can show without the user opening a panel.
    summary: summarize(record, components, total, confidence, caveats),
  };
}

function component({ name, value, weight, explanation }) {
  const v = clamp01(value);
  return {
    name,
    value: Math.round(v * 1000) / 1000,
    weight,
    contribution: Math.round(v * weight * 1000) / 1000,
    explanation,
  };
}

function confidenceOf({ runs, benchmarks }) {
  const runConfidence = Math.min(1, runs / CONFIDENT_RUNS);
  const benchConfidence = benchmarks && benchmarks.total ? Math.min(1, benchmarks.total / 3) : 0;
  return Math.round(((runConfidence * 0.7) + (benchConfidence * 0.3)) * 100) / 100;
}

// Grades widen at low confidence instead of pretending to precision: below a
// third of the evidence we want, a skill is "unproven" rather than "good".
function gradeOf(total, confidence) {
  if (confidence < 0.35) return 'unproven';
  if (total >= 0.85) return 'excellent';
  if (total >= 0.7) return 'good';
  if (total >= 0.5) return 'fair';
  if (total >= 0.3) return 'poor';
  return 'failing';
}

function summarize(record, components, total, confidence, caveats) {
  const strongest = [...components].sort((a, b) => b.contribution - a.contribution)[0];
  const weakest = [...components].sort((a, b) => a.value - b.value)[0];
  const head = `${gradeOf(total, confidence)} (${Math.round(total * 100)}/100, ${confidence >= 0.7 ? 'high' : confidence >= 0.35 ? 'moderate' : 'low'} confidence)`;
  const body = `strongest: ${strongest.name} — ${strongest.explanation}; weakest: ${weakest.name} — ${weakest.explanation}`;
  return caveats.length ? `${head}. ${body}. Caveats: ${caveats.join('; ')}.` : `${head}. ${body}.`;
}

module.exports = { WEIGHTS, CONFIDENT_RUNS, score, gradeOf, confidenceOf };
