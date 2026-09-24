# System visibility

Last verified: 2026-08-09

**Purpose:** Give the app an inside view of itself — what's configured, what happened, what's running in the background, and what email went out. Every app gets this, scaled to what it actually has.

**This step is not optional.** Everything else in this skill is a branch; this one always runs. An app whose owner cannot see why an email didn't arrive, or that a job has been retrying for an hour, is an app they can only debug by reading logs on a hosting dashboard — which is exactly the moment a new project stops being fun. The panels below appear only if the app has the thing they describe, but the page itself always exists.

> **Hard rule: never render a secret, or part of one.** This page reports whether something is *configured*, never what it is configured with. No API keys, no connection strings, no "sk-...abc4" tails, not even in a tooltip or a copy button. A masked key is still a key with fewer characters to guess, and this page exists to be looked at.

## Who can see it

**If the app has sign-in:** the page lives at `/settings/system`, is linked in the settings nav only for admins, and every page and action behind it calls `requireAdmin()` from `references/settings.md` on the server. Hiding the link is presentation; the guard is the security boundary.

**If the app has no sign-in:** there is nobody to be an admin, so the page renders in development only and does not exist in production.

```tsx
// src/app/settings/system/page.tsx — no-sign-in apps only
import { notFound } from "next/navigation";

export default async function SystemPage() {
  if (process.env.NODE_ENV === "production") notFound();
  // ...panels
}
```

Say why to the user in one line: without accounts there's no way to tell them apart from anyone else on the internet, so a page listing what's wired up doesn't belong on the public site. It's still there while they're building, which is when they need it.

## Health and configuration — always

One card listing every integration the app could have, and whether it's ready. Presence of the environment variable only.

```ts
// src/lib/system-status.ts
import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type Check = { name: string; ready: boolean; hint: string };

export async function getSystemStatus() {
  const integrations: Check[] = [
    // Include only the ones this app actually set up.
    { name: "Email (Resend)", ready: Boolean(process.env.RESEND_API_KEY), hint: "RESEND_API_KEY" },
    { name: "Background jobs (Inngest)", ready: Boolean(process.env.INNGEST_EVENT_KEY) || process.env.INNGEST_DEV === "1", hint: "INNGEST_EVENT_KEY" },
    { name: "File uploads", ready: Boolean(process.env.BLOB_READ_WRITE_TOKEN), hint: "BLOB_READ_WRITE_TOKEN — local folder in use until set" },
    { name: "Payments", ready: Boolean(process.env.POLAR_ACCESS_TOKEN), hint: "POLAR_ACCESS_TOKEN" },
    { name: "AI", ready: Boolean(process.env.OPENROUTER_API_KEY), hint: "OPENROUTER_API_KEY" },
    { name: "Agent access (MCP)", ready: Boolean(process.env.BETTER_AUTH_URL), hint: "BETTER_AUTH_URL — must be the app's public URL" },
    { name: "Canonical URL", ready: Boolean(process.env.APP_URL ?? process.env.BETTER_AUTH_URL), hint: "APP_URL — the app's public address" },
  ];

  let database = false;
  try {
    await db.execute(sql`select 1`);
    database = true;
  } catch {
    database = false;
  }

  return { integrations, database };
}
```

Render each as a row with a green/grey state and the plain-language hint — the *name* of the variable to set, never its value. "Not configured yet" is a normal state here, not an error: it is exactly what a half-built app looks like, and showing it as a warning trains the user to ignore warnings.

The canonical URL row is the odd one out and earns its place anyway: it gates no feature, so nothing breaks without it — the sitemap and every canonical link just quietly point at `localhost` in production, which nobody notices until a search engine has already read them. `references/seo.md` sets it up; this row is where its absence becomes visible.

## Activity log — always

The one panel that exists even in the smallest app. A record of things that happened, so the user can answer "when did that change?"

```ts
export const activityLog = pgTable("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

Postgres branch shown; SQLite uses `text` ids and `integer` timestamps per `references/database.md`. Drop `userId` if there are no accounts.

`onDelete: "set null"` rather than `cascade` — the log outlives the account so "who deleted this?" is still answerable afterwards, with only an anonymous row left behind.

One helper, called from the server actions that already exist:

```ts
// src/lib/activity.ts
import "server-only";
import { db } from "@/lib/db";
import { activityLog } from "@/lib/db/schema";

