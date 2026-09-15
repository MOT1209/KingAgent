// Academic search: papers, preprints, citations.
//
// The one thing this adapter knows that the web adapter does not: a paper has a
// DOI, a venue and a citation count, and those are the difference between "a
// PDF someone uploaded" and "a peer-reviewed result". They are carried into
// metadata so sourceQuality.js can weigh them.

const { SOURCE_TYPES } = require('../schemas/source');
const { createAdapter, baseMap, pick } = require('./adapter');

function createAcademicSource() {
  return createAdapter({
    id: 'academic',
    type: SOURCE_TYPES.ACADEMIC,
    label: 'Academic search',
    description: 'Papers, preprints and citations from a scholarly provider.',
    providerTypes: [SOURCE_TYPES.ACADEMIC],
    // A peer-reviewed paper is a primary source in the §11 sense; it starts high.
    defaultAuthority: 0.8,
    map: (row) => {
      const doi = pick(row, ['doi', 'DOI']);
      const citations = pick(row, ['citationCount', 'citation_count', 'citedByCount', 'cited_by_count'], null);
      return {
        ...baseMap(row, { type: SOURCE_TYPES.ACADEMIC }),
        // A DOI resolves to the canonical record, which is a better identity
        // than whichever aggregator happened to serve the row.
        url: pick(row, ['url', 'link', 'pdfUrl', 'openAccessPdf']) || (doi ? `https://doi.org/${doi}` : null),
        publisher: pick(row, ['venue', 'journal', 'publisher', 'containerTitle']),
        primary: true,
        metadata: {
          doi: doi || null,
          citationCount: typeof citations === 'number' ? citations : null,
          peerReviewed: row && row.peerReviewed === true,
          openAccess: row && (row.isOpenAccess === true || row.openAccess === true),
          arxivId: pick(row, ['arxivId', 'arxiv_id']) || null,
        },
      };
    },
  });
}

module.exports = { createAcademicSource };
