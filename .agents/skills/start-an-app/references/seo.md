# Discoverability

Last verified: 2026-08-13

**Purpose:** Settle whether this app is meant to be found by strangers, then make that answer true in the app's own files — the title in the browser tab, what a shared link looks like, a sitemap and a `robots.txt` that agree with each other, and an `llms.txt` where it earns its place.

**Every app runs this step; not every app gets SEO.** For a personal tool or an internal one the deliverable is a real title and a deliberate *keep me out of search results* — four lines, and the opposite of optimisation. Building a sitemap for an app nobody is meant to find is the same failure as generating a pricing table for a hiking journal.

> **Hard rule: never claim in metadata what the page doesn't contain.** The description is what the page is, in one sentence, not a list of words someone might search for. No keyword stuffing, no invented feature in a title, no `AggregateRating`, `Review`, or `Offer` in structured data for a product with no customers and no price. Metadata is the same promise as the landing page, made to a machine — and `references/pages.md` already bans fabricated credibility on the visible half. Invented structured data is the version of it that gets a real site penalised.

## First: is this meant to be found?

The front-door question in Step 1c already sorted this most of the way. **Ask only where the answer could plausibly be yes** — a public product, a content site, anything with a real landing page. For a one-person tool or an invite-only internal app, don't ask; say in one line what you're doing instead.

| The app is… | Ask? | What gets built |
| --- | --- | --- |
| A personal tool, one user | No | Real title, `noindex`, `robots.txt` disallowing everything |
| An internal or team tool | No | The same. A sign-in screen indexed under the company name is the failure here |
| A public product people sign up for | Yes | The full set below, over the signed-out pages only |
| A public content site (blog, directory, portfolio) | Yes | The full set, plus per-page metadata on the content itself |

Either answer goes on the build sheet as a statement. "Nothing to index — it's just you, so I'll keep it out of search results" is a decision the user should read, not a gap they discover.

## One list of public pages

The spine of this whole file. Three consumers need to know which pages a stranger may see — the sitemap, `llms.txt`, and the footer — and three separately maintained lists drift within a week. Write one.

`src/lib/site.ts`:

```ts
export const siteUrl = (
  process.env.APP_URL ??
  process.env.BETTER_AUTH_URL ??
  "http://localhost:3000"
).replace(/\/$/, "");

export const site = {
  name: "TrailLog",
  description: "A journal for the trails you've walked — dates, distances, and how it felt.",
};

export type PublicPage = { path: string; title: string; summary: string };

export const publicPages: PublicPage[] = [
  { path: "/", title: site.name, summary: site.description },
  // every page this app serves signed out, and nothing else
];
```

**Two variables, one value, resolved in one place.** `BETTER_AUTH_URL` already means "where this app lives" wherever `references/auth.md` ran, so falling back to it means an app that already has the right value gets a correct sitemap without a second setting to keep in step. `APP_URL` exists for the apps that have no auth. They must never disagree.

**Only server code reads `siteUrl`.** Absolute URLs are for sitemaps, canonicals and images, all of which render on the server; anything the browser navigates to is a relative link. A non-`NEXT_PUBLIC_` variable read in a client component is `undefined` there, and the first symptom is a canonical tag pointing at localhost.

This step runs last in Step 4 for exactly this reason: `references/legal.md` and `references/docs.md` both add public pages, and a sitemap written before they ran is already wrong. Add a row to the health card in `references/ops.md` too — `{ name: "Canonical URL", ready: Boolean(process.env.APP_URL ?? process.env.BETTER_AUTH_URL), hint: "APP_URL — the app's public address" }` — because an unset one in production is invisible until somebody reads the sitemap and finds it full of `localhost`.

## The title in the tab — every app, both branches

`create-next-app` writes `title: "Create Next App"` into `src/app/layout.tsx` and it survives an astonishing number of otherwise finished projects. It is what the browser tab says, what a bookmark is named, and what gets pasted into a chat when the user shows somebody. Fix it here, and own it here — `references/pages.md` deliberately doesn't, so there is one owner.

```ts
import type { Metadata } from "next";
import { site, siteUrl } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: site.name, template: `%s · ${site.name}` },
  description: site.description,
};
```

`metadataBase` is what turns every relative image and canonical path into an absolute URL. Without it Next warns at build and falls back to localhost.

