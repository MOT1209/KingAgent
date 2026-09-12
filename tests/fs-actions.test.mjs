import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { newFile, newFolder, movePath, trashPath, renamePath, importPaths, isDescendant, duplicatePath } =
  require('../src/main/fs-actions.js');

// The root resolves through the platform's real path rules — the same rules
// fs-actions applies — so fixtures and expected results land on the same drive
// and separator dialect all on their own.
const ROOT = path.resolve('/proj');
const P = (...segs) => path.join(ROOT, ...segs);
function fakeOps(existing = []) {
  const calls = { writes: [], mkdirs: [], renames: [], copies: [] };
  return {
    calls,
    exists: (p) => existing.includes(p),
    mkdir: (p) => calls.mkdirs.push(p),
    writeFile: (p) => calls.writes.push(p),
    rename: (a, b) => calls.renames.push([a, b]),
    cp: async (a, b) => { calls.copies.push([a, b]); },
  };
}

test('newFile creates inside the root and refuses outside or existing', () => {
  const ops = fakeOps([P('docs', 'dup.md')]);
  assert.equal(newFile({ root: ROOT, dir: '/proj/docs', name: 'a.md', ops }).ok, true);
  assert.deepEqual(ops.calls.writes, [P('docs', 'a.md')]);
  assert.equal(newFile({ root: ROOT, dir: '/etc', name: 'a.md', ops }).ok, false);
  assert.equal(newFile({ root: ROOT, dir: '/proj/docs', name: 'dup.md', ops }).ok, false);
  assert.equal(newFile({ root: ROOT, dir: '/proj/docs', name: '../evil.md', ops }).ok, false);
});

test('newFolder mirrors the same guards', () => {
  const ops = fakeOps();
  assert.equal(newFolder({ root: ROOT, dir: '/proj', name: 'notes', ops }).ok, true);
  assert.deepEqual(ops.calls.mkdirs, [P('notes')]);
  assert.equal(newFolder({ root: ROOT, dir: '/outside', name: 'x', ops }).ok, false);
});

test('movePath moves within the root, refusing collisions and escapes', () => {
  const ops = fakeOps([P('a.md'), P('docs', 'a.md')]);
  const hit = movePath({ root: ROOT, src: '/proj/a.md', destDir: '/proj/docs', ops });
  assert.equal(hit.ok, false);
  const ok = movePath({ root: ROOT, src: '/proj/a.md', destDir: '/proj/sub', ops });
  assert.deepEqual(ok, { ok: true, path: P('sub', 'a.md') });
  assert.deepEqual(ops.calls.renames, [[P('a.md'), P('sub', 'a.md')]]);
  assert.equal(movePath({ root: ROOT, src: '/proj/a.md', destDir: '/tmp', ops }).ok, false);
  assert.equal(movePath({ root: ROOT, src: '/etc/passwd', destDir: '/proj', ops }).ok, false);
});

test('trashPath trashes inside the root only, never the root itself', async () => {
  const trashed = [];
  const ops = fakeOps([P('old.md')]);
  const trashFn = (p) => { trashed.push(p); return Promise.resolve(); };
  const ok = await trashPath({ root: ROOT, path: '/proj/old.md', trashFn, ops });
  assert.deepEqual(ok, { ok: true, path: P('old.md') });
  assert.deepEqual(trashed, [P('old.md')]);
  assert.equal((await trashPath({ root: ROOT, path: ROOT, trashFn, ops })).ok, false);
  assert.equal((await trashPath({ root: ROOT, path: '/etc/passwd', trashFn, ops })).ok, false);
  assert.equal((await trashPath({ root: ROOT, path: '/proj/gone.md', trashFn, ops })).ok, false);
});

// ---- rename ----------------------------------------------------------------

test('renamePath renames in place, refusing escapes, collisions and the root', () => {
  const ops = fakeOps([P('a.md'), P('taken.md'), P('docs')]);
  const ok = renamePath({ root: ROOT, src: '/proj/a.md', name: 'b.md', ops });
  assert.deepEqual(ok, { ok: true, path: P('b.md') });
  assert.deepEqual(ops.calls.renames, [[P('a.md'), P('b.md')]]);

  assert.equal(renamePath({ root: ROOT, src: '/proj/a.md', name: 'taken.md', ops }).ok, false);
  assert.equal(renamePath({ root: ROOT, src: '/etc/passwd', name: 'x', ops }).ok, false);
  assert.equal(renamePath({ root: ROOT, src: '/proj/a.md', name: 'sub/b.md', ops }).ok, false);
  assert.equal(renamePath({ root: ROOT, src: '/proj/a.md', name: '', ops }).ok, false);
  // the root is the open folder itself — renaming it would move the project
  assert.equal(renamePath({ root: ROOT, src: ROOT, name: 'other', ops }).ok, false);
});

