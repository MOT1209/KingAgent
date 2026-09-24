# Sign-in in production

Last verified: 2026-08-11

**Purpose:** Make accounts work on the real domain. Two variables and, where social sign-in exists, a short piece of console work only a human can do.

> **Hard rule: never weaken authentication to make something work.** No wildcard trusted origins, no disabling the cross-site request check, no widening what the app accepts because a redirect didn't match. Every one of those turns a configuration problem into a security problem, and the configuration problem is usually one character.
>
> If the auth library's documentation and this file disagree on *how the pieces fit*, this file wins. On an option name or a method signature, their docs win.

## The two variables

**The origin.** The app's public URL, taken from the value recorded in `project-and-url.md` — canonical form, `https`, **no trailing slash**. Where the app also has agent access, this same value is the token issuer and audience, and `wire-mcp.md` explains why a trailing slash there fails in a way that gives no useful error.

**The signing secret. Generate a new one.** Do not copy the development value:

```bash
openssl rand -base64 32
```

A shared secret means a session minted on someone's laptop is valid against production. It costs one command to avoid.

## Both hosts, or one

If the app answers on both the bare domain and the `www` form, requests arriving on the non-canonical one fail the origin check — because the origin variable names exactly one of them.

Two acceptable answers, and the choice is deliberate:

- **Redirect at the edge**, so only the canonical host ever reaches the app. Preferred, and `project-and-url.md` sets it up.
- **Trust both explicitly** in the auth config, as a listed pair. Never a wildcard.

A session cookie set on one host and read on the other is a sign-in that appears to work and then silently doesn't — the single most confusing failure in this file.

## The console work

Social sign-in needs a callback URL registered with the provider, and **there is no API for this.** Not for Google, not for GitHub. It is a human in a browser, every time.

That is why the address is settled in Step 4 and this is handed over at the rendezvous in Step 6: so the user does it **once**, with the real URL, rather than doing it now and again after the domain changes.

Give them the exact strings, ready to paste — the production callback for each provider they use, in the shape that provider expects, alongside a link to the right console page.

**Leave the development callback in place.** Removing it breaks their local sign-in, and both can coexist.

## Verify

- The origin variable is the canonical production URL, `https`, with no trailing slash.
- The signing secret is new, and is not the value in the local `.env`.
- Requests to the non-canonical host either redirect to the canonical one or are explicitly trusted — never a wildcard.
- Sign-in with credentials that cannot exist returns a rejection, not a server error. `gate.md` runs this.
- Any cookie the app issues is `Secure` and `HttpOnly`.
- Social branch: the production callback is registered, the development one still works, and if the user has not done it yet it is named as outstanding rather than assumed.
