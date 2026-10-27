// Two helpers that were each written twice, byte for byte, in different files.
// The same hazard main.js names for its content hash: two copies of one small
// function drift the day either is touched.

const fs = require('node:fs');

// A string made safe to splice into a RegExp.
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A file's text, or '' when it cannot be read — for callers where "missing"
// and "unreadable" mean the same thing.
function safeRead(p) { try { return p ? fs.readFileSync(p, 'utf8') : ''; } catch (_) { return ''; } }

module.exports = { escapeRe, safeRead };
