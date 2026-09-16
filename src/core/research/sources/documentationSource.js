// Documentation research (§27): official docs, API references, release notes.
//
// Documentation is the highest-authority source for "how does this work?" and
// the *wrong* source for "is this a good idea?". The adapter therefore does two
// things nothing else does: it biases the query toward official domains when
// the host's provider supports a site filter, and it records which doc surface
// a row came from so the evaluator can tell an API reference from a blog post
// on the same domain.

const { SOURCE_TYPES } = require('../schemas/source');
const { createAdapter, baseMap, pick } = require('./adapter');

// Paths that mark a page as reference material rather than marketing. Matched
// against the URL path, not the domain, because a vendor's docs and its
// homepage share a hostname.
const DOC_PATH_HINTS = Object.freeze([
  '/docs', '/doc/', '/documentation', '/reference', '/api', '/guide', '/manual',
  '/handbook', '/spec', '/rfc', '/changelog', '/release', '/migration', '/faq',
]);

// Query shaping. A documentation search that just repeats the user's sentence
// competes with every blog that quotes it; adding the shape of reference
// material pulls the official page up without hard-coding a single vendor.
const DOC_TERMS = 'documentation OR reference OR guide';

function createDocumentationSource() {
  return createAdapter({
    id: 'documentation',
    type: SOURCE_TYPES.DOCUMENTATION,
    label: 'Documentation research',
    description: 'Official documentation, API references and release notes.',
    providerTypes: [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.WEB],
    defaultAuthority: 0.85,
    shapeQuery: (text, query) => (
      // Only reshape a discovery-style query. An evidence or verification query
      // is already precise, and padding it with OR terms makes it worse.
      query && (query.intent === 'evidence' || query.intent === 'verification')
        ? text
        : `${text} ${DOC_TERMS}`
    ),
    map: (row) => {
      const url = pick(row, ['url', 'link', 'href']);
      return {
        ...baseMap(row, { type: SOURCE_TYPES.DOCUMENTATION }),
        primary: true,
        metadata: {
          surface: docSurface(url),
          official: row && row.official === true,
          version: pick(row, ['version', 'docVersion', 'release']) || null,
          section: pick(row, ['section', 'anchor', 'heading']) || null,
        },
      };
    },
  });
}

// Which kind of documentation page is this? Used for scoring and for answering
// §27's "what changed in version X?" — a changelog is the right source for that
// and a guide is not.
function docSurface(url) {
  if (typeof url !== 'string') return 'unknown';
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return 'unknown'; }
  if (/\/(changelog|releases?|release-notes|whats-?new)/.test(path)) return 'changelog';
  if (/\/(api|reference)\b/.test(path)) return 'reference';
  if (/\/(guide|tutorial|getting-?started|handbook|manual)/.test(path)) return 'guide';
  if (/\/(spec|rfc)\b/.test(path)) return 'specification';
  if (DOC_PATH_HINTS.some((h) => path.includes(h))) return 'docs';
  return 'unknown';
}

module.exports = { createDocumentationSource, docSurface, DOC_PATH_HINTS };
