# Legal pages and cookie consent

Last verified: 2026-08-12

**Purpose:** Give the app the pages it actually owes the people who use it — a privacy policy, terms, a cookie notice — and a consent banner only where something genuinely needs consenting to. Which of these apply is worked out from what the app is; it is never put to the user as a question.

> **Hard rule: never write a legal claim the code cannot keep.** No invented company, address, governing jurisdiction, data protection officer, retention period, certification, or age limit the app doesn't enforce. Every sentence on these pages either describes something that exists in the codebase or is a blank marked loudly enough that nobody ships it by accident. A landing page with a fabricated testimonial is embarrassing; a privacy policy promising a thirty-day deletion window that nothing performs is a written undertaking the user didn't know they gave.
>
> These pages are a first draft assembled from what the app does, not legal advice, and the hand-off says that once, plainly. Say it once — a document hedged in every paragraph is worse than one that is simply accurate about a small app.

## First: what does this app actually owe anyone?

Do not reflexively add a privacy policy and a terms page. Everything needed to make this call was settled in Step 1a and 1b — who the app is for, whose data it holds, whether strangers can sign up. **Decide from the table, state the decision on the build sheet, and never ask.**

| The app is… | Privacy | Terms | Cookie banner |
| --- | --- | --- | --- |
| A personal tool, one user, no sign-up | None — nobody else's data is in it | None — there is no second party to agree with | No |
| An internal or team tool, invited people only | A short "what this stores and who can see it" note | No, unless the user asks | No |
| A public product other people sign up for | Yes | Yes | Only if something non-essential loads |
| A public product that takes money | Yes | Yes, plus cancellation and refunds | Only if something non-essential loads |
| A public content site with no accounts | Only if it collects anything at all — a contact form, a newsletter | No | Only if something non-essential loads |

A hiking journal for one person does not need a terms of service, and generating one is the same failure as generating a pricing table for it. **The absence is the deliverable in that row** — say so on the build sheet in one line ("nothing legal needed — it's just you, and nothing here tracks anyone") so the user reads a decision rather than an oversight.

Where a row says yes, the pages are built from what the app really contains. Where it says no, nothing is built and nothing is linked.

## The cookie question is not "does it set a cookie"

Almost every app here sets a cookie, and almost none of them owe a banner for it. Consent is owed for what is **not essential** to the thing the person asked for — not for the machinery that makes it work.

A banner is owed when the app loads any of these:

- Analytics or product analytics, on any provider.
- Session replay or heatmaps.
- A third-party embed that phones home: YouTube, Vimeo, Google Maps, Intercom, Calendly, a social timeline.
- A marketing, ad, or attribution pixel.
- A/B testing or personalisation that profiles a visitor.
- Stripe.js embedded in the page — as opposed to a redirect to hosted checkout.

A banner is **not** owed for:

- The Better Auth session cookie. Somebody asked to sign in; the cookie is how that request is honoured.
- A CSRF token, a theme choice, a locale, a dismissed-notice flag.
- Payment checkout that happens on the provider's own domain, which is their disclosure to make, not the app's.
- `next/font/google`, which `references/stack.md` sets up. It downloads the font at build time and serves it from the app's own domain, so nothing reaches Google from a visitor's browser. The name misleads; the behaviour is first-party.
- Anything that only ever runs on the server. Resend, Inngest, OpenRouter and the database are all sub-processors the privacy page has to name, and none of them set a thing in anybody's browser. **Disclosure and consent are different obligations** — confusing them is how an app ends up with a banner asking permission for its own back end.

The stack this skill builds loads none of the first list. **So most apps built here get no banner, and that is the correct outcome rather than a gap.** A banner over nothing but a session cookie is a dead control: the Reject button either lies or breaks sign-in, and consent theatre is the pattern regulators have been fining, not the one they reward. If a banner is skipped, say why in one line at hand-off, and say what would change it — "add analytics later and this needs one".

## Consent that actually gates

Only when the rule above says a banner is owed.

