// The SSRF-safe fetch loop a search provider's fetch() is built on (audit C1).
//
// searchProvider.js states the contract: check the *resolved* address, and
// screen *every* redirect hop. Stating it was not enforcing it, and each
// provider author would have had to rewrite the same loop. This is that loop,
// once. Core still opens no socket: DNS and the transport are injected, so the
// host (src/main) supplies `request` and this module supplies the policy.
//
//   lookup(hostname, { all: true }) -> [{ address, family }]   (dns.promises.lookup)
//   request({ url, address, family, signal }) -> { status, headers, body }
//
// `request` must connect to `address`, not re-resolve the hostname — otherwise
// a second DNS answer could differ from the one that was screened — and must
// not follow redirects itself; this loop does, one screened hop at a time.

const {
  screenUrl, screenResolvedAddress, screenRedirect, MAX_REDIRECTS,
} = require('./researchSecurity');

// An IP literal needs no lookup. (Core imports no network module, so this is
// a shape test rather than net.isIP.)
function ipFamily(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 4;
  if (host.includes(':')) return 6;
  return 0;
}

function refuse(reason, url, hops) {
  return { ok: false, reason, url: url || null, hops, response: null };
}

// Every address the name resolves to must pass: a name with one public and one
// private record would otherwise be a coin flip for the attacker.
async function resolveSafely(hostname, lookup, screenOpts) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (ipFamily(bare)) {
    const verdict = screenResolvedAddress(bare, screenOpts);
    return verdict.ok ? { ok: true, address: bare, family: ipFamily(bare) } : { ok: false, reason: verdict.reason };
  }
  let records;
  try {
    records = await lookup(bare, { all: true });
  } catch (err) {
    return { ok: false, reason: `could not resolve ${bare}: ${err && err.message}` };
  }
  if (!Array.isArray(records) || records.length === 0) return { ok: false, reason: `${bare} resolved to no address` };
  for (const r of records) {
    const verdict = screenResolvedAddress(r && r.address, screenOpts);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
  }
  return { ok: true, address: records[0].address, family: records[0].family || ipFamily(records[0].address) };
}

async function safeFetch(url, {
  request,
  lookup,
  screenOptions = {},
  maxRedirects = MAX_REDIRECTS,
  signal = null,
} = {}) {
  if (typeof request !== 'function') throw new TypeError('safeFetch requires a request() transport');
  if (typeof lookup !== 'function') throw new TypeError('safeFetch requires a lookup() resolver');
  let current = url;
  const first = screenUrl(current, screenOptions);
  if (!first.ok) return refuse(first.reason, current, 0);

  for (let hops = 0; ; hops++) {
    const { hostname } = new URL(current);
    const resolved = await resolveSafely(hostname, lookup, screenOptions);
    if (!resolved.ok) return refuse(resolved.reason, current, hops);

    const response = await request({ url: current, address: resolved.address, family: resolved.family, signal });
    const status = response && response.status;
    const location = response && response.headers && (response.headers.location || response.headers.Location);
    if (!(status >= 300 && status < 400 && location)) return { ok: true, reason: '', url: current, hops, response };

    if (hops >= maxRedirects) return refuse(`more than ${maxRedirects} redirects`, current, hops);
    let next;
    try { next = new URL(location, current).href; } catch { return refuse('redirect to an unparseable location', current, hops); }
    const verdict = screenRedirect(current, next, screenOptions);
    if (!verdict.ok) return refuse(verdict.reason, next, hops + 1);
    current = next;
  }
}

module.exports = { safeFetch };
