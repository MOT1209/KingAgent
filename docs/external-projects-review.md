# External projects review

A user asked to "merge" ten unrelated GitHub projects into KingAgent. This
document records what was actually done with each one and why, so the
research isn't silently re-litigated later. See also `CHANGELOG.md` for the
shipped changes.

None of these are a literal code merge — the ten projects span Rust,
TypeScript/Node, Python and shell/Lua, with product domains ranging from a
Linux distro to video production. What follows is either a real, working
integration built in KingAgent's own idiom, a documented "not now" with a
concrete reason, or a competitive note for the backlog.

## Integrated

- **mattpocock/skills** (MIT) — two skills, `domain-modeling` and
  `diagnosis-loop`, adapted (not copied verbatim) into
  `src/core/skills/builtin/catalog.js`. They fill taxonomy categories
  KingAgent's own builtin skills didn't cover; both attribute the source and
  are validated by the existing skill manifest/security pipeline like any
  other builtin.
- **tt-a1i/archify** (MIT) — not vendored (its Rust-adjacent Node build and
  multi-diagram-type IR/validation pipeline is a project of its own, not a
  dependency for one tool), but its core idea — a typed graph compiled to a
  portable, self-contained HTML artifact — is implemented clean-room as the
  `diagram:generate` tool (`src/core/tools/builtin/diagram-generate.js`):
  layered left-to-right layout, inline SVG, no new dependency.
- **firecrawl/anydoc** — same call: its Rust core has no compatible Node
  package (the "anydoc" name on npm is an unrelated project — checked via
  `npm view anydoc repository.url`, which points at a different repo
  entirely). Implemented the useful subset — `.docx`, `.csv`/`.tsv`,
  `.txt`/`.md`/`.json` to Markdown — as the `doc:convert` tool, including a
  from-scratch minimal ZIP reader (`zip-reader.js`) since `.docx` is a ZIP of
  XML. PDF and legacy `.doc`/`.xls`/`.ppt` are explicitly refused by name
  rather than faked; they need a real stream/OLE parser, which is future work
  if it's ever prioritized.
- **diegosouzapw/OmniRoute** — checked first whether KingAgent has any direct
  model-API call surface a "gateway" could sit in front of: it does not.
  KingAgent deliberately never calls a model provider itself — every agent
  runs as an external CLI harness (Claude Code, Codex, …) that brings its own
  subscription. So OmniRoute's actual product (a provider-facing HTTP
  gateway) has no integration point here, and `src/core/harness-orchestrator/
  router.js` already implements two of its routing ideas (`cost_aware`,
  `performance_aware`). The one real gap — an explicit ordered preference
  list, OmniRoute's "priority" strategy — was added as a new `priority`
  routing strategy (`agent.metadata.harnessPriority`). What OmniRoute does
  that KingAgent intentionally does not do: automatically retry a *different*
  paid harness after a failure. `orchestrator.js` already documents why not —
  "a retry there can cost real money and needs the same reasoning a plan
  does" — so that part of OmniRoute's design was not adopted, on purpose.

## Integrated, scoped down for safety

- **herdrdev/herdr** — its core idea (a session survives closing the thing
  that started it) is real and now partially implemented as an explicit,
  per-session opt-in: `term:set-persistent` marks a session, and
  `killSession` in `src/main/main.js` detaches it instead of killing it at
  tile close, window close or app quit, recording it in
  `background-sessions.json` (`src/main/background-sessions.js`). The
  default for every other session is unchanged — KingAgent still kills what
  it owns on close. Two things were deliberately left out of this pass, and
  are the actual reason herdr is a dedicated Rust binary rather than a small
  patch: (1) no full app-quit-surviving daemon — the detached process is a
  plain orphaned OS process, not owned by anything, so there's no service
  managing it if it needs supervision; (2) no terminal reattachment — a
  "reconnected" pane would need a tmux/screen-style multiplexer to show live
  output again, which is out of scope here. What you get is proof the
  process is alive or that it finished, and a way to end it
  (`background:kill`) or clear its record (`background:forget`). herdr's
  multi-machine/SSH story is not attempted at all.

## Studied, not merged (competitive notes)

- **stablyai/orca**, **chaitanyagiri/munder-difflin** — both occupy the same
  niche KingAgent already does (orchestrate multiple coding-agent CLIs from
  one UI). Orca's worktree-per-agent comparison view and Munder Difflin's
  persistent semantic-recall memory layer are backlog ideas, not committed
  work — see `docs/competitive-landscape.md`.

## Not integrated

- **calesthio/OpenMontage** — a Python/Remotion video-production pipeline.
  Different runtime, different product domain from an agent-desk app; no
  action unless KingAgent ever wants a "video agent" vertical.
- **deepseek-ai/deepseek-harness** — a competing plugin/agent framework
  (Cordis-based). Architecturally redundant with KingAgent's own
  `harness/` + `harness-orchestrator/`; adopting it would mean replacing
  working, tested code with an equivalent for no gain.
- **omacom/omarchy** — a full Linux distribution (DHH). Operates at the OS
  layer; nothing in it applies to a cross-platform Electron app at the code
  level.
