# Deliverables: Manifest, Technical Contract, Construction Maths

## SVG technical contract (every file)

- Pure vector: no filters, no blurs, no `<image>`, no live `<text>`, no external fonts.
- Explicit `width` + `height` matching the viewBox, `role="img"`, and a `<title>` — without
  width/height an `<img>` falls back to 300×150 and letterboxes, and Office/Slides mis-size
  viewBox-only SVGs on import.
- Ids prefixed per-asset (inlining two files with duplicate gradient ids corrupts both).
- Counters as real holes via `fill-rule="evenodd"` subpaths, verified in more than one renderer.
- No gradient anywhere unless the brand system explicitly kept one (default: flat colour only).

## The manifest

```
svg/mark/       mark-dark, mark-light, mark-mono-<light>, mark-mono-<dark>, mark-accent
                (tight artboard, the mark's own bounds)
svg/wordmark/   wordmark-dark/-light/-mono-*  — outlined from the font, accent letters
                as their own path group
svg/lockup/     lockup-horizontal-dark/-light, lockup-stacked-dark/-light
svg/icon/       icon-square-*, icon-app-* (plated), icon-avatar-* (round-safe),
                icon-adaptive-foreground/-background/-preview, favicon.svg (+ explicit
                dark/light overrides)
svg/themed/     inline-only variants: currentColor + var(--accent)
png/            favicon 16/32/48 · apple-touch 180 · app 192/512/1024 · adaptive 432 ·
                avatars 400/800 · marks 512/1024 · lockups at 1x/2x widths
README.md       pick-the-right-file table, themed-variant CSS snippet, circular-mask
                warning, favicon <link> block, colour/type/clear-space spec, honest
                known-open-items
guidelines.html generated spec page (below)
mockups/        optional — AI merch mockups via the Codex CLI (see "Merch mockups")
```

Package as `<company>-brand-kit/` and zip.

## Construction maths that must not be re-derived by guesswork

**Lockup baseline rule.** The mark's flat foot sits ON the wordmark's baseline (flat edges on
the baseline; only round forms overshoot, by ~1u). Never centre the mark on the wordmark's
bounding box — bbox-centred lockups reliably ship with the mark visibly oversized. Size the
mark from a *stated geometric relationship*, e.g. "mark height such that its dominant round
form equals cap height exactly"; derive the number, then write the derivation into the spec.

**Wordmark metrics.** Outline with fontTools (`scripts/outline.py`): instantiate the weight
from a variable font, apply GPOS kerning, flip Y, normalise so cap height = 100 units,
baseline = 0. Measure the TRUE ink extremes with BoundsPen (ascender ≠ tallest glyph;
descenders vary) — the viewBox must wrap measured ink, not font metrics.

**Ink radius / round-safe icons.** Compute max distance from bbox centre to any ink
point (check every arc extreme and every corner — the farthest ink is often a stem corner,
not the obvious bowl). Scale so all ink fits:
- avatars: inside r = 27 of the 64-frame's r = 32
- Android adaptive foreground: inside r = 20 (~66dp guaranteed circle); ship background
  layer + composed preview separately
Centre geometrically for circular crops (the crop is geometric); centre optically
(bbox↔centroid blend, ~0.35 bias) for square containers. Verify by rendering under circle,
square, AND squircle masks before packaging.

**Self-theming favicon.** One `favicon.svg` whose fills come from CSS custom properties in an
embedded `<style>`, with a `prefers-color-scheme: dark` override. A favicon has no
surrounding document, so `currentColor` does not work there — the file must carry its own
theme. Without this, a light-mark favicon on a light tab strip renders ~1:1 contrast and the
only visible pixels are the accent element. Also emit explicit -dark/-light override files
and PNG fallbacks:
```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/png/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/png/apple-touch-icon-180.png">
```

**Themed variants.** Letterform `fill="currentColor"`, accent `fill="var(--accent)"`.
Document loudly: inline-only — as `<img>`/background they render black.

**PNG rendering.** Headless Chrome: `--screenshot --window-size=W,H`, with
`--default-background-color=00000000` for transparency. Wrap the SVG in a minimal HTML page
with the SVG sized via CSS (the explicit width/height attributes will otherwise fight you).

## The generated guidelines page

Generate `guidelines.html` programmatically FROM the shipped assets — inline the real SVGs,
draw the construction plate from the real geometry with dimension lines, compute the stated
measurements from the files. The page then cannot drift from what ships, and every revision
regenerates it for free. Include: the idea (one screen, the phone test verbatim);
construction plate with dimensions; clear-space + minimum sizes (digital px, print mm,
embroidery mm); colour table with computed contrast ratios and the accent-discipline rule;
typography; lockups with the baseline rule stated; variants and when each applies; circular-
mask section with the ink-radius number; misuse list; asset index; an honest "how it was
made / known limitations" section; and — if merch mockups were generated (below) — an
"in the world" gallery of the surviving images, captioned as AI visualisations rather
than print proofs.

**Gallery images must be clickable to full screen.** Use a native `<dialog>` lightbox —
no libraries, so the page stays self-contained: thumbnails get `cursor: zoom-in`, a click
opens the image as large as the viewport allows (`max-width/max-height` ~95vw/95vh,
`object-fit: contain`, dark backdrop), and clicking anywhere or pressing Esc closes it
(`<dialog>` gives Esc for free). The pattern, in full:

