import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';
import { shellQuote } from './file-kinds.mjs';
import { docHrefTarget } from './md.mjs';
import { shouldPushName } from './session-name.mjs';
import { selectionReference, appendDraft, terminalInsertion } from './session-draft.mjs';
import { sessionMenuItems } from './session-menu.mjs';
import { splitAfter, splitLayout, isFile as isFilePanel, isSession as isSessionPanel } from './desk-view.mjs';
import { clampSpan, clampRows, MIN_COLS, GAP, ROW } from './desk-grid.mjs';
import { clampTermFont, nextTermFont, clampDocScale, nextDocScale, TERM_FONT_DEFAULT } from './tile-zoom.mjs';
import { createClockB } from './pty-notify.mjs';
import { pixIcon } from './icons.mjs';
import { mountChatPane } from './acp-pane.mjs';

// Grid of tiles: layout/sizing, the split view, terminal/doc zoom, tile
// mounting and its shell (drag/drop, resize grip, file selection, image
// paste), and the doc-link/browser-button helpers shared by the tile
// content kinds (editor/viewer/card) that mount into it. Extracted from
// app.js — see that file's own history for the earlier extractions this
// one follows (update-bar, terminal-link-tracking, panel-lifecycle,
// settings-panes, launcher, workspace-library).
export function createTileShell({
  api, state, tiles, els,
  statusColors, esc, shorten, baseNameOf, shortHome, uid, code2, q, panelChip,
  isFileDrag, isPathDrag, isDirDrag, draggedPath, droppedPaths, dropFilesOnPanel, dropPathOnPanel,
  xtermTheme, termFontFamily, setView, syncDeskColumns, terminalHint,
  browsers, openFile, closePanel, focusPanel, savePanels, reorderPanels, toggleKeepRunning, confirmOutsideOpen, startPanel,
  showMenu, tileMenu, openOutside, refreshRail, renderHeader,
  openLauncher, openQuickStart, openFolderDialog, switchToFolder,
  registerTerminalLinks, wireTerminalMenu, oscLinkHandler, hoveredLink, panelBases,
  toggleMic, beginRename, feedSessionName, applyTitle, toast, closeOverlay, overlay, renderOverlay, rememberContext,
  // mountEditor/mountViewer/mountCard/saveEditor live in the tile-content
  // module (a follow-up extraction, not yet split out) — thunked because,
  // once that module is built, it is constructed AFTER this one, and a
  // plain reference here would be a temporal-dead-zone crash exactly like
  // the refreshRail bug caught in the workspace-library extraction.
  getMountEditor, getMountViewer, getMountCard, getSaveEditor,
}) {
  const S = state;
  const tileEls = tiles;

  function statusMeta(p) {
    const c = statusColors();
    if (p.kind === 'browser') return { label: 'browser', color: c.ok };
    if (p.kind === 'card') return { label: p.dirty ? 'unsaved' : (p.item.readOnly ? 'read-only' : p.item.type), color: p.dirty ? c.warn : c.mut };
    if (p.kind === 'viewer') return { label: p.sub, color: c.mut };
    if (p.kind === 'editor') return { label: p.dirty ? 'unsaved' : 'file', color: p.dirty ? c.warn : c.mut };
    if (p.kind === 'acp') {
      if (p.exited) return { label: 'closed', color: c.mut };
      if (p.attention) return { label: 'needs you', color: c.warn };
      if (p.working) return { label: 'working', color: c.warn };
      return { label: 'live', color: c.ok };
    }
    if (p.exited) return { label: 'closed', color: c.mut };
    // A one-shot says how its command went, not just that a shell is alive: the
    // whole reason the tile exists is the command, and "live" while sitting at a
    // finished prompt is the thing that read as a dead end.
    // installOk is set once the scan has confirmed it, because the exit code of
    // an install cannot (see finishAgentInstall). A tile still waiting on that
    // answer says 'finished', which is the only thing known for certain.
    if (p.oneShot && p.commandDone) {
      if (p.installOk === true) return { label: 'installed', color: c.ok };
      if (p.installOk === false) return { label: 'did not install', color: c.warn };
      return { label: 'finished', color: c.mut };
    }
    if (p.oneShot) return { label: 'running', color: c.warn };
    if (p.attention) return { label: 'needs you', color: c.warn };
    return { label: 'live', color: c.ok };
  }
  function kindLabel(p) {
    if (p.kind === 'browser') return 'browser';
    if (p.kind === 'card') return p.item.platform + ' ' + p.item.type + ' · ' + p.item.scope;
    if (p.kind === 'viewer') return 'viewer · ' + baseNameOf(p.filePath);
    if (p.kind === 'editor') return 'editor · ' + baseNameOf(p.filePath);
    if (p.kind === 'acp') return 'chat · ' + shortHome(p.cwd);
    if (p.kind === 'claude') return 'claude · ' + shortHome(p.cwd);
    if (p.kind === 'shell') return 'terminal · ' + shortHome(p.cwd);
    if (p.kind === 'harness') return (p.program ? baseNameOf(p.program) : 'harness') + ' · ' + shortHome(p.cwd);
    return 'run · ' + shortHome(p.cwd);
  }

  // The no-folder desk: the first screen anyone ever sees, and until now a wall
  // for the exact person the app is for. It asked for a folder and offered one
  // button to go and find one — fine if you already work in projects, useless if
  // you have never made a folder for a piece of work in your life. So it offers
  // to make one.
  //
  // Which button is green depends on whether this is a first run. With Recents
  // empty there is nothing to open, so making one is the only sensible next move
  // and it takes the emphasis. Once anything is in Recents they swap: from then
  // on, opening something that already exists is the common case, and a person
  // with folders does not want to be nudged into making another.
  function emptyDeskHtml() {
    const first = !S.recents.length;
    const make = `<button class="btn ${first ? 'btn--go ' : ''}lane-cta" id="lane-make">＋ Make me a folder</button>`;
    const open = first
      ? `<button class="btn lane-cta" id="lane-open">Choose an existing one<span class="kb"> ⌘O</span></button>`
      : `<button class="btn btn--go lane-cta" id="lane-open">＋ Open a folder<span class="kb"> ⌘O</span></button>`;
    return `<div class="lane-empty"><div class="polaroid">no folder</div>
        <div><div class="big">Open a folder to start working</div>
        <div class="hint">Every session runs inside a folder. That is what keeps it resumable.</div>
        <div class="lane-ctas">${first ? make + open : open + make}</div>
        <button class="lane-tour" id="lane-tour">New to KingAgent? Start here</button></div></div>`;
  }

  // Hands off to the save panel in main, then through the ordinary switch path —
  // a folder KingAgent made is not a special kind of folder once it exists.
  async function makeFolderDialog() {
    const info = await api.makeFolder();
    if (!info) return;
    if (info.error) { toast('Could not make that folder — ' + info.error); return; }
    await switchToFolder(info);
    toast(`Made ${info.name}. Open “Start here” for what to do next.`);
  }

  function renderGrid() {
    if (!S.panels.length) {
      tileEls.forEach((t) => { if (t.disposeBrowser) t.disposeBrowser(); t.root.remove(); }); tileEls.clear();
      els.grid.classList.remove('has-focus');
      // The empty lane is not a card and must not be laid out on the card grid —
      // it is one block that wants the whole canvas, and a 210px row track would
      // cut it off. Its own box, not a track.
      els.grid.classList.add('is-empty');
      // Two empty desks, one shape: a heading, a line of why, and the button that
      // does the thing. The folder-open one used to be the exception — it told you
      // to press a key and offered nothing to click, which is the one state in the
      // app where the next step was homework. Its hint also still named Claude Code
      // alone, from when that was the only session KingAgent could start.
      els.grid.innerHTML = S.project
        ? `<div class="lane-empty"><div class="polaroid">nothing open</div>
        <div><div class="big">Start a session</div>
        <div class="hint">Agents, terminals and harnesses. They all run in this folder.</div>
        <button class="btn btn--go lane-cta" id="lane-new">＋ New session<span class="kb"> ⌘N</span></button></div></div>`
        : emptyDeskHtml();
      const make = q('#lane-make', els.grid); if (make) make.onclick = makeFolderDialog;
      const tour = q('#lane-tour', els.grid); if (tour) tour.onclick = openQuickStart;
      const cta = q('#lane-open', els.grid); if (cta) cta.onclick = openFolderDialog;
      const start = q('#lane-new', els.grid); if (start) start.onclick = () => openLauncher();
      browsers.decorate();
      return;
    }
    els.grid.classList.remove('is-empty');
    if (q('.lane-empty', els.grid)) els.grid.innerHTML = '';
    for (const [id, t] of tileEls) { if (!S.panels.find((p) => p.id === id)) { if (t.disposeRo) t.disposeRo(); if (t.disposeEditor) t.disposeEditor(); if (t.disposeBrowser) t.disposeBrowser(); t.root.remove(); tileEls.delete(id); } }
    els.grid.classList.toggle('has-focus', !!S.expandedId);
    // Moving a node takes the keyboard with it: insertBefore below re-parents the
    // tile, and the browser drops focus from whatever was inside it — for a
    // session tile that is xterm's hidden textarea. Expanding a tile goes straight
    // through here without focusPanel(), so nothing put the keyboard back and the
    // terminal silently stopped accepting input until the tile was clicked again.
    // Remember who had it, and give it back once the moves are done.
    const focused = document.activeElement;
    const focusedTile = focused && focused.closest ? focused.closest('.tile') : null;
    const refocusId = focusedTile ? focusedTile.dataset.id : null;
    // Moving a DOM node restarts its CSS animation, so settled tiles stay put.
    let cursor = els.grid.firstElementChild;
    const inPane = (p) => S.view === 'split' && (p.id === S.split.sessionId || p.id === S.split.fileId);
    for (const p of S.panels) {
      if (!tileEls.has(p.id)) mountTile(p);
      const t = tileEls.get(p.id);
      t.root.classList.toggle('focused', p.id === S.expandedId);
      t.root.classList.toggle('active', p.id === S.activeId);
      refreshTileHead(p);
      if (inPane(p)) continue;                 // the split's two cards are placed below
      if (t.root === cursor) cursor = cursor.nextElementSibling;
      else els.grid.insertBefore(t.root, cursor);
      applySpan(p, t);
      if (t.fit) markFit(t);
    }
    renderSplit();
    browsers.decorate();
    // Only if the move actually cost us the keyboard — never steal it from a
    // rename box, the rail, or an overlay that opened during the render.
    const now = document.activeElement;
    if (refocusId && !(now && now.closest && now.closest('.tile'))) {
      const t = tileEls.get(refocusId);
      if (t) { if (t.term) t.term.focus(); else if (t.ta) t.ta.focus(); }
    }
  }

  // ---- the split view -------------------------------------------------------
  // Two panes beside the (hidden) grid: the chosen session card on the left, one
  // of its files on the right, each the whole tile re-parented — head, body,
  // terminal and all. Every other card stays mounted in the grid, unseen, so a
  // terminal keeps running and Desk brings everything back untouched.
  function renderSplit() {
    const main = els.grid.parentElement;
    let pv = q('.paneview', main);
    if (S.view !== 'split') {
      // renderGrid already moved the two cards back into the grid; only the frame is left
      if (pv) { pv._resize?.disconnect(); for (const el of Array.from(pv.querySelectorAll('.tile'))) els.grid.appendChild(el); pv.remove(); }
      main.classList.remove('is-split');
      return;
    }
    main.classList.add('is-split');
    // The state may be stale — set at boot before the desk was restored, or
    // pointing at a card that closed. Repair it against the panels that exist.
    const fixed = splitAfter({ ...S.split, panels: S.panels }, { type: 'close' });
    if (fixed.sessionId !== S.split.sessionId || fixed.fileId !== S.split.fileId) { S.split = fixed; S.splitFull = null; }
    if (!pv) {
      pv = document.createElement('div'); pv.className = 'paneview';
      pv.innerHTML = '<div class="pane-switch" role="group" aria-label="Visible pane"><button data-pane="agent">Session</button><button data-pane="files">File</button></div><div class="pane pane-agent"></div><div class="pane-divider" title="Drag to resize"></div><div class="pane pane-files"></div>';
      main.insertBefore(pv, els.grid);
      wireDivider(pv);
      pv.querySelectorAll('[data-pane]').forEach((b) => { b.onclick = () => {
        const id = b.dataset.pane === 'agent' ? S.split.sessionId : S.split.fileId;
        if (id) focusPanel(id);
      }; });
      pv._resize = new ResizeObserver(() => syncSplitLayout(pv));
      pv._resize.observe(pv);
    }
    syncSplitLayout(pv);
    pv.classList.toggle('full-agent', S.splitFull === 'agent');
    pv.classList.toggle('full-files', S.splitFull === 'files');
    const place = (host, id, emptyText) => {
      const want = id ? tileEls.get(id) : null;
      for (const el of Array.from(host.children)) {
        if (want && el === want.root) continue;
        if (el.classList.contains('tile')) els.grid.appendChild(el); else el.remove();
      }
      if (want) {
        if (want.root.parentElement !== host) { host.appendChild(want.root); want.root.style.gridColumn = ''; want.root.style.gridRow = ''; }
        want.root.classList.remove('focused');
        if (want.fit) markFit(want);
      } else if (!q('.pane-empty', host)) {
        const e = document.createElement('div'); e.className = 'pane-empty'; e.textContent = emptyText; host.appendChild(e);
      }
    };
    const sess = S.split.sessionId ? S.panels.find((x) => x.id === S.split.sessionId) : null;
    place(q('.pane-agent', pv), S.split.sessionId, 'No session — ⌘N starts one');
    place(q('.pane-files', pv), S.split.fileId, sess ? `No files with ${sess.title} yet — open one from the Workspace tab` : 'Open a file from the Workspace tab');
  }
  function syncSplitLayout(pv) {
    const cs = getComputedStyle(pv);
    const width = pv.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const layout = splitLayout(width, S.splitRatio);
    pv.classList.toggle('is-compact', layout.compact);
    pv.style.setProperty('--split', layout.left + 'px');
    pv.dataset.show = S.activeId === S.split.fileId ? 'files' : 'agent';
    pv.querySelectorAll('[data-pane]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.pane === pv.dataset.show));
      b.disabled = !(b.dataset.pane === 'agent' ? S.split.sessionId : S.split.fileId);
    });
  }
  // The line between the panes: drag it, the left pane keeps the width.
  function wireDivider(pv) {
    const div = q('.pane-divider', pv);
    div.onmousedown = (e) => {
      e.preventDefault(); ptyDiscrete();
      const r = pv.getBoundingClientRect();
      const cs = getComputedStyle(pv);
      const left = parseFloat(cs.paddingLeft || '0');
      const mv = (ev) => {
        const width = pv.clientWidth - left - parseFloat(cs.paddingRight || '0');
        const px = splitLayout(width, (ev.clientX - r.left - left) / (width - 20)).left;
        S.splitRatio = px / (width - 20); syncSplitLayout(pv);
        tileEls.forEach((t) => { if (t.fit && t.root.closest('.paneview')) markFit(t); });
      };
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    };
  }
  // In split, ⤢ fills the desk with one pane instead of hiding the other cards.
  function toggleSplitFull(id) {
    const which = id === S.split.sessionId ? 'agent' : id === S.split.fileId ? 'files' : null;
    if (!which) return;
    S.splitFull = S.splitFull === which ? null : which;
    renderSplit();
  }

  // A card's size is two numbers it keeps: how many columns and how many rows it
  // asked for. What it gets is whatever fits the desk it is on right now.
  //
  // Stored unclamped, on purpose. Clamping on the way in would mean narrowing the
  // window permanently destroyed a 4-wide card — it would come back as 2 and stay
  // there. Clamping on the way out means the desk gives it back the moment there
  // is room again.
  //
  // Focus is not a size. While a tile is focused the stylesheet owns its
  // placement, so the inline properties come off and go back on afterwards —
  // which is why ⤢ twice returns a 3×2 card to 3×2 and not to the default.
  function applySpan(p, t) {
    if (!t || !t.root) return;
    if (t.root.parentElement && t.root.parentElement.classList.contains('pane')) return; // a pane owns the size
    if (p.id === S.expandedId) { t.root.style.gridColumn = ''; t.root.style.gridRow = ''; return; }
    const cols = syncDeskColumns.last || MIN_COLS;
    t.root.style.gridColumn = 'span ' + clampSpan(p.spanX, cols);
    t.root.style.gridRow = 'span ' + clampRows(p.spanY);
  }

  // ---- the grip ---------------------------------------------------------------
  // The card you are holding is the thing that moves. On grab it lifts out of the
  // grid and follows the hand pixel for pixel — live content, no scrim, no ghost
  // outline. A slot (a real grid item) holds its place, so the moment the drag
  // crosses a column line the slot's span changes and the neighbours reflow
  // around it: you watch the final layout happen while you are still holding.
  // Release settles the card into the slot.
  //
  // The first version froze the card and moved a dashed outline instead, out of
  // fear of refitting a terminal per frame. That fear belonged to the old
  // single-clock world: clock A repaints the canvas cheaply on every frame, and
  // clock B still tells the agent exactly once — rec.holdPty parks it until the
  // drop. What the outline method actually bought was a drag where nothing on
  // screen follows your hand, which reads as the app being stuck.
  function wireGrip(p, rec, grip) {
    const commit = (x, y) => {
      const changed = p.spanX !== x || p.spanY !== y;
      p.spanX = x; p.spanY = y;
      renderGrid();
      if (changed) savePanels();
    };

    grip.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      ptyDiscrete();
      commit(MIN_COLS, MIN_COLS);
      toast('Card size · reset');
    });

    // Sizing without a mouse. The grip keeps focus across the re-render, or the
    // second press would go to the document and scroll the desk instead.
    grip.addEventListener('keydown', (e) => {
      const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!dx && !dy) return;
      e.preventDefault(); e.stopPropagation();
      const cols = syncDeskColumns.last || MIN_COLS;
      ptyDiscrete();
      commit(clampSpan(clampSpan(p.spanX, cols) + dx, cols), clampRows(clampRows(p.spanY) + dy));
      const again = tileEls.get(p.id);
      if (again) { const g = q('.tile-grip', again.root); if (g) g.focus(); }
    });

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();   // the header owns dragging the card; the corner owns sizing it
      const grid = els.grid;
      const cs = getComputedStyle(grid);
      const inner = grid.clientWidth
        - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
      const cols = syncDeskColumns.last || MIN_COLS;
      const pitchX = (inner + GAP) / cols;     // one column plus the gap after it
      const pitchY = ROW + GAP;
      const startW = rec.root.offsetWidth, startH = rec.root.offsetHeight;
      const left = rec.root.offsetLeft, top = rec.root.offsetTop;
      let sx = clampSpan(p.spanX, cols), sy = clampRows(p.spanY);
      let moved = false;

      // The slot: keeps the card's place in the flow and shows where it lands.
      // Its corners are read off the tile itself, so every theme's slot matches
      // every theme's card — glass is 22px, paper is square, and a theme added
      // later is right without knowing this code exists.
      const slot = document.createElement('div');
      slot.className = 'desk-slot';
      slot.style.gridColumn = 'span ' + sx;
      slot.style.gridRow = 'span ' + sy;
      slot.style.borderRadius = getComputedStyle(rec.root).borderRadius;
      const tag = document.createElement('span');
      tag.className = 'ds-size';
      tag.textContent = sx + ' × ' + sy;
      slot.appendChild(tag);
      grid.insertBefore(slot, rec.root);

      // Lift: absolute takes the tile out of grid flow (the slot keeps its seat),
      // and explicit width/height make it follow the hand. Its ResizeObserver
      // keeps firing, so clock A refits the live terminal on every frame of this.
      rec.root.classList.add('lifting');
      rec.root.style.position = 'absolute';
      rec.root.style.left = left + 'px';
      rec.root.style.top = top + 'px';
      rec.root.style.width = startW + 'px';
      rec.root.style.height = startH + 'px';
      rec.holdPty = true;                 // clock B waits for the drop
      clockB.setHold(p.id, true);

      const place = (w, h) => {
        rec.root.style.width = w + 'px';
        rec.root.style.height = h + 'px';
        const nx = clampSpan(Math.round((w + GAP) / pitchX), cols);
        const ny = clampRows(Math.round((h + GAP) / pitchY));
        if (nx !== sx || ny !== sy) {
          sx = nx; sy = ny;
          slot.style.gridColumn = 'span ' + sx;
          slot.style.gridRow = 'span ' + sy;
          tag.textContent = sx + ' × ' + sy;
        }
      };

      const move = (ev) => {
        if (Math.abs(ev.clientX - e.clientX) > 2 || Math.abs(ev.clientY - e.clientY) > 2) moved = true;
        place(Math.max(80, startW + (ev.clientX - e.clientX)),
              Math.max(60, startH + (ev.clientY - e.clientY)));
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        slot.remove();
        rec.root.classList.remove('lifting');
        rec.root.style.position = ''; rec.root.style.left = ''; rec.root.style.top = '';
        rec.root.style.width = ''; rec.root.style.height = '';
        rec.holdPty = false;
        clockB.setHold(p.id, false);
        // A press that never moved is not a resize: no commit, no re-render, no
        // message to the agent — and the stored ask is left alone, which is what
        // keeps a stray click from overwriting a clamped card's remembered size.
        if (!moved) { clockB.clearPending(p.id); markFit(rec); return; }
        ptyDiscrete();                    // the drop is one committed change
        commit(sx, sy);
        markFit(rec);
        // The one message. Usually the post-drop refit changes cols and raises it
        // itself (which clears pending). When the final size matches the last
        // live fit, no resize event fires and nothing would ever tell the agent —
        // this backstop sends the parked notification, and only then.
        setTimeout(() => {
          if (clockB.isPending(p.id) && rec.term) {
            clockB.flushPending(p.id, rec.term.cols, rec.term.rows);
          }
        }, 60);
      };
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  const MIC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v3"/></svg>`;
  // terminal text size: one shared preference, defaulting smaller in the glass
  // themes because SF Mono renders larger than Courier Prime at equal px
  const TERM_FONT_KEY = 'kingagent-term-fontsize';
  function defaultTermFont() {
    try { return clampTermFont(localStorage.getItem(TERM_FONT_KEY), TERM_FONT_DEFAULT); }
    catch (_) { return TERM_FONT_DEFAULT; }
  }
  function termFontOf(p) { return clampTermFont(p && p.fontSize, defaultTermFont()); }
  // Zero, every theme. Tracking inherits into xterm's hidden measuring element,
  // which then reports a cell narrower than the font actually paints — same
  // right-edge clipping as a fractional size. Courier Prime wanted 0.2; SF Mono
  // does not need it.
  function termLetterSpacing() { return 0; }

  // The terminal draws with the DOM renderer, not the GPU one. The WebGL addon
  // is sharper and much faster on a wall of output, but it repaints by damage and
  // leaves the undamaged canvas alone — so anything it fails to mark dirty stays
  // on screen. In practice that was a block of stale pixels lying across live
  // text, and Claude's welcome banner surviving five redraws stacked on itself.
  // Same command, same build, the addon the only difference.
  //
  // It is a real gain when it works, and worth trying again: what made it fire so
  // often was the column count being wrong, which resized the terminal ten times
  // in the first tenth of a second. That is fixed now (see .term-body in
  // paper.css). The vendored addon stays in ./vendor for that attempt.
  // One tap used to tell every open agent to repaint, immediately — four taps
  // across three sessions was twelve messages and three redrawn screens. The size
  // still applies to every tile at once (it is one shared preference), but the
  // canvas redraw and the agent's notification are now on separate clocks, so a
  // run of taps settles into one message per session.
  function bumpTermFont(dir, p) {
    const rec = tileEls.get(p.id);
    const next = nextTermFont(termFontOf(p), dir, defaultTermFont());
    p.fontSize = next;
    savePanels();
    if (rec && rec.term) { rec.term.options.fontSize = next; markFit(rec); }
    else if (p.kind === 'acp' && rec) rec.body.style.zoom = String(next / defaultTermFont());
    toast('This session · ' + next + 'px');
  }
  // ---- document text size ------------------------------------------------------
  // Its own dial, separate from the terminal's. 12px monospace and a page of prose
  // are different jobs and one number cannot serve both: turning the terminal up to
  // read what an agent is doing would otherwise turn your notes into billboards.
  //
  // Same rule as the terminal's, though — scale now, and if there is a pty behind
  // it, tell it once you stop.
  const isDocTile = (p) => ['card', 'viewer', 'editor'].includes(p.kind);
  const DOC_SCALE_KEY = 'kingagent-doc-scale';
  function defaultDocScale() {
    try { return clampDocScale(localStorage.getItem(DOC_SCALE_KEY), 1); }
    catch (_) { return 1; }
  }
  function docScaleOf(p) { return clampDocScale(p && p.docScale, defaultDocScale()); }
  function applyDocScale(p, rec) {
    if (!rec || !rec.root) return;
    const s = docScaleOf(p);
    if (s === 1) rec.root.style.removeProperty('--doc-scale');
    else rec.root.style.setProperty('--doc-scale', String(s));
  }
  // Both layers of an editor scroll together, so anchoring the textarea is enough —
  // assigning its scrollTop fires the scroll handler that drags the underlay and
  // the line numbers along with it.
  function docScrollers(rec) {
    return [...rec.root.querySelectorAll('.md-read, .ed-area')];
  }
  function bumpDocFont(dir, p) {
    const rec = tileEls.get(p.id);
    const next = nextDocScale(docScaleOf(p), dir, defaultDocScale());
    p.docScale = next;
    savePanels();
    // Where you were reading, as a fraction of the document — the pixel offset is
    // meaningless once every line is a different height.
    const marks = rec ? docScrollers(rec).map((el) => {
      const room = el.scrollHeight - el.clientHeight;
      return { el, frac: room > 0 ? el.scrollTop / room : 0 };
    }) : [];
    applyDocScale(p, rec);
    // New scale means new wrap points — remeasure the gutter before the scroll
    // position is put back, or the fraction lands against stale heights.
    if (rec && rec.edSync) rec.edSync();
    requestAnimationFrame(() => {
      for (const m of marks) {
        const room = m.el.scrollHeight - m.el.clientHeight;
        m.el.scrollTop = room > 0 ? Math.round(m.frac * room) : 0;
      }
    });
    toast('This file · ' + Math.round(next * 100) + '%');
  }

  function spawnTerminalTwin(p, draft) {
    // Same agent, same folder, same session where the CLI can resume it —
    // and the half-typed message rides along as the seed. The chat pane
    // closes; the conversation continues in the terminal.
    const a = (S.agents || []).find((x) => x.id === p.agentId);
    const seed = draft || undefined;
    let spawned;
    if (p.agentId === 'claude' || (a && a.kind === 'claude')) {
      spawned = startPanel({ kind: 'claude', title: p.title || 'Claude session', code: 'CC', cwd: p.cwd, sid: p.acpSid, cont: !!p.acpSid, seed });
    } else if (a && a.bin) {
      spawned = startPanel({ kind: 'run', title: p.title || a.name, code: code2(a.name), command: a.bin, cwd: p.cwd, acpSid: p.acpSid, cont: !!p.acpSid, seed });
    } else {
      toast('Open it from ⌘N — new session, pick the agent.');
      return;
    }
    if (spawned) closePanel(p.id);
  }
  // The agent's own name for a chat, over the ACP channel or from its store on
  // disk. Same rung as a terminal's transcript name: it upgrades a prompt guess
  // and never touches a name you typed. ('ai' used to be its own source here,
  // unknown to session-name.mjs and so ranked at zero — a later prompt guess
  // could overwrite the agent's name.)
  function adoptChatTitle(p, title) { applyTitle(p, shorten(String(title), 60), 'agent'); }
  // The first message sent from a card names it at once, as Enter does in a
  // terminal tile; the newline is what commits the draft.
  function promptNamesChat(p, text) { if (p.autoName) feedSessionName(p, String(text || '') + '\n'); }
  function mountTile(p) {
    const root = document.createElement('div'); root.className = 'tile enter'; root.dataset.id = p.id;
    root.addEventListener('animationend', (e) => { if (e.target === root) root.classList.remove('enter'); });
    setTimeout(() => root.classList.remove('enter'), 600); // occluded windows throttle animations — drop it regardless
    root.innerHTML = `<div class="tile-head" draggable="true">
        ${panelChip(p)}
        <span class="col"><span class="t-title">${esc(p.title)}</span><span class="t-sub"></span></span>
        <span class="t-status"><span class="dot"></span><span class="lbl"></span></span>
        <button class="t-btn t-mic" title="Dictate into this session">${MIC_SVG}</button>
        <button class="t-btn t-zoom-out" title="${isDocTile(p) ? 'Smaller text' : 'Smaller terminal text'}"><span class="uni-i">−</span><span class="pix-i">${pixIcon('minus')}</span></button>
        <button class="t-btn t-zoom-in" title="${isDocTile(p) ? 'Bigger text' : 'Bigger terminal text'}"><span class="uni-i">＋</span><span class="pix-i">${pixIcon('plus')}</span></button>
        <button class="t-btn t-expand" title="Expand"><span class="uni-i">⤢</span><span class="pix-i">${pixIcon('expand')}</span></button>
        <button class="t-btn t-close" title="Close"><span class="uni-i">✕</span><span class="pix-i">${pixIcon('close')}</span></button>
      </div><div class="tile-body"></div>`;
    const head = q('.tile-head', root), body = q('.tile-body', root);
    const rec = { root, head, body, term: null, fit: null, statusDot: q('.t-status .dot', head), ta: null, gutter: null };
    tileEls.set(p.id, rec);
    // The grip lives on the card, not in its header — the corner is the thing
    // itself rather than a button that opens a way to do the thing, and the header
    // is already at the width where it starts dropping controls.
    const grip = document.createElement('div');
    grip.className = 'tile-grip';
    grip.tabIndex = 0;
    grip.setAttribute('role', 'slider');
    grip.setAttribute('aria-label', 'Resize ' + p.title);
    grip.title = 'Drag to resize · double-click to reset · arrow keys';
    root.appendChild(grip);
    wireGrip(p, rec, grip);
    q('.t-mic', head).onclick = (e) => { e.stopPropagation(); toggleMic(p); };
    const zi = q('.t-zoom-in', head), zo = q('.t-zoom-out', head);
    const bump = isDocTile(p) ? bumpDocFont : bumpTermFont;
    if (zi) zi.onclick = (e) => { e.stopPropagation(); bump(+1, p); };
    if (zo) zo.onclick = (e) => { e.stopPropagation(); bump(-1, p); };
    if (isDocTile(p)) applyDocScale(p, rec);
    q('.t-title', head).addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(p, q('.t-title', head)); });
    // Expand is a committed change, not a gesture — every tile it moves is told
    // on the next frame, not 140ms later, so one press is one movement.
    q('.t-expand', head).onclick = (e) => { e.stopPropagation(); ptyDiscrete(); if (S.view === 'split') { toggleSplitFull(p.id); return; } S.expandedId = S.expandedId === p.id ? null : p.id; renderGrid(); };
    q('.t-close', head).onclick = (e) => { e.stopPropagation(); closePanel(p.id); };
    head.addEventListener('mousedown', (e) => { if (!e.target.closest('.t-btn')) focusPanel(p.id, false); });
    // drag reorder
    head.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; root.classList.add('dragging'); });
    head.addEventListener('dragend', () => root.classList.remove('dragging'));
    if (isSessionPanel(p)) head.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, sessionMenuItems(p, {
      addBrowser: () => browsers.newBrowser(p.id),
      toggleKeepRunning: () => toggleKeepRunning(p),
    })); };
    if (isFilePanel(p)) head.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, tileMenu(p)); };
    root.addEventListener('dragover', (e) => {
      e.preventDefault(); e.stopPropagation();
      // Stopped for the same reason the drop below is: every tile is a direct
      // child of els.grid, whose own dragover refuses a folder. Without this the
      // tile names its effect and the grid immediately overwrites it — a folder
      // dropped on a session would light up copy, turn no-drop, and never arrive.
      //
      // A workspace path reads as a file arriving, not as a tile being reordered,
      // and it says copy: the row you are holding stays exactly where it lives.
      // Except on an editor or a viewer, which take a file to open and have
      // nothing to do with a folder — refused in the cursor, not silently on drop.
      if (isPathDrag(e)) {
        if (isDirDrag(e) && (p.kind === 'editor' || p.kind === 'viewer')) { e.dataTransfer.dropEffect = 'none'; return; }
        e.dataTransfer.dropEffect = 'copy'; root.classList.add('file-hint'); return;
      }
      root.classList.add(isFileDrag(e) ? 'file-hint' : 'drop-hint');
    });
    root.addEventListener('dragleave', () => root.classList.remove('drop-hint', 'file-hint'));
    root.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      root.classList.remove('drop-hint', 'file-hint');
      const paths = droppedPaths(e);
      if (paths.length) return dropFilesOnPanel(p, paths);
      // Before the reorder fallback: text/plain holds a path here, not a panel id,
      // and reorderPanels would look for a panel called /Users/... and find none.
      if (isPathDrag(e)) {
        const path = draggedPath(e);
        if (path) return dropPathOnPanel(p, path, isDirDrag(e));
      }
      reorderPanels(e.dataTransfer.getData('text/plain'), p.id);
    });

    if (p.kind === 'browser') browsers.mount(p, rec); else if (p.kind === 'editor') getMountEditor()(p, rec); else if (p.kind === 'viewer') getMountViewer()(p, rec); else if (p.kind === 'card') getMountCard()(p, rec); else if (p.kind === 'acp') mountChatPane(p, rec, { settled: clearAttention, wake: setAttention, open: (f) => openFile(f), toast, rename: adoptChatTitle, prompt: promptNamesChat, status: refreshTileHead, terminal: spawnTerminalTwin, annotationImage:async image=>{const r=await api.browserAnnotationImage({action:'read',id:image.id});if(!r.ok)throw new Error(r.error);return {type:'image',data:r.data,mimeType:r.mimeType};} }); else mountTerminal(p, rec);
    if (isFilePanel(p) && p.kind !== 'browser') wireFileSelection(p, rec);
  }

  function refreshTileHead(p) {
    const t = tileEls.get(p.id);
    if (!t) {
      if (S.overlay && S.overlay.type === 'peek' && S.overlay.panel === p) {
        const el = q('.pk-title'); if (el) el.textContent = p.title + (p.dirty ? ' •' : '');
      }
      return;
    }
    const m = statusMeta(p);
    const titleEl = q('.t-title', t.head);
    if (!titleEl.querySelector('input')) { // mid-rename: leave the input alone
      titleEl.textContent = p.title + (p.kind === 'editor' && p.dirty ? ' •' : '');
      titleEl.title = p.title + ' — double-click to rename';
    }
    const owner = p.owner ? S.panels.find((x) => x.id === p.owner) : null;
    q('.t-sub', t.head).textContent = kindLabel(p) + (owner ? ' · ' + shorten(owner.title, 22) : '');
    q('.t-status .lbl', t.head).textContent = m.label;
    t.statusDot.style.background = m.color;
    t.root.classList.toggle('attention', !!p.attention);
    t.root.classList.toggle('exited', !!p.exited);
    if (t.refreshImages) t.refreshImages();
  }

  // ---- terminal tiles --------------------------------------------------------

  // ---- the two clocks --------------------------------------------------------
  // Resizing a terminal is two jobs, and they were welded together: term.onResize
  // called api.termResize directly, so there was no way to redraw the canvas
  // without also telling the agent. Recomputing the canvas is cheap, local and
  // invisible to anyone else. Telling the pty makes Claude throw its screen away
  // and repaint, slicing whatever was scrolled above it — that is the crop on
  // expand, the mangling on collapse, and every open session being told at once
  // when you tapped ＋.
  //
  // Clock A (markFit → fitCanvas) repaints, once per frame across every tile.
  // Clock B (notifyPty) tells the agent, once, when the gesture stops.
  //
  // Every surface then follows from the rule rather than needing its own handling:
  // expand, collapse, the font buttons and a slow drag on the window edge are all
  // the same two clocks at different speeds.
  const dirtyFits = new Set();
  let fitFrame = null;
  function markFit(rec) {
    if (!rec || !rec.term || !rec.fit) return;
    dirtyFits.add(rec);
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => { fitFrame = null; drainFits(); });
  }
  function drainFits() {
    const batch = [...dirtyFits];
    dirtyFits.clear();
    for (const rec of batch) fitCanvas(rec);
  }

  // How long a gesture has to be still before the agent is told. The settle is
  // for CONTINUOUS gestures only — a window-edge drag, where the size keeps
  // changing and coalescing is the point. A committed change — expand, collapse,
  // a grip drop — is one movement. Discrete used to mean delay 0 for 300ms,
  // which fired once per extra fit frame (the stacked chrome). It now trails
  // 32ms so those frames become one SIGWINCH, still on the same paint.
  const clockB = createClockB({
    send: (m) => api.termResize(m),
    now: () => performance.now(),
    schedule: (ms, fn) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h),
  });
  function ptyDiscrete() { clockB.discrete(); }
  function notifyPty(p, rec) {
    if (!rec.term) return;
    clockB.notify(p.id, rec.term.cols, rec.term.rows);
  }

  function fitCanvas(rec) {
    if (!rec || !rec.term || !rec.fit) return;
    // A hidden terminal measures zero. addon-fit would round that up to its
    // minimum and resize the pty to a couple of columns — and claude reflows to
    // whatever it is told, so the session would come back from the card view
    // wrapped one word per line.
    //
    // Left marked rather than dropped, so it is redrawn on the frame it becomes
    // visible. Dropping it is why a tile came back from a collapse at the size it
    // held before the expand, and stayed there until something else nudged it.
    // No frame is scheduled here — the ResizeObserver fires the moment the tile
    // has a size, and that is what drains this.
    if (!rec.body.clientWidth || !rec.body.clientHeight) { dirtyFits.add(rec); return; }
    // One resize from FitAddon's proposal, then at most one overflow clip.
    // Both happen in this turn; Clock B coalesces them into one pty notify.
    let dim;
    try { dim = rec.fit.proposeDimensions(); } catch (_) { return; }
    if (!dim || isNaN(dim.cols) || isNaN(dim.rows)) return;
    const term = rec.term;
    if (term.cols !== dim.cols || term.rows !== dim.rows) {
      try { term.resize(dim.cols, dim.rows); } catch (_) { return; }
    }
    try {
      const body = rec.body;
      const screen = body.querySelector('.xterm-screen'); if (!screen) return;
      const cs = getComputedStyle(body);
      const limit = body.getBoundingClientRect().right
        - parseFloat(cs.borderRightWidth || '0') - parseFloat(cs.paddingRight || '0');
      const sr = screen.getBoundingClientRect();
      const overflow = sr.right - limit;
      if (overflow > 0 && term.cols > 20) {
        const cell = sr.width / term.cols;
        term.resize(term.cols - Math.ceil(overflow / cell), term.rows);
      }
    } catch (_) {}
  }

  function mountTerminal(p, rec) {
    const term = new Terminal({
      fontFamily: termFontFamily(), fontSize: termFontOf(p), letterSpacing: termLetterSpacing(),
      // 1.45 rather than 1.35: an agent writes paragraphs, not log lines, and at
      // 1.35 a long answer reads as one block of grey.
      lineHeight: 1.45,
      theme: xtermTheme(), cursorBlink: true, allowTransparency: true, allowProposedApi: true,
      scrollback: 6000,
      // Bold is the one weight distinction the stream actually carries — Claude
      // uses it for headings and emphasis — so let it be properly bold, and let
      // bold text take the bright half of the palette.
      fontWeight: 400, fontWeightBold: 700, drawBoldTextInBrightColors: true,
      minimumContrastRatio: 6,
      linkHandler: oscLinkHandler(p),
    });
    const fit = new FitAddon(); term.loadAddon(fit); rec.body.classList.add('term-body'); term.open(rec.body); rec.term = term; rec.fit = fit;
    if (S.demo) (window.__terms = window.__terms || []).push(term);
    requestAnimationFrame(() => {
      fitCanvas(rec);
      if (p.sceneStatic) return; // a fixture tile draws, it never runs
      startProcess(p, term.cols, term.rows);
    });
    term.onData((d) => { clearAttention(p); if (p.autoName) feedSessionName(p, d); api.termWrite({ id: p.id, data: d }); });
    // Clock B, and the only place it is wound. This used to call api.termResize
    // straight through, which is what made the canvas and the agent one job.
    term.onResize(() => notifyPty(p, rec));
    term.onBell(() => setAttention(p));
    term.onScroll(() => terminalHint.hide(p));
    registerTerminalLinks(term, p);
    wireTerminalMenu(p, rec);
    mountSessionImages(p, rec);
    // Clock A. No debounce of its own: redrawing the canvas is cheap and wanted on
    // every frame the tile changes size. The delay that used to live here was
    // protecting the pty, and the pty has its own settle now — which is also why a
    // slow window-edge drag no longer looks frozen while you hold it.
    const ro = new ResizeObserver(() => markFit(rec));
    ro.observe(rec.body);
    // a closed tile must not leave the link it was hovering behind in the map
    rec.disposeRo = () => {
      clockB.forget(p.id); dirtyFits.delete(rec); ro.disconnect(); hoveredLink.delete(p.id); terminalHint.hide(p);
      for (const k of panelBases.keys()) if (k.startsWith(p.id + ':')) panelBases.delete(k);
    };
  }

  // A selection is captured before opening a menu or moving keyboard focus.
  function captureFileSelection(p, rec) {
    const ta = rec.ta;
    if (ta && ta.getClientRects().length && ta.selectionEnd > ta.selectionStart) {
      return selectionReference({ path: p.filePath || p.title, source: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && rec.body.contains(selection.anchorNode) && rec.body.contains(selection.focusNode)) {
      return selectionReference({ path: p.filePath || p.title, text: selection.toString() });
    }
    return null;
  }
  function wireFileSelection(p, rec) {
    const bar = document.createElement('div'); bar.className = 'selection-actions'; bar.hidden = true;
    const button = document.createElement('button'); button.className = 'btn'; bar.appendChild(button); rec.root.appendChild(bar);
    const update = () => {
      rec.selection = captureFileSelection(p, rec);
      bar.hidden = !rec.selection;
      if (rec.selection) button.textContent = (rec.selection.startLine ? `${rec.selection.endLine - rec.selection.startLine + 1} lines selected · ` : 'Selection · ') + 'Add to session… ⇧⌘↵';
    };
    rec.body.addEventListener('mouseup', update);
    rec.body.addEventListener('keyup', update);
    rec.body.addEventListener('select', update, true);
    button.onmousedown = (e) => e.preventDefault();
    button.onclick = () => openSelectionDraft(p, rec.selection);
    rec.body.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        update(); if (rec.selection) { e.preventDefault(); e.stopPropagation(); openSelectionDraft(p, rec.selection); }
      }
    });
    rec.body.addEventListener('contextmenu', (e) => {
      const selection = captureFileSelection(p, rec); if (!selection) return;
      e.preventDefault(); e.stopPropagation();
      const sessions = S.panels.filter(isSessionPanel).filter((s) => !s.exited);
      showMenu(e.clientX, e.clientY, sessions.length ? sessions.map((s) => ({ label: `Send to ${s.title}…`, run: () => openSelectionDraft(p, selection, s.id) })) : [{ label: 'No open session', off: true }]);
    });
  }
  function openSelectionDraft(p, selection, destination) {
    if (!selection || !selection.text) return;
    const sessions = S.panels.filter(isSessionPanel).filter((s) => !s.exited);
    if (!sessions.length) { toast('Open a session first.'); return; }
    S.overlay = { type: 'selection-draft', selection, note: '', destination: destination || (sessions.some((s) => s.id === p.owner) ? p.owner : sessions[0].id) };
    renderOverlay();
  }
  function renderSelectionDraft() {
    const o = S.overlay;
    const sessions = S.panels.filter(isSessionPanel).filter((s) => !s.exited);
    const modal = overlay('modal modal--selection', `<div class="modal-head"><span class="title">Insert selection into session</span></div>
      <div class="modal-body selection-sheet"><div class="field-label">Sessions</div><div class="selection-recipients">${sessions.map((s) => `<label><input type="checkbox" data-selection-session="${esc(s.id)}"${(o.destinations || [o.destination]).includes(s.id) ? ' checked' : ''}${o.inserted?.includes(s.id) ? ' disabled' : ''}>${esc(s.title)} · ${tileEls.get(s.id)?.aiInput ? 'chat input' : 'terminal input'}${o.inserted?.includes(s.id) ? ' · inserted' : ''}</label>`).join('')}</div>
      <div class="context-reference">${esc(o.selection.reference)}</div><pre class="selection-preview">${esc(o.selection.text)}</pre>
      <label>Optional note<textarea id="selection-note" rows="3">${esc(o.note)}</textarea></label></div>
      <div class="modal-foot"><span class="note">Inserts into the session input without submitting.</span><button class="btn" id="selection-cancel">Cancel</button><button class="btn btn--go" id="selection-add">Insert into session</button></div>`);
    modal.querySelectorAll('[data-selection-session]').forEach((b) => { b.onchange = () => { o.destinations = [...modal.querySelectorAll('[data-selection-session]:checked')].map((b) => b.dataset.selectionSession); }; });
    q('#selection-note', modal).oninput = (e) => { o.note = e.target.value; };
    q('#selection-cancel', modal).onclick = closeOverlay;
    q('#selection-add', modal).onclick = async () => {
      q('#selection-add', modal).disabled = true;
      const text = (o.note ? o.note + '\n\n' : '') + o.selection.reference + '\n\n' + o.selection.text;
      const ids = (o.destinations || [o.destination]).filter((id) => !o.inserted?.includes(id));
      if (!ids.length) { toast('Choose a session.'); q('#selection-add', modal).disabled = false; return; }
      o.inserted ||= [];
      for (const id of ids) if (await insertSessionText(id, text, { focus: ids.length === 1 })) { o.inserted.push(id); rememberContext(id, { reference: o.selection.reference, text, insertedAt: Date.now() }); }
      if (ids.every((id) => o.inserted.includes(id))) { o.selection.onInserted?.(); closeOverlay(); } else renderOverlay();
    };
    q('#selection-note', modal).focus();
  }
  async function insertSessionText(id, text, { focus = true } = {}) {
    const p = S.panels.find((s) => s.id === id && isSessionPanel(s) && !s.exited);
    const rec = p && tileEls.get(id);
    if (!rec) { toast('That session is no longer available.'); return false; }
    if (rec.aiInput) {
      rec.aiInput.value = appendDraft(rec.aiInput.value, text);
      rec.aiInput.dispatchEvent(new Event('input', { bubbles: true }));
      if (focus) { focusPanel(id, false, { preserveLayout:true }); if (S.activeId === id) rec.aiInput.focus(); }
      return true;
    }
    if (!rec.term) { toast('That session is no longer available.'); return false; }
    const data = terminalInsertion(text, rec.term.modes.bracketedPasteMode);
    if (data === null) { toast('This terminal does not support safe multiline insertion. The selection is kept here.'); return false; }
    try {
      const result = await api.termWrite({ id, data });
      if (!result?.ok) throw new Error('write failed');
      if (focus) { focusPanel(id, false, { preserveLayout:true }); if (S.activeId === id) { rec.term.scrollToBottom(); rec.term.focus(); } }
      return true;
    } catch (_) { toast('Could not insert into that terminal.'); return false; }
  }
  function wireImagePaste(p, rec) {
    rec.root.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.items || []).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation();
      rec.pasteQueue = (rec.pasteQueue || Promise.resolve()).then(async () => {
        for (const file of files) {
          if (p.exited || !S.panels.includes(p)) { toast('That session is no longer available.'); return; }
          if ((p.imageAttachments || []).length >= 20) { toast('Hide or remove an image before adding more.'); return; }
          const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
          const saved = await api.savePastedImage(dataUrl);
          if (!saved || !saved.ok) { toast(saved?.error || 'Could not save the image.'); continue; }
          if (!S.panels.includes(p)) return;
          p.imageAttachments = p.imageAttachments || [];
          if (!p.imageAttachments.some((a) => a.path === saved.path)) {
            p.imageAttachments.push({ id: uid('image_'), path: saved.path, thumbnail: saved.thumbnail });
          }
          await insertSessionText(p.id, shellQuote(saved.path) + ' ');
          rec.refreshImages(); savePanels();
        }
      }).catch(() => toast('Could not paste that image.'));
    }, true);
  }
  function mountSessionImages(p, rec) {
    const strip = document.createElement('div');
    strip.className = 'image-strip session-images'; strip.setAttribute('aria-label', 'Pasted images');
    rec.root.appendChild(strip);
    let signature = '';
    rec.refreshImages = () => {
      const next = JSON.stringify([!!p.exited, p.imageAttachments || []]);
      if (next === signature) return;
      signature = next;
      strip.innerHTML = '';
      for (const image of p.imageAttachments || []) {
        const item = document.createElement('div'); item.className = 'image-attachment';
        item.innerHTML = `<button class="image-open" title="Open pasted image"><img alt="Pasted image" src="${esc(image.thumbnail)}"></button><button class="image-insert">Insert path</button><button class="image-remove" title="Hide thumbnail; keeps the file and terminal text">Hide</button>`;
        q('.image-open', item).onclick = () => { focusPanel(p.id); openFile(image.path, { pin: true }); };
        const insert = q('.image-insert', item); insert.disabled = !!p.exited;
        insert.onclick = async () => {
          insert.disabled = true;
          await insertSessionText(p.id, shellQuote(image.path) + ' ');
          insert.disabled = !!p.exited;
        };
        q('.image-remove', item).onclick = () => {
          p.imageAttachments = p.imageAttachments.filter((a) => a.id !== image.id);
          rec.refreshImages(); savePanels();
        };
        strip.appendChild(item);
      }
      strip.hidden = !strip.childElementCount;
    };
    wireImagePaste(p, rec); rec.refreshImages();
  }

  async function startProcess(p, cols, rows) {
    if (p.started) return; p.started = true;
    // A name KingAgent chose deliberately rides down into claude, so the conversation
    // reads the same from every other surface that lists it.
    const name = shouldPushName(p.titleSource) ? p.title : null;
    await api.termCreate({ id: p.id, cwd: p.cwd, cols, rows, kind: p.kind, command: p.command, program: p.program, args: p.args, seed: p.seed, cont: p.cont, sid: p.sid, acpSid: p.acpSid, name, watchDone: !!p.watchDone });
  }
  function setAttention(p) { if (p.id === S.activeId) return; p.attention = true; refreshTileHead(p); refreshRail(); renderHeader(); }
  function clearAttention(p) { if (!p.attention) return; p.attention = false; refreshTileHead(p); refreshRail(); renderHeader(); }

  // ---- links inside a rendered doc -------------------------------------------
  // The same three destinations as a terminal link — browser, here, Finder —
  // plus headings, which stay inside the doc. An href the resolver does not
  // recognise does nothing at all: rendered markdown never drives navigation.
  function headingSlug(s) {
    return String(s || '').trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  }
  async function openDocLink(href, p, read) {
    const t = docHrefTarget(href, p.filePath);
    if (t.kind === 'url') { api.openUrl(t.target); return; }
    if (t.kind === 'anchor') {
      const want = t.target.toLowerCase();
      const head = Array.from(read.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .find((h) => headingSlug(h.textContent) === want);
      if (head) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (t.kind !== 'path') return;
    const st = await api.statPath({ token: t.target, cwd: p.cwd, id: p.id });
    if (!st.exists) { toast('Not found: ' + shortHome(t.target)); return; }
    if (st.isFile) { if (confirmOutsideOpen(st.abs)) openFile(st.abs); }
    else api.revealFile(st.abs);
  }

  // Mirror the Edit tab's dragged column widths into a rendered Read pane.
  // Widths are keyed by table order and never serialized — GFM has nowhere to
  // put them — so this is session state following the reader across tabs.
  function applyDocColWidths(read, colWidths) {
    if (!colWidths) return;
    const tables = read.querySelectorAll('.md-tablewrap > table');
    tables.forEach((table, index) => {
      const widths = colWidths[index];
      const row = table.rows[0];
      if (!Array.isArray(widths) || !row || row.cells.length !== widths.length) return;
      const colgroup = document.createElement('colgroup');
      widths.forEach((w) => {
        const col = document.createElement('col');
        if (w) col.style.width = w + 'px';
        colgroup.appendChild(col);
      });
      table.insertBefore(colgroup, table.firstChild);
      table.style.tableLayout = 'fixed';
      table.style.width = widths.reduce((sum, w) => sum + (w || 0), 0) + 'px';
    });
  }

  function browserPanelFor(filePath) {
    const peek = S.overlay && S.overlay.type === 'peek' && S.overlay.panel;
    if (peek && peek.filePath === filePath) return peek;
    return S.panels.find((p) => p.filePath === filePath) || null;
  }
  function browserButtonLabel(button, p) {
    if (!button) return;
    button.innerHTML = p && p.dirty ? 'Save &amp; open in Chrome ↗' : 'Open in Chrome ↗';
    button.title = p && p.dirty
      ? 'Save this page, then open it in Chrome'
      : 'Open this saved page in Chrome';
  }
  function bindBrowserButton(button, p) {
    if (!button) return;
    button._browserPanel = p;
    browserButtonLabel(button, p);
    button.onclick = () => openOutside(p);
  }
  function refreshBrowserButtons(p) {
    document.querySelectorAll('.pk-browser, .ed-browser').forEach((button) => {
      if (button._browserPanel === p) browserButtonLabel(button, p);
    });
  }
  async function openFileInBrowser(filePath, panel) {
    const p = panel || browserPanelFor(filePath);
    if (p && p.dirty) {
      const saved = await getSaveEditor()(p);
      if (!saved) return;
    }
    closeOverlay();
    browsers.open('about:blank', filePath, p?.owner);
    setView('split');
  }

  return {
    statusMeta, kindLabel, makeFolderDialog, renderGrid, syncSplitLayout, refreshTileHead, markFit, clearAttention,
    openSelectionDraft, insertSessionText, renderSelectionDraft, openFileInBrowser, docScaleOf, openDocLink,
    applyDocColWidths, bindBrowserButton, refreshBrowserButtons, termFontOf, termLetterSpacing,
  };
}
