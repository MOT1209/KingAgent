# The worker image

A worker image is an Upstash snapshot of a Box that has been set up the way every worker should be. New worker Boxes are created from it with `Box.fromSnapshot`. The definition is one file in the factory repo, `worker/setup.sh`, so the image is reviewable and rebuildable.

Skip it when the stock Box is enough. The stock Node image already has Claude Code and Codex, and a plain factory works well without an image.

## What belongs in the image

Slow to install, and rarely changing:

- agent CLIs that the stock image lacks
- agent skills, installed at user level so they apply in every repo
- MCP servers and the packages they need
- a browser tool, for agents that check their own work
- language toolchains and system packages the app repos need

Ask the user what belongs in it, the browser tool included, **before any Box is created**. The image is built first, in one Box, and every other worker is created from it. Deciding afterwards means deleting and recreating the workers.

## Browser access comes from the build Box

Browser access is not something `setup.sh` installs. It is a property of the Box, set when the Box is created (`factory.browser`, default `true`), and **an image passes on the browser access of the Box it was built in**. `Box.fromSnapshot` ignores `browser: true`, so nothing can add it to a worker afterwards. `upstash-box.md` has the details.

In practice:

- Build the image in a Box that `provision-workers.mjs` created as a plain Box with `factory.browser` on. `build-snapshot.mjs` tests this first and refuses to build in a Box without browser access.
- An existing image that was built in a Box without it cannot be repaired. Remove its `snapshotId` from the config, have the user delete the workers, create one plain Box, build again in it, then create the rest.
- `provision-workers.mjs` tests each Box it creates and stops at the first one without browser access, so a bad image costs one Box, not the whole pool.

## One image or several

`build-snapshot.mjs <worker id>` builds an image **for that worker's agent type**. It bakes in the agent type's `boxSettings` (model and effort) and stores the id as `agents.<name>.snapshotId`. An agent type can also name its own setup script with `"setup": "worker/setup-fast.sh"`. Otherwise all types share `worker/setup.sh`.

So a user who wants a Haiku image for quick work and a large-model image for hard work gets two agent types and runs the build twice, once with a worker of each type.

`build-snapshot.mjs <worker id> --shared` builds one image for all agent types and stores it as `factory.snapshotId`. It holds tools only, no model settings. Each new Box still gets its own agent type's `boxSettings` when it is created, so this is the simpler choice when the tools are the same everywhere.

Before building, ask the model and effort question from SKILL.md for the agent type concerned, and show the user the "Defaults baked in" line the script prints.

## What does not belong

- **App code.** The repos change all the time. Each job makes a fresh clone. A clone inside the image would be stale at once, and the time saved is small.
- **Secrets.** They are hard to rotate once baked in, and the factory writes them at the start of each job anyway. The build script deletes known secret paths and scans the disk before it takes the snapshot.
- **Small files the user will keep editing**, such as a global `CLAUDE.md` or `AGENTS.md` with guardrails and workflow rules. If those live in the image, every wording change means a rebuild and recreating every Box. Keep them in the factory repo (for example under `worker/`) and list them as the agent type's `jobFiles`. The factory copies them into the Box at the start of every job: `{ "from": "worker/CLAUDE.md", "to": "/workspace/home/.claude/CLAUDE.md" }` for Claude Code, and `/workspace/home/.codex/AGENTS.md` for Codex.

## Writing `setup.sh`

- It runs as `boxuser` with bash, `set -euo pipefail`. Use `sudo` for system-level installs.
- The Box is ARM64 Debian 12. Check that what you install ships for that platform. Chrome for Testing does not, so use `sudo apt-get install -y chromium` and point tools at `/usr/bin/chromium`.
- Environment variables and `PATH` entries needed at run time go in `/etc/profile.d/<name>.sh`. The agent, the repo's setup commands and its checks all run as bash login shells, so all three see them.
- For Python repos: `sudo apt-get install -y python3-venv python3-pip`. The repo's `setup` then creates and activates a virtualenv.
- Installing skills for several agents at once with the `skills` tool:
  `npx -y skills@latest add <repo url> --skill <name> --global --agent claude-code codex --copy --yes`
  Claude Code's copy lands in `~/.claude/skills`, Codex's in `~/.agents/skills`. A skill that drives a command line tool (such as `agent-browser`) also needs that tool, and whatever the tool needs, in the image.
