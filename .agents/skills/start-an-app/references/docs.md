# Public documentation

Last verified: 2026-08-13

**Purpose:** A small set of pages that explain the app to the people using it, readable without signing in, living in the same project and wearing the same design as everything else.

**Only where the interview chose it.** Most apps built here don't need documentation and shouldn't have any: a personal tool has one user who already knows how it works, and an internal tool's docs are usually a message to three colleagues. Where the app is a product strangers sign up for — especially one that takes money — a handful of honest pages is the difference between an email and a self-serve answer. Ask there, don't ask anywhere else.

> **Hard rule: every page documents something a person can do in the app today.** No "Coming soon", no page for anything on the *not in version one* list, no API reference for endpoints that don't exist, no screenshot of a screen nobody built. A landing page that oversells is a marketing problem; documentation that oversells is somebody following your instructions, not finding the button, and concluding the product is broken. Where the honest version is four pages, ship four pages.

## How big

**Four to six pages.** That is not a starting point to grow from during the build — it is the size that stays true. Documentation is the fastest-rotting thing in a codebase, and every page written now is a page that has to be corrected the first time a screen changes.

One page always exists, and the rest are earned by branches that actually ran:

| Earned by | The page |
| --- | --- |
| Always | **Getting started** — the first real thing somebody does, end to end, in the app's own words |
| Always | **How it works** — the app's nouns and what they're for. Short; this is the page that stops support questions |
| `references/payments.md` | **Plans and billing** — what each plan includes at its real price, how to cancel, what happens to their data afterwards |
| `references/mcp.md` | **Connect an AI assistant** — the connector URL, what each tool can do, and how to revoke it. The connector URL is otherwise buried in settings, so this is the page people will actually arrive looking for |
| `references/storage.md` | Uploads, but only where there are real limits worth stating — file types, size caps, what happens to files when an account is deleted |
| `references/ai.md` | What the AI feature does, and plainly that what they type reaches a model provider |
| `references/jobs.md` | Only where a person waits on something — "an import takes a few minutes and you'll get an email" |
| Contact address is set | **Getting help** — where to write, and what to include |

`references/email.md` and `references/auth.md` earn nothing on their own. Signing up and resetting a password are the two flows every person on the internet already knows; a page explaining them is filler that makes the real pages harder to find. The exception is a sign-in that genuinely surprises people — an invite-only app, or one where Google is the only way in.

**Do not write a page for a branch that didn't run.** A billing page in an app with no payments is the docs version of an empty Settings tab.

## Where it lives

Its own route group, so the pages share one layout and stay reachable signed out:

```
src/app/(docs)/docs/page.mdx                     → /docs
src/app/(docs)/docs/getting-started/page.mdx     → /docs/getting-started
src/app/(docs)/layout.tsx                        → sidebar + the app's own header and footer
```

**Never inside `(dashboard)`.** These pages are for people deciding whether to sign up as much as for people already in, and a docs link that bounces a stranger to sign-in is worse than no docs link.

Link them from the header and the footer both. Someone reading the landing page and someone stuck mid-task look in different places.

**No docs framework.** Not Fumadocs, Nextra, Docusaurus, or a hosted platform — they are all good, and every one of them is a second design system, a second deploy, and a second place the product's name has to be updated. Six pages do not earn that. These are pages in the app, built from the components already installed, deployed by the same push, and wearing the theme `DESIGN.md` set. If the app ever grows into hundreds of pages, moving out is the right call then and the markdown comes with it.

## Wiring MDX

MDX is markdown that can render the app's own components, which is what stops the pages looking like a different website. It needs the MDX packages, a `next.config` that accepts `.mdx` as a page extension, and one component-mapping file. The installed `vercel-react-best-practices` skill and Step 2b's research supply the current package names and config shape — the wiring below is the arrangement, not the API.

**A page is a file, exporting its own metadata:**

```mdx
export const metadata = {
  title: "Getting started",
  description: "Log your first hike in under a minute.",
};

# Getting started

...
```

The `title` flows into the `%s · TrailLog` template that `references/seo.md` sets on the root layout.

**Style the pages once, in `mdx-components.tsx`**, by mapping each markdown element to the app's own typography — the same way `references/pages.md` puts the visual direction in one place rather than scattering it. Mapping `h1`, `h2`, `p`, `ul`, `a`, `code` and `pre` covers everything these pages use. A typography plugin is a reasonable shortcut if the direction suits it; hand-mapped elements match the rest of the app more closely and add no dependency.

