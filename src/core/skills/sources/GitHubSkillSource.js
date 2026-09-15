// GitHubSkillSource: skills published in a GitHub repository.
//
// Everything here is built around one fact: a branch is not a version. A skill
// fetched from `main` can be different tomorrow, which is why this adapter
// *resolves a ref to a commit sha* before fetching and records that sha in the
// manifest's provenance. That resolution is the difference between an
// `untrusted` and a `community` skill (registry/SkillSource.js), and it is why
// pinning is a behaviour of the source rather than advice in the docs.
//
// HTTP is injected. The core has no HTTP client of its own and should not grow
// one: the host owns the network stack, its proxy configuration and its
// certificate handling, and a core module that opened its own sockets would
// bypass all three. Without an injected client this source reports that it is
// not wired — it never silently degrades to "no results".
//
// Credentials are never stored on the adapter. A host that needs authenticated
// access supplies an `authorize()` callback returning headers per request, so
// a token lives in the host's secret handling and not in a skill source object
// that gets logged, serialized or handed to a renderer.

const { digestOf } = require('../cache/SkillCache');
const { isSafeRelativePath, isSafeRef, COMMIT_SHA } = require('../registry/SkillSource');

const API_HOST = 'api.github.com';
const RAW_HOST = 'raw.githubusercontent.com';
const MANIFEST_NAMES = Object.freeze(['skill.json', 'kingagent.skill.json']);
const MAX_BYTES = 512 * 1024;

class SkillSourceNotWiredError extends Error {
  constructor(sourceId) {
    super(`skill source "${sourceId}" needs an HTTP client; none is wired in this host`);
    this.name = 'SkillSourceNotWiredError';
    this.code = 'SKILL_SOURCE_NOT_WIRED';
    this.sourceId = sourceId;
  }
}

class GitHubSkillSource {
  constructor({
    http = null,           // { getJson(url, { headers }), getText(url, { headers }) }
    authorize = null,      // async () => ({ Authorization: '...' })
    apiHost = API_HOST,
    rawHost = RAW_HOST,
    repositories = [],     // optional: repositories this install browses by default
    logger = null,
  } = {}) {
    this.id = 'github';
    this.type = 'github';
    this.trusted = false;
    this._http = http;
    this._authorize = authorize;
    this._apiHost = apiHost;
    this._rawHost = rawHost;
    this._repositories = [...repositories];
    this._logger = logger;
  }

  get wired() { return Boolean(this._http); }

  _client() {
    if (!this._http) throw new SkillSourceNotWiredError(this.id);
    return this._http;
  }

  async _headers() {
    const base = { Accept: 'application/vnd.github+json', 'User-Agent': 'KingAgent' };
    if (!this._authorize) return base;
    const extra = await this._authorize();
    return { ...base, ...(extra || {}) };
  }