The `template` means every page underneath sets only its own half — `export const metadata = { title: "Log a hike" }` renders as `Log a hike · TrailLog`. Set one on each page a person can land on directly.

## The private branch

Two mechanisms, and they are not interchangeable — this is the part people get backwards.

In `src/app/layout.tsx`, alongside the metadata above:

```ts
robots: { index: false, follow: false },
```

And `src/app/robots.ts`:

```ts
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
```

**`noindex` is what removes a page from an index. `robots.txt` only stops it being crawled.** A crawler that is disallowed never fetches the page, so it never sees the `noindex` — which means a URL already known to a search engine can stay listed indefinitely behind a `Disallow`. For a brand-new app both together are right. If the user ever finds an already-indexed page they want gone, the fix is to *allow* crawling temporarily so the `noindex` can be read, and that is worth one sentence at hand-off rather than a surprise months later.

Build no sitemap, no `llms.txt`, no Open Graph image. There is nothing to point anyone at.

Say where the switch lives, because this is the setting that has to change the day the app goes public: `robots: { index: false }` in `src/app/layout.tsx` and `src/app/robots.ts`. Left in place on a launched product it costs the user every visitor they were expecting.

## The public branch

### `src/app/sitemap.ts`

```ts
import type { MetadataRoute } from "next";
import { publicPages, siteUrl } from "@/lib/site";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return publicPages.map((p) => ({
    url: `${siteUrl}${p.path === "/" ? "" : p.path}`,
    lastModified: new Date(),
  }));
}
```

**Nothing behind sign-in goes in a sitemap.** Not `/dashboard`, not `/settings`, not a route handler, not an API path. A sitemap is a list of pages you are inviting a stranger to open, and every entry that redirects to sign-in is an error in Search Console the user has to learn to ignore.

Where the app has genuinely public content — posts, listings, profiles — the rows come from the database, not a hand-written list, and `lastModified` comes from the row's own `updatedAt` rather than `new Date()`. A sitemap where everything changed today tells a crawler nothing. Scope the query the same way the public page does: if a row can be a draft, a draft is not in the sitemap.

`priority` and `changeFrequency` are optional and Google ignores both. Leave them out.

### `src/app/robots.ts`

```ts
import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/dashboard", "/settings"] }],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
```

**A `robots.ts` and a `public/robots.txt` cannot both exist** — the static file wins silently and the generated one, with its correct absolute sitemap URL, does nothing. Same for `sitemap.ts` and a `public/sitemap.xml`. Check that neither static file is there.

**`robots.txt` is public, so it never names a path you'd rather nobody knew.** The entries above are already-guessable sections that auth protects anyway; disallowing an obscure unprotected URL publishes it to everyone who reads the file. Crawl policy is not a security boundary — the session check is.

### AI crawlers are a separate decision

Rules for AI crawlers live in the same file and are a real choice, so make it deliberately rather than by default. There are three kinds and the user usually feels differently about each:

| Kind | Doing what | Usually |
| --- | --- | --- |
| Training crawlers | collecting text to train on | The user's call — content sites often say no, marketing sites usually don't care |
| Search / citation crawlers | building an index so an assistant can cite and link the app | Yes. This is how a public product gets recommended |
| User-initiated fetchers | a person asked their assistant to open this page | Yes. Blocking it blocks a visitor who chose to come |

Ask in one sentence only where the app's content *is* the product — a blog, a directory, anything someone would rather not see reproduced without a link. For a product's marketing pages, allow everything and say so in a line.

**The user-agent tokens move, and the file must not pin a stale list.** Step 2's research is where the current names come from; ask it explicitly. Getting one wrong is not a crash, it is a rule that quietly matches nothing.

### What a shared link looks like

The first time the user posts their app anywhere, the preview card is the product. `src/app/opengraph-image.tsx` generates one from the app's own name and colour with no external asset:

```tsx
import { ImageResponse } from "next/og";
import { site } from "@/lib/site";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ /* the app's own background and primary colour */ }}>
        <div>{site.name}</div>
        <div>{site.description}</div>
      </div>
    ),
    size,
  );
}
```

Inline styles only — `ImageResponse` renders in a satori runtime that knows nothing about Tailwind classes or CSS variables, so read the values out of `globals.css` and write them literally here. Then add `openGraph` and `twitter: { card: "summary_large_image" }` to the root metadata; Next attaches the generated image to both by file convention.

