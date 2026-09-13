// Path containment guard.
//
// Every filesystem tool resolves its target against a workspace root (when the
// platform provides one) so a tool call can never wander outside the folder a
// task is allowed to touch. Uses node:path so it is correct on every OS; the
// guard itself does not hardcode any separator.
//
// Lexical containment (`path.resolve` + `path.relative`) is necessary but not
// sufficient: a symlink inside the workspace can point outside it, so
// `assertWithin` additionally resolves the *real* path of the deepest existing
// ancestor of the target and checks THAT against the real root. The target's
// final segments (which may not exist yet for a write) are appended to the real
// ancestor, so a not-yet-created file behind a symlinked directory is still
// checked.

const path = require('node:path');

// Returns the absolute resolved path if `rel` stays inside `root`, else null.
// `rel` may itself be absolute — it is still checked for containment. Lexical
// only; use assertWithin for the symlink-safe variant.
function resolveWithin(root, rel) {
  if (!root) return path.resolve(rel); // no root: caller grants full access
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel || '.');
  const relFromRoot = path.relative(rootAbs, target);
  if (relFromRoot === '') return rootAbs;
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
  return target;
}

// Throws if `rel` escapes `root`, lexically OR through a symlink. `realpathSync`
// is injectable for tests that do not want a real filesystem; it defaults to
// node:fs so callers (and the guard) stay on the real path by default.
function assertWithin(root, rel, { realpathSync = null } = {}) {
  const target = resolveWithin(root, rel);
  if (target === null) {
    throw new Error(`path "${rel}" escapes the workspace root "${root}"`);
  }
  if (root && realpathSync !== false) {
    const real = realContains(root, target, realpathSync || require('node:fs').realpathSync);
    if (!real) {
      throw new Error(`path "${rel}" escapes the workspace root "${root}" through a symlink`);
    }
    return real;
  }
  return target;
}

// null when the real target escapes the real root; otherwise the real target.
function realContains(root, target, realpathSync) {
  let rootReal;
  try {
    rootReal = realpathSync(path.resolve(root));
  } catch {
    // Root does not exist yet (fresh workspace): fall back to the lexical root.
    rootReal = path.resolve(root);
  }
  // Unwind to the deepest ancestor that exists so realpath can resolve it, and
  // re-append the not-yet-existing tail.
  const tail = [];
  let probe = target;
  while (true) {
    try {
      const realProbe = realpathSync(probe);
      const realTarget = tail.length === 0
        ? realProbe
        : path.resolve(realProbe, ...tail.slice().reverse());
      const relFromRoot = path.relative(rootReal, realTarget);
      if (relFromRoot === '') return rootReal;
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
      return realTarget;
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR' && err.code !== 'EINVAL')) return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

module.exports = { resolveWithin, assertWithin, realContains };