- MCP servers are registered per agent, at user scope: `claude mcp add --scope user <name> -- <command>` for Claude Code, an `[mcp_servers.<name>]` block in `~/.codex/config.toml` for Codex. Check the current docs of each.
- When two agent types share one MCP server, put its command and flags in one small wrapper script in the image and point both registrations at it, so the two configs cannot drift apart.
- A browser-driving MCP server or tool has to be told which browser to use. There are two, and the first is the better one:
  - **Upstash's Chromium**, which the factory starts before each agent run and which then listens on port 9222 inside the Box. A tool that attaches to it over CDP shows up in the Upstash console, so the user can watch the agent work. For `agent-browser` that is its auto-connect option (`AGENT_BROWSER_AUTO_CONNECT=1`). With auto-connect on and no Chromium running, `agent-browser` fails instead of starting one. So the example in `worker/setup.sh` writes a `/etc/profile.d` script that turns it on only when port 9222 answers. That script runs when the agent's login shell starts, which is after the factory opened the first tab.
  - **A browser installed in the image**, as the fallback. The tool will not find a downloadable Chrome on ARM64. Expect to pass the executable path (`/usr/bin/chromium`), a headless flag, and usually a no-sandbox flag, because the Box is already the sandbox.
  
  Look the option names up in that tool's docs. Only `agent-browser` was tested here.
- Pin versions and switch off self-update for anything you install, so the image stays what was tested.
- End the script with a check section that prints versions and lists what was installed, and fails if something is missing. The build log is the only evidence of what is in the image.

## Building

```bash
node --env-file=.env scripts/provision-workers.mjs <worker id> --yes
```

```bash
node --env-file=.env scripts/build-snapshot.mjs <worker id> --yes
```

The first command gives that one worker a Box to build in. Without `--yes` both print a preview.

The script marks that worker busy, checks that the Box has browser access (unless `factory.browser` is `false`), uploads and runs `setup.sh` in its Box (in the background, polled), writes the agent type's `boxSettings`, removes sign-in files, saved git credentials and old workspaces, scans for secret-looking text, takes the snapshot `<prefix><agent>-base`, writes its id to `agents.<agent>.snapshotId` in the config, and releases the worker. Commit the config change.

It builds inside an existing worker's Box because accounts are often at their Box limit. With a free slot you could build in a fresh Box instead.

## Rolling it out

Build the image before the other workers exist, and nothing has to be deleted: the Box you built in already holds everything, and `provision-workers.mjs --yes` creates the rest from the snapshot.

Boxes that existed before the snapshot do not change. To move those to the image they must be deleted and created again. Deleting is permanent, so the user runs it:

```bash
node --env-file=.env scripts/delete-workers.mjs --yes
```

```bash
node --env-file=.env scripts/provision-workers.mjs --yes
```

Then verify inside one recreated Box per agent type with `scripts/box-exec.mjs`: tool versions, the skills folders, a real action with the tool (for a browser: open a page and read its title), and that no secret is on the disk. A snapshot restore kept everything in the original build, but check rather than assume.

After changing `setup.sh`, build again. Old snapshots are not removed by any script. The SDK lists snapshots per Box only, so the user deletes old ones in the Upstash console once no Box needs them.

## What a first job on the new image should prove

That the agent can actually use what was installed. Write one issue that asks for it, for example "use the frontend-design skill, and when you are done open the page with agent-browser and confirm the toggle works", and read the PR summary afterwards. Claude Code in print mode logs almost nothing besides its reply, so to see whether a tool was really used, look at its transcript in the Box under `~/.claude/projects` (with `scripts/box-exec.mjs`) before the next image build removes it.
