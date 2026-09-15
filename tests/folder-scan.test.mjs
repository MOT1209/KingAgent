import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { p, posix, makeTempDir } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { homeShort, baseName, readFrontmatter, scanFolder, recentsForRenderer } = require('../src/main/folder-scan.js');

// --- the two string helpers -------------------------------------------------

test("a path under home is shown as '~', and one outside it is left alone", () => {
  assert.equal(homeShort('/Users/ana', '/Users/ana'), '~');
  assert.equal(homeShort('/Users/ana/proj', '/Users/ana'), posix('~/proj'));
  assert.equal(homeShort('/srv/www', '/Users/ana'), '/srv/www');
});

test('an empty or missing path is handed back untouched, not turned into a string', () => {
  assert.equal(homeShort(null, '/Users/ana'), null);
  assert.equal(homeShort('', '/Users/ana'), '');
  assert.equal(homeShort(undefined, '/Users/ana'), undefined);
});

test('the name is the last segment, and a trailing separator is not a name', () => {
  assert.equal(baseName('/Users/ana/proj'), 'proj');
  assert.equal(baseName('/Users/ana/proj/'), 'proj');
  assert.equal(baseName(p('C:/Users/ana/proj')), 'proj');
  assert.equal(baseName(p('C:\\Users\\ana\\proj\\')), 'proj');
  assert.equal(baseName(''), '');
  assert.equal(baseName(null), '');
});

// --- frontmatter ------------------------------------------------------------

test('name and description come out of an agent file, quotes and all', () => {
  const read = () => '---\nname: "Release Notes"\ndescription: \'Writes them\'\ntools: Read, Edit\n---\n# body\n';
  assert.deepEqual(readFrontmatter('x.md', read), {
    name: 'Release Notes', description: 'Writes them', tools: 'Read, Edit',
  });
});

test('a file with no frontmatter answers empty rather than guessing', () => {
  assert.deepEqual(readFrontmatter('x.md', () => '# just a heading\n'), {});
  assert.deepEqual(readFrontmatter('x.md', () => '---\nnot ended\n'), {});
});

test('an unreadable file is empty frontmatter, not a thrown error', () => {
  assert.deepEqual(readFrontmatter('nope.md', () => { throw new Error('ENOENT'); }), {});
});

test('only the head of the file is looked at, so a huge body is not read twice', () => {
  let read = 0;
  const body = '---\nname: Big\n---\n' + 'x'.repeat(200000);
  const meta = readFrontmatter('big.md', () => { read += 1; return body; });
  assert.equal(meta.name, 'Big');
  assert.equal(read, 1);
});

// --- scanFolder -------------------------------------------------------------

