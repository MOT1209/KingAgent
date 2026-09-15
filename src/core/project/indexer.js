// ProjectIndexer: a small, cached, incremental picture of a folder.
//
// The temptation is a semantic index of the whole repository. That is a Phase 4
// problem with a vector store attached to it, and it is the wrong tool for the
// question a task actually asks first — "what is this and where do I start?".
//
// So: marker detection (project/detector.js) plus a *bounded* listing of the
// top two levels, cached per root and refreshed only when asked. Nothing here
// reads file contents beyond package.json, and nothing walks node_modules.

const path = require('node:path');
const { detectProject, detectRoot } = require('./detector');
const { createProjectMetadata, mergeProjectMetadata, projectIdFor } = require('./metadata');
const { TYPES } = require('../events/event-bus');

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build',
  'out', '.next', '.cache', '.turbo', 'coverage', '.idea', '.vscode', 'vendor',
]);

const DEFAULTS = Object.freeze({
  maxDepth: 2,
  maxEntries: 400,
  ttlMs: 5 * 60 * 1000, // a cached index older than this is re-detected
});

class ProjectIndexer {
  constructor({ fs, bus = null, collection = null, logger = null, options = {} } = {}) {
    this._fs = fs || require('node:fs/promises');
    this._bus = bus;
    this._collection = collection;
    this._logger = logger;
    this._opts = { ...DEFAULTS, ...options };
    this._cache = new Map(); // root -> { metadata, at }
  }

  // Find the project boundary for an arbitrary path inside it.
  async findRoot(start) {
    return detectRoot(this._fs, start);
  }

  // Marker detection only — cheap enough to call per task.
  async detect(root, { force = false } = {}) {
    const dir = path.resolve(root);
    const cached = this._cache.get(dir);
    if (!force && cached && Date.now() - cached.at < this._opts.ttlMs) return cached.metadata;

    const detection = await detectProject(this._fs, dir);
    const previous = cached ? cached.metadata : await this._loadPersisted(projectIdFor(dir));
    const metadata = mergeProjectMetadata(previous, createProjectMetadata(detection));
    this._cache.set(dir, { metadata, at: Date.now() });
    this._persist(metadata);
    if (this._bus) {
      this._bus.emit(TYPES.PROJECT_DETECTED, { projectId: metadata.projectId }, {
        root: metadata.root, type: metadata.type, languages: metadata.languages, hasGit: metadata.hasGit,
      });
    }
    return metadata;
  }

  // Detection plus a bounded tree. `entries` is capped and depth-limited; this
  // is a map to navigate by, not a corpus to search.
  async index(root, { force = false, maxDepth = null, maxEntries = null } = {}) {
    const metadata = await this.detect(root, { force });
    if (!force && metadata.tree && Date.now() - (metadata.indexedAt || 0) < this._opts.ttlMs) return metadata;

    const limit = maxEntries || this._opts.maxEntries;
    const depth = maxDepth === null ? this._opts.maxDepth : maxDepth;
    const tree = await this._walk(metadata.root, { depth, limit });
    const indexed = {
      ...metadata,
      tree: tree.entries,
      truncated: tree.truncated,
      fileCount: tree.entries.filter((e) => e.type === 'file').length,
      dirCount: tree.entries.filter((e) => e.type === 'directory').length,
      indexedAt: Date.now(),
    };
    this._cache.set(metadata.root, { metadata: indexed, at: Date.now() });
    this._persist(indexed);
    if (this._bus) {
      this._bus.emit(TYPES.PROJECT_INDEXED, { projectId: indexed.projectId }, {
        entries: indexed.tree.length, truncated: indexed.truncated,
      });
    }
    return indexed;
  }

  // The handful of paths a first context packet should mention without being
  // asked. Ordered: markers, docs, then source directories.
  importantFiles(metadata, { limit = 12 } = {}) {
    if (!metadata) return [];
    const out = [...(metadata.markers || []), ...(metadata.importantFiles || [])];
    for (const dir of metadata.sourceDirs || []) out.push(`${dir}/`);
    return [...new Set(out)].slice(0, limit);
  }

  invalidate(root) {
    if (root) return this._cache.delete(path.resolve(root));
    this._cache.clear();
    return true;
  }

  async _walk(root, { depth, limit }) {
    const entries = [];
    let truncated = false;
    const queue = [{ dir: root, level: 0 }];
    while (queue.length) {
      const { dir, level } = queue.shift();
      let items;
      try { items = await this._fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const item of items) {
        if (SKIP_DIRS.has(item.name)) continue;
        if (entries.length >= limit) { truncated = true; return { entries, truncated }; }
        const full = path.join(dir, item.name);
        const rel = path.relative(root, full) || item.name;
        const isDir = item.isDirectory();
        entries.push({ path: rel.split(path.sep).join('/'), name: item.name, type: isDir ? 'directory' : 'file' });
        if (isDir && level < depth) queue.push({ dir: full, level: level + 1 });
      }
    }
    return { entries, truncated };
  }

  async _loadPersisted(projectId) {
    if (!this._collection) return null;
    try { return await this._collection.get(projectId); } catch { return null; }
  }

  _persist(metadata) {
    if (!this._collection) return;
    this._collection.put(metadata.projectId, metadata).catch((err) => {
      if (this._logger) this._logger.warn('project persist failed', { error: err.message });
    });
  }
}

module.exports = { ProjectIndexer, SKIP_DIRS, DEFAULTS };
