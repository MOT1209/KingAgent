// What a task did to the filesystem, and which files it is currently thinking
// about.
//
// Two jobs that look like one:
//
//   * **Change tracking** — reads, creations, modifications, deletions and
//     renames, so a finished task can answer "what changed?" without diffing a
//     whole tree, and so the trace has something concrete to show a user.
//   * **Attention** — active / related / generated files, so the ContextManager
//     can select *targeted* files instead of loading a repository.
//
// Content is captured with a ceiling. A diff that keeps `before` and `after` in
// full for a 4 MB file duplicates 8 MB into a trace that then gets persisted,
// per attempt. Past `maxContentBytes` the record keeps a reference — size, a
// content hash and the first lines — which is enough to show the change
// happened and to detect that it happened twice, and not enough to blow up the
// store.

const crypto = require('node:crypto');

const OPERATIONS = Object.freeze({
  READ: 'read',
  CREATE: 'create',
  MODIFY: 'modify',
  DELETE: 'delete',
  RENAME: 'rename',
});

const DEFAULTS = Object.freeze({
  maxContentBytes: 64 * 1024, // per side of a diff
  maxChanges: 2000,
  maxTracked: 2000,
  previewLines: 12,
});

function hash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

// Either the content itself, or a reference that stands in for it.
function captureContent(text, limit, previewLines) {
  if (text === null || text === undefined) return null;
  const str = String(text);
  const bytes = Buffer.byteLength(str, 'utf8');
  if (bytes <= limit) return { inline: true, bytes, text: str, digest: hash(str) };
  return {
    inline: false,
    bytes,
    digest: hash(str),
    preview: str.split('\n').slice(0, previewLines).join('\n'),
    truncated: true,
  };
}

function createFileContext(options = {}) {
  const limits = { ...DEFAULTS, ...options };
  const changes = []; // chronological
  const tracked = new Map(); // path -> { path, operations:Set, reads, writes, lastAt, role }
  const active = new Set();
  const related = new Map(); // path -> reason

  function touch(path, operation) {
    if (!tracked.has(path)) {
      tracked.set(path, { path, operations: [], reads: 0, writes: 0, firstAt: Date.now(), lastAt: Date.now() });
    }
    const rec = tracked.get(path);
    if (!rec.operations.includes(operation)) rec.operations.push(operation);
    if (operation === OPERATIONS.READ) rec.reads += 1;
    else rec.writes += 1;
    rec.lastAt = Date.now();
    if (tracked.size > limits.maxTracked) {
      // Drop the least recently touched entry rather than growing without bound.
      let oldest = null;
      for (const [k, v] of tracked) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [k, v];
      if (oldest && oldest[0] !== path) tracked.delete(oldest[0]);
    }
    return rec;
  }

  function record(entry) {
    changes.push(entry);
    if (changes.length > limits.maxChanges) changes.splice(0, changes.length - limits.maxChanges);
    return entry;
  }

  const api = {
    OPERATIONS,

    recordRead(path, { bytes = null, summary = '' } = {}) {
      touch(path, OPERATIONS.READ);
      return record({ path, operation: OPERATIONS.READ, at: Date.now(), bytes, summary, before: null, after: null });
    },

    recordCreate(path, { after = null, summary = '' } = {}) {
      touch(path, OPERATIONS.CREATE);
      return record({
        path,
        operation: OPERATIONS.CREATE,
        at: Date.now(),
        before: null,
        after: captureContent(after, limits.maxContentBytes, limits.previewLines),
        summary: summary || `created ${path}`,
      });
    },

    recordModify(path, { before = null, after = null, summary = '' } = {}) {
      touch(path, OPERATIONS.MODIFY);
      return record({
        path,
        operation: OPERATIONS.MODIFY,
        at: Date.now(),
        before: captureContent(before, limits.maxContentBytes, limits.previewLines),
        after: captureContent(after, limits.maxContentBytes, limits.previewLines),
        summary: summary || `modified ${path}`,
      });
    },

    recordDelete(path, { before = null, summary = '' } = {}) {
      touch(path, OPERATIONS.DELETE);
      return record({
        path,
        operation: OPERATIONS.DELETE,
        at: Date.now(),
        before: captureContent(before, limits.maxContentBytes, limits.previewLines),
        after: null,
        summary: summary || `deleted ${path}`,
      });
    },

    recordRename(fromPath, toPath, { summary = '' } = {}) {
      touch(fromPath, OPERATIONS.RENAME);
      touch(toPath, OPERATIONS.RENAME);
      return record({
        path: toPath,
        from: fromPath,
        operation: OPERATIONS.RENAME,
        at: Date.now(),
        before: null,
        after: null,
        summary: summary || `renamed ${fromPath} → ${toPath}`,
      });
    },

    // --- attention ---------------------------------------------------------
    markActive(path) { active.add(path); touch(path, OPERATIONS.READ); return path; },
    unmarkActive(path) { return active.delete(path); },
    addRelated(path, reason = 'related') { related.set(path, reason); return path; },

    activeFiles() { return [...active]; },
    relatedFiles() { return [...related.entries()].map(([path, reason]) => ({ path, reason })); },

    generatedFiles() {
      return [...tracked.values()]
        .filter((r) => r.operations.includes(OPERATIONS.CREATE))
        .map((r) => r.path);
    },

    modifiedFiles() {
      return [...tracked.values()]
        .filter((r) => r.operations.some((o) => o !== OPERATIONS.READ))
        .sort((a, b) => b.lastAt - a.lastAt)
        .map((r) => r.path);
    },

    readFiles() {
      return [...tracked.values()].filter((r) => r.reads > 0).map((r) => r.path);
    },

    recentlyModified(limit = 10) {
      return this.modifiedFiles().slice(0, limit);
    },

    changes() { return changes.slice(); },

    // The TaskDiff view: one row per changed path, latest state wins, with the
    // first `before` and the last `after` so a path touched repeatedly reads as
    // one change rather than a replay.
    diff() {
      const byPath = new Map();
      for (const c of changes) {
        if (c.operation === OPERATIONS.READ) continue;
        const existing = byPath.get(c.path);
        if (!existing) {
          byPath.set(c.path, {
            path: c.path,
            operation: c.operation,
            before: c.before,
            after: c.after,
            summary: c.summary,
            ...(c.from ? { from: c.from } : {}),
          });
          continue;
        }
        // create → modify stays a create; anything → delete becomes a delete.
        existing.after = c.after;
        existing.summary = c.summary;
        if (c.operation === OPERATIONS.DELETE) existing.operation = OPERATIONS.DELETE;
        else if (existing.operation !== OPERATIONS.CREATE) existing.operation = c.operation;
      }
      return [...byPath.values()];
    },

    counts() {
      const out = { read: 0, create: 0, modify: 0, delete: 0, rename: 0 };
      for (const row of this.diff()) out[row.operation] = (out[row.operation] || 0) + 1;
      out.read = this.readFiles().length;
      return out;
    },

    summary() {
      const counts = this.counts();
      return {
        filesRead: counts.read,
        filesCreated: counts.create,
        filesModified: counts.modify,
        filesDeleted: counts.delete,
        filesRenamed: counts.rename,
        changed: this.diff().length,
        active: active.size,
      };
    },

    toJSON() {
      return {
        summary: this.summary(),
        active: [...active],
        related: this.relatedFiles(),
        changes: this.diff(),
      };
    },
  };
  return api;
}

module.exports = { createFileContext, OPERATIONS, captureContent, DEFAULTS };
