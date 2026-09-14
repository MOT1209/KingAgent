// The project indexer is a lightweight metadata foundation, not a semantic
// index: these tests check it stays that way (a bounded, depth-limited walk
// that never touches node_modules) while still detecting the markers a task
// actually needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProjectIndexer, detectProject, detectRoot, projectIdFor, describeProject } = require('../src/core/project/index.js');

// A tiny in-memory filesystem so detection is testable without touching disk.
function fakeFs(tree) {
  // tree: { '/root/package.json': '...', '/root/src': null (dir marker via trailing children) }
  const dirs = new Map(); // path -> [{name, isDir}]
  const files = new Map();
  for (const [p, content] of Object.entries(tree)) {
    if (content === null) continue;
    files.set(p, content);
  }
  // derive directory listings from paths
  for (const p of Object.keys(tree)) {
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i += 1) {
      const parent = cur || '/';
      cur = `${cur}/${parts[i]}`;
      if (!dirs.has(parent)) dirs.set(parent, new Map());
      const isLast = i === parts.length - 1;
      const isDir = !isLast || tree[p] === null;
      dirs.get(parent).set(parts[i], isDir);
    }
  }
  return {
    async stat(p) {
      const norm = p.replace(/\/$/, '');
      if (files.has(norm) || dirs.has(norm)) return { isDirectory: () => dirs.has(norm) && !files.has(norm) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async readFile(p) {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    async readdir(p, { withFileTypes } = {}) {
      const norm = p.replace(/\/$/, '') || '/';
      const entries = dirs.get(norm);
      if (!entries) return [];
      return [...entries.entries()].map(([name, isDir]) => (
        withFileTypes ? { name, isDirectory: () => isDir, isFile: () => !isDir } : name
      ));
    },
  };
}

test('detector: identifies a node project from package.json and reads its scripts', async () => {
  const fs = fakeFs({
    '/repo/package.json': JSON.stringify({ name: 'demo', version: '2.0.0', scripts: { test: 'node --test' }, dependencies: { electron: '1.0.0' } }),
    '/repo/.git': null,
    '/repo/README.md': '# demo',
    '/repo/src': null,
  });
  const detection = await detectProject(fs, '/repo');
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
  const fs = fakeFs({ '/empty/notes.txt': 'hi' });
  const detection = await detectProject(fs, '/empty');
  assert.equal(detection.type, 'unknown');
  assert.deepEqual(detection.markers, []);
});

test('detector: detectRoot walks up to find the boundary, bounded by maxUp', async () => {
  const fs = fakeFs({
    '/repo/.git': null,
    '/repo/package.json': '{}',
    '/repo/deep/nested/dir/file.txt': 'x',
  });
  const root = await detectRoot(fs, '/repo/deep/nested/dir');
  assert.equal(root, '/repo');
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
  const fs = fakeFs({
    '/repo/package.json': '{}',
    '/repo/src/a.js': 'x',
    '/repo/src/nested/deep/b.js': 'y', // beyond default depth 2
    '/repo/node_modules/pkg/index.js': 'z',
  });
  const indexer = new ProjectIndexer({ fs, options: { maxDepth: 2, maxEntries: 400 } });
  const indexed = await indexer.index('/repo');
  assert.ok(indexed.tree.some((e) => e.path === 'src'));
  assert.ok(indexed.tree.some((e) => e.path === 'src/a.js'));
  assert.ok(!indexed.tree.some((e) => e.path.startsWith('node_modules')), 'node_modules is never walked');
  assert.ok(!indexed.tree.some((e) => e.path === 'src/nested/deep/b.js'), 'depth is bounded');
});

test('indexer: results are cached until the TTL or force', async () => {
  const fs = fakeFs({ '/repo/package.json': '{}' });
  const indexer = new ProjectIndexer({ fs, options: { ttlMs: 100_000 } });
  const first = await indexer.detect('/repo');
  const second = await indexer.detect('/repo');
  assert.equal(first.detectedAt, second.detectedAt, 'served from cache, not re-detected');
  const forced = await indexer.detect('/repo', { force: true });
  assert.notEqual(forced, undefined);
});

test('indexer: importantFiles orders markers, docs, then source dirs', async () => {
  const fs = fakeFs({
    '/repo/package.json': '{}',
    '/repo/README.md': '# r',
    '/repo/src': null,
  });
  const indexer = new ProjectIndexer({ fs });
  const meta = await indexer.detect('/repo');
  const important = indexer.importantFiles(meta);
  assert.deepEqual(important, ['package.json', 'README.md', 'src/']);
});

test('indexer: emits project.detected and project.indexed, correlated by projectId', async () => {
  const fs = fakeFs({ '/repo/package.json': '{}' });
  const { EventBus, TYPES } = require('../src/core/events/event-bus.js');
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('project.')) seen.push(ev); });
  const indexer = new ProjectIndexer({ fs, bus });
  const indexed = await indexer.index('/repo');
  assert.ok(seen.some((e) => e.type === TYPES.PROJECT_DETECTED));
  assert.ok(seen.some((e) => e.type === TYPES.PROJECT_INDEXED));
  assert.ok(seen.every((e) => e.projectId === indexed.projectId));
});
