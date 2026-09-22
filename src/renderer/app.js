import { CONNECT_OVERLAYS } from './mcp-setup.mjs';
import { createUpdateBar } from './update-bar.mjs';
import { createTerminalLinkTracking } from './terminal-link-tracking.mjs';
import { createPanelLifecycle } from './panel-lifecycle.mjs';
import { createSettingsPanes } from './settings-panes.mjs';
import { createLauncher } from './launcher.mjs';
import { createWorkspaceLibrary } from './workspace-library.mjs';
// KingAgent — the agent workbench, by Dainami (renderer, terminal-first).
// Every session is a real PTY (claude / shell / any harness), shown as a paper tile in a grid you
// can focus, reorder, and expand. Workspace is a live explorer + paper editor. Vanilla DOM; tiles
// (xterm + editors) are managed incrementally so live processes survive re-renders.

import { fileKind, shellQuote, pathRef } from './file-kinds.mjs';
import { chipHtml, iconKeyFor, treeIcon, pixIcon, helpIcon } from './icons.mjs';
import { MAC_GROUP_KEYS } from './library-groups.mjs';
import { createLinkHint } from './link-hint.mjs';
import { deskColumns } from './desk-grid.mjs';
import { isFile as isFilePanel, isSession as isSessionPanel, ownerFor, keep as keepFile, splitAfter } from './desk-view.mjs';

import { createBrowserPane } from './browser-pane.mjs';
import { createTileShell } from './tile-shell.mjs';
import { createTileContent } from './tile-content.mjs';

const api = window.kingagent;
// The renderer's own view of the OS, straight from the preload bridge (a string
// beats an IPC round-trip). Drives chrome layout, labels and which actions are
// offered at all.
const PLATFORM = api.platform || '';
const IS_MAC = PLATFORM === 'darwin';
const REVEAL_LABEL = IS_MAC ? 'Reveal in Finder' : 'Reveal in File Explorer';
const terminalHint = createLinkHint({ document, window });

// Used by the update bar's star-ask, the About settings pane, and Quick
// Start's outbound links — declared early, at module scope, rather than
// inside any one of those (previously inside the About section) so none of
// them has to worry about load order to reach it.
const REPO_URL = 'https://github.com/MOT1209/KingAgent';
// The doc pages the quick start points at. One page per row, so a reader lands
// on the answer to the row they pressed rather than on a contents page they
// then have to search. Kept next to REPO_URL so every outward link KingAgent has is
// read in one place.
const DOCS = {
  home: 'https://github.com/MOT1209/KingAgent/tree/main/docs',
  start: 'https://github.com/MOT1209/KingAgent/blob/main/docs/design.md',
  pickAgent: 'https://github.com/MOT1209/KingAgent/blob/main/docs/architecture.md',
  examples: 'https://github.com/MOT1209/KingAgent/blob/main/README.md',
  permissions: 'https://github.com/MOT1209/KingAgent/blob/main/docs/security.md',
};
// Where the app sends people who want the person rather than the program.
//
// KingAgent has no telemetry and is not getting any — "nothing leaves your Mac" is
// one of the three reasons anyone trusts it, and it cannot be un-spent. So the
// UTM is the entire measurement story: it costs nothing, it is visible to
// anyone who reads the link, and GitHub's own page views read it at the
// other end. `where` names the surface, so "does the empty desk ever get
// clicked" has an answer without a single byte leaving the machine.
//
// GitHub links stay bare on purpose: the UTM is inert there, harmless but unread.
const makerUrl = (where) => `https://github.com/MOT1209/KingAgent?utm_source=kingagent-app&utm_medium=${where}`;
const teamsUrl = (where) => `https://github.com/MOT1209/KingAgent/discussions?utm_source=kingagent-app&utm_medium=${where}&utm_campaign=teams`;

// Finder can send a file the instant the page finishes loading, which is well
// before boot() has a desk to put it on. The listener goes up here, at module
// scope, so nothing is dropped in that gap; boot drains what arrived early.
const earlyOpens = [];
let deliverOpen = (ev) => earlyOpens.push(ev);
api.onOpenFile((ev) => deliverOpen(ev));

// ---- palette ---------------------------------------------------------------
// Colour answers exactly one question: what kind of thing is this? It is never
// derived from an id, so every service looks like a service and you only have
// to learn the palette once. The hues live in paper.css as [data-kind] rules:
// agent · skill · command · service · editor · viewer · shell · folder.
// A panel's kind → its chip kind. Anything that runs an agent reads as one.
function chipKindOf(panel) {
  if (!panel) return 'neutral';
  if (panel.chipKind) return panel.chipKind;
  switch (panel.kind) {
    case 'editor': return 'editor';
    case 'viewer': case 'browser': return 'viewer';
    case 'shell': return 'shell';
    case 'card': return 'agent';
    // every agent session is one kind — Claude, OpenCode, any other CLI — so the
    // desk, the rail and the new-session picker all show the same green
    default: return 'agent';
  }
}

const XTERM_THEME = {
  // Transparent, but with the paper's RGB channels: xterm's minimumContrastRatio
  // measures against this color, so faint dark-theme TUI text gets re-inked for cream.
  background: 'rgba(253,249,236,0)', foreground: '#2b2822', cursor: '#4a6b52', cursorAccent: '#fdf9ec',
  selectionBackground: 'rgba(201,169,78,0.38)',
  black: '#5a4b34', red: '#a8482f', green: '#4a7a4a', yellow: '#9a7420', blue: '#3f6088',
  magenta: '#8a5f8a', cyan: '#3f7d82', white: '#6f6553',
  brightBlack: '#8d8065', brightRed: '#b4503c', brightGreen: '#5f8f5f', brightYellow: '#a8792a',
  brightBlue: '#5a7fae', brightMagenta: '#a07aa0', brightCyan: '#5aa0a0', brightWhite: '#2f2b26',
};

