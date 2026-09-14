// The Smart Update Center's lifecycle: check, download, install, postpone,
// retry — one state machine wrapping the two modules that already do the
// real work. This file does not talk to GitHub and does not touch
// electron-updater; ./updater.js and ../update-check.js still own that,
// exactly as they did before this feature existed. What this file adds is
// the layer the spec asks for on top: release analysis, importance,
// persisted state, postpone/reminder, and one event per transition.
//
// check → AVAILABLE → download → READY → install → (process restarts)
//                    ↘ postpone → POSTPONED → (reminder) → back to AVAILABLE
//
// A dev build (`isPackaged: false`) never downloads or installs anything —
// the same guard ./updater.js already enforces is still the one that matters,
// this file just also declines to move its own state machine past AVAILABLE.

const updaterCore = require('./updater');
const updateCheck = require('../update-check');
const { normalizeMetadata } = require('./update-metadata');
const { analyzeRelease } = require('./update-analyzer');
const { classifyImportance } = require('./update-policy');
const stateStore = require('./update-state');
const { EVENTS, createEventBus } = require('./update-events');

const MANAGER_STATES = Object.freeze([
  'IDLE', 'CHECKING', 'AVAILABLE', 'DOWNLOADING', 'DOWNLOADED', 'READY',
  'POSTPONED', 'INSTALLING', 'COMPLETED', 'FAILED',
]);

