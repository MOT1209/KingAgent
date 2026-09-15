# Human Approval

Phase 2 already gated `DESTRUCTIVE` tools behind a per-call `authorize`
callback (`tools/manager.js`) — a promise the caller had to resolve. That
callback cannot be listed, cannot be audited, and cannot survive a pause. The
`ApprovalManager` (`src/core/approval/`) makes the same decision into a
**record**: listable, resumable, and the single thing both the Phase 2 tool
gate and Phase 3 orchestration converge on.

## The lifecycle

```
requestApproval() → PENDING → approve() | reject() | expire()
```

```js
const { request, decision } = approvals.requestApproval({
  action: 'file.delete', toolId: 'fs:delete', identity, parameters,
});
// request is listable right away:
approvals.getPendingApprovals({ taskId });
// settled from anywhere, by id — an IPC handler, a timeout, a resumed session:
approvals.approve(request.id, { decidedBy: 'user' });
const resolved = await decision; // { status: 'approved', decidedBy, resolvedAt, ... }
```

An unanswered request expires on its own after `ttlMs` (default 5 minutes);
`sweep()` expires everything past its deadline on demand, and is called on
every `resume()` so a task paused across an expired request never believes it
is still waiting. Settling twice is idempotent — the first decision wins.

## Risk and the dangerous-action table (`approval/request.js`)

```
file.delete · file.write.outside-workspace · command.destructive · command.run
git.push · system.modify · package.install · network.external · secret.access
agent.delegate
```

Each maps to a default risk (`low · medium · high · critical`). A policy can
narrow (`allow: [...]`) or widen (`require: [...]`, exhaustive when given) the
set that needs approval; `requiresApproval(action, policy)` is the single
function both the orchestrator and the tool-authorizer call.

## Bridging Phase 2

`approvals.toolAuthorizer({ identity })` returns exactly the
`authorize({ agent, tool, input, taskId })` shape `ToolManager.execute`
already expects. `createPlatform` wires it as the default authorizer, so
every `DESTRUCTIVE`/`requiresAuth` tool call — `fs:delete`, `terminal:run` —
becomes a request in `ApprovalManager` unless the host supplies its own
callback. Nothing about the Phase 2 gate changed; it now has a record behind
it instead of a bare closure.

## Events

```
approval.requested · approval.approved · approval.rejected · approval.expired
```

…plus, on the same decision, the Phase 2 events the renderer already
understands (`approval.required`, `approval.granted`, `approval.denied`) —
one decision, two event vocabularies, so nothing upstream needs to change to
keep working.

## Disposal

`approvals.dispose()` settles every outstanding request as expired and clears
its timers — called from `platform.dispose()` so a pending approval can never
keep a process alive after shutdown.

## Testing

`tests/core-approval.test.mjs` covers the full lifecycle (approve, reject,
expire, idempotent double-settle, sweep), event emission on both
vocabularies, and the `toolAuthorizer` bridge end to end (request appears as
pending → decided → the tool call's promise resolves accordingly).
