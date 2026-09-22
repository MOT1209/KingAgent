// One JSON file holds everything the app remembers about *how it behaves* —
// theme, the any-model config, transcription provider + keys. Several writers
// touch it (theme:set, ai:config:set, settings:set) and more than one window can
// be open, so every write is read-merge-rename: never clobber a sibling key, and
// never leave a half-written file behind if we die mid-save.
// The path is passed in rather than imported from electron so tests can load this.
const fs = require('fs');
const path = require('path');

const fsIo = {
  read: (f) => fs.readFileSync(f, 'utf8'),
  exists: (f) => fs.existsSync(f),
  write: (f, t) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 600: the file can hold API keys (envKeys) — owner-only, like ~/.ssh config
    fs.writeFileSync(f + '.tmp', t, { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
  },
};

// Secrets at rest: settings.json is the one file that holds API keys (the
// top-level provider keys below, and every name in envKeys), and it used to
// hold them as plain text — mode 0o600 is owner-only on POSIX but is not a
// real access control on Windows, and either way it does nothing once the
// file leaves the machine (a backup, a synced folder, a stolen laptop with
// disk encryption off). `crypt` is Electron's `safeStorage` — OS-keychain
// backed on macOS/Windows, libsecret-backed on Linux where a keyring is
// present — injected by main.js so this module stays loadable, and testable
// with a fake, outside Electron. A value is only ever encrypted if `crypt`
// reports encryption available; otherwise it is stored as before, which is
// also what happens to an already-encrypted install on a Linux box with no
// keyring: a documented, honest degrade, not a silent one.
const SECRET_KEYS = ['openaiKey', 'elevenKey', 'sttKey'];
const ENC_PREFIX = 'enc:v1:';

function encryptOne(v, crypt) {
  if (typeof v !== 'string' || !v) return v;
  if (!crypt || typeof crypt.isEncryptionAvailable !== 'function' || !crypt.isEncryptionAvailable()) return v;
  try { return ENC_PREFIX + crypt.encryptString(v).toString('base64'); } catch (_) { return v; }
}
function decryptOne(v, crypt) {
  if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) return v;
  if (!crypt || typeof crypt.decryptString !== 'function') return v; // can't decrypt yet; never leak plaintext by guessing
  try { return crypt.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64')); } catch (_) { return v; }
}
// envKeys is a name -> secret map (see main.js's keys:* handlers); every
// value in it is a secret too, not just the three named fields above.
function mapSecrets(doc, fn, crypt) {
  const out = { ...doc };
  for (const k of SECRET_KEYS) if (k in out) out[k] = fn(out[k], crypt);
  if (out.envKeys && typeof out.envKeys === 'object' && !Array.isArray(out.envKeys)) {
    const next = {};
    for (const [name, v] of Object.entries(out.envKeys)) next[name] = fn(v, crypt);
    out.envKeys = next;
  }
  return out;
}
const decryptSecrets = (doc, crypt) => mapSecrets(doc, decryptOne, crypt);
const encryptSecrets = (doc, crypt) => mapSecrets(doc, encryptOne, crypt);

// `crypt` is optional throughout: every existing caller (tests included) that
// does not pass one gets exactly the old plain-text behavior, forwards- and
// backwards-compatible with a settings.json an older KingAgent wrote.
function readSettings({ file, io = fsIo, crypt = null }) {
  if (!io.exists(file)) return {};
  try {
    const doc = JSON.parse(io.read(file));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? decryptSecrets(doc, crypt) : {};
  } catch (_) {
    // A corrupt file must not brick the app; it gets replaced on the next write.
    return {};
  }
}

// Shallow-merges `patch` over what is on disk. A key set to `null` is deleted —
// that is how the UI clears an API key without having to know the whole document.
// The returned `settings` (and every in-memory read) is always plain text —
// only the bytes handed to `io.write` are encrypted — so no caller anywhere
// else in the app needs to know this happens.
function writeSettings({ file, patch, io = fsIo, crypt = null }) {
  try {
    const doc = readSettings({ file, io, crypt });
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null) delete doc[k]; else doc[k] = v;
    }
    io.write(file, JSON.stringify(encryptSecrets(doc, crypt), null, 2) + '\n');
    return { ok: true, settings: doc };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The themes the app ships; anything else falls back to the default, so a
// stale or hand-edited settings.json can never paint the window an unknown
// color.
const THEMES = ['paper', 'operator', 'glass', 'graphite', 'soft', 'dusk'];
// What a new install opens on. Paper is the design language and still the base
// stylesheet everything else is layered over — this is only which desk you are
// handed first, and glass is the one that reads as a current Mac app to
// somebody who has never seen KingAgent before. Anyone who has chosen a theme keeps
// it: this is consulted only when nothing has been chosen.
const DEFAULT_THEME = 'glass';
// First-paint window background per theme (renderer CSS takes over on load).
const THEME_BG = { paper: '#cfc3ac', operator: '#121212', glass: '#e8e9ee', graphite: '#26272c', soft: '#e5e5e5', dusk: '#262a31' };
function normalizeTheme(name) { return THEMES.includes(name) ? name : DEFAULT_THEME; }
// Desk or Split (specs/2026-09-08-split-view.md): anything else is the desk.
const VIEWS = ['desk', 'split'];
function normalizeView(name) { return VIEWS.includes(name) ? name : 'desk'; }
function themeBackground(name) { return THEME_BG[normalizeTheme(name)]; }

// --- research settings (Phase 7 §50) ----------------------------------------
//
// The settings file is user-editable and is read at startup, so every value is
// re-validated here rather than trusted: a hand-edited `maxSources: "lots"` must
// not reach the engine, and a hand-edited `allowNetworkedSources: true` must be
// a real boolean rather than a truthy string.
//
// Two of these are security-relevant and are treated accordingly.
// `allowNetworkedSources` writes an `allow` into the research policy document,
// so it defaults to false: a fresh install gates outbound research on approval,
// which is how the platform already treats `network.request`. `allowedDomains`
// is a ceiling the renderer can only narrow (see agent-platform.js).
const RESEARCH_DEFAULTS = Object.freeze({
  enabled: true,
  defaultMode: 'standard',
  maxQueries: null,
  maxSources: null,
  maxConcurrency: null,
  timeoutMs: null,
  requireCitations: true,
  requireVerification: true,
  cacheEnabled: true,
  cacheTtlMs: null,
  allowedDomains: [],
  blockedDomains: [],
  allowNetworkedSources: false,
});

const RESEARCH_MODES = ['quick', 'standard', 'deep'];

function posIntOrNull(v, max) {
  return Number.isInteger(v) && v > 0 && v <= max ? v : null;
}

function domainList(v, max = 500) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v
    .filter((d) => typeof d === 'string')
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*?\./, '').split('/')[0])
    .filter((d) => d.length > 0 && d.length <= 253))].slice(0, max);
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