**The choice lives in a first-party cookie, not `localStorage`.** That is the whole design: a server component can read a cookie, so the scripts are never rendered into the page until consent exists. Loading a script and asking it to behave is not consent — the request has already left the browser.

`src/lib/consent.ts`:

```ts
import { cookies } from "next/headers";

export const CONSENT_COOKIE = "cookie-consent";

export type Consent = { analytics: boolean; marketing: boolean };

export const NONE: Consent = { analytics: false, marketing: false };

export async function readConsent(): Promise<Consent | null> {
  const raw = (await cookies()).get(CONSENT_COOKIE)?.value;
  if (!raw) return null;
  try {
    return { ...NONE, ...(JSON.parse(decodeURIComponent(raw)) as Partial<Consent>) };
  } catch {
    return null;
  }
}
```

`null` means *not asked yet* and is deliberately not the same value as a rejection. It shows the banner — and it withholds every script, exactly as a rejection does. Absent is never treated as permission.

In `src/app/layout.tsx`, which is where both halves meet:

```tsx
const consent = await readConsent();

// ...
<body>
  {children}
  {consent === null && <ConsentBanner />}
  {consent?.analytics && <Script src="…" strategy="afterInteractive" />}
</body>
```

Reading a cookie in the root layout opts the whole app into dynamic rendering, so the build's route table will show public pages as `ƒ` rather than `○`. That is the price of gating properly and it is the right trade — but know it is happening, because `references/verify.md` reads that same table for a different reason.

`src/components/consent-banner.tsx` is a client component built from the same shadcn pieces as the rest of the app. The rules it has to keep:

- **Accept and Reject are one click each, side by side, at the same visual weight.** Not a bright Accept beside a grey link, not a Reject that costs two clicks and a scroll. The asymmetry is the part that turns a banner into a finding.
- Granular choice sits behind a third control, with every non-essential category **off** until it is turned on. Never pre-ticked.
- It does not trap the page. No full-screen overlay that has to be answered before anything can be read.
- Writing the choice reloads, so the server re-renders with or without the scripts. Six months is a reasonable life for the cookie; then ask again.
- **Withdrawal has to bite.** Moving from accept to reject clears what the app can clear and stops the script being rendered on the next request. A preferences screen that only edits a stored value while the tag keeps firing is worse than no screen.

Reopening it is a footer link and a settings section, not a one-time event — `references/pages.md` places the first, `references/settings.md` the second.

## The pages

Routes live in their own group, `src/app/(legal)/`, so they share a plain readable layout and stay reachable signed out. Never inside the dashboard group.

- `/privacy` — always, where the table said yes.
- `/terms` — where the table said yes.
- `/cookies` — only where a banner was built. Otherwise the two paragraphs it would contain go in a "what we store" section of the privacy page, and the route doesn't exist.

Write them from the branches that actually ran. Each one that did carries something the privacy page has to say:

| Branch | What the page must disclose |
| --- | --- |
| Database, always | what the app stores, in the app's own nouns, and that it lives in its own database |
| `references/auth.md` | that an email address and a password hash are held, and a session cookie is set |
| `references/email.md` | that Resend delivers the mail, and that a receipt or a password reset is not marketing |
| `references/storage.md` | that uploads sit in the project locally and in Vercel Blob once deployed |
| `references/payments.md`, Polar | that Polar is **merchant of record** — the sale is a contract with Polar, and the app never sees a card |
| `references/payments.md`, Stripe | that Stripe processes the payment and the app never sees a card |
| `references/ai.md` | that what someone types into the AI feature leaves the app and reaches a model provider through OpenRouter |
| `references/jobs.md` | that Inngest runs work on their data outside the request they made |
| `references/mcp.md` | that AI clients **they** authorise can read and write their data on their behalf, and that revoking is in settings |

The terms page is shorter than people expect and should stay that way: what the service is, what an account holder may and may not do with it, who owns what they put in, that the app can be changed or withdrawn, and — with payments — how billing renews, how to cancel, and what happens to their data afterwards. Where `references/storage.md` ran, one clause on uploaded content: whose it is (theirs), what licence the app needs to display it back to them, and what gets removed.

