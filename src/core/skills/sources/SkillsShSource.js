// SkillsShSource: the adapter for the skills.sh ecosystem.
//
// READ THIS BEFORE CHANGING THE ENDPOINTS
//
// skills.sh is an external service whose HTTP contract is not defined by this
// repository, and this adapter was written without being able to call it (the
// build environment has no route to that host). Two consequences, both
// deliberate and both visible in the code:
//
//   1. **Every endpoint and every field name is configuration**, not a constant
//      compiled into the platform. `endpoints` and `map` below are the whole
//      contract; a host that knows the real API supplies them, and nothing else
//      in the skill system needs to change.
//   2. **An unrecognized response is an error, not an empty list.** A source
//      that silently returns `[]` when its API changed is how a platform starts
//      quietly shipping "no skills found" as if it were an answer. The errors
//      here say what was expected and what arrived.
//
// Everything a skills.sh skill brings is untrusted until it has been fetched,
// scanned and validated locally (security/SkillValidator.js) — the listing's
// own claims about permissions or risk are advertising copy, useful for display
// and never for a decision. Install pins the content digest so a later change
// is detected (loader/SkillLoader.js).

const { digestOfSkill } = require('../cache/SkillCache');
const { SkillSourceNotWiredError } = require('./GitHubSkillSource');

const DEFAULT_BASE_URL = 'https://skills.sh';

// The shape this adapter assumes when the host does not say otherwise. Treat
// these as a starting point to be corrected, not as documentation of the
// service.
const DEFAULT_ENDPOINTS = Object.freeze({
  search: '/api/skills?q={query}&limit={limit}',
  detail: '/api/skills/{id}',
  content: '/api/skills/{id}/content',
});

// Where the fields live in a response. Every one of these is overridable so a
// host can adapt to the real API without patching the platform.
const DEFAULT_MAP = Object.freeze({
  results: ['skills', 'results', 'items', 'data'],
  id: ['id', 'slug', 'name'],
  name: ['name', 'title', 'displayName'],
  version: ['version', 'latestVersion', 'latest'],
  description: ['description', 'summary'],
  categories: ['categories', 'tags'],
  tags: ['tags', 'keywords'],
  permissions: ['permissions'],
  riskLevel: ['riskLevel', 'risk'],
  author: ['author', 'owner', 'publisher'],
  installs: ['installs', 'downloads', 'installCount'],
  updatedAt: ['updatedAt', 'updated_at', 'modifiedAt'],
  manifest: ['manifest', 'skill'],
  content: ['content', 'instructions', 'body', 'markdown'],
});

class SkillsShSource {
  constructor({
    http = null,
    baseUrl = DEFAULT_BASE_URL,
    endpoints = {},
    map = {},
    authorize = null,
    logger = null,
    timeoutMs = 8000,
  } = {}) {
    this.id = 'skills.sh';
    this.type = 'skills.sh';
    this.trusted = false;
    this._http = http;
    this._baseUrl = String(baseUrl).replace(/\/+$/, '');
    if (!this._baseUrl.startsWith('https://')) throw new Error('skills.sh base URL must be https');
    this._endpoints = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this._map = { ...DEFAULT_MAP, ...map };
    this._authorize = authorize;
    this._logger = logger;
    this._timeoutMs = timeoutMs;
  }

  get wired() { return Boolean(this._http); }

  // What this adapter will call, so a host can verify the contract without
  // reading the source — and so the UI can show which registry it is talking to.
  contract() {
    return {
      baseUrl: this._baseUrl,
      endpoints: { ...this._endpoints },
      fields: Object.fromEntries(Object.entries(this._map).map(([k, v]) => [k, [...v]])),
      wired: this.wired,
      verified: false, // no request has confirmed this contract in this build
    };
  }

  _client() {
    if (!this._http) throw new SkillSourceNotWiredError(this.id);
    return this._http;
  }

  async _headers() {
    const base = { Accept: 'application/json', 'User-Agent': 'KingAgent' };
    if (!this._authorize) return base;
    return { ...base, ...((await this._authorize()) || {}) };
  }

