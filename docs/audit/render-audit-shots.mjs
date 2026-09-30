// Validates and previews every docs/audit/*.html page.
//
//   node docs/audit/render-audit-shots.mjs            # previews + assertions
//   node docs/audit/render-audit-shots.mjs --full     # also slice tall pages
//
// Electron rather than a headless-Chrome dependency, for the same reason
// docs/media/render-social-card.mjs uses it: the report leans on backdrop-filter
// and CSS grid, and several headless screenshot tools drop one or both without
// complaining — which takes the glass and the layout with it, so you end up
// reviewing a picture that is not what ships.
//
// The assertions matter more than the pictures. A page that throws inside its
// own script still screenshots; it screenshots as an empty sheet, which is
// indistinguishable from a deliberate minimal design. So every page is checked
// for its expected nodes and chart count *before* anything is written.
//
// On tall pages: Electron refuses to allocate a viewport past roughly 8000 CSS
// px at 2x — capturePage() answers UnknownVizError rather than clipping. Rather
// than chase that limit, --full walks the page in slices with a small overlap
// so no card hides in a seam. Off by default, because a report is read on
// screen, not printed, and the slice captures are slow.
import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'shots');
const FULL = process.argv.includes('--full');

const WIDTH = 1360;
const HEIGHT = 900;      // preview: one screenful, what a reader opens onto
const SLICE = 6000;      // --full only; see the UnknownVizError note above
const OVERLAP = 80;

const PAGES = [
  { file: 'index.html',       charts: 2, expect: ['#chart-severity svg', '#chart-donut svg', '#ghost-body tr', '.kpi'] },
  { file: 'findings.html',    findings: 90 },
  { file: 'interface.html',   charts: 1, findings: 51, expect: ['#chart-rtl svg', '#fonts-body tr', '#chart-contrast table', '#finding-list .finding'] },
  { file: 'security.html',    findings: 26, expect: ['#deps-body tr', '.table-wrap table tbody tr', '#finding-list .finding'] },
  { file: 'performance.html', charts: 1, findings: 45, expect: ['#chart-leaks svg', '#finding-list .finding'] },
  { file: 'quality.html',     charts: 2, expect: ['#zc-body tr', '#chart-cov svg', '#chart-dom svg', '.table-wrap table tbody tr'] },
  { file: 'fixplan.html',     charts: 1, expect: ['#phases .phase', '#roadmap .road', '#chart-matrix circle'] },
];

/* Two frames plus fonts.ready: the charts lay out on rAF, and one frame after
   the fonts land lets the webfont swap repaint at the new metrics. Skipping
   this is how a screenshot ends up with the fallback face and nobody notices,
   because it still looks like a page. */
const SETTLE = `(async () => {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }
  await new Promise(r => requestAnimationFrame(r));
  return true;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const meta = (r) =>
  `h:${r.height} charts:${r.charts}` +
  (r.circles ? ` marks:${r.circles}` : '') +
  (r.findings ? ` findings:${r.findings}` : '');

app.whenReady().then(async () => {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const failures = [];
  const warnings = [];
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    // The desk is cream, not white: a default white frame behind the report's
    // translucent cards shifts every blended colour in the capture.
    backgroundColor: '#cfc3ac',
    webPreferences: { zoomFactor: 1 },
  });

  for (const [i, page] of PAGES.entries()) {
    const src = join(here, page.file);
    if (!existsSync(src)) { failures.push(`${page.file}: file missing`); continue; }
    const name = `${String(i).padStart(2, '0')}-${basename(page.file, '.html')}`;

    try {
      win.setContentSize(WIDTH, HEIGHT);
      await win.loadFile(src);
      await win.webContents.executeJavaScript(SETTLE);

      const r = await win.webContents.executeJavaScript(`(() => {
        const miss = ${JSON.stringify(page.expect || [])}.filter(s => !document.querySelector(s));
        return {
          miss,
          charts: document.querySelectorAll('svg.chart').length,
          marks: document.querySelectorAll('svg.chart circle, svg.chart rect, svg.chart path').length,
          findings: document.querySelectorAll('#finding-list .finding').length,
          height: Math.ceil(document.documentElement.scrollHeight),
          width: document.documentElement.scrollWidth,
          dir: document.documentElement.dir,
          lang: document.documentElement.lang,
          // a page that threw in its own script lands here with a near-empty body
          text: (document.body.innerText || '').trim().length,
        };
      })()`);

      if (r.miss.length) failures.push(`${page.file}: missing ${r.miss.join(', ')}`);
      if (page.charts != null && r.charts < page.charts) {
        failures.push(`${page.file}: expected ${page.charts}+ charts, rendered ${r.charts}`);
      }
      if (page.findings != null && r.findings !== page.findings) {
        failures.push(`${page.file}: expected ${page.findings} findings, rendered ${r.findings}`);
      }
      if (r.text < 500) failures.push(`${page.file}: only ${r.text} chars of text — a script probably threw`);
      if (r.dir !== 'rtl') failures.push(`${page.file}: dir is "${r.dir}", expected "rtl"`);
      if (r.lang !== 'ar') failures.push(`${page.file}: lang is "${r.lang}", expected "ar"`);
      if (r.width > WIDTH + 2) {
        warnings.push(`${page.file}: scrollWidth ${r.width}px > viewport ${WIDTH}px — horizontal overflow`);
      }

      const shot = await win.webContents.capturePage();
      writeFileSync(join(outDir, `${name}.png`), shot.toPNG());
      const s = shot.getSize();
      console.log(`${name}.png  ${s.width}x${s.height}  ${meta(r)}`);
      await sleep(60);

      if (FULL && r.height > HEIGHT) {
        const stride = SLICE - OVERLAP;
        const passes = Math.ceil((r.height - HEIGHT) / stride) + 1;
        for (let p = 1; p < passes; p++) {
          const y = p * stride;
          if (y >= r.height) break;
          const h = Math.min(SLICE, r.height - y);
          try {
            win.setContentSize(WIDTH, Math.max(HEIGHT, h));
            await sleep(140);
            await win.webContents.executeJavaScript(SETTLE);
            await win.webContents.executeJavaScript(
              `window.scrollTo(0, ${y}); document.documentElement.scrollTop = ${y}; true`
            );
            await sleep(100);
            const part = await win.webContents.capturePage();
            const img = part.resize({ width: WIDTH, height: h, quality: 'best' });
            writeFileSync(join(outDir, `${name}-p${p + 1}.png`), img.toPNG());
            console.log(`  └ ${name}-p${p + 1}.png  ${img.getSize().width}x${img.getSize().height}  (slice ${p + 1}/${passes})`);
            await sleep(60);
          } catch (e) {
            warnings.push(`${page.file}: slice ${p + 1} skipped (${e.message})`);
            break;
          }
        }
        win.setContentSize(WIDTH, HEIGHT);
        await sleep(100);
      }
    } catch (err) {
      failures.push(`${page.file}: ${err.message}`);
    }
  }

  const shots = readdirSync(outDir).filter((f) => f.endsWith('.png'));
  console.log(`\n${PAGES.length} pages checked · ${shots.length} images → ${outDir}`);

  if (warnings.length) {
    console.log('\nwarnings:');
    for (const w of warnings) console.log('  ~ ' + w);
  }
  win.destroy();
  if (failures.length) {
    console.error('\nFAILED:');
    for (const f of failures) console.error('  ! ' + f);
    app.exit(1);
  }
  console.log('all assertions passed');
  app.exit(0);
});
