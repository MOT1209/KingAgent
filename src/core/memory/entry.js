// The memory entry: one remembered thing, in one shape.
//
// Every provider stores this and only this, so swapping a JSON provider for
// SQLite or a vector store later is a provider change and not a schema
// migration across the platform. `embedding` and `vector` are deliberately NOT
// fields here — Phase 3 retrieval is lexical, and a provider that adds vectors
// puts them in its own metadata rather than forcing every caller to carry one.

const crypto = require('node:crypto');
const { isPlainObject, nonEmptyString, fail } = require('../schema/validate');
const { isScope, scopeKey } = require('./scopes');
const { IMPORTANCE, isImportance, expiresAt: importanceExpiry, scoreImportance } = require('./importance');

const TYPES = Object.freeze({
  FACT: 'fact',
  OBSERVATION: 'observation',
  DECISION: 'decision',
  RESULT: 'result',
  PREFERENCE: 'preference',
  INSTRUCTION: 'instruction',
  CONSTRAINT: 'constraint',
  SUMMARY: 'summary',
  // Declared now so a Phase 4 retriever has somewhere to write; nothing in
  // Phase 3 produces them, and nothing depends on them.
  EPISODIC: 'episodic',
  SEMANTIC: 'semantic',
});

const MAX_CONTENT_CHARS = 8000;

function newMemoryId() {
  return `mem-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function validateMemoryEntry(def) {
  if (!isPlainObject(def)) return fail(['memory entry must be an object']);
  if (!nonEmptyString(textOf(def.content))) return fail(['memory entry requires content']);
  if (!isScope(def.scope)) return fail([`unknown memory scope: ${JSON.stringify(def.scope)}`]);
  if (def.importance !== undefined && !isImportance(def.importance)) {
    return fail([`unknown importance: ${JSON.stringify(def.importance)}`]);
  }
  if (def.tags !== undefined && (!Array.isArray(def.tags) || def.tags.some((t) => typeof t !== 'string'))) {
    return fail(['tags must be an array of strings']);
  }
  return { ok: true, entry: normalizeMemoryEntry(def) };
}

function normalizeMemoryEntry(def) {
  const now = Date.now();
  const importance = isImportance(def.importance) ? def.importance : scoreImportance(def);
  const raw = textOf(def.content);
  const truncated = raw.length > MAX_CONTENT_CHARS;
  const entry = {
    id: def.id || newMemoryId(),
    type: def.type || TYPES.OBSERVATION,
    content: truncated ? `${raw.slice(0, MAX_CONTENT_CHARS)}…` : raw,
    truncated,
    source: def.source || 'unknown',
    scope: def.scope,
    scopeId: def.scopeId === undefined || def.scopeId === null ? '*' : String(def.scopeId),
    importance,
    createdAt: def.createdAt || now,
    updatedAt: def.updatedAt || now,
    expiresAt: def.expiresAt === undefined ? importanceExpiry(importance, now) : def.expiresAt,
    metadata: isPlainObject(def.metadata) ? { ...def.metadata } : {},
    tags: Array.isArray(def.tags) ? [...new Set(def.tags.map(String))] : [],
  };
  entry.key = scopeKey(entry.scope, entry.scopeId);
  return entry;
}

function updateMemoryEntry(entry, patch = {}) {
  const merged = {
    ...entry,
    ...patch,
    id: entry.id,
    scope: patch.scope !== undefined ? patch.scope : entry.scope,
    scopeId: patch.scopeId !== undefined ? patch.scopeId : entry.scopeId,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
    metadata: { ...entry.metadata, ...(isPlainObject(patch.metadata) ? patch.metadata : {}) },
  };
  return validateMemoryEntry(merged);
}

module.exports = { TYPES, MAX_CONTENT_CHARS, newMemoryId, validateMemoryEntry, normalizeMemoryEntry, updateMemoryEntry, textOf, IMPORTANCE };
