// Deduplication (§13).
//
// The thing this protects is the count. Ten copies of one press release is one
// fact, and a system that reports "corroborated by ten sources" because a story
// was syndicated has invented nine corroborations. So dedup here does not just
// drop identical rows — it builds *clusters*, records which source is the
// canonical member, and hands the evidence layer a notion of independence that
// later scoring can trust.
//
// Four passes, cheapest first:
//   1. canonical URL     — the same address, modulo tracking and www
//   2. content digest    — byte-identical text under different addresses
//   3. shingle overlap   — near-duplicates: reformatted, re-hosted, excerpted
//   4. syndication       — same title + same publish date on different domains
//
// Pass 3 is the expensive one. Bucketing it by title would miss the common
// case — the same article re-published under a different headline — so
// candidates are found by min-hash sketch instead: each document indexes itself
// under its few smallest shingle hashes, and only documents sharing a sketch
// value are compared. That keeps it near-linear without the recall hole.

const crypto = require('node:crypto');
const { tokenize } = require('../../memory/relevance');

const SHINGLE_SIZE = 5;
const NEAR_DUPLICATE_THRESHOLD = 0.82;
// Containment is held to a higher bar than Jaccard: "almost all of A is inside
// B" is a strong claim, and at 0.9 a document has to be a near-verbatim excerpt
// to trip it.
const CONTAINMENT_THRESHOLD = 0.9;
// Below this many shingles a document is too short for overlap to mean
// anything — two one-sentence snippets about the same subject will look
// identical without being copies.
const MIN_SHINGLES = 8;
// How many of the smallest shingle hashes form a document's sketch. Larger
// means more candidate pairs compared and fewer misses; 4 is enough that two
// documents over the similarity threshold almost always share at least one.
const SKETCH_SIZE = 4;

