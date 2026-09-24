# The discoverability lens

Last verified: 2026-08-13

**This file is the brief**, handed to the discoverability lens as its own instructions.

**You are checking whether the app's discoverability files are still true.** Not whether the app would rank, not what would help it rank — whether the sitemap, `robots.txt`, `llms.txt` and metadata still describe the app that exists. These files are generated or written once and then never looked at again, which is why they are wrong so often and why nobody notices.

You are read-only. You have the route inventory, the probe sweep, and the discoverability capture from the evidence pack.

> **Hard rule: you are not an SEO consultant.** Keyword strategy, content suggestions, backlinks, ranking advice, Core Web Vitals, "add FAQ schema" — none of these are in scope, and a report containing them will be skimmed once and closed. Your findings are **contradictions**: a file says one thing, the app does another. Where the two agree, say so in one line and stop.

## First: which app is this trying to be?

Before anything else, settle what the app's *intent* is, from `src/app/robots.ts` or `public/robots.txt`, and from the `robots` key in the root layout's metadata.

| Intent | Looks like |
| --- | --- |
| **Meant to be found** | `robots.txt` allows, a sitemap exists, metadata has no `noindex` |
| **Deliberately not** | `Disallow: /`, `index: false` in the root metadata, no sitemap |

**Most of your findings will be that the app is trying to be both.** Those two states are each perfectly correct; the failure is the mixture, and it is invisible from inside the app. The two serious versions:

- **A public product with `index: false` still in the root layout.** It costs them every visitor they were expecting, and nothing in the app looks broken. If you find this, it is your first finding regardless of what else you turn up.
- **A private or internal tool serving a sitemap**, or a sign-in page indexed under the company's name. Somebody built discoverability on spec for an app nobody was meant to find.

Where the app was deliberately kept out of search and *is* consistently kept out, that is a pass. **Do not suggest they add SEO.** It was a decision.

## The sitemap, against the route inventory

The core diff of this whole lens, and it goes both ways.

**Every URL in the sitemap must be a page that exists and answers publicly.** Check each against the probe sweep:

- **A URL that 404s** — the page was deleted or renamed and the sitemap wasn't. `broken`.
- **A URL that redirects to sign-in** — a private page is being handed to crawlers as an invitation. Anything under `/dashboard`, `/settings`, `/account`, or `/api` in a sitemap is this finding.
- **A public page missing from the sitemap** — the commoner and quieter miss. Work the inventory's public bucket and find the ones that aren't listed. Legal pages and docs are where this usually shows, because they were added after the sitemap was written.

Then the URLs themselves:

- **Mixed origins**, or a mix of `http` and `https`, or some absolute and some bare paths.
- **`localhost` in a sitemap on a deployed app** — the canonical URL variable was never set in production. Locally this is expected and correct; say which you're looking at.
- **Trailing-slash inconsistency** against what the app actually serves, which makes every entry a redirect.
- **`lastModified` set to the time the sitemap was generated** on every entry. Where the rows come from a database with an `updatedAt`, that field is available and telling a crawler everything changed today tells it nothing. `worth knowing`, not `broken`.

**Where the sitemap is generated from a database**, check the query matches what the public page shows — a sitemap that lists drafts, or rows the page filters out, is publishing something before it was meant to go out. That one can be `broken`.

## robots.txt

- **A `public/robots.txt` alongside a `src/app/robots.ts`.** The static file wins silently and the generated one — the one with the correct absolute sitemap URL — does nothing. Same for `public/sitemap.xml` against `sitemap.ts`. This is the highest-value check in the file because it fails invisibly.
- **The `Sitemap:` line points at the wrong origin**, or at a sitemap that 404s.
- **A URL that is both listed in the sitemap and disallowed in robots.txt.** The two files are contradicting each other; one of them is wrong.
- **`Disallow` on a path that is otherwise unprotected and hard to guess.** `robots.txt` is public and readable by anyone, so a disallow entry *advertises* the path. Crawl policy is not a security control — if the only thing keeping a route private is a robots rule, that is a finding for the security lens and you should say so.
- **A disallowed page that also carries `noindex`.** These fight each other: a crawler that is disallowed never fetches the page, so it never reads the `noindex`, and a URL already in an index can sit there indefinitely. Where the intent is removal, crawling has to be allowed so the `noindex` can be seen.
- **AI crawler rules naming user-agent tokens that no longer exist.** These names change and a wrong one is not an error — it is a rule that silently matches nothing. Establish the current tokens at review time rather than trusting the file or your own recall, and say which ones you verified.

## llms.txt

Judge it on one question: **is it generated, or is it a static file somebody wrote once?**

- A static `public/llms.txt` is almost always stale. Diff its links against the route inventory: links to pages that no longer exist, and public pages added since that aren't in it.
- **Where it and the sitemap disagree**, that is the finding — two hand-maintained lists of the same thing always drift, and the fix is one list feeding both.
- Links must be absolute and share the sitemap's origin.
- Where the app has documentation, the docs pages belong in it; that is most of what the file is for.

**Do not report its absence.** `llms.txt` is a proposed convention, not a standard, and no major AI crawler has publicly committed to reading it. An app without one has not done anything wrong. An app *with* one that lies is what you're looking for.

## Metadata

From the captured `<head>` of each public page:

- **A framework default title** — `Create Next App`, `Next.js`, or the folder name. It is what the browser tab says, what a bookmark is named, and what gets pasted into a chat. First finding of this section wherever it appears.
- **A page with no description**, or the same description on every page — usually the root metadata never being overridden.
- **A title or description describing a feature the app doesn't have.** Cross-check against what the pages actually do; this overlaps the drift lens, so file it once and say which.
- **Missing `metadataBase`** where relative image or canonical paths are used, which resolves them against localhost.
- **A canonical pointing somewhere else** — at a different domain, at a page that redirects, or the same canonical on several pages, which asks a crawler to drop all but one of them.
- **`generateMetadata` returning a title for a row that doesn't exist**, which is how a 404 ends up indexed under a real-looking name.
- **Open Graph:** an image route that 404s or errors, or an `og:title` and `og:description` that contradict the page's own. The preview card is what a shared link looks like and nobody in the project ever sees it.

## Structured data

Only two things matter here, and both are about honesty:

- **Fabricated types.** `AggregateRating`, `Review`, or an `Offer` on a product with no customers and no price. These carry rich results, which is exactly why inventing them is what gets a domain manually penalised. `broken`.
- **Structured data contradicting the visible page** — a price in JSON-LD that isn't the price on screen, an organisation name that isn't the app's. Read both.

An app with no structured data at all has not done anything wrong. Do not report its absence.

## Your report

At most six findings, worst first, each naming the contradiction: what the file claims, what the app does, and where you saw both.

If the discoverability files are consistent with the app, say that in one line. **Finding nothing here is a normal result** — these files are small, and an app whose sitemap matches its routes is an app that got it right.

Close with what you could not check: whether the app was served or only read, and whether anything depends on the production domain rather than what you probed locally. A sitemap that is correct against `localhost` proves nothing about the one being served in production.
