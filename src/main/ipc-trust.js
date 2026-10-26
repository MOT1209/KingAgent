// What main accepts from the renderer when the renderer names a path or a URL.
//
// The renderer is not a trust boundary (main.js says so where trustedRoot is
// defined): anything that reaches it — a doc's markdown, a link an agent
// printed — can end up as an argument to an IPC call. So every handler that
// takes a path to read, write or run checks it here first, against places main
// itself knows about, never against a root the same call supplied. Pure, so
// each rule is testable without Electron.

const path = require('node:path');
const { libraryRoots } = require('./library');
const { KNOWN_AGENTS, expandHome } = require('./agents-detect');
const { APP_DATA_DIRNAME } = require('./platform');

// Separator-aware, so /proj-evil is not read as living under /proj. The same
// lexical test fs-actions' inside() applies to the fs:* verbs — except that on
// Windows it ignores case, where C:\proj and c:\proj are one folder and a path
// typed into a terminal rarely matches the case the folder picker returned.
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function within(root, abs) {
  if (!root) return false;
  const r = fold(path.resolve(root)), a = fold(abs);
  return a === r || a.startsWith(r + path.sep);
}

// Where the editor may read and write: the window's open folder, every
// library location the scan lists (so any skill or agent the Library shows can
// be edited), the plugin cache it also lists, KingAgent's own data folder, and
// each agent's settings file — the launcher's "Open its settings file". A
// settings file that sits directly in $HOME (~/.claude.json) is allowed as
// that one file, never as its folder, or "the folder it is in" would be $HOME.
function editableRoots({ projectPath, homeDir }) {
  const home = path.resolve(homeDir);
  const dirs = libraryRoots({ projectPath, homeDir: home });
  dirs.push(path.join(home, '.claude'), path.join(home, APP_DATA_DIRNAME));
  const files = [];
  for (const a of KNOWN_AGENTS) {
    const cfg = a.lifecycle && a.lifecycle.configPath;
    if (!cfg) continue;
    const abs = path.resolve(expandHome(cfg, home));
    if (path.dirname(abs) === home) files.push(abs);
    else dirs.push(path.dirname(abs));
  }
  if (projectPath) dirs.unshift(path.resolve(projectPath));
  return { dirs, files };
}

// The absolute path when the editor may touch it, otherwise null.
function allowedFile({ file, projectPath, homeDir }) {
  if (typeof file !== 'string' || !file || !path.isAbsolute(file)) return null;
  const abs = path.resolve(file);
  const { dirs, files } = editableRoots({ projectPath, homeDir });
  if (files.some((f) => fold(f) === fold(abs))) return abs;
  return dirs.some((d) => within(d, abs)) ? abs : null;
}

// A bundle folder is only ever one services:pickBundle unpacked and settled
// under ~/.kingagent/bundles/<slug> — not its scratch .unpacking-* folder, and
// not the bundles folder itself. Anything else would let a call choose the
// program written into every agent's MCP settings.
function bundleDirOk(dir, homeDir) {
  if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) return null;
  const root = path.join(path.resolve(homeDir), APP_DATA_DIRNAME, 'bundles');
  const abs = path.resolve(dir);
  if (path.dirname(abs) !== root) return null;
  if (path.basename(abs).startsWith('.')) return null;
  return abs;
}

// An installed connector is the checkout the setup sheet's own install tile
// cloned to ~/.kingagent/connectors/<repo>, holding the built dist/index.js
// the catalog entry runs with node. Nowhere else is a folder this app made.
function installDirOk(dir, homeDir, exists) {
  if (typeof dir !== 'string' || !dir) return null;
  const home = path.resolve(homeDir);
  const expanded = dir.replace(/^~(?=[\\/]|$)/, home);
  if (!path.isAbsolute(expanded)) return null;
  const abs = path.resolve(expanded);
  if (path.dirname(abs) !== path.join(home, APP_DATA_DIRNAME, 'connectors')) return null;
  return exists(path.join(abs, 'dist', 'index.js')) ? abs : null;
}

// Parse, check the scheme, and hand back the re-serialised href — never the
// string that arrived. A regex prefix test passes "https://x\r\n..." through
// whole, and on Windows openExternal ends at ShellExecute.
function httpHref(url, { httpsOnly = false } = {}) {
  let u;
  try { u = new URL(String(url == null ? '' : url).trim()); } catch (_) { return null; }
  if (u.protocol === 'https:') return u.href;
  if (u.protocol === 'http:' && !httpsOnly) return u.href;
  return null;
}

module.exports = { editableRoots, allowedFile, bundleDirOk, installDirOk, httpHref };
