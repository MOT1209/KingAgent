// GitHub research (§26): repositories, READMEs, issues, pull requests,
// releases, commits, dependencies, licence and activity.
//
// A repository is a *primary* source about itself. "What does this library do?"
// is answered better by its own README and release notes than by any article
// about it, so rows here start with high authority — but only for claims about
// that repository. sourceQuality.js does not extend that authority to unrelated
// subjects.

const { SOURCE_TYPES } = require('../schemas/source');
const { createAdapter, baseMap, pick } = require('./adapter');

// The facets §26 lists. A provider is asked for one facet at a time so a failure
// to read issues does not cost us the README.
const GITHUB_FACETS = Object.freeze([
  'repository', 'readme', 'issues', 'pulls', 'releases', 'commits',
  'documentation', 'tree', 'dependencies', 'license', 'activity',
]);

function createGithubSource() {
  return createAdapter({
    id: 'github',
    type: SOURCE_TYPES.GITHUB,
    label: 'GitHub research',
    description: 'Repositories, READMEs, issues, PRs, releases and activity.',
    providerTypes: [SOURCE_TYPES.GITHUB],
    defaultAuthority: 0.75,
    map: (row) => {
      const facet = pick(row, ['facet', 'kind', 'objectType'], 'repository');
      const repo = pick(row, ['repo', 'repository', 'full_name', 'fullName']);
      return {
        ...baseMap(row, { type: SOURCE_TYPES.GITHUB }),
        publisher: repo || pick(row, ['owner', 'organization']),
        primary: true,
        metadata: {
          facet: GITHUB_FACETS.includes(facet) ? facet : 'repository',
          repo: repo || null,
          ref: pick(row, ['ref', 'sha', 'tag', 'branch']) || null,
          path: pick(row, ['path', 'filePath']) || null,
          stars: numOrNull(pick(row, ['stars', 'stargazers_count', 'stargazersCount'], null)),
          forks: numOrNull(pick(row, ['forks', 'forks_count'], null)),
          openIssues: numOrNull(pick(row, ['open_issues', 'openIssues', 'openIssueCount'], null)),
          license: pick(row, ['license', 'licenseId', 'spdx']) || null,
          archived: row && row.archived === true,
          lastPushedAt: pick(row, ['pushed_at', 'pushedAt', 'lastPush']) || null,
          language: pick(row, ['language', 'primaryLanguage']) || null,
        },
      };
    },
  });
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

module.exports = { createGithubSource, GITHUB_FACETS };
