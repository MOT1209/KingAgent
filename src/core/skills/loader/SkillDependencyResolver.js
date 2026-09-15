// SkillDependencyResolver: the graph, its cycles, and the order things happen in.
//
// A dependency graph over capabilities that can request filesystem and process
// permissions is a supply-chain surface, so this resolver is written to fail
// rather than to cope:
//
//   * a cycle is an error naming the exact loop, never a "visited" set that
//     silently breaks it — a broken cycle means one of the two skills runs
//     without the other, which is precisely the state its author said was invalid;
//   * a version conflict (two skills needing incompatible ranges of a third) is
//     an error, not a "newest wins" — picking one quietly is how a caller ends
//     up with a skill that satisfies nobody;
//   * depth and breadth are bounded, because a hostile manifest graph is cheap
//     to author and expensive to walk.
//
// The output is a topological order: dependencies before dependents, which is
// the order to install in and the order to load in.

const { satisfies, maxSatisfying, compareVersions } = require('../registry/SkillVersion');

const MAX_DEPTH = 8;
const MAX_NODES = 200;

class SkillDependencyError extends Error {
  constructor(message, { code = 'SKILL_DEPENDENCY_ERROR', cycle = null, skillId = null } = {}) {
    super(message);
    this.name = 'SkillDependencyError';
    this.code = code;
    this.cycle = cycle;
    this.skillId = skillId;
  }
}

// Resolve the full closure of `roots` (skill ids, or `{ id, range }` pairs).
//
// `lookup(id, range)` returns a record or null; by default it reads the
// registry, but the installer passes one that can also consult a not-yet-
// installed candidate set, which is how a skill and its dependencies are
// validated together before either is installed.
function resolve({
  roots = [],
  registry = null,
  lookup = null,
  platform = null,
  maxDepth = MAX_DEPTH,
  maxNodes = MAX_NODES,
} = {}) {
  const find = lookup || ((id, range) => (registry ? registry.get(id, range === '*' ? null : range) : null));
  const resolved = new Map();  // id -> { record, requiredBy[], ranges[] }
  const missing = [];
  const conflicts = [];
  const incompatible = [];
  const order = [];
  const visiting = new Set();  // ids on the current DFS path -> cycle detection
  const done = new Set();

  const normalizedRoots = roots.map((r) => (typeof r === 'string' ? { id: r, range: '*' } : { id: r.id, range: r.range || '*' }));

  function walk(node, depth, path, requiredBy) {
    if (depth > maxDepth) {
      throw new SkillDependencyError(`dependency graph deeper than ${maxDepth} levels at ${node.id}`, { code: 'SKILL_DEPENDENCY_TOO_DEEP', skillId: node.id });
    }
    if (resolved.size > maxNodes) {
      throw new SkillDependencyError(`dependency graph larger than ${maxNodes} skills`, { code: 'SKILL_DEPENDENCY_TOO_LARGE' });
    }
    if (visiting.has(node.id)) {
      const cycle = [...path.slice(path.indexOf(node.id)), node.id];
      throw new SkillDependencyError(`circular skill dependency: ${cycle.join(' -> ')}`, { code: 'SKILL_DEPENDENCY_CYCLE', cycle, skillId: node.id });
    }

    const existing = resolved.get(node.id);
    if (existing) {
      // Already chosen — check the new range against the chosen version rather
      // than re-walking, and record a conflict if it does not fit.
      existing.ranges.push(node.range);
      if (requiredBy) existing.requiredBy.push(requiredBy);
      if (!satisfies(existing.record.version, node.range)) {
        conflicts.push({
          id: node.id,
          chosen: existing.record.version,
          range: node.range,
          requiredBy: requiredBy || 'root',
          otherRanges: existing.ranges.filter((r) => r !== node.range),
        });
      }
      return;
    }

    const record = find(node.id, node.range);
    if (!record) {
      missing.push({ id: node.id, range: node.range, requiredBy: requiredBy || 'root' });
      return;
    }
    if (platform && !record.manifest.supportedPlatforms.includes(platform)) {
      incompatible.push({ id: node.id, version: record.version, platform, supports: [...record.manifest.supportedPlatforms], requiredBy: requiredBy || 'root' });
      return;
    }
    if (!satisfies(record.version, node.range)) {
      conflicts.push({ id: node.id, chosen: record.version, range: node.range, requiredBy: requiredBy || 'root', otherRanges: [] });
      return;
    }

    resolved.set(node.id, { record, requiredBy: requiredBy ? [requiredBy] : [], ranges: [node.range] });
    visiting.add(node.id);
    path.push(node.id);
    for (const dep of record.manifest.dependencies) {
      walk({ id: dep.id, range: dep.range }, depth + 1, path, node.id);
    }
    path.pop();
    visiting.delete(node.id);
    if (!done.has(node.id)) {
      done.add(node.id);
      order.push(node.id); // post-order: dependencies land before dependents
    }
  }

  let cycle = null;
  try {
    for (const root of normalizedRoots) walk(root, 0, [], null);
  } catch (err) {
    if (err instanceof SkillDependencyError && err.code === 'SKILL_DEPENDENCY_CYCLE') {
      cycle = err.cycle;
    } else {
      throw err;
    }
  }

  const ok = !cycle && missing.length === 0 && conflicts.length === 0 && incompatible.length === 0;
  return {
    ok,
    // Dependencies first. This is the install order and the load order; a
    // caller that ignores it will load a skill whose prerequisites are absent.
    order: order.map((id) => resolved.get(id).record),
    resolved: [...resolved.entries()].map(([id, v]) => ({
      id,
      version: v.record.version,
      requiredBy: [...new Set(v.requiredBy)],
      ranges: [...new Set(v.ranges)],
    })),
    missing,
    conflicts,
    incompatible,
    cycle,
    reason: ok ? 'every dependency resolves' : describe({ cycle, missing, conflicts, incompatible }),
  };
}