export async function logActivity(action: string, detail?: unknown, userId?: string) {
  await db.insert(activityLog).values({ action, detail, userId });
}
```

Log the app's real verbs, in the app's own words — `hike.created`, `invoice.sent`, `member.invited` — not `POST /api/x`. Log writes, not reads. Never put a password, token, or full payload in `detail`; the ids and the changed fields are enough.

Render newest-first with the user's name where there is one, and a date filter. Keep it to the last few hundred rows in the page query — this table grows.

## Background jobs — only if `references/jobs.md` ran

The point of this panel is that background work stops being invisible. It reads the app's own `jobs` table, which is the record, and reaches out to Inngest only for live detail on a single run.

```tsx
const rows = await db
  .select()
  .from(jobs)
  .orderBy(desc(jobs.createdAt))
  .limit(50);
```

Show: what it was, who it was for, status, when it started, how long it took, and the error if it failed. Group or filter by status so a wall of completed jobs doesn't bury the one that broke.

Each row opens a detail view that calls `getRun` and `getTrace` from `src/lib/inngest/admin.ts` to show the step-by-step timeline — which step failed, how many attempts, what each returned. Two buttons:

- **Cancel** → `cancelRun`. Label the result "cancelling", not "cancelled": it takes effect at the next step boundary, not instantly.
- **Re-run** → `rerunRun`. This starts a *new* run; show the new id rather than pretending the old one restarted.

Both go through a server action that calls `requireAdmin()` first. The Inngest API key is account-wide and never reaches the browser.

If `INNGEST_API_KEY` isn't set, the list still works from the `jobs` table and the detail view says live detail needs the key — degraded, not broken.

Non-admin users should still see *their own* jobs somewhere in the app if the app's work is job-shaped ("your export is being prepared"). That belongs on the relevant feature page, scoped by `userId`, not here.

## Agent activity — only if `references/mcp.md` ran

Reads `mcp_call_log` newest-first: which tool, which client, which user, worked or failed, how long it took, and how many rows went out.

```tsx
const rows = await db
  .select()
  .from(mcpCallLog)
  .orderBy(desc(mcpCallLog.createdAt))
  .limit(100);
```

This panel shows **reads as well as writes**, unlike the activity log above. When a person reads their own data it is noise; when an agent does, it is the event — a read is how data leaves the app, and the row count is the number that tells you how much. Sort or filter by it and an agent pulling an entire account stands out from one answering a question.

Surface the error text on failed rows. "Claude said it couldn't find anything" is the support question this panel exists to answer, and the answer is usually a scope the user never approved or a tool that threw on an argument the model guessed.

Show the client name beside the tool. One person can have Claude Code and the Claude connector both attached, and "which one did that?" is otherwise unanswerable.

Non-admin users should be able to see their *own* agent activity from `/settings/connections` — the same rows scoped by `userId`. Admins see everyone's here.

## Email log — only if `references/email.md` ran

Reads `email_log`, newest first: recipient, subject, template, status, and when. Status comes from the send itself and then from the Resend webhook if it was set up, so `sent` becoming `delivered` or `bounced` is visible here.

This is the panel that answers the most common support question a small app gets — "I never got the email" — with an actual answer: it was never sent because the key is missing, it bounced, or it was delivered and is in their spam folder.

Offer a **Resend** action on a failed row, going through the same `sendEmail` helper so the retry is logged too.

Show the recipient address, since an admin needs it to help. Do not show the message body.

## Verify

- The system page exists and is reachable: linked in settings navigation for an admin account, and not linked for a normal one.
- Visiting `/settings/system` directly as a non-admin is refused by the server, not just hidden.
- No-sign-in apps: the page renders with `pnpm dev` and returns 404 after `pnpm build && pnpm start`.
- The health card lists every integration this app set up, correctly reflects which are configured, and shows no key, token, or connection string anywhere — check the rendered HTML, not just the screen.
- Doing the app's main action writes an activity row that reads in plain language.
- Jobs branch: a running job appears with its steps, cancelling it moves it out of running, and re-running it starts a new run.
- Email branch: an email sent from the app appears in the log with the right status, and a failed send can be retried from the page.
- Agent access branch: a tool called from Claude appears with its client and row count, a read shows up as well as a write, and a failed call shows the reason it failed.
- With `.env` emptied, the page still renders, shows everything as not configured, and nothing crashes.
