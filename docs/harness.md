# The harness layer

A harness is an execution backend: the thing that can actually run an agent's
work. KingAgent's own runtime is one; Claude Code, Codex, OpenCode, Gemini CLI
and any ACP agent are others.

```
Agent            who is working        agents/registry.js      (identity)
  ↓
Harness          what can execute      harness/registry.js     (backend)
  ↓
Model            which model           the harness's own list  (vendor)
```

The two registries stay separate on purpose. An agent is a persona with
capabilities, tools and a permission set; a harness is a backend with a
platform, a lifecycle and a capability list. Merging them would make "swap the
backend" mean "redefine the agent".

## Files

| File | Responsibility |
| --- | --- |
| `harness/manifest.js` | the manifest schema, validation, and the serializable view |
| `harness/capabilities.js` | the capability vocabulary and its normalisation |
| `harness/adapter.js` | the normalized adapter interface — `createHarness()` |
| `harness/lifecycle.js` | harness states and the legal edges between them |
| `harness/registry.js` | register / list / detect / resolve |
| `harness/manager.js` | selection, runs, ownership, environment grants |
| `harness/presets.js` | the built-in manifests |

## The adapter interface

```js
{ id, capabilities, detect(), install(), start(), stop(),
  pause(), resume(), send(), status(), dispose() }
```

Not every backend supports every operation, and the adapter says so rather than
failing deep in a child process:

- an operation the manifest's capability tags do not claim throws
  `HarnessCapabilityError` (`HARNESS_UNSUPPORTED_OPERATION`)
- an operation the host wired no callback for throws
  `HarnessNotWiredError` (`HARNESS_NOT_WIRED`)

Core never spawns a process. A harness wraps three host injections:

| Injection | What it does | In the app | In tests |
| --- | --- | --- | --- |
| `probe` | is this backend present on this machine? | looks for the binary | a fake |
| `installer` | obtain a missing backend | offers the platform install command | a fake |
| `transport` | talk to a running backend | node-pty / the existing terminal | a fake |

That is what keeps the terminal architecture untouched (§22) and the whole layer
unit-testable.

## Capabilities

A manifest declares *tags*; the platform derives `supports*` booleans from them.

```yaml
# a manifest in words
id: claude-code
capabilities: [coding, terminal, files, git, streaming, review, mcp, pause]
```

| Tag | Turns on |
| --- | --- |
| `pause` | `supportsPause`, `supportsResume` |
| `streaming` | `supportsStreaming` |
| `files` | `supportsFiles` |
| `terminal` | `supportsTerminal` |
| `browser` | `supportsBrowser` |
| `mcp` | `supportsMCP` |
| `model_selection` | `supportsModelSelection` |
| `structured_events` | `supportsStructuredEvents` |

An unknown tag is a validation error, not a silent no-op, so a typo cannot make
a backend look more capable than it is.

## Manifest validation

A manifest is inert data. Validation reads strings and arrays, drops every
unknown key, and refuses:

- an `env` block — environment is granted by policy, never declared by a backend
- a credential-shaped `environmentPolicy.allowlist` entry (use `secretEnv`)
- a `command` containing shell metacharacters (`;`, `&`, `|`, backtick, `$`,
  `>`, `<`, newline) — a command is an argv vector, never a shell string
- an unknown type, platform or capability

`secretEnv` names the environment variables a backend reads. Only the *names*
ever reach the platform; values are the host's business and are gated by the
policy engine.

## Lifecycle

```
registered ─┬─> detected ─┬─> starting ─> ready/running ─┬─> paused ─> running
            │             │                             ├─> stopping ─> stopped
            ├─> installable ─> starting                  └─> failed
            └─> failed                                        ↑
                                                             └── disposed
```

`stopped` is deliberately not terminal: restarting a backend after a clean stop
is normal. `installable` means "declared, not present on this machine" — the
state that makes a fresh install honest about what it can and cannot do.

Detection is advice, not a permission: `start()` is reachable straight from
`registered`, because a host that knows its own command should not have to run a
probe before spawning it.

## Registry vs manager

`HarnessRegistry` answers *what exists*: `register`, `unregister`, `get`,
`list`, `detect`, `resolve`. `resolve()` is deterministic — it filters by
platform, capability tags, declared models and lifecycle, then prefers the
backend with the fewest surplus capabilities (the most specific one that can
still do the job) and breaks remaining ties by id. Two identical registries
resolve identically, and the result carries the rejected candidates and why.

`HarnessManager` answers *what is running*: `select`, `start`, `stop`, `pause`,
`resume`, `send`, `stopTask`, `controlView`. Every run records the ownership
chain — `taskId`, `workspaceId`, `agentId`, `harnessId`, `traceId`, `sessionId`,
`sandboxId` — so stop, cancel, cleanup and recovery all reach the same process
tree. When a sandbox manager is wired, the run's process is registered with the
sandbox that owns it.

## Environment

`resolveEnvironment()` is the only place a harness's environment comes from:

| Mode | What the backend sees |
| --- | --- |
| `minimal` (default) | nothing beyond the platform minimum |
| `allowlist` | exactly the keys the manifest names, if the host granted values |
| `inherit` | the host environment — an explicit host opt-in |

Credential names in `secretEnv` are resolved through the policy engine. A name
the policy does not allow is reported as denied and never reaches the backend.

## Adding a backend

1. Write the manifest (id, name, type, platforms, capabilities, command).
2. Wire a `transport` for it on the host.
3. Optionally add `detect` hints and an installer.

Nothing else changes — not the runtime, the planner, memory, context, the
workflow engine or the UI. The backend appears in the registry, in routing, in
the control center and in the trace on the next start.

## The built-in backend

`kingagent-runtime` is registered on every install and is the only backend that
is always present. It is not a special case anywhere: it is a peer in the same
registry, which is what gives a fresh install something to route to and gives
the platform a guaranteed floor.