**No stock mockup and no fabricated screenshot**, the same rule `references/pages.md` sets for the landing page.

### `llms.txt`

A plain-markdown index at `/llms.txt`, one heading, one summary, and links with a line each — an agent pointed at the app finds the map instead of parsing navigation out of HTML.

`src/app/llms.txt/route.ts`:

```ts
import { publicPages, site, siteUrl } from "@/lib/site";

export async function GET() {
  const body = [
    `# ${site.name}`,
    ``,
    `> ${site.description}`,
    ``,
    `## Pages`,
    ``,
    ...publicPages.map((p) => `- [${p.title}](${siteUrl}${p.path}): ${p.summary}`),
    ``,
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
```

Generated from the same list as the sitemap, so it cannot fall behind. A `## Optional` section, if there is one, carries links an agent may skip when it wants less context.

**Be honest with the user about what this is.** `llms.txt` is a proposed convention rather than a standard, and no major AI crawler has publicly committed to reading it. It costs a dozen lines and helps anyone who points an assistant straight at the app, which is reason enough to write it — but it is an invitation, not a policy. **What a crawler is permitted to do lives in `robots.txt` and nowhere else**; an `llms.txt` neither grants nor withholds anything. Say that in one line at hand-off so nobody treats the file as a control.

Skip `llms-full.txt` in a first version. It is the whole documentation inlined into one file, which means a second copy of every page to keep current, and the links above already reach the real ones.

### Structured data, narrowly

One `WebSite` block in the root layout is worth having and stops there:

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{
    __html: JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: site.name,
      url: siteUrl,
      description: site.description,
    }),
  }}
/>
```

Add `Organization` **only** where `references/legal.md` ran and `legal.entity` is actually set — the entity is one of the blanks only the user can fill, so a build that invents one is writing a legal claim into machine-readable form. Where payments ran, an `Offer` may carry the real product name and price from `references/payments.md` and nothing else.

Never emit `AggregateRating`, `Review`, or a `FAQPage` of questions nobody asked. Those are the types that carry rich results, which is exactly why fabricating them is the thing that gets a domain manually penalised.

### Per-page metadata for public content

Where the app has public content pages, each one exports its own:

```ts
export async function generateMetadata({ params }): Promise<Metadata> {
  const row = await getPublicRow((await params).slug);
  if (!row) return {};
  return {
    title: row.title,
    description: row.summary,
    alternates: { canonical: `/posts/${row.slug}` },
  };
}
```

The canonical is relative and `metadataBase` makes it absolute. It matters wherever one page is reachable at more than one URL — a slug that also answers by id, a listing paginated at `?page=`.

Return `{}` for a row that doesn't exist and let the page's own `notFound()` do the work; metadata that invents a title for a missing record is how a 404 ends up indexed.

## Verify

- Every app: `curl -s http://localhost:3000/ | grep -o '<title>[^<]*'` returns the app's real name. Not "Create Next App".
- Private branch: `/robots.txt` answers with `Disallow: /`, the root layout carries `index: false`, and there is no `/sitemap.xml` and no `/llms.txt`.
- Private branch: where the `noindex` switch lives is on the hand-off list, because it is what has to change if the app goes public.
- Public branch: `/robots.txt`, `/sitemap.xml` and `/llms.txt` each answer `200`.
- Public branch: no URL in the sitemap contains `/dashboard`, `/settings` or `/api`, and none of them redirects to sign-in when fetched cold.
- Every entry in the sitemap is a page that exists — compare it against the route sweep in `references/verify.md`, and check the other direction too: a public page that isn't listed is the more common miss.
- Every URL in the sitemap is absolute and shares one origin. No mix of `http` and `https`, no bare paths.
- No `public/robots.txt` or `public/sitemap.xml` shadowing the generated ones.
- The Open Graph image renders at `/opengraph-image` and shows the app's own name — not a placeholder, not a stock mockup.
- No structured data claims a rating, a review, a price, or an entity the app cannot back.
- The description on every page describes that page. No keyword lists, no feature the app doesn't have.
- `APP_URL` (or `BETTER_AUTH_URL`) appears on the system page's health card, and the hand-off says to point it at the real domain.
