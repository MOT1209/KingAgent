// Real-world context renderer:
//   node context.mjs <markSvgPath> <outPng> [brandName] [domain] [tagline] [ink] [accent]
// Puts a mark into the situations it will actually live in: browser tab, app icon, avatar,
// business card, size ladders, and a 1-bit fax test. Ink = the brand's dark ground colour;
// accent = the colour used for the forced-solid rows (usually the light/knockout colour).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [markPath, out, NAME = 'Brand', DOMAIN = 'example.com', TAGLINE = '',
  INK = '#060711', ACC = '#ECEEF5'] = process.argv.slice(2);
const CHROME = process.env.CHROME
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');
// Strip active content before inlining, and escape text dropped into the HTML.
const sanitize = s => s
  .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
  .replace(/\s(xlink:)?href\s*=\s*("(javascript:|https?:)[^"]*"|'(javascript:|https?:)[^']*')/gi, '');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mark = sanitize(fs.readFileSync(markPath, 'utf8'));

const M = (cls = '') => `<span class="m ${cls}">${mark}</span>`;
const foot = [TAGLINE, DOMAIN].filter(Boolean).map(esc).join('<br>');

const html = `<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;background:#14161d;font:13px/1.45 "Segoe UI",-apple-system,sans-serif;color:#ECEEF5;padding:26px}
h1{font:600 17px/1 "Segoe UI";margin:0 0 4px;letter-spacing:-.02em}
.sub{color:#8B90A6;font-size:11px;margin-bottom:22px;font-family:Consolas,monospace}
.row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;align-items:flex-start}
.panel{background:#1c1f28;border-radius:12px;padding:16px;position:relative}
.cap{position:absolute;bottom:7px;left:12px;font:500 9px Consolas,monospace;color:#6a7085;letter-spacing:.05em}
.m{display:inline-block}.m svg{width:100%;height:100%;display:block}

/* browser tab */
.browser{width:460px;background:#22252e;border-radius:10px 10px 0 0;padding:9px 9px 0;box-shadow:0 8px 30px #0007}
.tabs{display:flex;gap:4px}
.tab{display:flex;align-items:center;gap:8px;background:#31343e;border-radius:8px 8px 0 0;padding:8px 14px;font-size:11.5px;color:#d5d8e2}
.tab.off{background:transparent;color:#7f8496}
.tab .m{width:16px;height:16px;flex:none}
.urlbar{background:#191c24;margin-top:0;padding:9px 12px;display:flex;gap:9px;align-items:center;font:11px Consolas,monospace;color:#8B90A6}
.dot{width:9px;height:9px;border-radius:50%}

/* phone home screen */
.phone{width:214px;height:290px;border-radius:26px;padding:20px 18px;background:linear-gradient(160deg,#2b3040,#12141b);display:grid;grid-template-columns:repeat(4,1fr);gap:13px 12px;align-content:start}
.appicon{aspect-ratio:1;border-radius:12px;background:#3a3f4e;display:grid;place-items:center}
.appicon.brand{background:${INK};padding:20%}
.appicon.brand .m{width:100%;height:100%}

/* avatars */
.av{width:44px;height:44px;border-radius:50%;background:${INK};display:grid;place-items:center;padding:9px}
.av.sm{width:26px;height:26px;padding:5px}
.av.lg{width:72px;height:72px;padding:15px}
.av .m{width:100%;height:100%}

/* card */
.card{width:300px;height:172px;border-radius:8px;background:${INK};padding:20px;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 10px 34px #0008}
.card.light{background:#F4F4F0}
.card .m{width:34px;height:34px}
.cardfoot{font:400 8.5px Consolas,monospace;letter-spacing:.09em;color:#8B90A6;text-transform:uppercase}
.card.light .cardfoot{color:#5a5f6e}

/* sizes strip */
.strip{display:flex;align-items:flex-end;gap:20px;padding:10px 4px}
.strip .u{display:flex;flex-direction:column;align-items:center;gap:6px}
.strip b{font:500 9px Consolas,monospace;color:#6a7085}

/* one-bit fax */
.fax{background:#fff;padding:14px;border-radius:6px}
.fax .m{filter:grayscale(1) contrast(999) brightness(0.999)}
.fax .m svg *{fill:#000 !important;stroke:#000 !important}

.solid svg *{fill:${ACC} !important;stroke:${ACC} !important}
.solidink svg *{fill:${INK} !important;stroke:${INK} !important}
.photo{background:linear-gradient(115deg,#c9553f 0%,#7a3f8a 45%,#1f5f7a 100%);}
</style></head><body>
<h1>${esc(NAME)} — mark in situ</h1>
<div class="sub">${esc(path.basename(markPath))} — every context the mark actually has to survive</div>

<div class="row">
  <div class="panel" style="padding-bottom:26px">
    <div class="browser">
      <div class="tabs">
        <div class="tab">${M('solid')}<span>${esc(NAME)}</span></div>
        <div class="tab off">GitHub</div><div class="tab off">Linear</div>
      </div>
      <div class="urlbar"><span class="dot" style="background:#3a3f4e"></span>${DOMAIN}</div>
    </div>
    <span class="cap">16px favicon — the real test</span>
  </div>

  <div class="panel" style="padding-bottom:26px">
    <div class="phone">
      <div class="appicon"></div><div class="appicon brand">${M('solid')}</div>
      <div class="appicon"></div><div class="appicon"></div>
      <div class="appicon"></div><div class="appicon"></div>
      <div class="appicon"></div><div class="appicon"></div>
    </div>
    <span class="cap">app icon among neighbours</span>
  </div>

  <div class="panel" style="padding-bottom:26px">
    <div style="display:flex;gap:12px;align-items:center">
      <div class="av sm">${M('solid')}</div><div class="av">${M('solid')}</div><div class="av lg">${M('solid')}</div>
    </div>
    <span class="cap">avatar / circular crop</span>
  </div>
</div>

<div class="row">
  <div class="panel" style="padding-bottom:26px">
    <div class="card"><div class="m solid" style="width:34px;height:34px">${mark}</div>
      <div class="cardfoot">${foot}</div></div>
    <span class="cap">card — dark</span>
  </div>
  <div class="panel" style="padding-bottom:26px">
    <div class="card light"><div class="m solidink" style="width:34px;height:34px">${mark}</div>
      <div class="cardfoot">${foot}</div></div>
    <span class="cap">card — light</span>
  </div>
  <div class="panel photo" style="padding-bottom:26px">
    <div style="width:120px;height:120px;display:grid;place-items:center">${M('solid')}</div>
    <span class="cap" style="color:#fff9">on a photo field</span>
  </div>
  <div class="panel" style="padding-bottom:26px">
    <div class="fax"><div class="m" style="width:110px;height:110px">${mark}</div></div>
    <span class="cap">1-bit / fax / engraving</span>
  </div>
</div>

<div class="row">
  <div class="panel" style="background:${INK};padding-bottom:26px">
    <div class="strip">
      ${[128, 64, 48, 32, 24, 16, 12].map(s => `<div class="u"><div class="m solid" style="width:${s}px;height:${s}px">${mark}</div><b>${s}</b></div>`).join('')}
    </div>
    <span class="cap">size ladder on ink</span>
  </div>
  <div class="panel" style="background:#fff;padding-bottom:26px">
    <div class="strip">
      ${[128, 64, 48, 32, 24, 16, 12].map(s => `<div class="u"><div class="m solidink" style="width:${s}px;height:${s}px">${mark}</div><b style="color:#888">${s}</b></div>`).join('')}
    </div>
    <span class="cap" style="color:#888">size ladder on paper</span>
  </div>
</div>
</body></html>`;

const tmp = path.join(path.dirname(out), '_ctx.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(tmp, html);
execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  `--screenshot=${out}`, '--window-size=1020,880', 'file:///' + tmp.replace(/\\/g, '/')], { stdio: 'ignore' });
console.log('wrote ' + out);
