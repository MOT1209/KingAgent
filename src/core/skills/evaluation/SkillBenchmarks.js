// SkillBenchmarks: fixed scenarios that check whether discovery actually works.
//
// These are the §21 real-world scenarios expressed as executable expectations.
// They test the *selection* layer — given this request, does the platform reach
// for the right capabilities — which is the part most likely to rot silently: a
// keyword table drifts, a category is renamed, and nothing fails until an agent
// quietly stops loading the testing skill.
//
// Two honesty notes, both of which shape how the results read:
//
//   * Recall is the metric that matters here, not precision. Selecting a
//     slightly wider set costs some context; missing the security skill on a
//     security task costs the task. So a scenario passes on recall, and
//     precision is reported alongside rather than gated on.
//   * These benchmarks measure discovery, not outcomes. A skill that is
//     correctly selected and then performs badly is invisible to this file —
//     that is what SkillEvaluator's run statistics are for. Neither number
//     alone is a quality measure and the report says so.

const { recommend } = require('../discovery/SkillRecommendation');
const { analyze } = require('../discovery/SkillDiscovery');

// A scenario passes when it finds at least this share of the expected
// categories. Not 1.0: the expectations include categories a reasonable reading
// of the request may not imply (a "build a website" request does not literally
// mention git), and a benchmark that can only pass by over-broadening discovery
// would be pushing the system in the wrong direction.
const PASS_RECALL = 0.6;

const SCENARIOS = Object.freeze([
  {
    id: 'rest-api',
    request: 'Build a REST API.',
    expect: ['architecture', 'api-design', 'implementation', 'unit-testing', 'security-audit', 'documentation'],
    note: 'The canonical greenfield backend task.',
  },
  {
    id: 'mcp-server',
    request: 'Create an MCP server for GitHub.',
    expect: ['mcp-builder', 'api-design', 'security-audit', 'mcp-testing', 'documentation', 'github'],
    note: 'Must reach the MCP category group, not just "implementation".',
  },
  {
    id: 'website-deploy',
    request: 'Build a website and deploy it.',
    expect: ['frontend-design', 'implementation', 'unit-testing', 'git', 'deployment'],
    note: 'Two phases in one sentence: build, then ship.',
  },
  {
    id: 'fix-broken-project',
    request: 'Fix this broken project.',
    expect: ['codebase-analysis', 'debugging', 'root-cause-analysis', 'implementation', 'unit-testing', 'code-review'],
    note: 'Repair work: analysis before change, verification after.',
  },
  {
    id: 'multi-agent-team',
    request: 'Create a multi-agent development team.',
    expect: ['team-builder', 'agent-delegation', 'agent-routing', 'parallel-agents', 'agent-review', 'unit-testing'],
    note: 'Orchestration rather than code.',
  },
  {
    id: 'full-stack-mcp',
    request: 'Build a Next.js application with Supabase authentication, create an MCP server for the API, test it and deploy it to Vercel.',
    expect: ['frontend-design', 'supabase', 'authentication', 'mcp-builder', 'api-design', 'deployment', 'vercel'],
    note: 'The brief\'s own worked example.',
  },
  {
    id: 'security-review',
    request: 'Audit this codebase for security vulnerabilities and fix the critical ones.',
    expect: ['security-audit', 'owasp', 'codebase-analysis', 'implementation'],
    note: 'Security work must not be answered with "implementation" alone.',
  },
]);

// Run one scenario against the discovery layer. With a registry, it also checks
// that the selected working set is non-empty — discovery finding a category
// nothing covers is a gap, and a benchmark should surface it.
function runScenario(scenario, { registry = null, platform = null } = {}) {
  const analysis = analyze(scenario.request);
  const found = new Set(analysis.categories.map((c) => c.category));
  const expected = scenario.expect;
  const matched = expected.filter((c) => found.has(c));
  const missing = expected.filter((c) => !found.has(c));
  const extra = [...found].filter((c) => !expected.includes(c));

  const recall = expected.length ? matched.length / expected.length : 1;
  const precision = found.size ? matched.length / found.size : 0;

  let selection = null;
  if (registry) {
    const rec = recommend({ request: scenario.request, registry, platform });
    selection = {
      skills: rec.selected.map((s) => ({ id: s.skillId, version: s.version, covers: s.coversCategories, phase: s.phase })),
      pipeline: rec.pipeline.map((p) => ({ phase: p.phase, skills: p.skills.map((s) => s.skillId) })),
      gaps: rec.gaps.map((g) => g.category),
    };
  }

  return {
    id: scenario.id,
    request: scenario.request,
    ok: recall >= PASS_RECALL,
    recall: Math.round(recall * 100) / 100,
    precision: Math.round(precision * 100) / 100,
    matched,
    missing,
    extra,
    selection,
    note: scenario.note,
  };
}

function run({ registry = null, platform = null, scenarios = SCENARIOS } = {}) {
  const results = scenarios.map((s) => runScenario(s, { registry, platform }));
  const passed = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? Math.round((passed / results.length) * 100) / 100 : 0,
    meanRecall: round(results.reduce((n, r) => n + r.recall, 0) / (results.length || 1)),
    meanPrecision: round(results.reduce((n, r) => n + r.precision, 0) / (results.length || 1)),
    results,
    // Repeated in the output so a dashboard cannot present this as an overall
    // quality figure.
    measures: 'skill discovery and selection only — not execution quality, which comes from run statistics',
    passThreshold: PASS_RECALL,
  };
}

// Per-skill benchmark results, in the shape SkillQualityScore expects. A skill
// counts as exercised by a scenario when the recommendation selected it.
function perSkill(report) {
  const out = {};
  for (const result of report.results) {
    if (!result.selection) continue;
    for (const skill of result.selection.skills) {
      const entry = out[skill.id] || { total: 0, passed: 0 };
      entry.total += 1;
      if (result.ok) entry.passed += 1;
      out[skill.id] = entry;
    }
  }
  for (const [id, entry] of Object.entries(out)) {
    out[id] = { ...entry, passRate: entry.total ? entry.passed / entry.total : 0 };
  }
  return out;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { SCENARIOS, PASS_RECALL, runScenario, run, perSkill };
