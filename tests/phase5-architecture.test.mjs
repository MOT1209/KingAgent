// Phase 5 §3-§6: the architecture invariants, as tests rather than prose.
//
// Phase 3 and Phase 4 were built independently and reconciled. The cost was a
// set of copied modules: `src/core/orchestrator/{coordinator,handoff,locks,
// messages}.js` were byte-identical twins of the harness-orchestrator files,
// and `src/core/artifacts/artifacts.js` was a byte-identical twin of
// `harness-orchestrator/artifacts.js`. None of them was reachable, and the
// orchestrator copy of the coordinator was worse than dead: it destructured six
// symbols (`containment` — the "a child may not out-reach its parent" check —
// among them) from a sibling `delegation.js` that does not export any of them,
// so every one of them was `undefined` at require time.
//
// These tests exist so that island cannot grow back unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'src', 'core');

function coreFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  })(CORE);
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

test('no two core modules are byte-identical copies of each other', () => {
  const byContent = new Map();
  for (const file of coreFiles()) {
    const body = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
    // A barrel that only re-exports is small and may legitimately coincide.
    if (body.length < 400) continue;
    if (!byContent.has(body)) byContent.set(body, []);
    byContent.get(body).push(rel(file));
  }
  const clones = [...byContent.values()].filter((group) => group.length > 1);
  assert.deepEqual(clones, [], `duplicated module bodies:\n${clones.map((g) => '  ' + g.join(' == ')).join('\n')}`);
});

test('every symbol a core module destructures from a sibling is actually exported there', () => {
  const problems = [];
  for (const file of coreFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    // `const { a, b } = require('./sibling');` — relative requires only.
    const re = /const\s*\{([^}]*)\}\s*=\s*require\(\s*'(\.[^']*)'\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const names = m[1]
        .split(',')
        .map((n) => n.split(':')[0].trim())
        .filter((n) => n && /^[A-Za-z_$][\w$]*$/.test(n));
      let target;
      try {
        target = require(path.resolve(path.dirname(file), m[2]));
      } catch {
        continue; // an unresolvable path is a different test's problem
      }
      for (const name of names) {
        if (!(name in target)) problems.push(`${rel(file)} destructures "${name}" from ${m[2]}, which does not export it`);
      }
    }
  }
  assert.deepEqual(problems, [], `dangling imports:\n  ${problems.join('\n  ')}`);
});

test('the orchestrator package holds no unreachable modules', () => {
  // Everything under src/core/orchestrator must be reachable from its own
  // barrel. A file that nothing can reach is the shape the dead coordinator
  // island had, and it is how a broken copy survives a test suite.
  const seen = new Set();
  const orig = Module._load;
  Module._load = function patched(request, parent, isMain) {
    const loaded = orig.apply(this, arguments);
    try { seen.add(Module._resolveFilename(request, parent, isMain)); } catch { /* builtin */ }
    return loaded;
  };
  try {
    require(path.join(CORE, 'orchestrator', 'index.js'));
  } finally {
    Module._load = orig;
  }

  const pkg = path.join(CORE, 'orchestrator');
  const files = coreFiles().filter((f) => f.startsWith(pkg + path.sep));
  const unreachable = files
    .filter((f) => path.basename(f) !== 'index.js')
    .filter((f) => !seen.has(f))
    .map(rel);
  assert.deepEqual(unreachable, [], `unreachable orchestrator modules: ${unreachable.join(', ')}`);
});

