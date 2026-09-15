// The project record: what the platform knows about a folder, in one shape.
//
// This is what a context packet quotes and what the project store persists. It
// is metadata only — never file contents — so it stays small enough to include
// in every packet without a budget decision.

const crypto = require('node:crypto');

const METADATA_VERSION = 1;

// A stable id for a root path, so the same folder is the same project across
// restarts without storing the path as a key (paths differ per machine, and a
// hash is also what keeps a home directory out of a key listing).
function projectIdFor(root) {
  return `proj-${crypto.createHash('sha256').update(String(root)).digest('hex').slice(0, 16)}`;
}

function createProjectMetadata(detection, { projectId = null, extra = {} } = {}) {
  const root = detection.root;
  return {
    version: METADATA_VERSION,
    projectId: projectId || projectIdFor(root),
    root,
    name: detection.name,
    projectVersion: detection.version || null,
    type: detection.type,
    languages: [...(detection.languages || [])],
    frameworks: [...(detection.frameworks || [])],
    packageManager: detection.packageManager || null,
    hasGit: Boolean(detection.hasGit),
    scripts: [...(detection.scripts || [])],
    markers: [...(detection.markers || [])],
    configFiles: [...(detection.configFiles || [])],
    importantFiles: [...(detection.importantFiles || [])],
    sourceDirs: [...(detection.sourceDirs || [])],
    detectedAt: detection.detectedAt || Date.now(),
    indexedAt: null,
    ...extra,
  };
}

// Later detections refresh the facts without losing anything a caller attached.
function mergeProjectMetadata(existing, next) {
  if (!existing) return next;
  return { ...existing, ...next, projectId: existing.projectId, indexedAt: next.indexedAt ?? existing.indexedAt };
}

// One line for a context packet / the UI.
function describeProject(meta) {
  if (!meta) return 'unknown project';
  const bits = [meta.name, meta.type !== 'unknown' ? meta.type : null, meta.packageManager, meta.hasGit ? 'git' : null]
    .filter(Boolean);
  return bits.join(' · ');
}

module.exports = { METADATA_VERSION, projectIdFor, createProjectMetadata, mergeProjectMetadata, describeProject };
