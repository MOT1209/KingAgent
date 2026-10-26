// The horizontal axis, read the way the layout reads it.
//
// The stylesheets mirror on their own: every rule is a logical property, so
// <html dir="rtl"> moves the sidebar, the rows and the grip with no JS at all.
// What CSS cannot mirror is geometry JS computes from a getBoundingClientRect —
// a popup anchored under a button, a drag measured in clientX. Those read
// physical pixels, so they ask here which edge is the start. Pure apart from
// isRtl(), so the arithmetic is tested without a DOM.

export function isRtl(el) {
  try { return getComputedStyle(el || document.documentElement).direction === 'rtl'; } catch (_) { return false; }
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(x, hi));

// Left px for a popup of `width` whose inline-START edge lines up with the
// anchor's: the anchor's left edge in LTR, its right edge in RTL. Clamped to
// the viewport with `margin` on both sides.
export function alignStart(rect, width, viewportWidth, rtl, margin = 8) {
  const x = rtl ? rect.right - width : rect.left;
  return clamp(x, margin, viewportWidth - width - margin);
}

// Left px for a popup whose inline-END edge lines up with the anchor's: its
// right edge in LTR (a menu dropping from a button at the end of a toolbar),
// its left edge in RTL.
export function alignEnd(rect, width, viewportWidth, rtl, margin = 8) {
  const x = rtl ? rect.left : rect.right - width;
  return clamp(x, margin, viewportWidth - width - margin);
}

// A pointer delta along the inline axis: positive means "towards the end".
export function inlineDelta(dx, rtl) { return rtl ? -dx : dx; }

// Distance from the inline-start edge of `rect` (minus its start padding) to
// clientX — how far into a container, along the reading direction, a pointer is.
export function inlineOffset(clientX, rect, padStart, rtl) {
  return rtl ? rect.right - padStart - clientX : clientX - rect.left - padStart;
}
