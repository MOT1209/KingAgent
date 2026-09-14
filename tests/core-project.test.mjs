// The project indexer is a lightweight metadata foundation, not a semantic
// index: these tests check it stays that way (a bounded, depth-limited walk
// that never touches node_modules) while still detecting the markers a task
// actually needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProjectIndexer, detectProject, detectRoot, projectIdFor, describeProject } = require('../src/core/project/index.js');

// A base every fixture resolves under. detectProject/detectRoot both call
// path.resolve() on whatever root they're given, and on Windows a bare
// POSIX-style literal like '/repo' resolves onto the *current* drive
// (C:\repo, D:\repo, ...) rather than staying '/repo' — so the fixture root
// has to be resolved once, here, and every fake-fs key and every test
// expectation built from the same resolved value, never from a hand-typed
// POSIX string compared against it.
const BASE = path.resolve(os.tmpdir(), 'ka-project-fixture');

// A tiny in-memory filesystem so detection is testable without touching disk.
// `tree` keys are POSIX-style paths *relative* to `root`; they are joined with
// `path.join` (platform separators, not hardcoded slashes) before becoming map
// keys, so the same fixture works whether the runtime is POSIX or Windows.
function fakeFs(root, tree) {
  const dirs = new Map(); // absolute dir -> Map<name, isDir>
  const files = new Map(); // absolute path -> content

  function abs(rel) {
    return rel === '' ? root : path.join(root, ...rel.split('/'));
  }

  for (const [rel, content] of Object.entries(tree)) {
    const full = abs(rel);
    if (content !== null) files.set(full, content);
    // Register this entry, and every ancestor up to `root`, in its parent's
    // directory listing so readdir() sees it regardless of how deep it is.
    let cur = full;
    while (cur !== root) {
      const parent = path.dirname(cur);
      if (!dirs.has(parent)) dirs.set(parent, new Map());
      const isDir = cur !== full || content === null;
      // A path already known to be a file is never overwritten into a dir by
      // a later ancestor registration (can't happen here, but keep it honest).
      if (!dirs.get(parent).has(path.basename(cur))) dirs.get(parent).set(path.basename(cur), isDir);
      cur = parent;
    }
  }

  return {
    async stat(p) {
      const norm = path.normalize(p);
      if (files.has(norm)) return { isDirectory: () => false };
      if (dirs.has(norm) || norm === root) return { isDirectory: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async readFile(p) {
      const norm = path.normalize(p);
      if (!files.has(norm)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(norm);
    },
    async readdir(p, { withFileTypes } = {}) {
      const norm = path.normalize(p);
      const entries = dirs.get(norm);
      if (!entries) return [];
      return [...entries.entries()].map(([name, isDir]) => (
        withFileTypes ? { name, isDirectory: () => isDir, isFile: () => !isDir } : name
      ));
    },
  };
}

test('detector: identifies a node project from package.json and reads its scripts', async () => {
  const root = path.join(BASE, 'repo-node');
  const fs = fakeFs(root, {
    'package.json': JSON.stringify({ name: 'demo', version: '2.0.0', scripts: { test: 'node --test' }, dependencies: { electron: '1.0.0' } }),
    '.git': null,
    'README.md': '# demo',
    'src': null,
  });
  const detection = await detectProject(fs, root);
  assert.equal(detection.type, 'node');
  assert.equal(detection.name, 'demo');
  assert.equal(detection.version, '2.0.0');
  assert.equal(detection.hasGit, true);
  assert.deepEqual(detection.scripts, ['test']);
  assert.ok(detection.frameworks.includes('electron'));
  assert.ok(detection.importantFiles.includes('package.json'));
  assert.ok(detection.sourceDirs.includes('src'));
});

test('detector: a directory with no markers detects as unknown, not an error', async () => {
  const root = path.join(BASE, 'repo-empty');
  const fs = fakeFs(root, { 'notes.txt': 'hi' });
  const detection = await detectProject(fs, root);
  assert.equal(detection.type, 'unknown');
  assert.deepEqual(detection.markers, []);
});

test('detector: detectRoot walks up to find the boundary, bounded by maxUp', async () => {
  const root = path.join(BASE, 'repo-walk');
  const fs = fakeFs(root, {
    '.git': null,
    'package.json': '{}',
    'deep/nested/dir/file.txt': 'x',
  });
  const found = await detectRoot(fs, path.join(root, 'deep', 'nested', 'dir'));
  assert.equal(found, root);
});

test('metadata: projectIdFor is stable for the same root and stable across detections', () => {
  assert.equal(projectIdFor('/repo'), projectIdFor('/repo'));
  assert.notEqual(projectIdFor('/repo'), projectIdFor('/other'));
});

test('describeProject reads as one line for a context packet', () => {
  const line = describeProject({ name: 'demo', type: 'node', packageManager: 'npm', hasGit: true });
  assert.equal(line, 'demo · node · npm · git');
});

// --- indexer -------------------------------------------------------------------

test('indexer: index() is bounded, depth-limited and skips node_modules', async () => {
  const root = path.join(BASE, 'repo-index');
  const fs = fakeFs(root, {
    'package.json': '{}',
    'src/a.js': 'x',
    'src/nested/deep/b.js': 'y', // beyond default depth 2
    'node_modules/pkg/index.js': 'z',
  });
  const indexer = new ProjectIndexer({ fs, options: { maxDepth: 2, maxEntries: 400 } });
  const indexed = await indexer.index(root);
  assert.ok(indexed.tree.some((e) => e.path === 'src'));
  assert.ok(indexed.tree.some((e) => e.path === 'src/a.js'));
  assert.ok(!indexed.tree.some((e) => e.path.startsWith('node_modules')), 'node_modules is never walked');
  assert.ok(!indexed.tree.some((e) => e.path === 'src/nested/deep/b.js'), 'depth is bounded');
});

test('indexer: results are cached until the TTL or force', async () => {
  const root = path.join(BASE, 'repo-cache');
  const fs = fakeFs(root, { 'package.json': '{}' });
  const indexer = new ProjectIndexer({ fs, options: { ttlMs: 100_000 } });
  const first = await indexer.detect(root);
  const second = await indexer.detect(root);
  assert.equal(first.detectedAt, second.detectedAt, 'served from cache, not re-detected');
  const forced = await indexer.detect(root, { force: true });
  assert.notEqual(forced, undefined);
});

test('indexer: importantFiles orders markers, docs, then source dirs', async () => {
  const root = path.join(BASE, 'repo-important');
  const fs = fakeFs(root, {
    'package.json': '{}',
    'README.md': '# r',
    'src': null,
  });
  const indexer = new ProjectIndexer({ fs });
  const meta = await indexer.detect(root);
  const important = indexer.importantFiles(meta);
  assert.deepEqual(important, ['package.json', 'README.md', 'src/']);
});

test('indexer: emits project.detected and project.indexed, correlated by projectId', async () => {
  const root = path.join(BASE, 'repo-events');
  const fs = fakeFs(root, { 'package.json': '{}' });
  const { EventBus, TYPES } = require('../src/core/events/event-bus.js');
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('project.')) seen.push(ev); });
  const indexer = new ProjectIndexer({ fs, bus });
  const indexed = await indexer.index(root);
  assert.ok(seen.some((e) => e.type === TYPES.PROJECT_DETECTED));
  assert.ok(seen.some((e) => e.type === TYPES.PROJECT_INDEXED));
  assert.ok(seen.every((e) => e.projectId === indexed.projectId));
});
