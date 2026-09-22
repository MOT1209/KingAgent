import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSettings, writeSettings, normalizeTheme, themeBackground, THEMES, DEFAULT_THEME, normalizeView, VIEWS, ENC_PREFIX } from '../src/main/settings.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nami-set-')), 'settings.json');
}

// An in-memory io that records every write, so we can assert on ordering.
function memIo() {
  const files = new Map();
  const writes = [];
  return {
    files, writes,
    read: (f) => { if (!files.has(f)) throw new Error('ENOENT'); return files.get(f); },
    exists: (f) => files.has(f),
    write: (f, t) => { writes.push({ file: f, text: t }); files.set(f, t); },
  };
}

test('readSettings returns {} for missing, empty, corrupt and non-object files', () => {
  const io = memIo();
  assert.deepEqual(readSettings({ file: '/nope.json', io }), {});
  io.files.set('/a.json', '');
  assert.deepEqual(readSettings({ file: '/a.json', io }), {});
  io.files.set('/b.json', '{ this is not json');
  assert.deepEqual(readSettings({ file: '/b.json', io }), {});
  io.files.set('/c.json', '["an","array"]');
  assert.deepEqual(readSettings({ file: '/c.json', io }), {});
});

test('writeSettings merges rather than clobbering sibling keys', () => {
  const file = tmpFile();
  writeSettings({ file, patch: { theme: 'operator' } });
  writeSettings({ file, patch: { aiModel: { baseUrl: 'http://x/v1', model: 'm' } } });
  writeSettings({ file, patch: { sttProvider: 'local', openaiKey: 'sk-test' } });
  // The theme write must have survived two later writers touching the same file.
  const doc = readSettings({ file });
  assert.equal(doc.theme, 'operator');
  assert.equal(doc.aiModel.model, 'm');
  assert.equal(doc.sttProvider, 'local');
  assert.equal(doc.openaiKey, 'sk-test');
});

test('a null value deletes the key — how the UI clears an API key', () => {
  const file = tmpFile();
  writeSettings({ file, patch: { openaiKey: 'sk-test', theme: 'paper' } });
  writeSettings({ file, patch: { openaiKey: null } });
  const doc = readSettings({ file });
  assert.equal('openaiKey' in doc, false);
  assert.equal(doc.theme, 'paper');
});

test('writes go through a tmp file and rename, never a partial settings.json', () => {
  const file = tmpFile();
  writeSettings({ file, patch: { theme: 'operator' } });
  // The real io renames, so no .tmp may be left lying around.
  assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.equal(fs.existsSync(file), true);
  // and the file it left behind must be valid JSON, not a truncated write
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'operator' });
});

test('a failing write reports {ok:false} instead of throwing', () => {
  const io = memIo();
  io.write = () => { throw new Error('disk full'); };
  const res = writeSettings({ file: '/x.json', patch: { theme: 'paper' }, io });
  assert.equal(res.ok, false);
  assert.match(res.error, /disk full/);
});

test('creates the parent directory on first write', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nami-set-')), 'deep', 'nested');
  const file = path.join(dir, 'settings.json');
  const res = writeSettings({ file, patch: { theme: 'paper' } });
  assert.equal(res.ok, true);
  assert.equal(readSettings({ file }).theme, 'paper');
});

// ---- secrets at rest ---------------------------------------------------------
// `crypt` stands in for Electron's safeStorage: a reversible, order-marked
// "encryption" so tests can tell a stored value was transformed without
// pulling in the real OS keychain.
function fakeCrypt({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('CIPHER(' + s + ')'),
    decryptString: (buf) => {
      const s = buf.toString();
      const m = /^CIPHER\((.*)\)$/.exec(s);
      if (!m) throw new Error('not our ciphertext');
      return m[1];
    },
  };
}

