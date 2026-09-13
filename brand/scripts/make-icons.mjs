// Turns the master mark into every raster the app ships.
//
//   node brand/scripts/make-icons.mjs
//
// Renders through headless Chrome — the same engine that draws the mark inside
// the app, so what Explorer shows and what the topbar shows cannot drift. The
// .ico is packed here rather than pulled from a dependency: the format is a
// 6-byte header plus one 16-byte directory entry per image, and Windows has
// read PNG-compressed entries since Vista, so a whole npm package to write 22
// bytes of struct would be the larger liability.
//
// --user-data-dir is not optional: with the user's own Chrome running, a
// headless launch against the default profile blocks on the profile lock and
// never returns.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FINAL = path.join(ROOT, 'brand/final');
const OUT = path.join(ROOT, 'build');
const TMP = path.join(os.tmpdir(), 'kingagent-icons');
// One profile per run, not one per machine: a previous render that died holding
// the lock otherwise blocks every later run, which is exactly how the first
// attempt at this script hung for minutes with nothing written.
const PROFILE = path.join(os.tmpdir(), `kingagent-icon-profile-${process.pid}`);

const CHROME = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome';

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

function renderPng(svgPath, size, outPng) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const html = `<html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>${svg}</body></html>`;
  const htmlPath = path.join(TMP, `r${size}.html`);
  fs.writeFileSync(htmlPath, html);
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--default-background-color=00000000',
    '--user-data-dir=' + PROFILE,
    `--screenshot=${outPng}`, `--window-size=${size},${size}`,
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ], { stdio: 'ignore' });
  return fs.readFileSync(outPng);
}

// ICO container: ICONDIR + n × ICONDIRENTRY + the PNG blobs, in that order.
function packIco(pngs) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);            // reserved
  dir.writeUInt16LE(1, 2);            // 1 = icon
  dir.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [], blobs = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);  // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);               // palette count
    e.writeUInt8(0, 3);               // reserved
    e.writeUInt16LE(1, 4);            // colour planes
    e.writeUInt16LE(32, 6);           // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e); blobs.push(data);
  }
  return Buffer.concat([dir, ...entries, ...blobs]);
}

const plate = path.join(FINAL, 'kingagent-icon.svg');

// electron-builder wants one large square; it derives the mac iconset from it.
console.log('icon.png  1024');
const master = path.join(OUT, 'icon.png');
renderPng(plate, 1024, master);

// The ico entries are downscaled from that one render rather than re-rendered.
// Chrome costs ~25s per launch here and occasionally wedges on its profile
// lock, so seven more launches was seven more chances to hang for a result
// that is a resize either way. sharp arrives with @huggingface/transformers;
// this is build-time tooling, not app code, so leaning on it is fine.
const { default: sharp } = await import('sharp');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const size of ICO_SIZES) {
  console.log('ico entry ', size);
  const data = await sharp(master).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
  fs.writeFileSync(path.join(TMP, `ico-${size}.png`), data);
  pngs.push({ size, data });
}
fs.writeFileSync(path.join(OUT, 'icon.ico'), packIco(pngs));
console.log('wrote build/icon.png and build/icon.ico (' + ICO_SIZES.join(', ') + ')');
