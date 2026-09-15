// When KingAgent asks about updates by itself: one beat after launch, then every
// six hours — plus the two things checked at that same beat, a staged download
// the settings say to install and a postponed update that has waited out its
// reminder window.
//
// Notification-only, and that is the whole point of the shape. Nothing here ever
// downloads unasked: the only automatic download is the one the user switched on
// in Settings, and the only automatic install is of a file an earlier run
// already fetched. See update-check.js for why nothing installs anything
// uninvited.
//
// Extracted from main.js as a factory over injected dependencies, so the
// schedule and each decision can be tested without an Electron app, a real
// timer or a network — see tests/update-polling.test.mjs.

// Six hours. The manager backs its own reminder interval off from here when a
// postponed update keeps coming due without the user acting on it.
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

// A beat after launch rather than during it: the first seconds belong to the
// window, and a check that competes with the first paint is a check nobody
// asked to feel.
const DEFAULT_LAUNCH_DELAY_MS = 8000;

function createUpdatePolling({
  manager,                     // () => the Smart Update Center
  readSettings,                // () => the settings object
  isPackaged,                  // () => boolean; unpolled when false
  review = false,              // review builds never poll either
  emit,                        // (channel, payload) => void, every open window
  hasStagedUpdate,             // () => boolean
  intervalMs = DEFAULT_INTERVAL_MS,
  launchDelayMs = DEFAULT_LAUNCH_DELAY_MS,
  scheduleTimeout = setTimeout,
  scheduleInterval = setInterval,
} = {}) {
  // Remembered so a window opened after the check can still be told what is on
  // offer without asking GitHub again: the boot payload carries the last answer.
  let lastOffered = null;

  // Settings → Updates → "Automatically check for updates" is on by default, so
  // only an explicit false skips the poll.
  async function poll() {
    if (readSettings().updatesAutoCheck === false) return null;
    const res = await manager().check();
    if (res.status.state !== 'update') return null;

    lastOffered = { version: res.status.version, url: res.status.url };
    emit('update:available', lastOffered);

    // Settings → Updates → "Automatically download updates", off by default —
    // rule one from updater.js ("nothing downloaded unasked") stays the default,
    // and this is the one door the user can open themselves. A failure is silent
    // here exactly like the check itself: the card still offers a manual
    // download, and a background prefetch is not something to alarm anyone about
    // failing.
    if (readSettings().updatesAutoDownload) manager().download().catch(() => {});
    return lastOffered;
  }

  // "Install updates automatically on next launch", off by default, and only
  // when a download from an earlier run is already sitting in the cache — this
  // never triggers a fresh download on its own. install() re-validates that
  // cached file against electron-updater's own record before trusting it, the
  // same as the button does, and refuses while a session is live.
  async function autoInstallOnLaunch() {
    if (!isPackaged() || review) return false;
    if (!readSettings().updatesInstallOnLaunch) return false;
    if (!hasStagedUpdate()) return false;
    try { await manager().install(); return true; } catch (_) { return false; }
  }

  // A postponed update that has waited out its reminder window, brought back at
  // launch rather than left for a background poll that might be hours away. The
  // spec's "do not repeatedly spam the user" is the manager's backoff, not a
  // check performed here.
  function checkReminder() {
    const due = manager().checkReminder();
    if (!due) return null;
    lastOffered = { version: due.postponedVersion, url: lastOffered?.url || null };
    emit('update:reminder', { version: due.postponedVersion });
    return lastOffered;
  }

  function start() {
    // Development is never polled: the version in package.json is behind the last
    // published release while you work, so every launch would nag about the
    // update you are in the middle of building. A button somebody pressed still
    // answers — see update:status in main.js.
    if (!isPackaged() || review) return false;
    scheduleTimeout(autoInstallOnLaunch, launchDelayMs).unref?.();
    scheduleTimeout(poll, launchDelayMs).unref?.();
    scheduleTimeout(checkReminder, launchDelayMs).unref?.();
    scheduleInterval(poll, intervalMs).unref?.();
    return true;
  }

  // A manual check that finds something re-arms the bar too, so a version
  // somebody once waved away can be found again.
  function note(version, url) {
    if (!version) return null;
    lastOffered = { version, url: url || null };
    return lastOffered;
  }

  return {
    get lastOffered() { return lastOffered; },
    note,
    poll,
    autoInstallOnLaunch,
    checkReminder,
    start,
  };
}

module.exports = { createUpdatePolling, DEFAULT_INTERVAL_MS, DEFAULT_LAUNCH_DELAY_MS };
