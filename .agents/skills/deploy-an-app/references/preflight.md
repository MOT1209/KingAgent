# Preflight

Last verified: 2026-08-11

**Purpose:** Establish what is true before anything is promised or created. Nothing in this file changes anything — it reads the machine, the account and the code, and produces the three inventories every later step depends on: what the CLI can do, what this app is, and which environment variables it reads.

> **Hard rule: nothing here mutates anything.** No install into the project, no project created, no variable written, no file edited. Preflight that changes things cannot be re-run after a failure, and re-running after a failure is exactly what it is for.
>
> On what the CLI can do, `--help` wins over this file, over the provider's documentation, and over Step 1's research. Documentation describes the release its author had.

Commands are written for a POSIX shell. **On Windows use the Bash tool rather than translating them** — the same rule the parent skill's gate follows, and here it matters more, because a PowerShell pipeline appends a carriage return to every value it pipes and that corrupts secrets invisibly.

## 1 — The CLI, without installing anything globally

Do **not** `npm install -g`. Upgrading a tool the user shares with their other projects, mid-deploy, on a machine where the PATH may not refresh until they restart their shell, is a side effect nobody asked for.

Invoke the current release directly instead:

```bash
npx --yes vercel@latest --version
```

Always current, no global change, nothing to undo. Use this form everywhere. Where the reference files write `vercel …`, read it as this.

**Then probe what that release can actually do.** The CLI's surface moves quickly, and commands that exist in one release are renamed in the next:

```bash
npx --yes vercel@latest --help
npx --yes vercel@latest env add --help
npx --yes vercel@latest blob --help
npx --yes vercel@latest integration --help
```

Record which of these exist, because later steps branch on them: a JSON output flag, a non-interactive flag, whether environment variables are updated in place or removed and re-added, and what the blob-store and integration subcommands are called. **Use what the help text says, not what this file or a search result says.**

## 2 — The account

```bash
npx --yes vercel@latest whoami
npx --yes vercel@latest teams ls
```

Not logged in is the one prerequisite with no automated path: signing in opens a browser and cannot be scripted. Stop and ask the user to run it themselves, then continue.

If the user belongs to more than one team, **ask which one** rather than taking the default. A project created in the wrong account is not movable by any command here, and its URL is already wrong.

## 3 — What this app is

Read it; do not ask. Every answer here is in the code, and the user should not have to remember what they built.

```bash
cat package.json
ls -a
```

Establish:

- **Is this Next.js**, and does a `package.json` sit in the current directory rather than a subfolder.
- **Which package manager** — from the lockfile, not from preference. The wrong one produces a lockfile conflict at build time.
- **What `build` actually runs.** If it chains a migration ahead of the framework build, the database must be reachable *during the build*, which is the single most common cause of a first deploy failing.
- **Which features exist**, each from a file rather than a question:

| Look for | Branch |
| --- | --- |
| a Drizzle config, and which dialect it names | database, and whether a conversion is needed |
| an auth config in `src/lib/` | sign-in |
| a social provider configured in it | OAuth callback work at the rendezvous |
| a blob/storage client in the dependencies | file uploads |
| a payments plugin in the auth config | payments |
| a background-jobs route | background jobs |
| an `/mcp` route | agent access |
| an email client in `src/lib/` | transactional email |

An app with none of these still deploys. The branch list only decides which reference files load.

## 4 — The environment manifest

This is what makes the skill work on an app it did not build, and it is worth more than any list of names a reference file could carry.

**Derive the variables from the code**, not from `.env` and not from memory:

```bash
grep -rhoE "process\.env\.[A-Z_][A-Z0-9_]*" src/ next.config.* drizzle.config.* 2>/dev/null \
  | sed 's/process\.env\.//' | sort -u
```

Then take the union with whatever `.env` defines, and classify every name into exactly one of:

| Class | Meaning | Where it is resolved |
| --- | --- | --- |
| **copy** | same value in production | Step 7 |
| **transform** | present in both, different value | Step 7, via the table in `env.md` |
| **regenerate** | must be a *new* value in production | Step 7 |
| **refuse** | must never reach production | `env.md` denylist |
| **provider** | created by provisioning | Step 5 |
| **derived** | computed from the production URL | Step 4 gives the URL |
| **user** | only a human can obtain it | the rendezvous, Step 6 |

**The classification is the schedule.** Every class maps to one step, and the number of deploys needed equals the number of classes that cannot be resolved until something else exists. Done properly, that number is one.

Also note **which variables are read at module scope** — outside a function body, where they are evaluated the moment the file is first imported:

```bash
grep -rn "process\.env\.[A-Z_]*!" src/ || echo "none"
```

Every one of these must be present at build time, not just at runtime. A client constructed at the top of a file that the app imports everywhere will be constructed during the build, and a missing key there fails the deploy rather than degrading.

## 5 — Git

```bash
git status --porcelain
git rev-parse --abbrev-ref HEAD
git remote -v
git check-ignore .env && echo ".env ignored" || echo "WARNING: .env is not ignored"
```

- **A dirty tree stops the pipeline.** A push deploys the committed tree and a direct upload deploys the working directory, so with uncommitted work those two mechanisms deploy different things — and only one of them is reproducible. Commit or stash first.
- **`.env` must be ignored.** If it is not, it will be uploaded, and the framework's loader treats a shipped `.env` as authoritative for every name that was *not* set on the host. That is how a local database address wins over the provisioned one, silently, on a deploy that otherwise looks fine.
- Note whether a remote exists. No remote is not a blocker — it decides which deploy mechanism `deploy.md` uses.

## 6 — First run, or an existing site?

```bash
npx --yes vercel@latest projects ls
```

If a project for this app already exists **and has a production deployment**, the posture changes for the whole run and every later file says how: nothing is created from scratch, existing values are corrected rather than written fresh, and the deploy stops going straight to production because there are users on the other end of it.

Establish it here. Discovering it at the moment of deploying is discovering it too late.

## Verify

- The CLI runs, and its help output — not this file — is what later steps were planned against.
- `whoami` names an account, and where there is a choice of team the user made it.
- The branch list came from files, and each entry can be traced to one.
- The environment manifest is complete: every name the code reads is classified, and no name is in two classes.
- Every module-scope variable is marked as needed at build time.
- The tree is clean, `.env` is ignored, and the current branch is known.
- Whether this is a first deploy or an existing production site is settled, and stated to the user in one line if it is the latter.
- Nothing was created, installed or written.
