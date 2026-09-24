# Designing the Mark — the creative playbook

Read this before drawing anything. It exists because two failure modes dominated earlier
runs of this process: marks that came out **blocky** (built on a coarse pixel grid,
curve-phobic, favicon constraints applied to the master mark) and marks that came out
**broken** (hand-authored bézier/arc paths that drew something the designer never
intended). Both are construction problems, not talent problems, and both are avoidable.

## 1. From personality to style route

Compress the brand's personality into three adjectives plus one "but not" (e.g. "precise,
calm, senior — but not cold"). Every design decision downstream answers to those four words.

Then choose concept routes from this menu. A concept round runs 3–4 designers, each locked
to ONE route — the routes are how you get genuine variety instead of four flavours of the
same idea.

| Route | What it is | When it wins | Its dangers |
|---|---|---|---|
| **Wordmark-led** | The name set in a well-chosen face, made ownable by one deliberate intervention, plus a monogram derived from it for icon contexts | Most young companies — the name IS the asset, and typography gives you a high quality floor for free | Timid customisation = generic; three interventions = gimmick. Make ONE change, confidently |
| **Monogram** | 1–2 letters, custom-drawn or font-derived with distinctive construction | Long names; brands people say as letters | Generic letter outlines are legally weak; check letter-adjacent competitors first; run the delete test (review.md) |
| **Geometric abstract** | A composition of primitives expressing ONE idea | Brands whose story has a spatial form: flow, connection, precision, growth | Strip-tests into a UI glyph; decoration mistaken for meaning. Hardest route — never give it more than one designer |
| **Pictorial** | A real object from the brand's world, simplified into distinctive geometry | Concrete domains — a bakery, a boat, a bird, a mountain town | Clip-art blandness; the cliché list (review.md) |
| **Name-device** | A gift hiding in the name itself — the FedEx arrow, a ligature, a double reading | When the name genuinely offers one | Forcing it. Always *check* for the gift during research; take it only if it is really there |
| **Emblem / badge** | Type and mark bound in a containing shape | Heritage, craft, food & drink, apparel | Dies at 16px — must ship with a simplified companion mark |

Include the wordmark-led route in most rounds: it has the most reliable floor, and its
derived monogram frequently beats dedicated abstract concepts.

## 2. Construction — geometry that cannot come out blocky or broken

**Work in a roomy frame.** Master mark: `viewBox="0 0 512 512"`. Decimals welcome, curves
welcome. Do NOT design the master on a favicon grid — small-size crispness is solved later
by a derived variant (§4), never by making the master chunky.

**Build from primitives, not freehand paths.** `<circle>`, `<rect rx>`, capsules (thick
stroked lines with round caps), regular polygons. Compose by overlap — same-fill shapes
merge visually into one silhouette, so a complex form is many simple elements, not one
heroic path. Cut holes as *real* holes: `fill-rule="evenodd"` with a reversed subpath.
A paper-coloured patch is not a hole — it shatters the moment the mark sits on a photo.

**Strokes are the highest-craft tool available to you.** A line-art mark with ONE uniform
stroke weight and deliberately stated caps/joins (`stroke-linecap`, `stroke-linejoin`)
reads as professional almost automatically, because consistency of weight *is* most of
what people perceive as craft. Elegant range in a 512 frame: 28–56 units. Never mix
stroke weights without a stated reason.

**Arc discipline.** Hand-written `A` commands with guessed sweep/large-arc flags are the
single biggest source of broken marks. Prefer whole `<circle>`s composed by overlap and
evenodd holes. If you must write an arc command, render immediately after writing it and
look — do not stack three unverified arcs and debug the wreckage.

**A proportion system.** Choose two or three base measures (a big radius, a stroke weight,
a gap) tied by simple ratios, and derive every other dimension from them. State the system
in your construction notes. Eyeballed one-off dimensions are where lopsidedness comes from.

**Symmetry by transform.** If the mark has repeated or mirrored elements, draw one and
place the rest with `transform="rotate(...)"` / `scale(-1,1)`. Hand-copied coordinates
drift; transforms cannot.

**Optical corrections** (apply after the geometry is right): round forms overshoot flat
edges by ~1–2% or they look smaller; a mark centred by bounding box in a square container
usually looks low and left — nudge toward the centroid (optics.py reports both); at equal
weight, curves look slightly thinner than straights.

**Render and look — the keystone.** `node build/preview.mjs <file.svg>`, then Read the PNG
and write down what you SEE — at full size, at 16px, in mono, in the circular crop.
Minimum three draw→render→look cycles; most of your effort belongs here. In earlier runs,
designers who skipped this shipped drawings that contradicted their own descriptions every
single time. A mark you have not looked at is a mark you have not designed.

## 3. What "good" looks like

The review process (review.md) is a list of ways to fail; this is the bar to aim at.

