// Artifact: a named, owned, typed thing an agent produced or consumed.
//
// The reason this exists rather than agents passing each other text: a research
// agent that returns "here's what I found…" gives the lead agent a paragraph to
// re-parse, with no provenance and nothing to show a user. An artifact is a
// value with a type, an owner and an id — a test report is a `test-result`, a
// change set is a `diff` — so a result can be validated, displayed, referenced
// from a trace, and handed on without being re-read by a model.
//
// Content is either inline (small, structured) or a reference (a path in the
// workspace). Nothing here duplicates a large file into the store.

const crypto = require('node:crypto');
const { isPlainObject, nonEmptyString, fail } = require('../schema/validate');

const ARTIFACT_TYPES = Object.freeze({
  FILE: 'file',
  CODE: 'code',
  REPORT: 'report',
  IMAGE: 'image',
  DATASET: 'dataset',
  TEST_RESULT: 'test-result',
  BUILD: 'build',
  DIFF: 'diff',
  DOCUMENT: 'document',
});

const ALL_TYPES = Object.freeze(Object.values(ARTIFACT_TYPES));

// Past this, inline content is refused and the caller must pass a path instead.
// An artifact store is metadata plus small payloads; it is not a blob store.
const MAX_INLINE_BYTES = 256 * 1024;

function newArtifactId() {
  return `art-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function contentBytes(content) {
  if (content === null || content === undefined) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(content), 'utf8'); } catch { return 0; }
}

function digestOf(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function validateArtifact(def) {
  if (!isPlainObject(def)) return fail(['artifact must be an object']);
  if (!nonEmptyString(def.name)) return fail(['artifact requires a name']);
  if (def.type !== undefined && !ALL_TYPES.includes(def.type)) {
    return fail([`unknown artifact type: ${JSON.stringify(def.type)}`]);
  }
  if (def.content === undefined && !nonEmptyString(def.path)) {
    return fail(['artifact requires either inline content or a path']);
  }
  if (def.content !== undefined && contentBytes(def.content) > MAX_INLINE_BYTES) {
    return fail([`artifact content exceeds ${MAX_INLINE_BYTES} bytes; store it as a file and pass a path`]);
  }
  if (!nonEmptyString(def.workspaceId)) return fail(['artifact requires an owning workspaceId']);
  return { ok: true, artifact: normalizeArtifact(def) };
}

function normalizeArtifact(def) {
  const now = Date.now();
  const hasContent = def.content !== undefined && def.content !== null;
  return {
    id: def.id || newArtifactId(),
    type: def.type || ARTIFACT_TYPES.DOCUMENT,
    name: def.name,
    path: def.path || null,
    content: hasContent ? def.content : null,
    inline: hasContent,
    bytes: hasContent ? contentBytes(def.content) : (def.bytes ?? null),
    digest: hasContent ? digestOf(def.content) : (def.digest || null),
    taskId: def.taskId || null,
    workspaceId: def.workspaceId,
    agentId: def.agentId || null,
    traceId: def.traceId || null,
    projectId: def.projectId || null,
    producedBy: def.producedBy || null, // step / tool that made it
    createdAt: def.createdAt || now,
    updatedAt: def.updatedAt || now,
    metadata: isPlainObject(def.metadata) ? { ...def.metadata } : {},
  };
}

// A reference is what travels — in a handoff, a delegation result, a trace
// event — instead of the artifact itself.
function artifactRef(artifact) {
  return {
    id: artifact.id,
    type: artifact.type,
    name: artifact.name,
    workspaceId: artifact.workspaceId,
    taskId: artifact.taskId,
    agentId: artifact.agentId,
    bytes: artifact.bytes,
    digest: artifact.digest,
  };
}

// Owner sees everything; anyone else needs an explicit share. There is no
// "same session so it's fine" rule — that is how a delegate reads a sibling's
// private output.
function canRead(artifact, { workspaceId = null, agentId = null } = {}) {
  if (!artifact) return false;
  if (workspaceId && artifact.workspaceId === workspaceId) return true;
  const shared = artifact.metadata && artifact.metadata.sharedWith;
  if (!Array.isArray(shared)) return false;
  return Boolean((workspaceId && shared.includes(workspaceId)) || (agentId && shared.includes(agentId)));
}

function canWrite(artifact, { workspaceId = null } = {}) {
  return Boolean(artifact && workspaceId && artifact.workspaceId === workspaceId);
}

module.exports = {
  ARTIFACT_TYPES, ALL_TYPES, MAX_INLINE_BYTES,
  validateArtifact, normalizeArtifact, artifactRef, canRead, canWrite,
  newArtifactId, contentBytes, digestOf,
};
