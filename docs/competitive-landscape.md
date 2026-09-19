# Competitive landscape: Orca and Munder Difflin

KingAgent, Orca (stablyai/orca) and Munder Difflin (chaitanyagiri/munder-difflin)
all solve the same problem — run several coding-agent CLIs from one desktop
UI — with different bets on what matters most. This is a research note for
the backlog, not a commitment to build any of it.

## Feature comparison

| Capability | KingAgent | Orca | Munder Difflin |
| --- | --- | --- | --- |
| Wraps existing agent CLIs (Claude Code, Codex, …) | yes | yes | yes (12 CLIs) |
| Parallel panes/worktrees | yes (panes, one workspace folder) | yes (isolated git worktrees per agent) | yes (office-floor metaphor) |
| Mobile companion | no | yes (iOS/Android) | no |
| Cross-agent memory / recall | no | no | yes (markdown + semantic index) |
| Session persists past app close | no (killed on quit, deliberately) | no evidence in README | no evidence in README |
| Human approval / spend gates | yes (policy engine, approvals) | not documented | yes (approval gates, circuit breaker) |
| Visual diff/annotation review | no | yes (AI diff annotation) | no |
| Built-in IDE (editor, git diff) | no (terminal panes only) | no (terminal-first) | yes (Monaco + git) |
| Remote/SSH execution | no | yes (SSH worktrees) | no |
| Native PR/issue-tracker integration | no | yes (GitHub PRs, Linear) | no |

## What is worth tracking, and why it isn't committed work

- **Worktree-per-agent comparison** (Orca) — running the same task through two
  agents in separate git worktrees and diffing the results is a strong
  feature for "which agent handles this better," but it's a genuinely
  different session model from KingAgent's one-workspace-folder design and
  would need its own design pass, not a bolt-on.
- **Semantic memory recall across sessions** (Munder Difflin) — KingAgent
  already has a `core/memory` subsystem; whether it should grow a
  cross-session semantic index the way Munder Difflin's does is a real
  question, but it changes what memory is for (session continuity vs.
  cross-project recall) and deserves its own design doc.
- **Mobile companion** (Orca) — no counterpart in KingAgent's architecture
  today (Electron desktop only); a real mobile app is a multi-month
  commitment, not a feature toggle.

## What KingAgent already does that neither of them documents

Policy-gated approvals, a sandboxed skill ecosystem with security scanning,
and an explicit refusal to auto-retry a paid external agent on failure (see
`src/core/harness-orchestrator/orchestrator.js`) are not things Orca's or
Munder Difflin's READMEs claim. Worth keeping in mind before assuming "more
features" is the same as "better" — KingAgent's bet is on governance and
safety around agents that can spend money and touch files, which is a
different axis than either competitor is optimizing for.
