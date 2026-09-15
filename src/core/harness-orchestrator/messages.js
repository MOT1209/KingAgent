// AgentMessage: the structured protocol agents talk in.
//
// §28 is unusually blunt about this: "Never use hidden prompt concatenation as
// the communication protocol." The reason is that concatenation destroys
// provenance — once agent A's request is a paragraph inside agent B's prompt,
// nothing downstream can say who asked, what was asked, or what came back. So
// communication is an envelope with a type, and the payload is data.
//
//   REQUEST     someone wants something done
//   DELEGATION  a lead hands a scoped task to a child agent
//   RESULT      a child reports what it produced
//   ERROR       something failed, with a code
//   STATUS      progress, no action implied
//   APPROVAL    a human decision is needed, or has been made
//   HANDOFF     ownership of a task transfers, with state
//
// Every message carries `inReplyTo` when it answers another, and the tracing
// refs (`taskId`, `delegationId`, `sessionId`, `traceId`) so the trace file can
// reconstruct the conversation tree without reading payloads.

const crypto = require('node:crypto');
const { isPlainObject, isString, fail } = require('../schema/validate');

const MESSAGE_TYPES = Object.freeze([
  'REQUEST',
  'DELEGATION',
  'RESULT',
  'ERROR',
  'STATUS',
  'APPROVAL',
  'HANDOFF',
]);

// Payload keys a message may carry. A whitelist rather than a free-for-all: an
// unknown key is almost always a caller trying to pass a prompt, a whole
// transcript, or an object graph through the protocol.
const PAYLOAD_KEYS = Object.freeze([
  'objective', 'detail', 'result', 'artifacts', 'questions', 'constraints',
  'files', 'reason', 'code', 'summary', 'progress', 'requestId', 'granted',
  'handoff', 'delegation', 'note', 'stats',
]);

function createMessage({
  type,
  from,
  to,
  payload = {},
  inReplyTo = null,
  taskId = null,
  delegationId = null,
  sessionId = null,
  traceId = null,
  agentId = null,
  harnessId = null,
  workspaceId = null,
  parentEventId = null,
} = {}) {
  const message = {
    id: `msg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    type,
    from,
    to,
    payload: sanitizePayload(payload),
    inReplyTo,
    taskId,
    delegationId,
    sessionId,
    traceId,
    agentId,
    harnessId,
    workspaceId,
    parentEventId,
    at: Date.now(),
  };
  const { ok, errors } = validateMessage(message);
  if (!ok) throw new Error(`invalid agent message: ${errors.join('; ')}`);
  return Object.freeze(message);
}

function validateMessage(message) {
  if (!isPlainObject(message)) return fail(['message must be an object']);
  if (!MESSAGE_TYPES.includes(message.type)) return fail([`message type must be one of ${MESSAGE_TYPES.join(', ')}`]);
  if (!isString(message.from) || !message.from) return fail(['message requires a sender']);
  if (!isString(message.to) || !message.to) return fail(['message requires a recipient']);
  if (message.payload !== undefined && !isPlainObject(message.payload)) return fail(['message payload must be an object']);
  if (message.inReplyTo !== null && message.inReplyTo !== undefined && !isString(message.inReplyTo)) {
    return fail(['message inReplyTo must be a message id or null']);
  }
  return { ok: true, errors: [] };
}

// Reply to a message, inheriting every correlation id. This is the only
// sanctioned way to answer: hand-building a reply is how ids drift.
function replyTo(message, { type, from, payload = {}, extra = {} } = {}) {
  return createMessage({
    type,
    from: from || message.to,
    to: message.from, // replies go back to the sender, not to whoever asked last
    payload,
    inReplyTo: message.id,
    taskId: message.taskId,
    delegationId: message.delegationId,
    sessionId: message.sessionId,
    traceId: message.traceId,
    harnessId: message.harnessId,
    workspaceId: message.workspaceId,
    parentEventId: message.id,
    ...extra,
  });
}

function sanitizePayload(payload) {
  if (!isPlainObject(payload)) return {};
  const out = {};
  for (const key of PAYLOAD_KEYS) {
    if (payload[key] === undefined) continue;
    const value = payload[key];
    // Shallow-copy only: a payload is structured data, not an object graph.
    if (Array.isArray(value)) out[key] = value.slice(0, 50).map(plain);
    else if (isPlainObject(value)) out[key] = plain(value);
    else out[key] = value;
  }
  return out;
}

function plain(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(plain);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return String(value);
}

// The mailbox a coordinator owns per task. Bounded, and it never hands out its
// internal array — a reader cannot mutate history by accident.
function createMailbox({ limit = 500 } = {}) {
  const messages = [];
  return {
    post(message) {
      messages.push(message);
      if (messages.length > limit) messages.splice(0, messages.length - limit);
      return message;
    },
    all() {
      return messages.map((m) => ({ ...m }));
    },
    forTask(taskId) {
      return messages.filter((m) => m.taskId === taskId).map((m) => ({ ...m }));
    },
    between(from, to) {
      return messages.filter((m) => (m.from === from && m.to === to) || (m.from === to && m.to === from)).map((m) => ({ ...m }));
    },
    count() {
      return messages.length;
    },
    clear() {
      messages.length = 0;
    },
  };
}

module.exports = { MESSAGE_TYPES, PAYLOAD_KEYS, createMessage, validateMessage, replyTo, sanitizePayload, createMailbox };