function describe({ cycle, missing, conflicts, incompatible }) {
  const parts = [];
  if (cycle) parts.push(`circular dependency: ${cycle.join(' -> ')}`);
  if (missing.length) parts.push(`missing: ${missing.map((m) => `${m.id}@${m.range} (needed by ${m.requiredBy})`).join(', ')}`);
  if (conflicts.length) parts.push(`version conflicts: ${conflicts.map((c) => `${c.id} is ${c.chosen} but ${c.requiredBy} needs ${c.range}`).join(', ')}`);
  if (incompatible.length) parts.push(`unsupported platform: ${incompatible.map((i) => `${i.id} supports ${i.supports.join('/')}, not ${i.platform}`).join(', ')}`);
  return parts.join('; ');
}

// Which installed skills depend on this one — what "remove" has to warn about.
function dependents(registry, id) {
  return registry.list()
    .filter((r) => r.manifest.dependencies.some((d) => d.id === id))
    .map((r) => ({ id: r.id, version: r.version, range: r.manifest.dependencies.find((d) => d.id === id).range }));
}

// Would removing `id` break anything still installed?
function canRemove(registry, id, { version = null } = {}) {
  const blockers = dependents(registry, id).filter((d) => {
    if (!version) return true;
    const remaining = registry.all(id).filter((r) => r.version !== version);
    return !remaining.some((r) => satisfies(r.version, d.range));
  });
  return { ok: blockers.length === 0, blockers };
}

// Highest installed version satisfying a range, for callers that only need the
// version number (the CLI's `skills info`, the update check).
function bestInstalled(registry, id, range = '*') {
  const versions = registry.all(id).map((r) => r.version).sort(compareVersions);
  return maxSatisfying(versions, range);
}

module.exports = { SkillDependencyError, MAX_DEPTH, MAX_NODES, resolve, dependents, canRemove, bestInstalled };
