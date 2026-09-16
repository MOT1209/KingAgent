// Search providers: the seam between the research engine and whatever actually
// talks to the network (§36).
//
// This deliberately mirrors the shape of core/ai/provider.js — register / get /
// list / resolve — rather than reusing it. They are different kinds of provider:
// an AI provider answers `generate(messages)`, a search provider answers
// `search(query)` and `fetch(url)`, and collapsing them would mean every model
// adapter had to grow a `search` it cannot implement. The *pattern* is shared
// on purpose so a reader who knows one knows the other.
//
// Core imports no HTTP client and no search SDK. A concrete provider is
// supplied by the host (src/main), where the keys live — the same rule the
// model provider already follows.

const { isString } = require('../../schema/validate');
const { SourceUnavailableError, SourceTimeoutError } = require('../errors/researchErrors');

// --- the provider security contract -----------------------------------------
//
// Core performs no network I/O, so two SSRF defences cannot live here and must
// be honoured by the provider that does the fetching. They are stated here
// because this is the file a provider author reads:
//
//   1. **Check the resolved address, not just the URL.** `screenUrl` inspects
//      the hostname as written. A public name can resolve to a private address
//      (`localtest.me` → 127.0.0.1, `169.254.169.254.nip.io` → the metadata
//      endpoint). Resolve first, pass the address to
//      `researchSecurity.screenResolvedAddress(ip)`, and connect only if it
//      passes. The known wildcard-DNS services are blocked by name as a cheap
//      first layer, but that is a blocklist and blocklists are never complete.
//
//   2. **Screen every redirect hop.** A page on an allowed domain redirecting
//      to the metadata endpoint defeats a check applied only to the first URL.
//      Follow redirects manually, passing each hop through
//      `researchSecurity.screenRedirect(from, to)`, and stop at
//      `researchSecurity.MAX_REDIRECTS`.
//
// A provider that cannot do either must not follow redirects at all. Reporting
// the post-redirect address as the result's `url` also helps: SourceManager
// screens every returned URL, so an honest final URL is caught there even if
// the provider missed it.
//
// What a provider must implement. `search` is mandatory; `fetch` is optional —
// a provider that only ranks (returning snippets) is still useful, and the
// pipeline degrades to snippet-level evidence rather than refusing it.
const PROVIDER_METHODS = Object.freeze(['search', 'fetch']);

function validateProvider(id, adapter) {
  if (!isString(id) || !id) return { ok: false, errors: ['search provider requires an id'] };
  if (!adapter || typeof adapter.search !== 'function') {
    return { ok: false, errors: [`search provider "${id}" must implement search()`] };
  }
  if (adapter.fetch !== undefined && typeof adapter.fetch !== 'function') {
    return { ok: false, errors: [`search provider "${id}" has a non-function fetch()`] };
  }
  if (adapter.sourceTypes !== undefined && !Array.isArray(adapter.sourceTypes)) {
    return { ok: false, errors: [`search provider "${id}" sourceTypes must be an array`] };
  }
  return { ok: true, errors: [] };
}

// The provider that is always present. It does not pretend to search: it says
// plainly that nothing is configured, so a research task without a host-supplied
// provider reports "no web provider" instead of returning an empty result set
// that reads like "nothing exists about this topic".
const nullSearchProvider = Object.freeze({
  id: 'null',
  label: 'No search provider configured',
  sourceTypes: [],
  async search() {
    throw new SourceUnavailableError('null', 'no search provider is configured for this install');
  },
  async fetch() {
    throw new SourceUnavailableError('null', 'no search provider is configured for this install');
  },
});

