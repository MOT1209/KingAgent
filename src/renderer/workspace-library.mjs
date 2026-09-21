import { fileKind, tailPath, pathRef } from './file-kinds.mjs';
import { decideReload } from './file-sync.mjs';
import { tileMenuItems } from './tile-menu.mjs';
import { isFile as isFilePanel, isSession as isSessionPanel, groupRail } from './desk-view.mjs';
import { SHELF_GROUPS, MAC_GROUP_KEYS, CLI_ORDER, shelfOf, cliKey, serviceShelf, shouldLoadMac, macCountLabel } from './library-groups.mjs';
import { receiversOf } from './receivers.mjs';
import { shortAge } from './rel-time.mjs';
import { chipHtml, iconKeyFor, treeIcon, pixIcon } from './icons.mjs';

// Extracted from app.js verbatim, as part of splitting that file into
// smaller feature modules.
//
// The workspace tree (with rename-in-place, drag & drop, disk-watcher sync),
// the generic right-click context-menu widget, the sessions/library rail
// tabs, and the project/theme topbar popovers.
export function createWorkspaceLibrary({ api, state, tiles, els, overlay, toast, closeOverlay, renderOverlay, closeFinished, getPeekRec,
  terminalHint, esc, q, shortHome, REVEAL_LABEL, getPanelType, getPathType, getDirType,
  openFolderDialog, openFolder, openFile, moveFileTo, moveMenu, focusPanel,
  saveEditor, openFileInBrowser, insertSessionText, statusMeta, kindLabel, panelChip, beginRename,
  openCard, openConnect, openCreate, openServiceDetails, refreshAgents, currentTheme, setTheme }) {
  const S = state;

  function renderHeader() {
    const p = S.project; els.topbarCenter.innerHTML = '';
    const chip = document.createElement('div'); chip.className = 'project-chip';
    chip.innerHTML = p
      ? `<span class="folder-glyph">${treeIcon('', 'dir', true)}</span><span class="name">${esc(p.name)}</span><span class="path">${esc(p.pathShort)}</span><span class="caret">▼</span>`
      : `<span class="folder-glyph">${treeIcon('', 'dir', false)}</span><span class="name">Open a folder</span><span class="caret">▼</span>`;
    chip.onclick = (e) => { e.stopPropagation(); toggleProjectsPop(); };
    els.topbarCenter.appendChild(chip);
    // An errand whose command has landed is not a live session — its shell is
    // still open, but nothing is running in it and counting it makes the badge
    // say two sessions are working when one of them is a finished install.
    const live = S.panels.filter((x) => x.status === 'live' && isSessionPanel(x)
      && !(x.oneShot && x.commandDone)).length;
    const attn = S.panels.filter((x) => x.attention).length;
    if (live > 0) { els.liveBadge.style.display = ''; els.liveLabel.textContent = attn ? `${attn} needs you` : `${live} live`; els.liveBadge.classList.toggle('attn', attn > 0); }
    else els.liveBadge.style.display = 'none';
  }
  function projectRowHtml(r) {
    if (r.missing) {
      return `<button class="project-row dead" data-path="${esc(r.path)}" title="${esc(r.path)}">
        <span class="folder-glyph">${treeIcon('', 'dir', false)}</span>
        <span class="col"><span class="name">${esc(r.name)}</span><span class="summary">moved or deleted — locate…</span></span>
        <span class="mark row-forget" title="Remove from Recents">✕</span></button>`;
    }
    return `<button class="project-row" data-path="${esc(r.path)}" title="${esc(r.path)}">
      <span class="mark row-pin${r.pinned ? ' on' : ''}" title="${r.pinned ? 'Unpin' : 'Pin to the top'}">${r.pinned ? '●' : '○'}</span>
      <span class="folder-glyph">${treeIcon('', 'dir', false)}</span>
      <span class="col"><span class="name">${esc(r.name)}</span><span class="summary">${esc(r.pathShort)}</span></span>
      <span class="row-age">${esc(shortAge(r.at))}</span>
      <span class="mark row-newwin" title="Open in a new window">⧉</span>
      <span class="mark row-forget" title="Remove from Recents">✕</span></button>`;
  }

  function toggleProjectsPop() {
    const ex = q('.projects-pop'); if (ex) { ex.remove(); return; }
    const pop = document.createElement('div'); pop.className = 'projects-pop';
    // Pinned folders are the ones you live in, so they get their own group above
    // the churn — a stray peek at ~/Downloads can never push them down.
    const all = S.recents || [];
    const pinned = all.filter((r) => r.pinned);
    const rest = all.filter((r) => !r.pinned);
    const group = (label, rows) => rows.length ? `<div class="pop-label">${label}</div>${rows.map(projectRowHtml).join('')}` : '';
    const body = pinned.length
      ? group('Pinned', pinned) + group('Recent', rest)
      : group('Recent folders', rest);
    pop.innerHTML = `${body || '<div class="rail-empty">No recent folders yet.</div>'}
      <button class="project-open-other" id="open-other"><span class="plus">＋</span><span>Open another folder…</span><span class="kbd">⌘O</span></button>
      <button class="project-open-other" id="open-newwin"><span class="plus">⧉</span><span>New window</span><span class="kbd">⇧⌘N</span></button>`;
    // fixed + measured + parked on body, not absolute-in-topbar: the topbar clips
    // its descendants (overflow backstop for ⌘+ zoom), and renderHeader() rebuilds
    // topbar-center's innerHTML, which would silently eat the pop.
    const anchor = els.topbarCenter.getBoundingClientRect();
    pop.style.left = (anchor.left + anchor.width / 2) + 'px';
    pop.style.top = (anchor.top + 46) + 'px';
    document.body.appendChild(pop);
    const reopen = () => { const p = q('.projects-pop'); if (p) p.remove(); toggleProjectsPop(); };
    pop.querySelectorAll('.project-row').forEach((row) => {
      const path = row.dataset.path;
      const dead = row.classList.contains('dead');
      // A dead row offers the only useful thing left: point at where it went.
      row.onclick = async () => { pop.remove(); if (dead) openFolderDialog(); else await openFolder(path); };
      const pin = q('.row-pin', row);
      if (pin) pin.onclick = async (e) => {
        e.stopPropagation();
        S.recents = await api.recentsPin(path, !row.querySelector('.row-pin').classList.contains('on'));
        reopen();
      };
      const win = q('.row-newwin', row);
      if (win) win.onclick = (e) => { e.stopPropagation(); pop.remove(); api.newWindow(path); };
      q('.row-forget', row).onclick = async (e) => {
        e.stopPropagation();
        S.recents = await api.recentsRemove(path);
        reopen();
      };
    });
    q('#open-other', pop).onclick = () => { pop.remove(); openFolderDialog(); };
    q('#open-newwin', pop).onclick = () => { pop.remove(); api.newWindow(); };
    // The reopen path rebuilds the pop inside a click, so arm the dismiss listener
    // on the next tick or it fires on the very click that opened this one.
    setTimeout(() => document.addEventListener('click', function off() { pop.remove(); document.removeEventListener('click', off); }, { once: true }), 0);
  }

  // ---- theme popover (◐ in the topbar) ---------------------------------------
  const THEME_OPTIONS = [
    { id: 'paper', name: 'paper', desc: 'cream desk' },
    { id: 'operator', name: 'operator', desc: 'dark ops' },
    { id: 'glass', name: 'glass', desc: 'liquid glass' },
    { id: 'graphite', name: 'graphite', desc: 'dark glass' },
    { id: 'soft', name: 'soft', desc: 'off-white' },
    { id: 'dusk', name: 'dusk', desc: 'soft dark' },
  ];
  function positionThemePop() {
    const pop = q('.theme-pop'), zone = q('#theme-zone');
    if (!pop || !zone) return;
    const anchor = zone.getBoundingClientRect();
    const right = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, window.innerWidth - anchor.right));
    pop.style.right = right + 'px';
    pop.style.top = (anchor.bottom + 8) + 'px';
    pop.style.maxHeight = Math.max(80, window.innerHeight - anchor.bottom - 16) + 'px';
    pop.style.overflowY = 'auto';
  }
  function toggleThemePop() {
    const ex = q('.theme-pop'); if (ex) { ex.remove(); return; }
    const pop = document.createElement('div'); pop.className = 'theme-pop';
    pop.innerHTML = `<div class="pop-label">Appearance</div>` + THEME_OPTIONS.map((t) =>
      `<button class="theme-opt${currentTheme() === t.id ? ' picked' : ''}" data-theme-id="${t.id}" aria-pressed="${currentTheme() === t.id}">
        <span class="theme-dot"></span><span class="theme-name">${t.name}</span><span class="theme-desc">${t.desc}</span></button>`).join('');
    pop.onclick = (e) => e.stopPropagation();
    // fixed + measured + parked on body — same clipping story as the projects pop
    document.body.appendChild(pop);
    positionThemePop();
    pop.querySelectorAll('.theme-opt').forEach((b) => {
      b.onclick = () => {
        setTheme(b.dataset.themeId);
        pop.querySelectorAll('.theme-opt').forEach((o) => {
          const picked = o.dataset.themeId === currentTheme();
          o.classList.toggle('picked', picked); o.setAttribute('aria-pressed', String(picked));
        });
      };
    });
    setTimeout(() => document.addEventListener('click', function off() { pop.remove(); document.removeEventListener('click', off); }, { once: true }), 0);
  }

  function renderRail() { document.querySelectorAll('.rail-tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.railTab)); refreshRail(); }
  // Rebuilds wipe the tab's scroller, so its position is saved and put back.
  const RAIL_SCROLLER = { sessions: '.rail-list', workspace: '.tree', library: '.lib-list' };
  const railScroll = {};
  function refreshRail() {
    const c = els.railContent;
    const sel = RAIL_SCROLLER[S.railTab];
    const prev = q(sel, c); if (prev) railScroll[S.railTab] = prev.scrollTop;
    c.innerHTML = '';
    if (S.railTab === 'sessions') refreshSessionsRail(c);
    else if (S.railTab === 'library') refreshLibraryRail(c);
    else refreshWorkspaceRail(c);
    const next = q(sel, c); if (next && railScroll[S.railTab]) next.scrollTop = railScroll[S.railTab];
  }
  function refreshSessionsRail(c) {
    const head = document.createElement('div'); head.className = 'rail-head';
    head.innerHTML = `<span class="title">Sessions</span>${S.panels.length ? '<span class="action" id="clear-all">close finished</span>' : ''}`;
    c.appendChild(head);
    const cl = q('#clear-all', head); if (cl) cl.onclick = closeFinished;
    if (!S.panels.length) { const e = document.createElement('div'); e.className = 'rail-empty'; e.textContent = 'No sessions yet. Press ⌘N, or type a message below.'; c.appendChild(e); return; }
    // Sessions first, each with the files that joined it folded under it; files
    // with no live session last, under "Desk" (desk-view.mjs). In split the
    // highlight follows the two panes, on the desk the card you last clicked.
    const list = document.createElement('div'); list.className = 'rail-list';
    const split = S.view === 'split';
    const shownFile = split ? S.split.fileId : null;
    const isActive = (p) => (split ? p.id === S.split.sessionId || p.id === shownFile : p.id === S.activeId);
    const PANEL_TYPE = getPanelType();
    const fileRow = (f) => {
      const m = statusMeta(f);
      const row = document.createElement('div');
      row.className = 'nav-file' + (isActive(f) ? ' sel' : '') + (f.preview ? ' preview' : '');
      row.dataset.id = f.id; row.draggable = true; row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-pressed', String(isActive(f)));
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusPanel(f.id); } };
      row.innerHTML = `${panelChip(f)}<span class="name goal" title="${esc(f.title)}">${esc(f.title)}</span><span class="status" style="color:${m.color}">${esc(m.label)}</span>`;
      row.onclick = () => focusPanel(f.id);
      row.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, moveMenu(f)); };
      // drag a file row onto a session row (or the Desk heading) to move it
      row.ondragstart = (e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData(PANEL_TYPE, f.id); e.dataTransfer.setData('text/plain', f.id); } catch (_) {} row.classList.add('dragging'); };
      row.ondragend = () => row.classList.remove('dragging');
      return row;
    };
    const dropTarget = (el, ownerId) => {
      el.addEventListener('dragover', (e) => { if (!Array.from(e.dataTransfer.types).includes(PANEL_TYPE)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-into'); });
      el.addEventListener('dragleave', () => el.classList.remove('drop-into'));
      el.addEventListener('drop', (e) => { el.classList.remove('drop-into'); const id = e.dataTransfer.getData(PANEL_TYPE); if (!id) return; e.preventDefault(); e.stopPropagation(); const f = S.panels.find((x) => x.id === id); if (f && isFilePanel(f)) moveFileTo(f, ownerId); });
    };
    const g = groupRail(S.panels);
    for (const { session: p, files } of g.sessions) {
      const m = statusMeta(p);
      const folded = S.railFold.has(p.id);
      const row = document.createElement('div');
      row.className = 'nav-card' + (isActive(p) ? ' active' : '') + (p.attention ? ' attn' : '');
      row.dataset.id = p.id;
      const count = files.length ? `<button type="button" class="count" aria-expanded="${!folded}" title="${folded ? 'Show files' : 'Hide files'}"><span class="tw">${folded ? '▸' : '▾'}</span>${files.length} ${files.length === 1 ? 'file' : 'files'}</button>` : '';
      row.innerHTML = `${panelChip(p)}
        <span class="col"><span class="goal" title="${esc(p.title)} — double-click to rename">${esc(p.title)}</span><span class="sid">${esc(kindLabel(p))}</span></span>
        <span class="nav-meta"><span class="status" style="color:${m.color}">${p.attention ? '● ' : ''}${esc(m.label)}</span>${count}</span>`;
      row.onclick = () => focusPanel(p.id);
      q('.goal', row).addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(p, q('.goal', row)); });
      const cnt = q('.count', row);
      if (cnt) cnt.onclick = (e) => { e.stopPropagation(); if (folded) S.railFold.delete(p.id); else S.railFold.add(p.id); refreshRail(); q(`.nav-card[data-id="${p.id}"] .count`)?.focus({ preventScroll: true }); };
      dropTarget(row, p.id);
      list.appendChild(row);
      if (files.length && !folded) {
        const grp = document.createElement('div'); grp.className = 'nav-files';
        for (const f of files) grp.appendChild(fileRow(f));
        list.appendChild(grp);
      }
    }
    if (g.desk.length) {
      if (g.sessions.length) { const h = document.createElement('div'); h.className = 'nav-group'; h.textContent = 'Desk'; dropTarget(h, null); list.appendChild(h); }
      const grp = document.createElement('div'); grp.className = 'nav-files nav-files--desk';
      for (const f of g.desk) grp.appendChild(fileRow(f));
      list.appendChild(grp);
    }
    c.appendChild(list);
  }
  function refreshWorkspaceRail(c) {
    const p = S.project;
    const wrap = document.createElement('div'); wrap.className = 'tree';
    if (!p) { wrap.innerHTML = '<div class="rail-empty">Open a folder (⌘O) to browse and edit files.</div>'; c.appendChild(wrap); return; }
    const head = document.createElement('div'); head.className = 'tree-path';
    const pathSpan = document.createElement('span'); pathSpan.className = 'path'; pathSpan.textContent = p.pathShort;
    const toggle = document.createElement('span'); toggle.className = 'action';
    toggle.textContent = S.treeAll ? 'essentials' : 'show all';
    toggle.title = S.treeAll ? 'Hide build output, dotfiles and node_modules' : 'Show every file, including hidden and ignored ones';
    toggle.onclick = () => {
      S.treeAll = !S.treeAll;
      localStorage.setItem('kingagent-tree-all', S.treeAll ? '1' : '0');
      S.tree = {};
      api.listDir(p.path, S.treeAll).then((rows) => { S.tree[p.path] = rows; refreshRail(); });
    };
    // Creating a file has always worked — it was just right-click-only, which for
    // most people means it did not exist. Same menu the header's context menu
    // opens, on something you can see. Both glyphs, because glass and graphite
    // swap every chrome mark for its pixel twin.
    const plus = document.createElement('span');
    plus.className = 'tree-new'; plus.title = 'New file or folder';
    plus.setAttribute('role', 'button'); plus.tabIndex = 0;
    plus.innerHTML = `<span class="uni-i">＋</span><span class="pix-i">${pixIcon('plus')}</span>`;
    const openNewMenu = (x, y) => showMenu(x, y, [
      { label: 'New file…', run: () => openFsName('file', newTargetDir()) },
      { label: 'New folder…', run: () => openFsName('folder', newTargetDir()) },
    ]);
    plus.onclick = (e) => { e.stopPropagation(); const r = plus.getBoundingClientRect(); openNewMenu(r.left, r.bottom + 4); };
    plus.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); const r = plus.getBoundingClientRect(); openNewMenu(r.left, r.bottom + 4);
    };
    head.appendChild(pathSpan); head.appendChild(plus); head.appendChild(toggle); wrap.appendChild(head);
    head.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: REVEAL_LABEL, run: () => api.revealFile(p.path) },
        { label: 'New file…', run: () => openFsName('file', p.path) },
        { label: 'New folder…', run: () => openFsName('folder', p.path) },
      ]);
    };
    // the header stands for the root, so a drag can be dropped on it to move
    // something back up out of a folder
    wireDrop(head, () => p.path);
    // first look at this folder (e.g. right after boot): fetch the root level once
    if (!S.tree[p.path]) api.listDir(p.path, S.treeAll).then((rows) => { S.tree[p.path] = rows; if (S.railTab === 'workspace') refreshRail(); });
    renderTreeLevel(wrap, p.path, 0);
    c.appendChild(wrap);
  }

  // Where the ＋ creates: the folder you have selected, the folder of the file you
  // have selected, or the root.
  function newTargetDir() {
    const root = S.project.path;
    const sel = S.treeSel;
    if (!sel) return root;
    for (const [dir, rows] of Object.entries(S.tree)) {
      for (const n of rows || []) if (n.path === sel) return n.kind === 'dir' ? n.path : dir;
    }
    return root;
  }
  function renderTreeLevel(container, dir, depth) {
    const children = S.tree[dir];
    if (!children) return;
    const PATH_TYPE = getPathType(), DIR_TYPE = getDirType();
    for (const n of children) {
      const row = document.createElement('div'); row.className = 'tree-row';
      if (n.path === S.treeSel) row.classList.add('sel');
      if (S.treeFresh.has(n.path)) row.classList.add('landed');
      row.style.paddingLeft = (6 + depth * 13) + 'px';
      row.style.setProperty('--d', String(depth));
      row.dataset.path = n.path; row.dataset.kind = n.kind; row.dataset.dir = dir;
      const isOpen = S.expanded.has(n.path);
      const glyph = n.kind === 'dir' ? (isOpen ? '▾' : '▸') : '';
      if (S.treeEdit && S.treeEdit.path === n.path) { renderRenameRow(row, n, dir, glyph, isOpen); container.appendChild(row); continue; }
      row.draggable = true;
      row.innerHTML = `<span class="tw">${glyph}</span><span class="icon">${treeIcon(n.name, n.kind, isOpen)}</span>
        <span class="name" style="font-weight:${n.kind === 'dir' ? 700 : 400}">${esc(n.name)}</span><span class="meta">${esc(n.meta)}</span>`;
      // On the desk a click peeks; in split it opens the file into the session
      // on the left and keeps it there — every file you open stays.
      row.onclick = () => { S.treeSel = n.path; if (n.kind === 'dir') toggleDir(n.path); else { openFile(n.path, S.view === 'split' ? { pin: true } : undefined); refreshRail(); } };
      row.oncontextmenu = (e) => { e.preventDefault(); S.treeSel = n.path; showMenu(e.clientX, e.clientY, treeMenu(n, dir)); };
      row.ondragstart = (e) => {
        S.treeDrag = n.path;
        row.classList.add('dragging');
        // copyMove, not move. This is not about the cursor picture: a dropEffect
        // outside effectAllowed is not merely ignored, it cancels the drop
        // outright (Blink drag_controller: operation becomes kNone). With 'move'
        // alone, the tile asking for 'copy' below would have killed its own drop.
        // Folder targets are unaffected — wireDrop names dropEffect = 'move'
        // itself, which is still a member.
        e.dataTransfer.effectAllowed = 'copyMove';
        try {
          e.dataTransfer.setData('text/plain', n.path);
          e.dataTransfer.setData(PATH_TYPE, n.path);
          if (n.kind === 'dir') e.dataTransfer.setData(DIR_TYPE, n.path);
        } catch (_) {}
      };
      row.ondragend = () => { S.treeDrag = null; row.classList.remove('dragging'); clearDropMarks(); };
      // A file row stands for the folder that holds it — the same near-miss
      // forgiveness Finder gives you.
      wireDrop(row, () => (n.kind === 'dir' ? n.path : dir));
      container.appendChild(row);
      if (n.kind === 'dir' && isOpen) renderTreeLevel(container, n.path, depth + 1);
    }
  }
  async function toggleDir(dir) {
    if (S.expanded.has(dir)) { S.expanded.delete(dir); refreshRail(); return; }
    if (!S.tree[dir]) S.tree[dir] = await api.listDir(dir, S.treeAll);
    S.expanded.add(dir); refreshRail();
  }

  // ---- rename in place --------------------------------------------------------
  function beginTreeRename(path) { S.treeEdit = { path }; refreshRail(); }
  function renderRenameRow(row, n, dir, glyph, isOpen) {
    row.classList.add('editing');
    row.innerHTML = `<span class="tw">${glyph}</span><span class="icon">${treeIcon(n.name, n.kind, isOpen)}</span>`;
    const input = document.createElement('input');
    input.className = 'tree-rename'; input.value = n.name; input.spellcheck = false;
    row.appendChild(input);
    let done = false;
    const finish = async () => {
      if (done) return; done = true;
      const name = input.value.trim();
      S.treeEdit = null;
      if (!name || name === n.name) { refreshRail(); return; }
      const res = await api.fsRename({ root: S.project.path, src: n.path, name });
      if (!res.ok) { toast(res.error || 'Could not rename'); refreshRail(); return; }
      // the expanded set is keyed on paths, so a renamed folder has to carry its
      // open state across or it silently collapses under you
      if (S.expanded.has(n.path)) { S.expanded.delete(n.path); S.expanded.add(res.path); }
      delete S.tree[n.path];
      S.treeSel = res.path;
      await refreshTreeDir(dir);
    };
    setTimeout(() => {
      input.focus();
      const dot = n.name.lastIndexOf('.');
      // Finder's rule: select the stem, leave the extension out of it
      if (n.kind === 'file' && dot > 0) input.setSelectionRange(0, dot); else input.select();
    }, 20);
    input.onblur = finish;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      if (e.key === 'Escape') { e.preventDefault(); done = true; S.treeEdit = null; refreshRail(); }
    };
  }

  // ---- drag: move within the tree, import from outside it ---------------------
  function clearDropMarks() { document.querySelectorAll('.tree-row.drop-into, .tree-path.drop-into').forEach((el) => el.classList.remove('drop-into')); }
  let dropHoverTimer = null, dropHoverPath = null;
  function cancelHoverExpand() { if (dropHoverTimer) clearTimeout(dropHoverTimer); dropHoverTimer = null; dropHoverPath = null; }

  function wireDrop(el, destFn) {
    el.ondragover = (e) => {
      const dest = destFn();
      // refuse a folder into itself or below itself before the cursor suggests it
      if (S.treeDrag && isUnder(S.treeDrag, dest)) { clearDropMarks(); cancelHoverExpand(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = S.treeDrag ? 'move' : 'copy';
      clearDropMarks(); el.classList.add('drop-into');
      // hold over a closed folder and it opens, so you can drag somewhere you
      // have not looked yet
      if (el.dataset && el.dataset.kind === 'dir' && !S.expanded.has(dest)) {
        if (dropHoverPath !== dest) {
          cancelHoverExpand(); dropHoverPath = dest;
          dropHoverTimer = setTimeout(() => { toggleDir(dest); }, 600);
        }
      } else cancelHoverExpand();
    };
    el.ondragleave = () => { el.classList.remove('drop-into'); cancelHoverExpand(); };
    el.ondrop = async (e) => {
      e.preventDefault(); e.stopPropagation();
      clearDropMarks(); cancelHoverExpand();
      const dest = destFn();
      const root = S.project.path;
      const files = e.dataTransfer.files;
      if (files && files.length) {
        // from Finder. droppedFilePath, never File.path — removed in Electron 32.
        const srcPaths = [...files].map((f) => api.droppedFilePath(f)).filter(Boolean);
        if (!srcPaths.length) { toast('Could not read what was dropped.'); return; }
        const res = await api.fsImport({ root, destDir: dest, srcPaths });
        if (!res.ok) { toast(res.error || 'Could not copy that in'); return; }
        S.expanded.add(dest);
        markFresh(res.paths);
        await refreshTreeDir(dest);
        toast(res.paths.length === 1 ? 'Copied in ' + baseName(res.paths[0]) + '.' : 'Copied in ' + res.paths.length + ' items.');
        return;
      }
      const src = S.treeDrag; S.treeDrag = null;
      if (!src) return;
      const srcDir = dirName(src);
      if (srcDir === dest) return;
      const res = await api.fsMove({ root, src, destDir: dest });
      if (!res.ok) { toast(res.error); return; }
      S.expanded.delete(src); delete S.tree[src];
      S.expanded.add(dest); S.treeSel = res.path;
      markFresh([res.path]);
      await refreshTreeDir(srcDir); await refreshTreeDir(dest);
      toast('Moved ' + baseName(src) + '.');
    };
  }
  function dirName(p) { const i = String(p).lastIndexOf('/'); return i > 0 ? p.slice(0, i) : p; }
  function baseName(p) { return String(p).slice(String(p).lastIndexOf('/') + 1); }
  // Same rule as isDescendant in fs-actions.js. Duplicated rather than shared
  // because the renderer cannot require a CommonJS main module — and this copy is
  // only ever cosmetic, shaping the drop cursor. The guard that counts is in main.
  function isUnder(parent, child) {
    return child === parent || String(child).startsWith(parent + '/');
  }
  // A brief green on rows that just appeared, so a watcher-driven change is
  // something you notice rather than something you have to diff by eye.
  function markFresh(paths) {
    for (const p of paths || []) S.treeFresh.add(p);
    clearTimeout(markFresh.t);
    markFresh.t = setTimeout(() => { S.treeFresh.clear(); if (S.railTab === 'workspace') refreshRail(); }, 2400);
  }

  // ---- workspace context menu ------------------------------------------------
  function showMenu(x, y, items) {
    terminalHint.hide();
    hideMenu();
    const m = document.createElement('div'); m.className = 'ctx-menu'; m.id = 'ctx-menu';
    for (const it of items) {
      if (it === '-') { const hr = document.createElement('div'); hr.className = 'ctx-sep'; m.appendChild(hr); continue; }
      const row = document.createElement('div');
      row.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.off ? ' off' : '');
      row.textContent = it.label;
      // The menu is where people look for a shortcut they don't know yet, so the
      // ones that exist say so here rather than staying folklore.
      if (it.kb) { const k = document.createElement('span'); k.className = 'ctx-kb'; k.textContent = it.kb; row.appendChild(k); }
      // An inert row is there to answer "why can't I open this?" — it says the
      // reason in the shortcut column and does nothing when clicked. Removing it
      // instead would leave the question unanswered.
      if (it.off) row.onclick = (e) => e.stopPropagation();
      else row.onclick = (e) => { e.stopPropagation(); hideMenu(); it.run(e); };
      m.appendChild(row);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    setTimeout(() => {
      window.addEventListener('click', hideMenu, { once: true });
      window.addEventListener('contextmenu', hideMenu, { once: true });
      window.addEventListener('keydown', escHideMenu);
    }, 0);
  }
  function escHideMenu(e) { if (e.key === 'Escape') hideMenu(); }
  // Every listener showMenu armed has to come back off, not just the keydown one.
  // `once` only fires-and-removes when the event actually arrives, so dismissing a
  // menu with Escape or a click left the *contextmenu* listener armed — and it
  // then bubbled into the next right-click and tore that menu down as it opened.
  // The menu opened once per session and Duplicate, Copy path and Move to Trash
  // were unreachable after it. Present since 0.1.2.
  function hideMenu() {
    const m = document.getElementById('ctx-menu'); if (m) m.remove();
    window.removeEventListener('keydown', escHideMenu);
    window.removeEventListener('click', hideMenu);
    window.removeEventListener('contextmenu', hideMenu);
  }
  async function refreshTreeDir(dir) {
    await relistDir(dir);
    if (S.railTab === 'workspace') refreshRail();
  }

  // ---- keeping the tree honest ------------------------------------------------
  // What is watched is a property of the *project*, not of what happens to be
  // drawn. It used to be called from the bottom of renderWorkspaceTree, which
  // meant a window booted on the Sessions tab watched nothing at all until you
  // clicked Workspace — and then only the folders that were open. One recursive
  // watcher on the root covers all of it; see src/main/dir-watch.js.
  function watchProject() {
    if (!api.dirWatch) return;
    api.dirWatch(S.project ? S.project.path : null).catch(() => {});
  }

  // Something changed inside `dir`. Two rows can be wrong because of it, and the
  // second is the one that used to be missed:
  //
  //   · dir's own listing, if dir is open
  //   · dir's row in its PARENT's listing, which is where its "N items" is
  //     computed — so a file appearing inside a collapsed ui/ is corrected by
  //     re-listing the folder that holds ui/, never ui/ itself
  //
  // Anything deeper than that changes no number anybody can see, and returns
  // without a readdir.
  async function onDirChanged(dir, files) {
    // Two jobs now. The tree's is below; this one is the files themselves, and it
    // runs first because it does not care whether the folder is open in the
    // sidebar — a tile follows its file wherever that file lives.
    void followFileChanges(files);
    if (!S.project || !dir) return;
    if (S.treeEdit && dirName(S.treeEdit.path) === dir) return;  // mid-rename; the commit re-lists
    const parent = dir === S.project.path ? null : dirName(dir);
    let touched = false;
    if (dir in S.tree) touched = await relistDir(dir) || touched;
    if (parent && parent in S.tree) touched = await relistDir(parent) || touched;
    if (touched && S.railTab === 'workspace') refreshRail();
  }

  // Re-read one open folder. A null means it has gone — "empty" and "deleted" are
  // different answers and dir:list now distinguishes them, which is what lets the
  // row disappear instead of emptying out.
  async function relistDir(dir) {
    const before = new Set((S.tree[dir] || []).map((n) => n.path));
    const rows = await api.listDir(dir, S.treeAll);
    if (rows == null) { delete S.tree[dir]; S.expanded.delete(dir); return true; }
    S.tree[dir] = rows;
    const fresh = rows.map((n) => n.path).filter((p) => !before.has(p));
    if (fresh.length) markFresh(fresh);
    return true;
  }
  // A file open on the desk follows the file on disk.
  //
  // The watcher names what moved; every open tile holding one of those paths
  // re-reads it and asks decideReload what to do — merge it, ask about it, or
  // leave it alone (src/renderer/file-sync.mjs holds the rules and the reasons).
  // A null `files` means the platform would not say which file it was, so every
  // open file is re-checked: a missed reload is a tile quietly lying about a
  // document, and one extra read of a file you have open costs nothing you can
  // feel. An empty list names nothing and does nothing.
  //
  // One read per panel at a time. A build writing the same file forty times in a
  // burst would otherwise stack forty reads against one tile and apply them in
  // whatever order they came back.
  const followInFlight = new Set();
  async function followFileChanges(files) {
    const named = files == null ? null : new Set(files);
    const open = S.panels.filter((p) => p.filePath && (p.kind === 'editor' || p.kind === 'viewer'));
    // The peek sheet is a panel that never joined S.panels — it is the most
    // likely thing to be looking at while an agent writes, so it follows too.
    const peek = S.overlay && S.overlay.type === 'peek' && S.overlay.panel;
    if (peek && peek.filePath && !open.includes(peek)) open.push(peek);
    for (const p of open) {
      if (named && !named.has(p.filePath)) continue;
      if (followInFlight.has(p.id)) continue;
      followInFlight.add(p.id);
      try { await followOneFile(p); } finally { followInFlight.delete(p.id); }
    }
  }
  // The tile that shows `p` — a pinned one, or the peek sheet, which mounts the
  // same editor into a rec of its own.
  function fileRecFor(p) {
    const rec = tiles.get(p.id);
    if (rec) return rec;
    const peekRec = getPeekRec();
    return peekRec && S.overlay && S.overlay.type === 'peek' && S.overlay.panel === p ? peekRec : null;
  }
  async function followOneFile(p) {
    const rec = fileRecFor(p);
    if (!rec || !rec.reloadFromDisk) return;
    // A viewer has no buffer and nothing unsaved: there is no decision to make,
    // only a cache to bust.
    if (p.kind === 'viewer') { rec.reloadFromDisk(); return; }
    const res = await api.rawFile(p.filePath);
    // Gone, binary, or too big to read. The tile keeps what it has rather than
    // emptying out over a failed read — the same instinct as the zero-byte rule.
    if (!res || !res.ok || typeof res.text !== 'string') return;
    const d = decideReload({ text: p.text || '', dirty: !!p.dirty, lastHash: p.lastHash || null, diskText: res.text });
    // 'refuse' is silent on purpose: nothing was lost and nothing needs deciding.
    // Telling somebody their file briefly read as empty is noise about a write
    // that has almost certainly already finished.
    if (d.action === 'drop' || d.action === 'refuse') return;
    if (d.action === 'merge') { rec.reloadFromDisk(d.text); return; }
    if (d.action === 'ask' && rec.raiseDiskBar) rec.raiseDiskBar(d.diskText);
  }
  // Which session a file lands in: the one you are working in, else the only
  // live one. Several live and none active is the one case that has to ask,
  // and it asks with a toast rather than a picker — a right-click is a quick
  // gesture, and the fix is to click the session you meant first.
  async function addPathToSession(path, isDir) {
    const live = S.panels.filter(isSessionPanel).filter((p) => !p.exited);
    if (!live.length) { toast('Open a session first.'); return; }
    const active = live.find((p) => p.id === S.activeId);
    const target = active || (live.length === 1 ? live[0] : null);
    if (!target) { toast('Click the session you mean, then add the file.'); return; }
    const text = pathRef(path, S.project && S.project.path, isDir);
    const ok = await insertSessionText(target.id, text, { focus: true });
    toast(ok ? 'Added to ' + (target.title || 'the session') + '.' : 'Could not add that here.');
  }
  // The same verbs from an open tab. A tile is aimed at the session that owns
  // it; one with no live owner falls back to the rule the tree uses above.
  function tileTarget(p) {
    const owner = p.owner && S.panels.find((s) => s.id === p.owner && isSessionPanel(s) && !s.exited);
    if (owner) return owner;
    const live = S.panels.filter(isSessionPanel).filter((s) => !s.exited);
    if (!live.length) { toast('Open a session first.'); return null; }
    const active = live.find((s) => s.id === S.activeId);
    const target = active || (live.length === 1 ? live[0] : null);
    if (!target) toast('Click the session you mean, then add the file.');
    return target;
  }
  async function addTileToSession(p) {
    const target = tileTarget(p); if (!target) return;
    const text = p.filePath ? pathRef(p.filePath, S.project && S.project.path, false) : p.url + ' ';
    const ok = await insertSessionText(target.id, text, { focus: true });
    toast(ok ? 'Added to ' + (target.title || 'the session') + '.' : 'Could not add that here.');
  }
  // Leave KingAgent for the Mac's browser: a saved HTML file through the file
  // channel, a website through the url one. Main guards both — a .md, a
  // file:// that is not HTML, a custom scheme: none of them gets out.
  async function openOutside(p) {
    if (p.filePath && fileKind(p.filePath) === 'html') {
      if (p.dirty && !(await saveEditor(p))) return;
      const r = await api.openFileInBrowser(p.filePath);
      if (r && r.ok === false) toast(r.error || 'Could not open Chrome.');
      return;
    }
    if (p.url && /^https?:\/\//i.test(p.url)) api.openUrl(p.url);
    else toast('Nothing to open yet.');
  }
  function tileMenu(p) {
    return tileMenuItems(p, {
      html: (x) => !!x.filePath && fileKind(x.filePath) === 'html',
      openOutside, addToSession: addTileToSession, move: moveMenu,
      copy: (x) => { api.copyText(x.filePath || x.url); toast(x.filePath ? 'Path copied.' : 'Address copied.'); },
      newWindow: (x) => api.newWindow(x.filePath.replace(/\/[^/]*$/, '') || '/', x.filePath),
    });
  }
  function treeMenu(n, parentDir) {
    const root = S.project.path;
    const items = [];
    if (n.kind === 'file' && fileKind(n.path) === 'html') {
      items.push({ label: 'Open in browser', run: () => openFileInBrowser(n.path) });
      items.push({ label: 'Open in Chrome ↗', run: () => openOutside({ filePath: n.path }) });
    }
    // The whole file, not a highlighted piece of it. Same text a drag types —
    // an @mention inside the project, a quoted path outside — into the session
    // you are working in. Folders go too, with their trailing slash.
    items.push({ label: 'Add to session', run: () => addPathToSession(n.path, n.kind === 'dir') });
    // Every window owns one folder. A folder opens as that window's root; a
    // file opens its folder and lands the file on the new desk.
    items.push({ label: 'Open in new window', run: () => {
      if (n.kind === 'dir') api.newWindow(n.path);
      else api.newWindow(parentDir || root, n.path);
    } });
    items.push({ label: REVEAL_LABEL, run: () => api.revealFile(n.path) });
    if (n.kind === 'dir') {
      items.push({ label: 'New file…', run: () => openFsName('file', n.path) });
      items.push({ label: 'New folder…', run: () => openFsName('folder', n.path) });
    }
    // "Move to…" is gone: it opened a native picker that would happily let you
    // choose a folder outside the root, and then movePath refused it — offering a
    // destination you are not allowed to use. Dragging the row does this now.
    items.push({ label: 'Rename…', kb: '⏎', run: () => beginTreeRename(n.path) });
    items.push({ label: 'Duplicate', run: async () => {
      const res = await api.fsDuplicate({ root, src: n.path });
      if (!res.ok) { toast(res.error || 'Could not duplicate'); return; }
      markFresh([res.path]);
      await refreshTreeDir(parentDir);
      toast('Duplicated to ' + baseName(res.path) + '.');
    } });
    items.push({ label: 'Copy path', run: async () => {
      try { await navigator.clipboard.writeText(n.path); toast('Path copied.'); }
      catch (_) { toast('Could not copy that.'); }
    } });
    items.push('-');
    // Direct to Trash: right-click plus a click below a separator is deliberate,
    // and the Trash is recoverable. The library card's Delete keeps its armed
    // second click because it sits next to Save.
    items.push({ label: 'Move to Trash', danger: true, kb: '⌘⌫', run: () => trashTreeItem(n.path, parentDir) });
    return items;
  }

  // Shared by the menu row and ⌘⌫, so the keyboard route cannot drift from the
  // one the menu advertises.
  async function trashTreeItem(path, parentDir) {
    const res = await api.fsTrash({ root: S.project.path, path });
    if (!res.ok) { toast(res.error); return; }
    S.expanded.delete(path); delete S.tree[path];
    if (S.treeSel === path) S.treeSel = null;
    // Previewing the thing you just trashed is a window onto a file that is no
    // longer there — close it rather than leave a stale page up.
    if (S.overlay && S.overlay.type === 'peek' && S.overlay.panel && S.overlay.panel.filePath === path) closeOverlay();
    await refreshTreeDir(parentDir);
    toast('Moved ' + baseName(path) + ' to Trash.');
  }
  function openFsName(mode, dir) { S.overlay = { type: 'fs-name', mode, dir, name: '' }; renderOverlay(); }
  function renderFsName() {
    const o = S.overlay;
    // Its own header, not .picker-input: that row belongs to the launcher and the
    // agent picker too, and it has no nowrap on the label and no truncation on the
    // trailing span — so a deep path wrapped the title onto two lines and then ran
    // to three of its own, leaving the destination as the biggest thing in a box
    // whose actual job is a name and a button.
    const full = shortHome(o.dir);
    const modal = overlay('picker-box', `
      <div class="fs-head"><span class="prompt-mark">＋</span>
        <span class="fs-title">New ${o.mode === 'file' ? 'file' : 'folder'}</span>
        <span class="fs-where" title="${esc(full)}">${esc(tailPath(full))}</span></div>
      <div class="fs-row"><input id="fs-name" placeholder="${o.mode === 'file' ? 'notes.md' : 'a name'}" spellcheck="false" />
        <button class="btn btn--go" id="fs-go">Create</button></div>
      <div class="fs-hint">${o.mode === 'file'
    ? 'Any extension. It lands empty and opens in the editor.'
    : 'The folder is created and opened in the tree.'}</div>`, { top: true });
    const input = q('#fs-name', modal); input.value = o.name; setTimeout(() => input.focus(), 30);
    input.oninput = () => { o.name = input.value; };
    const go = async () => {
      const name = input.value.trim();
      if (!name) { toast('Give it a name first.'); return; }
      const root = S.project.path;
      const res = o.mode === 'file'
        ? await api.fsNewFile({ root, dir: o.dir, name })
        : await api.fsNewFolder({ root, dir: o.dir, name });
      if (!res.ok) { toast(res.error || 'Could not create'); return; }
      closeOverlay();
      if (o.dir !== root) S.expanded.add(o.dir);
      await refreshTreeDir(o.dir);
      if (o.mode === 'file') openFile(res.path, { pin: true });
      toast('Created ' + name);
    };
    q('#fs-go', modal).onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }

  // ---- library rail (agents & skills across platforms) -----------------------
  async function loadLibrary(force) {
    if (S.library.loading || (S.library.loaded && !force)) return;
    S.library.loading = true;
    const keepMac = S.library.macLoaded;
    S.library.macGen += 1;
    S.library.macLoading = false;
    try {
      const res = (await api.libraryScan({ projectPath: S.project && S.project.path, scope: 'project' })) || {};
      S.library.items = res.items || []; S.library.edges = res.edges || [];
    } catch (_) { S.library.items = []; S.library.edges = []; }
    S.library.macLoaded = false;
    S.library.loading = false; S.library.loaded = true;
    if (keepMac) await loadMacLibrary();
    else maybeLoadMac();
    if (S.railTab === 'library') refreshRail();
    refreshPointer(true);   // read-only; it never writes a file on its own
  }
  function maybeLoadMac() {
    if (S.library.macLoaded || S.library.macLoading) return;
    const openGroups = new Set(MAC_GROUP_KEYS.filter((k) => !S.library.collapsed.has(k)));
    if (shouldLoadMac({ openGroups, query: S.library.q, macLoaded: false })) loadMacLibrary();
  }
  async function loadMacLibrary() {
    if (S.library.macLoaded || S.library.macLoading) return;
    S.library.macLoading = true;
    const gen = S.library.macGen;
    try {
      const res = (await api.libraryScan({ projectPath: S.project && S.project.path, scope: 'mac' })) || {};
      if (gen !== S.library.macGen) return;
      const seen = new Set(S.library.items.map((i) => i.id));
      for (const i of (res.items || [])) if (!seen.has(i.id)) S.library.items.push(i);
      if (res.edges && res.edges.length) S.library.edges = (S.library.edges || []).concat(res.edges);
      S.library.macLoaded = true;
    } catch (_) {}
    if (gen === S.library.macGen) S.library.macLoading = false;
    if (S.railTab === 'library') refreshRail();
  }
  async function refreshServices() {
    if (S.services.loading) return;
    S.services.loading = true;
    // Coverage is computed against installed agents, so the detect pass has to
    // land first — refreshAgents dedupes in-flight calls, this never re-scans.
    if (!S.agents) { try { await refreshAgents(); } catch (_) {} }
    try {
      const res = await api.listServices({ projectPath: S.project && S.project.path, agentIds: installedAgentIds() });
      S.services.catalog = res.catalog || []; S.services.connected = res.connected || [];
      S.services.coverage = res.coverage || null;
    } catch (_) {}
    S.services.loading = false;
    if (S.railTab === 'library') refreshRail();
    if (S.overlay && S.overlay.type === 'connect') renderOverlay();
  }
  const TYPE_CHIP = { agent: { code: 'AG', kind: 'agent' }, skill: { code: 'SK', kind: 'skill' }, command: { code: 'CM', kind: 'command' } };
  const LIB_MAKE = [
    { key: 'agent', icon: 'agent', code: 'AG', kind: 'agent', name: 'Agent', sub: 'build', title: 'Create an agent' },
    { key: 'skill', icon: 'skill', code: 'SK', kind: 'skill', name: 'Skill', sub: 'teach', title: 'Create a skill' },
    { key: 'mcp', icon: 'mcp', code: 'MC', kind: 'service', name: 'MCP', sub: 'connect', title: 'Connect MCP' },
  ];
  function libItemTag(i) {
    if (i.type === 'skill' && i.scope === 'project') {
      const a = availabilityTag(i);
      return `<span class="scope-tag" data-tone="${a.tone}" title="${esc(a.title)}">${esc(a.text)}</span>`;
    }
    if (i.platform === 'project') {
      return `<span class="scope-tag" data-tone="ok" title="${esc(i.filePath)}">project</span>`;
    }
    const who = agentNameOf(cliKey(i) || i.platform);
    return `<span class="scope-tag" title="${esc(i.filePath)}">${esc(who)}</span>`;
  }
  function serviceCovLine(sv) {
    const cov = S.services.coverage && S.services.coverage[sv.id];
    const writable = new Set(receiversOf('mcp', installedAgentIds()));
    const missing = cov ? cov.missing.filter((id) => writable.has(id)) : [];
    const have = cov ? (cov.have || []).filter((id) => writable.has(id)) : (sv.platforms || []);
    if (missing.length) {
      return `<span class="ok" style="color:var(--amber-ink)">●</span> ${esc(missing.map(agentNameOf).join(' · '))} missing`;
    }
    return `<span class="ok">●</span> ${esc(have.map(agentNameOf).join(' · ') || 'connected')}`;
  }

  // What a row is allowed to claim. Only two things make a skill runnable from
  // here: this project's pointer names it, or the agent that owns the folder reads
  // it natively. Everything else is a file on disk that happens to be a skill, and
  // saying so is what stops "Use here" from looking pointless.
  function availabilityTag(i) {
    if (i.broken) return { text: 'broken', tone: 'bad', title: 'Its files are gone — this is a link to nothing. ' + (i.linkTarget || '') };
    if (i.availability === 'project') {
      // "runs here" would be a lie while no agent has been told it exists, so the
      // tag carries that rather than a second warning line under the description.
      const st = S.pointer;
      if (st && (st.unlisted || []).includes(i.slug)) {
        // short on purpose: the tag sits beside the name in a 282px rail, and a
        // long one pushes the name into an ellipsis, which is the thing you scan for
        return { text: 'unlisted', tone: 'warn', title: 'It is in this project, but no agent has been told about it yet. Tell them, below.' };
      }
      return { text: 'runs here', tone: 'ok', title: 'Announced in AGENTS.md — a session started in this project can use it.' };
    }
    if (i.availability === 'agent') {
      const a = (S.agents || []).find((x) => x.id === i.ownerAgent);
      const who = (a && a.name) || i.ownerAgent;
      return { text: who + ' only', tone: 'mute', title: `${who} reads this folder itself. KingAgent's sessions here won't see it unless you copy it in.` };
    }
    return { text: 'not wired', tone: 'mute', title: 'It sits in a shared folder that no agent reads. Copy it here to use it.' };
  }
  // Short on purpose: the tag sits beside the item's name in a 282px rail, and
  // the name is what you are actually scanning for. Longer wording lives on the
  // detail sheets, where there is room for it.

  // ---- pointer status: silent when healthy -----------------------------------
  // If every skill is announced there is nothing to say, and a line that always
  // says the same thing is noise. So this surfaces only the exception: a skill no
  // agent has been told about, usually one that arrived with a git pull.
  async function refreshPointer(force) {
    const dir = S.project && S.project.path;
    if (!dir) { S.pointer = null; return; }
    if (S.pointerLoading && !force) return;
    S.pointerLoading = true;
    try { S.pointer = await api.pointerStatus({ dir, agentIds: installedAgentIds() }); }
    catch (_) { S.pointer = null; }
    S.pointerLoading = false;
    if (S.railTab === 'library') refreshRail();
  }
  function installedAgentIds() { return (S.agents || []).filter((a) => a.found).map((a) => a.id); }
  function agentNameOf(id) { const a = (S.agents || []).find((x) => x.id === id); return a ? a.name : id; }
  // A `## Skills` heading the user wrote themselves. KingAgent appends below it rather
  // than taking it over — their wording is usually better than anything generated
  // from frontmatter, and rewriting prose we didn't author is not a trade worth
  // making. But two Skills sections in one file is worth mentioning once.
  const FOREIGN_DISMISSED = 'kingagent-foreign-skills-dismissed';
  function appendForeignNote(list) {
    const st = S.pointer;
    const dir = S.project && S.project.path;
    if (!st || !st.foreignSection || !dir) return;
    let done = [];
    try { done = JSON.parse(localStorage.getItem(FOREIGN_DISMISSED) || '[]'); } catch (_) { done = []; }
    if (done.includes(dir)) return;
    const note = document.createElement('div');
    note.className = 'ptr-note';
    note.innerHTML = `<span class="pn-msg">AGENTS.md also has a Skills section you wrote. KingAgent left it alone and put its own list below — tidy up whenever you like.</span>
      <button class="pn-x" title="Got it">✕</button>`;
    list.appendChild(note);
    q('.pn-x', note).onclick = (e) => {
      e.stopPropagation();
      try { localStorage.setItem(FOREIGN_DISMISSED, JSON.stringify(done.concat([dir]))); } catch (_) {}
      refreshRail();
    };
  }
  function appendPointerBar(list) {
    appendForeignNote(list);
    const st = S.pointer;
    if (!st || st.inSync) return;
    const bits = [];
    if ((st.unlisted || []).length) bits.push(`${st.unlisted.length} not announced to any agent`);
    if ((st.stale || []).length) bits.push(`${st.stale.length} still listed after being deleted`);
    if ((st.missingFiles || []).length) bits.push(`${st.missingFiles.join(' + ')} missing`);
    const bar = document.createElement('div');
    bar.className = 'ptr-bar';
    bar.innerHTML = `<span class="pb-msg">⚠ ${esc(st.error ? st.error : bits.join(' · '))}</span>
      ${st.error ? '' : '<button class="btn pb-go">Tell them</button>'}`;
    list.appendChild(bar);
    const go = q('.pb-go', bar);
    if (go) go.onclick = async (e) => { e.stopPropagation(); await writePointers(go); };
  }
  // The one write the Library can make, and it names its files first.
  async function writePointers(btn) {
    const dir = S.project && S.project.path;
    if (!dir) { toast('Open a folder first.'); return; }
    const agentIds = installedAgentIds();
    if (btn) { btn.disabled = true; btn.textContent = 'Telling…'; }
    const res = await api.pointerWrite({ dir, agentIds });
    if (!res || !res.ok) { toast((res && res.error) || 'Could not write the pointer files'); if (btn) { btn.disabled = false; btn.textContent = 'Tell them'; } return; }
    const n = (res.written || []).length;
    toast(n ? `Updated ${res.written.join(', ')} — every installed agent knows now.` : 'Already up to date.');
    await refreshPointer(true);
    loadLibrary(true);
  }
  function toggleLibGroup(key) {
    if (S.library.collapsed.has(key)) S.library.collapsed.delete(key);
    else S.library.collapsed.add(key);
    maybeLoadMac();
    refreshRail();
  }
  function appendLibItem(sect, i) {
    const chip = TYPE_CHIP[i.type] || TYPE_CHIP.agent;
    const row = document.createElement('div'); row.className = 'agent-row';
    const path = shortHome(i.filePath || i.dirPath || '');
    row.innerHTML = `${chipHtml({ key: i.type, code: chip.code, kind: chip.kind })}
      <span class="col"><span class="name">${esc(i.name)}</span><span class="tools">${esc(path)}</span></span>
      ${libItemTag(i)}<span class="chev">›</span>`;
    row.onclick = () => openCard(i);
    sect.appendChild(row);
  }
  function appendServiceRow(sect, sv) {
    const cat = S.services.catalog.find((s) => s.id === sv.id);
    const cov = S.services.coverage && S.services.coverage[sv.id];
    const writable = new Set(receiversOf('mcp', installedAgentIds()));
    const missing = cov ? cov.missing.filter((id) => writable.has(id)) : [];
    const row = document.createElement('div'); row.className = 'agent-row';
    row.innerHTML = `${chipHtml({ key: iconKeyFor(sv.id) || 'mcp', code: (cat && cat.code) || 'SV', kind: 'service' })}
      <span class="col"><span class="name">${esc(sv.name)}</span>
      <span class="tools">${serviceCovLine(sv)}</span></span>
      ${missing.length ? '<button class="btn sv-tell">tell them</button>' : `<span class="scope-tag">${sv.scopes && sv.scopes.includes('project') ? 'project' : 'this Mac'}</span>`}`;
    row.onclick = () => openServiceDetails(sv);
    const tell = row.querySelector('.sv-tell');
    if (tell) tell.onclick = async (e) => {
      e.stopPropagation();
      tell.disabled = true; tell.textContent = 'telling…';
      await api.deliverServices({ projectPath: S.project && S.project.path, agentIds: installedAgentIds() });
      refreshServices();
    };
    sect.appendChild(row);
  }
  function refreshLibraryRail(c) {
    if (!S.library.loaded) loadLibrary();
    const head = document.createElement('div'); head.className = 'rail-head';
    head.innerHTML = `<span class="title">Library</span>
      <span class="racts"><button type="button" class="lib-exp">expand all</button>
      <button type="button" class="lib-col">close all</button></span>`;
    c.appendChild(head);
    q('.lib-exp', head).onclick = () => { S.library.collapsed.clear(); maybeLoadMac(); refreshRail(); };
    q('.lib-col', head).onclick = () => {
      for (const g of SHELF_GROUPS) S.library.collapsed.add(g.key);
      refreshRail();
    };
    const make = document.createElement('div'); make.className = 'lib-new-grid';
    make.innerHTML = LIB_MAKE.map((m) => `<div class="add-card lib-new" data-make="${esc(m.key)}" tabindex="0" role="button" title="${esc(m.title)}">
        ${chipHtml({ key: m.icon, code: m.code, kind: m.kind })}
        <span class="ac-name">${esc(m.name)}</span><span class="ac-desc">${esc(m.sub)}</span></div>`).join('');
    c.appendChild(make);
    make.querySelectorAll('.lib-new').forEach((el) => {
      const go = () => (el.dataset.make === 'mcp' ? openConnect() : openCreate(el.dataset.make));
      el.onclick = go;
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    const top = document.createElement('div'); top.className = 'lib-top';
    const search = document.createElement('input');
    search.className = 'lib-search'; search.placeholder = 'Filter the library…'; search.value = S.library.q;
    search.oninput = () => { S.library.q = search.value; maybeLoadMac(); refreshRail(); const s = q('.lib-search', c); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } };
    top.appendChild(search); c.appendChild(top);
    const list = document.createElement('div'); list.className = 'lib-list'; c.appendChild(list);
    if (!S.library.loaded) { const e = document.createElement('div'); e.className = 'rail-empty'; e.textContent = 'Scanning…'; list.appendChild(e); return; }
    const ql = S.library.q.trim().toLowerCase();
    const match = (i) => !ql || (i.name + ' ' + i.description + ' ' + i.slug + ' ' + (i.filePath || '')).toLowerCase().includes(ql);
    let shown = 0;
    for (const g of SHELF_GROUPS) {
      const isSvc = g.key === 'services' || g.key === 'mac-services';
      const items = isSvc
        ? S.services.connected.filter((sv) => serviceShelf(sv) === g.key && (!ql || (sv.id + ' ' + sv.name).toLowerCase().includes(ql)))
        : S.library.items.filter((i) => shelfOf(i) === g.key && match(i));
      const pendingMac = g.mac && !isSvc && !S.library.macLoaded;
      if (!items.length && !pendingMac && !(g.key === 'services' && !ql)) continue;
      shown += items.length + (g.key === 'services' ? 1 : 0) + (pendingMac ? 1 : 0);
      const open = ql ? true : !S.library.collapsed.has(g.key);
      const sect = document.createElement('div'); sect.className = 'lib-sect'; list.appendChild(sect);
      const lab = document.createElement('div'); lab.className = 'lib-group';
      const count = pendingMac ? macCountLabel({ loaded: false, n: items.length }) : items.length;
      lab.innerHTML = `<span class="lg-caret">${open ? '▾' : '▸'}</span><span>${esc(g.label)}</span><span class="lg-count">${esc(String(count))}</span>`;
      lab.onclick = () => toggleLibGroup(g.key);
      sect.appendChild(lab);
      if (!open) continue;
      if (pendingMac) {
        const wait = document.createElement('div'); wait.className = 'rail-empty';
        wait.textContent = 'Scanning…';
        sect.appendChild(wait);
        continue;
      }
      if (isSvc) {
        for (const sv of items) appendServiceRow(sect, sv);
        if (g.key === 'services') {
          const add = document.createElement('div'); add.className = 'agent-row';
          add.innerHTML = `<span class="code" data-kind="service">⚡</span>
            <span class="col"><span class="name">connect MCP</span><span class="tools">Notion, Slack, a folder…</span></span><span class="chev">›</span>`;
          add.onclick = () => openConnect();
          sect.appendChild(add);
        }
        continue;
      }
      if (g.mac) {
        const buckets = new Map();
        for (const i of items) {
          const k = cliKey(i) || 'other';
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(i);
        }
        const keys = CLI_ORDER.filter((k) => buckets.has(k)).concat([...buckets.keys()].filter((k) => !CLI_ORDER.includes(k)));
        for (const k of keys) {
          const subKey = g.key + ':' + k;
          const subOpen = ql ? true : !S.library.collapsed.has(subKey);
          const sub = document.createElement('div'); sub.className = 'lib-group sub';
          sub.innerHTML = `<span class="lg-caret">${subOpen ? '▾' : '▸'}</span><span>${esc(agentNameOf(k))}</span><span class="lg-count">${buckets.get(k).length}</span>`;
          sub.onclick = () => toggleLibGroup(subKey);
          sect.appendChild(sub);
          if (subOpen) for (const i of buckets.get(k)) appendLibItem(sect, i);
        }
        continue;
      }
      for (const i of items) appendLibItem(sect, i);
      if (g.key === 'skills') appendPointerBar(sect);
    }
    if (!shown) { const e = document.createElement('div'); e.className = 'rail-empty'; e.textContent = ql ? 'No match.' : 'Nothing here yet — the buttons above make your first.'; list.appendChild(e); }
  }
  // With no folder there is exactly one thing worth saying, and it is the thing
  // the screen is asking you to fix. This used to announce "claude ready" when the
  // Claude CLI happened to be installed — from when the app only ran that one
  // agent. It named a single agent on the first screen a new user sees, and said
  // it on a screen where no agent can start: every action here needs a folder.
  function renderFooter() { els.footerPath.textContent = S.project ? S.project.pathShort : 'no folder open'; }

  return {
    renderHeader, renderRail, refreshRail, renderFooter, watchProject, refreshServices,
    loadLibrary, refreshPointer, installedAgentIds, agentNameOf, showMenu,
    toggleProjectsPop, positionThemePop, toggleThemePop,
    beginTreeRename, dirName, trashTreeItem, openFsName, renderFsName,
    onDirChanged, followFileChanges, openOutside, tileMenu,
    TYPE_CHIP, THEME_OPTIONS,
  };
}
