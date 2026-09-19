// background-sessions.js — the opt-in "detach instead of kill" registry
// behind the herdr-inspired persistent-session feature. Pure logic, IO
// injected, same convention as session-registry.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  recordDetach, removeRecord, listBackgroundSessions, readAll, registryFile,
} from '../src/main/background-sessions.js';

function memoryIo(initial = null) {
  let store = initial;
  return {
    read: (_f) => { if (store === null) throw new Error('ENOENT'); return store; },
    write: (f, text) => { store = text; },
    _dump: () => store,
  };
}

test('registryFile lives under the given userData directory', () => {
  assert.equal(registryFile('/tmp/udata'), path.join('/tmp/udata', 'background-sessions.json'));
});

test('readAll returns an empty array when nothing was ever written', () => {
  const io = memoryIo();
  assert.deepEqual(readAll(io, '/u'), []);
});

test('readAll returns an empty array on corrupt JSON rather than throwing', () => {
  const io = memoryIo('{not json');
  assert.deepEqual(readAll(io, '/u'), []);
});

test('recordDetach requires an id and an integer pid', () => {
  const io = memoryIo();
  assert.throws(() => recordDetach(io, '/u', { pid: 1 }), /requires a session id/);
  assert.throws(() => recordDetach(io, '/u', { id: 'a', pid: 'not-a-number' }), /requires an integer pid/);
});

test('recordDetach writes a normalized record and readAll reads it back', () => {
  const io = memoryIo();
  const saved = recordDetach(io, '/u', {
    id: 'p1', pid: 4242, name: 'fix the bug', cwd: '/proj', kind: 'claude',
    program: '/usr/bin/claude', args: ['--resume', 'x'], detachedAt: 1000,
  });
  assert.equal(saved.id, 'p1');
  assert.equal(saved.pid, 4242);
  assert.deepEqual(readAll(io, '/u'), [saved]);
});

test('recordDetach replaces an existing record for the same id rather than duplicating it', () => {
  const io = memoryIo();
  recordDetach(io, '/u', { id: 'p1', pid: 1 });
  recordDetach(io, '/u', { id: 'p1', pid: 2 });
  const all = readAll(io, '/u');
  assert.equal(all.length, 1);
  assert.equal(all[0].pid, 2);
});

test('recordDetach never trusts unknown or wrongly-typed fields into the stored record', () => {
  const io = memoryIo();
  const saved = recordDetach(io, '/u', { id: 'p1', pid: 1, args: 'not-an-array', evil: 'dropped', name: 42 });
  assert.deepEqual(saved.args, []);
  assert.equal(saved.name, '');
  assert.equal(saved.evil, undefined);
});

test('removeRecord deletes one record and reports whether anything was removed', () => {
  const io = memoryIo();
  recordDetach(io, '/u', { id: 'p1', pid: 1 });
  recordDetach(io, '/u', { id: 'p2', pid: 2 });
  assert.equal(removeRecord(io, '/u', 'p1'), true);
  assert.deepEqual(readAll(io, '/u').map((r) => r.id), ['p2']);
  assert.equal(removeRecord(io, '/u', 'ghost'), false);
});

test('listBackgroundSessions reports liveness per record using the injected check', () => {
  const io = memoryIo();
  recordDetach(io, '/u', { id: 'alive', pid: 111 });
  recordDetach(io, '/u', { id: 'dead', pid: 222 });
  const isAlive = (pid) => pid === 111;
  const list = listBackgroundSessions(io, '/u', { isAlive });
  assert.deepEqual(list.map((r) => [r.id, r.alive]).sort(), [['alive', true], ['dead', false]]);
});

test('listBackgroundSessions never removes a dead record by itself — forgetting is a separate, explicit act', () => {
  const io = memoryIo();
  recordDetach(io, '/u', { id: 'p1', pid: 1 });
  listBackgroundSessions(io, '/u', { isAlive: () => false });
  assert.equal(readAll(io, '/u').length, 1);
});
