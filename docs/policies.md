# Policies

The policy engine is the governance seam. Every sensitive operation asks it, and
the answer is never ambiguous: allowed, denied, or allowed only after a human
approves.

```
Action ──> PolicyManager ──> evaluate ──> permission ──> approval? ──> Sandbox ──> Execute
```

## Files

| File | Responsibility |
| --- | --- |
| `policy/scopes.js` | the scope hierarchy, the effect ladder, the key format |
| `policy/rules.js` | rule shape, action matching, the action vocabulary |
| `policy/evaluator.js` | the pure merge — no I/O, no clock, no approval |
| `policy/policy.js` | the document schema and its provenance rules |
| `policy/manager.js` | registration, evaluation, approval, audit |

## Provenance: policies come from a person or the platform

A policy document can only be registered with a source of `system` or `human`.
There is no `agent` source and no code path that records one:

```js
policy.register(document, { source: 'system' });  // at wiring time
policy.register(document, { source: 'human' });   // from an approval / settings flow
policy.register(document, { source: 'agent' });   // throws POLICY_SOURCE_REQUIRED
```

Registration also requires an explicit source argument — omitting it is an
error, not a default. That is the whole mechanism behind §40's "an agent cannot
grant itself additional permissions": an agent has one move available, which is
to ask a human through the approval flow.

## Scopes

```
global  →  project  →  workspace  →  workflow  →  harness  →  agent  →  task  →  tool
broadest                                                                   narrowest
```

The chain is consulted broadest-first, and both the wildcard form (`agent:*`, a
policy for every agent) and the instance form (`agent:coder`) are included —
the specific one later, so it wins ties.

```js
scopeChain({ workspaceId: '/ws', agentId: 'coder', toolId: 'fs:read' })
// ['global:*', 'workspace:*', 'workspace:/ws', 'agent:*', 'agent:coder',
//  'tool:*', 'tool:fs:read']
```

## Effects and the merge rule

```
allow  <  approval  <  deny
```

**The most restrictive matching effect wins.** Ties are attributed to the most
specific scope, and within a scope to the later rule (documents are read
top-to-bottom, like a firewall). A weaker rule that merely matched alongside the
winner is never named as the decider — otherwise a narrow `allow` would take
credit for a broad `deny`.

A narrower policy therefore cannot loosen a broader one. A workspace policy can
add a gate its project policy did not have; it cannot remove one.

## Rules

```js
{ id, action, effect, reason, constraints }
```

Action patterns are matched by a hand-written segment walker, not a RegExp built
from a policy string (a policy is exactly the input an attacker would like to
turn into a regex):

| Pattern | Matches |
| --- | --- |
| `git.push` | exactly `git.push` |
| `git.*` | `git.push`, `git.status` — one segment, not a prefix |
| `filesystem.**` | `filesystem.read`, `filesystem.read.deep` |
| `**` | everything |

Actions are dotted lowercase strings: `filesystem.read`, `git.push`,
`tool.call.fs:read`, `sandbox.create`, `agent.run`, `agent.delegate`,
`credential.ANTHROPIC_API_KEY`. A tool may declare the action it presents as
(`policyAction`), so `git:push` can be addressed as `git.push`; the tool names
its action, the policy still decides it.

**Write the rule against the action the tool actually declares.** A tool with no
`policyAction` falls back to `tool.call.<id>`, but one that declares its own is
gated on *that* string and nothing else — a rule written against the fallback
will never match, and the tool will keep running as though no policy existed.
The declared action is part of `toolManager.list()` (and therefore of
`agent:listTools`), so it is answerable from the same data a policy UI already
reads. Two built-ins differ from the fallback:

| Tool | Action a policy must target |
| --- | --- |
| `terminal:run` | `command.run` |
| `fs:delete` | `filesystem.delete` |

`tests/phase5-security.test.mjs` asserts that the listed action and the gated
action agree for every registered tool, so a tool cannot gain a hidden action
again.

