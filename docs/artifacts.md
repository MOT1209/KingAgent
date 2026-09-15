# Artifacts

Agents exchange structured artifacts instead of arbitrary text whenever
possible. Where a delegation could return "here's what I found: …" for a lead
agent to re-parse, it instead returns an `Artifact` (`src/core/artifacts/`): a
named, typed, owned value with an id a trace can reference and a UI can
render.

## Types (`artifacts/artifact.js`)

```
file · code · report · image · dataset · test-result · build · diff · document
```

Content is either inline (small, structured — capped at `MAX_INLINE_BYTES`,
256 KB) or a `path` reference into the workspace. An artifact store is
metadata plus small payloads, not a blob store; a large output stays on disk
and the artifact points at it.

## Ownership

An artifact belongs to the workspace that produced it, stamped from the
workspace's own identity at creation — never from a caller-supplied field, so
nothing in the payload can claim someone else's ownership. Every read and
every write is checked:

```js
await artifacts.get(id, { workspace: producer });   // ok
await artifacts.get(id, { workspace: stranger });   // throws ArtifactAccessError
await artifacts.share(id, [stranger.workspaceId], { workspace: producer });
await artifacts.get(id, { workspace: stranger });   // ok now — read only
await artifacts.update(id, {...}, { workspace: stranger }); // still throws
```

A denial is `ArtifactAccessError` (`code: 'ARTIFACT_DENIED'`), not an empty
result — the same "denial, never silence" rule memory follows. Sharing
(`share()`) is additive, recorded on the artifact's own
`metadata.sharedWith`, and grants read only; only the producing workspace can
update, delete or share further. `list()` is scoped the same way: it returns
what the asker owns or was shared, never an enumeration of everything.

## Convenience constructors

```js
artifacts.recordDiff(diffRows, { workspace, name });        // ARTIFACT_TYPES.DIFF
artifacts.recordTestResult(result, { workspace, name });    // ARTIFACT_TYPES.TEST_RESULT
```

The orchestrator calls `recordDiff` at the end of every run that changed
files (`workspace.files.diff()` is exactly what `TaskDiff` in the mission
brief describes — one row per changed path, `before`/`after` captured with
the same size ceiling as the workspace's file tracking).

## References vs. content

`artifactRef(artifact)` strips content and returns `{ id, type, name,
workspaceId, taskId, agentId, bytes, digest }` — what travels in a handoff, a
delegation result, or a trace event. Nothing passes a large artifact's
content across a boundary that doesn't need it; a recipient with access asks
for it explicitly via `get()`.

## Persistence

`ArtifactStore` (`artifacts/store.js`) is a thin, bounded wrapper over an
`artifacts` collection (`persistence/collections.js`) — the same swappable
store contract as everything else in Phase 3. Past `maxArtifacts`, the oldest
records are pruned.

## Testing

`tests/core-artifacts.test.mjs` covers validation (name + content-or-path
required, the size ceiling), ownership enforcement for read/write/share/list,
event correlation, and the pure `canReadArtifact`/`canWriteArtifact`
predicates the manager is built on.
