// General web search. The broadest adapter and the least trusted by default:
// anything can be on the open web, so authority is earned per-domain by
// sourceQuality.js rather than granted by the type.

const { SOURCE_TYPES } = require('../schemas/source');
const { createAdapter, baseMap } = require('./adapter');

function createWebSource() {
  return createAdapter({
    id: 'web',
    type: SOURCE_TYPES.WEB,
    label: 'Web search',
    description: 'General web search across whatever providers the host configured.',
    providerTypes: [SOURCE_TYPES.WEB],
    defaultAuthority: 0.45,
    map: (row) => baseMap(row, { type: SOURCE_TYPES.WEB }),
  });
}

// News is web search with a recency bias, not a separate index. It is a distinct
// adapter because the *scoring* differs — a three-year-old news page is worth
// much less than a three-year-old reference page — and because a task can ask
// for one without the other.
function createNewsSource() {
  return createAdapter({
    id: 'news',
    type: SOURCE_TYPES.NEWS,
    label: 'News search',
    description: 'Recent reporting. Ranked with a heavy freshness weight.',
    providerTypes: [SOURCE_TYPES.NEWS, SOURCE_TYPES.WEB],
    defaultAuthority: 0.4,
    map: (row) => ({
      ...baseMap(row, { type: SOURCE_TYPES.NEWS }),
      metadata: { recencySensitive: true },
    }),
  });
}

module.exports = { createWebSource, createNewsSource };