```html
<dialog id="lightbox" onclick="this.close()"><img alt=""></dialog>
<script>
  document.querySelectorAll('.mockup-gallery img').forEach(t => t.onclick = () => {
    const d = document.getElementById('lightbox');
    d.querySelector('img').src = t.dataset.full || t.src;
    d.showModal();
  });
</script>
```

In the kit copy, `data-full` can point at the full-resolution `mockups/<slug>.png` while
the thumbnail is CSS-constrained; in the Artifact publish both are the embedded data URI. Subset the brand font to a data-URI `@font-face` (~9KB
per weight via fontTools subset → woff2) so the page is self-contained. Theme-aware via
`prefers-color-scheme` with `[data-theme]` overrides. Publish as an Artifact when available;
always also ship the file in the kit.

## Merch mockups (optional — requires the Codex CLI)

Offer only when `codex --version` succeeds, and only run after the user says yes (it takes
time and uses their Codex account). These are AI-generated visualisations for taste-testing
the identity in the world, not print proofs — label them as such in the README.

**Reference image.** Codex image generation accepts reference images via `-i`. Pass the
largest kit PNG whose colourway matches the surface: knockout (light-on-dark) art for dark
garments, dark-on-light art for light garments and paper. Stacked lockup for chest prints
and cards; bare mark for caps and embroidery.

**Prompt template.** Two parts are load-bearing: the faithful-reproduction instruction, and
*verbal redundancy* — describe the artwork in words as well as attaching it, and spell the
name out explicitly. Image models mangle wordmarks; the spelling line is what catches it.

```
codex exec -s workspace-write --skip-git-repo-check "Generate a photorealistic e-commerce
apparel product photo and save it to <kit>/mockups/<slug>.png. Scene: <scene>. The
attached image is the exact logo artwork: reproduce it faithfully <application>, about
<width> wide — <verbal description: the mark's elements and colours, and which letters of
the wordmark are accent-coloured>. Spelling must be exactly '<name>'. <finish>. Portrait
orientation." -i <kit>/png/<reference>.png
```

Two CLI traps, both hit in real runs — get them right the first time:

- **`--skip-git-repo-check` is required.** Codex refuses to run in a directory that is not
  a git repository ("Not inside a trusted directory"), and brand-kit working folders
  usually aren't repos. Without the flag, every job exits immediately.
- **The prompt comes BEFORE `-i`, and `-i` goes last.** `-i` accepts *multiple* image
  paths; if it precedes the prompt, it swallows the prompt string as another image path
  and the CLI fails with "No prompt provided via stdin". Keep the order exactly as in the
  template: flags, then the quoted prompt, then `-i <reference.png>` at the end.

**Default variant matrix** (seven images; male + female models, faces never visible):

| Slug | Scene | Application / finish |
|---|---|---|
| tshirt-male, tshirt-female | fit model, chin to waist, plain crew-neck cotton tee in the brand's ink colour, front-on, soft studio light, neutral light-grey seamless background | screen print, centre chest, ~26 cm wide; matte water-based finish that follows fabric folds slightly |
| golf-male, golf-female | model chin to waist, collared golf/polo shirt in the ink colour, front-on, studio | embroidered left chest, bare mark or compact lockup, ~9 cm; visible stitched-thread texture |
| cap-male, cap-female | structured six-panel cap in the ink colour, worn and framed below the eyes, or a cap-only product shot | embroidery on the front panel, bare mark only, ~6 cm; raised stitches |
| cards | no model — flat-lay stack of business cards on a desk, soft daylight | front in ink colour with the knockout lockup, back in paper colour with the dark lockup; matte cardstock |

**Run and check.** The commands are independent — run them in the background in parallel.
As each image lands, Read the PNG and check: spelling exact, mark reproduced rather than
redrawn, accent on the right letters, colourway correct for the garment. Regenerate a
failure once, naming the failure in the new prompt ("the previous attempt misspelled the
name as ..."). Only survivors go into `<kit>/mockups/`.

**Then regenerate `guidelines.html`** so the "in the world" gallery appears — the page is
generated from the shipped assets, so a regeneration is free, and mockups arrive after
the first generation. Two forms:

- **Kit copy:** reference the images by relative path (`mockups/<slug>.png`) — they ship
  in the same folder, and the page stays light.
- **Artifact publish:** relative paths won't resolve in a single published page, so inline
  downscaled copies as data URIs — resize to ≤ ~900px wide, re-encode as JPEG ~80
  (Pillow is already a dependency) — to stay self-contained and well inside size limits.
  If even downscaled images would push the page past its budget, keep the gallery in the
  kit copy only and say so.

Re-zip the kit after the regeneration so the packaged archive includes both the mockups
and the updated guidelines.

## Verification gates before packaging

1. Round-safe variants rendered under circle/square/squircle masks — nothing clips.
2. Favicon rendered over white, over light-grey (#DEE1E6), over the dark ground at 16px.
3. Lockup: mark foot exactly on baseline; only round forms cross it.
4. Every SVG imports clean (no missing width/height, no duplicate ids).
5. Contact sheet of the full kit — one page, all assets, both grounds — reviewed by eye.
6. README's known-open-items list is current and honest.
