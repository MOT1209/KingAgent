// Artifacts: the durable *products* of a run, as opposed to its log.
//
// §34 asks for code, diff, report, test-result, build, research and file
// artifacts, each associated with the task, workspace, agent, harness and trace
// that produced it. The trace says what happened; an artifact is the thing that
// came out, and the two are read by different consumers (a person scrolling a
// diff versus an evaluator reading a test result).
//
// Bounded in two directions, because a report can be enormous and a long session
// can produce thousands of small ones:
//
//   * content is capped per artifact and truncated *with a flag* rather than
//     silently, so a reader can tell the difference between "short" and "cut"
//   * the store keeps a rolling cap and evicts oldest-first
//
// Nothing here is executable and nothing is interpreted: an artifact is data
// plus provenance.

const crypto = require('node:crypto');
const { isPlainObject, isString, fail } = require('../schema/validate');
const { TYPES } = require('../events/event-bus');

const ARTIFACT_TYPES = Object.freeze([
  'code',
  'diff',
  'report',
  'test-result',
  'build',
  'research',
  'file',
  'log',
]);

const DEFAULT_MAX_CONTENT = 200 * 1024; // 200 KB per artifact
const DEFAULT_MAX_ARTIFACTS = 2000;

function validateArtifact(input, { maxContentBytes = DEFAULT_MAX_CONTENT } = {}) {
  if (!isPlainObject(input)) return fail(['artifact must be an object']);
  if (!ARTIFACT_TYPES.includes(input.type)) return fail([`artifact type must be one of ${ARTIFACT_TYPES.join(', ')}`]);
  if (!isString(input.name) || input.name.trim() === '') return fail(['artifact requires a name']);
  if (input.content !== undefined && !isString(input.content)) return fail(['artifact content must be a string']);
  if (input.ref !== undefined && input.ref !== null && !isString(input.ref)) return fail(['artifact ref must be a string or null']);
  if (input.content === undefined && !input.ref) return fail(['artifact requires either content or a ref']);

  let content = input.content === undefined ? null : input.content;
  let truncated = false;
  if (content !== null && Buffer.byteLength(content, 'utf8') > maxContentBytes) {
    // Slice on bytes, then repair any split multi-byte character by re-decoding
    // what fits. A truncated artifact must still be valid text.
    const buf = Buffer.from(content, 'utf8').subarray(0, maxContentBytes);
    content = buf.toString('utf8').replace(/\uFFFD+$/, '');
    truncated = true;
  }
  return { ok: true, artifact: normalizeArtifact(input, { content, truncated }) };
}

function normalizeArtifact(input, { content, truncated }) {
  const id = input.id || `art-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  return Object.freeze({
    id,
    type: input.type,
    name: input.name,
    summary: input.summary || '',
    content,
    ref: input.ref || null,
    truncated,
    size: content === null ? null : Buffer.byteLength(content, 'utf8'),
    // Provenance: the four ids §34 requires, plus session and trace so the
    // control center can show an artifact next to the work that made it.
    taskId: input.taskId || null,
    workspaceId: input.workspaceId || null,
    agentId: input.agentId || null,
    harnessId: input.harnessId || null,
    sessionId: input.sessionId || null,
    traceId: input.traceId || null,
    delegationId: input.delegationId || null,
    createdAt: Date.now(),
  });
}

function createArtifactStore({ bus = null, store = null, maxContentBytes = DEFAULT_MAX_CONTENT, maxArtifacts = DEFAULT_MAX_ARTIFACTS, logger = null } = {}) {
  const artifacts = new Map(); // id -> artifact

  function add(input) {
    const { ok, artifact, errors } = validateArtifact(input, { maxContentBytes });
    if (!ok) throw new Error(`invalid artifact: ${errors.join('; ')}`);
    artifacts.set(artifact.id, artifact);
    if (artifacts.size > maxArtifacts) {
      const oldest = [...artifacts.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, artifacts.size - maxArtifacts);
      for (const a of oldest) artifacts.delete(a.id);
    }
    if (bus) {
      bus.emit(TYPES.ARTIFACT_CREATED, {
        taskId: artifact.taskId,
        workspaceId: artifact.workspaceId,
        agentId: artifact.agentId,
        harnessId: artifact.harnessId,
        sessionId: artifact.sessionId,
        delegationId: artifact.delegationId,
      }, { artifactId: artifact.id, type: artifact.type, name: artifact.name, size: artifact.size, truncated: artifact.truncated });
    }
    if (store) store.set(`artifact:${artifact.id}`, artifact).catch((err) => {
      if (logger) logger.warn('artifact persist failed', { error: err.message });
    });
    return summarizeArtifact(artifact);
  }

  function get(id) {
    return artifacts.get(id) || null;
  }

  function list(filter = {}) {
    let all = [...artifacts.values()];
    if (filter.taskId) all = all.filter((a) => a.taskId === filter.taskId);
    if (filter.sessionId) all = all.filter((a) => a.sessionId === filter.sessionId);
    if (filter.type) all = all.filter((a) => a.type === filter.type);
    if (filter.agentId) all = all.filter((a) => a.agentId === filter.agentId);
    return all
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, filter.limit || 200)
      .map(summarizeArtifact);
  }

  function count() {
    return artifacts.size;
  }

  function remove(id) {
    return artifacts.delete(id);
  }

  function clear() {
    artifacts.clear();
  }

  return { add, get, list, count, remove, clear, types: () => [...ARTIFACT_TYPES] };
}

// The metadata view: content is fetched separately, so a list of 200 artifacts
// does not carry 200 reports over IPC.
function summarizeArtifact(artifact) {
  return {
    id: artifact.id,
    type: artifact.type,
    name: artifact.name,
    summary: artifact.summary,
    size: artifact.size,
    truncated: artifact.truncated,
    ref: artifact.ref,
    taskId: artifact.taskId,
    workspaceId: artifact.workspaceId,
    agentId: artifact.agentId,
    harnessId: artifact.harnessId,
    sessionId: artifact.sessionId,
    traceId: artifact.traceId,
    delegationId: artifact.delegationId,
    createdAt: artifact.createdAt,
  };
}

module.exports = { ARTIFACT_TYPES, DEFAULT_MAX_CONTENT, DEFAULT_MAX_ARTIFACTS, validateArtifact, normalizeArtifact, createArtifactStore, summarizeArtifact };