test('renaming to the same name is a no-op, not an "already exists" error', () => {
  const ops = fakeOps(['/proj/a.md']);
  const res = renamePath({ root: ROOT, src: '/proj/a.md', name: 'a.md', ops });
  assert.equal(res.ok, true);
  assert.deepEqual(ops.calls.renames, [], 'nothing was renamed');
});

// ---- descendant guard -------------------------------------------------------

test('isDescendant catches the self-and-below cases a prefix test would miss', () => {
  assert.equal(isDescendant('/proj/src', '/proj/src'), true);
  assert.equal(isDescendant('/proj/src', '/proj/src/main'), true);
  assert.equal(isDescendant('/proj/src', '/proj/srcXtra'), false, 'sibling sharing a prefix');
  assert.equal(isDescendant('/proj/src', '/proj'), false);
});

test('movePath refuses to move a folder inside itself', () => {
  const ops = fakeOps(['/proj/src', '/proj/src/main']);
  assert.equal(movePath({ root: ROOT, src: '/proj/src', destDir: '/proj/src/main', ops }).ok, false);
  assert.equal(movePath({ root: ROOT, src: '/proj/src', destDir: '/proj/src', ops }).ok, true, 'same place is a no-op');
  assert.deepEqual(ops.calls.renames, [], 'neither case touched the disk');
});

// ---- import from outside the root -------------------------------------------

test('importPaths copies in, never moves, and only into the root', async () => {
  const ops = fakeOps([]);
  const res = await importPaths({ root: ROOT, destDir: '/proj/docs', srcPaths: ['/Users/me/shot.png'], ops });
  assert.equal(res.ok, true);
  assert.deepEqual(res.paths, [P('docs', 'shot.png')]);
  assert.deepEqual(ops.calls.copies, [['/Users/me/shot.png', P('docs', 'shot.png')]]);
  assert.deepEqual(ops.calls.renames, [], 'a source outside the root is never moved');

  const out = await importPaths({ root: ROOT, destDir: '/etc', srcPaths: ['/Users/me/x.png'], ops });
  assert.equal(out.ok, false);
});

test('importing a name that is taken yields -copy rather than an error', async () => {
  const ops = fakeOps([P('shot.png'), P('shot-copy.png')]);
  const res = await importPaths({ root: ROOT, destDir: ROOT, srcPaths: ['/Users/me/shot.png'], ops });
  assert.equal(res.ok, true);
  assert.deepEqual(res.paths, [P('shot-copy-1.png')]);
});

test('importPaths reports a failed copy instead of claiming success', async () => {
  const ops = fakeOps([]);
  ops.cp = async () => { throw new Error('EACCES'); };
  const res = await importPaths({ root: ROOT, destDir: ROOT, srcPaths: ['/Users/me/x.png'], ops });
  assert.equal(res.ok, false);
  assert.match(res.error, /EACCES/);
});

test('importPaths with nothing to import is a no-op, not a crash', async () => {
  const ops = fakeOps([]);
  const res = await importPaths({ root: ROOT, destDir: ROOT, srcPaths: [], ops });
  assert.equal(res.ok, false);
});

// ---- duplicate ---------------------------------------------------------------

test('duplicatePath names the copy beside the original, inside the root only', async () => {
  const ops = fakeOps([P('app.js')]);
  const res = await duplicatePath({ root: ROOT, src: '/proj/app.js', ops });
  assert.equal(res.ok, true);
  assert.equal(res.path, P('app-copy.js'));
  assert.deepEqual(ops.calls.copies, [[P('app.js'), P('app-copy.js')]]);

  assert.equal((await duplicatePath({ root: ROOT, src: '/etc/passwd', ops })).ok, false);
  assert.equal((await duplicatePath({ root: ROOT, src: ROOT, ops })).ok, false);
});

test('duplicating a dotfile keeps the leading dot out of the suffix', async () => {
  const ops = fakeOps([P('.env')]);
  const res = await duplicatePath({ root: ROOT, src: '/proj/.env', ops });
  assert.equal(res.path, P('.env-copy'));
});
