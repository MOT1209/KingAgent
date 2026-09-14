// Barrel for project detection and the lightweight index.

const { ProjectIndexer, SKIP_DIRS } = require('./indexer');
const detector = require('./detector');
const metadata = require('./metadata');

module.exports = {
  ProjectIndexer,
  SKIP_DIRS,
  detectProject: detector.detectProject,
  detectRoot: detector.detectRoot,
  MARKERS: detector.MARKERS,
  projectIdFor: metadata.projectIdFor,
  createProjectMetadata: metadata.createProjectMetadata,
  describeProject: metadata.describeProject,
  METADATA_VERSION: metadata.METADATA_VERSION,
};
