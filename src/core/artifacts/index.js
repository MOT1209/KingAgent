// Barrel for the artifact subsystem.

const { ArtifactManager, ArtifactAccessError } = require('./manager');
const { ArtifactStore } = require('./store');
const artifact = require('./artifact');

module.exports = {
  ArtifactManager,
  ArtifactAccessError,
  ArtifactStore,
  ARTIFACT_TYPES: artifact.ARTIFACT_TYPES,
  ALL_ARTIFACT_TYPES: artifact.ALL_TYPES,
  MAX_INLINE_BYTES: artifact.MAX_INLINE_BYTES,
  validateArtifact: artifact.validateArtifact,
  artifactRef: artifact.artifactRef,
  canReadArtifact: artifact.canRead,
  canWriteArtifact: artifact.canWrite,
};