// ---- themes (paper default · operator dark) --------------------------------
const THEME_KEY = 'kingagent-theme';
const XTERM_THEME_OPERATOR = {
  // Transparent over the operator panel; minimumContrastRatio re-inks
  // cream-tuned TUI text for the dark ground.
  background: 'rgba(31,31,31,0)', foreground: '#ecebe7', cursor: '#ef6461', cursorAccent: '#121212',
  selectionBackground: 'rgba(239,100,97,0.28)',
  black: '#4f4f4f', red: '#ef6461', green: '#5aa06e', yellow: '#d8a03d', blue: '#6ea8ff',
  magenta: '#c792ea', cyan: '#5ac8c8', white: '#b8b5ae',
  brightBlack: '#8f8d86', brightRed: '#ff8b88', brightGreen: '#66c17e', brightYellow: '#e8b45a',
  brightBlue: '#8fbcff', brightMagenta: '#d7a9f0', brightCyan: '#7adcdc', brightWhite: '#f2f0ee',
};
// glass (light frost): ANSI deepened so every CLI stays readable on the light well
const XTERM_THEME_GLASS = {
  background: 'rgba(255,255,255,0)', foreground: '#34353d', cursor: '#ef6461', cursorAccent: '#ffffff',
  selectionBackground: 'rgba(239,100,97,0.22)',
  black: '#3c3d45', red: '#d6423e', green: '#2e7d4f', yellow: '#b07c10', blue: '#3763c9',
  magenta: '#a4499d', cyan: '#1f7f86', white: '#8b8c96',
  brightBlack: '#6a6b76', brightRed: '#e0524f', brightGreen: '#3f9b63', brightYellow: '#c98d1a',
  brightBlue: '#5b82d9', brightMagenta: '#bb64b3', brightCyan: '#2f989f', brightWhite: '#1d1d22',
};
// graphite (dark grey glass): the same slots brightened for the smoke well
const XTERM_THEME_GRAPHITE = {
  background: 'rgba(25,26,32,0)', foreground: '#dcdde6', cursor: '#ff8b88', cursorAccent: '#26272c',
  selectionBackground: 'rgba(239,100,97,0.3)',
  black: '#4a4b55', red: '#ff6b67', green: '#5fca8b', yellow: '#e8b33e', blue: '#6f9dff',
  magenta: '#d580cc', cyan: '#4fc2cc', white: '#a7a8b3',
  brightBlack: '#7c7d88', brightRed: '#ffa19e', brightGreen: '#7fdca3', brightYellow: '#f2c766',
  brightBlue: '#93b5ff', brightMagenta: '#e3a1dc', brightCyan: '#78d8d8', brightWhite: '#f0f0f6',
};
const XTERM_THEME_SOFT = {
  background: 'rgba(229,229,229,0)', foreground: '#2c2a33', cursor: '#ef6461', cursorAccent: '#e5e5e5',
  selectionBackground: 'rgba(239,100,97,0.22)',
  black: '#3c3d45', red: '#d6423e', green: '#3d7a4a', yellow: '#9a6c14', blue: '#3d6bb3',
  magenta: '#7a4a8a', cyan: '#1f7f86', white: '#8b8c96',
  brightBlack: '#6a6b76', brightRed: '#e0524f', brightGreen: '#4f9b5f', brightYellow: '#c98d1a',
  brightBlue: '#5b82d9', brightMagenta: '#9a64b3', brightCyan: '#2f989f', brightWhite: '#2c2a33',
};
const XTERM_THEME_DUSK = {
  background: 'rgba(38,42,49,0)', foreground: '#e8eaee', cursor: '#ef6461', cursorAccent: '#262a31',
  selectionBackground: 'rgba(239,100,97,0.3)',
  black: '#4a4b55', red: '#ff6b67', green: '#5fca8b', yellow: '#e8b33e', blue: '#6f9dff',
  magenta: '#d580cc', cyan: '#4fc2cc', white: '#a7a8b3',
  brightBlack: '#7c7d88', brightRed: '#ffa19e', brightGreen: '#7fdca3', brightYellow: '#f2c766',
  brightBlue: '#93b5ff', brightMagenta: '#e3a1dc', brightCyan: '#78d8d8', brightWhite: '#e8eaee',
};
const STATUS_COLORS = {
  paper: { ok: '#4a7a4a', warn: '#a8792a', mut: '#8d8065' },
  operator: { ok: '#5aa06e', warn: '#ef6461', mut: '#98958e' },
  glass: { ok: '#2e7d4f', warn: '#b07c10', mut: '#8f9094' },
  graphite: { ok: '#63c68a', warn: '#e6c05c', mut: '#9a9ba6' },
  soft: { ok: '#3d7a4a', warn: '#a8792a', mut: '#8d939e' },
  dusk: { ok: '#5fca8b', warn: '#e6c05c', mut: '#8d939e' },
};
const THEME_NAMES = ['paper', 'operator', 'glass', 'graphite', 'soft', 'dusk'];
const GLASS_FAMILY = new Set(['glass', 'graphite']);
const SOFT_FAMILY = new Set(['soft', 'dusk']);
const XTERM_THEMES = {
  paper: XTERM_THEME, operator: XTERM_THEME_OPERATOR, glass: XTERM_THEME_GLASS, graphite: XTERM_THEME_GRAPHITE,
  soft: XTERM_THEME_SOFT, dusk: XTERM_THEME_DUSK,
};
// What a new install opens on, and the answer whenever nothing valid has been
// chosen. Kept in step with DEFAULT_THEME in src/main/settings.js, which paints
// the window before this file has loaded — the two disagreeing is a visible
// flash of the wrong colour on every launch.
const DEFAULT_THEME = 'glass';
function normalizeTheme(name) {
  return THEME_NAMES.includes(name) ? name : DEFAULT_THEME;
}
function currentTheme() {
  const t = document.body.dataset.theme;
  return t === undefined ? 'paper' : normalizeTheme(t);
}
function xtermTheme() { return XTERM_THEMES[currentTheme()]; }
function statusColors() { return STATUS_COLORS[currentTheme()]; }
// SF Mono in every theme's terminal, Courier Prime everywhere else.
//
// Courier Prime is a typewriter face: thin strokes, low x-height, wide letters.
// It is what makes KingAgent's chrome look hand-made and it is the worst thing about
// reading a dense terminal — an agent's output is small, dense, and rarely
// re-read carefully, which is the opposite of what that face is for. The glass
// themes already made this trade; the rest now follow.
//
// The UI keeps Courier Prime, so the desk still reads as paper. Only the
// terminals change.
function termFontFamily() {
  return "'SF Mono', ui-monospace, Menlo, monospace";
}
function applyThemeAttrs(name) {
  name = normalizeTheme(name);
  if (name !== 'paper' && THEME_NAMES.includes(name)) document.body.dataset.theme = name;
  else delete document.body.dataset.theme;
  // data-glass scopes the shared liquid-glass system CSS + the tilt engine
  if (GLASS_FAMILY.has(name)) document.body.setAttribute('data-glass', '');
  else document.body.removeAttribute('data-glass');
  if (SOFT_FAMILY.has(name)) document.body.setAttribute('data-soft', '');
  else document.body.removeAttribute('data-soft');
}
// Desk or Split. Persisted like the theme: localStorage for the next boot of
// this window, settings.json so a fresh window agrees. Entering split works
// out what the two panes show from whatever was active (desk-view.mjs).
const VIEW_KEY = 'kingagent-view';
function setView(name, persistIt = true) {
  const view = name === 'split' ? 'split' : 'desk';
  const was = S.view;
  S.view = view;
  if (persistIt && !S.demo && !S.review) { try { localStorage.setItem(VIEW_KEY, view); } catch (_) {} }
  if (persistIt && !S.demo && !S.review && api.viewSet) api.viewSet(view);
  if (view === 'split' && was !== 'split') S.split = splitAfter({ ...S.split, panels: S.panels }, { type: 'enter', activeId: S.activeId });
  if (view !== 'split') S.expandedId = null;
  applyViewAttrs();
  if (els.grid) { renderGrid(); renderRail(); }
}
function applyViewAttrs() {
  document.querySelectorAll('#viewsw .view-choice').forEach((b) => { const active = b.dataset.view === S.view; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
}
let themeSaveVersion = 0;
function setTheme(name, persistIt = true) {
  name = normalizeTheme(name);
  applyThemeAttrs(name);
  if (api.themeApplied) api.themeApplied(name);
  const version = ++themeSaveVersion;
  let saved = Promise.resolve();
  if (persistIt && !S.review && api.themeSet) {
    saved = Promise.resolve(api.themeSet(name)).then((result) => {
      if (!result || !result.ok) throw new Error('save failed');
      if (version === themeSaveVersion) { try { localStorage.setItem(THEME_KEY, name); } catch (_) {} }
    }).catch(() => toast('Appearance changed, but could not be saved for next launch.'));
  }
  tileEls.forEach((t, id) => {
    if (!t.term) return;
    t.term.options.theme = xtermTheme();
    t.term.options.fontFamily = termFontFamily();
    t.term.options.fontSize = termFontOf(S.panels.find((x) => x.id === id));
    t.term.options.letterSpacing = termLetterSpacing();
    markFit(t);
  });
  if (els.grid) { renderAll(); requestAnimationFrame(positionThemePop); }
  return saved;
}
// apply the saved theme before first paint (localStorage mirrors settings.json)
// Before first paint, and before boot data arrives. An install that has never
// chosen a theme gets the default rather than the base stylesheet, which is
// what "paper is the absence of an attribute" would otherwise hand it.
try { applyThemeAttrs(localStorage.getItem(THEME_KEY) || DEFAULT_THEME); } catch (_) { applyThemeAttrs(DEFAULT_THEME); }

// ---- launcher rows ---------------------------------------------------------
// Agents come from the detected registry (S.agents); only Terminal is static.
// Big rows are things that run right now; small cards are things you could add.
const EVERGREEN_ROWS = [
  { id: 'shell', name: 'Terminal', sub: 'a plain shell, ink on paper', kind: 'shell', chipKind: 'shell', code: '❯' },
];

// ---- state -----------------------------------------------------------------
const S = {
  project: null, recents: [], demo: false,
  panels: [], activeId: null, expandedId: null,
  // Desk or Split (desk-view.mjs). split remembers what the two panes show.
  view: 'desk', split: { sessionId: null, fileId: null, last: {} },
  splitRatio: .46, splitFull: null,   // the divider's position; which pane ⤢ filled
  railFold: new Set(),   // sessions whose file list is folded in the rail
  railTab: 'sessions', overlay: null, toast: null, seq: 0, winId: 0,
  pendingOpen: null,                    // file from Finder, waiting on a folder switch to be allowed
  version: '', updatedAt: null,        // shown in Settings → About, filled at boot
  agents: null, agentsLoading: false,   // detected agent CLIs (null until first scan)
  justAdded: null,                      // agent installed this run — flagged in the launcher
  agentStatus: {},                      // id → { signedIn, label, rows, source }, filled lazily
  tree: {}, expanded: new Set(),   // explorer: path -> children[], expanded dirs
  treeSel: null,                   // selected row, for the ＋ target and Enter-to-rename
  treeEdit: null,                  // { path } while a rename input is open
  treeDrag: null,                  // path being dragged, for the descendant guard
  treeFresh: new Set(),            // rows that just landed, briefly marked
  treeAll: localStorage.getItem('kingagent-tree-all') === '1',  // show ignored files too
  // Your project's skills are what you came for; other tools' folders and broken
  // links start folded, or 139 borrowed rows sit between you and everything else.
  library: { items: [], edges: [], q: '', loaded: false, loading: false, macLoaded: false, macLoading: false, collapsed: new Set(MAC_GROUP_KEYS), macGen: 0 },
  pointer: null, pointerLoading: false,
  services: { catalog: [], connected: [], loading: false },   // connect-a-service state
  railCollapsed: false, railPeek: false,
};

let els = {};
const tileEls = new Map();
// panelLifecycle and browsers need each other (browsers.open/restore/etc. from
// panelLifecycle's own functions; pinFilePanel/focusPanel/closePanel from
// browsers's constructor) — a genuine cycle that used to resolve for free
// because everything was one hoisted scope. Breaking it: panelLifecycle is
// built first, with thin thunks standing in for `browsers` (a `const`
// assigned two lines down) — the thunks only read that binding when actually
// called, at runtime, long after both consts exist. Its own exports are then
// destructured into these same local names so every other call site in this
// file (there are many) keeps working unchanged.
const panelLifecycle = createPanelLifecycle({ api, state: S, tiles: tileEls, toast, uid, code2, baseNameOf, shortHome, q, shorten,
  // renderRail/renderHeader/renderGrid/syncSplitLayout/refreshTileHead/
  // clearAttention are thunks: they now live in tile-shell.mjs (renderGrid,
  // syncSplitLayout, refreshTileHead, clearAttention) or workspace-library.mjs
  // (renderRail, renderHeader), both constructed after this module.
  renderGrid: (...a) => renderGrid(...a), renderRail: (...a) => renderRail(...a), renderHeader: (...a) => renderHeader(...a), renderAll,
  // openCard is a thunk: it now lives in tile-content.mjs, constructed last.
  syncSplitLayout: (...a) => syncSplitLayout(...a), openPeek, openCard: (...a) => openCard(...a),
  refreshTileHead: (...a) => refreshTileHead(...a), clearAttention: (...a) => clearAttention(...a),
  browsers: {
    open: (...a) => browsers.open(...a), restore: (...a) => browsers.restore(...a),
    hasPending: (...a) => browsers.hasPending(...a), canClose: (...a) => browsers.canClose(...a),
    removeNotes: (...a) => browsers.removeNotes(...a), clearNotes: (...a) => browsers.clearNotes(...a),
  } });
const { savePanels, flushPanels, restorePanels, seedTitleSource, startPanel,
  confirmOutsideOpen, openFile, moveFileTo, moveMenu, pinFilePanel, focusPanel, toggleKeepRunning, closePanel, closeFinished, reorderPanels } = panelLifecycle;
const browsers = createBrowserPane({ api, state: S, tiles: tileEls, uid, esc, helpIcon, isFile: isFilePanel, isSession: isSessionPanel,
  pin: pinFilePanel, focus: focusPanel, refresh: renderAll, save: savePanels,
  show: (o) => { S.overlay = o; renderOverlay(); }, dialog: overlay, close: closeOverlay, toast,
  // settings is a thunk, not the plain openSettings reference, for the same
  // reason as panelLifecycle's browsers thunks above: openSettings comes from
  // settingsPanes, constructed further down (it in turn needs `browsers` and
  // `updateBar`, so it cannot come first) - the thunk only looks it up when a
  // browser tile's menu actually calls it, long after settingsPanes exists.
  // selection is a thunk: openSelectionDraft now lives in tile-shell.mjs,
  // constructed after this module, same reasoning as the settings thunk below.
  // dictation.start is a thunk: startAnnotationDictation now lives in
  // tile-content.mjs, constructed last, same reasoning as the settings thunk.
  selection: (...a) => openSelectionDraft(...a), insertAnnotation, sessions: () => S.panels.filter(isSessionPanel).filter(p=>!p.exited), panelIcon:panelChip, settings: (...a) => openSettings(...a), closePanel, dictation: { start: (...a) => startAnnotationDictation(...a) },
  tileMenu: (p) => tileMenu(p), showMenu: (x, y, items) => showMenu(x, y, items), openOutside: (p) => openOutside(p) });
const updateBar = createUpdateBar({ api, els, q, esc, state: S, onStarClick: () => api.openUrl(REPO_URL) });
const termLinks = createTerminalLinkTracking({ api, state: S, q, tiles: tileEls, terminalHint, toast, shorten,
  // showMenu/openSelectionDraft are thunks for the same reason as renderRail/
  // renderHeader above: openSelectionDraft now lives in tile-shell.mjs.
  openSelectionDraft: (...a) => openSelectionDraft(...a), showMenu: (...a) => showMenu(...a), browsers, setView, openFile, confirmOutsideOpen, REVEAL_LABEL });
const { registerTerminalLinks, wireTerminalMenu, oscLinkHandler, hoveredLink, panelBases } = termLinks;
const settingsPanes = createSettingsPanes({ api, state: S, toast, esc, helpIcon, q, overlay, closeOverlay, renderOverlay,
  rememberHelpFocus, getHelpFocusKey: () => helpFocusKey,
  // refreshSttInfo/setSttInfo/transcribeBlob are thunks: they now live in
  // tile-content.mjs, constructed last, same reasoning as elsewhere.
  refreshSttInfo: (...a) => refreshSttInfo(...a), setSttInfo: (...a) => setSttInfo(...a), transcribeBlob: (...a) => transcribeBlob(...a),
  setTheme, currentTheme, getThemeOptions: () => THEME_OPTIONS,
  browsers, updateBar, REPO_URL, DOCS, makerUrl, teamsUrl });
const { openSettings, renderSettings, wireHelpDialog } = settingsPanes;
const launcher = createLauncher({ api, state: S, tiles: tileEls, browsers, toast, overlay, closeOverlay, renderOverlay, rememberHelpFocus,
  openSettings, wireHelpDialog, getTypeChip: () => TYPE_CHIP, REPO_URL, DOCS,
  startPanel, closePanel, openFile, savePanels, flushPanels, restorePanels, seedTitleSource,
  esc, q, shorten, shortHome, baseNameOf, uid, code2,
  // renderRail/renderHeader/refreshRail/watchProject/refreshServices/loadLibrary/
  // refreshPointer/installedAgentIds/agentNameOf are thunks: they now live in
  // workspace-library.mjs; refreshTileHead/renderGrid/makeFolderDialog are
  // thunks because they now live in tile-shell.mjs — both modules constructed
  // after this one, same reasoning as panelLifecycle's browsers thunks.
  refreshTileHead: (...a) => refreshTileHead(...a), refreshRail: (...a) => refreshRail(...a), renderRail: (...a) => renderRail(...a), renderHeader: (...a) => renderHeader(...a),
  renderGrid: (...a) => renderGrid(...a), renderAll, attachCompanion, EVERGREEN_ROWS,
  watchProject: (...a) => watchProject(...a), refreshServices: (...a) => refreshServices(...a), makeFolderDialog: (...a) => makeFolderDialog(...a),
  loadLibrary: (...a) => loadLibrary(...a), refreshPointer: (...a) => refreshPointer(...a),
  installedAgentIds: (...a) => installedAgentIds(...a), agentNameOf: (...a) => agentNameOf(...a),
  // openCard is a thunk: it now lives in tile-content.mjs, constructed last.
  openCard: (...a) => openCard(...a) });
const { openLauncher, openAgentSheet, openAgentRemove, openAgentPicker, refreshAgentStatus, refreshAgents,
  runCommandFinished, openImproveItem, openCreate, openQuickStart,
  openFolderDialog, openFolder, switchToFolder, receiveOpenFile,
  openConnect, openConnectOwn, openServiceDetails, launchAgent, pickerAgents, rowTool, openToolList,
  renderLauncher, renderFolderFirst, renderAgentSetup, renderAgentRemove,
  renderAgentPickerSheet, renderCreateSheet, renderImproveItem, renderSwitchChoice,
  renderQuickStart, mcpSetup } = launcher;
// PANEL_TYPE/PATH_TYPE/DIR_TYPE and peekRec are all declared later in app.js
// (drag-data MIME constants near the terminal-link section; peekRec in the
// Overlays block) — thunked for the same reason REPO_URL/THEME_OPTIONS were.
const workspaceLibrary = createWorkspaceLibrary({ api, state: S, tiles: tileEls, els, overlay, toast, closeOverlay, renderOverlay, closeFinished,
  getPeekRec: () => peekRec, terminalHint, esc, q, shortHome, REVEAL_LABEL,
  getPanelType: () => PANEL_TYPE, getPathType: () => PATH_TYPE, getDirType: () => DIR_TYPE,
  openFolderDialog, openFolder, openFile, moveFileTo, moveMenu, focusPanel,
  // openFileInBrowser/insertSessionText/statusMeta/kindLabel are thunks: they
  // now live in tile-shell.mjs. saveEditor/beginRename/openCard are thunks:
  // they now live in tile-content.mjs. Both modules are constructed after
  // this one, same reasoning as elsewhere.
  saveEditor: (...a) => saveEditor(...a), openFileInBrowser: (...a) => openFileInBrowser(...a), insertSessionText: (...a) => insertSessionText(...a),
  statusMeta: (...a) => statusMeta(...a), kindLabel: (...a) => kindLabel(...a), panelChip, beginRename: (...a) => beginRename(...a),
  openCard: (...a) => openCard(...a), openConnect, openCreate, openServiceDetails, refreshAgents, currentTheme, setTheme });
const { renderHeader, renderRail, refreshRail, renderFooter, watchProject, refreshServices,
  loadLibrary, refreshPointer, installedAgentIds, agentNameOf, showMenu,
  toggleProjectsPop, positionThemePop, toggleThemePop,
  beginTreeRename, dirName, trashTreeItem, openFsName, renderFsName,
  onDirChanged, followFileChanges, openOutside, tileMenu,
  TYPE_CHIP, THEME_OPTIONS } = workspaceLibrary;
// mountEditor/mountViewer/mountCard/saveEditor are thunks: they are hoisted
// function declarations in app.js today (safe regardless of order), but are
// destined for a future tile-content extraction that would build its module
// after this one — thunking now avoids having to touch this construction
// call again when that split happens, the same way the panelLifecycle/
// browsers cycle was resolved.
const tileShell = createTileShell({ api, state: S, tiles: tileEls, els,
  statusColors, esc, shorten, baseNameOf, shortHome, uid, code2, q, panelChip,
  isFileDrag, isPathDrag, isDirDrag, draggedPath, droppedPaths, dropFilesOnPanel, dropPathOnPanel,
  currentTheme, xtermTheme, termFontFamily, setView, syncDeskColumns, terminalHint,
  browsers, openFile, closePanel, focusPanel, savePanels, reorderPanels, toggleKeepRunning, confirmOutsideOpen, startPanel,
  showMenu, tileMenu, openOutside, refreshRail, renderHeader,
  openLauncher, openQuickStart, openFolderDialog, switchToFolder,
  registerTerminalLinks, wireTerminalMenu, oscLinkHandler, hoveredLink, panelBases,
  // toggleMic/beginRename/feedSessionName/applyTitle are thunks too, for the
  // same reason as the mount*/saveEditor thunks above: they now live in
  // tile-content.mjs, constructed last.
  toggleMic: (...a) => toggleMic(...a), beginRename: (...a) => beginRename(...a), feedSessionName: (...a) => feedSessionName(...a), applyTitle: (...a) => applyTitle(...a),
  toast, closeOverlay, overlay, renderOverlay, rememberContext,
  getMountEditor: () => mountEditor, getMountViewer: () => mountViewer, getMountCard: () => mountCard, getSaveEditor: () => saveEditor,
});
const { statusMeta, kindLabel, makeFolderDialog, renderGrid, syncSplitLayout, refreshTileHead, markFit, clearAttention,
  openSelectionDraft, insertSessionText, renderSelectionDraft, openFileInBrowser, docScaleOf, openDocLink,
  applyDocColWidths, bindBrowserButton, refreshBrowserButtons, termFontOf, termLetterSpacing } = tileShell;
const tileContent = createTileContent({ api, state: S, tiles: tileEls, esc, q, shorten, baseNameOf, shortHome, formatLabel, uid, REVEAL_LABEL,
  keepFile,
  refreshTileHead, refreshRail, refreshBrowserButtons,
  docScaleOf, openDocLink, applyDocColWidths, bindBrowserButton,
  focusPanel, pinFilePanel, closePanel, savePanels,
  loadLibrary, refreshPointer, installedAgentIds, TYPE_CHIP,
  rowTool, launchAgent, openImproveItem,
  openSettings,
  toast, closeOverlay, openPeek });
const { mountEditor, saveEditor, mountViewer, openCard, mountCard, saveCard,
  setSttInfo, refreshSttInfo, transcribeBlob, startAnnotationDictation, toggleMic,
  injectToSession, beginRename, applyTitle, feedSessionName } = tileContent;
function attachCompanion(p,owner) {
  if(!p||!owner)return;
  p.companionOf=owner;
  if(S.view!=='split')setView('split');
  S.split=splitAfter({...S.split,panels:S.panels},{type:'select-companion',id:p.id});S.splitFull=null;
  renderGrid();renderRail();savePanels();
}
async function insertAnnotation(payload,destinations) {
  const inserted=[],failed=[];
  for(const id of destinations) {
    try {
    const rec=tileEls.get(id),p=S.panels.find(p=>p.id===id);
    if(!p||p.exited||!rec){failed.push({id,error:'Session is closed.'});continue;}
    let text=payload.text || `${payload.note}\n\n${payload.reference}`;
    if(payload.image) {
      const grant=await api.browserAnnotationImage({action:'grant',id:payload.image.id,recipientIds:[id]});
      if(!grant?.ok){failed.push({id,error:grant?.error||'Image unavailable.'});continue;}
    }
    let ok;
    if(rec.insertSessionDraft) {
      const r=await rec.insertSessionDraft({text,images:payload.image?[payload.image]:[]});ok=r?.ok;
    } else {
      if(payload.image)text+=`\n\nScreenshot file reference: ${JSON.stringify(payload.image.path)}\nKingAgent image ID: ${payload.image.id} (available through kingagent_read_annotation_image when connected).`;
      ok=await insertSessionText(id,text,{focus:false});
    }
    if(ok){inserted.push(id);rememberContext(id,{reference:payload.reference||payload.url,text,insertedAt:Date.now()});}
    else failed.push({id,error:'Could not insert into this input.'});
    } catch(error) { failed.push({id,error:error.message||'Insertion failed.'}); }
  }
  if(inserted.length)toast('Feedback inserted into '+inserted.length+' session input'+(inserted.length===1?'':'s')+'.');
  return {ok:failed.length===0,inserted,failed};
}
// panelId -> { root, head, body, term, fit, statusDot, ta, gutter }

// w<winId> makes the name unique across every open window: main keys its session
// maps by whatever id we invent here, and on its own S.seq restarts at 1 in each
// window. See the boot handler in main.js. Ids are opaque everywhere (nothing
// parses one, none is written to state.json), so the prefix is free.
function uid(p) { S.seq += 1; return `w${S.winId}_${p}${S.seq}`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function shorten(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function code2(str) {
  const w = String(str || '').replace(/[^a-zA-Z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase();
  return (String(str || '?').replace(/[^a-zA-Z]/g, '').slice(0, 2) || 'SS').toUpperCase();
}
function baseNameOf(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '(file)'; }
// The format a file is in, for a tab that should not call TOML "Markdown".
function formatLabel(p) {
  const m = baseNameOf(p).match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toUpperCase() : 'Raw';
}
function shortHome(p) { return String(p || '').replace(/^\/Users\/[^/]+/, '~'); }
function q(sel, root) { return (root || document).querySelector(sel); }
// A panel's chip: brand glyph when the session maps to a known brand, else its code.
function panelChip(p) {
  if (p.kind === 'browser') return `<span class="code code--icon" data-kind="viewer">${helpIcon('browser')}</span>`;
  if (isFilePanel(p)) return `<span class="code code--icon" data-kind="${chipKindOf(p)}">${treeIcon(p.filePath || p.title, 'file')}</span>`;
  const key = p.kind === 'claude' ? 'claude'
    : iconKeyFor(p.agentId) || iconKeyFor(p.title);
  return chipHtml({ key, code: p.code, kind: chipKindOf(p) });
}

// ---- OS file drops ---------------------------------------------------------
function isFileDrag(e) { return dragTypes(e).includes('Files'); }
// A row dragged out of the Workspace tree. It carries its path in a private type
// as well as in text/plain, because text/plain already means "panel id" to the
// tile reorder — one channel, two meanings, and the tile could only guess. The
// payload itself is unreadable until the drop fires (browsers hide getData
// during dragover), so in flight this is all there is to go on, exactly as with
// isFileDrag above.
//
// Whether the row is a folder rides as a second *type* rather than as data, for
// exactly that reason: the canvas has to refuse a folder while you are still
// holding it, and a hidden payload cannot answer that.
const PATH_TYPE = 'application/x-kingagent-path';
const DIR_TYPE = 'application/x-kingagent-dir';
const PANEL_TYPE = 'application/x-kingagent-panel'; // a file row dragged onto a session row in the rail
function dragTypes(e) { return Array.from((e.dataTransfer && e.dataTransfer.types) || []); }
function isPathDrag(e) { return dragTypes(e).includes(PATH_TYPE); }
function isDirDrag(e) { return dragTypes(e).includes(DIR_TYPE); }
function draggedPath(e) { try { return e.dataTransfer.getData(PATH_TYPE) || ''; } catch (_) { return ''; } }
function droppedPaths(e) {
  return Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    .map((f) => api.droppedFilePath(f)).filter(Boolean);
}
function dropFilesOnPanel(p, paths) {
  if (p.kind === 'editor' || p.kind === 'viewer') { paths.forEach((f) => openFile(f, { pin: true })); return; }
  if (p.kind === 'acp') {
    const t = tileEls.get(p.id);
    if (t && t.acpAttach) paths.forEach((f) => t.acpAttach('\u{1F4CE} ' + baseNameOf(f), { path: f }));
    toast('Attached ' + (paths.length === 1 ? baseNameOf(paths[0]) : paths.length + ' files') + ' \u2014 path goes to the agent');
    return;
  }
  injectToSession(p, paths.map(shellQuote).join(' ') + ' ');
  toast('Dropped ' + (paths.length === 1 ? baseNameOf(paths[0]) : paths.length + ' files') + ' into ' + shorten(p.title, 24));
}
// A workspace path dropped on a session. The file does not move and nothing is
// copied — the session is handed a reference to where it already lives.
//
// S.treeDrag is cleared here rather than left to the row's own dragend, because
// both of the paths below rebuild the rail synchronously — injectToSession
// focuses the panel, which calls renderRail, which empties the container the
// dragged row lives in. The row is gone before dragend would reach it. Every
// tree drop on master ended in wireDrop.ondrop, which nulls this itself; these
// two are the first that do not, and a stale S.treeDrag is not inert — the next
// no-files drag onto a tree row would move a file you are not holding.
function dropPathOnPanel(p, path, isDir) {
  S.treeDrag = null;
  if (p.kind === 'editor' || p.kind === 'viewer') { if (!isDir) openFile(path, { pin: true }); return; }
  injectToSession(p, pathRef(path, S.project && S.project.path, isDir));
  toast('Added ' + baseNameOf(path) + ' to ' + shorten(p.title, 24));
}

// ===========================================================================
//  Boot
// ===========================================================================
(async function boot() {
  // Before buildShell paints: the lights deck and the windows overlay gutter
  // are per-OS CSS, keyed off this attribute.
  document.body.dataset.platform = api.platform || '';
  api.onFullScreen((on) => document.body.classList.toggle('is-fullscreen', !!on));
  buildShell();
  const b = await api.boot();
  S.winId = b.winId || 0;
  S.version = b.version || ''; S.updatedAt = b.updatedAt || null;
  // The wordmark's caption. Rendered empty by buildShell and filled here, so
  // the lockup is never laid out twice — the stack is sized by KingAgent above it,
  // and a build that somehow reports no version simply shows nothing.
  if (S.version) { const bv = q('#brand-ver'); if (bv) bv.textContent = 'v' + S.version; }
  S.review = !!b.review;
  S.demo = b.demo; S.recents = b.recentFolders || []; S.project = b.currentFolder || null;
  // Here, not in buildShell: buildShell runs before this await resolves, so the
  // project was still null there and the window watched nothing at all until you
  // opened a different folder. Whatever boot restored is watched from now,
  // whichever rail tab the window happens to open on.
  watchProject();
  setSttInfo(b.sttInfo);
  if (b.collapsed) S.railCollapsed = true;
  setTheme(b.themeArg || b.theme || DEFAULT_THEME, false);
  if (!S.review) { try { localStorage.setItem(THEME_KEY, currentTheme()); } catch (_) {} }
  // The view you left the app in. localStorage is this window's memory,
  // settings.json the shared one; a --scene may force one for a screenshot.
  let view = null; if (!S.demo) { try { view = localStorage.getItem(VIEW_KEY); } catch (_) {} }
  setView(S.demo ? 'desk' : (view || b.view || 'desk'), false);

  // One window opening a folder reorders the list for every window; without this
  // the other windows' popovers keep showing a stale order until they reboot.
  // Either the check already ran before this window existed (boot carries it),
  // or it lands later while the window is open.
  if (b.updater && b.updater.releaseInfo) updateBar.setReleaseInfo(b.updater.releaseInfo);
  if (b.update) updateBar.offerUpdate(b.update, b.updater);
  api.onUpdateAvailable(updateBar.offerUpdate);
  api.onUpdateProgress((ev) => updateBar.paintUpdate('downloading', ev));
  api.onUpdateReady((ev) => updateBar.paintUpdate('ready', ev));
  api.onUpdateFailed(() => updateBar.paintUpdate('failed', {}));
  // A postponed update whose reminder window has passed, brought back by
  // main rather than waiting for the next six-hourly poll. Unlike an
  // ordinary poll result, this one is allowed past a "not now" from before —
  // that mark meant "stop nagging automatically", and this is a reminder the
  // user asked for on purpose when they clicked it.
  if (api.updater && api.updater.onReminder) {
    api.updater.onReminder((ev) => { localStorage.removeItem(updateBar.SKIPPED_UPDATE); updateBar.offerUpdate(ev); });
  }

  api.onRecentsChanged((rows) => {
    S.recents = rows || [];
    if (q('.projects-pop')) { q('.projects-pop').remove(); toggleProjectsPop(); }
  });

  api.onTermData(({ id, data }) => {
    const t = tileEls.get(id); if (t && t.term) t.term.write(data);
    // when a byte last moved — the auto-takeover's "is the terminal mid-task"
    const p = S.panels.find((x) => x.id === id); if (p) p.lastPtyData = Date.now();
  });

  // Main watched the agent's store after spawn and found the conversation this
  // terminal-run tile landed in — save it so the next launch resumes it. A tile
  api.onTermSessionId(({ id, sid }) => {
    const p = S.panels.find((x) => x.id === id);
    if (!p || !sid || p.acpSid) return;
    p.acpSid = sid;
    savePanels();
  });

  // A one-shot command KingAgent ran on the user's behalf has landed. The shell is
  // still alive and still theirs — this is the command reporting, not the tile
  // ending. See src/main/run-done.js for how the shell says so.
  api.onTermCommandDone(({ id, code }) => {
    const p = S.panels.find((x) => x.id === id); if (!p) return;
    runCommandFinished(p, code);
  });

  api.onTermExit(({ id, code, note }) => {
    const p = S.panels.find((x) => x.id === id); if (!p) return;
    p.exited = true; p.status = 'exited';
    // main writes the note, because only it knows whether KingAgent ended this
    // session or the process did. `code` stays in the payload for older paths.
    const said = note || `exited · ${code}`;
    const t = tileEls.get(id); if (t && t.term) t.term.write(`\r\n\x1b[38;2;141;128;101m[${said}]\x1b[0m\r\n`);
    // A panel can care that its command finished — an agent sign-out re-reads
    // who is signed in, so the details sheet is never stale.
    if (p.onExit) { try { p.onExit(code); } catch (_) {} }
    refreshTileHead(p); refreshRail(); renderHeader(); browsers.decorate();
  });

  // Claude names its own conversation a few turns in, and re-names it as the
  // work moves on. That name is what `claude --resume` will show tomorrow, so
  // the rail shows it too — unless you named the tile yourself.
  api.onSessionTitle(({ id, title }) => {
    const p = S.panels.find((x) => x.id === id); if (!p) return;
    applyTitle(p, title, 'agent');
  });

  // /resume inside a tile lands claude in a different conversation than the one
  // KingAgent pinned at spawn. Storing the id it actually moved to is what makes the
  // tile come back as that conversation next launch instead of an empty one.
  api.onSessionSid(({ id, sid }) => {
    const p = S.panels.find((x) => x.id === id); if (!p || !sid || p.sid === sid) return;
    p.sid = sid;
    savePanels();
  });

  api.onMenuCommand((cmd) => runMenuCommand(cmd));

  if (S.demo) seedDemo();
  refreshAgents();   // pre-detect so ⌘N is instant
  refreshServices(); // services group in the library + connect sheets
  renderAll();
  if (!S.demo && Array.isArray(b.panels) && b.panels.length) restorePanels(b.panels);
  // Nothing auto-starts: an empty desk lands on the session page, where the
  // agent and the surface are chosen. Scenes keep the desk to themselves.
  // A file already on its way from Finder means the desk is about to have
  // something on it, and the launcher would open straight over the top of it.
  else if (!S.demo && !b.scene && S.project && !earlyOpens.length) openLauncher();
  if (b.scene) showScene(b.scene);
  // The desk exists now, so anything Finder sent during boot can land.
  deliverOpen = receiveOpenFile;
  while (earlyOpens.length) receiveOpenFile(earlyOpens.shift());
  updateBar.armStarAsk();
})();

// --scene= puts one surface on screen at boot so `npm run shot` can capture it in both
// themes. Screenshot plumbing only; nothing in the app calls this.
function showScene(name) {
  const [what, ...rest] = String(name).split(':');
  const step = rest.join(':'); // a step can be a path, and paths carry colons' worth of slashes
  if (what === 'browser') {
    const sess = S.panels.find(isSessionPanel);
    if (S.demo && step === 'multi' && sess) S.panels.push({ ...sess, id: uid('p_'), title: 'Codex session', code: 'CX', sceneStatic: true });
    if (sess) S.activeId = sess.id;
    browsers.open('about:blank', null, sess?.id);
    setView('split', false); return;
  }
  if (what === 'settings') return openSettings(step || 'voice');
  // split: the demo desk with its files joined to the session, in the split view
  if (what === 'split') {
    const sess = S.panels.find(isSessionPanel);
    const first = S.panels.find(isFilePanel);
    if (sess && first) {
      first.owner = sess.id;
      const second = { id: uid('p_'), kind: 'editor', chipKind: 'editor', code: 'ED', title: 'webauthn.ts', filePath: '/Users/calvin/work/atlas/src/auth/webauthn.ts', owner: sess.id, preview: true, status: 'live',
        text: "export async function verifyRegistration(cred: Credential) {\n  const res = await fetch('/api/webauthn/verify', {\n    method: 'POST', body: JSON.stringify(cred),\n  })\n  if (!res.ok) throw new Error('registration rejected')\n  return res.json()\n}\n" };
      S.panels.splice(S.panels.indexOf(first), 0, second);
      S.activeId = first.id;
    }
    setView(step === 'desk' ? 'desk' : 'split', false); renderHeader();
    return;
  }
  // chat: a static transcript so the thinking/tool cards can be shot without
  // a live agent. chat-live still starts a real Claude pane.
  if (what === 'chat') {
    const np = {
      id: uid('p_'), kind: 'acp', chipKind: 'agent', code: 'CC', title: 'Claude Code',
      agentId: 'claude', cwd: (S.project && S.project.path) || '~',
      status: 'live', started: true, sceneStatic: true,
    };
    S.panels.unshift(np); S.activeId = np.id; S.expandedId = np.id;
    renderGrid(); renderRail(); renderHeader();
    const rec = tileEls.get(np.id);
    // chat:md — one fixed markdown-heavy reply through the real renderer, so
    // the six themes can be shot against identical pixels.
    if (step === 'md' && rec && rec.cwFeed) {
      rec.cwFeed({ type: 'user', text: 'compare the agents we support and what is left to test' });
      rec.cwFeed({ type: 'message', text: '## Agent roster\n\nAll six connect over the same channel — **one renderer, zero per-agent code**.\n\n'
        + '| Agent | Commands | Modes | Chat |\n|---|---|---|---|\n| claude | 96 | 6 | yes |\n| kimi | 35 | 4 | yes |\n| codex | 6 | 3 | yes |\n| grok | 97 | — | yes |\n\n'
        + '### Still to verify\n\n- long replies with *mixed* formatting\n  - nested points like this one\n  - links inside bold — **[works now](https://github.com/MOT1209/KingAgent)**\n- [x] tables render clean\n- [ ] half-streamed table mid-reply\n\n'
        + '> Note: raw HTML in a reply stays escaped — it can never run.\n\n'
        + 'Run the probe again after any CLI update: `tools/acp-probe.mjs`\n\n'
        + '```sh\nfor a in claude kimi codex grok; do\n  probe "$a" && echo "$a ok"\ndone\n```\n\n~~hermes pending~~ — verified 26 Aug.' });
      return;
    }
    const host = rec && rec.body && rec.body.querySelector('.cw-scroll');
    if (host) {
      const empty = host.querySelector('.cw-empty');
      if (empty) empty.remove();
      host.insertAdjacentHTML('beforeend',
        '<div class="cw-blk"><div class="cw-u">Compare our pricing with the top 20 competitors</div></div>'
        + '<div class="cw-blk"><button class="cw-think"><span class="tw">Thinking…</span></button>'
        + '<div class="cw-think-body">I\'ll line up the 20 sites first, then pull pricing into a sheet.</div></div>'
        + '<div class="cw-blk"><div class="cw-card"><div class="cw-card-hd"><span class="k">Read</span> <span class="f">pricing.csv</span><span class="cw-run ok">done</span></div></div></div>'
        + '<div class="cw-blk"><div class="cw-card cw-plan"><div class="cw-card-hd"><span class="k">Plan</span><span class="f">1/3</span></div>'
        + '<ul><li class="don">Read pricing.csv</li><li class="tod">Line up 20 competitor sites</li><li class="tod">Build the spreadsheet</li></ul></div></div>'
        + '<div class="cw-blk"><div class="cw-a">Lined up the sheet. 20 competitors, our rows on top.</div></div>');
    }
    return;
  }
  // chat-live: spawn a real Claude chat pane, expanded (gate screenshots)
  if (what === 'chat-live') {
    const liveCwd = decodeURIComponent(new URL('../../../../', location.href).pathname).replace(/\/$/, '');
    const np = { id: uid('p_'), kind: 'acp', chipKind: 'agent', code: 'CC', title: step || 'Claude Code', agentId: step || 'claude', cwd: liveCwd, status: 'live', started: true };
    S.panels.unshift(np); S.activeId = np.id; S.expandedId = np.id;
    renderGrid(); renderRail(); renderHeader();
    return;
  }
  // doc:disk — a file tile with unsaved edits and the changed-on-disk bar
  // raised over them, which is the one state nothing in the app can be clicked
  // into on demand: it needs an agent to rewrite the file at the right moment.
  if (what === 'doc' && step === 'disk') {
    const np = {
      id: uid('p_'), kind: 'editor', chipKind: 'editor', code: 'ED', title: 'NOTES.md',
      filePath: ((S.project && S.project.path) || '/Users/calvin/work/atlas') + '/NOTES.md',
      status: 'live', dirty: true,
      text: '# Release notes\n\n- Follow a file on disk while it is open on the desk\n- Name the files behind a folder change\n\nStill to write: the part about what happens\nwhen two people have the same file open.\n',
    };
    S.panels.unshift(np); S.activeId = np.id; S.expandedId = np.id;
    renderGrid(); renderRail(); renderHeader();
    const rec = tileEls.get(np.id);
    if (rec && rec.raiseDiskBar) rec.raiseDiskBar(np.text + '\n## Written by the agent while you were typing\n');
    return;
  }
  // open:<abs path> — pin any file as a tile, which is how a new viewer kind
  // gets screenshotted without a folder open and a tree to click through.
  if (what === 'open' && step) return openFile(step, { pin: true });
  // peek:<abs path> — the floating file sheet, used for controls that live in
  // the peek head rather than on a pinned tile.
  if (what === 'peek' && step) return openFile(step);
  // The folder-first card asks where a session should run when no folder is
  // open. :empty shoots the first-run face (no recents on file).
  if (what === 'folder-first') {
    if (step === 'empty') S.recents = [];
    S.project = null;
    S.overlay = { type: 'folder-first', run: () => {}, who: 'Claude' };
    return renderOverlay();
  }
  // The ⌘K picker, and the same picker with one agent's tool list open.
  //   --scene=agents  ·  agents:<slug>
  // Both wait on the detect pass: without it the rows cannot name a tool.
  if (what === 'agents') {
    return refreshAgents().then(async () => {
      await openAgentPicker();
      if (!step) return;
      const item = pickerAgents().find((a) => a.slug === step);
      if (item) await openToolList(item);
    });
  }
  // agent surfaces need the detect pass to have landed, and the sheet also
  // needs that agent's identity, so both wait rather than shooting "checking…"
  if (what === 'launcher' || what === 'agent' || what === 'agent-remove') {
    return refreshAgents().then(async () => {
      if (what === 'launcher') return openLauncher();
      const a = (S.agents || []).find((x) => x.id === step) || (S.agents || []).find((x) => x.found);
      if (!a) return openLauncher();
      await refreshAgentStatus(a.id);
      return what === 'agent' ? openAgentSheet(a) : openAgentRemove(a);
    });
  }
  // An install that has just finished — the one state you cannot arrange on
  // demand without actually installing something. The tile is static (no pty),
  // but finishAgentInstall is the real one: it re-scans and decides from what
  // it finds, so the shot shows what a user would see and not a mock of it.
  //   --scene=install:ok  ·  install:failed  ·  install:launcher
  if (what === 'install') {
    return refreshAgents().then(async () => {
      if (step === 'launcher') {
        const found = (S.agents || []).find((x) => x.found);
        S.justAdded = found && found.id;
        return openLauncher();
      }
      const fail = step === 'failed';
      // ok needs an agent this Mac really has, so the scan can confirm it.
      // failed is driven by the exit code, which is what actually decides —
      // a machine with every agent already installed (this one, as it turns
      // out) has no missing agent to borrow for the shot.
      const a = (S.agents || []).find((x) => x.found) || (S.agents || [])[0];
      if (!a) return undefined;
      const p = startPanel({
        kind: 'run', title: `install ${a.name}`, code: code2(a.name), command: a.install,
        oneShot: true, agentId: a.id, sceneStatic: true,
      });
      if (!p) return undefined;
      await new Promise((r) => requestAnimationFrame(r));
      const t = tileEls.get(p.id);
      if (t && t.term) {
        t.term.write(`\x1b[38;5;246m$ ${a.install}\x1b[0m\r\n`);
        t.term.write('  resolving host…\r\n  downloading  ████████  100%\r\n');
        t.term.write(fail ? '\x1b[38;5;174mcurl: (6) Could not resolve host\x1b[0m\r\n'
          : `\x1b[38;5;114m  ✓ ${a.bin} installed\x1b[0m\r\n`);
      }
      return runCommandFinished(p, fail ? 6 : 0);
    });
  }
  if (what === 'projects') return toggleProjectsPop();
  // newfile / newfolder — the create box. It had no scene, so every screenshot
  // of this app was taken without it, and its header shipped wrapped across two
  // lines under a three-line path before anyone saw it.
  if (what === 'newfile' || what === 'newfolder') {
    const ready = S.project ? Promise.resolve() : (S.recents[0] ? openFolder(S.recents[0].path) : Promise.resolve());
    return ready.then(() => {
      S.railTab = 'workspace'; renderRail();
      // step lets a shot aim at a deep folder, which is the case that broke it
      const dir = step || (S.project && S.project.path) || '~';
      openFsName(what === 'newfile' ? 'file' : 'folder', dir);
    });
  }
  // The update card only appears when a newer release exists, which is exactly
  // the state you cannot arrange on demand — so the scene fakes the payload.
  // A download in flight and one waiting for a quit are two more states nobody
  // can arrange on demand, and they are the two the user stares at longest.
  //   --scene=update  ·  update:downloading  ·  update:ready  ·  update:confirm
  if (what === 'update') {
    localStorage.removeItem(updateBar.SKIPPED_UPDATE);
    const staged = step === 'downloading' || step === 'ready' || step === 'confirm';
    updateBar.offerUpdate({ version: staged ? '0.2.0' : (step || '0.2.0'), url: 'https://example.test/KingAgent.dmg' });
    if (staged) updateBar.paintUpdate(step, { percent: 58, version: '0.2.0', live: 3 });
    return undefined;
  }
  // Same problem as the update card: the star ask is gated on five launches and
  // a 90-second wait, which is not a state anyone can arrange for a screenshot.
  if (what === 'star') {
    localStorage.removeItem(updateBar.STAR_ASKED);
    return updateBar.paintStarAsk();
  }
  // rename:tile / rename:rail — the in-place name editor, which you can only
  // otherwise reach by double-clicking a live session
  if (what === 'rename') {
    const p = S.panels.find((x) => isSessionPanel(x));
    if (!p) return;
    const t = tileEls.get(p.id);
    return beginRename(p, step === 'rail' ? q('.rail-list .nav-card .goal') : t && q('.t-title', t.head));
  }
  if (what === 'theme') return toggleThemePop();
  if (what === 'term-scroll') {
    const p = S.panels.find((x) => x.kind === 'shell' || x.kind === 'claude') || S.panels[0];
    if (!p) return;
    S.expandedId = p.id; S.activeId = p.id; renderGrid();
    return new Promise((resolve) => setTimeout(() => {
      const t = tileEls.get(p.id);
      if (t && t.term) {
        for (let i = 0; i < 80; i++) t.term.write('  ' + String(i + 1).padStart(2, '0') + '  competitor row — pricing.csv\r\n');
      }
      resolve();
    }, 700));
  }
  // empty desk — with a folder (demo) or none. Panels have to be cleared
  // because --demo seeds two tiles onto the grid.
  if (what === 'empty') {
    S.panels = []; S.activeId = null; S.expandedId = null;
    if (step === 'nofolder') { S.project = null; S.recents = []; }
    renderGrid(); renderRail(); renderHeader();
    return;
  }
  if (what === 'quickstart') return openQuickStart();
  if (what === 'workspace') {
    // the tree needs a folder; a path in the step opens that one. Fall back
    // to the most recent if none is open.
    const folder = step && step.startsWith('/') ? step : null;
    const ready = folder ? openFolder(folder)
      : S.project ? Promise.resolve()
      : (S.recents[0] ? openFolder(S.recents[0].path) : Promise.resolve());
    return ready.then(async () => {
      S.railTab = 'workspace';
      const root = S.project && S.project.path;
      if (root) {
        try {
          if (!S.tree[root]) S.tree[root] = await api.listDir(root, S.treeAll);
          const kids = S.tree[root] || [];
          const firstDir = kids.find((n) => n.kind === 'dir' && n.name === 'src')
            || kids.find((n) => n.kind === 'dir' && n.name[0] !== '.' && n.name !== 'node_modules');
          if (firstDir) {
            S.tree[firstDir.path] = await api.listDir(firstDir.path, S.treeAll);
            S.expanded.add(firstDir.path);
            const sub = (S.tree[firstDir.path] || []).find((n) => n.kind === 'dir' && n.name[0] !== '.');
            if (sub) {
              S.tree[sub.path] = await api.listDir(sub.path, S.treeAll);
              S.expanded.add(sub.path);
            }
          }
        } catch (_) { /* demo path is fake; a missing folder just stays closed */ }
      }
      renderRail();
    });
  }
  S.railTab = 'library';
  // library:<abs path> / mcp:<abs path> — open that folder first, so shots can
  // show project-scoped state (coverage pills need a project's masters).
  const withFolder = step && step.startsWith('/') && (what === 'library' || what === 'mcp') ? openFolder(step) : Promise.resolve();
  withFolder.then(() => loadLibrary(true)).then(() => {
    renderRail();
    if (what === 'library') return;
    if (what === 'mcp') return step === 'own' ? openConnectOwn() : openConnect();
    // create:agent / create:skill — the one-screen sheet ("agent" alone is the
    // agent identity sheet above, so the create scene needs its own name)
    if (what === 'create') return openCreate(step === 'agent' ? 'agent' : 'skill');
    if (what !== 'agent' && what !== 'skill') return;
    openCreate(what); // one screen for both — the step argument died with the steps
  });
}

// ===========================================================================
//  The menu bar, from this side
// ===========================================================================
// Every KingAgent item in the application menu arrives here as a string. The rule
// this file keeps is that a menu item never has its own implementation: it
// calls the same function the keyboard or the button already called, so there
// is one behaviour per command and the menu only adds a label to it.
//
// Which is also why ⌘W is in here at all. A menu accelerator outranks a
// renderer keydown, so the moment File carries ⌘W the keydown below stops
// firing for it. Routing it to closeActive() is what keeps the key meaning
// close *pane* instead of Close Window, which is what the conventional menu
// item would have made it.
function runMenuCommand(cmd) {
  const [what, ...rest] = String(cmd || '').split(':');
  const arg = rest.join(':'); // an argument can be a path, and paths carry colons' worth of slashes
  if (what === 'about') return openSettings('about');
  if (what === 'settings') return openSettings(arg || 'voice');
  if (what === 'update-check') {
    openSettings('about');
    // The pane's own button, pressed. Checking has one implementation and it
    // lives in wireAboutPane, including the part where asking by hand
    // un-dismisses a version that was waved away.
    const act = q('#ab-act');
    if (act) act.click();
    return undefined;
  }
  if (what === 'new-session') return openLauncher();
  if (what === 'open-folder') return openFolderDialog();
  if (what === 'open-recent') return arg ? openFolder(arg) : undefined;
  if (what === 'new-file' || what === 'new-folder') {
    if (!S.project) { toast('Open a folder first.'); return openFolderDialog(); }
    S.railTab = 'workspace'; renderRail();
    return openFsName(what === 'new-file' ? 'file' : 'folder', S.project.path);
  }
  if (what === 'save') { if (!saveActive()) toast('Nothing here to save.'); return undefined; }
  if (what === 'reveal') {
    const p = activeFilePanel();
    if (!p) { toast('Open a file first.'); return undefined; }
    return api.revealFile(p.filePath);
  }
  if (what === 'close-pane') return closeActive();
  if (what === 'dictate') {
    const p = S.panels.find((x) => x.id === S.activeId);
    if (!p) { toast('Start a session first.'); return undefined; }
    return toggleMic(p);
  }
  if (what === 'rail') {
    if (arg === 'toggle') { S.railCollapsed = !S.railCollapsed; return applyChrome(); }
    S.railTab = arg;
    if (arg === 'library') loadLibrary(true);
    return renderRail();
  }
  if (what === 'theme') return setTheme(arg);
  if (what === 'agents') return openAgentPicker();
  return undefined;
}

// Both of these were written inline in onGlobalKey. They are functions now
// because the menu has to run the same code, and a second copy of "what does
// ⌘W mean" is exactly how the two would drift apart.
function closeActive() {
  if (S.overlay && S.overlay.type === 'peek') requestClosePeek();
  else if (S.activeId) closePanel(S.activeId);
}
// Returns whether it saved anything, because the keydown only swallows ⌘S when
// there was something to save.
function saveActive() {
  const pk = S.overlay && S.overlay.type === 'peek' && S.overlay.panel;
  if (pk && pk.kind === 'editor') { saveEditor(pk); return true; }
  if (pk && pk.kind === 'card') { saveCard(pk); return true; }
  const p = S.panels.find((x) => x.id === S.activeId);
  if (p && p.kind === 'editor') { saveEditor(p); return true; }
  if (p && p.kind === 'card') { saveCard(p); return true; }
  return false;
}
// A peek wins over the tile behind it, same as saving does: it is what you are
// looking at.
function activeFilePanel() {
  const pk = S.overlay && S.overlay.type === 'peek' && S.overlay.panel;
  if (pk && pk.filePath) return pk;
  const p = S.panels.find((x) => x.id === S.activeId);
  return p && p.filePath ? p : null;
}

// ===========================================================================
//  Static shell
// ===========================================================================
function buildShell() {
  document.getElementById('root').innerHTML = `
    <div class="desk"><div class="sheet">
      <div class="lights-deck" aria-hidden="true"></div>
      <div class="topbar">
        <div class="brand">
          <span class="brand-mark">
            <!-- The K is the product drawn as a letter: one spine, arms leaving
                 it from a single junction — one workspace, several agents. The
                 only element carrying colour is the block in the letter's mouth,
                 which is a terminal cursor: the agent that is live right now.
                 Geometry is on a 64-grid with a 4-unit module, so every straight
                 edge lands on a whole device pixel at 16px instead of greying
                 out. Ink follows currentColor so each desk sets it once. -->
            <svg class="king-mark" viewBox="0 0 64 64" aria-hidden="true">
              <rect x="8" y="8" width="12" height="48" fill="currentColor"/>
              <g stroke-width="12" fill="none" stroke="currentColor">
                <path d="M20 32 L46 10"/>
                <path d="M20 32 L46 54"/>
              </g>
              <rect class="king-mark-cursor" x="48" y="24" width="8" height="16" fill="var(--mark-accent)"/>
            </svg>
            <span class="brand-stack">
              <span class="brand-name">KingAgent</span>
              <span class="brand-ver" id="brand-ver"></span>
            </span>
          </span>
          <span class="brand-sub">AI Agent Operating Platform</span>
        </div>
        <div class="topbar-center" id="topbar-center"></div>
        <div class="topbar-right">
          <div class="live-badge" id="live-badge" style="display:none"><span class="dot"></span><span id="live-label"></span></div>
          <button class="btn btn-help" id="btn-help" title="Quick start"><span class="uni-i">?</span><span class="pix-i">${pixIcon('help')}</span></button>
          <div class="theme-zone" id="theme-zone"><button class="btn" id="btn-theme" title="Theme"><span class="uni-i">◐</span><span class="pix-i">${pixIcon('theme')}</span></button></div>
          <button class="btn btn-set" id="btn-settings" title="Settings ⌘,"><span class="uni-i">⚙</span><span class="pix-i">${pixIcon('settings')}</span></button>
          <div class="viewsw" id="viewsw" role="group" aria-label="Workspace view" title="Desk: every card on a grid. Split: one session beside one of its files.">
            <button class="view-choice" data-view="desk">Desk</button>
            <button class="view-choice" data-view="split">Split</button>
          </div>
          <button class="btn" id="btn-agents">Agents<span class="kb"> ⌘K</span></button>
          <button class="btn btn--go" id="btn-new"><span class="uni-i">＋ </span><span class="pix-i">${pixIcon('plus')}</span>New<span class="kb2"> session</span><span class="kb"> ⌘N</span></button>
        </div>
      </div>
      <div class="split">
        <div class="rail" id="rail">
          <button class="rail-strip" id="rail-strip" title="Show sidebar">›</button>
          <div class="rail-tabs">
            <button class="rail-tab active" data-tab="sessions">Sessions</button>
            <button class="rail-tab" data-tab="workspace">Workspace</button>
            <button class="rail-tab" data-tab="library">Library</button>
            <button class="rail-collapse" id="rail-collapse" title="Hide sidebar">‹</button>
          </div>
          <div id="rail-content"></div>
        </div>
        <div class="main">
          <div class="grid" id="grid"></div>
          <div id="update-root"></div>
          <div class="footer">
            <span>⌘N new session</span><span>⌘K agents</span><span>⌘O folder</span>
            <span>⌘W close pane</span><span>⌘S save</span><span class="path" id="footer-path"></span>
            <button class="btn btn--small footer-shortcuts" id="btn-shortcuts">${helpIcon('shortcuts')} Shortcuts</button>
          </div>
        </div>
      </div>
      <div id="overlay-root"></div><div id="toast-root"></div>
    </div></div>`;

  // Object.assign onto the existing object, not a fresh one: updateBar (and
  // anything else constructed before boot reaches this point) captured `els`
  // by reference at module-init time, and a plain `els = {...}` reassignment
  // would orphan that reference, leaving it looking at a permanently empty
  // object.
  Object.assign(els, {
    topbarCenter: q('#topbar-center'), liveBadge: q('#live-badge'), liveLabel: q('#live-label'),
    railContent: q('#rail-content'), grid: q('#grid'),
    footerPath: q('#footer-path'), overlayRoot: q('#overlay-root'), toastRoot: q('#toast-root'),
    updateRoot: q('#update-root'),
  });
  q('#btn-new').onclick = () => openLauncher();
  q('#btn-agents').onclick = () => openAgentPicker();
  document.querySelectorAll('#viewsw .view-choice').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  q('#btn-help').onclick = () => openQuickStart();
  q('#btn-shortcuts').onclick = () => openSettings('shortcuts');
  q('#btn-theme').onclick = (e) => { e.stopPropagation(); toggleThemePop(); };
  q('#btn-settings').onclick = () => openSettings();
  document.querySelectorAll('.rail-tab[data-tab]').forEach((t) => { t.onclick = () => { S.railTab = t.dataset.tab; if (t.dataset.tab === 'library') loadLibrary(true); renderRail(); }; });
  q('#rail-collapse').onclick = () => { S.railCollapsed = true; S.railPeek = false; applyChrome(); };
  q('#rail-strip').onclick = () => { S.railCollapsed = false; S.railPeek = true; applyChrome(); };
  document.addEventListener('keydown', onGlobalKey);
  // Capture Escape before a terminal treats it as an agent command.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && terminalHint.hide()) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('pointerdown', () => terminalHint.hide(), true);
  document.addEventListener('scroll', () => terminalHint.hide(), true);
  document.addEventListener('wheel', () => terminalHint.hide(), { capture: true, passive: true });
  window.addEventListener('blur', () => terminalHint.hide());
  window.addEventListener('resize', () => terminalHint.hide());
  initGlassTilt();

  // The desk relays its own tracks. Cheap — it only re-renders when the count
  // actually changes, which is a handful of times across a whole window drag.
  syncDeskColumns();
  window.addEventListener('resize', () => { syncDeskColumns(); positionThemePop(); });

  // A folder changed on disk — usually because a session just wrote to it.
  if (api.onDirChanged) api.onDirChanged(({ dir, files }) => onDirChanged(dir, files));
  // Safety net for what the watchers cannot catch: network volumes, FSEvents
  // gaps. Costs one pass at the exact moment you have come back to look at it.
  window.addEventListener('focus', () => {
    if (!S.project || S.treeEdit) return;
    for (const dir of [S.project.path, ...S.expanded]) if (dir in S.tree) onDirChanged(dir, []);
    // Once, not once per folder: the open files are one list, and re-reading
    // each of them for every expanded folder would turn a window focus into
    // dozens of reads of the same file.
    void followFileChanges(null);
  });

  // OS file drops: never let Electron navigate away on a stray drop.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // Dropping on empty canvas opens the file as a viewer/editor tile
  // (tile drops stopPropagation, so this only fires outside tiles).
  // A folder is refused here rather than accepted and ignored: there is no
  // folder viewer tile, so the cursor should never promise one.
  //
  // The refusal has to be said out loud — `dropEffect = 'none'` — and cannot be
  // left to withholding preventDefault. The window listener directly above sits
  // further up the same bubble path and prevents the default on every dragover
  // in the document, so by the time the event is done the drop is allowed no
  // matter what this handler declines to do. Staying silent would leave the
  // browser showing the copy it infers from effectAllowed, over a drop that
  // then does nothing — the exact thing this whole change exists to delete.
  els.grid.addEventListener('dragover', (e) => {
    if (isPathDrag(e)) {
      if (isDirDrag(e)) { e.dataTransfer.dropEffect = 'none'; return; }
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; return;
    }
    if (isFileDrag(e)) e.preventDefault();
  });
  els.grid.addEventListener('drop', (e) => {
    if (isPathDrag(e)) {
      if (isDirDrag(e)) return;
      const path = draggedPath(e); if (!path) return;
      S.treeDrag = null; // openFile renders the rail out from under the row — see dropPathOnPanel
      e.preventDefault(); openFile(path, { pin: true }); return;
    }
    const paths = droppedPaths(e); if (!paths.length) return;
    e.preventDefault(); paths.forEach((f) => openFile(f, { pin: true }));
  });
  applyChrome();
}

// ---- glass 3D tilt ----------------------------------------------------------
// In the glass themes, the rail's session cards tilt toward the cursor: pointer
// position feeds the --rx/--ry vars that theme-glass.css puts into their
// transform. One delegated listener, rAF-throttled; other themes pay nothing
// (early return), and stale vars are inert because only [data-glass] transforms
// read them.
//
// Desk tiles are deliberately excluded. They were the loudest thing on screen —
// a document sliding under your hand while you are trying to read it — and a
// terminal could never tilt anyway: a 3D transform makes Chromium rasterize its
// text to a texture, which the hover lift's translateZ then stretches. A card
// 200px wide can carry that movement; a work surface cannot. Tiles keep every
// other hover cue, so they still answer the cursor without moving.
function initGlassTilt() {
  let pane = null, raf = 0, lastEvent = null;
  const reset = (el) => { if (el) { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); } };
  document.addEventListener('pointermove', (e) => {
    if (!document.body.hasAttribute('data-glass')) { if (pane) { reset(pane); pane = null; } return; }
    const hit = e.target instanceof Element ? e.target.closest('.nav-card') : null;
    if (hit !== pane) { reset(pane); pane = hit; }
    if (!pane) return;
    lastEvent = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!pane || !lastEvent) return;
      const r = pane.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = (lastEvent.clientX - r.left) / r.width;
      const y = (lastEvent.clientY - r.top) / r.height;
      pane.style.setProperty('--rx', ((0.5 - y) * 5).toFixed(2) + 'deg');
      pane.style.setProperty('--ry', ((x - 0.5) * 7).toFixed(2) + 'deg');
    });
  });
  document.addEventListener('pointerleave', () => { reset(pane); pane = null; });
}

function applyChrome() {
  const sheet = q('.sheet');
  sheet.classList.toggle('rail-collapsed', S.railCollapsed);
  sheet.classList.toggle('rail-peek', S.railPeek);
  // tiles need a re-fit when the grid width changes
  setTimeout(() => { syncDeskColumns(); tileEls.forEach((t) => markFit(t)); }, 60);
}

// How many tracks the desk lays. Twice what auto-fill used to choose, so a
// default card spans two of them and measures exactly what it always did — the
// arithmetic and its proof are in desk-grid.mjs. Anything that changes the width
// available to the grid has to call this: the window, the rail, a zoom.
// The memo hangs off the function rather than a module-level `let`, because
// buildShell() calls this while the module body is still evaluating — a `let`
// declared below is in its temporal dead zone there, and reading it threw before
// the desk had drawn anything at all.
function syncDeskColumns() {
  if (!els.grid) return;
  const cs = getComputedStyle(els.grid);
  const inner = els.grid.clientWidth
    - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
  const cols = deskColumns(inner);
  if (syncDeskColumns.last === cols) return;
  syncDeskColumns.last = cols;
  els.grid.style.setProperty('--cols', String(cols));
  // Spans are stored unclamped, so a narrower desk re-renders them smaller and a
  // wider one gives them back. Only on a change, never on every resize event.
  if (els.grid.childElementCount) renderGrid();
}

function onGlobalKey(e) {
  const meta = e.metaKey || e.ctrlKey;
  // Enter renames the selected row and ⌘⌫ trashes it, the way Finder does —
  // but only when the rail is what you are looking at and nothing else has the
  // keyboard. ⌘⌫ and not a bare ⌫ is the whole point: Delete on its own is one
  // mis-keystroke away from destroying something while you meant to rename it.
  // A peek does not disqualify the rail. Clicking a file both selects the row
  // and opens its preview — that is one gesture here — and the peek never takes
  // focus, so the selection is still what the keyboard is aimed at. Same as
  // Quick Look: space previews, ⌘⌫ still trashes. Any other overlay is a real
  // modal and does own the keyboard. The activeElement test stays either way:
  // click into the peek's editor and ⌘⌫ is a text operation again.
  const peeking = S.overlay && S.overlay.type === 'peek';
  const inTree = S.railTab === 'workspace' && S.treeSel && !S.treeEdit
    && !/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');
  // Rename needs the rail actually in front of you — starting an edit hidden
  // behind a preview would put your typing somewhere you cannot see it.
  if (e.key === 'Enter' && !meta && inTree && !S.overlay) { e.preventDefault(); beginTreeRename(S.treeSel); return; }
  if (meta && (e.key === 'Backspace' || e.key === 'Delete') && inTree && (!S.overlay || peeking)) {
    e.preventDefault(); trashTreeItem(S.treeSel, dirName(S.treeSel)); return;
  }
  if (meta && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); api.newWindow(); return; }
  if (meta && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); openLauncher(); return; }
  if (meta && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openFolderDialog(); return; }
  if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openAgentPicker(); return; }
  if (meta && e.key === ',') { e.preventDefault(); openSettings(); return; }
  // ⌘W and ⌘S are also menu items now, and a menu accelerator fires instead of
  // this handler rather than as well as it. Both paths call the same function,
  // so which one the keystroke takes cannot change what it does.
  if (meta && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); closeActive(); return; }
  if (meta && (e.key === 's' || e.key === 'S')) { if (saveActive()) e.preventDefault(); return; }
  if (e.key === 'Escape') { if (S.overlay && S.overlay.type === 'peek') { requestClosePeek(); } else if (S.overlay) { closeOverlay(); } else if (S.expandedId) { S.expandedId = null; renderGrid(); } }
}

