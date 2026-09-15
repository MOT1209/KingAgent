// LocalSkillSource: skills from a directory on this machine.
//
// This is the source developers and enterprises actually use — a private skill
// repository checked out on disk, or a skill being written right now — and it
// is the one where a path bug turns into "the agent read /etc/shadow". Three
// containment checks, none of which is redundant:
//
//   1. the manifest's `path`/`entry` values are validated as relative and
//      traversal-free before they are joined (schemas/SkillManifest.js);
//   2. the joined path is resolved and must still start with the skill's own
//      directory, which catches the cases string checks miss;
//   3. the *real* path (symlinks followed) is checked the same way, because a
//      symlink inside a skill folder is the standard way around check 2.
//
// Reads are also size-capped: a skill is a document, and a source that hands
// back a gigabyte is a denial of service, not a skill.

const nodePath = require('node:path');
const { digestOf } = require('../cache/SkillCache');
const { isSafeRelativePath } = require('../registry/SkillSource');
const { satisfies } = require('../registry/SkillVersion');

const MANIFEST_NAMES = Object.freeze(['skill.json', 'kingagent.skill.json']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SKILLS = 500;

class LocalSkillSource {
  constructor({ fs, directory, path = nodePath, logger = null, maxFileBytes = MAX_FILE_BYTES } = {}) {
    if (!fs) throw new Error('LocalSkillSource requires an fs implementation');
    if (!directory) throw new Error('LocalSkillSource requires a directory');
    this.id = 'local';
    this.type = 'local';
    this.trusted = false;
    this._fs = fs;
    this._path = path;
    this._root = path.resolve(directory);
    this._logger = logger;
    this._maxFileBytes = maxFileBytes;
  }

  get directory() { return this._root; }

  async list() {
    let entries;
    try {
      entries = await this._fs.readdir(this._root, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const entry of entries.slice(0, MAX_SKILLS)) {
      if (!isDirectoryEntry(entry)) continue;
      const name = entryName(entry);
      const manifest = await this._readManifest(name).catch((err) => {
        if (this._logger) this._logger.debug(`skipping ${name}: ${err.message}`);
        return null;
      });
      if (manifest) out.push(listing(manifest, name));
    }
    return out;
  }

  async search({ query = '', limit = 25 } = {}) {
    const q = String(query).toLowerCase().trim();
    const all = await this.list();
    if (!q) return all.slice(0, limit);
    return all.filter((r) => r.id.includes(q) || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)).slice(0, limit);
  }

  async find({ id, range = '*' } = {}) {
    const all = await this.list();
    const hit = all.find((r) => r.id === id && (range === '*' || satisfies(r.version, range)));
    return hit || null;
  }

  async fetch({ id, dir = null } = {}) {
    const folder = dir || id;
    const manifest = await this._readManifest(folder);
    const entry = (manifest.entry && manifest.entry.instructions) || (typeof manifest.entry === 'string' ? manifest.entry : 'SKILL.md');
    const content = await this._readFile(folder, entry);
    const resources = {};
    const declared = (manifest.entry && Array.isArray(manifest.entry.resources)) ? manifest.entry.resources : [];
    for (const rel of declared) {
      resources[rel] = await this._readFile(folder, rel);
    }
    return {
      manifest: { ...manifest, source: { type: 'local', directory: this._root, path: folder } },
      content,
      resources,
      digest: digestOf(content),
    };
  }

  async read(manifest) {
    const folder = (manifest.source && manifest.source.path) || manifest.id;
    const entry = (manifest.entry && manifest.entry.instructions) || 'SKILL.md';
    const content = await this._readFile(folder, entry);
    const resources = {};
    for (const rel of (manifest.entry && manifest.entry.resources) || []) {
      resources[rel] = await this._readFile(folder, rel);
    }
    return { content, resources };
  }

  async _readManifest(folder) {
    for (const name of MANIFEST_NAMES) {
      try {
        const text = await this._readFile(folder, name);
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') throw new Error('manifest is not an object');
        return parsed;
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
        throw new Error(`${folder}/${name}: ${err.message}`, { cause: err });
      }
    }
    throw new Error(`no ${MANIFEST_NAMES.join(' or ')} in ${folder}`);
  }

  // The containment check. Every read in this class goes through it.
  async _readFile(folder, relative) {
    if (!isSafeRelativePath(folder) || !isSafeRelativePath(relative)) {
      throw new Error(`unsafe skill path: ${folder}/${relative}`);
    }
    const target = this._path.resolve(this._root, folder, relative);
    const base = this._path.resolve(this._root, folder);
    if (!isInside(this._path, base, target) || !isInside(this._path, this._root, target)) {
      throw new Error(`skill path escapes its directory: ${relative}`);
    }
    // Symlinks: resolve and check again. A symlink pointing outside the skill
    // folder passes every string-level check above.
    if (typeof this._fs.realpath === 'function') {
      try {
        const real = await this._fs.realpath(target);
        if (!isInside(this._path, this._root, this._path.resolve(real))) {
          throw new Error(`skill path is a symlink out of the skills directory: ${relative}`);
        }
      } catch (err) {
        if (!err || err.code !== 'ENOENT') {
          if (/symlink out of/.test(err.message)) throw err;
        }
      }
    }
    if (typeof this._fs.stat === 'function') {
      const stat = await this._fs.stat(target).catch(() => null);
      if (stat && typeof stat.size === 'number' && stat.size > this._maxFileBytes) {
        throw new Error(`${relative} is larger than ${this._maxFileBytes} bytes`);
      }
    }
    return this._fs.readFile(target, 'utf8');
  }
}

function isInside(path, base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isDirectoryEntry(entry) {
  return typeof entry === 'string' || (entry && typeof entry.isDirectory === 'function' && entry.isDirectory());
}

function entryName(entry) {
  return typeof entry === 'string' ? entry : entry.name;
}

function listing(manifest, folder) {
  return {
    id: manifest.id,
    name: manifest.name || manifest.id,
    version: manifest.version || '0.0.0',
    description: manifest.description || '',
    categories: [...(manifest.categories || [])],
    tags: [...(manifest.tags || [])],
    permissions: [...(manifest.permissions || [])],
    riskLevel: manifest.riskLevel || null,
    author: manifest.author || '',
    source: 'local',
    dir: folder,
  };
}

module.exports = { LocalSkillSource, MANIFEST_NAMES, MAX_FILE_BYTES };