test('one public orchestration entry point, with the harness layer beneath it', () => {
  const { createPlatform } = require('../src/core/index.js');
  const platform = createPlatform({});

  // §4: `platform.orchestrator` is the public control plane.
  assert.equal(typeof platform.orchestrator.handle, 'function', 'the public orchestrator handles requests');
  assert.equal(typeof platform.orchestrator.route, 'function');
  assert.equal(typeof platform.orchestrator.cancel, 'function');

  // §5: the two coordinators sit at different levels and neither is the other.
  //
  //   AgentCoordinator      runs a delegated sub-task through the AgentRuntime:
  //                         agent selection, lifecycles, aggregation.
  //   HarnessCoordinator    owns the delegation *record* and the execution
  //                         backend behind it: harness runs, file locks,
  //                         sandboxes, and the control view the UI reads.
  //
  // Both expose `delegate`, and that is the seam to watch — so the test pins
  // what only one of them can do, not just that both exist.
  assert.notEqual(platform.coordinator, platform.harnessCoordinator);
  for (const only of ['selectAgent', 'selectAgents', 'lifecycle', 'aggregate']) {
    assert.equal(typeof platform.coordinator[only], 'function', `AgentCoordinator owns ${only}`);
    assert.equal(platform.harnessCoordinator[only], undefined, `HarnessCoordinator must not duplicate ${only}`);
  }
  for (const only of ['controlView', 'runParallel', 'buildReview', 'cancelTask', 'tree']) {
    assert.equal(typeof platform.harnessCoordinator[only], 'function', `HarnessCoordinator owns ${only}`);
    assert.equal(platform.coordinator[only], undefined, `AgentCoordinator must not duplicate ${only}`);
  }

  // There is no third orchestrator hiding on the platform.
  const orchestrators = Object.keys(platform).filter((k) => /orchestrator/i.test(k));
  assert.deepEqual(orchestrators.sort(), ['harnessOrchestrator', 'orchestrator']);
});

test('the renderer sees one Artifact shape whichever store produced it', () => {
  const { artifactView } = require('../src/main/agent-platform.js');

  // A workspace-owned artifact (ArtifactManager) and a harness artifact carry
  // different native fields. §6: after the view they are the same model.
  const workspaceOwned = artifactView({
    id: 'a1', type: 'diff', name: 'change.diff', path: '/ws/change.diff',
    bytes: 12, digest: 'sha', taskId: 't1', workspaceId: 'w1', agentId: 'ag1',
    createdAt: 1, updatedAt: 2,
  });
  const harnessOwned = artifactView({
    id: 'a2', type: 'report', name: 'tests.txt', ref: null, size: 30, truncated: false,
    taskId: 't1', workspaceId: 'w1', agentId: 'ag1', harnessId: 'claude-code',
    sessionId: 's1', traceId: 'tr1', delegationId: null, createdAt: 3,
  });

  assert.deepEqual(Object.keys(workspaceOwned).sort(), Object.keys(harnessOwned).sort(),
    'both stores must produce the same key set');

  for (const field of ['taskId', 'workspaceId', 'agentId', 'harnessId', 'sessionId', 'traceId', 'delegationId']) {
    assert.ok(field in workspaceOwned, `${field} is part of the one model`);
    assert.ok(field in harnessOwned, `${field} is part of the one model`);
  }
  // Absent provenance is null, never missing — a UI can render it unconditionally.
  assert.equal(workspaceOwned.harnessId, null);
  assert.equal(workspaceOwned.storage.bytes, 12);
  assert.equal(harnessOwned.storage.bytes, 30, 'size and bytes reach the UI as one field');

  // Content stays out of a list view on both paths.
  assert.equal(Object.hasOwn(workspaceOwned, 'content'), false);
  assert.equal(Object.hasOwn(harnessOwned, 'content'), false);
  assert.equal(artifactView({ id: 'a3', content: 'x' }, { includeContent: true }).content, 'x');
});

test('no IPC handler fabricates a result it did not obtain', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'agent-platform.js'), 'utf8');
  // The two literals Phase 5 removed. Either one reappearing means a handler is
  // answering from a constant again instead of from the subsystem underneath.
  assert.doesNotMatch(src, /handle\('workflow:cancel',\s*\(\{\s*id\s*\}\)\s*=>\s*\(\{\s*cancelled:\s*true/,
    'workflow:cancel must report what the engine actually did');
  assert.doesNotMatch(src, /handle\('workflow:listInstances',\s*\(\)\s*=>\s*\[\]\)/,
    'workflow:listInstances must read the engine instance table');
});
