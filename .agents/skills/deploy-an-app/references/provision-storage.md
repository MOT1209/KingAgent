# File uploads in production

Last verified: 2026-08-11

**Purpose:** Give uploaded files somewhere permanent to live. While the app was being built they went into a folder in the project; that folder does not exist in production, and this is the switch.

> **Hard rule: this is a setting, not a code change.** The app in this stack picks its storage at runtime by whether a credential is present, so connecting a store is the whole job. If it looks like the code needs editing to use the store, the credential isn't reaching the app — fix that instead.
>
> On the command and its flags, `--help` wins over this file.

## Create it and connect it

```bash
npx --yes vercel@latest blob store add <name>
```

The subcommand name has changed between releases — `preflight.md` probed for the current one, so use what it found rather than what is written here.

Two things to get right:

- **Access.** Files that are rendered in a page — avatars, photos on a record — need to be publicly readable. Anything private needs the private mode and a different render path. Take the app's existing behaviour as the answer.
- **Connect it to the project**, in production. Connecting is what injects the credential; a store that exists but is attached to nothing is the most common way this step silently does nothing. It is worth confirming rather than assuming, because the app will fall back to a local folder that does not exist and fail only when someone uploads.

## The variables

The store injects its own. Which names depend on the release: a modern setup uses a short-lived credential paired with a store identifier, with a long-lived token as the fallback used off-platform.

The app in this stack checks for **either**. What matters is that at least one name it looks for is present in production — `env.md` compares names against the manifest.

## Two things worth saying at hand-off

- **Files uploaded while building stay on the laptop.** They were development data and were never in version control. Nothing migrates them, and nothing should.
- **There is a request-size ceiling** on the upload path, and files above it never reach the app at all. Where the app needs larger files, that is a client-direct upload — a real change, worth doing only when the app actually needs it.

If the app renders images through the framework's image component, the store's hostname must be allowed in the framework config. That is usually already there from when the app was built; confirm rather than assume, because the failure is a broken image on a page that otherwise works.

## Verify

- The store exists, and is **connected to the project** in production — confirmed, not assumed.
- At least one credential name the app looks for is present in production.
- The store's hostname is allowed in the framework config if images are rendered through it.
- Access mode matches how the app actually serves files.
- The store is in the ledger with its free-tier limit.
- Unperformed and named: an actual upload through the app, and the file rendering after a refresh. That needs a session and a browser.
