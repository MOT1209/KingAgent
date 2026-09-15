// Phase 5 §33/§34: every packaging entry point must ship the Whisper weights.
//
// The app transcribes on-device with whisper-tiny.en, shipped via
// electron-builder's `extraResources` from `build/models`, which
// `npm run fetch-model` populates. Nothing fails loudly when that directory is
// empty: electron-builder copies nothing, the installer is built, and the app
// quietly downloads the weights on first launch — which is precisely what the
// local engine exists to avoid, and what §34 asks us to verify.
//
// npm runs `pre<name>` for the *exact* script name only, so `prepack` covers
// `pack` and nothing else. Before Phase 5 `dist:win`, `pack:win` and `pack:mac`
// had neither a hook nor an inline call. package.json's own comment records
// this trap being hit once before, for `dist`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Any script that invokes electron-builder produces something installable.
const packagingScripts = Object.entries(pkg.scripts)
  .filter(([name, body]) => !name.startsWith('//') && !name.startsWith('pre') && !name.startsWith('post')
    && /electron-builder/.test(body))
  .map(([name]) => name);

test('every packaging script fetches the model, by hook or inline', () => {
  assert.ok(packagingScripts.length >= 4, `expected several packaging scripts, found ${packagingScripts.join(', ')}`);

  const missing = packagingScripts.filter((name) => {
    const hook = pkg.scripts[`pre${name}`];
    const hookFetches = typeof hook === 'string' && /fetch-model/.test(hook);
    const inlineFetches = /fetch-model/.test(pkg.scripts[name]);
    return !hookFetches && !inlineFetches;
  });

  assert.deepEqual(missing, [], `these build an installer with no Whisper weights: ${missing.join(', ')}`);
});

test('the review build is the one deliberate exception, and it still fetches', () => {
  // pack:review uses its own config; it is a reviewer artifact, not a release,
  // but it carries prepack:review so it behaves like the rest.
  assert.match(pkg.scripts['prepack:review'] || '', /fetch-model/);
});

test('extraResources still carries build/models into the bundle', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  // The hooks above are pointless if the packager stops copying the directory.
  assert.match(yml, /extraResources:/);
  assert.match(yml, /from:\s*build\/models/, 'build/models must reach the bundle');
  assert.match(yml, /to:\s*models/, 'and land where main.js looks for it');
});

test('the Windows CI pack populates build/models before packaging', () => {
  // The cache step alone is not enough: a cache only restores what some earlier
  // run wrote, and nothing writes it if no step fetches. A green Windows job
  // that produced a model-less build is the failure this guards.
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const packIndex = ci.indexOf('npm run pack:win');
  assert.notEqual(packIndex, -1, 'ci.yml should still pack a Windows build');

  const before = ci.slice(0, packIndex);
  const fetches = /npm run fetch-model/.test(before);
  const hooked = /fetch-model/.test(pkg.scripts['prepack:win'] || '');
  assert.ok(fetches || hooked,
    'the Windows CI job must fetch the model — via an explicit step or the prepack:win hook — before packing');
});