// ===========================================================================
//  Render regions
// ===========================================================================
function renderAll() { renderHeader(); renderRail(); renderGrid(); renderFooter(); renderOverlay(); applyChrome(); }

// ===========================================================================
//  Overlays, peek, and toast
// ===========================================================================
// Generic modal/overlay plumbing used by every sheet in the app — browser
// overlays, Settings, Quick Start, and everything in launcher.mjs. Kept here
// rather than moved into any one feature module: four already-extracted
// modules (panelLifecycle, browsers, termLinks, settingsPanes) depend on
// toast/overlay/closeOverlay/renderOverlay/rememberHelpFocus as plain
// (unthunked) constructor arguments, and this dispatch table itself routes
// to far more than just Launcher sheets, so it was never really any one
// module's to own.
let lastOverlayType = null; // same-type re-renders skip the entrance animation
let overlayDispose = null;
// The peek sheet mounts an editor into a rec that never joins tileEls, so a
// file changing on disk while it is floating would otherwise have nowhere to
// land. Cleared with the overlay, like overlayDispose.
let peekRec = null;
let helpReturnFocus = null;
let helpFocusKey = null;
let overlayStill = false;
function rememberHelpFocus() {
  if (!S.overlay || !['settings', 'quickstart'].includes(S.overlay.type)) helpReturnFocus = document.activeElement;
}
function renderOverlay() {
  browsers.schedule();
  terminalHint.hide();
  const focused = document.activeElement;
  helpFocusKey = focused && els.overlayRoot.contains(focused)
    ? { id: focused.id, section: focused.dataset.sec } : null;
  if (overlayDispose) { overlayDispose(); overlayDispose = null; }
  peekRec = null;
  els.overlayRoot.innerHTML = ''; const o = S.overlay;
  overlayStill = !!o && o.type === lastOverlayType;
  lastOverlayType = o ? o.type : null;
  if (!o) {
    if (helpReturnFocus && helpReturnFocus.isConnected) helpReturnFocus.focus({ preventScroll: true });
    helpReturnFocus = null;
    return;
  }
  if (!['settings', 'quickstart'].includes(o.type)) helpReturnFocus = null;
  if (o.type === 'browser-new') return browsers.renderNew();
  if (CONNECT_OVERLAYS.has(o.type)) return mcpSetup().render();
  if (o.type === 'browser-note') return browsers.renderNote();

  if (o.type === 'insertion-history') return renderInsertionHistory();
  if (o.type === 'browser-profiles') return browsers.renderProfiles();
  if (o.type === 'browser-import') return browsers.renderImport();
  if (o.type === 'selection-draft') return renderSelectionDraft();
  if (o.type === 'launcher') return renderLauncher();
  if (o.type === 'folder-first') return renderFolderFirst();
  if (o.type === 'peek') return renderPeek();
  if (o.type === 'agent-setup') return renderAgentSetup();
  if (o.type === 'agent-remove') return renderAgentRemove();
  if (o.type === 'agents') return renderAgentPickerSheet();
  if (o.type === 'create') return renderCreateSheet();
  if (o.type === 'improve-item') return renderImproveItem();
  if (o.type === 'fs-name') return renderFsName();
  if (o.type === 'switch-folder') return renderSwitchChoice();
  if (o.type === 'settings') return renderSettings();
  if (o.type === 'quickstart') return renderQuickStart();
}
function closeOverlay() { S.overlay = null; renderOverlay(); }

