// Path containment guard.
//
// Every filesystem tool resolves its target against a workspace root (when the
// platform provides one) so a tool call can never wander outside the folder a
// task is allowed to touch. Uses node:path so it is correct on every OS; the
// guard itself does not hardcode any separator.

const path = require('node:path');

// Returns the absolute resolved path if `rel` stays inside `root`, else null.
// `rel` may itself be absolute — it is still checked for containment.
function resolveWithin(root, rel) {
  if (!root) return path.resolve(rel); // no root: caller grants full access
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel || '.');
  const relFromRoot = path.relative(rootAbs, target);
  if (relFromRoot === '') return rootAbs;
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
  return target;
}

function assertWithin(root, rel) {
  const target = resolveWithin(root, rel);
  if (target === null) {
    throw new Error(`path "${rel}" escapes the workspace root "${root}"`);
  }
  return target;
}

module.exports = { resolveWithin, assertWithin };