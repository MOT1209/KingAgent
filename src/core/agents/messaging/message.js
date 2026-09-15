// AgentMessage: the typed envelope agents talk in.
//
// Free-form text between agents is the multi-agent equivalent of a global
// variable: the receiver re-parses intent from prose, nothing can be validated,
// and a trace shows a conversation rather than an execution. A message has a
// type, a task, a workspace and a trace, so the coordinator can route it, the
// trace can correlate it, and a delegation's result can be checked against a
// schema instead of read.
//
// Attachments are artifact *references*, never payloads — the artifact store
// already owns the content and its permissions.

const crypto = require('node:crypto');
const { isPlainObject, nonEmptyString, fail } = require('../../schema/validate');

const MESSAGE_TYPES = Object.freeze({
  REQUEST: 'REQUEST',
  RESPONSE: 'RESPONSE',
  DELEGATION: 'DELEGATION',
  RESULT: 'RESULT',
  ERROR: 'ERROR',
  APPROVAL: 'APPROVAL',
  STATUS: 'STATUS',
  HANDOFF: 'HANDOFF',
});

const ALL_MESSAGE_TYPES = Object.freeze(Object.values(MESSAGE_TYPES));

const MAX_CONTENT_CHARS = 16_000;
const MAX_ATTACHMENTS = 25;

function newMessageId() {
  return `msg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function validateMessage(def) {
  if (!isPlainObject(def)) return fail(['message must be an object']);
  if (!nonEmptyString(def.fromAgent)) return fail(['message requires fromAgent']);
  if (!nonEmptyString(def.toAgent)) return fail(['message requires toAgent']);
  if (def.type !== undefined && !ALL_MESSAGE_TYPES.includes(def.type)) {
    return fail([`unknown message type: ${JSON.stringify(def.type)}`]);
  }
  if (def.attachments !== undefined && !Array.isArray(def.attachments)) {
    return fail(['attachments must be an array of artifact references']);
  }
  if (Array.isArray(def.attachments) && def.attachments.length > MAX_ATTACHMENTS) {
    return fail([`a message carries at most ${MAX_ATTACHMENTS} attachments`]);
  }
  return { ok: true, message: normalizeMessage(def) };
}

function boundContent(content) {
  if (typeof content === 'string') {
    return content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}…` : content;
  }
  if (content === null || content === undefined) return null;
  try {
    const text = JSON.stringify(content);
    if (text.length <= MAX_CONTENT_CHARS) return content;
    return { truncated: true, chars: text.length, preview: text.slice(0, MAX_CONTENT_CHARS) };
  } catch {
    return { unserializable: true };
  }
}

function normalizeMessage(def) {
  return Object.freeze({
    id: def.id || newMessageId(),
    fromAgent: def.fromAgent,
    toAgent: def.toAgent,
    taskId: def.taskId || null,
    workspaceId: def.workspaceId || null,
    traceId: def.traceId || null,
    sessionId: def.sessionId || null,
    correlationId: def.correlationId || null, // ties a RESPONSE back to its REQUEST
    type: def.type || MESSAGE_TYPES.REQUEST,
    content: boundContent(def.content),
    attachments: Array.isArray(def.attachments) ? def.attachments.slice(0, MAX_ATTACHMENTS) : [],
    metadata: isPlainObject(def.metadata) ? { ...def.metadata } : {},
    timestamp: def.timestamp || Date.now(),
  });
}

// The reply to a message, with the correlation already wired.
function replyTo(message, { type = MESSAGE_TYPES.RESPONSE, content = null, attachments = [], fromAgent = null, metadata = {} } = {}) {
  return normalizeMessage({
    fromAgent: fromAgent || message.toAgent,
    toAgent: message.fromAgent,
    taskId: message.taskId,
    workspaceId: message.workspaceId,
    traceId: message.traceId,
    sessionId: message.sessionId,
    correlationId: message.id,
    type,
    content,
    attachments,
    metadata,
  });
}

module.exports = { MESSAGE_TYPES, ALL_MESSAGE_TYPES, MAX_CONTENT_CHARS, MAX_ATTACHMENTS, validateMessage, normalizeMessage, replyTo, newMessageId };
