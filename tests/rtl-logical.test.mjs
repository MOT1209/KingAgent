// The layout mirrors under <html dir="rtl"> only while every horizontal rule
// is written in logical properties. One `margin-left` brought back by a later
// change silently un-mirrors its row, and nothing else would notice: the
// default layout is left to right, so every screenshot still looks right. This
// is the check that notices.
//
// A line may stay physical when it is about physical geometry — a coordinate
// read off getBoundingClientRect, a terminal that is LTR in every layout, the
// Windows caption buttons. It says so with `physical:` and a reason on the
// same line, so the exception is a decision someone can read, not an accident.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isRtl, alignStart, alignEnd, inlineDelta, inlineOffset } from '../src/renderer/dir-axis.mjs';
const require = createRequire(import.meta.url);
const { normalizeDirection } = require('../src/main/settings.js');

const RENDERER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const files = (ext) => fs.readdirSync(RENDERER).filter((f) => ext.some((e) => f.endsWith(e))).sort();

const CSS_RULES = [
  [/\b(margin|padding|border)-(left|right)\b/, 'margin/padding/border-left|right → -inline-start|end'],
  [/(^|[;{\s"'`])(left|right)\s*:/, 'left/right → inset-inline-start|end'],
  [/text-align\s*:\s*(left|right)\b/, 'text-align: left|right → start|end'],
  [/float\s*:\s*(left|right)\b/, 'float: left|right → inline-start|end'],
  [/border-(top|bottom)-(left|right)-radius/, 'corner radius → border-start-*/end-*-radius'],
];
const JS_RULES = [
  ...CSS_RULES,
  [/\.style\.(left|right|marginLeft|marginRight|paddingLeft|paddingRight)\b/, 'style.left/paddingLeft → insetInlineStart/paddingInlineStart, or dir-axis.mjs for a rect'],
  [/\.(paddingLeft|paddingRight|marginLeft|marginRight|borderLeftWidth|borderRightWidth)\b/, 'computed paddingLeft → paddingInlineStart'],
];

function offenders(file, rules) {
  const out = [];
  fs.readFileSync(path.join(RENDERER, file), 'utf8').split('\n').forEach((line, i) => {
    if (line.includes('physical:')) return;
    // Comments say left and right in prose; only code counts.
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/\s.*$/, '');
    for (const [re, fix] of rules) if (re.test(code)) out.push(`${file}:${i + 1}  ${fix}\n    ${line.trim()}`);
  });
  return out;
}

test('renderer stylesheets use logical properties for every horizontal rule', () => {
  const bad = files(['.css']).flatMap((f) => offenders(f, CSS_RULES));
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('renderer scripts use logical properties, or say why a line is physical', () => {
  const bad = files(['.mjs', '.js']).flatMap((f) => offenders(f, JS_RULES));
  assert.deepEqual(bad, [], '\n' + bad.join('\n'));
});

test('the page declares its language and direction', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  assert.match(html, /^<html lang="en" dir="ltr">/, 'app.js and theme-boot.js change these; the default must be explicit');
});

test('every font stack can draw Arabic with the bundled face', () => {
  const missing = [];
  for (const f of files(['.css'])) {
    const css = fs.readFileSync(path.join(RENDERER, f), 'utf8');
    for (const m of css.matchAll(/(?:font-family|--[\w-]*(?:mono|sans|dot)|--crepe-font-code)\s*:\s*([^;{}]+)/g)) {
      const v = m[1].trim();
      if (!v.includes(',') || v.startsWith('var(') || v === 'inherit') continue; // @font-face names, references
      if (!v.includes("'KA Arabic'")) missing.push(`${f}: ${v}`);
    }
  }
  assert.deepEqual(missing, []);
  const paper = fs.readFileSync(path.join(RENDERER, 'paper.css'), 'utf8');
  for (const w of [400, 700]) {
    const file = `ibm-plex-sans-arabic-${w}-arabic.woff2`;
    assert.ok(paper.includes(file), `@font-face for ${w}`);
    assert.ok(fs.statSync(path.join(RENDERER, 'vendor', 'fonts', file)).size > 10000, `${file} is bundled`);
  }
  assert.match(fs.readFileSync(path.join(RENDERER, 'vendor', 'fonts', 'OFL.txt'), 'utf8'), /IBM Plex Sans Arabic/);
});

test('direction is ltr unless rtl was chosen', () => {
  assert.equal(normalizeDirection('rtl'), 'rtl');
  assert.equal(normalizeDirection('ltr'), 'ltr');
  for (const v of [undefined, null, '', 'RTL', 'auto', 1]) assert.equal(normalizeDirection(v), 'ltr');
});

test('a popup lines up with the start or end edge of its anchor on either layout', () => {
  const r = { left: 300, right: 340, width: 40 };
  assert.equal(alignStart(r, 100, 1000, false), 300);
  assert.equal(alignStart(r, 100, 1000, true), 240);
  assert.equal(alignEnd(r, 100, 1000, false), 240);
  assert.equal(alignEnd(r, 100, 1000, true), 300);
});

test('a popup is clamped inside the viewport', () => {
  assert.equal(alignStart({ left: 5, right: 25 }, 100, 1000, false), 8);
  assert.equal(alignStart({ left: 950, right: 990 }, 100, 1000, false), 892);
  assert.equal(alignEnd({ left: 2, right: 30 }, 100, 1000, false), 8);
  assert.equal(alignStart({ left: 10, right: 40 }, 100, 1000, true), 8);
});

test('a drag measures along the reading direction', () => {
  assert.equal(inlineDelta(30, false), 30);
  assert.equal(inlineDelta(30, true), -30);
  const rect = { left: 100, right: 900 };
  assert.equal(inlineOffset(300, rect, 20, false), 180);
  assert.equal(inlineOffset(700, rect, 20, true), 180);
});

test('isRtl reads the computed direction and survives having no DOM', () => {
  assert.equal(isRtl(), false);
  const saved = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ direction: 'rtl' });
  try { assert.equal(isRtl({}), true); } finally { globalThis.getComputedStyle = saved; }
});