  _url(endpoint, params = {}) {
    const template = this._endpoints[endpoint];
    if (!template) throw new Error(`skills.sh adapter has no "${endpoint}" endpoint configured`);
    const path = template.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(String(params[key] === undefined ? '' : params[key])));
    const url = `${this._baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    // Defence against a template or a parameter that tries to leave the host.
    if (!url.startsWith(`${this._baseUrl}/`)) throw new Error(`skills.sh request would leave ${this._baseUrl}`);
    return url;
  }

  async search({ query = '', limit = 25 } = {}) {
    const client = this._client();
    const url = this._url('search', { query, limit });
    const body = await client.getJson(url, { headers: await this._headers(), timeoutMs: this._timeoutMs });
    const rows = pickArray(body, this._map.results);
    if (rows === null) {
      throw new Error(
        `skills.sh search response was not recognized (expected an array, or an object with one of: ${this._map.results.join(', ')}). ` +
        'Configure `endpoints`/`map` on the skills.sh source for the real API shape.',
      );
    }
    return rows.map((row) => this._listing(row)).filter((r) => r.id);
  }

  async find({ id } = {}) {
    const client = this._client();
    const body = await client.getJson(this._url('detail', { id }), { headers: await this._headers(), timeoutMs: this._timeoutMs });
    if (!body || typeof body !== 'object') return null;
    const row = this._listing(body);
    return row.id ? row : null;
  }

  // Fetch a skill for installation. Returns the manifest exactly as published
  // plus the content bytes and their digest; the digest is what pins this
  // version, since a registry entry can be republished under the same version.
  async fetch({ id } = {}) {
    const client = this._client();
    const headers = await this._headers();
    const detail = await client.getJson(this._url('detail', { id }), { headers, timeoutMs: this._timeoutMs });
    if (!detail || typeof detail !== 'object') throw new Error(`skills.sh returned no detail for "${id}"`);

    const published = pick(detail, this._map.manifest);
    const manifest = published && typeof published === 'object' ? { ...published } : this._manifestFromListing(detail, id);

    let content = pick(detail, this._map.content);
    if (typeof content !== 'string') {
      content = await client.getText(this._url('content', { id }), { headers, timeoutMs: this._timeoutMs });
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`skills.sh returned no instructions for "${id}"; expected a string under one of: ${this._map.content.join(', ')}`);
    }

    const digest = digestOfSkill({ content });
    return {
      manifest: {
        ...manifest,
        id: manifest.id || id,
        // Provenance from the fetch, never from the payload. `digest` is what
        // lifts this skill from `untrusted` to `community` once a person
        // accepts it (registry/SkillSource.js).
        source: { type: 'skills.sh', slug: manifest.id || id, digest },
      },
      content,
      resources: {},
      digest,
    };
  }

  async read(manifest) {
    const client = this._client();
    const id = (manifest.source && manifest.source.slug) || manifest.id;
    const content = await client.getText(this._url('content', { id }), { headers: await this._headers(), timeoutMs: this._timeoutMs });
    if (typeof content !== 'string') throw new Error(`skills.sh returned no content for "${id}"`);
    return { content, resources: {} };
  }

  _listing(row) {
    return {
      id: str(pick(row, this._map.id)),
      name: str(pick(row, this._map.name)) || str(pick(row, this._map.id)),
      version: str(pick(row, this._map.version)) || null,
      description: str(pick(row, this._map.description)) || '',
      categories: arr(pick(row, this._map.categories)),
      tags: arr(pick(row, this._map.tags)),
      permissions: arr(pick(row, this._map.permissions)),
      riskLevel: str(pick(row, this._map.riskLevel)) || null,
      author: str(pick(row, this._map.author)) || '',
      installs: num(pick(row, this._map.installs)),
      updatedAt: pick(row, this._map.updatedAt) || null,
      source: 'skills.sh',
    };
  }

  // When a registry returns a listing but no manifest document, build the
  // minimum manifest from the listing. It will still go through full local
  // validation — which is where an incomplete one is rejected with a message
  // naming what the registry did not provide.
  _manifestFromListing(row, id) {
    const listing = this._listing(row);
    return {
      id: listing.id || id,
      name: listing.name || id,
      version: listing.version || '0.0.0',
      description: listing.description,
      author: listing.author,
      categories: listing.categories,
      tags: listing.tags,
      permissions: listing.permissions,
      riskLevel: listing.riskLevel || undefined,
    };
  }
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function pickArray(body, keys) {
  if (Array.isArray(body)) return body;
  const found = pick(body, keys);
  return Array.isArray(found) ? found : null;
}

function str(v) { return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v); }
function arr(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }

module.exports = { SkillsShSource, DEFAULT_BASE_URL, DEFAULT_ENDPOINTS, DEFAULT_MAP };
