// The right-click menu on a session (terminal) tile's head.
//
// "Keep running in background" is the opt-in half of background-sessions.js:
// closing this tile normally kills the process it owns; toggling this first
// makes that same close detach it instead (see toggleKeepRunning in app.js).
// The label carries the state — a check mark it already has, rather than a
// separate row — because a tile's context menu is judged in the instant
// before the click, not read as a settings page.
//
// Pure, like tile-menu.mjs: the verbs come in as ctx, nothing here touches
// the DOM, and it is testable without a terminal.
export function sessionMenuItems(p, ctx) {
  const items = [{ label: 'Add browser…', run: () => ctx.addBrowser(p) }];
  items.push('-');
  items.push({
    label: p.keepRunning ? '✓ Keep running in background' : 'Keep running in background',
    kb: p.keepRunning ? 'stays alive on close' : undefined,
    run: () => ctx.toggleKeepRunning(p),
  });
  return items;
}