- **One idea.** A mark can carry one idea. Two ideas = zero ideas.
- **A clean, nameable silhouette.** Squint. Fill it black. Is the outline distinctive
  enough to recognise, and could you describe it in one sentence a stranger could redraw
  it from? (Write that sentence — the *phone test* — before you construct.)
- **Confident weight.** Bold enough to hold a wall; consistent enough to feel machined.
- **Balanced ink.** No orphan elements floating free of the composition; no side visibly
  heavier without intent.
- **Appropriate character.** Check the three adjectives. A playful mark for a law firm and
  a solemn mark for a bakery are both craft failures.

## 4. The small-size variant — derived, not designed-first

After the master is approved, derive the favicon/small-size variant from it. At a 16px
render: every gap ≥ 1.5 device px, every stroke ≥ 2 device px, enclosed counters ≥ 5
device px across (or vented to the silhouette), fine details dropped rather than shrunk.
Thicken strokes, widen gaps, simplify — the small variant is a *bolder sibling*, not a
scaled copy. Then name what the 16px render reads as, out loud, from the render
(review.md). The master mark stays elegant; the small variant does the favicon work.

## 5. Typography

Pick from quality open fonts (Google Fonts, variable where possible) by personality:

| Personality | Faces to reach for |
|---|---|
| Neutral, modern, SaaS | Inter Tight, Manrope, Schibsted Grotesk |
| Geometric, technical, engineered | Space Grotesk, Sora, Outfit, Chivo |
| Friendly, human, approachable | Nunito Sans, Albert Sans, Figtree |
| Editorial, premium, considered | Fraunces, Newsreader, Source Serif 4 |
| Loud, characterful, display | Bricolage Grotesque, Unbounded, Archivo (width axis) |
| Technical accent / code | JetBrains Mono, IBM Plex Mono, Space Mono |

For the wordmark: outline the real font (`scripts/outline.py` — real kerning, true ink
bounds), then earn ownability with ONE deliberate intervention — a cut terminal, a shared
stroke between two letters, one modified glyph, an accent-coloured element. One change,
not three. Ship the system with a display face and a text face, named in the guidelines.

## 6. Palette

- **Ink + paper:** a near-black and an off-white chosen for the brand (never pure #000 on
  pure #FFF unless brutalism is the point).
- **ONE accent** plus a designated darker twin for the ground it fails on. The accent must
  clear WCAG 4.5:1 on at least one canonical ground — compute and state both ratios.
- **Flat colour is the primary system.** A gradient may exist as an optional *skin* on the
  large master mark if the brand wants it, but it is never structure: every deliverable
  must work flat, and the flat versions are the primary files. (A gradient averages to mud
  at 16px and cannot be embroidered.)
- Verify any "this colour position is unclaimed in the category" claim against the actual
  competitor set — that claim has been confidently wrong before.

## 7. Designer agent prompt skeleton

Every designer prompt begins with mandatory reading:

```
Read, in this order, before doing anything:
1. <workdir>/brand/BRIEF.md            — company, personality, tokens, quality bar
2. <skill>/references/design.md        — construction rules and the quality bar
3. <workdir>/brand/LAW.md              — if it exists: kill conditions from failed rounds
```

Prompt skeleton:

```
You are a senior identity designer at a top-tier studio.

YOUR ROUTE — <route name from the menu>
<one paragraph: the idea-space, and the specific dangers listed for this route>

PROCESS — in this order; the order is the point:
1. Write 8–10 one-sentence PHONE TESTS inside your route — ideas a stranger could
   redraw the mark from. Ideas only, no coordinates.
2. Cull against review.md's kill list. Pick the strongest survivor; say why.
3. Construct it: 512×512 frame, primitives-first, a stated proportion system
   (design.md §2 — follow it exactly; it exists because of past failures).
4. Write the SVG to <concepts-dir>/<slug>.svg.
5. RENDER AND LOOK: node <build>/preview.mjs <file>. Read the PNG. Report what you
   SEE at full size and 16px — not what you intended.
6. Fix what you saw. Re-render. Minimum three cycles; most of your effort goes here.
7. Derive nothing else yet — the small-size variant comes after selection.
8. Self-attack for one paragraph; the strongest objection goes in knownWeakness.

Colour: flat <ink/paper> with at most ONE element in <accent>, and that element must be
the one carrying the brand's core meaning. No gradients in concept files.
```

Schema (StructuredOutput):

```json
{ "slug": "", "route": "", "oneLiner": "", "phoneTest": "",
  "whatIActuallySawAt16px": "reported from the RENDER; a description of intent voids the submission",
  "renderCycles": 0, "proportionSystem": "the base measures and ratios used",
  "construction": "geometry precise enough for a stranger to rebuild",
  "whyItBeatsTheAlternatives": "", "knownWeakness": "" }
```
