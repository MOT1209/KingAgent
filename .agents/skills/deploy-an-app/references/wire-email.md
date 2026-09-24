# Email in production

Last verified: 2026-08-11

**Purpose:** Take an app that has been printing its emails to a terminal and make it send them for real, from a domain the user owns.

> **Hard rule: start this first and check it last.** Domain verification is the only step in the pipeline measured in minutes to hours rather than seconds, it depends on nothing, and everything else can proceed while it settles. Scheduling it late is what makes a deploy feel slow.
>
> If the provider's documentation and this file disagree on *how the pieces fit*, this file wins. On a DNS record, an endpoint, or a dashboard path, their docs win.

## The domain

Sending as a domain requires proving the user owns it. The provider's API creates the domain and **returns the exact records to publish** — a signing record, a sender-policy record, usually a mail-exchange record, and often a tracking one.

Create the domain through the API, then read the records out of the response. Do not write records from memory: the signing key is generated per domain and is different every time.

**Send from a subdomain**, not the bare domain — something like `send.example.com`. This keeps the app's transactional mail separate from the user's ordinary mail, so a problem with one cannot affect the other. If the user ever adds marketing email, that goes on a *third* subdomain, and it is worth one sentence at hand-off: a complaint about a newsletter must never be able to stop a password reset arriving.

## Publishing the records

**If the domain's nameservers are on the host**, write them directly — `project-and-url.md` has the command, and this is the good case.

**Otherwise they go to the user at the rendezvous**, with the other console work: exact names, types and values, ready to paste at their registrar. Never invent a record, and never edit DNS somewhere the skill was not given access to.

Then ask the provider to verify, and poll:

```bash
curl -s -H "Authorization: Bearer $KEY" https://api.resend.com/domains/<id>
```

Not yet verified is a normal state for a while. Report it as pending, not as a failure — and check it again in the gate rather than blocking the pipeline on it.

## The key and the sender

**A production key, scoped to the domain**, rather than a broad one. Write it and the sending address to production.

The sending address must be at the verified subdomain and should carry the app's name — the shape is a display name and an address. An email signed with a placeholder name is the same failure as a page of lorem ipsum, and this is where it survives longest because nobody re-reads their own transactional mail.

**Until the domain verifies, the app can still send to the account owner's own address.** That is worth saying to the user: email is not broken while DNS settles, it is limited.

## What can be checked, and what cannot

The records resolving from outside is checkable, and so is the provider's own verification status. Both go in the gate.

**Delivery is not checkable.** A provider accepting a send proves the provider accepted it. It says nothing about whether the message reached an inbox rather than a spam folder, and no command available here can establish that. Name it as unperformed and suggest the user send themselves one.

Also worth naming at hand-off: the free tier's daily send limit and its request rate. Both bite quietly.

## Verify

- The domain exists at the provider, and its records are either written by the CLI or in the rendezvous block — never half of each.
- The records resolve from outside, checked with a DNS query rather than assumed from having written them.
- The provider reports the domain verified, or it is reported as pending with what is outstanding.
- The production key is scoped to the domain, and is not the development key.
- The sending address is at the verified subdomain and carries the app's real name.
- Unperformed and named: an email actually arriving, and anything about spam placement.
