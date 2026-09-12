// Parse every first-party module we ship.
//
// The suite is 100+ files and a parse error anywhere in it fails that one
// file's tests opaquely; a renderer module with a typo is worse, because the
// renderer has no test runner to fail at all. This walks the same trees the
// packager ships (src/main, src/renderer, minus the vendored bundles) and
// asks node to parse each file, failing loudly on the first that cannot.
//
// Excluded: src/renderer/vendor/** — third-party bundles that already parse.
// Everything else that ends in .js, .mjs or .cjs must.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['src/main', 'src/renderer'];
const EXTS = new Set(['.js', '.mjs', '.cjs']);
const SKIP = /(^|[\\/])vendor[\\/]/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (SKIP.test(p)) continue;   // vendor/ prunes at every level, files included
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(path.extname(entry))) yield p;
  }
}

let files = 0;
const bad = [];
for (const tree of TREES) {
  try {
    for (const file of walk(path.join(ROOT, tree))) {
      files += 1;
      const src = readFileSync(file, 'utf8');
      if (/^\s*(import|export)\b/m.test(src)) {
        // ESM: import it. A module that parses but cannot execute in plain
        // node (electron, DOM globals) is still fine — only a SyntaxError is
        // a parse failure. Everything else is not our business here.
        await import(pathToFileURL(file).href).catch((e) => {
          if (e instanceof SyntaxError) bad.push(`${file}: ${e.message}`);
        });
      } else {
        // CJS-style: compile without running. new vm.Script catches syntax
        // errors and nothing else.
        const vm = await import('node:vm');
        try { new vm.Script(src, { filename: file }); } catch (e) { bad.push(`${file}: ${e.message}`); }
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

if (bad.length) {
  console.error(`\n${bad.length} file(s) do not parse:\n\n${bad.join('\n')}\n`);
  process.exit(1);
}
console.log(`syntax ok: ${files} files parse`);
