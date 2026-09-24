# The project and its address

Last verified: 2026-08-11

**Purpose:** Create the project and settle the URL before anything else exists. Every later step takes the address as an input — the sign-in origin, the OAuth callbacks, the webhook targets, the token audience — so this file runs before provisioning, before environment variables, and long before a deploy.

> **Hard rule: read the production URL back from the platform. Never construct it.** The obvious guess — the project name with the host's suffix — is right until it isn't, and it stops being right exactly when someone else already has that name. Then the platform assigns something different, every value derived from the guess is wrong, and the first symptom is a sign-in loop nobody can explain.
>
> If the host's documentation and this file disagree on *what order to do things in*, this file wins. On a command, a flag or a dashboard path, their docs win — and `--help` beats both.

## Why this is early

Three things need the address, and only one of them needs the site to be *live*:

| Needs | Actually requires |
| --- | --- |
| The sign-in origin, and the token audience with agent access | the URL |
| OAuth callback URLs, pasted into a provider console by hand | the URL |
| Payment webhook registration | the URL — an endpoint can be registered before it answers |
| DNS propagation | nothing at all, and it is the slowest step in the pipeline |
| Background-job sync | a **live** endpoint — this one waits |

So the address is settled first, the slow DNS work starts immediately, and the user is asked for console work exactly once, with the real value rather than a placeholder.

## Naming

The project name becomes the free URL, and by default it is taken from the folder name. That means the most consequential identifier in the app would be chosen by whatever the user happened to call a directory.

**Put the name on the deploy sheet in Step 3** and use it deliberately. Lowercase, hyphens, no spaces. It should be the app's name, not `my-app` and not the folder.

```bash
npx --yes vercel@latest link --yes --project <name>
```

If the name is taken in the user's own account, **stop and ask.** Reusing an existing project deploys this app over whatever was there.

## Read the URL back

Immediately, before anything derives from it:

```bash
npx --yes vercel@latest project inspect <name>
```

Take the production URL from the output. Where the probe in `preflight.md` found a JSON output flag, use it and read the field rather than parsing prose.

**Record it once, and use that recorded value everywhere.** Two steps independently deriving "the URL" is how a trailing slash gets into one of them.

## A custom domain

If the user has one:

```bash
npx --yes vercel@latest domains add <domain> <project>
```

A domain can be attached to a project with no deployments. It answers nothing until there is one, which costs nothing, because there are no visitors yet.

**Add both the bare domain and the `www` form, pick one as canonical, and redirect the other to it permanently.** This is not tidiness. A session cookie is set for the host that issued it, so a user who signs in on one form and browses the other is signed out — an intermittent, unreproducible bug that reads as "the login is broken".

The canonical form is the one that goes into every derived value.

### The DNS records

The host will name the records the domain needs. **Where the domain's nameservers are already on the host, write them directly:**

```bash
npx --yes vercel@latest dns ls <domain>
npx --yes vercel@latest dns add <domain> <subdomain> <type> <value>
```

Otherwise, collect them and hand them to the user at the rendezvous in Step 6 — exact names and values, ready to paste, alongside the other console work. Never invent a record, and never edit DNS at a registrar the skill was not explicitly given access to.

**Start this before provisioning, not after.** Propagation takes minutes and occasionally hours; everything else in the pipeline takes seconds. It is the only step where waiting is the cost.

### Checking it landed

```bash
dig +short <domain>
npx --yes vercel@latest domains inspect <domain>
```

Not yet propagated is a normal state, not a failure. Say so plainly rather than reporting it as an error — and remember it for the gate, where an unpropagated domain makes every check behind it red for one reason.

## What this produces

By the end of this file, three values are fixed and recorded for every later step:

- **The production URL**, canonical form, no trailing slash.
- **The project name**, as the platform accepted it.
- **The DNS records**, either written or queued for the rendezvous.

Add the project to the record of things created — `recovery.md` has the format. It is the first entry.

## Verify

- The project exists under the account and team the user chose.
- The production URL was **read from the platform**, not assembled from the project name.
- It has no trailing slash, and it is the form every later step will use.
- Where there is a custom domain: both forms are attached, one is canonical, and the other redirects to it.
- DNS records are either written by the CLI or in the rendezvous block for the user — never half of each.
- Nothing has been deployed, and no environment variable has been written.
- The project is the first entry in the record of what this run created.
