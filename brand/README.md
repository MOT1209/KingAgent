# The KingAgent mark

A K, because the letter is already the product: one spine, arms leaving it from a
single junction — one workspace, several agents running out of it. The only
element carrying colour is the block in the letter's mouth, and it is a terminal
cursor: the agent that is live right now. That is also why the mark replaced the
one it inherited. The previous mark was Nami's — a wave creature, `nami` being
Japanese for wave — and it said nothing about this app; its coral was also close
enough to Claude's own that KingAgent read as somebody's client rather than a
platform.

## Construction

64×64 frame, 4-unit module, so every straight edge lands on a whole device pixel
at 16px instead of rendering as a permanent half-grey column.

| | |
|---|---|
| spine | `x 8→20`, `y 8→56` (12u wide) |
| arms | stroke 12u from the junction at `20,32` to `46,10` and `46,54` |
| cursor | `x 48→56`, `y 24→40` (8×16u) |
| clearance, cursor to arm | 7.8u (floor is 6u) |
| accent share of total ink | ~9% (ceiling is ~10%, past which an accent becomes the subject) |

Ink is centred in the frame on both axes. The cursor's own left edge sits far
enough right that the arm above it has already climbed clear — that is what buys
the clearance, and it is why the cursor is not a square: a 12×12 square centred
on the junction lands its edges on half-pixels at 16px, and a 12×8 bar reads as
a hyphen next to the letter.

## Colour

| token | value | where |
|---|---|---|
| accent | `#F5A524` | the cursor, every desk |
| ink | `#0B0C0E` / `#FAF9F7` | letter, dark or knocked out |

One accent value on every desk, deliberately. The first cut used a darker amber
(`#9A6206`) on the light desks, picked for contrast against the *ground* — and in
the running app it read as a brown sliver, because what the block has to separate
from is the near-black ink beside it, not the paper behind it.

Amber is the name (King → gold) and the medium (terminal phosphor) at once, and
it stays clear of the field: Warp and Kiro own purple, Windsurf teal, Claude the
coral this app used to wear.

## The desks

The accent runs through the whole UI, not just the mark: every desk that used
Nami's coral (`#ef6461`) now takes amber — primary actions, live dots, focus
glows, the glass and graphite auroras. Two things were untangled on the way:

- **Danger got its own hue back.** These desks had collapsed "run this",
  "delete this" and "needs you" onto the single coral, so a destructive button
  was the same colour as the primary one. Danger is now a true red
  (`#D94A3D`), and the amber family is amber.
- **Amber buttons take dark ink.** White on `#F5A524` is ~2:1 and the label
  stops being a label; `#10131A` on it is ~10:1. Where the accent is *text* on
  a light ground the desks use `--accent-text` (`#9A6206`), because soft and
  dusk share one rule across a white ground and a dark one.

The paper desk is deliberately untouched: its primary action was always a real
green on cream, never Nami's coral, so there was nothing borrowed to replace.

## Files

| file | use |
|---|---|
| `final/kingagent-mark.svg` | master — `currentColor` ink, `--mark-accent` cursor |
| `final/kingagent-mark-ink.svg` | flat, for light grounds |
| `final/kingagent-mark-knockout.svg` | flat, for dark grounds |
| `final/kingagent-mark-mono.svg` | one colour — stamps, embroidery, faxes |
| `final/kingagent-icon.svg` | the plated app icon |
| `final/kingagent-icon-round.svg` | circular masks — avatars clip against ink radius, not the bounding box |

The mark also lives inline in `src/renderer/app.js` (the topbar lockup); the two
are the same geometry and must move together.

## Regenerating the rasters

```bash
node brand/scripts/make-icons.mjs     # → build/icon.png (1024), build/icon.ico (16…256)
```

Needs Chrome installed. `scripts/preview.mjs` and `scripts/sheet.mjs` render a
mark on both grounds, in one colour, and down a size ladder to 12px — run one of
them and *look at the result* before believing any change to this mark is an
improvement. Every rejected concept in this mark's history was rejected because
it was rendered and looked at, not because it read badly as a description.

## Known open items

- The 16px ico entry is downscaled from the 1024 master rather than drawn for
  that size. It is legible, but the letter is cramped inside the plate; a
  dedicated small-size variant with ~15% less plate padding would be sharper.
- No trademark search has been run against existing `K` marks in developer
  tooling — Kotlin and Kiro (AWS's agentic IDE, a direct competitor) are the two
  that matter. Do this before using the mark commercially.
- The wordmark is untouched: the topbar still sets it in the desk's own face.
