# Sessions

A session is the container a person's work lives in. It outlives the tasks
inside it and ties together the seven things §24 names: user, agents, workspace,
tasks, harnesses, trace and artifacts.

## Session state is not task state

Three lifecycles exist and they are deliberately separate:

| Lifecycle | Question it answers | File |
| --- | --- | --- |
| task | what is this unit of work doing? | `runtime/states.js` |
| harness | is the backend alive? | `harness/lifecycle.js` |
| session | is this working context open, and will it accept work? | `session/lifecycle.js` |

All four combinations are normal: a paused session can contain a running task
(you paused sending, not the work), and a running session can contain a failed
task. Collapsing them would make "pause" ambiguous, which is the bug this
separation prevents.

## States

```
created ──> initializing ──> ready ──┬──> running ──┬──> waiting ──┐
                                     │             ├──> paused ───┤
                                     └──────────────┘             │
                                                                  ▼
                                     stopping ──> stopped / failed / completed
```

- `initializing` is the work a host does before it can accept anything: probing
  the workspace, detecting the chosen backend.
- `ready` is "open, nothing running yet" — what the UI shows between runs.
- `waiting` is the state that carries the most meaning: open and healthy but
  blocked on a human (an approval, a question, a credential). It is not an error
  and it is not idle time.
- `stopped`, `completed` and `failed` are terminal.

`SessionManager.start()` walks the opening edges internally, so a caller that
opens and starts in one move produces the same state history as one that opens,
waits, then starts. Anything else illegal throws instead of being papered over.

## What a session carries

```js
{
  id, label, state, userId,
  agentIds, harnessIds, workspaceId, workspaceRoot, traceId,
  taskIds, artifactIds, sandboxIds,
  approvals, messages, delegations,
  createdAt, startedAt, pausedAt, completedAt, updatedAt, failure
}
```

`taskIds` (200) and `artifactIds` (500) are capped: a session that lives for a
week must not grow without limit in memory.

## Recovery

`SessionManager.recover({ reason })` is the entry point after a restart:

- a session in `initializing` or `ready` becomes `ready`
- a session in `running` or `waiting` becomes **`paused`**

Parking in-flight work rather than resuming it is deliberate: resuming work
nobody is watching is not recovery, it is a surprise. The caller decides whether
to continue, and the reason is recorded.

## Pause, resume, stop

`pause` and `resume` move the session and are idempotent for their own state.
`stop` is terminal and a no-op on an already-terminal session — a finished
session is never turned into a stopped one, so history stays honest.

`WAITING` is reachable from `ready`, `running` and `paused`, and `wait()` records
why.

## Events

`session.created`, `session.started`, `session.paused`, `session.resumed`,
`session.completed`, `session.failed` and `session.stopped`, each carrying
`sessionId`, `workspaceId`, the most recent `taskId`, the first `agentId` and the
most recent `harnessId`.

## The control-center view

`SessionManager.controlView(id)` adds the counts the UI needs (`agentCount`,
`taskCount`, `artifactCount`) on top of the snapshot. Over IPC:
`agent:sessions` (summaries) and `agent:session` (one view).

Snapshots are serializable — no handles, no functions, no class instances — and
clones are independent, so a renderer cannot mutate the manager's state by
holding a view.
