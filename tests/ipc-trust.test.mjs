import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { allowedFile, bundleDirOk, installDirOk, httpHref } = require('../src/main/ipc-trust.js');
const { scanLibrary } = require('../src/main/library.js');

const H = path.resolve('/home/u'), P = path.resolve('/work/proj');
const at = (root, ...segs) => path.join(root, ...segs);
const ok = (file, projectPath = P) => allowedFile({ file, projectPath, homeDir: H });

test('files inside the window folder are editable', () => {
  assert.equal(ok(at(P, 'README.md')), at(P, 'README.md'));
  assert.equal(ok(at(P, 'src', 'a.js')), at(P, 'src', 'a.js'));
});

test('a sibling that only shares a prefix is not inside the folder', () => {
  assert.equal(ok(path.resolve('/work/proj-evil/x.md')), null);
});

test('.. cannot climb out of the folder', () => {
  assert.equal(ok(P + path.sep + '..' + path.sep + 'other' + path.sep + 'x.md'), null);
});

test('secrets under $HOME are refused', () => {
  assert.equal(ok(at(H, '.ssh', 'id_rsa')), null);
  assert.equal(ok(at(H, '.zshrc')), null);
  assert.equal(ok(at(H, 'Documents', 'taxes.txt')), null);
});

test('user-scope skills, agents and plugin files are editable', () => {
  assert.ok(ok(at(H, '.claude', 'skills', 'x', 'SKILL.md')));
  assert.ok(ok(at(H, '.agents', 'skills', 'x', 'SKILL.md')));
  assert.ok(ok(at(H, '.claude', 'agents', 'r.md')));
  assert.ok(ok(at(H, '.claude', 'plugins', 'cache', 'm', 'p', '1', 'skills', 's', 'SKILL.md')));
  assert.ok(ok(at(H, '.config', 'opencode', 'agent', 'a.md')));
});

test("each agent's settings file is editable, and a home-level one only as that file", () => {
  assert.ok(ok(at(H, '.claude.json')));
  assert.ok(ok(at(H, '.codex', 'config.toml')));
  assert.ok(ok(at(H, '.kimi-code', 'config.toml')));
  assert.equal(ok(at(H, '.claude.json.bak')), null);
  assert.equal(ok(at(H, 'notes.md')), null);
});

test('with no folder open, the project rule allows nothing', () => {
  assert.equal(ok(at(P, 'README.md'), null), null);
  assert.ok(ok(at(H, '.claude', 'skills', 'x', 'SKILL.md'), null));
});

test('relative paths and non-strings are refused', () => {
  assert.equal(ok('README.md'), null);
  assert.equal(ok(''), null);
  assert.equal(ok(undefined), null);
  assert.equal(ok({ toString: () => at(P, 'a') }), null);
});

test('every file the Library lists can be opened in the editor', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-trust-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-trust-proj-'));
  try {
    const write = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    const skill = (name) => `---\nname: ${name}\ndescription: d\n---\nbody\n`;
    write(at(home, '.claude', 'skills', 'u1', 'SKILL.md'), skill('u1'));
    write(at(home, '.agents', 'skills', 'u2', 'SKILL.md'), skill('u2'));
    write(at(home, '.claude', 'agents', 'ag.md'), '---\nname: ag\ndescription: d\n---\n');
    write(at(home, '.codex', 'agents', 'cx.toml'), 'name = "cx"\n');
    write(at(home, '.config', 'opencode', 'command', 'c.md'), '---\ndescription: d\n---\n');
    write(at(proj, '.claude', 'skills', 'p1', 'SKILL.md'), skill('p1'));
    write(at(proj, 'skills', 'p2', 'SKILL.md'), skill('p2'));
    write(at(proj, '.claude', 'agents', 'pa.md'), '---\nname: pa\ndescription: d\n---\n');
    const items = scanLibrary({ projectPath: proj, homeDir: home });
    assert.ok(items.length >= 6, 'the fixture is actually scanned');
    for (const it of items) {
      if (!it.filePath) continue;
      assert.ok(allowedFile({ file: it.filePath, projectPath: proj, homeDir: home }), it.filePath + ' must stay editable');
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('a bundle folder must be one pickBundle settled under ~/.kingagent/bundles', () => {
  const root = at(H, '.kingagent', 'bundles');
  assert.equal(bundleDirOk(at(root, 'acme-1.0.0'), H), at(root, 'acme-1.0.0'));
  assert.equal(bundleDirOk(at(root, '.unpacking-123'), H), null);
  assert.equal(bundleDirOk(root, H), null);
  assert.equal(bundleDirOk(at(root, 'acme', 'nested'), H), null);
  assert.equal(bundleDirOk(at(root, '..', 'x'), H), null);
  assert.equal(bundleDirOk(path.resolve('/tmp/evil'), H), null);
  assert.equal(bundleDirOk('acme-1.0.0', H), null);
});

test('an install folder must be a built checkout under ~/.kingagent/connectors', () => {
  const dir = at(H, '.kingagent', 'connectors', 'kie-mcp');
  const exists = (p) => p === at(dir, 'dist', 'index.js');
  assert.equal(installDirOk('~/.kingagent/connectors/kie-mcp', H, exists), dir);
  assert.equal(installDirOk(dir, H, exists), dir);
  assert.equal(installDirOk(at(H, '.kingagent', 'connectors', 'other'), H, exists), null, 'not built');
  assert.equal(installDirOk(path.resolve('/tmp/kie-mcp'), H, () => true), null);
  assert.equal(installDirOk(at(H, 'Documents'), H, () => true), null);
  assert.equal(installDirOk('kie-mcp', H, () => true), null);
  assert.equal(installDirOk(undefined, H, () => true), null);
});

test('links are parsed and re-serialised, and only web schemes pass', () => {
  assert.equal(httpHref('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(httpHref('  http://localhost:3000  '), 'http://localhost:3000/');
  assert.equal(httpHref('http://localhost:3000', { httpsOnly: true }), null);
  assert.equal(httpHref('https://x.test/\r\nfile:///etc/passwd'), 'https://x.test/file:///etc/passwd');
  assert.equal(httpHref('file:///etc/passwd'), null);
  assert.equal(httpHref('javascript:alert(1)'), null);
  assert.equal(httpHref('ms-msdt:/id'), null);
  assert.equal(httpHref('not a url'), null);
  assert.equal(httpHref(undefined), null);
});