function contentDigest(text) {
  return crypto.createHash('sha256')
    .update(String(text || '').toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');
}

// Word-level shingles as hashed integers — cheap to intersect, and far more
// robust to reformatting than comparing raw text.
function shingles(text, size = SHINGLE_SIZE) {
  const words = tokenize(text);
  const out = new Set();
  for (let i = 0; i + size <= words.length; i += 1) {
    out.add(hash32(words.slice(i, i + size).join(' ')));
  }
  return out;
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// How much of the *smaller* document appears in the larger one.
//
// Jaccard alone misses the commonest real duplicate: a syndicated article with
// two paragraphs of the re-publisher's commentary bolted on. Its Jaccard drops
// below any sane threshold while 100% of the original is still sitting there.
// Containment catches exactly that, and only that — two genuinely different
// documents do not contain one another.
function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const x of small) if (large.has(x)) shared += 1;
  return shared / small.size;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const x of small) if (large.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// The k smallest shingle hashes. Two highly-overlapping documents draw their
// smallest hashes from mostly the same pool, so they collide here with high
// probability — the standard min-hash argument, at one band.
function sketch(shingleSet, k = SKETCH_SIZE) {
  return [...shingleSet].sort((a, b) => a - b).slice(0, k);
}

function titleKey(title) {
  return tokenize(title).slice(0, 10).join(' ');
}

// Cluster `sources`. Returns:
//   kept      Source[]                        one canonical source per cluster
//   clusters  [{ canonicalId, memberIds, reason, size }]
//   removed   [{ id, duplicateOf, reason }]
function deduplicate(sources, {
  threshold = NEAR_DUPLICATE_THRESHOLD,
  containmentThreshold = CONTAINMENT_THRESHOLD,
} = {}) {
  const clusters = [];
  const byCanonicalUrl = new Map();
  const byDigest = new Map();
  const bySyndication = new Map();
  const removed = [];
  // clusterIndex by member id, so later passes can find an existing cluster.
  const clusterOf = new Map();

  const attach = (cluster, source, reason) => {
    cluster.members.push(source);
    clusterOf.set(source.id, cluster);
    removed.push({ id: source.id, duplicateOf: cluster.canonical.id, reason });
  };

  const newCluster = (source) => {
    const cluster = { canonical: source, members: [source], reasons: [] };
    clusters.push(cluster);
    clusterOf.set(source.id, cluster);
    return cluster;
  };

  // Ranked so the canonical member is the best copy, not the first-seen one:
  // primary sources win, then longer content, then earlier retrieval.
  const ordered = [...sources].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    const ac = a.content ? a.content.length : 0;
    const bc = b.content ? b.content.length : 0;
    if (ac !== bc) return bc - ac;
    return (a.retrievedAt || 0) - (b.retrievedAt || 0);
  });

  // sketch hash -> candidate entries. One document appears under each of its
  // sketch values, so lookup is a handful of map reads rather than a scan.
  const sketchIndex = new Map(); // number -> [{ sh, cluster }]

  for (const source of ordered) {
    // 1. canonical URL
    const cu = source.canonicalUrl || source.url;
    if (cu && byCanonicalUrl.has(cu)) {
      attach(byCanonicalUrl.get(cu), source, 'identical canonical url');
      continue;
    }

    // 2. exact content
    const body = `${source.content || source.snippet || ''}`;
    const digest = body.length >= 120 ? contentDigest(body) : null;
    if (digest && byDigest.has(digest)) {
      attach(byDigest.get(digest), source, 'identical content');
      continue;
    }

    // 4. syndication — same headline, same day, different publisher. Checked
    // before the expensive shingle pass because it is a single map lookup and
    // it catches wire copy whose bodies were lightly edited.
    const tk = titleKey(source.title);
    const day = source.publishedAt ? Math.floor(source.publishedAt / 86_400_000) : null;
    const synKey = tk && day !== null ? `${tk}::${day}` : null;
    if (synKey && bySyndication.has(synKey)) {
      const cluster = bySyndication.get(synKey);
      if (cluster.canonical.domain !== source.domain) {
        attach(cluster, source, 'syndicated copy');
        continue;
      }
    }

    // 3. near-duplicate, found through the min-hash sketch
    const sh = shingles(body);
    const sk = sh.size >= MIN_SHINGLES ? sketch(sh) : [];
    let matched = null;
    const considered = new Set();
    for (const key of sk) {
      for (const entry of sketchIndex.get(key) || []) {
        if (considered.has(entry.cluster)) continue;
        considered.add(entry.cluster);
        if (jaccard(sh, entry.sh) >= threshold || containment(sh, entry.sh) >= containmentThreshold) {
          matched = entry.cluster;
          break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      attach(matched, source, 'near-duplicate content');
      continue;
    }

    const cluster = newCluster(source);
    if (cu) byCanonicalUrl.set(cu, cluster);
    if (digest) byDigest.set(digest, cluster);
    if (synKey) bySyndication.set(synKey, cluster);
    for (const key of sk) {
      if (!sketchIndex.has(key)) sketchIndex.set(key, []);
      sketchIndex.get(key).push({ sh, cluster });
    }
  }

  return {
    kept: clusters.map((c) => c.canonical),
    clusters: clusters.map((c) => ({
      canonicalId: c.canonical.id,
      memberIds: c.members.map((m) => m.id),
      domains: [...new Set(c.members.map((m) => m.domain).filter(Boolean))],
      size: c.members.length,
    })),
    removed,
    // The map the evidence layer needs: which cluster does this source belong
    // to? Two pieces of evidence from the same cluster are one source, however
    // many URLs they carry.
    clusterOf: new Map([...clusterOf.entries()].map(([id, c]) => [id, c.canonical.id])),
  };
}

// How many *independent* sources are behind a set of source ids? The question
// §16 asks. Members of one cluster count once, and so do two documents from the
// same domain — a vendor's blog post and its docs page are not two opinions.
function independentCount(sourceIds, { clusterOf = new Map(), sourcesById = new Map() } = {}) {
  const keys = new Set();
  for (const id of sourceIds) {
    const canonical = clusterOf.get(id) || id;
    const source = sourcesById.get(canonical) || sourcesById.get(id);
    keys.add(source && source.domain ? `d:${source.domain}` : `s:${canonical}`);
  }
  return keys.size;
}

module.exports = {
  deduplicate, independentCount, shingles, sketch, jaccard, containment, contentDigest, titleKey,
  SHINGLE_SIZE, NEAR_DUPLICATE_THRESHOLD, CONTAINMENT_THRESHOLD, MIN_SHINGLES, SKETCH_SIZE,
};
