# Design system

Last verified: 2026-08-24

**Purpose:** Turn the answer to the look-and-feel question into `DESIGN.md` at the project root, make it real as theme tokens rather than as advice, and point every agent that opens this project afterwards at it.

> **Read the `shadcn` skill before touching the theme.** Step 2a installed it. It is shadcn's own account of how their theme variables are structured and how a component consumes them — take the current syntax and file shape from it, and take from this file what goes in `DESIGN.md` and how it binds the rest of the build.

**Runs for every app, immediately after `references/stack.md`.** It needs the project to exist, and it has to land before the first screen is written — retrofitting a theme onto pages that already exist means editing all of them.

## Three ways in, one file out

The interview asked how it should look and got back one of three things. All three end at the same place: a `DESIGN.md` in the project root that the rest of the build is held to.

### They pasted something

A brand guide, a colour list, a `design.md` from another project, a screenshot, a font name, a link. **It wins outright** — used as given, not as inspiration. Their colours, their fonts, their spacing, their words for things.

- **Keep their structure and their wording** where the paste is already a document. Reformat only enough to make it usable — the goal is a file they recognise, not a file you rewrote.
- **Fill gaps in its spirit, and mark them.** Most pastes cover light mode and a brand colour and stop. Dark mode, focus rings, destructive colours, radius and an empty-state tone still have to be decided; decide them, and say which are yours in a *Filled in by the build* line at the end so the user knows exactly what to argue with.
- **A link you cannot read is not an answer.** A Figma URL, a private brand portal, a site behind a login: say so in one line and ask for the values — "I can't open that one; paste the hex codes and the font name and I'll take it from there." Do not guess a brand from its name, and do not scrape a live site for its colours unless the user asks for exactly that.
- **A screenshot is read for values, not copied.** Name the colours, the radius and the type you can see, play them back, and build from those.

### They described it in words

Turn adjectives into decisions before writing anything, and play those back. "Clean and modern" is something nobody can disagree with, which means they have agreed to nothing.

> "Calm and minimal, then: warm off-white background rather than pure white, near-black text, one muted green for buttons and links, soft corners, and a lot of whitespace. Inter for everything. Sound right?"

If they named a product — "like Linear", "like Notion", "like Stripe's docs" — take the *properties* and say what you took: the density, the neutral base, the radius, the type. Do not attempt a copy, and never use another company's colours, logo or wordmark.

### They said "you pick"

Propose. Do not ask a second question. Two or three named directions, one line each, with a recommendation and the reason — drawn from what the app *is*, since that is now known.

| Direction | Fits | What it means concretely |
| --- | --- | --- |
| **Quiet utility** | Developer tools, dashboards, internal tools | Cool grey neutrals, near-black text, one restrained accent, small radius, a geometric sans, dense spacing |
| **Warm editorial** | Journals, recipes, reading, anything personal | Warm off-white, ink-brown text, a serif for headings, medium radius, generous line height and margins |
| **Confident product** | A SaaS other people sign up for | White base, one saturated accent used sparingly, medium radius, a large type scale on the landing page and a calm one inside the app |
| **Playful** | Kids, hobbies, habit trackers, anything meant to be fun | A high-chroma accent, large radius, a rounded sans, bigger touch targets, warm empty states |
| **Premium dark-first** | Creative tools, music, analytics, anything watched at night | Near-black base with a luminous accent, medium radius, tight tracking — designed in dark and checked in light, not the other way round |
| **Institutional** | Finance, health, invoicing, anything holding money or records | Cool neutrals, a deep navy or green accent, small radius, restrained type, no decoration |

Recommend one in a sentence that refers to their app, not to design: *"For a hiking journal I'd go warm editorial — it should feel like a notebook, not like a dashboard. Or quiet utility if you'd rather it stayed out of the way."*

## Write `DESIGN.md`

At the project root, beside `package.json`. Short enough to be read every time and specific enough to be checked — decisions, not a style bible. Every value in it must exist as a token in `globals.css`; if the two disagree, the CSS is the bug.

```markdown
# Design system — <App name>

<One paragraph: what this app should feel like to use, and what it should not.
"A hiking journal should feel like a notebook — warm, unhurried, mostly text.
Not a fitness dashboard: no charts on the front page, no streaks, no badges.">

## Colour

Set in `src/app/globals.css`. Never write a colour in a component.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--background` / `--foreground` | <value> | <value> | Page base and body text |
| `--primary` / `--primary-foreground` | <value> | <value> | Primary buttons, links, the one thing per screen |
| `--muted` / `--muted-foreground` | <value> | <value> | Secondary surfaces, timestamps, help text |
| `--border` | <value> | <value> | Card and input edges, separators |
| `--destructive` | <value> | <value> | Delete only — never for emphasis |

