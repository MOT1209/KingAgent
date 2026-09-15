// Phase 7 §56: the audits, as tests rather than a one-off report.
//
// A report says "we checked". A test says "it cannot regress". Everything §56
// asks to audit that *can* be asserted mechanically is asserted here, so the
// properties survive the next person to touch this code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH = path.join(ROOT, 'src', 'core', 'research');

function researchFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  })(RESEARCH);
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const sources = researchFiles().map((f) => ({ file: rel(f), text: fs.readFileSync(f, 'utf8') }));

// Comments carry prose that names the things the code must not do.
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// --- architecture audit ------------------------------------------------------

test('audit/architecture: no placeholder or stub implementation remains', () => {
  const bad = [];
  for (const { file, text } of sources) {
    const body = code(text);
    // A TODO or a thrown "not implemented" in a shipped subsystem is a
    // promise nobody kept.
    if (/\bTODO\b|\bFIXME\b|\bXXX\b/.test(body)) bad.push(`${file}: carries a TODO`);
    if (/not implemented|unimplemented|coming soon/i.test(body)) bad.push(`${file}: has an unimplemented path`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('audit/architecture: every research module is reachable from the barrel', () => {
  // A module nobody requires is dead code however good it is.
  const required = new Set();
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/require\('(\.[^']+)'\)/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])).replace(/\.js$/, '');
      required.add(resolved);
      // `require('./schemas')` resolves to `./schemas/index.js`; record both
      // spellings so a directory require does not read as an orphan.
      required.add(`${resolved}/index`);
    }
  }
  const orphans = sources
    .map((s) => s.file.replace(/\.js$/, ''))
    .filter((f) => !f.endsWith('research/index') && !required.has(f));
  assert.deepEqual(orphans, [], `unreachable research modules:\n  ${orphans.join('\n  ')}`);
});

test('audit/architecture: the barrel exposes one assembly point and it builds with nothing wired', () => {
  const { createResearchSubsystem } = require('../src/core/research');
  const s = createResearchSubsystem({});
  assert.ok(s.engine && s.researcher && s.sources && s.capabilities);
  // No providers, no policy, no memory, no fs: it must still describe itself
  // rather than throwing.
  const caps = s.capabilities();
  assert.ok(Array.isArray(caps.sources) && caps.sources.length > 0);
  assert.equal(caps.mcp, 'not configured');
  assert.equal(caps.model, 'not configured');
});

// --- security audit ----------------------------------------------------------

test('audit/security: only the security module decides what is safe', () => {
  // Every URL screen and content screen goes through one file. A second place
  // that decided this would be a second place to get it wrong.
  const offenders = sources
    .filter((s) => !s.file.endsWith('security/researchSecurity.js'))
    .filter((s) => /new RegExp\(|\beval\(|new Function\(/.test(code(s.text)));
  assert.deepEqual(offenders.map((o) => o.file), [], 'dynamic code construction in the research layer');
});

test('audit/security: nothing in research writes to the filesystem', () => {
  // Research reads. A research layer that could write is a much larger blast
  // radius for a subsystem whose job is ingesting untrusted text.
  const bad = [];
  for (const { file, text } of sources) {
    const body = code(text);
    for (const call of ['writeFile', 'appendFile', 'mkdir', 'rm(', 'rmdir', 'unlink', 'rename', 'copyFile', 'chmod']) {
      if (body.includes(`fs.${call}`)) bad.push(`${file}: fs.${call}`);
    }
    // `exec(` alone is not a signal — RegExp.prototype.exec is everywhere in
    // this layer. The real ones are named.
    if (/child_process|spawnSync|execSync|execFile|\bspawn\(/.test(body)) bad.push(`${file}: spawns a process`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('audit/security: the research agent cannot reach a destructive tool', () => {
  const { researchAgentDefinition } = require('../src/core/research/agents/researchAgent');
  const { canUseTool } = require('../src/core/tools/permissions');
  const { normalizeAgent } = require('../src/core/agents/definition');
  const agent = normalizeAgent(researchAgentDefinition());
  const destructive = { id: 'fs:delete', permissions: { level: 'destructive', requiresAuth: true }, capabilities: [] };
  assert.equal(canUseTool(agent, destructive).ok, false);
});

// --- performance audit -------------------------------------------------------

test('audit/performance: nothing unbounded reaches a provider or a store', () => {
  const { createResearchTask, MODE_DEFAULTS } = require('../src/core/research/schemas/researchTask');
  for (const mode of ['quick', 'standard', 'deep']) {
    const task = createResearchTask({ question: 'q', mode });
    for (const key of ['maxQueries', 'maxSources', 'maxConcurrency', 'maxToolCalls', 'timeoutMs']) {
      assert.ok(task.limits[key] > 0, `${mode}.${key} is unbounded`);
    }
    assert.ok(task.limits.maxConcurrency <= 8, `${mode} allows ${task.limits.maxConcurrency} concurrent retrievals`);
    assert.ok(task.deadline > Date.now(), `${mode} has no deadline`);
  }
  // Deep must cost more than quick, or the modes are labels.
  assert.ok(MODE_DEFAULTS.deep.maxSources > MODE_DEFAULTS.standard.maxSources);
  assert.ok(MODE_DEFAULTS.standard.maxSources > MODE_DEFAULTS.quick.maxSources);
});

test('audit/performance: content is truncated at the boundary, not deep in the pipeline', () => {
  const { normalizeSource, MAX_CONTENT_CHARS } = require('../src/core/research/schemas/source');
  const huge = normalizeSource({ title: 'X', url: 'https://x.dev/1', content: 'a'.repeat(MAX_CONTENT_CHARS * 3) });
  assert.ok(huge.content.length <= MAX_CONTENT_CHARS + 1);
  assert.equal(huge.truncated, true, 'a truncated source must know it was truncated');
});

test('audit/performance: the cache is bounded and evicts', async () => {
  const { createRetrievalCache, FRESHNESS } = require('../src/core/research/retrieval/retrievalCache');
  const cache = createRetrievalCache({ maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) {
    await cache.set(cache.key({ query: `q${i}`, sourceType: 'web' }), [i], { freshness: FRESHNESS.SLOW });
  }
  assert.equal(cache.size(), 3);
  assert.ok(cache.stats().evictions > 0);
});

// --- research accuracy audit -------------------------------------------------

test('audit/accuracy: confidence can never reach certainty', () => {
  const { deriveConfidence, VERIFICATION } = require('../src/core/research/evidence/claimAnalyzer');
  const best = deriveConfidence({
    claim: { verificationStatus: VERIFICATION.STRONGLY_SUPPORTED, independentSourceCount: 99 },
    agg: { support: 1, contradiction: 0, net: 1 },
    sourceQuality: 1,
  });
  assert.ok(best < 1, `confidence reached ${best}`);
});

test('audit/accuracy: a single source can never produce a strongly-supported claim', () => {
  const { deriveStatus, VERIFICATION } = require('../src/core/research/evidence/claimAnalyzer');
  const status = deriveStatus({
    agg: { support: 1, contradiction: 0, net: 1 },
    independent: 1, independentAgainst: 0, hasConflict: false, supportingCount: 5,
  });
  assert.notEqual(status, VERIFICATION.STRONGLY_SUPPORTED);
});

test('audit/accuracy: an unresolved conflict overrides any amount of support', () => {
  const { deriveStatus, VERIFICATION } = require('../src/core/research/evidence/claimAnalyzer');
  assert.equal(deriveStatus({
    agg: { support: 1, contradiction: 0, net: 1 },
    independent: 9, independentAgainst: 1, hasConflict: true, supportingCount: 9,
  }), VERIFICATION.CONFLICTING);
});

test('audit/accuracy: the quality score is capped by its weakest pillar', () => {
  const { evaluate } = require('../src/core/research/quality/researchEvaluator');
  const { EvidenceStore } = require('../src/core/research/evidence/evidenceStore');
  const { createResearchTask } = require('../src/core/research/schemas/researchTask');
  const task = createResearchTask({ question: 'what is a widget' });
  task.classification = { needsResearch: true };
  task.queries = [];
  task.sources = [];
  const q = evaluate({ task, store: new EvidenceStore(), claims: [], citations: [], strategy: null });
  assert.ok(q.score <= 0.35, `an empty run scored ${q.score}`);
  assert.equal(q.passed, false, 'a run that established nothing must not pass');
});

// --- citation audit ----------------------------------------------------------

test('audit/citations: a citation is impossible without evidence and a source', () => {
  const { validateCitation } = require('../src/core/research/schemas/citation');
  assert.equal(validateCitation({ sourceId: 's', claimId: 'c' }).ok, false, 'no evidenceId was accepted');
  assert.equal(validateCitation({ evidenceId: 'e', claimId: 'c' }).ok, false, 'no sourceId was accepted');
  assert.equal(validateCitation({ evidenceId: 'e', sourceId: 's' }).ok, false, 'no claimId was accepted');
  assert.equal(validateCitation({ evidenceId: 'e', sourceId: 's', claimId: 'c' }).ok, true);
});

test('audit/citations: the validator checks the quote against the stored source text', () => {
  const src = fs.readFileSync(path.join(RESEARCH, 'citations', 'citationValidator.js'), 'utf8');
  // Three independent checks, each of which alone would catch a fabrication.
  assert.match(src, /quoteDigest !== evidence\.digest/);
  assert.match(src, /digestOf\(citation\.quote\) !== evidence\.digest/);
  assert.match(src, /haystack\.includes/);
});

// --- MCP audit ---------------------------------------------------------------

test('audit/mcp: no MCP call happens without a client, and none is invented', () => {
  const { createMcpSource } = require('../src/core/research/sources/mcpSource');
  const none = createMcpSource({});
  assert.equal(none.available(), false);
  assert.equal(none.inventory(), null);
  return assert.rejects(() => none.search({ query: { text: 'x' } }), /no MCP client/);
});

test('audit/mcp: an action-shaped MCP tool is discovered but never called speculatively', async () => {
  const { createMcpSource } = require('../src/core/research/sources/mcpSource');
  const src = createMcpSource({ client: {
    async listTools() {
      return [
        { name: 'browser_navigate', description: 'Drive the browser', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
        { name: 'sql_query', description: 'Run a database query', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      ];
    },
    async callTool() { throw new Error('should never be called'); },
  } });
  const found = await src.discover();
  for (const tool of found) {
    assert.equal(tool.queryable, false, `${tool.name} would be called speculatively`);
    assert.ok(tool.unusableReason, `${tool.name} gives no reason for being unused`);
  }
});

// --- skill integration audit --------------------------------------------------

test('audit/skills: every §22 skill name is present and points at a registered tool', () => {
  const { RESEARCH_SKILLS } = require('../src/core/research/tools');
  const expected = [
    'web-research', 'deep-research', 'academic-research', 'github-research',
    'documentation-research', 'file-research', 'source-verification',
    'citation-generation', 'fact-checking', 'comparison-research',
  ];
  assert.deepEqual(Object.keys(RESEARCH_SKILLS).sort(), [...expected].sort());
  const { createPlatform } = require('../src/core/index.js');
  const platform = createPlatform({ io: {} });
  try {
    for (const [name, skill] of Object.entries(RESEARCH_SKILLS)) {
      assert.ok(platform.tools.get(skill.tool), `${name} points at unregistered tool ${skill.tool}`);
      assert.ok(platform.tools.list().some((t) => t.capabilities.includes(skill.capability)),
        `no tool declares ${name}'s capability ${skill.capability}`);
    }
  } finally {
    platform.dispose();
  }
});

// --- cross-platform audit ------------------------------------------------------

test('audit/platform: nothing in research is OS-specific', () => {
  const bad = [];
  for (const { file, text } of sources) {
    const body = code(text);
    if (/process\.platform|['"]win32['"]|['"]darwin['"]/.test(body)) bad.push(`${file}: branches on the platform`);
    if (/[A-Z]:\\\\|\/usr\/|\/etc\/|\/var\/|\/tmp\//.test(body)) bad.push(`${file}: hardcodes an OS path`);
    if (/__dirname|process\.cwd\(\)/.test(body)) bad.push(`${file}: resolves against the process, not io`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('audit/platform: file research goes through the injected fs and the shared path guard', () => {
  const src = fs.readFileSync(path.join(RESEARCH, 'sources', 'fileSource.js'), 'utf8');
  assert.match(src, /requires an fs adapter/, 'fileSource does not require an injected fs');
  assert.ok(!/require\('node:fs/.test(src), 'fileSource imports fs directly');
  const barrel = fs.readFileSync(path.join(RESEARCH, 'index.js'), 'utf8');
  // The same guard the built-in filesystem tools use — research does not get a
  // second, more permissive way out of the workspace.
  assert.match(barrel, /assertWithin/);
  assert.match(barrel, /tools\/path-guard/);
});

test('audit/platform: a Windows-shaped path is handled like any other', async () => {
  const { createFileSource } = require('../src/core/research/sources/fileSource');
  const { normalizeQuery } = require('../src/core/research/schemas/researchQuery');
  const winPath = 'C:\\Users\\sam\\docs\\policy.md';
  const files = { [winPath]: 'The retention period for application logs is 90 days in production environments.' };
  const source = createFileSource({
    fs: {
      async readFile(p) { return files[p]; },
      async stat(p) { if (!(p in files)) throw new Error('ENOENT'); return { size: files[p].length, mtimeMs: Date.now() }; },
    },
  });
  const out = await source.search({ query: normalizeQuery({ text: 'retention period logs' }), files: [winPath] });
  assert.equal(out.length, 1);
  assert.equal(out[0].source.path, winPath);
});
