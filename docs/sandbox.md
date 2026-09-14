# Sandboxes

Every execution in Phase 4 happens inside a sandbox: an authorized workspace,
its limits, and the processes that belong to it.

```
SandboxManager
 └── Sandbox                       one authorized workspace
      ├── readPaths / writePaths   narrowing inside the root
      ├── limits                   cpu / memory / processes / time / fs / network / env
      ├── process table            every handle, with its owner
      └── backend                  the isolation mechanism (advisory, planned: job object, …)
```

## Honesty about enforcement

The most important field in a sandbox snapshot is `enforcement`:

| Value | Meaning |
| --- | --- |
| `kernel` | the OS stops a violation (job object, sandbox profile, namespace) |
| `advisory` | *KingAgent* stops it in process — path checks, process ownership, timeouts, cleanup |
| `none` | the host disabled sandboxing; the workspace boundary still applies |

This fork ships one real backend, `advisory`, and declares the kernel-enforced
families as planned. An advisory sandbox is worth having — it is where workspace
restriction, ownership and cleanup live — but calling it isolation would be
false, so the snapshot says `advisory` and the UI shows
`Platform-enforced`, not "secure sandbox".

The advisory backend deliberately does **not** declare `cpu` or `memory` in its
feature list, and `applyLimits()` reports them as unsupported. A caller that
requires a feature no available backend can provide gets
`satisfied: false` with the reason, rather than a sandbox it believes is bounded.

## Workspace boundary

`Sandbox.assertPath(target, mode)` and `pathAllowed()` enforce the boundary with
the same containment logic the tool layer uses — lexical *and* symlink-aware:

- `resolveWithin(root, target)` rejects `../` and absolute escapes
- `realContains()` re-checks the target's real path, so a symlink inside the
  workspace pointing outside it is caught
- `filesystemMode: 'readonly'` refuses writes; `'none'` refuses everything
- `readPaths` / `writePaths` narrow access *inside* the root and never widen it

`Sandbox.spawn({ cwd })` validates the working directory through the same gate
before a process exists, so a spawn outside the workspace is refused, not
detected afterwards.

## Limits

| Limit | Default | Ceiling |
| --- | --- | --- |
| `cpuTimeMs` | none declared | 30 min |
| `memoryMb` | 512 | 4096 |
| `maxProcesses` | 8 | 32 |
| `timeoutMs` | 5 min | 30 min |
| `filesystemMode` | `workspace` | `workspace` |
| `networkMode` | `deny` | `loopback` |
| `environmentPolicy` | `minimal` | `allowlist` |

`clampLimits(requested, ceiling)` is the same "more restrictive wins" rule as the
policy engine, applied to numbers and modes: a caller can ask for less than the
ceiling and never more. A trimmed request is recorded in `clampNotes`, so the UI
can show what was actually granted rather than what was asked for.

`validateLimits()` rejects nonsense (negative memory, unknown modes) instead of
coercing it.

## Process ownership

`registerProcess()` records every handle with the ownership chain from §23 —
`taskId`, `workspaceId`, `agentId`, `harnessId`, `traceId`, `sessionId`,
`sandboxId`, plus the delegation or run it belongs to. `killAll()` walks that
table and is safe to call twice, which matters because cancellation, cleanup and
shutdown all converge there.

The host supplies the spawner (`io.sandbox.spawn`, `kill`, `killTree`). Core
never spawns anything itself, which is what lets the Electron main process wrap
node-pty and the existing terminal instead of replacing them (§22).

## Backends

| Backend | Platforms | Enforcement | Implemented |
| --- | --- | --- | --- |
| `advisory` | all | advisory | yes |
| `windows-job-object` | windows | planned — advisory until wired | no |
| `macos-sandbox` | macos | planned | no |
| `linux-namespaces` | linux | planned — kernel | no |
| `remote` | all | planned — kernel | no |
| `none` | all | none | yes (explicit opt-out) |

`selectBackend({ platform, required })` returns the best available backend and
the reasons the others were rejected. A host can inject its own backend with
`io.sandbox.backend`, or a factory with `backendFactory`, without any other
module changing.

## Snapshots

`Sandbox.snapshot()` — the §39 panel — contains only values the sandbox actually
knows:

```js
{
  label: 'Workspace Restricted',
  enforcement: 'advisory', enforcementLabel: 'Platform-enforced',
  filesystem: { mode: 'workspace', label: 'Workspace only' },
  network: { mode: 'deny', label: 'Restricted' },
  processes: { count: 2, limit: 8 },
  memoryMb: { limit: 512, used: null },   // never fabricated
  cpuTimeMs: { limit: null, used: null },
  ownership: { taskId, workspaceId, agentId, harnessId, sessionId, traceId },
  processList: [...],
  clampNotes: [...]
}
```

`used` is `null` wherever the backend cannot observe usage. A UI that shows an
invented "1.4 GB / 4 GB" is worse than one that shows the limit and says usage
is unavailable.

## Lifecycle and events

```
created ─> started ─> stopping ─> stopped
                └──> failed
```

`sandbox.created`, `sandbox.started`, `sandbox.stopped`, `sandbox.failed` and
`sandbox.process.registered` all carry `sandboxId`, `taskId`, `agentId`,
`harnessId`, `sessionId` and `workspaceId`, so the trace can join them to the
work they belonged to.

`SandboxManager.cleanup()` kills everything in every sandbox and is safe at any
time, including twice. It is what recovery and shutdown call.

## Creation is gated

`SandboxManager.create()` evaluates `sandbox.create` against the policy engine
first. A denial throws before a sandbox exists. The orchestrator never runs work
without one, and a sandbox cannot be created without an explicit workspace root.
