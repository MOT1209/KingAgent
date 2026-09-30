/* KingAgent audit report — shared behaviour.
 *
 * Charts are hand-built SVG. No chart library: the repo has no bundler and no
 * runtime dependency for its UI, and a report that has to be opened from the
 * filesystem should not need a CDN either. Each renderer below is ~15 lines
 * and produces the exact mark it describes.
 *
 * RTL note: every chart lays out from the right edge, because these are
 * Arabic pages. Bar lengths are proportional, not positional, so nothing
 * depends on the reading direction — but the category labels sit to the right
 * of their bars, which is where an Arabic reader starts looking.
 */
(function () {
  'use strict';

  const A = window.AUDIT;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const SEV_COLORS = {
    critical: '#a4161a',
    high: '#b4530a',
    medium: '#8a6100',
    low: '#4a6b52',
  };
  const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
  const SEV_AR = { critical: 'حرج', high: 'عالٍ', medium: 'متوسط', low: 'منخفض' };

  /* ------------------------------------------------------------ numbers */

  /* Arabic reports count in Latin digits — that is the convention in every
   * technical Arabic publication, and it keeps the tabular figures legible
   * against the file names the report is quoting. */
  const num = (n) => Number(n).toLocaleString('en-US');
  const pct = (n) => num(Math.round(n * 10) / 10) + '%';

  /* ------------------------------------------------------------- charts */

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(w, h, label) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', `0 0 ${w} ${h}`);
    s.setAttribute('class', 'chart');
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label || '');
    return s;
  }
  const el = (tag, attrs, text) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  };

  /* A category label: Arabic, right-aligned, sitting inside the right edge of
   * the plot.
   *
   * The trap this avoids: in an RTL document `text-anchor` resolves against the
   * inherited direction, so "end" means the *left* and the label walks off the
   * right edge of the viewBox. Forcing direction:ltr fixes the anchor but then
   * breaks ordering *inside* the string — "تصريحات CSS فيزيائية" renders with
   * its two Arabic words swapped, because the base direction decides which run
   * comes first.
   *
   * So: direction rtl for correct word order, and text-anchor "start" because in
   * RTL that is the right-hand edge. Geometry stays LTR throughout.
   */
  function arLabel(x, y, str, opts) {
    const o = opts || {};
    return el('text', {
      x, y,
      'text-anchor': 'start',
      direction: 'rtl',
      'font-size': o.size || 12.5,
      fill: o.fill || '#2f2b26',
      'font-weight': o.weight || null,
      class: o.cls || null,
    }, str);
  }

  /* A value label: Latin digits, tabular, LTR — sits to the left of the plot. */
  function numLabel(x, y, str, opts) {
    const o = opts || {};
    return el('text', {
      x, y, 'text-anchor': 'end',
      direction: 'ltr',
      class: o.cls || 'val',
      'font-size': o.size || 13,
      fill: o.fill || null,
    }, str);
  }

  /* Donut: severity split. */
  function donut(rows, opts) {
    const o = Object.assign({ size: 260, thickness: 44, hole: 0.6 }, opts || {});
    const total = rows.reduce((a, r) => a + r.value, 0) || 1;
    const s = svg(o.size, o.size, o.label || 'توزيع النتائج حسب الخطورة');
    const cx = o.size / 2, cy = o.size / 2;
    const r = (o.size - o.thickness) / 2 - 6;
    const cir = 2 * Math.PI * r;
    let off = 0;

    rows.forEach((row) => {
      if (!row.value) return;
      const frac = row.value / total;
      const arc = el('circle', {
        cx, cy, r, fill: 'none',
        stroke: row.color,
        'stroke-width': o.thickness,
        'stroke-dasharray': `${(cir * frac - 2).toFixed(2)} ${cir.toFixed(2)}`,
        'stroke-dashoffset': (-off * cir).toFixed(2),
        transform: `rotate(-90 ${cx} ${cy})`,
      });
      arc.appendChild(el('title', {}, `${row.label}: ${row.value} (${pct(frac * 100)})`));
      s.appendChild(arc);
      off += frac;
    });

    if (o.centerTop) {
      s.appendChild(numLabel(cx, cy + 6, num(total), { size: 34 }));
      s.appendChild(el('text', { x: cx, y: cy + 28, 'text-anchor': 'middle', direction: 'rtl', 'font-size': 12.5, fill: '#6d6350' }, o.centerTop));
    }
    return s;
  }

  /* Horizontal bars, right-anchored for RTL. */
  function bars(rows, opts) {
    const o = Object.assign({ w: 620, rowH: 34, padTop: 8, labelW: 190, valueW: 56, max: null }, opts || {});
    const max = o.max || Math.max.apply(null, rows.map((r) => r.value).concat([1]));
    const h = o.padTop + rows.length * o.rowH + 8;
    const s = svg(o.w, h, o.label || 'أعمدة');
    const trackX = o.w - o.labelW;
    const trackW = trackX - o.valueW - 10;

    rows.forEach((r, i) => {
      const y = o.padTop + i * o.rowH;
      const bh = Math.min(20, o.rowH - 12);
      const by = y + (o.rowH - bh) / 2;

      s.appendChild(arLabel(o.w, y + o.rowH / 2 + 4, r.label));

      s.appendChild(el('rect', {
        x: trackX - trackW, y: by, width: trackW, height: bh, rx: 4,
        fill: '#f1e7d1', stroke: '#d4c7ab',
      }));

      const w = Math.max(2, (r.value / max) * trackW);
      const bar = el('rect', {
        x: trackX - w, y: by, width: w, height: bh, rx: 4,
        fill: r.color || '#ef6461',
      });
      bar.appendChild(el('title', {}, r.sub ? `${r.label}: ${r.value} — ${r.sub}` : `${r.label}: ${r.value}`));
      s.appendChild(bar);

      s.appendChild(numLabel(trackX - trackW - 8, y + o.rowH / 2 + 4, r.display != null ? r.display : num(r.value)));
    });
    return s;
  }

  /* Grouped/stacked columns — severity by domain. */
  function stackedCols(rows, series, opts) {
    const o = Object.assign({ w: 660, h: 300, padB: 74, padT: 16, padS: 14, label: 'الأعمدة المكدّسة' }, opts || {});
    const totals = rows.map((r) => series.reduce((a, s) => a + (r[s.key] || 0), 0));
    const max = Math.max.apply(null, totals.concat([1]));
    const plotH = o.h - o.padB - o.padT;
    const plotW = o.w - o.padS * 2;
    const slot = plotW / rows.length;
    const bw = Math.min(96, slot * 0.56);
    const s = svg(o.w, o.h, o.label);

    // y gridlines
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = (max / steps) * i;
      const y = o.padT + plotH - (v / max) * plotH;
      s.appendChild(el('line', { x1: o.padS, y1: y, x2: o.w - o.padS, y2: y, class: 'grid-line' }));
      s.appendChild(numLabel(o.w - o.padS - 4, y + 4, num(Math.round(v)), { size: 10.5, fill: '#7b7060' }));
    }

    rows.forEach((r, i) => {
      // RTL: first row on the right
      const cx = o.w - o.padS - slot * (i + 0.5);
      let acc = 0;
      series.forEach((ser) => {
        const v = r[ser.key] || 0;
        if (!v) return;
        const bh = (v / max) * plotH;
        const y = o.padT + plotH - (acc + v) / max * plotH;
        const seg = el('rect', {
          x: cx - bw / 2, y, width: bw, height: Math.max(1, bh), fill: ser.color,
        });
        seg.appendChild(el('title', {}, `${r.domain} — ${ser.label}: ${v}`));
        s.appendChild(seg);
        acc += v;
      });
      const total = totals[i];
      s.appendChild(numLabel(cx, o.padT + plotH - (total / max) * plotH - 7, num(total), { size: 14 }));
      s.appendChild(arLabel(cx, o.padT + plotH + 20, r.domain, { size: 12 }));
    });

    s.appendChild(el('line', { x1: o.padS, y1: o.padT + plotH, x2: o.w - o.padS, y2: o.padT + plotH, class: 'axis' }));
    return s;
  }

  /* Coverage: actual vs gate, as a bullet chart per metric. */
  function bullets(rows, opts) {
    const o = Object.assign({ w: 620, rowH: 56, labelW: 96, max: 100 }, opts || {});
    const h = rows.length * o.rowH + 10;
    const s = svg(o.w, h, 'التغطية مقابل بوابة الحد الأدنى');
    const trackX = o.w - o.labelW;
    const trackW = trackX - 8;

    rows.forEach((r, i) => {
      const y = i * o.rowH + 14;
      const bh = 22;
      s.appendChild(arLabel(o.w, y + 15, r.label, { size: 13 }));
      s.appendChild(el('rect', { x: trackX - trackW, y, width: trackW, height: bh, rx: 5, fill: '#f1e7d1', stroke: '#d4c7ab' }));

      const w = (r.actual / o.max) * trackW;
      const ok = r.actual >= r.gate;
      const bar = el('rect', { x: trackX - w, y, width: w, height: bh, rx: 5, fill: ok ? '#4a6b52' : '#b4530a' });
      bar.appendChild(el('title', {}, `${r.label}: ${pct(r.actual)} (الحد ${pct(r.gate)})`));
      s.appendChild(bar);

      // gate marker
      const gx = trackX - (r.gate / o.max) * trackW;
      s.appendChild(el('line', { x1: gx, y1: y - 4, x2: gx, y2: y + bh + 4, stroke: '#a4161a', 'stroke-width': 2, 'stroke-dasharray': '3 2' }));
      s.appendChild(numLabel(trackX - trackW - 6, y + 15, pct(r.actual), { size: 12.5 }));
    });
    return s;
  }

  /* Contrast heat table — measured ratios per theme, with the AA line marked. */
  function contrastTable(tokens, themes, threshold) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const head = themes.map((t) => `<th class="num">${esc(t)}</th>`).join('');
    wrap.innerHTML =
      `<table><caption>نسبة التباين لكل رمز نصّي في كل سمة. الخانة الحمراء تحت عتبة WCAG AA (${threshold}:1). </caption>` +
      `<thead><tr><th>الرمز</th>${head}</tr></thead><tbody>` +
      tokens.map((t) => {
        const cells = themes
          .map((th) => {
            const v = t[th];
            const fail = v < threshold;
            return `<td class="num" style="${fail ? 'background:var(--sev-critical-bg);color:var(--sev-critical);font-weight:700' : ''}">${v.toFixed(2)}</td>`;
          })
          .join('');
        return `<tr><td><code>${esc(t.name)}</code></td>${cells}</tr>`;
      }).join('') +
      `</tbody></table>`;
    return wrap;
  }

  /* Effort / impact scatter for the fix plan. */
  function scatter(items, opts) {
    const o = Object.assign({ w: 660, h: 380, pad: 46, label: 'مصفوفة الجهد والأثر' }, opts || {});
    const s = svg(o.w, o.h, o.label);
    const maxE = 5, maxI = 10;
    const plotW = o.w - o.pad * 2;
    const plotH = o.h - o.pad * 2;

    for (let i = 0; i <= maxI; i += 2) {
      const y = o.pad + plotH - (i / maxI) * plotH;
      s.appendChild(el('line', { x1: o.pad, y1: y, x2: o.pad + plotW, y2: y, class: 'grid-line' }));
      s.appendChild(numLabel(o.pad + plotW + 6, y + 4, String(i), { size: 10.5, fill: '#7b7060' }));
    }
    for (let e = 1; e <= maxE; e++) {
      const x = o.pad + ((e - 0.5) / maxE) * plotW;
      s.appendChild(el('line', { x1: x, y1: o.pad, x2: x, y2: o.pad + plotH, class: 'grid-line' }));
      s.appendChild(numLabel(x, o.pad + plotH + 18, String(e), { size: 10.5, fill: '#7b7060' }));
    }
    s.appendChild(el('text', { x: o.pad + plotW / 2, y: o.h - 6, 'text-anchor': 'middle', direction: 'rtl', 'font-size': 12, fill: '#6d6350' }, 'الجهد (عدد الملفات)'));
    s.appendChild(el('text', { x: 14, y: o.pad + plotH / 2, 'text-anchor': 'middle', direction: 'rtl', 'font-size': 12, fill: '#6d6350', transform: `rotate(-90 14 ${o.pad + plotH / 2})` }, 'الأثر (حجم ما يُغلق)'));

    items.forEach((it) => {
      const x = o.pad + ((it.effort - 0.5) / maxE) * plotW;
      const y = o.pad + plotH - (it.impact / maxI) * plotH;
      const color = SEV_COLORS[it.sev] || '#4a6b52';
      const c = el('circle', { cx: x, cy: y, r: 9, fill: color, 'fill-opacity': 0.9, stroke: '#fffdf6', 'stroke-width': 2 });
      c.appendChild(el('title', {}, `${it.id} — ${it.title}\nالجهد ${it.effort} · الأثر ${it.impact}\n${it.findings.length} نتيجة`));
      s.appendChild(c);
      s.appendChild(numLabel(x, y - 14, it.id, { size: 11.5 }));
    });
    return s;
  }

  /* ------------------------------------------------------------ findings */

  function findingCard(f) {
    const n = document.createElement('article');
    n.className = 'finding';
    n.dataset.sev = f.sev;
    n.dataset.id = f.id;
    n.dataset.domain = f.domain;
    n.dataset.text = (f.id + ' ' + f.title + ' ' + f.loc + ' ' + f.impact + ' ' + f.fix).toLowerCase();

    n.innerHTML =
      `<button class="finding-head" type="button" aria-expanded="false">` +
      `<span class="f-id">${esc(f.id)}</span>` +
      `<span class="f-title">${esc(f.title)}<span class="f-loc">${esc(f.loc)}</span></span>` +
      `<span class="badge badge--${esc(f.sev)}"><i class="dot"></i>${esc(SEV_AR[f.sev])}</span>` +
      `<span class="f-chev" aria-hidden="true">&#x25B8;</span>` +
      `</button>` +
      `<div class="f-body"><dl>` +
      `<dt>الأثر</dt><dd>${esc(f.impact)}</dd>` +
      `<dt>الإصلاح</dt>` +
      `</dl><div class="f-fix"><dl><dt>الإصلاح المقترح</dt><dd>${esc(f.fix)}</dd></dl></div></div>`;

    const head = $('.finding-head', n);
    head.addEventListener('click', () => {
      const open = n.dataset.open === 'true';
      n.dataset.open = open ? 'false' : 'true';
      head.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    return n;
  }

  function mountFindings(opts) {
    const o = Object.assign({ filterBar: null, count: null }, opts || {});
    const list = $('#finding-list');
    if (!list) return;
    // Idempotent: the DOMContentLoaded handler below mounts the full set, and a
    // domain page then mounts again to narrow it. Without the reset the second
    // call appends rather than replaces, and the page shows every finding twice
    // (measured: 90 + 51 = 141 on interface.html).
    list.innerHTML = '';
    const all = A.findings.slice().sort(
      (a, b) => A.SEV[a.sev].order - A.SEV[b.sev].order || a.id.localeCompare(b.id)
    );
    all.forEach((f) => list.appendChild(findingCard(f)));

    const bar = o.filterBar ? $(o.filterBar) : null;
    if (!bar) return;
    const search = $('input[type="search"]', bar);
    const btns = $$('.fbtn', bar);
    const out = o.count ? $(o.count) : null;
    let sev = 'all';
    let dom = 'all';
    let q = '';

    function apply() {
      let n = 0;
      $$('.finding', list).forEach((node) => {
        const ok =
          (sev === 'all' || node.dataset.sev === sev) &&
          (dom === 'all' || node.dataset.domain === dom) &&
          (!q || node.dataset.text.indexOf(q) !== -1);
        node.hidden = !ok;
        if (ok) n++;
      });
      if (out) {
        out.textContent = n === all.length
          ? `${num(n)} نتيجة`
          : `${num(n)} من ${num(all.length)}`;
      }
      const empty = $('#finding-empty');
      if (empty) empty.hidden = n !== 0;
    }

    btns.forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.filter;
        if (b.dataset.kind === 'sev') {
          sev = sev === v ? 'all' : v;
          $$('.fbtn[data-kind="sev"]', bar).forEach((x) =>
            x.setAttribute('aria-pressed', x.dataset.filter === sev ? 'true' : 'false'));
        } else {
          dom = dom === v ? 'all' : v;
          $$('.fbtn[data-kind="dom"]', bar).forEach((x) =>
            x.setAttribute('aria-pressed', x.dataset.filter === dom ? 'true' : 'false'));
        }
        apply();
      });
    });
    if (search) search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); apply(); });
    apply();
  }

  /* ------------------------------------------------------------- chrome */

  function openAll(on) {
    $$('.finding').forEach((n) => {
      n.dataset.open = on ? 'true' : 'false';
      const h = $('.finding-head', n);
      if (h) h.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
  }

  function mountLegend(node) {
    if (!node) return;
    node.innerHTML = SEV_ORDER.map(
      (k) => `<span><i style="background:${SEV_COLORS[k]}"></i>${esc(SEV_AR[k])}</span>`
    ).join('');
  }

  /* A domain page (interface / security / performance) shows only that layer.
   * The severity buttons on such a page filter within the narrowed set rather
   * than the full one, so the toggle reads as "show me this tier" and the count
   * the reader sees is the count in the layer they are actually reading. */
  function mountDomain(domain, opts) {
    const o = opts || {};
    const list = $('#finding-list');
    if (!list) return 0;
    list.innerHTML = '';
    const all = A.findings
      .filter((f) => f.domain === domain)
      .sort((a, b) => A.SEV[a.sev].order - A.SEV[b.sev].order || a.id.localeCompare(b.id));
    all.forEach((f) => list.appendChild(findingCard(f)));

    const bar = $('.filters');
    const btns = bar ? $$('.fbtn[data-kind="sev"]', bar) : [];
    btns.forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.filter;
        const nodes = $$('.finding', list);
        const tier = nodes.filter((n) => n.dataset.sev === v);
        // A tier that is already the only thing showing toggles back to all,
        // so the button is never a dead end.
        const showingTierOnly = tier.length > 0 && tier.every((n) => !n.hidden);
        btns.forEach((x) => x.setAttribute('aria-pressed', 'false'));
        nodes.forEach((n) => { n.hidden = !showingTierOnly && n.dataset.sev !== v; });
        b.setAttribute('aria-pressed', showingTierOnly ? 'false' : 'true');
      });
    });
    if (o.openAll) {
      const btn = $('#open-all');
      if (btn) btn.addEventListener('click', () => {
        const anyClosed = $$('.finding', list).some((n) => n.dataset.open !== 'true');
        $$('.finding', list).forEach((n) => {
          n.dataset.open = anyClosed ? 'true' : 'false';
          const h = $('.finding-head', n);
          if (h) h.setAttribute('aria-expanded', anyClosed ? 'true' : 'false');
        });
        btn.textContent = anyClosed ? 'طيّ الكل' : 'فتح الكل';
      });
    }
    return all.length;
  }

  /* A curated cross-domain subset (performance.html) rather than one whole
   * layer. Same wiring as mountDomain, so the toggle behaves identically
   * instead of each page growing its own copy. */
  function mountIds(ids, opts) {
    const list = $('#finding-list');
    if (!list) return 0;
    const wanted = new Set(ids);
    list.innerHTML = '';
    const all = A.findings
      .filter((f) => wanted.has(f.id))
      .sort((a, b) => A.SEV[a.sev].order - A.SEV[b.sev].order || a.id.localeCompare(b.id));
    all.forEach((f) => list.appendChild(findingCard(f)));
    const bar = $('.filters');
    const btns = bar ? $$('.fbtn[data-kind="sev"]', bar) : [];
    btns.forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.filter;
        const nodes = $$('.finding', list);
        const tier = nodes.filter((n) => n.dataset.sev === v);
        const showingTierOnly = tier.length > 0 && tier.every((n) => !n.hidden);
        btns.forEach((x) => x.setAttribute('aria-pressed', 'false'));
        nodes.forEach((n) => { n.hidden = !showingTierOnly && n.dataset.sev !== v; });
        b.setAttribute('aria-pressed', showingTierOnly ? 'false' : 'true');
      });
    });
    void opts;
    return all.length;
  }

  document.addEventListener('DOMContentLoaded', () => {
    mountLegend($('#sev-legend'));
    /* Only mount the full set when the page has not declared a narrower scope.
     * A domain page sets data-scope on the list and calls mountDomain /
     * mountIds from its own inline script; without this check the shared
     * handler would run afterwards and quietly put all 90 back. Order between
     * the two is a DOMContentLoaded registration race, which is exactly the
     * kind of thing a data attribute should settle instead. */
    const list = $('#finding-list');
    const scope = list && list.dataset.scope;
    if (!scope) {
      mountFindings({ filterBar: '#finding-filters', count: '#finding-count' });
    }
    const openAllBtn = $('#open-all');
    if (openAllBtn) {
      openAllBtn.addEventListener('click', () => {
        const anyClosed = $$('.finding').some((n) => n.dataset.open !== 'true');
        openAll(anyClosed);
        openAllBtn.textContent = anyClosed ? 'طيّ الكل' : 'فتح الكل';
      });
    }
    // keyboard: / focuses search, matching a codebase where ⌘K is the palette
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        const s = $('input[type="search"]');
        if (s) { e.preventDefault(); s.focus(); }
      }
    });
  });

  window.AUDIT_UI = { donut, bars, stackedCols, bullets, scatter, contrastTable, mountFindings, mountDomain, mountIds, openAll, esc, num, pct, SEV_COLORS, SEV_ORDER, SEV_AR };
})();
