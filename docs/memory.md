# Memory

Memory is scoped, importance-scored, and searched — never dumped and never
written automatically. The `MemoryManager` (`src/core/memory/manager.js`) is
the only door in or out; a `MemoryProvider` behind it owns nothing but bytes.

## Scopes (`memory/scopes.js`)

```
global · project · workspace · agent · task · session · workflow
```

`global` is shared by grant alone. Every other scope is *owned*: a policy
that grants `project` still has to name **which** project (`policy.ids.project`),
and `canAccess(policy, scope, scopeId)` checks both the grant and the owner —
a policy granting `task` for `task-A` cannot read `task-B`'s memory even
though the scope name matches. A denial is an error
(`MemoryAccessError`, `code: 'MEMORY_DENIED'`), never a silent empty result —
an empty result looks exactly like "nothing is remembered" and hides a
misconfigured policy.

`readableKeys(policy)` turns a policy into the exact `(scope, owner)` pairs a
search may touch; `search()` filters to that set before it ranks anything, so
a query cannot walk outside the grant no matter what it asks for.

A workspace's own `memoryPolicy()` (`workspace/workspace.js`) is what most
callers pass: it grants exactly the scopes the workspace's policy lists, with
`taskId`/`sessionId`/`agentId`/`workspaceId`/`projectId` as the owners — so
memory access is narrowed by delegation exactly the way tool access is (see
[workspace.md](./workspace.md)).

## Importance (`memory/importance.js`)

```
critical · high · normal · low · temporary
```

`scoreImportance()` is a deterministic classifier: an instruction or
preference is `critical`; a decision or constraint is `high`; a high-volume,
low-signal observation (a directory listing, a passing check) is `low` or
`temporary`. `PERSIST_THRESHOLD` is `normal` — deliberately above `low`, so
routine tool chatter never becomes a permanent memory by default.

## Candidates: observation → evaluate → candidate → persist

```js
const candidate = memory.candidate({ content, source }, { policy });
// candidate.shouldPersist is advice; nothing is written yet
if (candidate.shouldPersist) await memory.commitCandidate(candidate, { policy });
```

`store()` is the only thing that writes, and a caller has to call it (via
`commitCandidate`, or directly). An observation that scores below
`PERSIST_THRESHOLD` is refused unless the caller passes `force: true` — an
explicit act, not something that happens as a side effect of running a step.

## Relevance (`memory/relevance.js`)

`rank()` scores lexical overlap with the query + tag match, weighted by
importance and decayed by recency (a fortnight half-life), with a small boost
for a scope the caller says it prefers. It is deliberately lexical, not a
vector store — Phase 3 does not add a mandatory embedding dependency. The
scoring function is the seam: a future provider that can rank semantically
supplies its own `score` per entry and everything above it (the manager, the
context packet) is unchanged.

## Summarization (`memory/summarizer.js`)

**Summarizing never deletes.** `summarize()` reads every entry in a scope,
extracts durable facts (a deterministic pass always runs; an AI provider, when
present, can produce a better one — and a provider failure always falls back
to the deterministic result rather than failing the call), and — only if
`persist: true` — stores the summary as a *new* entry that records its
`sources`. The raw entries it summarized are untouched.

## Types (`memory/entry.js`)

`fact · observation · decision · result · preference · instruction ·
constraint · summary`, plus `episodic`/`semantic` declared for a future
retriever — nothing in Phase 3 produces them, and nothing depends on them.

## API

```
store(entry, { policy, refs })
retrieve(id, { policy })
search({ query, tags, scopes, limit }, { policy })
list({ scope, scopeId }, { policy })
update(id, patch, { policy })
delete(id, { policy })
clear({ scope, scopeId }, { policy })
summarize({ scope, persist }, { policy })
candidate(observation, { policy, scope })
commitCandidate(candidate, { policy, force })
```

## Research memory (Phase 7)

`src/core/research/memory/researchMemory.js` is a *policy* over this manager,
not a second store: it decides what a completed research run may offer up and
when it expires, then hands candidates to `store()` like any other caller.

- Only `supported` / `strongly_supported` claims at confidence ≥ 0.6, carrying
  citations, become entries. An unverified claim is not a fact, and storing one
  means the next run treats our own uncertainty as established background.
- `expiresAt` is set from how fast the subject moves. A **realtime** question
  has a zero TTL, so nothing from it is remembered as fact — it would be wrong
  before it was read. `researchRouter` applies the same rule on the way in and
  re-researches rather than serving a stale answer.
- Scope is `project` when the task has one, else `session`. Never `global`.
- Citations travel in the entry's metadata, so a remembered claim can be
  re-cited rather than asserted on trust.
- A memory denial is not a research failure: the answer is already produced,
  and remembering it is a bonus.

## Testing

`tests/core-memory.test.mjs` covers scope isolation (including "same scope
name, different owner"), the observation→candidate→persist pipeline
(including force), relevance ranking, summarization's raw-entry preservation,
and event correlation.
