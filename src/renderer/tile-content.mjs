import { fileKind, fileUrl, docUrl } from './file-kinds.mjs';
import { parseDoc, getField, setField, serializeDoc, editsAsFrontmatter, listItems, setListField, removeField } from './frontmatter.mjs';
import { resolveOpen } from './peek-core.mjs';
import { feedNameDraft, adoptTitle } from './session-name.mjs';
import { renderMarkdown, highlightMarkdown, isMarkdownPath } from './md.mjs';
import { mountMarkdownEditor, richMarkdownPath, markdownImageUrl } from './markdown-rich.mjs';
import { hashText, changeRange, shiftOffset } from './file-sync.mjs';

// Tile content: the editor tile (markdown/html/plain-text, the rich block
// editor, the frontmatter properties strip), the viewer tile (image/video/
// audio/pdf/fallback), the card tile (agent/skill form + raw markdown),
// dictation (mic recording + transcription, both in-session and for
// annotations), and rename-in-place. Extracted from app.js — the final
// pass of the split that also produced update-bar, terminal-link-tracking,
// panel-lifecycle, settings-panes, launcher, workspace-library and
// tile-shell.
export function createTileContent({
  api, state, tiles, esc, q, shorten, baseNameOf, shortHome, formatLabel, uid, REVEAL_LABEL,
  keepFile,
  refreshTileHead, refreshRail, refreshBrowserButtons,
  docScaleOf, openDocLink, applyDocColWidths, bindBrowserButton,
  focusPanel, pinFilePanel, closePanel, savePanels,
  loadLibrary, refreshPointer, installedAgentIds, TYPE_CHIP,
  rowTool, launchAgent, openImproveItem,
  openSettings,
  toast, closeOverlay, openPeek,
}) {
  const S = state;
  const tileEls = tiles;

  // ---- editor tiles ----------------------------------------------------------
  function mountEditor(p, rec) {
    // Markdown and html open rendered; everything else has nothing to render, so
    // it opens straight in the editor and never shows the Read tab.
    const md = isMarkdownPath(p.filePath);
    const rich = richMarkdownPath(p.filePath);
    const html = fileKind(p.filePath) === 'html';
    const rendered = md || html;
    if (!rendered) p.edMode = 'edit';
    else if (rich && !['read', 'edit', 'markdown'].includes(p.edMode)) p.edMode = 'read';
    else if (!rich && p.edMode !== 'edit') p.edMode = 'read';

    const wrap = document.createElement('div'); wrap.className = 'editor';
    const tabs = rich
      ? `<div class="ed-tabs card-tabs"><button class="card-tab ed-tab" data-m="read">Read</button><button class="card-tab ed-tab" data-m="edit">Edit</button><button class="card-tab ed-tab" data-m="markdown">Markdown</button></div>`
      : rendered ? `<div class="ed-tabs card-tabs"><button class="card-tab ed-tab" data-m="read">Read</button><button class="card-tab ed-tab" data-m="edit">Edit</button></div>` : '';
    // The changed-on-disk bar sits above the tabs, between the tile's head and
    // the document, because it is about the whole file rather than about the
    // pane you happen to be looking at. It only ever appears over unsaved edits:
    // a clean panel merges without a word.
    wrap.innerHTML = `<div class="disk-bar" hidden>
        <span class="dk-msg">Changed on disk</span>
        <span class="dk-acts"><button class="btn dk-reload">Reload</button><button class="btn dk-keep">Keep mine</button></span>
      </div>
      ${tabs}
      <div class="ed-read md-read"></div>
      ${rich ? `<div class="ed-rich"><div class="ed-fm"></div><div class="ed-rich-doc"><div class="ed-rich-loading">Open Edit to load the block editor.</div></div></div>` : ''}
      <div class="ed-pane"><div class="ed-gutter"></div>
        <div class="ed-stack"><pre class="ed-hl" aria-hidden="true"></pre><pre class="ed-measure" aria-hidden="true"></pre><textarea class="ed-area" spellcheck="false"></textarea></div></div>
      <div class="ed-bar"><span class="ed-path">${esc(shortHome(p.filePath))}</span>${html && !rec.peek ? '<button class="btn ed-browser"></button>' : ''}<button class="btn ed-finder">Finder</button><button class="btn btn--go ed-save">Save ⌘S</button></div>`;
    wrap.classList.toggle('editor--md', md);
    wrap.classList.toggle('editor--rich', rich);
    wrap.classList.toggle('editor--html', html);
    rec.body.appendChild(wrap);

    const ta = q('.ed-area', wrap), gutter = q('.ed-gutter', wrap);
    const hl = q('.ed-hl', wrap), read = q('.ed-read', wrap);
    const measure = q('.ed-measure', wrap);
    // Milkdown owns this node's children (it wipes innerHTML on load), so the
    // properties strip lives beside it, not inside it — both scroll together
    // because .ed-rich is the scroller.
    const richDoc = q('.ed-rich-doc', wrap);
    rec.ta = ta; rec.gutter = gutter;
    ta.value = p.text || '';
    let richEditor = null;
    let richLoading = null;
    let richStale = false;
    let disposed = false;

    const markDirty = () => {
      if (p.dirty) return;
      p.dirty = true; keepFile(p); refreshTileHead(p); refreshRail(); refreshBrowserButtons(p); // an edit keeps a preview
    };
    const resolveImage = (src) => markdownImageUrl(p.filePath, src) || src;
    // Frontmatter never enters the block editor: Milkdown reads `---` as a
    // horizontal rule and rewrites the YAML as prose, which silently destroys
    // `type:`/`tags:` on the first save. The properties strip edits it in
    // place, so the fence is read fresh on every use — a captured copy would
    // let a body edit resurrect a value the strip had already changed.
    const currentFm = () => {
      const m = String(p.text || '').match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      return m ? m[0] : '';
    };
    const richBody = () => String(p.text || '').slice(currentFm().length);

    // ---- the properties strip -------------------------------------------------
    // Obsidian-style frontmatter editing above the document. Field types are
    // inferred from the value, never configured; anything the form cannot
    // represent shows locked and is written back byte-for-byte (frontmatter.mjs
    // keeps that contract). Every edit rewrites only its own lines in p.text.
    const fmRoot = q('.ed-fm', wrap);
    let fmDraft = null;                 // {key, val} while a property is being born
    // Closed by default: a document opens as a document, not as a form. The
    // choice sticks to the panel, so reopening the same file keeps it.
    if (p.fmOpen == null) p.fmOpen = false;
    const fmWrite = (mutate) => {
      const doc = parseDoc(p.text || '');
      if (doc.malformed) return;
      mutate(doc);
      const next = serializeDoc(doc);
      if (next !== p.text) { p.text = next; ta.value = next; markDirty(); sync(); }
      renderFmStrip();
    };
    const fmKind = (doc, e) => {
      if (!e.key) return { kind: 'opaque' };
      if (e.complex) {
        const items = listItems(doc, e.key);
        return items ? { kind: 'tags', items } : { kind: 'locked' };
      }
      const v = getField(doc, e.key);
      if (v === 'true' || v === 'false') return { kind: 'check', v };
      if (/^-?\d+(\.\d+)?$/.test(v)) return { kind: 'number', v };
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { kind: 'date', v };
      return { kind: 'text', v };
    };
    function renderFmStrip() {
      if (!fmRoot || !editsAsFrontmatter(p.filePath)) return;
      const doc = parseDoc(p.text || '');
      const hint = '<span class="fmp-slim-hint">/ for blocks · select text to format</span>';
      if (doc.malformed) {
        fmRoot.innerHTML = `<div class="fmp-broken">Frontmatter looks malformed — fix it in the Markdown tab.</div><div class="fmp-slim fmp-slim--bare">${hint}</div>`;
        return;
      }
      // Collapsed: one slim row previewing the keys, with the block-editor hint
      // on its right end. It scrolls away with the document — the form only
      // takes space while you are actually editing properties.
      if (!fmDraft && (!p.fmOpen || !doc.hasFrontmatter)) {
        p.fmOpen = false;
        const keys = doc.entries.map((e) => e.key).filter(Boolean).join(' · ');
        fmRoot.innerHTML = `<div class="fmp-slim"><span class="fmp-arr">▸</span> properties${keys ? `<span class="fmp-keys">${esc(keys)}</span>` : ''}${hint}</div>`;
        q('.fmp-slim', fmRoot).onclick = (ev) => {
          // the hint is an editor tip riding on the row's right end, not a
          // properties control — a click on it should do nothing
          if (ev.target.closest('.fmp-slim-hint')) return;
          p.fmOpen = true;
          if (!doc.hasFrontmatter) fmDraft = { key: '', val: '' };
          renderFmStrip();
          q('.fmp-dk', fmRoot)?.focus();
        };
        return;
      }
      const rows = doc.entries.map((e) => {
        const t = fmKind(doc, e);
        let control;
        if (t.kind === 'opaque' || t.kind === 'locked') {
          const preview = t.kind === 'opaque' ? e.lines.join(' ') : e.lines.slice(1).map((l) => l.trim()).join(' · ');
          return `<div class="fmp-row fmp-lockrow"><span class="fmp-key">${esc(e.key || '')}</span>
            <span class="fmp-locked" title="Kept exactly as written — edit in the Markdown tab">🔒 <span class="fmp-pad">${esc(preview)}</span></span></div>`;
        }
        if (t.kind === 'tags') {
          control = `<span class="fmp-chips" data-key="${esc(e.key)}">` + t.items.map((item, k) =>
            `<span class="fmp-chip">${esc(item)}<button data-k="${k}" title="Remove">×</button></span>`).join('') +
            `<input placeholder="+ tag, Enter"></span>`;
        } else if (t.kind === 'check') {
          control = `<label class="fmp-check"><input type="checkbox" data-key="${esc(e.key)}"${t.v === 'true' ? ' checked' : ''}> ${t.v === 'true' ? 'yes' : 'no'}</label>`;
        } else {
          const type = t.kind === 'number' ? 'number' : t.kind === 'date' ? 'date' : 'text';
          control = `<input type="${type}" data-key="${esc(e.key)}" value="${esc(t.v)}" placeholder="empty — click to fill">`;
        }
        return `<div class="fmp-row" data-row="${esc(e.key)}"><span class="fmp-key">${esc(e.key)}</span>
          <span class="fmp-val">${control}</span><button class="fmp-rm" data-key="${esc(e.key)}" title="Remove property">✕</button></div>`;
      }).join('');
      const draft = fmDraft ? `<div class="fmp-row fmp-draft">
          <span class="fmp-key"><input class="fmp-dk" placeholder="name" value="${esc(fmDraft.key)}"></span>
          <span class="fmp-val"><input class="fmp-dv" placeholder="value (can be empty)" value="${esc(fmDraft.val)}"></span>
          <span class="fmp-hint">Enter saves · Esc cancels</span></div>` : '';
      fmRoot.innerHTML = `<div class="fmp">
        <div class="fmp-head"><span class="fmp-arr">▾</span> Properties<span class="fmp-count">${doc.entries.length} field${doc.entries.length === 1 ? '' : 's'}</span></div>
        <div class="fmp-body">${rows}${draft}${fmDraft ? '' : '<button class="fmp-add">+ add property</button>'}</div></div>`;

      q('.fmp-head', fmRoot).onclick = () => { p.fmOpen = false; fmDraft = null; renderFmStrip(); };
      fmRoot.querySelectorAll('input[data-key]:not([type="checkbox"])').forEach((el) => {
        el.addEventListener('change', () => fmWrite((doc2) => setField(doc2, el.dataset.key, el.value.trim())));
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.blur(); });
      });
      fmRoot.querySelectorAll('.fmp-check input').forEach((el) => {
        el.addEventListener('change', () => fmWrite((doc2) => setField(doc2, el.dataset.key, el.checked ? 'true' : 'false')));
      });
      fmRoot.querySelectorAll('.fmp-chips').forEach((chips) => {
        const key = chips.dataset.key;
        chips.querySelectorAll('.fmp-chip button').forEach((btn) => {
          btn.addEventListener('click', () => fmWrite((doc2) => {
            const items = listItems(doc2, key) || [];
            items.splice(Number(btn.dataset.k), 1);
            setListField(doc2, key, items);
          }));
        });
        const inp = chips.querySelector(':scope > input');
        inp.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' || !inp.value.trim()) return;
          const item = inp.value.trim();
          fmWrite((doc2) => setListField(doc2, key, [...(listItems(doc2, key) || []), item]));
        });
      });
      fmRoot.querySelectorAll('.fmp-rm').forEach((btn) => {
        btn.addEventListener('click', () => fmWrite((doc2) => removeField(doc2, btn.dataset.key)));
      });
      const add = q('.fmp-add', fmRoot);
      if (add) add.onclick = () => { fmDraft = { key: '', val: '' }; renderFmStrip(); q('.fmp-dk', fmRoot)?.focus(); };
      const dk = q('.fmp-dk', fmRoot), dv = q('.fmp-dv', fmRoot);
      if (dk && dv) {
        const save = () => {
          // repair the key rather than reject it: spaces become _, the rest drops
          const key = dk.value.trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '');
          if (!key) { toast('Give it a name first — e.g. freebie_url'); dk.focus(); return; }
          const doc2 = parseDoc(p.text || '');
          if (doc2.entries.some((x) => x.key === key)) {
            fmDraft = null; renderFmStrip();
            const row = fmRoot.querySelector(`[data-row="${CSS.escape(key)}"]`);
            if (row) { row.classList.add('fmp-flash'); row.querySelector('input,select')?.focus(); }
            toast(key + ' already exists — jumped you to it');
            return;
          }
          const value = dv.value.trim();
          fmDraft = null;
          fmWrite((doc3) => setField(doc3, key, value));
        };
        [dk, dv].forEach((el) => {
          el.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); save(); }
            if (ev.key === 'Escape') { ev.preventDefault(); fmDraft = null; renderFmStrip(); }
          });
          el.addEventListener('input', () => { fmDraft = { key: dk.value, val: dv.value }; });
        });
      }
    }
    const ensureRichEditor = async () => {
      if (!rich || disposed) return null;
      if (richEditor) {
        if (richStale) { richEditor.setMarkdown(richBody()); richStale = false; }
        return richEditor;
      }
      if (richLoading) return richLoading;
      richDoc.innerHTML = '<div class="ed-rich-loading">Loading the block editor…</div>';
      richLoading = mountMarkdownEditor(richDoc, richBody(), {
        resolveImage,
        // Session-only: GFM cannot store a column width, so dragged widths live
        // on the card and follow the document into the Read pane, nothing more.
        columnWidths: p.mdColWidths || (p.mdColWidths = {}),
        onColumnWidths: (index, widths) => { p.mdColWidths[index] = widths; },
        onCopyLink: (link) => api.copyText(link),
        onFocus: () => { S.activeId = p.id; refreshRail(); },
        onChange: (next) => {
          const whole = currentFm() + next;
          if (disposed || whole === p.text) return;
          p.text = whole; ta.value = whole; markDirty(); sync();
        },
      }).then((editor) => {
        if (disposed) { editor.destroy(); return null; }
        richEditor = editor; richLoading = null;
        const loading = q('.ed-rich-loading', richDoc); if (loading) loading.remove();
        if (richStale) { richEditor.setMarkdown(richBody()); richStale = false; }
        return editor;
      }).catch((error) => {
        richLoading = null;
        richDoc.innerHTML = `<div class="ed-rich-error">The block editor could not open. Markdown mode still works.<small>${esc(error && error.message || error)}</small></div>`;
        return null;
      });
      return richLoading;
    };
    rec.disposeEditor = () => {
      disposed = true;
      edRo.disconnect();
      if (richEditor) richEditor.destroy();
      richEditor = null;
    };

    // ---- following the file on disk -------------------------------------------
    // A rewrite lands here rather than through a close-and-reopen, so the panel
    // keeps its scroll, its undo stack, and — as far as one splice can promise —
    // its caret. Only ever reached for a clean panel, or for one whose owner
    // pressed Reload; a dirty panel raises the bar instead and is never
    // overwritten without being asked.
    const diskBar = q('.disk-bar', wrap);
    const hideDiskBar = () => { p.diskText = null; if (diskBar) diskBar.hidden = true; };
    rec.raiseDiskBar = (next) => {
      p.diskText = next;
      if (diskBar) diskBar.hidden = false;
    };
    if (p.diskText != null && diskBar) diskBar.hidden = false;   // survives a re-mount
    rec.reloadFromDisk = (next) => {
      if (disposed || typeof next !== 'string') return;
      const range = changeRange(ta.value, next);
      const focused = document.activeElement === ta;
      const selStart = ta.selectionStart, selEnd = ta.selectionEnd;
      const top = ta.scrollTop;
      p.text = next;
      p.lastHash = hashText(next);
      ta.value = next;
      // Offsets move with the splice, so text arriving further down the file
      // leaves the caret exactly where it was sitting.
      if (focused) { ta.selectionStart = shiftOffset(selStart, range); ta.selectionEnd = shiftOffset(selEnd, range); }
      ta.scrollTop = top;
      p.dirty = false;
      hideDiskBar();
      richStale = true;
      renderFmStrip();
      // The rich pane is replaced wholesale, which is right: a clean panel has
      // nothing in it to preserve, and Milkdown owns its own document.
      if (p.edMode === 'edit' && rich) void ensureRichEditor();
      else applyMode();
      sync();
      refreshTileHead(p); refreshRail(); refreshBrowserButtons(p);
    };
    if (diskBar) {
      q('.dk-reload', wrap).onclick = () => { const next = p.diskText; hideDiskBar(); rec.reloadFromDisk(next); };
      // Keep mine remembers the bytes it declined, so the next event about the
      // same unchanged file is recognised and dropped rather than asking again.
      q('.dk-keep', wrap).onclick = () => { if (p.diskText != null) p.lastHash = hashText(p.diskText); hideDiskBar(); };
    }
    // A link in a rendered doc is a link: plain click, no modifier. The terminal
    // needs Cmd because a click there belongs to whatever is running; a document
    // has no competing meaning for it.
    read.addEventListener('click', (ev) => {
      const a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      ev.preventDefault();
      openDocLink(a.getAttribute('href'), p, read);
    });

    // Lines soft-wrap to the pane, so a logical line can be several rows tall.
    // The hidden measure layer shares every glyph metric with the textarea (the
    // `.ed-hl, .ed-area, .ed-measure` rule), so the browser itself reports each
    // line's wrapped height — no font arithmetic to drift. Heights are read at
    // subpixel precision: offsetHeight rounds, and at --doc-scale 1.15 a
    // systematic 0.3px per line has the gutter a row off by line 100.
    let edLast = null;   // {value, width, scale} of the last full measure
    const sync = () => {
      const value = ta.value;
      const width = measure.clientWidth;
      const scale = docScaleOf(p);
      const dirty = !edLast || edLast.value !== value;
      if (dirty) {
        measure.innerHTML = value.split('\n').map((l) => `<div>${l ? esc(l) : '&#8203;'}</div>`).join('');
        // the underlay only ever mirrors the textarea, so it can't drift
        hl.innerHTML = md ? highlightMarkdown(value) : '';
      }
      // A pure resize re-wraps the measure layer by itself; only the heights
      // need re-reading — skipping the reparse keeps tile-drag cheap.
      if (dirty || edLast.width !== width || edLast.scale !== scale) {
        const rows = measure.children;
        gutter.innerHTML = Array.from(rows, (r, i) => `<div style="height:${r.getBoundingClientRect().height}px">${i + 1}</div>`).join('');
      }
      edLast = { value, width, scale };
      gutter.scrollTop = ta.scrollTop;
      hl.scrollTop = ta.scrollTop;
    };
    rec.edSync = sync;
    // Wrap points move whenever the pane is resized — tile drag, expand, rail
    // collapse — and the gutter has to follow.
    const edRo = new ResizeObserver(() => sync());
    edRo.observe(q('.ed-stack', wrap));
    const applyMode = () => {
      wrap.dataset.mode = p.edMode;
      if (p.edMode === 'read') {
        if (html) {
          // The page renders from the buffer, not the file, so Edit → Read shows
          // unsaved changes — the same live round trip markdown has. Sandboxed
          // exactly like the standalone viewer: scripts run, but the page has an
          // opaque origin and cannot reach KingAgent. The injected <base> makes the
          // page's own relative images and stylesheets resolve beside the file;
          // the parser hoists it into <head> wherever the document starts.
          read.innerHTML = '';
          const f = document.createElement('iframe');
          f.className = 'ed-html';
          if (p.dirty) {
            // Mid-edit the file on disk is stale, so the page is rendered from the
            // buffer in an opaque sandbox — the change shows live, its relative
            // images do not (an opaque origin cannot fetch file://), and they
            // return the moment you save. allow-scripts only; no same-origin,
            // because a srcdoc page shares KingAgent's file:// origin and the flag
            // would let it read the app.
            f.setAttribute('sandbox', 'allow-scripts');
            const text = p.text || '';
            const dir = 'file://' + String(p.filePath).split('/').slice(0, -1).map(encodeURIComponent).join('/') + '/';
            f.srcdoc = /<base[\s>]/i.test(text) ? text : `<base href="${dir}">` + text;
          } else {
            // Saved → served from kingagent-doc://, its own origin. Relative images
            // load, and allow-same-origin is safe: "same origin" is the page's
            // kingagent-doc origin, cross-origin to KingAgent, so it still cannot reach the
            // app (proved by the hostile-page test). connect-src 'none' in the
            // served CSP stops it sending anything it read anywhere.
            f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
            f.src = docUrl(p.filePath);
          }
          read.appendChild(f);
        } else {
          // Images in a doc resolve like the HTML Read tab's do: doc-relative
          // paths through kingagent-doc:// (its containment gate refuses .. escapes),
          // remote and data URLs as themselves. Absolute paths stay links — a
          // document does not get to display arbitrary files from the disk.
          read.innerHTML = renderMarkdown(p.text || '', {
            resolveImage: (src) => markdownImageUrl(p.filePath, src),
          });
          applyDocColWidths(read, p.mdColWidths);
        }
      }
      wrap.querySelectorAll('.ed-tab').forEach((b) => b.classList.toggle('active', b.dataset.m === p.edMode));
      if (p.edMode === 'edit' && rich) {
        renderFmStrip();   // markdown-tab edits to the YAML land here on re-entry
        void ensureRichEditor().then((editor) => {
          if (editor && p.edMode === 'edit') editor.focus();
        });
      }
      if ((p.edMode === 'edit' && !rich) || p.edMode === 'markdown') sync();
    };

    ta.addEventListener('input', () => { p.text = ta.value; markDirty(); if (rich) richStale = true; sync(); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; hl.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveEditor(p); }
      // insertText, not an assignment to ta.value: assigning replaces the field's
      // contents outside the browser's editing pipeline and throws the undo stack
      // away with them, so one Tab cost you the whole history — Cmd+Z afterwards
      // did nothing at all. Editing through the pipeline fires input, and the
      // handler above does the p.text/dirty/sync work that used to be repeated here.
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    });
    ta.addEventListener('focus', () => { S.activeId = p.id; refreshRail(); });
    wrap.querySelectorAll('.ed-tab').forEach((b) => {
      b.onclick = () => {
        p.edMode = b.dataset.m; applyMode();
        if (p.edMode === 'markdown' || (p.edMode === 'edit' && !rich)) ta.focus();
      };
    });
    const edPath = q('.ed-path', wrap);
    if (edPath) { edPath.title = REVEAL_LABEL; edPath.onclick = () => api.revealFile(p.filePath); }
    bindBrowserButton(q('.ed-browser', wrap), p);
    q('.ed-finder', wrap).onclick = () => api.revealFile(p.filePath);
    q('.ed-save', wrap).onclick = () => saveEditor(p);
    sync(); applyMode();
  }
  async function saveEditor(p) {
    const res = await api.saveFile({ file: p.filePath, text: p.text });
    if (res && res.ok) {
      // The echo guard. Our own write is about to come back off the watcher, and
      // without this the panel treats it as somebody else's change — which on a
      // buffer typed into since the save would raise a bar over our own save.
      p.lastHash = res.hash || hashText(p.text || '');
      p.diskText = null;
      p.dirty = false; refreshTileHead(p); refreshRail(); refreshBrowserButtons(p);
      toast('Saved ' + baseNameOf(p.filePath));
      return true;
    }
    toast('Save failed: ' + (res && res.error || '?'));
    return false;
  }

  // ---- viewer tiles (image / video / audio / pdf / fallback) -----------------
  function mountViewer(p, rec) {
    const wrap = document.createElement('div'); wrap.className = 'viewer viewer--' + p.sub;
    const url = fileUrl(p.filePath);
    const fallback = `<div class="vw-stage vw-stage--pad"><div class="vw-glyph">▣</div>
        <div class="vw-name">${esc(p.title)}</div>
        <div class="vw-note">${esc(p.note || "Can't preview this file here.")}</div>
        <button class="btn vw-reveal">${REVEAL_LABEL}</button></div>`;
    if (p.sub === 'image') wrap.innerHTML = `<div class="vw-stage"><img src="${esc(url)}" alt="${esc(p.title)}" /></div>`;
    else if (p.sub === 'video') wrap.innerHTML = `<div class="vw-stage vw-stage--dark"><video src="${esc(url)}" controls playsinline></video></div>`;
    else if (p.sub === 'audio') wrap.innerHTML = `<div class="vw-stage vw-stage--pad"><div class="vw-glyph">♪</div><div class="vw-name">${esc(p.title)}</div><audio src="${esc(url)}" controls></audio></div>`;
    else if (p.sub === 'pdf') wrap.innerHTML = `<iframe class="vw-pdf" src="${esc(url)}"></iframe>`;
    // Served from kingagent-doc://, the page's own origin — relative images load and
    // allow-same-origin is safe because that origin is cross-origin to KingAgent (see
    // the Read tab in mountEditor for the full reasoning). html routes to the
    // editor now, so this branch is a fallback; it uses the same safe path.
    else if (p.sub === 'html') wrap.innerHTML = `<iframe class="vw-pdf vw-html" sandbox="allow-scripts allow-same-origin" src="${esc(docUrl(p.filePath))}"></iframe>`;
    else wrap.innerHTML = fallback;
    wrap.insertAdjacentHTML('beforeend',
      `<div class="ed-bar"><span class="ed-path">${esc(shortHome(p.filePath))}</span><button class="btn vw-finder">Finder</button></div>`);
    rec.body.appendChild(wrap);
    wrap.querySelectorAll('.vw-reveal, .vw-finder, .ed-path').forEach((b) => { b.onclick = () => api.revealFile(p.filePath); if (b.classList.contains('ed-path')) b.title = REVEAL_LABEL; });
    // A rewritten PNG keeps its cached bitmap forever otherwise: the src is the
    // same URL, so nothing re-fetches and the tile shows yesterday's image. The
    // counter is the whole mechanism. A viewer has no buffer and nothing unsaved,
    // so there is no decision to make here — only a cache to break.
    rec.reloadFromDisk = () => {
      const el = wrap.querySelector('img, video, audio, iframe');
      if (!el) return;
      p.vwVersion = (p.vwVersion || 0) + 1;
      const base = el.classList.contains('vw-html') ? docUrl(p.filePath) : url;
      el.src = base + (base.includes('?') ? '&' : '?') + 'v=' + p.vwVersion;
      if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') el.load();
    };
    const media = wrap.querySelector('img, video, audio');
    if (media) media.addEventListener('error', () => {
      const stage = wrap.querySelector('.vw-stage, .vw-pdf');
      p.note = 'This format could not be decoded.';
      if (stage) stage.outerHTML = fallback;
      const b = wrap.querySelector('.vw-reveal'); if (b) b.onclick = () => api.revealFile(p.filePath);
    }, { once: true });
  }

  // ---- card tiles (agent / skill editing: form + raw markdown) ---------------
  // Agents differ per platform, so they are keyed by both. A skill is keyed by type
  // alone: its frontmatter is the same wherever the folder lives, and keying it by
  // platform meant a skill from Cursor or the project's own folder fell through to
  // the agent shape and offered Tools and Model — fields a SKILL.md has no use for,
  // which the form would then write into the file.
  const FIELD_MAP = {
    skill: [['name', 'Name'], ['description', 'Description']],
    // the master: the superset every dialect is a subset of
    'project:agent': [['name', 'Name'], ['description', 'Description'], ['tools', 'Tools'], ['model', 'Model'], ['mode', 'Mode']],
    'claude:agent': [['name', 'Name'], ['description', 'Description'], ['tools', 'Tools'], ['model', 'Model']],
    'opencode:agent': [['description', 'Description'], ['mode', 'Mode'], ['model', 'Model']],
    'opencode:command': [['description', 'Description'], ['agent', 'Agent'], ['model', 'Model']],
  };
  function connectionsOf(item) {
    const byId = new Map(S.library.items.map((i) => [i.id, i]));
    const out = S.library.edges.filter((e) => e.from === item.id).map((e) => byId.get(e.to)).filter(Boolean);
    const inn = S.library.edges.filter((e) => e.to === item.id).map((e) => byId.get(e.from)).filter(Boolean);
    return { out, inn };
  }
  // A skill that lives somewhere else is worth showing, but showing it is only
  // half a feature: this is the action that makes it usable here. Nothing offers
  // it for a skill already in the project, or one whose files have gone.
  function useHereLabel(item) {
    if (item.broken) return '';
    if (item.type === 'skill') return item.scope === 'project' ? '' : 'Use here';
    return item.readOnly ? 'Duplicate to project' : '';
  }
  // A hand-made platform agent can be lifted into the drawer; a master already
  // is everyone's, and read-only plugin agents are somebody else's to lift.
  function canAdopt(item) {
    return item.type === 'agent' && !item.readOnly && !item.broken && !!S.project
      && ['claude', 'opencode', 'gemini', 'antigravity', 'kimi'].includes(item.platform);
  }
  async function openCard(item, opts) {
    await loadLibrary();
    const r = resolveOpen(S.panels, 'card', item.filePath);
    if (r.action === 'focus') { focusPanel(r.id); return; }
    const res = await api.rawFile(item.filePath);
    if (!res.ok) { toast(res.error || 'Could not open'); loadLibrary(true); return; }
    const doc = parseDoc(res.text);
    const chip = TYPE_CHIP[item.type] || TYPE_CHIP.agent;
    const p = {
      id: uid('p_'), kind: 'card', item, filePath: item.filePath, doc, raw: res.text,
      // The invariant is 'only markdown edits as frontmatter', and it must not
      // rest on a .toml never happening to start with ---.
      mode: doc.hasFrontmatter && editsAsFrontmatter(item.filePath) ? 'form' : 'raw', dirty: false, status: 'live',
      chipKind: chip.kind, code: chip.code, title: item.name, cwd: S.project && S.project.path,
    };
    if (doc.malformed) toast('Frontmatter looks malformed. Raw view only.');
    if (opts && opts.pin) pinFilePanel(p, opts);
    else openPeek(p);
  }
  function mountCard(p, rec) {
    // A broken link has no file behind it, so its inputs are disabled for the same
    // reason a plugin's are: there is nothing here that saving could write to.
    const ro = p.item.readOnly || p.item.broken;
    const wrap = document.createElement('div'); wrap.className = 'card-ed';
    const fields = FIELD_MAP[p.item.type] || FIELD_MAP[p.item.platform + ':' + p.item.type] || FIELD_MAP['claude:agent'];
    // The form is a frontmatter editor, and only markdown has frontmatter. Codex
    // agents are TOML: offered the form, it would find no fence, fall through to
    // Claude's field list, and the first keystroke would make setField *create*
    // frontmatter — writing a YAML block onto somebody's hand-written TOML and
    // leaving a file Codex can no longer parse. No form, and the raw tab is
    // named for what it actually holds.
    const asMarkdown = editsAsFrontmatter(p.filePath);
    wrap.innerHTML = `
      <div class="card-tabs">
        ${asMarkdown ? '<button class="card-tab" data-m="form">Form</button>' : ''}
        <button class="card-tab" data-m="raw">${asMarkdown ? 'Markdown' : esc(formatLabel(p.filePath))}</button>
        <span class="card-src">${esc(p.item.platform + ' ' + p.item.type + ' · ' + p.item.scope)}${ro ? ' · read-only' : ''}</span>
      </div>
      <div class="card-form">
        ${fields.map(([k, label]) => `<label class="card-lbl">${esc(label)}</label>
          <input class="card-in" data-f="${k}" ${ro ? 'disabled' : ''} />`).join('')}
        <label class="card-lbl">Instructions</label>
        <textarea class="card-body" spellcheck="false" ${ro ? 'disabled' : ''}></textarea>
      </div>
      <div class="card-raw"><textarea class="raw-area" spellcheck="false" ${ro ? 'readonly' : ''}></textarea></div>
      <div class="card-links"></div>
      <div class="ed-bar">
        <span class="ed-path">${esc(shortHome(p.filePath))}</span>
        <button class="btn card-finder">Finder</button>
        ${p.item.type === 'agent' && p.item.platform === 'claude' ? '<button class="btn card-use">Use</button>' : ''}
        ${canAdopt(p.item) ? '<button class="btn btn--go card-adopt">Make it everyone’s</button>' : ''}
        ${useHereLabel(p.item) ? `<button class="btn btn--go card-dup">${esc(useHereLabel(p.item))}</button>` : ''}
        ${p.item.broken ? '<button class="btn btn--go card-del">Remove this dead link</button>'
          : ro ? ''
          : '<button class="btn card-del">Delete</button><button class="btn card-improve">Improve with my agent</button><button class="btn btn--go card-save">Save ⌘S</button>'}
      </div>`;
    rec.body.appendChild(wrap);
    const formEl = q('.card-form', wrap), rawEl = q('.card-raw', wrap), rawTa = q('.raw-area', wrap), bodyTa = q('.card-body', wrap);
    const markDirty = () => { if (!p.dirty) { p.dirty = true; keepFile(p); refreshTileHead(p); refreshRail(); } };

    const syncFormFromDoc = () => {
      formEl.querySelectorAll('.card-in').forEach((inp) => { inp.value = getField(p.doc, inp.dataset.f); });
      bodyTa.value = p.doc.body;
    };
    const applyMode = () => {
      const formMode = p.mode === 'form';
      formEl.style.display = formMode ? '' : 'none';
      rawEl.style.display = formMode ? 'none' : '';
      wrap.querySelectorAll('.card-tab').forEach((b) => b.classList.toggle('active', b.dataset.m === p.mode));
      if (formMode) syncFormFromDoc(); else rawTa.value = p.raw;
    };
    wrap.querySelectorAll('.card-tab').forEach((b) => {
      b.onclick = () => {
        const target = b.dataset.m;
        if (target === p.mode) return;
        if (target === 'raw') { p.raw = serializeDoc(p.doc); p.mode = 'raw'; applyMode(); return; }
        if (!asMarkdown) return;   // there is no form for a file with no frontmatter to edit
        const doc = parseDoc(rawTa.value);
        if (doc.malformed) { toast('Fix the frontmatter fences (---) first — staying in raw view.'); return; }
        p.raw = rawTa.value; p.doc = doc; p.mode = 'form'; applyMode();
      };
    });
    formEl.querySelectorAll('.card-in').forEach((inp) => {
      inp.addEventListener('input', () => { setField(p.doc, inp.dataset.f, inp.value); markDirty(); });
    });
    bodyTa.addEventListener('input', () => { p.doc.body = bodyTa.value; markDirty(); });
    rawTa.addEventListener('input', () => { p.raw = rawTa.value; markDirty(); });
    [bodyTa, rawTa].forEach((ta) => ta.addEventListener('focus', () => { S.activeId = p.id; refreshRail(); }));

    // connections strip: what this references, what references it (from the library edges)
    const linksEl = q('.card-links', wrap);
    const { out, inn } = connectionsOf(p.item);
    if (out.length || inn.length) {
      const chip = (i) => `<button class="link-chip" data-id="${esc(i.id)}">${esc(i.slug)}</button>`;
      linksEl.innerHTML =
        (out.length ? `<span class="lk-lbl">references →</span>${out.map(chip).join('')}` : '') +
        (inn.length ? `<span class="lk-lbl">← referenced by</span>${inn.map(chip).join('')}` : '');
      linksEl.querySelectorAll('.link-chip').forEach((b) => {
        b.onclick = () => { const it = S.library.items.find((x) => x.id === b.dataset.id); if (it) openCard(it); };
      });
    } else linksEl.style.display = 'none';

    const cardPath = q('.ed-path', wrap);
    if (cardPath) { cardPath.title = REVEAL_LABEL; cardPath.onclick = () => api.revealFile(p.filePath); }
    const cardFinder = q('.card-finder', wrap);
    if (cardFinder) cardFinder.onclick = () => api.revealFile(p.filePath);
    const useBtn = q('.card-use', wrap);
    // Same resolution the picker uses, so Use and ⌘K never disagree about
    // which tool an agent runs on.
    if (useBtn) useBtn.onclick = () => {
      const tool = rowTool(p.item);
      if (!tool) { toast('Nothing installed can run ' + p.item.slug + '.'); return; }
      launchAgent(p.item, tool);
    };
    const adoptBtn = q('.card-adopt', wrap);
    if (adoptBtn) adoptBtn.onclick = async () => {
      if (p.dirty) { toast('Save the card first — the master is lifted from the file.'); return; }
      adoptBtn.disabled = true; adoptBtn.textContent = 'Lifting…';
      const res = await api.adoptAgent({ filePath: p.item.filePath, platform: p.item.platform, projectPath: S.project.path, agentIds: installedAgentIds() });
      if (!res.ok) { toast(res.error || 'Could not lift it'); adoptBtn.disabled = false; adoptBtn.textContent = 'Make it everyone’s'; return; }
      if (S.panels.includes(p)) closePanel(p.id); else closeOverlay();
      await loadLibrary(true);
      const master = S.library.items.find((i) => i.filePath === res.masterPath);
      toast('Now everyone’s — the master lives in agents/.');
      if (master) openCard(master);
    };
    const saveBtn = q('.card-save', wrap); if (saveBtn) saveBtn.onclick = () => saveCard(p);
    const dupBtn = q('.card-dup', wrap);
    if (dupBtn) dupBtn.onclick = async () => {
      if (!S.project) { toast('Open a folder first — the copy lands in the project.'); return; }
      const res = await api.libraryDuplicate({ filePath: p.item.filePath, type: p.item.type, projectPath: S.project.path });
      if (!res.ok) { toast(res.error || 'Copy failed'); return; }
      // A skill only runs here once the pointer says so, so the copy and the
      // announcement are one action — otherwise Use here leaves you half done.
      if (p.item.type === 'skill') {
        const w = await api.pointerWrite({ dir: S.project.path, agentIds: installedAgentIds() });
        toast(w && w.ok && (w.written || []).length
          ? `Copied in and announced — every installed agent knows about ${res.item.slug} now.`
          : 'Copied into this project — opening your editable copy.');
        await refreshPointer(true);
      } else toast('Copied into this project — opening your editable copy.');
      loadLibrary(true);
      openCard(res.item);
    };
    const impBtn = q('.card-improve', wrap);
    if (impBtn) impBtn.onclick = () => {
      if (p.dirty) { toast('Save the card first so your agent sees your latest.'); return; }
      openImproveItem(p.item);
    };
    const delBtn = q('.card-del', wrap);
    if (delBtn) delBtn.onclick = async () => {
      if (!delBtn.dataset.armed) { delBtn.dataset.armed = '1'; delBtn.textContent = 'Really move to Trash?'; delBtn.classList.add('armed'); return; }
      const res = await api.libraryDelete({ filePath: p.item.filePath, projectPath: S.project && S.project.path });
      if (!res.ok) { toast(res.error || 'Could not delete'); return; }
      if (S.panels.includes(p)) closePanel(p.id); else closeOverlay();
      loadLibrary(true); toast('Moved to Trash.');
      // and stop advertising it, along with any native link that pointed at it
      if (p.item.type === 'skill' && p.item.scope === 'project' && S.project) {
        api.pointerWrite({ dir: S.project.path, agentIds: installedAgentIds() }).then(() => refreshPointer(true));
      }
    };
    // clicking or tabbing anywhere else stands the armed Delete back down
    if (delBtn) delBtn.onblur = () => {
      if (!delBtn.dataset.armed) return;
      delete delBtn.dataset.armed; delBtn.textContent = 'Delete'; delBtn.classList.remove('armed');
    };
    applyMode();
  }
  async function saveCard(p) {
    if (p.item.readOnly) return;
    if (p.mode === 'form') p.raw = serializeDoc(p.doc);
    const res = await api.saveFile({ file: p.filePath, text: p.raw });
    if (res && res.ok) {
      p.dirty = false;
      p.title = getField(p.doc, 'name') || p.item.slug;
      refreshTileHead(p); refreshRail(); toast('Saved ' + p.title);
      loadLibrary(true);
      // The block publishes each skill's description, so editing one here is a
      // reason to rewrite it — the announcement should not lag the file.
      if (p.item.type === 'skill' && p.item.scope === 'project' && S.project) {
        api.pointerWrite({ dir: S.project.path, agentIds: installedAgentIds() }).then(() => refreshPointer(true));
      }
      // A master agent's copies must never lag the master — regenerate on save.
      if (p.item.type === 'agent' && p.item.platform === 'project' && S.project) {
        api.deliverAgents({ projectPath: S.project.path, agentIds: installedAgentIds() });
      }
    } else toast('Save failed: ' + (res && res.error || '?'));
  }

  // ---- dictation (in-app mic + clipboard paste) ------------------------------
  // Which engine transcribes is main's business (see stt.js). The renderer only
  // records, decodes to the 16 kHz mono float every engine can read, and asks.
  let annotationRecording = null;
  let recording = null; // { panelId, recorder, stream }

  // S.sttInfo mirrors stt.status(): { active, chosen, ready, providers[] }.
  function setSttInfo(info) {
    S.sttInfo = info || { active: null, chosen: null, ready: false, providers: [] };
    S.stt = !!S.sttInfo.ready;
    return S.sttInfo;
  }
  async function refreshSttInfo() { return setSttInfo(await api.sttStatus()); }

  // Only Chromium can decode Opus-in-WebM, so the samples have to be made here.
  // Returns null when decoding fails — cloud providers can still use the raw blob.
  async function decodePcm(blob) {
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      try {
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
        // downmix, scaled by 1/√2 per channel so a centred voice keeps its level
        const l = buf.getChannelData(0), r = buf.getChannelData(1);
        const out = new Float32Array(l.length), k = Math.SQRT1_2;
        for (let i = 0; i < l.length; i++) out[i] = k * (l[i] + r[i]);
        return out;
      } finally { ctx.close(); }
    } catch (_) { return null; }
  }

  // One recording → text. Sends both shapes: decoded samples for the on-device
  // engine, the original webm so cloud providers upload ~8 KB/s instead of a WAV.
  async function transcribeBlob(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pcm = await decodePcm(blob);
    return api.transcribe({ pcm, sampleRate: 16000, bytes, mime: blob.type || 'audio/webm' });
  }
  function startAnnotationDictation({ onState, onText, onError }) {
    let cancelled = false, recorder = null, stream = null;
    const release = () => stream?.getTracks().forEach(track => track.stop());
    const handle = {
      cancel() { cancelled = true; if(annotationRecording===handle)annotationRecording=null; if (recorder?.state === 'recording') recorder.stop(); release(); onState('idle'); },
      stop() { if (recorder?.state === 'recording') recorder.stop(); },
    };
    if(annotationRecording){queueMicrotask(()=>onError('Finish the current comment recording first.'));return handle;}
    annotationRecording=handle;
    (async () => {
      await Promise.resolve();
      if(cancelled)return;
      try {
        if (recording) throw new Error('Stop session dictation before recording a comment.');
        if (!S.stt) throw new Error('Choose a speech provider in Settings → Voice first.');
        onState('starting'); stream = await navigator.mediaDevices.getUserMedia({ audio:true });
        if (cancelled) { release(); return; }
        recorder = new MediaRecorder(stream); const chunks = [];
        recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
        recorder.onerror = () => { release(); if (!cancelled) { onState('idle'); onError('Microphone recording failed.'); } };
        recorder.onstop = async () => {
          release(); if (cancelled) return; onState('transcribing');
          try { const result = await transcribeBlob(new Blob(chunks, {type:recorder.mimeType || 'audio/webm'}));
            if (cancelled) return; if (!result?.ok || !result.text) throw new Error(result?.error || 'No speech detected.');
            onText(result.text);
          } catch (error) { if (!cancelled) onError(error.message); }
          finally { if(annotationRecording===handle)annotationRecording=null; if (!cancelled) onState('idle'); }
        };
        recorder.start(); onState('recording');
      } catch (error) { release(); if(annotationRecording===handle)annotationRecording=null; if (!cancelled) { onState('idle'); onError(error.message); } }
    })();
    return handle;
  }
  function micBtn(p) {
    const t = tileEls.get(p.id); if (!t) return null;
    return q('.t-mic', t.head);
  }
  function setMicState(p, state) {
    const b = micBtn(p); if (!b) return;
    if (!b.dataset.idle) b.dataset.idle = b.innerHTML; // whatever glyph pair it was born with
    b.classList.toggle('rec', state === 'recording');
    b.classList.toggle('busy', state === 'transcribing');
    if (state === 'recording') b.innerHTML = '<span class="rec-square"></span>';
    else if (state === 'transcribing') b.textContent = '…';
    else b.innerHTML = b.dataset.idle;
    b.title = state === 'recording' ? 'Stop & transcribe' : state === 'transcribing' ? 'Transcribing…' : 'Dictate into this session';
  }
  async function toggleMic(p) {
    if(annotationRecording){toast('Finish or cancel comment dictation first.');return;}
    if (recording && recording.panelId === p.id) { stopMic(); return; }
    if (recording) stopMic();
    // nothing set up: send them somewhere they can fix it, rather than a dead end
    if (!S.stt) { toast('Pick how KingAgent should hear you.'); return openSettings('voice'); }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream); const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((x) => x.stop());
        setMicState(p, 'transcribing');
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const res = await transcribeBlob(blob);
        setMicState(p, 'idle');
        if (res && res.ok && res.text) { injectToSession(p, res.text); toast('Dictated: ' + shorten(res.text, 40)); }
        else toast('Transcribe failed: ' + (res && res.error || 'no speech'));
      };
      rec.start(); recording = { panelId: p.id, recorder: rec, stream };
      setMicState(p, 'recording');
      toast('Recording… click the mic again to stop.');
    } catch (e) { toast('Mic error: ' + e.message); }
  }
  function stopMic() { if (recording) { try { recording.recorder.stop(); } catch (_) {} recording = null; } }
  function injectToSession(p, text) {
    if (!text) return;
    focusPanel(p.id, false, { preserveLayout:true });
    if (p.kind === 'acp') {
      const t = tileEls.get(p.id); if (!t || !t.aiInput) return;
      t.aiInput.value += (t.aiInput.value && !t.aiInput.value.endsWith(' ') ? ' ' : '') + text;
      t.aiInput.dispatchEvent(new Event('input'));
      t.aiInput.focus();
      return;
    }
    if (p.kind === 'editor') {
      const t = tileEls.get(p.id); if (!t || !t.ta) return;
      // Same reason as the Tab key: assigning ta.value costs the undo stack, and
      // dictation was spending it on every insert. focusPanel above already put
      // the keyboard here; execCommand needs that for certain, so say so.
      t.ta.focus();
      document.execCommand('insertText', false, text);
      return;
    }
    if (p.autoName) feedSessionName(p, text);
    api.termWrite({ id: p.id, data: text });
  }
  // Rename in place: the label becomes an input sitting exactly where it was, so
  // the tile never reflows. Enter keeps it, Escape and an empty name abandon it.
  // A name you set by hand outranks everything, including claude's own, and rides
  // down into claude on the next spawn so both sides read the same.
  function beginRename(p, el) {
    if (!el || el.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'name-edit';
    input.value = p.title;
    input.setAttribute('aria-label', 'Rename session');
    el.textContent = '';
    el.appendChild(input);
    input.focus(); input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return; done = true;
      const next = input.value.trim();
      if (keep && next && next !== p.title) applyTitle(p, next, 'user');
      else { refreshTileHead(p); refreshRail(); }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // Every rename in the app goes through here, so precedence is decided in one
  // place: your own name sticks, claude's name upgrades a guess, a guess only
  // ever fills an unnamed tile. Returns whether the label actually moved.
  function applyTitle(p, title, source) {
    const win = adoptTitle({ title: p.title, source: p.titleSource }, { title, source });
    if (!win) return false;
    p.title = win.title; p.titleSource = win.source;
    if (source !== 'prompt') { p.autoName = false; p._nameDraft = ''; }
    refreshTileHead(p); refreshRail(); savePanels();
    for (const f of S.panels) if (f.owner === p.id) refreshTileHead(f); // file cards name their session
    if (source !== 'user') flashTitle(p); // you typed it yourself: nothing to notice
    return true;
  }
  // One flash on both labels when a name arrives on its own, so the rename is
  // noticed rather than puzzled over. The rail row was just rebuilt, so only the
  // tile's label needs its animation restarted.
  function flashTitle(p) {
    const t = tileEls.get(p.id);
    const labels = [t && q('.t-title', t.head), q(`.nav-card[data-id="${p.id}"] .goal`)].filter(Boolean);
    for (const el of labels) { el.classList.remove('renamed'); void el.offsetWidth; el.classList.add('renamed'); }
  }
  // Keystrokes stream into a name draft until Enter commits one (session-name.mjs
  // decides); the committed prompt names the tile straight away, so the rail is
  // useful from the first turn — claude's own name replaces it a minute later.
  function feedSessionName(p, data) {
    const r = feedNameDraft(p._nameDraft, data);
    p._nameDraft = r.draft;
    if (!r.name) return;
    p.autoName = false; p._nameDraft = '';
    applyTitle(p, r.name, 'prompt');
  }

  return {
    mountEditor, saveEditor, mountViewer, connectionsOf, useHereLabel, canAdopt, openCard, mountCard, saveCard,
    setSttInfo, refreshSttInfo, decodePcm, transcribeBlob, startAnnotationDictation, micBtn, setMicState, toggleMic,
    stopMic, injectToSession, beginRename, applyTitle, flashTitle, feedSessionName,
  };
}
