# Upstash Box: what the template relies on

Verified against `@upstash/box` 0.7.5 and the docs at the time of writing. Check current docs (Stage 0 in SKILL.md) before relying on anything here. The installed SDK's type definitions, `node_modules/@upstash/box/dist/*.d.ts`, are the quickest way to confirm a signature.

## Where the docs are

- Context7 library id: `/websites/upstash_box`
- Quickstart: https://upstash.com/docs/box/overall/quickstart
- Shell commands: https://upstash.com/docs/box/overall/shell
- Snapshots: https://upstash.com/docs/box/overall/snapshots
- Lifecycle, pause and resume: https://upstash.com/docs/box/overall/how-it-works
- Playwright guide (shows apt working in a Box): https://upstash.com/docs/box/guides/web-scraping-playwright

## SDK calls in use

The SDK reads `UPSTASH_BOX_API_KEY` from the environment.

```js
import { Box } from "@upstash/box"

// Create. `timeout` is the SDK's request timeout in ms (default 600000).
// `browser: true` is the only way a Box ever gets browser access.
const box = await Box.create({ name, labels: ["factory"], runtime: "node", browser: true, timeout })

// Find again later, from any process
const boxes = await Box.list({ label: "factory" })   // BoxData[]: id, name, labels, status
const same = await Box.get(box.id, { timeout })
const byName = await Box.getByName(name)

// Run a command. Resolves when the command ends.
const run = await box.exec.command("echo hello")     // run.result, run.status, run.exitCode

// Files
await box.files.write({ path: "/workspace/home/file.txt", content: "text" })
const text = await box.files.read("/workspace/home/file.txt")

// Labels: the factory's shared state
await box.labels.add("busy")       // returns the updated list
await box.labels.remove("busy")
await box.labels.list()

// Lifecycle
await box.pause()                  // no active CPU charges, disk kept
await box.resume()
await box.delete()                 // permanent
await Box.delete({ boxIds: [id1, id2] })

// Snapshots
const snap = await box.snapshot({ name: "worker-base" })     // snap.id
const fresh = await Box.fromSnapshot(snap.id, { name, labels, runtime: "node" })   // `browser` is ignored here
await box.listSnapshots()          // snapshots taken from THIS Box. There is no account-wide list in the SDK
await Box.deleteSnapshots({ snapshotIds: [snap.id] })

// Browser. Both need a Box with browser access
await box.browser.listTabs()                    // does not start Chromium. The factory's "has it got a browser" test
await box.browser.tab.create("about:blank")     // starts Chromium. The factory does this before each agent run
```

Box statuses: `creating`, `idle`, `running`, `paused`, `error`, `deleted`. Pause and resume are not available when a Box is created with `keepAlive`.

The template's `sh()` helper in `src/box.mjs` wraps `exec.command`: it appends `echo "__EXIT__$?"`, parses the exit code from the output, and throws on failure unless told otherwise. Use it rather than `exec.command` directly, so failures are never silent. It runs in plain `sh` and holds one HTTP request open, so it is for short commands only.

`runScript()` is for everything else: the agent, repo setup, checks and the image build. It writes a bash script into the Box, starts it with `nohup` as a login shell, and polls an exit-code file every ten seconds. A `#STEP name` line in the script body marks a step, and the last step that started is reported back, which is how a failing check is named.

Not used, on purpose: `box.agent.run` and the `agent`, `skills` and `mcpServers` options of `Box.create`. Those configure Upstash's built-in agent runner, which takes provider API keys. The factory runs agent CLIs itself (see `agents.md`). `box.git.*` is also not used, so that the factory controls exactly how the token is handled.

## Browser access

On by default in the template (`factory.browser`). Found the hard way in a real factory, where the first ten workers had to be deleted:

- **It is decided when a Box is created.** `Box.create({ browser: true })` is the only switch. A Box that exists cannot be changed.
- **`Box.fromSnapshot` ignores `browser: true`.** SDK 0.7.5 copies `name`, `labels`, `size`, `runtime` and a few more into the request, and not `browser`. Read `fromSnapshot` in `node_modules/@upstash/box/dist/client.js` to see whether that has changed.
- **A snapshot passes on the browser access of the Box it was taken from.** A Box made from a snapshot of a browser-enabled Box has browser access with no option passed. A snapshot of a plain Box can never give one. So the image has to be built in a browser-enabled Box, and `build-snapshot.mjs` refuses to build anywhere else.
- A Box without it answers browser calls with "browser is not enabled for this box". `hasBrowser()` in `src/box.mjs` calls `box.browser.listTabs()` and reads that error. `BoxData` from `Box.list` also has a `browser` field in the type definitions, but whether the API fills it in was not checked, so the scripts do not rely on it.
- **Upstash's Chromium starts only when a first tab is opened.** Listing tabs does not start it. Once running, it listens on port 9222 inside the Box. `startBrowser()` opens a blank tab before each agent run. If that fails the job goes on without a browser.
- A browser tool in the image has to be told to attach to that Chromium. See `worker-image.md`.

## Facts about a Box

Found by looking inside one. Re-check them with `scripts/box-exec.mjs` if something behaves oddly.

- Debian 12 on ARM64 (`aarch64`). User `boxuser`, passwordless `sudo`, `apt-get` available.
- The working folder of a command is `/workspace/home`. `$HOME` is `/home/boxuser`.
- `~/.claude`, `~/.codex` and a few others are links into `/workspace/home`. `/workspace` is a separate volume. The rest is the system disk.
- Pause and resume, and snapshots, keep the whole disk, including apt packages and files outside `/workspace`.
- The Node image ships Node, npm, pnpm, yarn, bun, git, make, Claude Code and the Codex CLI. It has Python 3.11 but no pip, and `python3 -m venv` fails until `python3-venv` is installed with apt. No Go, Rust, Java, gcc or Docker. `scripts/smoke-test.mjs` prints this list for the user's own Box, so trust that over this note.
- `runtime: "node"` is the only runtime the template was tested with. It is the config key `factory.runtime`. Another runtime may not ship the agent CLIs.
- Both CLIs honour a user-level settings file in the Box for model and reasoning effort (`~/.claude/settings.json`, `~/.codex/config.toml`). Verified. See `agents.md`.
- Global git config sets `credential.helper = store` and an Upstash author. See `pitfalls.md`.
- The default shell for `exec.command` is `sh` (dash), not bash. Its built-in `kill` does not accept a process group. `/bin/kill` does.
- `box.files.write` can write outside `/workspace/home`, for example to `/home/boxuser/.config/...`. Verified.
- `setsid` is available.
- Labels: at most five per Box, at most 20 characters, from letters, digits, `.`, `_`, `-`, `:`.
- The free plan allowed 10 Boxes in total, paused ones included.