Whatever the app's own words are for its nouns, the legal pages use them too. A privacy policy about "user-generated items" for an app whose every other screen says "hikes" reads as boilerplate because it is.

## Claim only what the code keeps

Read this list against the pages before moving on. Each entry is a sentence that is only allowed if something in the build performs it:

- **Deletion.** Allowed wherever there is sign-in — `references/settings.md` builds "delete my account", and deletion there is immediate and permanent. Describe what it actually removes, including the uploads and the subscription if those branches ran, and do not invent a grace period it doesn't have.
- **Export.** Allowed wherever there is sign-in, and only there — `references/settings.md` builds **Download my data** as a real server action returning their own rows. Say it exists and where it is. On an app with no accounts there is nothing to export and nothing to claim.
- **Rectification** — "you can correct your data". Only for the fields the app actually lets somebody edit. The profile is editable; whatever the interview left read-only is not.
- **Retention periods.** Only if something enforces one. "We keep logs for 90 days" is false in an app whose activity log is never pruned.
- **Security claims.** "Encrypted in transit" is true and safe. "Encrypted at rest", SOC 2, ISO, HIPAA, or "bank-level security" are claims about infrastructure nobody has provisioned yet.
- **An age limit.** Only if there is a check. A minimum-age clause with no field asking for one is a rule the app breaks itself.
- **Anyone to contact.** Only the address in `src/lib/legal.ts`, and only once it is set — see below.
- **A named jurisdiction or entity.** Never invented. The user is a person with a legal situation the build knows nothing about.

Where the honest version is short, let it be short.

## The blanks a build cannot fill

A handful of facts exist only in the user's head. They go in one file, `src/lib/legal.ts`, and nowhere else:

```ts
export const legal = {
  appName: "TrailLog",
  entity: null as string | null,        // the person or company that operates it
  contactEmail: null as string | null,  // where privacy requests go
  jurisdiction: null as string | null,  // whose law governs the terms
  lastUpdated: "…",                     // today's date, and it moves when the pages do
};
```

**An unset value renders a visible marker, never a plausible placeholder.** `[Your Company Name]` sitting in a live privacy policy is the legal form of lorem ipsum — it survives because nobody notices it. So render it as something nobody can miss, in `src/components/legal-blank.tsx`:

```tsx
export function Blank({ field }: { field: string }) {
  return (
    <mark className="rounded bg-yellow-200 px-1 text-black dark:bg-yellow-300">
      Needs your details — set <code>{field}</code> in <code>src/lib/legal.ts</code>
    </mark>
  );
}
```

This is the one place in the app where a hardcoded colour is right rather than a lapse from `references/pages.md` — the marker is meant to look like something that doesn't belong, and a theme-aware version of it would blend in, which is the opposite of the job. That exact string is what `references/verify.md` greps the served page for, so it cannot ship in silence, and Step 8 lists each unset field as one line the user can clear in a minute. Where a clause depends entirely on a blank — a governing-law sentence with no jurisdiction — **omit the clause and mark it**, rather than writing a sentence that means nothing.

## Verify

- The decision matches the table, and it was stated on the build sheet rather than asked as a question.
- Signed out, every page the table called for answers, and every page it didn't is absent — no orphan `/terms` on a personal tool.
- Every page that exists is linked from the footer, and every footer link resolves.
- Every branch that ran appears in the privacy page, in the app's own words for its nouns.
- Nothing on any of them claims deletion, export, rectification, retention, security, or an age limit that the code doesn't perform.
- Every unset field in `src/lib/legal.ts` shows as a marker on the page and is on the hand-off list. No `[Your …]` placeholder anywhere.
- No banner branch: the reason there is no banner is a sentence at hand-off, not a silence.
- Banner branch: no third-party script appears in the served HTML before a choice is made, Reject is one click at the same weight as Accept, no non-essential category starts ticked, and the choice survives a reload.
- Banner branch: rejecting after accepting stops the script rendering on the next request.
