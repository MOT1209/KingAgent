// Turning normalized release metadata into the explanation a person reads.
//
// This is the layer the spec calls "never invent technical changes that do
// not exist in release metadata." Every string this file hands back came
// from update-metadata.js's normalize step, which itself only ever copied
// text out of the release — a highlight, a bug-fix line, a paragraph of
// notes. Nothing here writes new prose; it only selects, counts, and orders
// what is already there.

// Highlights, in order of how much a release author actually told us:
// their own curated `highlights` list first; failing that, the individual
// change lists concatenated (security first, so the one category that most
// wants a person's attention is never buried under six feature bullets);
// failing that, whatever bullet lines already existed in the free-text
// summary. An update with none of the above simply has no highlights — an
// empty list is the honest answer, not a fabricated one.
function deriveHighlights(meta, max = 6) {
  if (meta.highlights.length) return meta.highlights.slice(0, max);
  const combined = [...meta.securityFixes, ...meta.features, ...meta.bugFixes];
  if (combined.length) return combined.slice(0, max);
  return extractBullets(meta.summary).slice(0, max);
}

function extractBullets(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, ''));
}

// A category the metadata did not state outright is inferred from what it
// does contain — never from anything outside the metadata.
function classifyCategory(meta) {
  if (meta.category) return meta.category;
  if (meta.breakingChanges) return 'breaking';
  if (meta.securityFixes.length) return 'security';
  if (meta.features.length) return 'feature';
  if (meta.bugFixes.length) return 'fix';
  return 'compatibility';
}

function analyzeRelease(meta) {
  const stats = Object.freeze({
    features: meta.features.length,
    bugFixes: meta.bugFixes.length,
    securityFixes: meta.securityFixes.length,
  });
  return Object.freeze({
    version: meta.version,
    title: meta.title,
    summary: meta.summary,
    highlights: deriveHighlights(meta),
    stats,
    category: classifyCategory(meta),
    breakingChanges: !!meta.breakingChanges,
    requiresRestart: meta.requiresRestart !== false,
    minimumSupportedVersion: meta.minimumSupportedVersion || null,
    estimatedDownloadSize: meta.estimatedDownloadSize || 0,
  });
}

module.exports = { analyzeRelease, deriveHighlights, extractBullets, classifyCategory };