  // A repository search across the repositories this install was configured
  // with. There is no global "search GitHub for skills" here on purpose:
  // scraping the whole of GitHub for anything shaped like a skill manifest is
  // how you end up installing a typosquat.
  async search({ query = '', limit = 25 } = {}) {
    if (!this.wired || this._repositories.length === 0) return [];
    const q = String(query).toLowerCase().trim();
    const out = [];
    for (const repo of this._repositories) {
      const listings = await this.listRepository(repo).catch((err) => {
        if (this._logger) this._logger.debug(`github: ${repo.repository || repo}: ${err.message}`);
        return [];
      });
      for (const row of listings) {
        if (!q || row.id.includes(q) || row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q)) {
          out.push(row);
        }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async find({ id, range = '*' } = {}) {
    const rows = await this.search({ query: id, limit: 50 });
    return rows.find((r) => r.id === id) || null;
  }

  // List the skill folders of one repository. A repository is expected to keep
  // skills under a directory (default `skills/`), each in its own folder with a
  // manifest — the same layout LocalSkillSource reads.
  async listRepository({ repository, ref = 'HEAD', path = 'skills' } = {}) {
    const client = this._client();
    assertRepository(repository);
    const headers = await this._headers();
    const sha = await this.resolveRef({ repository, ref });
    const url = `https://${this._apiHost}/repos/${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(sha)}`;
    const entries = await client.getJson(url, { headers });
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const entry of entries) {
      if (!entry || entry.type !== 'dir') continue;
      const manifest = await this._readManifest({ repository, sha, dir: `${path}/${entry.name}` }).catch(() => null);
      if (manifest) out.push(listing(manifest, { repository, ref: sha, path: `${path}/${entry.name}` }));
    }
    return out;
  }

  // Turn a branch or tag into an immutable commit sha. A sha passes through
  // untouched; anything else is resolved, and the caller gets the sha back in
  // the manifest's source so the trust tier reflects what was actually fetched.
  async resolveRef({ repository, ref = 'HEAD' }) {
    assertRepository(repository);
    if (COMMIT_SHA.test(String(ref))) return String(ref);
    if (!isSafeRef(String(ref)) && ref !== 'HEAD') throw new Error(`unsafe git ref: ${JSON.stringify(ref)}`);
    const client = this._client();
    const headers = await this._headers();
    const url = `https://${this._apiHost}/repos/${repository}/commits/${encodeURIComponent(ref)}`;
    const commit = await client.getJson(url, { headers });
    const sha = commit && (commit.sha || (commit.commit && commit.commit.sha));
    if (!sha || !COMMIT_SHA.test(sha)) throw new Error(`could not resolve ${repository}@${ref} to a commit`);
    return sha;
  }

  async fetch({ repository, ref = 'HEAD', path = null, id = null } = {}) {
    assertRepository(repository);
    const dir = path || (id ? `skills/${id}` : null);
    if (!dir || !isSafeRelativePath(dir)) throw new Error(`a github skill fetch needs a safe path inside the repository (got ${JSON.stringify(dir)})`);
    const sha = await this.resolveRef({ repository, ref });
    const manifest = await this._readManifest({ repository, sha, dir });
    const entry = (manifest.entry && manifest.entry.instructions) || (typeof manifest.entry === 'string' ? manifest.entry : 'SKILL.md');
    const content = await this._readRaw({ repository, sha, filePath: `${dir}/${entry}` });
    const resources = {};
    for (const rel of (manifest.entry && manifest.entry.resources) || []) {
      resources[rel] = await this._readRaw({ repository, sha, filePath: `${dir}/${rel}` });
    }
    return {
      manifest: {
        ...manifest,
        // Provenance is set here, from what was fetched — never from the
        // manifest's own `source` block, which a publisher controls.
        source: { type: 'github', repository, ref: sha, path: dir },
      },
      content,
      resources,
      digest: digestOf(content),
      pinned: true,
      ref: sha,
    };
  }

  async read(manifest) {
    const source = manifest.source || {};
    const dir = source.path;
    const entry = (manifest.entry && manifest.entry.instructions) || 'SKILL.md';
    const content = await this._readRaw({ repository: source.repository, sha: source.ref, filePath: `${dir}/${entry}` });
    const resources = {};
    for (const rel of (manifest.entry && manifest.entry.resources) || []) {
      resources[rel] = await this._readRaw({ repository: source.repository, sha: source.ref, filePath: `${dir}/${rel}` });
    }
    return { content, resources };
  }

  async _readManifest({ repository, sha, dir }) {
    let lastError = null;
    for (const name of MANIFEST_NAMES) {
      try {
        const text = await this._readRaw({ repository, sha, filePath: `${dir}/${name}` });
        return JSON.parse(text);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`no readable manifest in ${repository}/${dir}: ${lastError ? lastError.message : 'not found'}`);
  }

  async _readRaw({ repository, sha, filePath }) {
    const client = this._client();
    assertRepository(repository);
    if (!COMMIT_SHA.test(String(sha))) throw new Error('github content is only read at a pinned commit sha');
    if (!isSafeRelativePath(filePath)) throw new Error(`unsafe repository path: ${filePath}`);
    const url = `https://${this._rawHost}/${repository}/${sha}/${encodePath(filePath)}`;
    const text = await client.getText(url, { headers: await this._headers(), maxBytes: MAX_BYTES });
    if (typeof text !== 'string') throw new Error(`no content at ${filePath}`);
    if (text.length > MAX_BYTES) throw new Error(`${filePath} exceeds ${MAX_BYTES} bytes`);
    return text;
  }
}

function assertRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(repository)) {
    throw new Error(`invalid GitHub repository: ${JSON.stringify(repository)}`);
  }
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function listing(manifest, { repository, ref, path }) {
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
    source: 'github',
    repository,
    ref,
    path,
  };
}

module.exports = { GitHubSkillSource, SkillSourceNotWiredError, API_HOST, RAW_HOST };
