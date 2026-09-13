// Bump the patch version for a rolling release, and print the new value.
//
// The ship workflow runs this once per push: it reads package.json, raises the
// patch digit, writes it back, and prints the new version for the workflow to
// tag. Committing that bump also means the *next* push starts one patch higher,
// so versions strictly increase, which is what the built-in updater (semver-gt
// on latest.yml) and the in-app bar (isNewer on parts) both require. A
// prerelease suffix like -build.<run> would skip past a fixed isNewer's idea of
// "newer" — parseVersion only orders one prerelease against one release, not
// one against another — so builds carry a plain dotted version and nothing else.
//
// Pure enough: only write what you were asked to write, and never when a
// --check intended it.
import fs from 'node:fs';

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

if (process.argv.includes('--check')) {
  console.log(pkg.version);
  process.exit(0);
}

const parts = String(pkg.version).split('.').map((n) => Number(n));
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
  throw new Error(`cannot bump unparseable version "${pkg.version}"`);
}
parts[2] += 1;
pkg.version = parts.join('.');

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(pkg.version);