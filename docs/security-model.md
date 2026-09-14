# Security model (Phase 4)

This document covers the trust boundaries Phase 4 adds. For the pre-existing
surface — Electron settings, context isolation, IPC, path guards — see
[security.md](security.md).

## The one rule

> **An agent cannot grant itself additional permissions.**

Only three things can increase access:

| Who | How |
| --- | --- |
| the platform | registers a policy with `source: 'system'` at wiring time |
| a person | registers a policy with `source: 'human'`, or approves a gated call |
| the host | injects a capability (a spawner, a transport, a credential) at construction |

There is no API for anything else, and three specific places enforce it:

1. `PolicyManager.register()` requires an explicit source and refuses anything
   that is not `system` or `human`.
2. `AgentRouter` cannot be talked into a candidate: a policy `deny` makes a pair
   ineligible before ranking, so no score can override it.
3. `SandboxManager.create()` evaluates `sandbox.create` first, and limits clamp
   against a ceiling — a caller asks for less, never more.

## Audit by area

| Area | Boundary |
| --- | --- |
| Agent isolation | agents never share a workspace implicitly; every run gets its own sandbox |
| Harness execution | core never spawns; the host injects `spawn`/`transport` explicitly |
| Workspace boundaries | the sandbox root is the only root, checked lexically and through symlinks |
| Policy bypass | the tool gate consults policy *first*; a denial is final and not overridable in the UI |
| Path traversal | `resolveWithin` + `realContains` on every sandbox path and every filesystem tool |
| Command injection | manifest commands reject shell metacharacters; policy patterns are not compiled to RegExp; the command policy screens `terminal:run` |
| Environment | `minimal` by default; a manifest may not declare an `env` block |
| Credential exposure | only *names* flow through the platform, gated by `credential.**` approval; values are the host's |
| IPC | every channel is whitelisted in `security/ipc-guard.js` and validated before a subsystem sees it |
| Artifact access | artifacts are data with provenance; content is fetched per id, and nothing in an artifact is executed |
| Cross-agent delegation | `containment()` refuses any widening at construction |
| Cross-agent permissions | a child inherits its parent's ceiling and can only narrow it |
| Sandbox escape | stated honestly: the shipped backend is `advisory`, not kernel isolation (see below) |
| Process cleanup | every handle is owned; `killAll`/`cleanup` are idempotent and reachable from cancel, recovery and shutdown |
| Network access | `deny` by default; wider modes are declared unsupported by the advisory backend |

## Honest limits

Three claims this platform does *not* make:

1. **The advisory sandbox is not isolation.** It enforces paths, ownership,
   timeouts and environment in process. Code running in an escaped context is
   not confined by a boundary it cannot cross, and the snapshot says
   `enforcement: 'advisory'` so nothing downstream can forget that.
2. **Code execution is off by default.** `CodeExecutor` is constructed with no
   engines; the `js` engine runs in a disposable child process with a scrubbed
   environment and a parent-enforced timeout, which raises the bar but is not a
   capability sandbox.
3. **Locks are cooperative.** The file locks protect agents that go through the
   coordinator. They are a coordination protocol, not an OS guarantee.

## What a hostile agent could try, and what happens

| Attempt | Result |
| --- | --- |
| Ask for `destructive` permissions in a delegation | refused by `containment()` with the dimension that widened |
| Ask for a path outside the parent's scope | refused by `containment()` |
| Register a policy that allows itself more | refused: `source` must be `system` or `human` |
| Select a backend the policy denies | ineligible before ranking; the decision reports the policy id |
| Ask for more memory than the ceiling | clamped down, and the trim is recorded in `clampNotes` |
| Spawn outside the workspace | refused before the process exists |
| Reach a credential by declaring it in a manifest | only the name is granted, and only with policy approval |
| Put a prompt or a transcript in a message | dropped: payload keys are whitelisted, and `send()` refuses a bare string |
| Read tool inputs out of the policy audit | tool inputs are never placed in the policy context |
| Leave a process behind after cancelling | `cancelTask` stops delegations, harness runs and sandboxes; `cleanup` is idempotent |
| Write the same file as a parallel sibling | the second is `blocked` and never starts |

## Secret handling

- The logger redacts secret-shaped keys at every depth (`logging/logger.js`).
- Harness manifests name secrets in `secretEnv`; `environmentPolicy.allowlist`
  refuses credential-shaped entries outright.
- `HarnessManager.resolveEnvironment()` returns granted *names*; the host
  injects the values.
- Tool inputs are excluded from policy contexts, so command strings and file
  contents cannot reach the audit ring.
- The repository itself is checked for credential-shaped strings on every test
  run (`tests/repo-shape.test.mjs`).

## Fail-closed points

These default to refusal, and each is verified by a test:

| Situation | Result |
| --- | --- |
| A policy requires approval and no approver is wired | denied |
| The approver returns false | denied |
| The approver throws | denied, with the failure named |
| A locked-down install has no matching policy | denied |
| A sandbox backend cannot provide a required feature | `satisfied: false`, no silent downgrade |
| An external harness has no runner wired | the run fails with the reason |
| A tool call needs authorization and no host callback is wired | denied (unchanged from before Phase 4) |

## Reporting

Security-relevant decisions are all observable: `policy.denied`,
`policy.approval_required`, `sandbox.failed`, `harness.failed`,
`session.failed`. `policy.audit()` and `policy.explain()` answer "why was this
blocked?" without needing the log file, and every event carries the ids needed
to join it back to a task, a session and an agent.
