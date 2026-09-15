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

function readSettings({ file, io = fsIo }) {
  if (!io.exists(file)) return {};
  try {
    const doc = JSON.parse(io.read(file));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch (_) {
    // A corrupt file must not brick the app; it gets replaced on the next write.
    return {};
  }
}

// Shallow-merges `patch` over what is on disk. A key set to `null` is deleted —
// that is how the UI clears an API key without having to know the whole document.
function writeSettings({ file, patch, io = fsIo }) {
  try {
    const doc = readSettings({ file, io });
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null) delete doc[k]; else doc[k] = v;
    }
    io.write(file, JSON.stringify(doc, null, 2) + '\n');
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
};
