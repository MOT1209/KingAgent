// Designer's render-and-look harness.  node preview.mjs <file.svg> [outPng] [ink] [paper]
//
// Renders the mark big on both grounds IN ITS OWN TRUE COLOURS (this matters: a harness that
// force-overrides fills hides accent elements from every reviewer — that bug has survived
// multiple review rounds unnoticed before), plus forced-mono rows, silhouette,
// circular crop, a real raster ladder to 12px, and an ink-gain/embroidery simulation.
// Read the PNG afterwards and LOOK at it. That is the entire point.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const src = process.argv[2];
const out = process.argv[3] || src.replace(/\.svg$/, '.preview.png');
const INK = process.argv[4] || '#0B0C0E';
const PAPER = process.argv[5] || '#FFFFFF';
const CHROME = process.env.CHROME
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');
// Strip active content before inlining (defence-in-depth — concept SVGs are agent-written):
// scripts, foreignObject, on* handlers, and javascript:/external hrefs have no place in a logo.
const sanitize = s => s
  .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
  .replace(/\s(xlink:)?href\s*=\s*("(javascript:|https?:)[^"]*"|'(javascript:|https?:)[^']*')/gi, '');
const svg = sanitize(fs.readFileSync(src, 'utf8'));

const ladder = () => [64, 48, 32, 24, 16, 12].map(s =>
  `<div class="u"><div class="mk" style="width:${s}px;height:${s}px">${svg}</div><b>${s}</b></div>`).join('');

const html = `<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;background:#1a1c22;color:#eceef5;font:12px/1.4 sans-serif;padding:18px}
h3{font:600 10px ui-monospace,monospace;color:#7f8496;margin:0 0 8px;letter-spacing:.06em;text-transform:uppercase}
.row{display:flex;gap:14px;margin-bottom:14px;align-items:flex-start;flex-wrap:wrap}
.p{border-radius:10px;padding:16px}
.mk svg{width:100%!important;height:100%!important;display:block}
.big{width:240px;height:240px}
.mid{width:104px;height:104px}
.u{display:flex;flex-direction:column;align-items:center;gap:5px}
.u b{font:500 9px ui-monospace,monospace;color:#6a7085}
.lad{display:flex;gap:16px;align-items:flex-end}
.ink{background:${INK}} .paper{background:${PAPER}}
.paper h3{color:#999}.paper .u b{color:#999}
.monoW svg *{fill:#ECEEF5 !important;stroke:#ECEEF5 !important}
.monoK svg *{fill:${INK} !important;stroke:${INK} !important}
.gain .mk{filter:blur(0.6px) contrast(14)}
.circ{border-radius:50%;overflow:hidden}
.sil{filter:brightness(0) invert(1)}
</style></head><body>
<div class="row">
  <div class="p ink"><h3>true colour — dark</h3><div class="mk big">${svg}</div></div>
  <div class="p paper"><h3>true colour — light</h3><div class="mk big">${svg}</div></div>
  <div class="p ink"><h3>silhouette</h3><div class="mk mid sil">${svg}</div></div>
  <div class="p ink circ" style="width:150px;height:150px;display:grid;place-items:center;padding:0">
    <div class="mk" style="width:86px;height:86px">${svg}</div>
  </div>
</div>
<div class="row">
  <div class="p ink"><h3>ladder — true colour</h3><div class="lad">${ladder()}</div></div>
  <div class="p paper"><h3>ladder — true colour on light</h3><div class="lad">${ladder()}</div></div>
</div>
<div class="row">
  <div class="p ink monoW"><h3>one ink — knockout</h3><div class="lad">${ladder()}</div></div>
  <div class="p paper monoK"><h3>one ink — positive</h3><div class="lad">${ladder()}</div></div>
  <div class="p paper monoK gain"><h3>ink gain / embroidery</h3><div class="lad">${ladder()}</div></div>
</div>
</body></html>`;

const tmp = out.replace(/\.png$/, '.html');
fs.writeFileSync(tmp, html);
execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  `--screenshot=${out}`, '--window-size=1040,760', 'file:///' + path.resolve(tmp).replace(/\\/g, '/')], { stdio: 'ignore' });
console.log('rendered -> ' + out + '   (Read this PNG and LOOK at it — render-and-look)');