That file is also where a `<Callout>` or a `<Steps>` component becomes available inside every page, built from the shadcn pieces already installed. Add one only when a page needs it.

## One manifest

The sidebar, the sitemap and `llms.txt` all need to know what pages exist and in what order. Deriving that from the filesystem is more machinery than six files deserve, and maintaining three copies of the list guarantees they disagree.

`src/lib/docs.ts`:

```ts
export type Doc = { slug: string; title: string; summary: string; group: string };

export const docs: Doc[] = [
  { slug: "getting-started", title: "Getting started", summary: "Log your first hike.", group: "Basics" },
  { slug: "how-it-works", title: "How it works", summary: "Hikes, photos, and who can see them.", group: "Basics" },
];
```

The sidebar renders it grouped, in this order. Then feed the same list into `src/lib/site.ts` from `references/seo.md`, so every doc page lands in the sitemap and in `llms.txt` without a second list:

```ts
export const publicPages: PublicPage[] = [
  { path: "/", title: site.name, summary: site.description },
  ...docs.map((d) => ({ path: `/docs/${d.slug}`, title: d.title, summary: d.summary })),
];
```

`summary` earns its place three times over — the sidebar tooltip, the `llms.txt` line, and the page's own meta description. Write it as a sentence, not a label.

**An entry with no file, or a file with no entry, is the failure this arrangement has.** It costs one check to catch and it is in the Verify list below.

## Writing them

- **The app's own words, throughout.** The same nouns and verbs as the interview, the landing page and the legal pages. Documentation calling a hike an "entry" is the same tell as a privacy policy about "user-generated items".
- **Second person, present tense, one task per page.** "Open Hikes and choose Add" — not "the user may then proceed to".
- **Every instruction names something that is on screen.** A button label, a page name, a menu item. If you can't name it, the page is describing an app you didn't build.
- **Start with the task, not the concept.** People arrive mid-problem. The explanation belongs under the steps, if it belongs at all.
- **A screenshot is a maintenance cost with a picture attached.** Only where words genuinely fail, and only of a screen that actually exists.
- **Date the pages.** A visible "last updated" is honest about staleness, and the first thing a reader wants when an instruction doesn't match what they see.

**Writing the docs is the app's second review.** If a page is hard to write because the flow needs four paragraphs to explain, that is a finding about the app, not a paragraph to word around — tell the user at hand-off rather than documenting the confusion.

## What must never appear

These pages are served to anyone, indexed by `references/seo.md`, and read by AI crawlers. Everything on them is public forever.

- **No key, token, or connection string**, real or "example". A realistic-looking fake key gets pasted into a real config by someone in a hurry; a real one is a leak. Where an example needs one, make it obviously unusable.
- **No real user data.** Not in a screenshot, not in a sample response, not as an example email address that belongs to somebody.
- **No admin screen.** `/settings/system` is not a feature the public documentation describes.
- **No internal URL** — a staging host, a dashboard on somebody's account, a database console.
- **Nothing about how the app is deployed or hosted.** That is the user's operational detail, not their customers' business.

```bash
grep -rniE 'sk-|pk_|api[_-]?key|postgres://|localhost:[0-9]|\.vercel\.app' src/app/\(docs\) || echo "clean"
```

## Not in a first version

Say these out loud rather than leaving them as gaps:

- **Search.** A search box over six pages is theatre; the browser's own find does it better. It earns its place somewhere past twenty pages.
- **Versioning.** There is one version of the app. Versioned docs are a structure to maintain in exchange for nothing.
- **Translations.** One language, done well.
- **A changelog.** Only if the user wants one and will actually write it. An abandoned changelog dates the whole product.
- **An API reference**, unless the app genuinely has a public API. Where `references/mcp.md` ran, the tools page *is* the reference, written in the app's words rather than as a schema dump.

## Verify

- Signed out, `/docs` and every page in the manifest answer `200` — not a redirect to sign-in.
- Every entry in `src/lib/docs.ts` has a file, and every `page.mdx` under `(docs)` has an entry.
- Every page documents something that exists: follow one page's instructions against the running app and confirm each named control is really there.
- No page describes anything on the sheet's *not in version one* list.
- Only branches that ran have pages — no billing page without payments, no uploads page without uploads.
- Every doc page appears in the sitemap and in `llms.txt`, via `publicPages`.
- The grep above is clean: no keys, no real addresses, no internal hosts, no admin screens.
- The pages use the app's own nouns and verbs, matching the landing page and the legal pages.
- Docs are linked from both the header and the footer, and every link in them resolves.
- The pages render in light and dark mode and at a narrow viewport, like the rest of the app.