function createSearchProviderRegistry() {
  const providers = new Map();
  // sourceType -> ordered provider ids. Order is registration order, which is
  // also the fallback order when one fails (§35).
  const byType = new Map();

  function register(id, adapter) {
    const { ok, errors } = validateProvider(id, adapter);
    if (!ok) throw new TypeError(errors[0]);
    const entry = Object.freeze({
      id,
      label: adapter.label || id,
      sourceTypes: Object.freeze([...(adapter.sourceTypes || [])]),
      priority: typeof adapter.priority === 'number' ? adapter.priority : 0,
      timeoutMs: Number.isInteger(adapter.timeoutMs) ? adapter.timeoutMs : 15_000,
      search: adapter.search.bind(adapter),
      fetch: typeof adapter.fetch === 'function' ? adapter.fetch.bind(adapter) : null,
      // Optional health probe. A provider that knows it is rate-limited can say
      // so and be skipped rather than burning a retry.
      healthy: typeof adapter.healthy === 'function' ? adapter.healthy.bind(adapter) : () => true,
    });
    providers.set(id, entry);
    for (const type of entry.sourceTypes) {
      if (!byType.has(type)) byType.set(type, []);
      const list = byType.get(type);
      if (!list.includes(id)) list.push(id);
      list.sort((a, b) => (providers.get(b).priority - providers.get(a).priority));
    }
    return entry;
  }

  function unregister(id) {
    for (const list of byType.values()) {
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
    }
    return providers.delete(id);
  }

  function get(id) {
    return providers.get(id) || null;
  }

  function has(id) {
    return providers.has(id);
  }

  function list() {
    return [...providers.values()].map((p) => ({
      id: p.id, label: p.label, sourceTypes: [...p.sourceTypes], priority: p.priority, canFetch: Boolean(p.fetch),
    }));
  }

  // Every provider that can serve a source type, best first. Returning the
  // whole ordered list rather than one provider is what makes §35's "fallback
  // provider" a loop instead of a special case.
  function resolveAll(sourceType) {
    const ids = byType.get(sourceType) || [];
    return ids.map((id) => providers.get(id)).filter((p) => p && p.healthy() !== false);
  }

  function resolve(sourceType) {
    return resolveAll(sourceType)[0] || null;
  }

  function supports(sourceType) {
    return resolveAll(sourceType).length > 0;
  }

  return { register, unregister, get, has, list, resolve, resolveAll, supports, size: () => providers.size };
}

// Run a provider call with a timeout and an abort signal, and translate whatever
// it throws into the research error family. Every adapter goes through this, so
// a provider that hangs cannot hang a research task (§46).
async function callProvider(provider, method, args, { timeoutMs, signal } = {}) {
  const fn = provider[method];
  if (typeof fn !== 'function') {
    throw new SourceUnavailableError(provider.id, `provider does not implement ${method}()`);
  }
  const limit = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : provider.timeoutMs;
  if (signal && signal.aborted) throw new SourceUnavailableError(provider.id, 'aborted before start', { category: 'cancelled' });

  let timer = null;
  let onAbort = null;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new SourceTimeoutError(provider.id, limit)), limit);
      if (signal) {
        onAbort = () => reject(new SourceUnavailableError(provider.id, 'cancelled', { category: 'cancelled' }));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve()
        .then(() => fn({ ...args, signal }))
        .then(resolve, (err) => reject(normalizeProviderError(provider.id, err)));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function normalizeProviderError(providerId, err) {
  if (err && err.name && err.name.startsWith('Research')) return err;
  if (err instanceof SourceUnavailableError) return err;
  const msg = (err && err.message) || String(err);
  const category = /rate.?limit|429|too many/i.test(msg) ? 'transient'
    : /timeout|etimedout|timed out/i.test(msg) ? 'timeout'
      : /enotfound|econnrefused|econnreset|network|dns/i.test(msg) ? 'transient'
        : 'environment';
  return new SourceUnavailableError(providerId, msg.slice(0, 300), { category, cause: err });
}

module.exports = {
  PROVIDER_METHODS, nullSearchProvider, validateProvider,
  createSearchProviderRegistry, callProvider, normalizeProviderError,
};
