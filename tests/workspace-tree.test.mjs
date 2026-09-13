import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { listDirectory, readTree } = require('../src/main/workspace-tree.js');

// Windows only lets a session create symlinks with Developer Mode or an
// elevated shell. Whether they exist changes what the two link tests prove, so
// the probe happens here, at module scope: test options are evaluated when the
// test is registered, so a probe inside `before` is always too late and the
// skip flag would never be honest.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nami-workspace-tree-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const skill = path.join(base, 'skill-target');
const file = path.join(base, 'file-target.md');
const root = path.join(base, 'workspace');
fs.mkdirSync(root);
fs.mkdirSync(skill);
fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Skill\n');
fs.writeFileSync(file, '# File\n');
fs.writeFileSync(path.join(root, 'ordinary.txt'), 'ordinary\n');
let symlinks = true;
try {
  fs.symlinkSync(skill, path.join(root, 'linked-skill'));
  fs.symlinkSync(file, path.join(root, 'linked-file.md'));
  fs.symlinkSync(path.join(base, 'missing'), path.join(root, 'broken-link'));
} catch {
  // sessions without symlink privilege still exercise everything else
  symlinks = false;
}

test('directory listing treats a live link to a directory as a folder', { skip: !symlinks && 'session cannot create symlinks' }, () => {
  const rows = listDirectory(root, true);

  assert.deepEqual(rows.map(({ name, kind }) => ({ name, kind })), [
    { name: 'linked-skill', kind: 'dir' },
    { name: 'broken-link', kind: 'file' },
    { name: 'linked-file.md', kind: 'file' },
    { name: 'ordinary.txt', kind: 'file' },
  ]);
  assert.equal(rows[0].meta, '1 item');
  assert.equal(rows[1].meta, '');
  assert.equal(rows[2].meta, '7 B');
});

test('initial shallow tree expands through a linked directory', { skip: !symlinks && 'session cannot create symlinks' }, () => {
  const rows = readTree(root, 0, 2);
  const linked = rows.findIndex((row) => row.name === 'linked-skill');

  assert.notEqual(linked, -1);
  assert.deepEqual(rows.slice(linked, linked + 2), [
    { name: 'linked-skill', kind: 'dir', pad: 0, meta: '1 item' },
    { name: 'SKILL.md', kind: 'file', pad: 1, meta: '8 B' },
  ]);
});