test('openaiKey, elevenKey, sttKey and every envKeys entry are encrypted on disk', () => {
  const file = tmpFile();
  const crypt = fakeCrypt();
  writeSettings({
    file, crypt,
    patch: { openaiKey: 'sk-a', elevenKey: 'el-b', sttKey: 'stt-c', envKeys: { FOO: 'bar', BAZ: 'qux' }, theme: 'paper' },
  });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const v of [onDisk.openaiKey, onDisk.elevenKey, onDisk.sttKey, onDisk.envKeys.FOO, onDisk.envKeys.BAZ]) {
    assert.ok(v.startsWith(ENC_PREFIX), `expected ${v} to be encrypted`);
    assert.doesNotMatch(v, /sk-a|el-b|stt-c|bar|qux/, 'plaintext must not appear on disk');
  }
  // A non-secret key stored beside them is untouched.
  assert.equal(onDisk.theme, 'paper');
  // readSettings, given the same crypt, hands back the original plain text —
  // every existing caller (stt.js, storedEnvKeys(), settings:get's masking)
  // keeps working unmodified.
  const doc = readSettings({ file, crypt });
  assert.deepEqual(
    [doc.openaiKey, doc.elevenKey, doc.sttKey, doc.envKeys.FOO, doc.envKeys.BAZ],
    ['sk-a', 'el-b', 'stt-c', 'bar', 'qux'],
  );
});

test('a settings.json an older KingAgent wrote in plain text still reads back plainly', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ openaiKey: 'sk-legacy', envKeys: { FOO: 'old' }, theme: 'dusk' }));
  const doc = readSettings({ file, crypt: fakeCrypt() });
  assert.equal(doc.openaiKey, 'sk-legacy');
  assert.equal(doc.envKeys.FOO, 'old');
  assert.equal(doc.theme, 'dusk');
});

test('without encryption available, secrets are stored and read as plain text (documented degrade)', () => {
  const file = tmpFile();
  const crypt = fakeCrypt({ available: false });
  writeSettings({ file, crypt, patch: { openaiKey: 'sk-a' } });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.openaiKey, 'sk-a');
  assert.equal(readSettings({ file, crypt }).openaiKey, 'sk-a');
});

test('an encrypted value read without a crypt (or a broken one) is returned opaque, never guessed at as plain text', () => {
  const file = tmpFile();
  writeSettings({ file, crypt: fakeCrypt(), patch: { openaiKey: 'sk-a' } });
  const doc = readSettings({ file }); // no crypt passed
  assert.notEqual(doc.openaiKey, 'sk-a');
  assert.ok(doc.openaiKey.startsWith(ENC_PREFIX));
});

test('callers that never pass crypt keep the exact old plain-text behavior', () => {
  const file = tmpFile();
  writeSettings({ file, patch: { openaiKey: 'sk-a', envKeys: { FOO: 'bar' } } });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.openaiKey, 'sk-a');
  assert.equal(onDisk.envKeys.FOO, 'bar');
});

// ---- themes -----------------------------------------------------------------
// theme:set and the window backgroundColor both go through these, so a stale or
// hand-edited settings.json can never produce an unknown theme or background.

test('normalizeTheme accepts all shipped themes', () => {
  for (const t of ['paper', 'operator', 'glass', 'graphite', 'soft', 'dusk']) assert.equal(normalizeTheme(t), t);
});

test('normalizeTheme falls back to the default for anything else', () => {
  // Asserted against the exported constant rather than a literal: a new install
  // and a corrupt settings.json must land on the same desk, and the day those
  // two disagree is the day someone changes one of them alone.
  for (const bad of ['neon', '', null, undefined, 42, 'GLASS']) assert.equal(normalizeTheme(bad), DEFAULT_THEME);
});

test('the default is a theme the app actually ships', () => {
  assert.ok(THEMES.includes(DEFAULT_THEME), `${DEFAULT_THEME} is not one of ${THEMES.join(', ')}`);
});

test('themeBackground maps every theme to its first-paint color', () => {
  assert.equal(themeBackground('paper'), '#cfc3ac');
  assert.equal(themeBackground('operator'), '#121212');
  assert.equal(themeBackground('glass'), '#e8e9ee');
  assert.equal(themeBackground('graphite'), '#26272c');
  assert.equal(themeBackground('soft'), '#e5e5e5');
  assert.equal(themeBackground('dusk'), '#262a31');
  // unknown themes paint the default, matching normalizeTheme
  assert.equal(themeBackground('neon'), themeBackground(DEFAULT_THEME));
});

test('normalizeView knows desk and split and falls back to the desk', () => {
  assert.deepEqual(VIEWS, ['desk', 'split']);
  assert.equal(normalizeView('split'), 'split');
  assert.equal(normalizeView('desk'), 'desk');
  for (const bad of ['', null, undefined, 'focus', 42]) assert.equal(normalizeView(bad), 'desk');
});