## Type

- **Headings:** <font>, <weight>. Loaded in `layout.tsx` via `next/font`.
- **Body:** <font>, <size>/<line height>.
- **Scale:** <the four or five sizes this app actually uses, and where each appears.>
- Sentence case for headings and buttons, unless the direction says otherwise.

## Shape and space

- **Radius:** `--radius: <value>`. Everything inherits it; nothing sets its own.
- **Content width:** <max width>, centred, with <padding> on narrow screens.
- **Rhythm:** <the spacing steps in use — e.g. 4 / 8 / 16 / 24 / 48>. Stick to them.

## Components

- shadcn/ui, added as needed. A component that exists there is never hand-rolled.
- **One primary button per screen.** Everything else is `secondary`, `outline` or `ghost`.
- **Cards** group one concern each, with their own action. Not a card around every element.
- **Every list has an empty state** in the app's own voice — "no hikes yet, add your first one" — never a blank panel.
- **Every destructive action confirms**, and says what will be lost.

## Voice

<How the app talks: "plain, second person, no exclamation marks. Errors say what
happened and what to do next — 'that photo is over 5 MB, try a smaller one' —
never 'An error occurred'.">

## Never

- A hex, `rgb()`, or `oklch()` value inside a component. Tokens only.
- A font that isn't one of the two above.
- A one-off radius, shadow or spacing value.
- A colour that only works in one of the two modes.
```

Fill every `<placeholder>`. A `DESIGN.md` with a placeholder left in it is worse than none — it reads as a decision made when it wasn't.

## Make it real

A design document that the app doesn't obey is decoration. Two edits bind it:

1. **Tokens in `src/app/globals.css`.** Set the values in the `:root` and dark blocks shadcn wrote — the `shadcn` skill has the current shape of that file. Every token named in `DESIGN.md` gets its value here, in both modes. `--radius` is one line and changes the character of every component at once.
2. **Fonts in `src/app/layout.tsx`.** `next/font/google`, wired to the CSS variables the theme reads. Changing the font shifts the app's character further than any colour will, and it is a one-line change now and a tedious one later.

Then check both modes with real content in front of you. **An accent that is legible on white and invisible on near-black is the single most common failure here**, and it ships silently because the person who chose it was in light mode.

## Point the agents at it

Two files at the project root, both naming `DESIGN.md`, so that whatever opens this project next is bound by the same document — including a later session of this one.

`AGENTS.md` carries the project brief:

```markdown
# <App name>

<One line: what this app is, from the build sheet.>

**Design system: `DESIGN.md` in this directory. Read it before creating or changing
any page or component, and follow it — colours, type, spacing and radius come from
its tokens, never from a value written into a component.**

## Stack

Next.js (App Router) · TypeScript · Tailwind · shadcn/ui · Drizzle · <database>
<· Better Auth · and whatever else the build sheet included>

## Commands

<the project's own scripts: dev, build, db:generate, db:migrate, db:up if Docker>

## Conventions

- Schema changes go through `db:generate` then `db:migrate`. Never `drizzle-kit push`.
- <One line per rule from the build that a later agent would otherwise break —
  e.g. every query is scoped to the session user; agent tools go through `logged()`.>
```

`CLAUDE.md` beside it, short, pulling the same brief in rather than repeating it:

```markdown
# <App name>

See `AGENTS.md` for the project brief, stack and conventions.

@AGENTS.md

**Design system: `DESIGN.md`.** Every new page or component follows it. Colours,
type, spacing and radius come from the theme tokens — never a value hardcoded
into a component.
```

Keeping the content in one file and importing it is what stops the two drifting apart three months from now. Do not write the brief twice.

## Verify

- `DESIGN.md`, `AGENTS.md` and `CLAUDE.md` all exist at the project root, and the last two both name `DESIGN.md`.
- No `<placeholder>` remains in any of the three.
- Every token named in `DESIGN.md` has a value in `globals.css`, in **both** light and dark blocks.
- `grep -rEn '#[0-9a-fA-F]{3,8}\b|rgb\(|oklch\(' src --include='*.tsx'` returns nothing. The only sanctioned exception in the whole app is the unfilled-field marker in `references/legal.md`, which is deliberately hardcoded so it cannot blend in.
- The fonts named in `DESIGN.md` are the fonts loaded in `layout.tsx`, and no other font is imported anywhere.
- The app renders in light and dark, and the primary colour is legible against both backgrounds.