function fixture() {
  const tmp = makeTempDir('king-folder-scan-');
  const proj = path.join(tmp.root, 'proj');
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'release-notes'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'reviewer.md'),
    '---\nname: Reviewer\ndescription: Reviews diffs\ntools: Read\n---\n');
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'README.txt'), 'not an agent\n');
  fs.writeFileSync(path.join(proj, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: Release Notes\n---\n');
  fs.writeFileSync(path.join(proj, '.claude', 'skills', 'scratch', 'notes.txt'), 'no SKILL.md here\n');
  return { tmp, proj };
}

test('a folder describes its own agents and skills, and skips what only looks like them', () => {
  const { tmp, proj } = fixture();
  try {
    const info = scanFolder(proj, { home: tmp.root, tree: () => ['tree'] });
    assert.equal(info.hasClaude, true);
    assert.deepEqual(info.agents, [{ slug: 'reviewer', name: 'Reviewer', desc: 'Reviews diffs', tools: 'Read' }]);
    // a directory in skills/ with no SKILL.md is scratch, and README.txt is not an agent
    assert.deepEqual(info.skills, [{ slug: 'release-notes', name: 'Release Notes' }]);
    assert.deepEqual(info.tree, ['tree']);
  } finally { tmp.dispose(); }
});

test("the folder's own name and a shortened path come back with it", () => {
  const { tmp, proj } = fixture();
  try {
    const info = scanFolder(proj, { home: tmp.root, tree: () => [] });
    assert.equal(info.name, 'proj');
    // the home prefix becomes '~', whichever separator this platform joins with
    assert.equal(info.pathShort, '~' + proj.slice(tmp.root.length));
    assert.equal(info.path, proj);
  } finally { tmp.dispose(); }
});

test('a folder that is not there answers with an empty skeleton instead of throwing', () => {
  const tmp = makeTempDir('king-folder-gone-');
  try {
    const info = scanFolder(path.join(tmp.root, 'gone', 'missing'), { home: tmp.root, tree: () => [] });
    assert.equal(info.hasClaude, false);
    assert.deepEqual(info.agents, []);
    assert.deepEqual(info.skills, []);
    assert.equal(info.name, 'missing');
  } finally { tmp.dispose(); }
});

test('a folder with no .claude at all still opens', () => {
  const tmp = makeTempDir('king-folder-bare-');
  const proj = path.join(tmp.root, 'plain');
  fs.mkdirSync(proj);
  try {
    const info = scanFolder(proj, { home: tmp.root, tree: () => [] });
    assert.equal(info.hasClaude, false);
    assert.deepEqual(info.agents, []);
  } finally { tmp.dispose(); }
});

test('an agent file with no frontmatter still gets an entry, named after itself', () => {
  const tmp = makeTempDir('king-folder-nofm-');
  const proj = path.join(tmp.root, 'proj');
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'planner.md'), '# just prose\n');
  try {
    const info = scanFolder(proj, { home: tmp.root, tree: () => [] });
    assert.deepEqual(info.agents, [{ slug: 'planner', name: 'planner', desc: '', tools: '' }]);
  } finally { tmp.dispose(); }
});

// --- recentsForRenderer -----------------------------------------------------

test('a recents row carries the shortened path, the name and whether the folder is still there', () => {
  const out = recentsForRenderer(
    [{ path: '/Users/ana/proj', at: 5, pinned: false }],
    { home: '/Users/ana', exists: () => true },
  );
  assert.deepEqual(out, [{
    path: '/Users/ana/proj', pathShort: posix('~/proj'), name: 'proj', at: 5, pinned: false, missing: false,
  }]);
});

test('a folder that has gone is marked missing, which is what greys it out and drops it from the menu', () => {
  const out = recentsForRenderer([{ path: '/gone', at: 1 }], { home: '/Users/ana', exists: () => false });
  assert.equal(out[0].missing, true);
});

test('a pinned row sorts above a newer unpinned one', () => {
  const out = recentsForRenderer(
    [{ path: '/a', at: 900, pinned: false }, { path: '/b', at: 1, pinned: true }],
    { home: '/home', exists: () => true },
  );
  assert.deepEqual(out.map((r) => r.path), ['/b', '/a']);
});

// sortRecents subtracts Number(pinned) on both sides, and a row with no
// `pinned` at all makes that NaN — falsy, so the pin was ignored entirely and a
// pinned folder could land below a plain recent one.
test('a hand-written row with no pinned field still sorts as a pin when it is one', () => {
  const out = recentsForRenderer(
    [{ path: '/new', at: 900 }, { path: '/pin', at: 1, pinned: 1 }],
    { home: '/home', exists: () => true },
  );
  assert.deepEqual(out.map((r) => r.path), ['/pin', '/new']);
  assert.equal(out[0].pinned, true, 'and the field the renderer reads is a real boolean');
});

test('a state.json that lost its recents list renders an empty one, not a crash', () => {
  assert.deepEqual(recentsForRenderer(undefined), []);
  assert.deepEqual(recentsForRenderer(null), []);
  assert.deepEqual(recentsForRenderer({ nope: true }), []);
});
