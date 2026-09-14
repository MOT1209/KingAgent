// Turning GitHub's release document into something the analyzer can trust.
//
// A KingAgent release is a GitHub release: a tag, a name, a markdown body, and a
// pile of assets. update-check.js already reads the parts that decide *whether*
// to offer an update (tag_name, draft, prerelease, assets). This file reads the
// parts that decide *how to explain* it.
//
// Release authors get to write a structured block if they want one — a fenced
// ```kingagent-update code block in the release notes, holding the JSON shape
// from the spec (summary, importance, highlights, features, bugFixes,
// securityFixes, …). When it is there, it is the source of truth. When it is
// not, every field falls back through release name → release notes → a
// generic line, and never further than that: nothing here invents a change
// that was not written down somewhere in the release itself.

const IMPORTANCE_LEVELS = ['optional', 'recommended', 'important', 'critical'];
const CATEGORIES = ['feature', 'fix', 'security', 'performance', 'compatibility', 'breaking'];

const FIELD_DEFAULTS = Object.freeze({
  version: null,
  title: null,
  summary: '',
  importance: null,
  category: null,
  highlights: [],
  features: [],
  bugFixes: [],
  securityFixes: [],
  breakingChanges: false,
  requiresRestart: true,
  estimatedDownloadSize: 0,
  publishedAt: null,
  minimumSupportedVersion: null,
});

function stringArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

// The one place a release author can hand this app real structure instead of
// prose. Anything that fails to parse — a typo, a half-finished block, notes
// written before this feature shipped — reads as "no structured metadata",
// never as an error: release notes are prose first, and a broken fence must
// not break the update check.
const METADATA_FENCE = /```(?:json\s+)?kingagent-update\s*\n([\s\S]*?)```/i;
function extractStructuredMetadata(body) {
  const text = String(body || '');
  const m = METADATA_FENCE.exec(text);
  if (!m) return null;
  try {
    const doc = JSON.parse(m[1]);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch (_) {
    return null;
  }
}

// The first paragraph of the release notes, trimmed to something a dialog can
// show without becoming the release notes itself. Verbatim text, never a
// paraphrase — a summary this file writes itself would be a guess dressed up
// as a fact.
function firstParagraph(text, max = 400) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const cut = trimmed.indexOf('\n\n');
  const para = (cut === -1 ? trimmed : trimmed.slice(0, cut)).trim();
  return para.length > max ? para.slice(0, max - 1).trimEnd() + '…' : para;
}

// `release` is the GitHub release document (same shape update-check.js's
// releaseFromApi reads: tag_name, name, body, published_at, assets, plus an
// optional `metadata` object for callers that already parsed one out).
function normalizeMetadata(release) {
  const doc = release && typeof release === 'object' ? release : {};
  const version = String(doc.tag_name || doc.version || '').trim().replace(/^v/i, '') || null;
  const structured = extractStructuredMetadata(doc.body)
    || (doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : null);

  const out = { ...FIELD_DEFAULTS, version };

  if (structured) {
    if (typeof structured.title === 'string' && structured.title.trim()) out.title = structured.title.trim();
    if (typeof structured.summary === 'string' && structured.summary.trim()) out.summary = structured.summary.trim();
    if (IMPORTANCE_LEVELS.includes(structured.importance)) out.importance = structured.importance;
    if (CATEGORIES.includes(structured.category)) out.category = structured.category;
    out.highlights = stringArray(structured.highlights);
    out.features = stringArray(structured.features);
    out.bugFixes = stringArray(structured.bugFixes);
    out.securityFixes = stringArray(structured.securityFixes);
    if (typeof structured.breakingChanges === 'boolean') out.breakingChanges = structured.breakingChanges;
    if (typeof structured.requiresRestart === 'boolean') out.requiresRestart = structured.requiresRestart;
    if (Number.isFinite(structured.estimatedDownloadSize) && structured.estimatedDownloadSize >= 0) {
      out.estimatedDownloadSize = structured.estimatedDownloadSize;
    }
    if (typeof structured.minimumSupportedVersion === 'string' && structured.minimumSupportedVersion.trim()) {
      out.minimumSupportedVersion = structured.minimumSupportedVersion.trim();
    }
  }

  // Fallback hierarchy for the two fields a person actually reads first.
  // Structured metadata wins when it said something; otherwise the release's
  // own name, then its notes, then — only when GitHub gave back nothing
  // usable at all — one generic line.
  if (!out.title) {
    out.title = (typeof doc.name === 'string' && doc.name.trim())
      || (version ? `KingAgent ${version}` : 'KingAgent update');
  }
  if (!out.summary) {
    const notesBody = typeof doc.body === 'string' ? doc.body.replace(METADATA_FENCE, '').trim() : '';
    out.summary = notesBody ? firstParagraph(notesBody) : 'A new version of KingAgent is available.';
  }
  if (typeof doc.published_at === 'string' && doc.published_at) out.publishedAt = doc.published_at;

  // Not part of the spec's JSON shape, but useful for callers (and tests)
  // that want to know which rung of the fallback hierarchy actually fired.
  out.source = structured ? 'structured' : (doc.name ? 'release-name' : (doc.body ? 'release-notes' : 'generic'));
  return out;
}

function validateMetadata(meta) {
  const errors = [];
  if (!meta || typeof meta !== 'object') return ['metadata must be an object'];
  if (meta.importance != null && !IMPORTANCE_LEVELS.includes(meta.importance)) errors.push('invalid importance');
  if (meta.category != null && !CATEGORIES.includes(meta.category)) errors.push('invalid category');
  for (const key of ['highlights', 'features', 'bugFixes', 'securityFixes']) {
    if (meta[key] != null && !Array.isArray(meta[key])) errors.push(`${key} must be an array`);
  }
  if (meta.estimatedDownloadSize != null && (!Number.isFinite(meta.estimatedDownloadSize) || meta.estimatedDownloadSize < 0)) {
    errors.push('estimatedDownloadSize must be a non-negative number');
  }
  return errors;
}

module.exports = {
  normalizeMetadata,
  validateMetadata,
  extractStructuredMetadata,
  IMPORTANCE_LEVELS,
  CATEGORIES,
  FIELD_DEFAULTS,
};
