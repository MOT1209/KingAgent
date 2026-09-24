// Contact-sheet renderer: node sheet.mjs <svgDir> <outPng> [title]
// Renders every .svg in svgDir on dark + light, at 512 / 96 / 48 / 32 / 16, plus a monochrome column.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [dir, out, title = 'contact sheet'] = process.argv.slice(2);
const CHROME = process.env.CHROME
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');

const files = fs.readdirSync(dir).filter(f => f.endsWith('.svg')).sort();
if (!files.length) { console.error('no svgs in ' + dir); process.exit(1); }

// Strip active content before inlining, and escape text dropped into the HTML.
const sanitize = s => s
  .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
  .replace(/\s(xlink:)?href\s*=\s*("(javascript:|https?:)[^"]*"|'(javascript:|https?:)[^']*')/gi, '');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const cards = files.map(f => {
  const svg = sanitize(fs.readFileSync(path.join(dir, f), 'utf8'));
  const sizes = [96, 48, 32, 16];
  const row = s => `<div class="sz"><div style="width:${s}px;height:${s}px">${svg}</div><b>${s}</b></div>`;
  return `
  <section>
    <h2>${esc(f)}</h2>
    <div class="grid">
      <div class="cell dark"><div class="big">${svg}</div><div class="sizes">${sizes.map(row).join('')}</div><span class="lbl">on #060711</span></div>
      <div class="cell light"><div class="big">${svg}</div><div class="sizes">${sizes.map(row).join('')}</div><span class="lbl">on #FFFFFF</span></div>
      <div class="cell dark mono"><div class="big">${svg}</div><div class="sizes">${sizes.map(row).join('')}</div><span class="lbl">1-colour knockout</span></div>
      <div class="cell light monod"><div class="big">${svg}</div><div class="sizes">${sizes.map(row).join('')}</div><span class="lbl">1-colour ink</span></div>
    </div>
  </section>`;
}).join('');

const html = `<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;background:#16181f;color:#ECEEF5;font:13px/1.4 -apple-system,Segoe UI,Inter,sans-serif;padding:24px}
h1{font:600 18px/1 Segoe UI;margin:0 0 20px;letter-spacing:-.02em}
h2{font:600 13px/1 ui-monospace,Consolas,monospace;margin:26px 0 8px;color:#8B90A6;letter-spacing:.04em}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.cell{border-radius:10px;padding:18px;display:flex;flex-direction:column;align-items:center;gap:14px;position:relative;min-height:230px;justify-content:center}
.dark{background:#060711}.light{background:#fff}
.big{width:150px;height:150px;display:grid;place-items:center}
.big svg{width:100%;height:100%}
.sizes{display:flex;align-items:flex-end;gap:14px}
.sz{display:flex;flex-direction:column;align-items:center;gap:5px}
.sz b{font:500 9px ui-monospace,monospace;opacity:.45}
.sz svg{width:100%;height:100%;display:block}
.lbl{position:absolute;top:7px;left:9px;font:500 9px ui-monospace,monospace;opacity:.4}
.light .lbl,.light .sz b{color:#060711}
.mono svg *{fill:#ECEEF5 !important;stroke:#ECEEF5 !important}
.mono svg [data-hole],.mono svg .hole{fill:#060711 !important;stroke:#060711 !important}
.monod svg *{fill:#060711 !important;stroke:#060711 !important}
.monod svg [data-hole],.monod svg .hole{fill:#fff !important;stroke:#fff !important}
</style></head><body><h1>${esc(title)}</h1>${cards}</body></html>`;

const tmp = path.join(path.dirname(out), '_sheet.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(tmp, html);
const h = 260 + files.length * 300;
execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--screenshot=${out}`, `--window-size=1500,${Math.min(h, 15000)}`, 'file:///' + tmp.replace(/\\/g, '/')],
  { stdio: 'ignore' });
console.log('wrote ' + out + ' (' + files.length + ' marks)');