## The decision

```js
{
  allowed, requiresApproval, effect, reason,
  policyId, scope, scopeId, ruleId,
  constraints, matched, trail: [...]
}
```

Every field is always present. `trail` lists the matching rules in chain order
with their reasons — it is the answer to §38's "why was this allowed / blocked /
gated?", not a debugging extra.

## Approval

An `approval` effect asks the injected approver:

```js
policy.setApprover(async ({ action, decision, context }) => true|false);
```

Fail-closed in every direction:

- no approver wired → **denied**, with the reason saying no approver exists
- approver returns false → denied
- approver throws → denied, with the failure named

`evaluate({ action, askApproval: false })` reports the gate honestly without
asking: `allowed: false`, `requiresApproval: true`. That is the mode the tool
gate uses, because the human loop for a destructive tool call already exists and
must not be prompted twice.

`enforce()` is the same evaluation that throws `PolicyDeniedError` or
`PolicyApprovalRequiredError` instead of returning, for call sites that must not
be able to forget the check.

## Defaults

| Install | Default effect | Behaviour |
| --- | --- | --- |
| normal | `allow` | unchanged from before Phase 4; the existing permission gates still apply underneath |
| locked down | `deny` | nothing happens without a policy that says it may |

`createClosedPolicyManager()` is the locked-down variant, useful in tests that
have to prove the gate is real.

The baseline documents loaded on every install are a *restriction* layer: they
gate credentials, network access and deletes behind approval, and deny
privilege grants outright. Because the merge is most-restrictive-wins, a host
policy can only ever tighten them.

## Research actions (Phase 7)

`src/core/research/policies/researchPolicy.js` adds a `research.*` action
family to this engine. It contributes names and a baseline document; it
contains no evaluation logic and there is no second engine.

| Action | Baseline |
| --- | --- |
| `research.start`, `research.plan` | allow — planning does not leave the machine |
| `research.source.file`, `research.source.local` | allow — files already in the workspace |
| `research.memory.write` | allow — scoped by the memory policy underneath |
| `research.search`, `research.fetch`, `research.source.{web,news,academic,github,documentation,discussion}` | approval (`allow` when `research.allowNetworkedSources` is set) |
| `research.source.mcp` | approval, always — an MCP server is third-party code |
| `research.browser` | approval, always — browser automation acts as the user |

Two consequences fall out of the rules above rather than being special cases:

- A networked source is evaluated **twice** — on its own action and on the
  existing `network.request` — and the stricter answer wins. Setting
  `allowNetworkedSources` does not bypass the network gate.
- With no approver wired, an approval gate is a denial, so a fresh install does
  no outbound research unattended.

`evaluateSource(policyManager, { type })` is the two-gate call; with no policy
manager at all it fails closed for anything networked.

## The tool bridge

Phase 4 sits in front of the existing tool gate rather than replacing it:

```js
authorize({ agent, tool, input, taskId }) {
  decision = policy.evaluate({ action: actionForTool(tool), askApproval: false });
  if (decision.effect === 'deny') return false;      // policy denies: final
  if (!hostAuthorize) return false;                  // unchanged: nothing unattended
  return hostAuthorize({ agent, tool, input, taskId, policy: decision }) === true;
}
```

A policy `deny` is never overridable by a human click; a policy `allow` does not
skip the existing per-call approval for destructive tools.

Tool inputs are deliberately kept out of the policy context, so file contents
and command strings cannot end up in the audit ring.

## Audit

Every evaluation lands in a bounded ring (200 entries) with its decision and
correlation refs, and streams `policy.evaluated` / `policy.denied` /
`policy.approval_required`. The policy UI reads:

- `policy.audit({ limit, action })` — the most recent decisions
- `policy.explain({ action, context })` — a full re-evaluation with the chain,
  the trail and the constraints, without recording anything
