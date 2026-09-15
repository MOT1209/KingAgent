// BuiltinSkillSource: the skills that ship inside the app bundle.
//
// The simplest adapter, and the reference implementation of the interface every
// other source must satisfy:
//
//   id                     stable identifier used in provenance and logs
//   type                   the source type its manifests carry
//   list()                 everything this source offers
//   search({ query })      a filtered listing (optional)
//   find({ id, range })    one listing, or null (optional)
//   fetch(listing)         manifest + content, for installation
//   read(manifest)         content only, for loading an installed skill
//
// Built-in content is in-process: there is no IO, no network and nothing to
// time out, which is why this source is also what the tests use as a control.

const { BUILTIN_SKILLS } = require('../builtin/catalog');
const { satisfies } = require('../registry/SkillVersion');
const { digestOf } = require('../cache/SkillCache');

class BuiltinSkillSource {
  constructor({ skills = BUILTIN_SKILLS } = {}) {
    this.id = 'builtin';
    this.type = 'builtin';
    this.trusted = true;
    this._skills = new Map(skills.map((s) => [s.manifest.id, s]));
  }

  async list() {
    return [...this._skills.values()].map((s) => listing(s));
  }

  async search({ query = '', limit = 25 } = {}) {
    const q = String(query).toLowerCase().trim();
    const all = await this.list();
    if (!q) return all.slice(0, limit);
    return all
      .filter((row) => row.id.includes(q)
        || row.name.toLowerCase().includes(q)
        || row.description.toLowerCase().includes(q)
        || row.categories.some((c) => c.includes(q))
        || row.tags.some((t) => t.includes(q)))
      .slice(0, limit);
  }

  async find({ id, range = '*' } = {}) {
    const entry = this._skills.get(id);
    if (!entry) return null;
    if (range && range !== '*' && !satisfies(entry.manifest.version, range)) return null;
    return listing(entry);
  }

  // Everything an installer needs: the manifest with its provenance already
  // stamped, the content, and the digest of the bytes actually returned.
  async fetch({ id } = {}) {
    const entry = this._skills.get(id);
    if (!entry) throw new Error(`no built-in skill "${id}"`);
    const content = entry.content;
    return {
      manifest: { ...entry.manifest, source: { type: 'builtin' } },
      content,
      resources: {},
      digest: digestOf(content),
    };
  }

  async read(manifest) {
    const entry = this._skills.get(manifest.id);
    if (!entry) throw new Error(`built-in skill "${manifest.id}" is no longer in the bundle`);
    return { content: entry.content, resources: {} };
  }
}

function listing(entry) {
  const m = entry.manifest;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    categories: [...(m.categories || [])],
    tags: [...(m.tags || [])],
    permissions: [...(m.permissions || [])],
    riskLevel: m.riskLevel || null,
    author: m.author || 'KingAgent',
    source: 'builtin',
  };
}

module.exports = { BuiltinSkillSource };
