# Landing page and dashboard

Last verified: 2026-07-27

**Purpose:** Give the app a real front door and, when there are accounts, a real place to land after signing in. This is the step that decides whether the result looks like *their app* or like a scaffold with the boxes ticked.

> **Read `DESIGN.md` before building any of these, and the `vercel-react-best-practices` and `shadcn` skills alongside it.** `DESIGN.md` is binding — the look was agreed with the user before this step and is not reopened here. Step 2a installed the two skills, and this is the densest React in the app — the step where server versus client components, where data is fetched, and how forms submit actually matter. Build the screens out of shadcn components rather than hand-writing markup that approximates them. Those skills own *how the React is written*; this file owns what the pages are, what they say, and who sees them.

## First: what is the front door?

Do not reflexively build a marketing landing page. Pick from what the interview established:

| The app is… | Front door | Dashboard |
| --- | --- | --- |
| A product other people will sign up for (SaaS, marketplace, community) | Full landing page: what it is, who it's for, how it works, call to action | Yes — everything real lives behind sign-in |
| A personal tool, one user, no sign-up flow | **No marketing page.** `/` *is* the app — the list, the board, the log | Not separately; `/` is already it |
| An internal or team tool | A short signed-out screen: name, one line, sign-in button | Yes |
| A public site where content is the point (blog, directory, portfolio) | The content itself, on `/` | Only if there's an author/admin side |

A hiking journal for one person does not need a hero section and a pricing table. Building one is the single fastest way to make the result feel like a template. If the interview said "just me", skip straight to the app.

## Styling: build to `DESIGN.md`

The visual direction is not decided here. It was agreed in the interview and written to `DESIGN.md` at the project root by `references/design.md`, which also set the theme tokens in `src/app/globals.css` and the fonts in `layout.tsx`. **This step spends its judgement on the app, not on how it looks** — read that file and build to it.

Where the pages need something the file doesn't cover — a badge colour, a chart palette, a wider content width for one page — **add it to `DESIGN.md` as a token first, then use the token.** Deciding it inside a component instead is how an app ends up with five blues and no record of which was intended.

Rules that hold regardless of direction:

- Use shadcn components (`pnpm dlx shadcn@latest add ...`) rather than hand-rolling buttons and inputs. Add only what the pages actually use.
- Give the app real spacing. Cramped, full-width, edge-to-edge content is the clearest tell of a scaffold: constrain the content width and let it breathe.
- Every list needs an **empty state** — the first thing the user sees is zero rows, and "nothing here yet, add your first hike" is the difference between working and broken-looking.
- Responsive from the start. Check one narrow viewport before calling it done.

## Landing page

Write it about *their* product, from the interview. Structure that works for almost any app:

1. **Header** — name, and either Sign in / Get started or nothing at all if there are no accounts.
2. **Hero** — what it is in one sentence a stranger understands, one supporting line, one primary action. Their words from the interview, not "Welcome to MyApp".
3. **What you can do** — three or four real capabilities, named concretely ("Log a hike with photos and notes"), not adjectives ("Powerful. Fast. Simple.").
4. **Pricing** — only if payments were set up, showing the real product name and price from `references/payments.md`.
5. **Footer** — name, year, and only links that exist. This is where later steps add theirs: `references/docs.md` puts a **Docs** link here if the app got documentation, and `references/legal.md` runs after both and decides whether this app owes a privacy policy or terms at all. Leave the footer somewhere they can add to it, and add nothing on spec. Where legal also built a consent banner, the footer carries the **Cookie preferences** control that reopens it.

**Page titles are not set here.** `references/seo.md` owns everything in `<head>` — the title, the template every page's title slots into, the description, and the preview card — because it runs last and is the only step that sees every public page. Leave `src/app/layout.tsx`'s metadata alone; it gets fixed there, in one place, rather than in two that drift.

**Never fabricate credibility.** No invented testimonials, customer quotes, company logos, star ratings, user counts, "trusted by 10,000 teams", or press mentions. The app has no users yet and everyone reading the page knows it. If a section would need social proof to work, leave the section out — an honest page with three real features beats a fake one, and fake reviews are the kind of thing that gets a real product in real trouble later.

Same rule for screenshots: show the actual UI or show nothing. No stock mockups.

## Dashboard

Only when sign-in was chosen. This is what proves auth actually works end to end, so build it even if it starts small.

Put it in a route group so the protection is written once, in `src/app/(dashboard)/layout.tsx`:

```tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  return (
    <div className="min-h-screen">
      {/* nav + signed-in user + sign-out */}
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
```

**Check the session on the server, in the layout or page.** Middleware is fine as an optimistic redirect to keep signed-out users from seeing a flash of the dashboard, but it is not the security boundary — a client-side or middleware-only check can be bypassed. Anything that reads or writes user data re-checks the session where it runs.

Leave room in the navigation for **Settings** — `references/settings.md` builds it next and hangs it off whatever nav you write here. It needs a place to live, not a placeholder page.

The dashboard page itself shows **their real data**, scoped to the signed-in user — the nouns from the interview, filtered by `userId`, with the primary action ("Log a hike") in reach. A page that only says "Welcome back, user@example.com" proves auth works and nothing else; go one step further and render the actual thing the app is for.

Scope every query by the session user. On a multi-user app, a query that forgets `where(eq(table.userId, session.user.id))` shows everyone each other's data — check each one.

## Verify

- Signed out, `/` renders the right front door for this app, and every visible string is about their product.
- No invented testimonials, logos, ratings, or user numbers anywhere.
- Every footer link resolves, and there is no link to a legal page this app was never going to have.
- Signed out, visiting `/dashboard` redirects to sign-in.
- Signing in lands on the dashboard, which shows the signed-in user and their own data.
- Sign out returns to the signed-out state, and `/dashboard` is protected again.
- One user's data is not visible to another (create a second account and confirm).
- Empty states read as intentional, not broken.
- The app looks right in both light and dark mode, and at a narrow viewport.