// ---- peek: float a file or card above the desk without touching the tiles --
function openPeek(p) {
  const cur = S.overlay && S.overlay.type === 'peek' && S.overlay.panel;
  if (cur && (cur.kind === 'editor' || cur.kind === 'card') && cur.dirty
      && !confirm(`Discard unsaved changes to ${baseNameOf(cur.filePath)}?`)) return;
  S.overlay = { type: 'peek', panel: p }; renderOverlay();
}
function renderPeek() {
  const p = S.overlay.panel;
  const browser = p.kind === 'editor' && fileKind(p.filePath) === 'html';
  const wrap = document.createElement('div'); wrap.className = 'overlay'; wrap.onclick = requestClosePeek;
  const box = document.createElement('div'); box.className = 'peek-box'; box.onclick = (e) => e.stopPropagation();
  box.innerHTML = `<div class="peek-head">
      ${panelChip(p)}
      <span class="col"><span class="pk-title">${esc(p.title)}${p.dirty ? ' •' : ''}</span><span class="pk-sub">${esc(shortHome(p.filePath))}</span></span>
      ${browser ? '<button class="btn pk-browser"></button>' : ''}
      <button class="btn btn--go pk-pin" title="Keep it open as a tile on the desk">Pin to desk</button>
      <button class="t-btn pk-x" title="Close"><span class="uni-i">✕</span><span class="pix-i">${pixIcon('close')}</span></button>
    </div><div class="peek-body"></div>`;
  wrap.appendChild(box); els.overlayRoot.appendChild(wrap);
  const rec = { body: q('.peek-body', box), peek: true };
  if (p.kind === 'editor') mountEditor(p, rec);
  else if (p.kind === 'card') mountCard(p, rec);
  else mountViewer(p, rec);
  overlayDispose = rec.disposeEditor || null;
  peekRec = rec;
  if (browser) bindBrowserButton(q('.pk-browser', box), p);
  q('.pk-pin', box).onclick = pinPeek;
  q('.pk-x', box).onclick = requestClosePeek;
}
// Pinning a page means the page, not its source: an HTML peek lands on the
// desk as a browser tile showing it rendered. The source is one click away
// in the tree, where the peek still opens with Read / Edit.
async function pinPeek() {
  const o = S.overlay; if (!o || o.type !== 'peek') return;
  const p = o.panel;
  if (p.kind === 'editor' && fileKind(p.filePath) === 'html') {
    if (p.dirty && !(await saveEditor(p))) return;
    const owner = p.owner || ownerFor(S.panels, { activeId: S.activeId, view: S.view, sessionId: S.split.sessionId });
    S.overlay = null; renderOverlay();
    browsers.open('about:blank', p.filePath, owner);
    return;
  }
  S.overlay = null; renderOverlay();
  pinFilePanel(p);
}
function requestClosePeek() {
  const o = S.overlay; if (!o || o.type !== 'peek') { closeOverlay(); return; }
  const p = o.panel;
  if ((p.kind === 'editor' || p.kind === 'card') && p.dirty
      && !confirm(`Discard unsaved changes to ${baseNameOf(p.filePath)}?`)) return;
  closeOverlay();
}

