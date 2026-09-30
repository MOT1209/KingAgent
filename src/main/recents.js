// The Recents list — pure list logic, no fs and no electron, so it can be
// tested directly. main.js owns persistence and the missing-folder check.
//
// A row is { path, at, pinned }. Two rules shape the list:
//   · pinned rows sort first and are never evicted — one stray peek at
//     ~/Downloads must not be able to push a real project off the list;
//   · unpinned rows are a plain most-recent-first eight.

const RECENTS_CAP = 8;

// Normalize a folder path into a stable comparison key.
//
// Windows is case-insensitive and accepts both separators, so `C:\Proj`,
// `c:\proj`, `C:/Proj/` and `C:\Proj\` are one folder on disk but four
// different strings. Comparing raw strings splits one desk into duplicates
// (empty-looking desk on reopen) or misses a remove/pin. POSIX stays
// case-sensitive; only trailing separators are stripped there.
function normalizeFolderKey(p, platform = process.platform) {
  if (typeof p !== 'string' || !p) return '';
  let s = p;
  if (platform === 'win32') {
    s = s.replace(/\//g, '\\');
    // Preserve roots: `C:\`, `\\`, `\`. Strip trailing separators otherwise.
    if (!/^[A-Za-z]:\\$/.test(s) && s !== '\\' && s !== '\\\\') {
      s = s.replace(/[\\/]+$/, '');
    }
    return s.toLowerCase();
  }
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function sameFolder(a, b, platform = process.platform) {
  return normalizeFolderKey(a, platform) === normalizeFolderKey(b, platform);
}

// The list used to be a bare array of path strings. Anything that isn't a
// usable row is dropped rather than carried forward half-formed.
function migrateRecents(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((r) => (typeof r === 'string' ? { path: r, at: 0, pinned: false } : r))
    .filter((r) => r && typeof r.path === 'string' && r.path)
    .map((r) => ({ path: r.path, at: Number(r.at) || 0, pinned: !!r.pinned }));
}

function sortRecents(rows) {
  return rows.slice().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.at - a.at));
}

// The cap applies only to unpinned rows, so a pinned list longer than the cap
// is allowed — the user asked for every one of those.
function capRecents(rows, cap = RECENTS_CAP, platform = process.platform) {
  const seen = new Set();
  const unique = rows.filter((r) => {
    const k = normalizeFolderKey(r && r.path, platform);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const pinned = unique.filter((r) => r.pinned);
  const rest = sortRecents(unique.filter((r) => !r.pinned)).slice(0, cap);
  return sortRecents([...pinned, ...rest]);
}

// Opening a folder moves it to the front and stamps it, keeping whatever pin it
// already had — opening a pinned folder must not silently unpin it.
function rememberFolderIn(rows, folder, at, cap = RECENTS_CAP, platform = process.platform) {
  const prev = rows.find((r) => sameFolder(r.path, folder, platform));
  const rest = rows.filter((r) => !sameFolder(r.path, folder, platform));
  return capRecents([{ path: folder, at, pinned: !!(prev && prev.pinned) }, ...rest], cap, platform);
}

function setPinnedIn(rows, folder, pinned, cap = RECENTS_CAP, platform = process.platform) {
  const next = rows.map((r) => (sameFolder(r.path, folder, platform) ? { ...r, pinned: !!pinned } : r));
  return capRecents(next, cap, platform);
}

function removeFrom(rows, folder, platform = process.platform) {
  return rows.filter((r) => !sameFolder(r.path, folder, platform));
}

module.exports = { RECENTS_CAP, migrateRecents, sortRecents, capRecents, rememberFolderIn, setPinnedIn, removeFrom, normalizeFolderKey, sameFolder };
