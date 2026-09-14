# Delegation

A delegation is one agent handing a scoped piece of work to another. It is the
one place in the platform where one agent's reach could grow into another's, so
the contract is explicit and the check happens at construction, not at
execution.

## The record

| Field | Why it exists |
| --- | --- |
| `id` | the delegation's own identity in the trace |
| `role` | lead / worker / reviewer / research / tester |
| `parentTaskId` | the task every event in this subtree hangs off |
| `parentDelegationId` | the edge that makes `tree()` and `cancel()` recursive |
| `parentAgentId` | who is responsible |
| `childAgentId` | who is doing it |
| `workspaceId` | which authorized workspace the child may touch |
| `harnessId` | which backend runs it (may differ from the parent's) |
| `objective` | the work, in one line |
| `permissions` | the effective permission set — never wider than the parent's |
| `scope.paths` | the files the child may write (also what the locks cover) |
| `scope.tools` | the tool subset, when the parent narrowed it |
| `timeoutMs` | when the child is out of time |
| `resultSchema` | what a RESULT is expected to contain |
| `traceId`, `sessionId` | correlation into the run and the session |
| `depth` | how deep in the tree; capped at 4 |

A delegation has to be readable on its own — without the parent's context —
because that is what makes it auditable after the fact.

## Status

```
pending ──> running ──┬──> completed
                      ├──> failed ──> running (retry) | cancelled
                      └──> cancelled
```

Reporting a delegation as completed while it is still `pending` is allowed — it
ran without anyone announcing it — and walks the legal edge. Reporting the same
terminal state twice is idempotent and posts nothing; reporting a *different*
terminal state (`cancelled` → `completed`) is a contradiction and throws.

## The containment check

```js
containment(parent, child) // { ok, reasons, compared }
```

The comparison, dimension by dimension:

```
child.permission levels  ⊆  parent.permission levels
child.allowDestructive   →  parent.allowDestructive
child.scope.paths        ⊆  parent.scope.paths      (when the parent declared any)
child.scope.tools        ⊆  parent.scope.tools      (when the parent declared any)
```

A refusal names the dimension, not just "denied":

```
child grants "moderate" but the parent grants at most "safe"
child scope path "/ws/secrets" is outside the parent scope
```

When neither side declares a permission set, `compared` is `false` and the check
passes: pretending to contain something that was never declared would be worse
than saying so. The policy engine is still the gate for every actual call.

## Inherited authority

A child starts from its parent's permission set unless a *narrower* one is asked
for, so the default is never an escalation. The parent's ceiling is the child's
ceiling, always.

## Two more gates

1. **Policy.** `agent.delegate` is evaluated with the parent, child, task,
   session and workspace ids in context. A `deny` refuses the delegation with the
   policy's reason.
2. **Depth.** Deeper than 4 is refused. A delegation tree that can grow without
   bound is a runaway, not a team.

## Locks

`scope.paths` is not decorative: `runParallel` takes a write lock on every path
it names. Two children claiming the same file means the second is reported
`blocked` and does not start. A child that wants to read a shared file takes no
lock unless the caller asks for `mode: 'read'`, in which case readers share.

## Cancellation

```
cancel(delegationId)      subtree, children first; releases its own locks
cancelTask(taskId)        every delegation in the task, then harness runs and sandboxes
```

Only `cancelTask` stops execution resources, so a child cancelling its own
subtree cannot tear down a sibling's processes. Both are idempotent.

## Reporting

Ending a delegation always posts a message: `RESULT` on success (with a summary
and the artifact ids) or `ERROR` on failure, from the child to the parent, with
every correlation id inherited. A result that is only visible to whoever held
the object is not a protocol.

## Related

- [multi-agent.md](multi-agent.md) — the coordinator around it
- [policies.md](policies.md) — `agent.delegate`
- [sandbox.md](sandbox.md) — the workspace a child inherits
