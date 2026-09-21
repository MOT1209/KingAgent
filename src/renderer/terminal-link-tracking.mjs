import { scanLinks, urlTarget } from './term-links.mjs';
import { termMenuItems } from './term-menu.mjs';
import { runBounds, leadingIndent, lastCol, rowPiece, MAX_JOINS } from './term-wrap.mjs';
import { basesFromText, joinBase } from './path-bases.mjs';

// Extracted from app.js verbatim, as part of splitting that file into
// smaller feature modules.
//
// Cmd/Ctrl-click anything an agent prints: a URL opens in your browser, a file
// opens as an editor tile right here, a folder reveals in Finder. Hold Alt and
// a file reveals in Finder instead of opening.
//
// Nothing dead is ever offered: a path is stat'd before it underlines, so the
// only things that light up are things that actually open.
export function createTerminalLinkTracking({ api, state, q, tiles, terminalHint, toast, shorten,
  openSelectionDraft, showMenu, browsers, setView, openFile, confirmOutsideOpen, REVEAL_LABEL }) {
  const LINK_STAT_TTL = 10000;
  const linkStats = new Map(); // `${id}\0${cwd}\0${token}` -> { at, st }
  // The session id is part of the key, not decoration: two tiles opened on the
  // same folder can be sitting in different directories, and a cache keyed on
  // the frozen cwd alone would hand one tile's answer to the other.
  async function statLink(token, cwd, id) {
    const key = `${id || ''}\u0000${cwd || ''}\u0000${token}`;
    const hit = linkStats.get(key);
    if (hit && Date.now() - hit.at < LINK_STAT_TTL) return hit.st;
    const st = await api.statPath({ token, cwd, id });
    // Evict oldest-first rather than wiping: a clear() under pressure meant a
    // busy screen re-statted everything it had just learned, over and over.
    // The delete before set matters: Map.set on an existing key keeps its old
    // position, so without it a hot key refreshed for the tenth time would
    // still sit at the front of insertion order — first in line to be evicted.
    if (linkStats.size > 800) {
      let drop = 200;
      for (const k of linkStats.keys()) { linkStats.delete(k); if (--drop <= 0) break; }
    }
    linkStats.delete(key);
    linkStats.set(key, { at: Date.now(), st });
    return st;
  }

  // A path long enough to wrap is still one path. Walk the whole wrapped run and
  // keep a cell address per character, so the underline lands on the right cells
  // even when the line holds wide glyphs (a wide char is one string char but two
  // columns, and its second cell reports width 0).
  // A hard wrap is not a wrap: a program that measured the width itself and
  // printed its own newline leaves isWrapped false on both rows, nothing joins
  // them, and scanLinks matches the head of a severed URL as a whole one. The
  // walk goes both ways so hovering either fragment finds the other; see
  // term-wrap.mjs for why the guards are as narrow as they are.
  function wrappedRow(term, y, mode = false) {
    const buf = term.buffer.active;
    const cols = term.cols;
    const { top, bottom, hard } = runBounds(buf, y, cols, mode);
    let text = ''; const at = [];
    for (let row = top; row <= bottom; row++) {
      const line = buf.getLine(row); if (!line) continue;
      // A joined row's hanging indent is not part of the token, and emitting it
      // would put a space in the middle of the URL the scanner is about to read.
      const from = hard.has(row) ? leadingIndent(line, cols) : 0;
      // Same seam, other side: a loose head broke short of the edge, and its
      // blank tail would be emitted as spaces between the two halves. A strict
      // head is full, so trimming it is a no-op.
      const to = hard.has(row + 1) ? lastCol(line, cols) : term.cols;
      for (let x = from; x < to; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const ch = cell.getChars() || ' ';
        for (let i = 0; i < ch.length; i++) at.push({ x: x + 1, y: row + 1 });
        text += ch;
      }
    }
    // top is handed back for callers that walk the buffer run by run
    // (collectBases): one call answers both "what does this run say" and
    // "where does the next one start", instead of a second bounds walk.
    return { text, at, top, bottom };
  }

  function openTermLink(link, st, ev) {
    if (link.kind === 'url') { api.openUrl(urlTarget(link.text)); return; }
    if (st && st.isFile && !(ev && ev.altKey)) { if (confirmOutsideOpen(st.abs)) openFile(st.abs); }
    else if (st) api.revealFile(st.abs);
  }

  // What the pointer is over, per tile, so the right-click menu knows what was
  // right-clicked. xterm already does the hit-testing to fire hover/leave;
  // recomputing a cell from mouse coordinates would be a second implementation of
  // it, free to disagree with the one drawing the underline.
  const hoveredLink = new Map();   // panel id -> { link, st }

  // The absolute folders recently visible in a card, most recent first — the
  // haystack a missed relative path is retried against (path-bases.mjs has the
  // why). Walked as loose-glued runs so a base that wrapped across rows is
  // seen whole. Cached briefly per panel: the scan is pure string work but a
  // hover storm should not repeat it.
  const panelBases = new Map();   // panel id + region bucket -> { at, mark, bases }
  const BASES_TTL = 5000;
  const BASES_ROWS = 150;
  async function collectBases(term, p, anchorTop) {
    const buf = term.buffer.active;
    // Keyed by WHERE the hover is, not just which panel: a scrolled-up hover
    // must not borrow folders from a later era of the session, and the walk
    // below anchors at the hovered run for the same reason.
    const key = p.id + ':' + Math.floor(anchorTop / 50);
    // Buffer shape as a freshness hint on top of a short TTL. Honest limits:
    // once the scrollback ring is full, length pins at the cap and the mark
    // stops moving — the TTL is short precisely because the mark cannot be
    // trusted to signal in that state.
    const mark = buf.length + ':' + buf.cursorY;
    const hit = panelBases.get(key);
    if (hit && hit.mark === mark && Date.now() - hit.at < BASES_TTL) return hit.bases;
    const bases = []; const seen = new Set();
    // Walk UP from the hovered run: the folder a short path is relative to is
    // named above it — the user's prompt, the sweep header — not at the
    // bottom of the scrollback.
    let y = Math.min(anchorTop + 1, buf.length), walked = 0;
    while (y >= 1 && walked < BASES_ROWS && bases.length < 6) {
      const run = wrappedRow(term, y, true);
      // No slash, no folder — skip the scan without paying for it.
      if (run.text.indexOf('/') !== -1) {
        for (const b of basesFromText(run.text, 6)) {
          if (seen.has(b)) continue;
          seen.add(b);
          // The glue that produced this text was loose and unverified, so the
          // disk vets every base: prose fused onto a path ("…/shotsand") is
          // no folder, and garbage must not burn slots in the pool.
          const st = await statLink(b, p.cwd, p.id);
          if (st && st.exists && !st.isFile) bases.push(b);
          if (bases.length >= 6) break;
        }
      }
      walked += y - run.top;   // y is 1-based, top 0-based: exactly the run's rows
      y = run.top;             // the row just above the run
    }
    if (panelBases.size > 400) {
      let drop = 100;
      for (const k of panelBases.keys()) { panelBases.delete(k); if (--drop <= 0) break; }
    }
    panelBases.set(key, { at: Date.now(), mark, bases });
    return bases;
  }

  // Two cells in reading order, ranges inclusive on both ends the way xterm
  // hands them out.
  function cellBefore(a, b) { return a.y < b.y || (a.y === b.y && a.x < b.x); }
  function rangesTouch(a, b) {
    return !(cellBefore(a.end, b.start) || cellBefore(b.end, a.start));
  }

  function registerTerminalLinks(term, p) {
    if (!term.registerLinkProvider) return;

    const build = (rows, at) => {
      const links = [];
      for (const row of rows) {
        if (!row) continue;
        const start = at[row.link.start], end = at[row.link.end - 1];
        if (!start || !end) continue;
        const live = row.link.kind === 'url' || !!row.st;
        links.push({
          text: row.link.text,
          range: { start, end },
          // Without this xterm decorates nothing: a path that opens on
          // ⌘-click looked exactly like a path that does not, and the only
          // way to find out was to try. Now the cursor and the underline say
          // so before you commit to the click. Dead paths stay bare — the
          // underline has to keep meaning "this opens".
          decorations: live ? { pointerCursor: true, underline: true } : { pointerCursor: false, underline: false },
          activate: (ev) => { if (live && (ev.metaKey || ev.ctrlKey)) openTermLink(row.link, row.st, ev); },
          hover: (ev) => {
            hoveredLink.set(p.id, { link: row.link, st: row.st, live });
            if (!state.overlay && !q('#ctx-menu')) terminalHint.show({ kind: row.link.kind, st: row.st }, ev, p);
          },
          // Only clear if this link is still the one recorded. Moving from
          // one link straight onto the next fires the new hover before the
          // old leave, and an unconditional delete would throw away the link
          // the pointer is actually on.
          leave: () => {
            const cur = hoveredLink.get(p.id);
            if (cur && cur.link === row.link) { hoveredLink.delete(p.id); terminalHint.hide(p); }
          },
        });
      }
      return links;
    };

    const resolveLinks = async (y) => {
      const strict = wrappedRow(term, y);
      const found = strict.text ? scanLinks(strict.text) : [];
      const rows = await Promise.all(found.map(async (link) => {
        if (link.kind === 'url') return { link, st: null };
        const st = await statLink(link.text, p.cwd, p.id);
        // A missed stat is handed over rather than dropped. Undecorated and
        // inert, it looks and behaves exactly as it does now — but xterm knows
        // it is there, which is what gives it a right-click. Copying does not
        // need the file to exist, and gating the menu on the stat would hide it
        // in the one case it exists for.
        return { link, st: st && st.exists ? st : null };
      }));

      // Where a token sits in its run: against the leading blank edge, the
      // trailing one, both, or neither. Computed once per token — the base
      // retry and the growth pass below both read it.
      const edgesOf = (l) => ({
        start: !strict.text.slice(0, l.start).trim(),
        end: !strict.text.slice(l.end).trim(),
      });

      // A relative path that missed the card's folder gets a second chance
      // against the folders on screen — cwd first (it already ran, above),
      // scavenged bases after, first hit wins, disk arbitrates. Every relative
      // miss qualifies: a CLI listing files "one per line" puts each path
      // alone on its row, which is the shape this exists for. A miss on every
      // base leaves the row exactly as it was. Misses run concurrently;
      // within one miss the bases stay ordered, most recent folder first.
      const relMisses = rows.filter((r) => r.link.kind === 'path' && !r.st
        && r.link.text[0] !== '/' && r.link.text[0] !== '~');
      if (relMisses.length) {
        const bases = await collectBases(term, p, strict.top);
        await Promise.all(relMisses.slice(0, 12).map(async (r) => {
          for (const b of bases) {
            const joined = joinBase(b, r.link.text);
            if (!joined) return;   // a shape joinBase refuses is refused for every base
            const st = await statLink(joined, p.cwd, p.id);
            if (st && st.exists) { r.st = st; return; }
          }
        }));
      }
      let links = build(rows, strict.at);

      // The loose reglue: a path severed by an early break under a hanging
      // indent (Claude's tool results). Runs when a path is still missing OR
      // the strict scan found nothing at all — the hovered row may be a bare
      // continuation fragment ("er/scene.png", or even just "me") that scans
      // as nothing, and the glued run is where the whole path appears. A
      // candidate becomes a link only if it exists on disk.
      let looseLinks = [];
      if (rows.some((r) => r.link.kind === 'path' && !r.st) || !found.length) {
        const loose = wrappedRow(term, y, true);
        if (loose.text !== strict.text) {
          const candidates = scanLinks(loose.text).filter((l) => l.kind === 'path');
          const confirmed = (await Promise.all(candidates.map(async (link) => {
            const st = await statLink(link.text, p.cwd, p.id);
            return st && st.exists ? { link, st } : null;
          }))).filter(Boolean);
          if (confirmed.length) {
            looseLinks = build(confirmed, loose.at);
            links = looseLinks.concat(links.filter((l) => !looseLinks.some((w) => rangesTouch(w.range, l.range))));
          }
        }
      }

      // The anchored growth: a still-missing token touching the run's edge may
      // be a fragment of a column-0 wrap — codex, antigravity and opencode
      // break at their own inner width and continue flush left. Column 0 must
      // not JOIN as a mode (adjacent paths in a list would merge into one dead
      // token), so the extension anchors on the failing token: grow it a row
      // at a time in the direction it touches, and believe the shortest grown
      // path the disk confirms. One geometric guard survives from the join
      // modes: a row only counts as CUT if it is filled past two thirds of the
      // width — "mv src/app" alone on a wide row was a chosen break, and
      // growing it would let a lucky disk hit mint a link out of prose.
      const buf0 = term.buffer.active;
      const cut = (row) => {
        const l = buf0.getLine(row);
        // Two thirds of the CURRENT width, capped at 60: hard-wrapped rows
        // keep their printed width when a tile is widened (xterm reflows only
        // soft wraps), and an emitter wrapping an inner column narrower than
        // the tile is still a real cut. 60 columns of unbroken path-like text
        // ending mid-token is evidence enough at any tile size.
        return !!l && lastCol(l, term.cols) >= Math.min(Math.floor((term.cols * 2) / 3), 60);
      };
      const fragMisses = rows.filter((r) => {
        if (r.link.kind !== 'path' || r.st) return false;
        const e = edgesOf(r.link);
        return e.start || e.end;
      }).slice(0, 4);
      if (fragMisses.length) {
        // A fragment for growing downward is a row's leading unbroken run; one
        // for growing upward is its trailing run. `whole` says the run WAS the
        // whole row — a row that also carried an annotation ends the path, so
        // growth stops after taking its piece.
        const downFrag = (row) => {
          const piece = rowPiece(buf0.getLine(row), term.cols); if (!piece) return null;
          const cutAt = piece.text.search(/\s/);
          const text = cutAt === -1 ? piece.text : piece.text.slice(0, cutAt);
          if (!text) return null;
          return { text, endCell: { x: piece.at[text.length - 1] + 1, y: row + 1 }, whole: cutAt === -1 };
        };
        const upFrag = (row) => {
          const piece = rowPiece(buf0.getLine(row), term.cols); if (!piece) return null;
          const m = piece.text.match(/\S+$/); if (!m) return null;
          const off = piece.text.length - m[0].length;
          return { text: m[0], startCell: { x: piece.at[off] + 1, y: row + 1 }, whole: off === 0 };
        };
        const extras = [];
        for (const r of fragMisses) {
          const tokenStart = strict.at[r.link.start], tokenEnd = strict.at[r.link.end - 1];
          if (!tokenStart || !tokenEnd) continue;
          // Already healed by the loose reglue: nothing left to grow.
          if (looseLinks.some((w) => rangesTouch(w.range, { start: tokenStart, end: tokenEnd }))) continue;
          const e = edgesOf(r.link);
          const downs = []; const ups = [];
          if (e.end && cut(strict.bottom)) {
            let acc = '';
            for (let k = 1; k <= MAX_JOINS; k++) {
              const f = downFrag(strict.bottom + k); if (!f) break;
              acc += f.text; downs.push({ text: acc, endCell: f.endCell, rows: k });
              // The path continues past this row only if the row held nothing
              // else AND was itself cut at the width.
              if (!f.whole || !cut(strict.bottom + k)) break;
            }
          }
          if (e.start) {
            let acc = '';
            for (let k = 1; k <= MAX_JOINS; k++) {
              // The row being consumed continues INTO the line below it, so it
              // must itself be cut — a short row above ended its own thought.
              if (!cut(strict.top - k)) break;
              const f = upFrag(strict.top - k); if (!f) break;
              acc = f.text + acc; ups.push({ text: acc, startCell: f.startCell, rows: k });
              if (!f.whole) break;
            }
          }
          const cands = [];
          for (const d of downs) cands.push({ text: r.link.text + d.text, start: tokenStart, end: d.endCell, rows: d.rows });
          for (const u of ups) cands.push({ text: u.text + r.link.text, start: u.startCell, end: tokenEnd, rows: u.rows });
          for (const u of ups) for (const d of downs) {
            if (u.rows + d.rows > MAX_JOINS) continue;
            cands.push({ text: u.text + r.link.text + d.text, start: u.startCell, end: d.endCell, rows: u.rows + d.rows });
          }
          cands.sort((a, b) => a.rows - b.rows);
          // Shortest first, stop at the first hit — the sort exists so the
          // common one-row severance costs one stat, not a volley.
          for (const c of cands) {
            const st = await statLink(c.text, p.cwd, p.id);
            if (!(st && st.exists)) continue;
            const at = new Array(c.text.length);
            at[0] = c.start; at[c.text.length - 1] = c.end;
            extras.push(...build([{ link: { kind: 'path', text: c.text, start: 0, end: c.text.length }, st }], at));
            break;
          }
        }
        if (extras.length) {
          links = extras.concat(links.filter((l) => !extras.some((w) => rangesTouch(w.range, l.range))));
        }
      }
      return links;
    };

    term.registerLinkProvider({
      provideLinks(y, callback) {
        resolveLinks(y)
          .then((links) => callback(links.length ? links : undefined))
          .catch(() => callback(undefined));
      },
    });
  }

  // Right-click a link in a session. Away from one this does nothing and the
  // terminal keeps whatever behaviour it had — this is a link menu, not a
  // terminal menu, and copying arbitrary text is what selection is for.
  function wireTerminalMenu(p, rec) {
    rec.body.addEventListener('contextmenu', (e) => {
      const picked = rec.term?.getSelection();
      if (picked?.trim()) { e.preventDefault(); showMenu(e.clientX, e.clientY, [{ label: 'Add selection to session…', run: () => openSelectionDraft({ owner: p.id }, { reference: p.title + ' (terminal excerpt)', text: picked }) }, { label: 'Copy selection', run: () => copyLinkText(picked) }]); return; }
      const hit = hoveredLink.get(p.id);
      if (!hit) return;
      e.preventDefault();
      const items = termMenuItems({ kind: hit.link.kind, text: hit.link.text, st: hit.st }).map((it) => {
        if (it === '-' || it.off) return it;
        if (it.copy != null) return { ...it, run: () => copyLinkText(it.copy) };
        // Reveal is the alt route openTermLink already understands; naming it
        // here keeps the menu and the modifier on one implementation.
        return { ...it, run: () => openTermLink(hit.link, hit.st, { altKey: it.label === REVEAL_LABEL }) };
      });
      if (hit.link.kind === 'url') items.unshift({ label: 'Open in KingAgent browser', run: () => { browsers.open(urlTarget(hit.link.text), null, p.id); setView('split'); } });
      showMenu(e.clientX, e.clientY, items);
    });
  }

  async function copyLinkText(text) {
    try { await api.copyText(text); toast('Copied ' + shorten(text, 44) + '.'); }
    catch (_) { toast('Could not copy that.'); }
  }

  // OSC 8 hyperlinks (a CLI marking its own text as a link) come through xterm's
  // own provider. Claiming the handler matters: xterm's default pops a blocking
  // confirm() and a bare window.open, which in Electron is a dead-end window.
  function oscLinkHandler(p) {
    let hover = null;
    return {
      hover: async (ev, uri) => {
        terminalHint.hide(p);
        const revision = terminalHint.revision;
        const marker = {};
        hover = marker;
        let hit;
        if (/^https?:\/\//i.test(uri)) {
          hit = { link: { kind: 'url', text: uri }, st: null, live: true };
        } else if (/^file:\/\//i.test(uri)) {
          let path = uri.replace(/^file:\/\/(localhost)?/i, '');
          try { path = decodeURIComponent(path); } catch (_) {}
          let st;
          try { st = await api.statPath({ token: path, cwd: p.cwd, id: p.id }); } catch (_) { return; }
          hit = { link: { kind: 'path', text: path }, st, live: !!st && st.exists };
        }
        if (!hit || hover !== marker || terminalHint.revision !== revision || !tiles.has(p.id) || state.overlay || q('#ctx-menu')) return;
        marker.hit = hit;
        hoveredLink.set(p.id, hit);
        terminalHint.show({ kind: hit.link.kind, st: hit.st }, ev, p);
      },
      leave: () => {
        if (hover && hoveredLink.get(p.id) === hover.hit) { hoveredLink.delete(p.id); terminalHint.hide(p); }
        hover = null;
      },
      activate: async (ev, uri) => {
        if (!(ev.metaKey || ev.ctrlKey)) return;
        if (/^https?:\/\//i.test(uri)) { api.openUrl(uri); return; }
        if (!/^file:\/\//i.test(uri)) return;
        let abs = uri.replace(/^file:\/\/(localhost)?/i, '');
        try { abs = decodeURIComponent(abs); } catch (_) {}
        const st = await api.statPath({ token: abs, cwd: p.cwd, id: p.id });
        if (!st.exists) { toast('Not found: ' + abs); return; }
        openTermLink({ kind: 'path', text: abs }, st, ev);
      },
    };
  }

  return { registerTerminalLinks, wireTerminalMenu, oscLinkHandler, hoveredLink, panelBases };
}
