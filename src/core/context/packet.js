// The ContextPacket: exactly what the agent was given, frozen and addressable.
//
// Before this existed, "what did the model see?" was unanswerable after the
// fact — context was assembled inline and thrown away. A packet is the record:
// serializable (it goes over IPC and into a trace), deterministic (the same
// inputs produce the same digest, so a rerun can be compared to the original),
// versioned (a packet read back next year knows which assembler made it), and
// testable (it is a value, not a side effect).
//
// It carries no chain-of-thought. Everything in it is an input the platform
// chose — a request, a file, a tool result, a memory — never a model's private
// deliberation.

const crypto = require('node:crypto');
const { newId } = require('../workspace/identity');

const PACKET_VERSION = 1;

// Stable stringify: keys sorted at every level, so two packets with the same
// content hash the same regardless of insertion order.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// The digest deliberately excludes id and createdAt: two packets assembled a
// second apart from identical inputs must compare equal, or the digest can
// never be used to detect "we already built this".
const VOLATILE = new Set(['id', 'createdAt', 'digest']);

function packetDigest(packet) {
  const stable = {};
  for (const [k, v] of Object.entries(packet)) if (!VOLATILE.has(k)) stable[k] = v;
  return crypto.createHash('sha256').update(canonical(stable)).digest('hex').slice(0, 32);
}

function createContextPacket({
  id = null,
  identity = {},
  objective = '',
  task = null,
  step = null,
  agent = null,
  project = null,
  workspace = null,
  files = [],
  tools = [],
  skills = [],
  memories = [],
  previousResults = [],
  environment = null,
  constraints = [],
  executionState = null,
  layers = null,
  items = [],
  budget = null,
  dropped = [],
} = {}) {
  const packet = {
    version: PACKET_VERSION,
    id: id || newId('ctx'),
    createdAt: Date.now(),
    identity: {
      workspaceId: identity.workspaceId || null,
      taskId: identity.taskId || null,
      agentId: identity.agentId || null,
      projectId: identity.projectId || null,
      sessionId: identity.sessionId || null,
      traceId: identity.traceId || null,
    },
    objective: String(objective || ''),
    task,
    step,
    agent,
    project,
    workspace,
    files: [...files],
    tools: [...tools],
    skills: [...skills],
    memories: [...memories],
    previousResults: [...previousResults],
    environment,
    constraints: [...constraints],
    executionState,
    layers,
    items: [...items],
    budget,
    dropped: [...dropped],
  };
  packet.digest = packetDigest(packet);
  return Object.freeze(packet);
}

function serializePacket(packet) {
  return JSON.stringify(packet);
}

function deserializePacket(text) {
  const raw = typeof text === 'string' ? JSON.parse(text) : text;
  if (!raw || typeof raw !== 'object') throw new Error('context packet must be an object');
  if (raw.version !== PACKET_VERSION) {
    throw new Error(`unsupported context packet version ${raw.version} (this build reads ${PACKET_VERSION})`);
  }
  return Object.freeze({ ...raw });
}

// Two packets describing the same world? Compares digests, not object identity.
function samePacket(a, b) {
  return Boolean(a && b && a.digest && a.digest === b.digest);
}

// A packet is large; this is what a list view and a trace event carry.
function summarizePacket(packet) {
  return {
    id: packet.id,
    digest: packet.digest,
    objective: packet.objective.slice(0, 160),
    taskId: packet.identity.taskId,
    agentId: packet.identity.agentId,
    items: packet.items.length,
    files: packet.files.length,
    memories: packet.memories.length,
    tools: packet.tools.length,
    usedChars: packet.budget ? packet.budget.usedChars : null,
    usedTokens: packet.budget ? packet.budget.usedTokens : null,
    dropped: packet.dropped.length,
    createdAt: packet.createdAt,
  };
}

module.exports = {
  PACKET_VERSION, createContextPacket, serializePacket, deserializePacket,
  packetDigest, samePacket, summarizePacket, canonical,
};