function overlay(cls, inner, opts) {
  const wrap = document.createElement('div'); wrap.className = 'overlay' + (opts && opts.top ? ' overlay--top' : ''); wrap.onclick = closeOverlay;
  const modal = document.createElement('div'); modal.className = cls; modal.onclick = (e) => e.stopPropagation(); modal.innerHTML = inner;
  if (overlayStill) modal.style.animation = 'none';
  const x = document.createElement('button'); x.className = 't-btn ov-x'; x.title = 'Close'; x.innerHTML = `<span class="uni-i">✕</span><span class="pix-i">${pixIcon('close')}</span>`; x.onclick = closeOverlay;
  modal.appendChild(x);
  wrap.appendChild(modal); els.overlayRoot.appendChild(wrap); return modal;
}

// ---- toast -----------------------------------------------------------------
let toastTimer = null;
function toast(msg) { els.toastRoot.innerHTML = `<div class="toast"><span class="dot"></span><span class="msg">${esc(msg)}</span></div>`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toastRoot.innerHTML = ''; }, 2200); }

// ===========================================================================
//  Demo seed (screenshot / preview)
// ===========================================================================
function seedDemo() {
  S.project = { path: '/Users/calvin/work/atlas', pathShort: '~/work/atlas', name: 'Atlas', hasClaude: true, tree: [], agents: [
    { slug: 'collector', name: 'collector', desc: 'Pulls structured data off pages', tools: 'browser · files · shell' },
    { slug: 'engineer', name: 'engineer', desc: 'Edits the repo, runs tests, opens a PR', tools: 'claude code · git' },
    { slug: 'researcher', name: 'researcher', desc: 'Reads the web and writes a brief', tools: 'web · sources' },
  ], skills: [] };
  S.recents = [{ path: '/Users/calvin/work/atlas', pathShort: '~/work/atlas', name: 'Atlas' }];
  // A claude tile + an editor tile so the paper grid reads clearly.
  const ct = { id: uid('p_'), kind: 'shell', chipKind: 'agent', code: 'CC', title: 'Claude session', cwd: '/Users/calvin/work/atlas', status: 'live', started: true, _demoText: true };
  const e = { id: uid('p_'), kind: 'editor', chipKind: 'editor', code: 'ED', title: 'passkey.ts', filePath: '/Users/calvin/work/atlas/src/auth/passkey.ts', dirty: true, status: 'live',
    text: `import { verifyRegistration } from './webauthn'\n\nexport async function register(user: User) {\n  const options = await createOptions(user)\n  const cred = await navigator.credentials.create({ publicKey: options })\n  return verifyRegistration(cred)\n}\n` };
  S.panels = [ct, e]; S.activeId = ct.id;
  // paint a paper "claude" banner into the demo terminal after mount
  setTimeout(() => { const t = tileEls.get(ct.id); if (t && t.term) t.term.write('\x1b[38;2;168;121;42m✻ Welcome to Claude Code\x1b[0m\r\n\r\n  \x1b[38;2;74;107;82m❯\x1b[0m Compare our pricing with the top 20 competitors\r\n\r\n  \x1b[38;2;74;122;74m✓\x1b[0m Read pricing.csv (187 rows)\r\n  \x1b[38;2;74;122;74m✓\x1b[0m Lined up 20 competitor sites\r\n  \x1b[38;2;168;121;42m●\x1b[0m Building your spreadsheet…\r\n\r\n  \x1b[38;2;141;128;101mType / for commands · esc to interrupt\x1b[0m\r\n'); }, 500);
}

