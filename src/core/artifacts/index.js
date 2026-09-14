// The artifact store's public surface.

const {
  ARTIFACT_TYPES,
  DEFAULT_MAX_CONTENT,
  DEFAULT_MAX_ARTIFACTS,
  validateArtifact,
  normalizeArtifact,
  createArtifactStore,
  summarizeArtifact,
} = require('./artifacts');

module.exports = {
  ARTIFACT_TYPES,
  DEFAULT_MAX_CONTENT,
  DEFAULT_MAX_ARTIFACTS,
  validateArtifact,
  normalizeArtifact,
  createArtifactStore,
  summarizeArtifact,
};
