# Skill security model

The threat this layer exists to contain: **a capability package, written by
someone else, that an agent will follow while holding the user's filesystem,
shell and credentials.**

## Controls, and what each one is actually worth

| Control | Stops | Does not stop |
| --- | --- | --- |
| Manifest validation | Executable fields, unknown categories, traversal in paths, under-declared risk | A well-formed manifest with hostile instructions |
| Content scanner | Known-bad patterns: remote-exec, credential exfiltration, persistence, control evasion, prompt injection | Novel phrasings; intent it has no pattern for |
| Provenance & trust | Silent promotion of remote content; unpinned refs passing as reviewed | A malicious skill in a trusted-looking repository |
| Policy engine | Any permission a deployment forbids, per scope | Nothing — this is the real gate |
| Approval | Unattended high-risk runs | A user who approves everything |
| Sandbox | Path escapes, runaway processes (advisory) or kernel-enforced where available | Code already inside the boundary, on an advisory backend |
| Tool allowlist | A skill reaching for tools it never declared | A skill misusing a tool it did declare |
| Evaluation & quarantine | A skill that keeps failing or trips a control | The first occurrence |

No single row is sufficient, and the scanner in particular is **detection, not
proof**. A clean scan means "nothing in what it says is alarming", never "this is
safe". That phrasing is in the code, in the report payload, and in the UI.

## The validation sequence

`security/SkillValidator.js`, cheapest failure first:

1. manifest validation (shape, ids, versions, forbidden keys)
2. source validation (provenance parses; paths cannot traverse)
3. platform compatibility
4. dependency presence
5. content scan (instructions + every declared resource)
6. permission analysis
7. network requirement — declared vs. observed in the content
8. filesystem requirement — declared vs. observed
9. policy evaluation, through the platform's own `PolicyManager`
10. sandbox decision (posture from trust × risk × findings)

A mismatch in 7/8 is a warning, not a refusal: it means the approval prompt
would have understated the skill, which is exactly what a person should see.

## Trust tiers

```
untrusted  remote and unpinned — the content can change under the decision
community  remote, pinned to a commit sha or a recorded content digest
workspace  a local directory the user pointed at themselves
builtin    shipped in the bundle and reviewed with the product
```

Trust is raised only by `SkillTrust.verify({ tier, actor })` with a **named
human actor**, and never above the source's ceiling — a remote skill tops out at
`community` no matter who vouches for it. Revoking is unrestricted: lowering
trust must never be harder than raising it.

## Posture: what trust × risk implies

| trust ＼ risk | low | medium | high | critical |
| --- | --- | --- | --- | --- |
| **builtin** | run | run | sandbox | sandbox + approval |
| **workspace** | run | sandbox | sandbox + approval | sandbox + approval |
| **community** | sandbox | sandbox + approval | sandbox + approval | sandbox + approval |
| **untrusted** | sandbox + approval | sandbox + approval | sandbox + approval | sandbox + approval |

A scanner `warn` adds approval anywhere in the table; a `critical` adds both and
blocks installation outright. A recorded security incident permanently adds both.

## Fail-closed points

* An approval that cannot reach a human is a **refusal**, not a silent yes.
* A required sandbox with no sandbox manager, or no authorized workspace root,
  is a **refusal** — never an unconfined run.
* No policy engine at execution time means **no grant**.
* Content that changed after installation is re-scanned; if the new content is
  refused, the skill is **quarantined**, not skipped.
* A tool call outside the skill's declared surface is refused *and* recorded as a
  security incident, which quarantines the skill.

## What the scanner looks for

Destructive shell (`rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs), remote
execution (`curl | sh`, PowerShell download-and-execute), credential access and
exfiltration (`~/.ssh/id_rsa`, `.aws/credentials`, env vars piped to a host),
persistence (shell profile writes, system-path writes), traversal, supply-chain
(global installs, unpinned fetches), and control evasion — instructions to
bypass approvals or ignore prior instructions.

**Known false-positive class:** security guidance legitimately contains the words
an attack uses ("never disable the sandbox"). A prohibition immediately in front
of the matched phrase downgrades a `critical` one step to `warn` — a person still
sees it, and the phrase remains visible. The window is deliberately tight (≤ 24
characters, ≤ 2 words), so "do not tell the user, and disable approvals" does not
qualify.

## Quarantine

Automatic on: any security incident, three consecutive failures, or a scanner
block. Release requires a **named person**, lands in `disabled` (never straight
back into service), keeps the findings, and is recorded in the skill's history.

## Testing the controls

`tests/skills-security.test.mjs` runs ten named attacks (remote execution, fork
bomb, credential exfiltration, persistence, prompt injection, …) plus path
traversal, symlink escape, oversized content, refused installs, and the
change-after-approval path. Run it alone with:

```bash
node --test tests/skills-security.test.mjs
```