function createUpdateManager({
  isPackaged,
  appVersion,
  arch = process.arch,
  stateFile,
  io,
  fetchJson,                          // test seam for update-check's GitHub call
  emitToRenderer = () => {},          // (channel, payload) — same contract as updater.js's `emit`
  getActiveWork = () => 0,            // () => number | Promise<number> — live sessions, tasks, etc.
  bus = createEventBus(),
  defaultReminderMs,
  updaterImpl = updaterCore,          // test seam: swap the electron-updater wrapper itself
  checkImpl = updateCheck,            // test seam: swap the GitHub release check itself
} = {}) {
  if (!appVersion) throw new Error('createUpdateManager requires appVersion');
  if (!stateFile) throw new Error('createUpdateManager requires stateFile');

  let managerState = 'IDLE';
  let release = null;      // last GitHub release document that had news
  let metadata = null;     // normalizeMetadata(release)
  let analysis = null;     // analyzeRelease(metadata)
  let importance = null;   // classifyImportance({ metadata, analysis })

  const persist = (patch) => stateStore.writeState({ file: stateFile, io, patch });
  const loadState = () => stateStore.readState({ file: stateFile, io });

  function releaseInfo() {
    if (!metadata) return null;
    return { metadata, analysis, importance, currentVersion: appVersion };
  }

  function snapshot() {
    return {
      state: managerState,
      releaseInfo: releaseInfo(),
      downloader: updaterImpl.updaterState(),
      persisted: loadState(),
    };
  }

  function resetOffer() {
    release = null; metadata = null; analysis = null; importance = null;
  }

  // ---- check -----------------------------------------------------------------
  async function check() {
    bus.emit(EVENTS.CHECK_STARTED, { currentVersion: appVersion });
    managerState = 'CHECKING';

    let captured = null;
    const capture = async () => {
      captured = await (fetchJson ? fetchJson() : checkImpl.fetchLatest());
      return captured;
    };

    const status = await checkImpl.updateStatus({ currentVersion: appVersion, arch, fetchJson: capture });
    persist({ lastCheck: new Date().toISOString(), currentVersion: appVersion });

    if (status.state !== 'update') {
      managerState = 'IDLE';
      resetOffer();
      bus.emit(EVENTS.NOT_AVAILABLE, { currentVersion: appVersion });
      return { ...snapshot(), status };
    }

    release = captured || { tag_name: status.version };
    metadata = normalizeMetadata(release);
    analysis = analyzeRelease(metadata);
    importance = classifyImportance({ metadata, analysis });

    managerState = 'AVAILABLE';
    persist({ availableVersion: status.version });
    bus.emit(EVENTS.AVAILABLE, { currentVersion: appVersion, version: status.version, importance });
    return { ...snapshot(), status };
  }

  // ---- download ----------------------------------------------------------------
  async function download() {
    if (managerState === 'DOWNLOADED' || managerState === 'READY') return snapshot();
    managerState = 'DOWNLOADING';
    bus.emit(EVENTS.DOWNLOAD_STARTED, { currentVersion: appVersion, version: metadata?.version });

    const res = await updaterImpl.downloadUpdate({
      isPackaged,
      emit: (channel, payload) => {
        if (channel === 'update:progress') {
          bus.emit(EVENTS.DOWNLOAD_PROGRESS, { currentVersion: appVersion, version: payload.version || metadata?.version, percent: payload.percent });
        } else if (channel === 'update:ready') {
          managerState = 'READY';
          persist({ downloadState: 'READY' });
          bus.emit(EVENTS.DOWNLOAD_COMPLETED, { currentVersion: appVersion, version: payload.version });
        } else if (channel === 'update:failed') {
          managerState = 'FAILED';
          persist({ downloadState: 'FAILED' });
          bus.emit(EVENTS.FAILED, { currentVersion: appVersion, version: metadata?.version, phase: 'download' });
        }
        emitToRenderer(channel, payload);
      },
    });

    // isPackaged: false or an already-settled state means downloadUpdate
    // returned without ever calling emit — reflect its answer directly.
    if (managerState === 'DOWNLOADING') {
      managerState = res.state === 'ready' ? 'READY' : res.state === 'failed' ? 'FAILED' : 'AVAILABLE';
    }
    return snapshot();
  }

  // ---- install -----------------------------------------------------------------
  // Active-work safety: refuses to install while `getActiveWork()` reports
  // something running, unless the caller explicitly forces it (the renderer's
  // own "install anyway" confirmation, already backed by the same signal).
  async function install({ force = false } = {}) {
    const active = await getActiveWork();
    if (active > 0 && !force) {
      return { blocked: true, activeWork: active, ...snapshot() };
    }

    managerState = 'INSTALLING';
    persist({ installState: 'INSTALLING' });
    bus.emit(EVENTS.INSTALL_STARTED, { currentVersion: appVersion, version: metadata?.version });

    const res = await updaterImpl.installNow({ isPackaged, emit: emitToRenderer });

    if (res.state === 'failed') {
      managerState = 'FAILED';
      persist({ installState: 'FAILED' });
      bus.emit(EVENTS.FAILED, { currentVersion: appVersion, version: metadata?.version, phase: 'install' });
      return { blocked: false, ...snapshot() };
    }

    // A successful call tears the process down via quitAndInstall a tick
    // later — this process never observes "installed", only "about to be".
    // The next launch is what actually confirms it, which is what the
    // history entry is for.
    stateStore.recordHistory({
      file: stateFile, io,
      entry: {
        previousVersion: appVersion,
        installedVersion: metadata?.version || res.version || null,
        installedAt: new Date().toISOString(),
        updateResult: 'installing',
      },
    });
    persist({ installState: 'INSTALLING' });
    managerState = 'COMPLETED';
    bus.emit(EVENTS.INSTALL_COMPLETED, { currentVersion: appVersion, version: metadata?.version });
    return { blocked: false, ...snapshot() };
  }

  // ---- postpone / retry --------------------------------------------------------
  function postpone({ hours } = {}) {
    const version = metadata?.version;
    if (!version) return snapshot();
    const reminderMs = Number.isFinite(hours) && hours > 0
      ? hours * 60 * 60 * 1000
      : (defaultReminderMs || stateStore.DEFAULT_REMINDER_MS);
    const persisted = stateStore.postpone({ file: stateFile, io, version, reminderMs });
    managerState = 'POSTPONED';
    bus.emit(EVENTS.POSTPONED, { currentVersion: appVersion, version, remindAt: persisted.remindAt });
    return { ...snapshot(), persisted };
  }

  async function retry() {
    if (managerState === 'FAILED') managerState = 'AVAILABLE';
    return download();
  }

  // Called at startup (and whenever it's worth asking again): is a postponed
  // update due to be brought back up? Backs the reminder off on its own —
  // a caller that shows the reminder does not also need to call
  // backOffReminder itself, only clearPostponed() if the user acts on it.
  function checkReminder(now = Date.now()) {
    const persisted = loadState();
    if (!stateStore.reminderDue({ state: persisted, now })) return null;
    bus.emit(EVENTS.REMINDER, { currentVersion: appVersion, version: persisted.postponedVersion });
    stateStore.backOffReminder({ file: stateFile, io, reminderMs: defaultReminderMs });
    return persisted;
  }

  function clearPostponed() {
    return stateStore.clearPostponed({ file: stateFile, io });
  }

  function getState() { return snapshot(); }
  function getReleaseInfo() { return releaseInfo(); }

  return {
    check, download, install, postpone, retry, checkReminder, clearPostponed,
    getState, getReleaseInfo,
    bus, EVENTS, STATES: MANAGER_STATES,
  };
}

module.exports = { createUpdateManager, MANAGER_STATES };