function rememberContext(id, context) {
  const rec = tileEls.get(id), p = S.panels.find((p) => p.id === id); if (!rec || !p) return;
  p.contextNotes ||= []; p.contextNotes.push(context); p.contextNotes = p.contextNotes.slice(-20);
  if (!rec.contextStrip) { rec.contextStrip = document.createElement('div'); rec.contextStrip.className = 'browser-note-strip'; rec.root.appendChild(rec.contextStrip); }
  rec.contextStrip.innerHTML = `<span>${p.contextNotes.length} inserted ${p.contextNotes.length === 1 ? 'item' : 'items'}</span><button class="btn btn--small">Review</button><button class="btn btn--small">Clear history</button>`;
  const [review, hide] = rec.contextStrip.querySelectorAll('button');
  review.onclick = () => { S.overlay = { type: 'insertion-history', panelId: id }; renderOverlay(); };
  hide.onclick = () => { p.contextNotes = []; rec.contextStrip.remove(); rec.contextStrip = null; };
}
function renderInsertionHistory() {
  const id = S.overlay.panelId, p = S.panels.find(p => p.id === id);
  const entries = p?.contextNotes || [];
  const modal = overlay('modal modal--selection modal--insertion-history', `<div class="modal-head"><span class="title">Inserted items</span></div><div class="modal-body selection-sheet"><p class="note">One-time insertions into ${esc(p?.title || 'this session')}. This history does not update the source or undo messages.</p>${entries.map((n, i) => `<section><div class="context-reference">${esc(n.reference)}</div><pre class="selection-preview">${esc(n.text)}</pre><button class="btn btn--small" data-insert-again="${i}">Insert again…</button></section>`).join('') || '<p>No inserted items.</p>'}</div><div class="modal-foot"><button class="btn btn--go" id="history-done">Done</button></div>`);
  q('#history-done', modal).onclick = closeOverlay;
  modal.querySelectorAll('[data-insert-again]').forEach(b => b.onclick = () => openSelectionDraft({owner:id}, {reference:'Previously inserted item', text:entries[Number(b.dataset.insertAgain)].text}));
}
