# The environment

Last verified: 2026-08-11

**Purpose:** Put every value the deployed app needs onto the host, correctly, before the first build. This is where deploys quietly go wrong: not with an error, but with a green build and an app that takes fake money, never runs a job, or talks to a database on a machine that isn't there.

> **Hard rule: `.env` is not a deployment artefact, and there is no copy loop.** Every variable is copied, transformed, regenerated, refused, provisioned, derived or requested — one of seven, decided deliberately. A local development file contains values that are *correct locally and dangerous in production*, and the dangerous ones fail silently.
>
> **Never `vercel env pull`.** It writes a file into the project and overwrites local configuration the user is still using.

Commands are written for a POSIX shell. **On Windows use the Bash tool**, not a translation — see the trailing-newline rule below, which is the single most damaging bug in this file and is invisible after the fact.

## The seven classes

`preflight.md` produced a manifest of every name the code reads, each in exactly one class. Resolve them class by class.

| Class | What to do |
| --- | --- |
| **copy** | same value as local — an AI model name, a public flag |
| **transform** | present in both, different value — the table below |
| **regenerate** | a **new** value for production, never the development one |
| **refuse** | never reaches production — the denylist below |
| **provider** | comes from provisioning in Step 5 |
| **derived** | computed from the production URL from Step 4 |
| **user** | only a human can obtain it — collected at the rendezvous |

## The denylist — values that must never ship

Each of these produces a **successful deploy and a broken app**, which is why they are worth naming individually rather than trusting judgement in the moment.

| Variable | Locally | In production |
| --- | --- | --- |
| a jobs *development* flag | points the SDK at the local dev server **and turns off signature checking** | jobs silently never run, and the endpoint accepts unsigned requests. Do not set it at all — the SDK already defaults to cloud mode, and setting it to `0` is noise |
| a payments *sandbox* switch | correct — no real money | the app takes fake money forever behind a checkout that looks like it works. **One word is the entire go-live switch** |
| a database URL pointing at `localhost` | correct — the container | the build tries to reach `localhost` from inside a build container and fails, or worse, a shipped `.env` makes it win over the provisioned value |
| a test-mode payment key or price id | correct | live checkout against a test catalogue. Test and live catalogues are separate everywhere |
| a shared-sandbox sending address | correct | mail from a domain the user does not own |

**Also regenerate, never copy: the session signing secret.** Reusing the development secret means a token minted on a laptop is valid in production. Generate a fresh one:

```bash
openssl rand -base64 32
```

## Writing a value

Values are read from **standard input**. This is the part that has to be exactly right:

```bash
printf '%s' "$VALUE" | npx --yes vercel@latest env add NAME production
```

- **`printf '%s'`, never `echo`.** `echo` appends a newline; on Windows a PowerShell pipeline appends a carriage return *and* a newline.
- **A trailing newline is stored as part of the value.** A database URL with one fails obscurely. A signing secret with `\r\n` produces a signature mismatch on every single request. **And it cannot be read back to diagnose** — see below. This bug costs an afternoon and looks like something else the whole time.
- Development, preview and production are separate targets and cannot be combined in one call. This skill writes **production**. Only add preview if the user asked for it, and never point preview at the production database — a preview build runs the same migration and would alter production's schema.

**Overwriting an existing value** depends on what the CLI in `preflight.md` reported: either an update subcommand, or a forced add, or a remove followed by an add. Probe, don't assume.

## What can and cannot be confirmed

**Production values are stored as sensitive by default, and a sensitive value cannot be read back** — not by the CLI, not in the dashboard.

So the strongest true statement available is: *the name exists in production*.

```bash
npx --yes vercel@latest env ls production
```

Compare that list against the manifest as a set of **names**. That is a real and useful check — every integration in this stack gates on a variable being present — but it is a check of names, and it must be described that way. "The environment variables are verified" is the exact sentence this skill must never say when only names were read.

**A value is only ever provable by behaviour.** The database URL is proven by the app answering a query; the signing secret by a session surviving a request. `gate.md` does that work, and it is the only thing that does.

## Order

**Every variable is written before the first build.** Not just the database one.

The framework executes module scope during the build, and this stack constructs provider clients at the top of files the app imports everywhere. A key missing at build time is a failed deploy, not a degraded feature. `preflight.md` marked which names those are; there is no separate runtime-only tier to defer.

## Verify

- Every name in the manifest is written to production, or deliberately absent with a reason.
- Nothing from the denylist reached production. Check by name — a jobs dev flag and a payments sandbox switch are the two worth confirming individually.
- The session secret is new, not the development one.
- Every value was written with `printf '%s'` through the Bash tool. No `echo`, no PowerShell pipeline.
- `env ls production` matches the manifest as a set of names, and the check was described as names rather than values.
- `.env` is unchanged, still ignored by git, and no file was pulled into the project.
- No secret was printed into the conversation.
