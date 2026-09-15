# Agent Workspace

Every task the orchestrator runs gets exactly one `AgentWorkspace`
(`src/core/workspace/`). It is the execution boundary: a controlled root,
a policy, tracked files, a controlled environment, and the identity every
other Phase 3 record quotes.

```
AgentWorkspace
├── identity   (workspaceId, projectId, taskId, sessionId, agentId, traceId)
├── root / cwd (path-guarded — see resolve())
├── policy     (tools, capabilities, memoryScopes, allowNetwork, allowDestructive)
├── files      (FileContext: reads, creates, modifies, deletes, active/related)
├── environment (an explicit allow-list, never process.env by default)
├── artifactIds / memoryRefs / contextRefs
└── status     (active → suspended → active | closed)
```

## Identity

`workspace/identity.js` mints the six correlation keys once per workspace and
freezes them. `createIdentity()` is used for a top-level run; `childIdentity()`
is used for a delegation — it inherits `projectId`, `sessionId` and `traceId`
from the parent, mints a new `workspaceId`/`taskId`, and records
`parentWorkspaceId`/`parentTaskId`. `identityRefs()` extracts the subset the
`EventBus` and every trace event carry, so a multi-agent run's events can be
filtered by `traceId` (the whole run), `workspaceId` (one agent's part of it),
or walked by `parentEventId` (the delegation tree).

## Containment

`workspace.resolve(rel)` is the only sanctioned way to turn a relative path
into an absolute one inside a workspace. It delegates to
`tools/path-guard.js#assertWithin`, which checks containment lexically *and*
resolves the real path of the deepest existing ancestor so a symlink cannot be
used to escape the root. A path that fails either check throws — it does not
return `null` and let a caller forget to check.

```js
ws.resolve('src/a.js');       // ok, inside root
ws.resolve('../../etc/passwd'); // throws: "escapes the workspace root"
```

This is defense-in-depth alongside `tools/permissions.js` — a workspace not
granting `fs:write` and a root not containing `/etc` are two independent
reasons a write to `/etc/passwd` cannot happen.

## Policy and narrowing

A workspace's `policy` is `{ tools, capabilities, memoryScopes, allowNetwork,
allowDestructive, maxFileBytes }`. `derivePolicy(parentPolicy, requested)` is
the one function that produces a child's policy, and it **only narrows**:

- an array on the parent side and the child side intersects; `null` on either
  side means "unrestricted from that side", so intersecting with an
  unrestricted parent keeps the request as-is, but intersecting with a
  *restricted* parent can only shrink it;
- a boolean flag (`allowNetwork`, `allowDestructive`) the parent does not hold
  cannot be granted by asking for it — the child's value is
  `parent && requested`, so the parent's `false` always wins.

`WorkspaceManager.createChild(parent, opts)` is the only place a delegated
workspace is built, and it always routes through `derivePolicy`. There is no
path from a request payload to a wider policy than the workspace that issued
it.

## File tracking (`workspace/file-context.js`)

Every read, create, modify, delete and rename goes through `workspace.noteFile`,
which also emits a correlated `workspace.file.added` / `.removed` / `.modified`
event (a read does not — it is attention, not a change). `files.diff()`
collapses repeated touches of the same path into one row (create→modify stays
a create; anything→delete becomes a delete), and content over 64 KB per side is
captured by digest + preview rather than duplicated in full — a diff is a
record that something changed, not a second copy of a large file.

## Environment (`workspace/environment.js`)

Nothing is inherited from the host process by default. A workspace's
environment starts from an explicit `base` plus whatever `inherit` names
(`PATH`, `HOME`, …) *and* passes a secret-name filter — `AWS_SECRET_ACCESS_KEY`,
`*_TOKEN`, `*_API_KEY` and similar are refused even when the name is on the
allow-list, unless the host explicitly opts in with `allowSecrets`. The
serialized view (`toJSON()`, what a trace or IPC payload carries) always
redacts secret-shaped names, so a value admitted for a real process spawn
still cannot leak through persistence.

## Lifecycle and recovery

`active → suspended → active | closed`. `WorkspaceManager.suspend/reactivate/close`
own the transition; a closed workspace refuses every method that would do
something (`resolve`, `noteFile`, …) with `"workspace … is closed"`.
`WorkspaceManager.persist()` writes the serializable `toJSON()` view (never
the real environment values) to the `workspaces` collection; `restore()`
revives it **suspended**, with its file history replayed as read-only entries
— restoring a workspace never re-performs an operation. See
[state-recovery.md](./state-recovery.md) for how this feeds pause/resume.

## Testing

`tests/core-workspace.test.mjs` covers identity minting and lineage, path
containment (including a symlink escape), policy narrowing, tool/scope
enforcement, artifact ownership, environment redaction, and manager
persist/restore round-trips.
