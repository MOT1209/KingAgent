# State, Pause/Resume, and Recovery

Distinct from `core/recovery/recovery.js` (Phase 2), which classifies a
**failed step** and decides retry/replan/ask. `state/recovery.js`
(`StateRecoveryManager`) is the other half: what to do about a task that
**stopped existing** — a deliberate pause, or a process that went away.

## The one rule everything else follows

**Never blindly restart a destructive action.** A snapshot records whether the
last action was mutating and whether an observation ever came back for it. If
the process stopped between "started deleting a file" and "confirmed the
delete happened", recovery does not guess: replaying could do it twice,
skipping could leave it undone, and neither is the platform's call to make
silently.

```js
recovery.decide(snapshot);
// endedMidMutation(snapshot) → { action: 'ask', reason: 'stopped during a
//   mutating action (delete_file on x.js) with no recorded outcome' }
```

## AgentStateSnapshot (`state/snapshot.js`)

A snapshot is references, not contents: memory ids, context packet ids,
artifact ids — never the memories, packets or artifacts themselves, each of
which lives in its own store with its own permissions. That is what keeps a
snapshot small enough to write on every step and what means a leaked
snapshot would still not be a way to read anything.

```
version, identity (agent/task/workspace/project/session/trace),
status, agentState, currentStep, completedSteps, activeTools,
memoryRefs, contextRefs, artifactRefs, pendingApprovals,
lastObservation (bounded summary), lastAction (bounded summary, incl. `mutating`),
plan (id/objective/mode/stepCount), reason, updatedAt
```

## Pause / Resume

```js
await recovery.pause({ workspace, task, currentStep, lastAction, lastObservation });
// → captures a snapshot, suspends the workspace. In-flight tool calls are
//   never aborted mid-write — pausing stops *new* work, not work already
//   committed to.

const result = await recovery.resume(taskId);
// → restores the workspace (live if present, else revived from the
//   `workspaces` collection), sweeps expired approvals, decides what's safe,
//   and returns { ok, action, workspace, resumeStep, contextRefs, memoryRefs,
//   artifactRefs, pendingApprovals } — a plan, not a re-execution. The
//   orchestrator/runtime acts on it.
```

## Crash recovery

```js
await recovery.listInterrupted();
// every task whose latest snapshot says it never reached a terminal state,
// each with its decision already computed — what the app offers a user (or
// acts on automatically) after a restart.
```

`AgentStateStore` (`state/store.js`) keeps the most recent `keepPerTask`
snapshots per task (default 10) plus, always, the latest — bounded history,
not an unbounded log.

## Decision table

| Situation | Action |
| --- | --- |
| Task already reached a terminal status | `discard` |
| Last action was mutating with no recorded observation | `ask` |
| Approvals were outstanding | `ask` |
| Deliberately paused (`status: paused`) | `continue` |
| No step was in flight | `replan` |
| Last action was mutating (and did complete) | `replan` — re-derive against the world as it now is |
| Last action was read-only | `continue` — a repeat costs nothing |

## Testing

`tests/core-state-recovery.test.mjs` covers every row of the decision table,
snapshot bounding, listInterrupted's live+persisted merge, and pause/resume's
effect on workspace status.