// `settings.research` -> the config object core/research/index.js takes.
function researchConfig(settings) {
  const raw = settings && typeof settings.research === 'object' && !Array.isArray(settings.research)
    ? settings.research
    : {};
  return {
    enabled: bool(raw.enabled, RESEARCH_DEFAULTS.enabled),
    defaultMode: RESEARCH_MODES.includes(raw.defaultMode) ? raw.defaultMode : RESEARCH_DEFAULTS.defaultMode,
    maxQueries: posIntOrNull(raw.maxQueries, 100),
    maxSources: posIntOrNull(raw.maxSources, 500),
    maxConcurrency: posIntOrNull(raw.maxConcurrency, 16),
    timeoutMs: posIntOrNull(raw.timeoutMs, 30 * 60 * 1000),
    requireCitations: bool(raw.requireCitations, RESEARCH_DEFAULTS.requireCitations),
    requireVerification: bool(raw.requireVerification, RESEARCH_DEFAULTS.requireVerification),
    cacheEnabled: bool(raw.cacheEnabled, RESEARCH_DEFAULTS.cacheEnabled),
    cacheMaxEntries: posIntOrNull(raw.cacheMaxEntries, 10_000) || 500,
    allowedDomains: domainList(raw.allowedDomains),
    blockedDomains: domainList(raw.blockedDomains),
    allowNetworkedSources: bool(raw.allowNetworkedSources, RESEARCH_DEFAULTS.allowNetworkedSources),
  };
}

module.exports = {
  readSettings, writeSettings, fsIo, normalizeTheme, themeBackground, THEMES, DEFAULT_THEME,
  normalizeView, VIEWS, researchConfig, RESEARCH_DEFAULTS, RESEARCH_MODES,
  SECRET_KEYS, ENC_PREFIX,
};
