const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The bridge name is the app's identity in the renderer's world: `kingagent`.
// It was `dainami` under the previous brand; both ends moved together.
contextBridge.exposeInMainWorld('kingagent', {
  boot: () => ipcRenderer.invoke('boot'),
  browserConfirmDiscard: (count) => ipcRenderer.invoke('browser:confirm-discard', { count }),
  browserOverlays: (args) => ipcRenderer.invoke('browser:overlays', args),
  onBrowserOverlayInput: (cb) => { const h = (_e, value) => cb(value); ipcRenderer.on('browser:overlay-input', h); return () => ipcRenderer.removeListener('browser:overlay-input', h); },
  browserProfiles: (args) => ipcRenderer.invoke('browser:profiles', args),
  browserResolve: (value) => ipcRenderer.invoke('browser:resolve', { value }),
  browserCreate: (args) => ipcRenderer.invoke('browser:create', args),
  browserClose: (id) => ipcRenderer.invoke('browser:close', { id, confirmed:true }),
  browserLayout: (args) => ipcRenderer.invoke('browser:layout', args),
  browserAction: (args) => ipcRenderer.invoke('browser:action', args),
  browserSync: (sessions) => ipcRenderer.invoke('browser:sync', { sessions }),
  usageRead: () => ipcRenderer.invoke('usage:read'),
  browserConnection: (args) => ipcRenderer.invoke('browser:connection', args),
  browserContext: (args) => ipcRenderer.invoke('browser:context', args),
  browserAnnotationImage: (args) => ipcRenderer.invoke('browser:annotation-image', args),
  browserStatus: () => ipcRenderer.invoke('browser:status'),
  browserEnable: (enabled) => ipcRenderer.invoke('browser:enable', { enabled }),
  browserGrant: (args) => ipcRenderer.invoke('browser:grant', args),
  onBrowserEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('browser:event', h); return () => ipcRenderer.removeListener('browser:event', h); },
  // The renderer styles window chrome per OS (traffic-light deck on mac,
  // titleBarOverlay clearance on windows); a string beats an IPC round-trip.
  platform: process.platform,
  onFullScreen: (cb) => { const h = (_e, on) => cb(on); ipcRenderer.on('window:fullscreen', h); return () => ipcRenderer.removeListener('window:fullscreen', h); },
  droppedFilePath: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },

  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  // Same return shape as pickFolder, so the renderer switches to it the same
  // way — it just made the folder first, and left a note in it.
  makeFolder: () => ipcRenderer.invoke('folder:make'),
  // commit:false reads the folder without adopting it — the renderer needs the
  // scan before it can decide whether the switch happens at all.
  openFolder: (folder, commit) => ipcRenderer.invoke('folder:open', { folder, commit: commit !== false }),
  scanFolder: (folder) => ipcRenderer.invoke('folder:scan', folder),
  rescanFolder: (folder) => ipcRenderer.invoke('folder:rescan', folder),

  readFile: (file) => ipcRenderer.invoke('file:read', file),
  listDir: (dir, all) => ipcRenderer.invoke('dir:list', { dir, all: !!all }),
  rawFile: (file) => ipcRenderer.invoke('file:raw', file),
  // Answers { ok, hash } — the hash of the bytes just written, which the
  // panel keeps so the watcher event this save is about to cause is
  // recognised as its own and dropped.
  saveFile: (args) => ipcRenderer.invoke('file:save', args),
  statPath: (args) => ipcRenderer.invoke('path:stat', args),
  revealFile: (file) => ipcRenderer.invoke('file:reveal', file),
  openFileInBrowser: (file) => ipcRenderer.invoke('file:openBrowser', file),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  savePastedImage: (dataUrl) => ipcRenderer.invoke('clipboard:save-image', dataUrl),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  transcribe: (args) => ipcRenderer.invoke('stt:transcribe', args),
  sttStatus: () => ipcRenderer.invoke('stt:status'),
  sttPrepare: () => ipcRenderer.invoke('stt:prepare'),
  onSttProgress: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('stt:progress', h); return () => ipcRenderer.removeListener('stt:progress', h); },

  openLink: (url) => ipcRenderer.invoke('link:open', url),
  acpStart: (args) => ipcRenderer.invoke('acp:start', args),
  acpSend: (args) => ipcRenderer.invoke('acp:send', args),
  acpKill: (args) => ipcRenderer.invoke('acp:kill', args),
  onAcpMsg: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('acp:msg', h); return () => ipcRenderer.removeListener('acp:msg', h); },
  onAcpErr: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('acp:err', h); return () => ipcRenderer.removeListener('acp:err', h); },
  onAcpExit: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('acp:exit', h); return () => ipcRenderer.removeListener('acp:exit', h); },
  savePanels: (args) => ipcRenderer.invoke('panels:save', args),
  loadPanels: (folder) => ipcRenderer.invoke('panels:load', folder),
  recentsPin: (path, pinned) => ipcRenderer.invoke('recents:pin', { path, pinned }),
  recentsRemove: (path) => ipcRenderer.invoke('recents:remove', path),
  onRecentsChanged: (cb) => { const h = (_e, rows) => cb(rows); ipcRenderer.on('recents:changed', h); return () => ipcRenderer.removeListener('recents:changed', h); },
  // openFile is only set by the switch sheet: the desk declined to change
  // folders, so the file rides along to the window being made instead.
  newWindow: (folder, openFile) => ipcRenderer.invoke('window:new', { folder, openFile: openFile || null }),

  // Finder opened a file with KingAgent. adopt says the folder has to change first;
  // without it the file already lives on this desk. See src/main/open-with.js.
  onOpenFile: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('open:file', h); return () => ipcRenderer.removeListener('open:file', h); },

  // One channel for the whole menu bar. Every KingAgent item in it is a string this
  // window turns into the same call the keyboard already made, so the menu adds
  // labels rather than a second way for anything to work.
  onMenuCommand: (cb) => { const h = (_e, cmd) => cb(cmd); ipcRenderer.on('menu:command', h); return () => ipcRenderer.removeListener('menu:command', h); },
  detectAgents: () => ipcRenderer.invoke('agents:detect'),
  agentStatus: (id) => ipcRenderer.invoke('agents:status', { id }),
  agentRemovalPlan: (id, binPath) => ipcRenderer.invoke('agents:removalPlan', { id, binPath }),
  agentRemove: (id, binPath) => ipcRenderer.invoke('agents:remove', { id, binPath }),
  listServices: (args) => ipcRenderer.invoke('services:list', args),
  connectService: (args) => ipcRenderer.invoke('services:connect', args),
  deliverServices: (args) => ipcRenderer.invoke('services:deliver', args),
  pickBundle: () => ipcRenderer.invoke('services:pickBundle'),
  connectCustom: (args) => ipcRenderer.invoke('services:connectCustom', args),
  disconnectService: (args) => ipcRenderer.invoke('services:disconnect', args),
  openUrl: (url) => ipcRenderer.invoke('url:open', url),
  themeApplied: (theme) => ipcRenderer.send('theme:applied', theme),
  themeSet: (theme) => ipcRenderer.invoke('theme:set', theme),
  viewSet: (view) => ipcRenderer.invoke('view:set', view),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  keysGet: () => ipcRenderer.invoke('keys:get'),
  settingsReveal: () => ipcRenderer.invoke('settings:reveal'),
  keysSet: (name, value) => ipcRenderer.invoke('keys:set', { name, value }),
  keysDelete: (name) => ipcRenderer.invoke('keys:delete', { name }),
  keysReveal: (name) => ipcRenderer.invoke('keys:reveal', { name }),

  libraryScan: (args) => ipcRenderer.invoke('library:scan', args),
  libraryCreate: (args) => ipcRenderer.invoke('library:create', args),
  libraryDuplicate: (args) => ipcRenderer.invoke('library:duplicate', args),
  libraryDelete: (args) => ipcRenderer.invoke('library:delete', args),
  deliverAgents: (args) => ipcRenderer.invoke('library:deliverAgents', args),
  agentDelivery: (args) => ipcRenderer.invoke('library:agentDelivery', args),
  importAgent: (args) => ipcRenderer.invoke('library:importAgent', args),
  adoptAgent: (args) => ipcRenderer.invoke('library:adoptAgent', args),
  pointerStatus: (args) => ipcRenderer.invoke('pointer:status', args),
  pointerWrite: (args) => ipcRenderer.invoke('pointer:write', args),
  fsNewFile: (args) => ipcRenderer.invoke('fs:newFile', args),
  fsNewFolder: (args) => ipcRenderer.invoke('fs:newFolder', args),
  fsMove: (args) => ipcRenderer.invoke('fs:move', args),
  fsRename: (args) => ipcRenderer.invoke('fs:rename', args),
  // Files dragged in from Finder. Paths come from droppedFilePath above, never
  // File.path — Electron removed that in v32 and it reads undefined here.
  fsImport: (args) => ipcRenderer.invoke('fs:import', args),
  fsDuplicate: (args) => ipcRenderer.invoke('fs:duplicate', args),
  fsTrash: (args) => ipcRenderer.invoke('fs:trash', args),
  // The tree declares every folder it can see; main diffs that against the
  // watchers it has open and reports back { watching, overflow, failed }.
  dirWatch: (root) => ipcRenderer.invoke('dir:watch', { root }),
  // { dir, files } — files is the absolute paths that moved, or null when the
  // platform would not say. Same shape as before, one field wider.
  onDirChanged: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('dir:changed', h); return () => ipcRenderer.removeListener('dir:changed', h); },
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),

  termCreate: (args) => ipcRenderer.invoke('term:create', args),
  termWrite: (args) => ipcRenderer.invoke('term:write', args),
  termResize: (args) => ipcRenderer.invoke('term:resize', args),
  termKill: (args) => ipcRenderer.invoke('term:kill', args),
  sessionWatchTitle: (args) => ipcRenderer.invoke('session:watch-title', args),
  onTermData: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('term:data', h); return () => ipcRenderer.removeListener('term:data', h); },
  onTermCommandDone: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('term:command-done', h); return () => ipcRenderer.removeListener('term:command-done', h); },
  onTermExit: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('term:exit', h); return () => ipcRenderer.removeListener('term:exit', h); },

  // Main found the conversation a terminal-run agent tile landed in, by
  // polling the agent's store after spawn — { id, sid }. The renderer saves
  // it as acpSid so the next launch resumes it.
  onTermSessionId: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('term:session-id', h); return () => ipcRenderer.removeListener('term:session-id', h); },

  // claude worked out a name for this conversation — { id, title }
  onSessionTitle: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('session:title', h); return () => ipcRenderer.removeListener('session:title', h); },
  // Claude moved this tile to a different conversation (the user ran /resume).
  // The panel has to store the new id or the next launch resumes the wrong one.
  onSessionSid: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('session:sid', h); return () => ipcRenderer.removeListener('session:sid', h); },

  // A newer KingAgent exists — { version, url }. Only ever fires when there is one;
  // silence is the normal case and means nothing went wrong.
  onUpdateAvailable: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('update:available', h); return () => ipcRenderer.removeListener('update:available', h); },
  openUpdate: (url) => ipcRenderer.invoke('update:open', url),
  updateStatus: () => ipcRenderer.invoke('update:status'),

  // Downloading one. All three fire on every window, because one download
  // serves the whole app — see main's update:download.
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  // { force: true } is the renderer's own "install anyway" — main still runs
  // the active-work check either way, force only tells it the user already
  // saw the warning and chose to go ahead.
  installUpdate: (args) => ipcRenderer.invoke('update:install', args),
  updaterState: () => ipcRenderer.invoke('update:state'),
  liveSessions: () => ipcRenderer.invoke('update:sessions'),
  onUpdateProgress: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('update:progress', h); return () => ipcRenderer.removeListener('update:progress', h); },
  onUpdateReady: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('update:ready', h); return () => ipcRenderer.removeListener('update:ready', h); },
  onUpdateFailed: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('update:failed', h); return () => ipcRenderer.removeListener('update:failed', h); },
  appVersion: () => ipcRenderer.invoke('app:version'),

  // The Smart Update Center's own surface — window.kingagent.updater. Every
  // method here is a plain invoke/on pair to a channel registered in main.js
  // (src/main/updater/update-manager.js does the actual work); nothing raw
  // from Node or Electron crosses this bridge, same rule as the rest of this
  // file.
  updater: {
    getState: () => ipcRenderer.invoke('update:getState'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: (args) => ipcRenderer.invoke('update:install', args),
    postpone: (args) => ipcRenderer.invoke('update:postpone', args),
    getReleaseInfo: () => ipcRenderer.invoke('update:getReleaseInfo'),
    onStateChange: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('update:available', h);
      ipcRenderer.on('update:reminder', h);
      ipcRenderer.on('update:ready', h);
      ipcRenderer.on('update:failed', h);
      return () => {
        ipcRenderer.removeListener('update:available', h);
        ipcRenderer.removeListener('update:reminder', h);
        ipcRenderer.removeListener('update:ready', h);
        ipcRenderer.removeListener('update:failed', h);
      };
    },
    onProgress: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('update:progress', h); return () => ipcRenderer.removeListener('update:progress', h); },
    onUpdateAvailable: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('update:available', h); return () => ipcRenderer.removeListener('update:available', h); },
    onReminder: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('update:reminder', h); return () => ipcRenderer.removeListener('update:reminder', h); },
  },

  // Phase 2: the Agent Platform surface. Every invoke channel here is allowed
  // by src/core/security/ipc-guard.js and registered in src/main/agent-platform.js —
  // the renderer reaching this object works only because both ends already
  // agreed on the channel. onPlatformEvent pumps structured task/workflow/
  // approval events over, one channel, tagged by ev.type.
  agentPlatform: {
    listAgents: () => ipcRenderer.invoke('agent:listAgents'),
    getAgent: (id) => ipcRenderer.invoke('agent:get', { id }),
    listTools: () => ipcRenderer.invoke('agent:listTools'),
    runTask: (args) => ipcRenderer.invoke('agent:runTask', args),
    listTasks: () => ipcRenderer.invoke('agent:listTasks'),
    getTask: (id) => ipcRenderer.invoke('agent:task', { id }),
    history: (id) => ipcRenderer.invoke('agent:history', { id }),
    pauseTask: (id) => ipcRenderer.invoke('agent:pause', { id }),
    resumeTask: (id) => ipcRenderer.invoke('agent:resume', { id }),
    cancelTask: (id) => ipcRenderer.invoke('agent:cancel', { id }),
    listWorkflows: () => ipcRenderer.invoke('workflow:list'),
    runWorkflow: (workflowId, inputs) => ipcRenderer.invoke('workflow:run', { workflowId, inputs }),
    getWorkflow: (id) => ipcRenderer.invoke('workflow:get', { id }),
    cancelWorkflow: (id) => ipcRenderer.invoke('workflow:cancel', { id }),
    authorizeResponse: (requestId, approved) => ipcRenderer.invoke('agent:authorizeResponse', { requestId, approved }),

    // --- Phase 3 -------------------------------------------------------------
    // Every one of these is on the guarded channel list
    // (src/core/security/ipc-guard.js); tests/core-wiring.test.mjs checks that
    // this surface stays a subset of it.
    orchestrate: (args) => ipcRenderer.invoke('orchestrator:run', args),
    routeRequest: (args) => ipcRenderer.invoke('orchestrator:route', args),
    getRun: (id) => ipcRenderer.invoke('orchestrator:get', { id }),
    listRuns: () => ipcRenderer.invoke('orchestrator:list'),
    cancelRun: (id) => ipcRenderer.invoke('orchestrator:cancel', { id }),
    orchestratorPolicies: () => ipcRenderer.invoke('orchestrator:policies'),

    getWorkspace: (id) => ipcRenderer.invoke('workspace:get', { id }),
    listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
    workspaceFiles: (id) => ipcRenderer.invoke('workspace:files', { id }),

    listTraces: () => ipcRenderer.invoke('trace:list'),
    getTrace: (id) => ipcRenderer.invoke('trace:get', { id }),
    traceActivity: (id) => ipcRenderer.invoke('trace:activity', { id }),

    listArtifacts: (args) => ipcRenderer.invoke('artifact:list', args || {}),
    getArtifact: (id, workspaceId) => ipcRenderer.invoke('artifact:get', { id, workspaceId }),

    searchMemory: (args) => ipcRenderer.invoke('memory:search', args),
    listMemory: (args) => ipcRenderer.invoke('memory:list', args),

    pendingApprovals: (taskId) => ipcRenderer.invoke('approval:pending', taskId ? { taskId } : {}),
    decideApproval: (id, approved, note) => ipcRenderer.invoke('approval:decide', { id, approved, note }),

    interruptedTasks: () => ipcRenderer.invoke('state:interrupted'),
    resumeTask2: (taskId) => ipcRenderer.invoke('state:resume', { taskId }),
    latestSnapshot: (taskId) => ipcRenderer.invoke('state:snapshot', { taskId }),

    detectProject: (root) => ipcRenderer.invoke('project:detect', { root }),

    agentLifecycles: (taskId) => ipcRenderer.invoke('agents:lifecycles', taskId ? { taskId } : {}),
    agentMessages: (taskId) => ipcRenderer.invoke('agents:messages', { taskId }),

    // --- Phase 4: the Agent Control Center (src/core/harness-orchestrator/) --
    // All read-only except route (a dry run) and cancelTask. Nothing here can
    // raise a permission or widen a sandbox. `harness`-prefixed where the name
    // would otherwise collide with the Phase 3 method above it (both
    // `listArtifacts`/`getArtifact` exist on two independent artifact stores —
    // see the module comment in src/core/index.js).
    controlCenter: (args = {}) => ipcRenderer.invoke('agent:controlCenter', args),
    listHarnesses: () => ipcRenderer.invoke('agent:harnesses'),
    detectHarnesses: (id) => ipcRenderer.invoke('agent:harnessDetect', id ? { id } : {}),
    listSandboxes: () => ipcRenderer.invoke('agent:sandboxes'),
    getSandbox: (id) => ipcRenderer.invoke('agent:sandbox', { id }),
    listPolicies: () => ipcRenderer.invoke('agent:policies'),
    policyAudit: (limit) => ipcRenderer.invoke('agent:policyAudit', limit ? { limit: String(limit) } : {}),
    explainPolicy: (args) => ipcRenderer.invoke('agent:explainPolicy', args),
    listSessions: () => ipcRenderer.invoke('agent:sessions'),
    getSession: (id) => ipcRenderer.invoke('agent:session', { id }),
    harnessListArtifacts: (args = {}) => ipcRenderer.invoke('agent:artifacts', args),
    harnessGetArtifact: (id) => ipcRenderer.invoke('agent:artifact', { id }),
    listDelegations: (taskId) => ipcRenderer.invoke('agent:delegations', { taskId }),
    route: (args) => ipcRenderer.invoke('agent:route', args),
    cancelTaskTree: (taskId, sessionId) => ipcRenderer.invoke('agent:cancelTask', sessionId ? { taskId, sessionId } : { taskId }),

    // --- Phase 7: research (src/core/research/) -----------------------------
    // `startResearch` is the only call that spends anything. Its payload can
    // only narrow what the install already allows — the main side clamps every
    // limit and intersects every domain list (see agent-platform.js).
    startResearch: (args) => ipcRenderer.invoke('research:start', args),
    researchStatus: (id) => ipcRenderer.invoke('research:status', { id }),
    cancelResearch: (id, reason) => ipcRenderer.invoke('research:cancel', reason ? { id, reason } : { id }),
    getResearch: (id) => ipcRenderer.invoke('research:get', { id }),
    listResearch: () => ipcRenderer.invoke('research:list'),
    researchSources: (id) => ipcRenderer.invoke('research:sources', { id }),
    researchEvidence: (id, claimId) => ipcRenderer.invoke('research:evidence', claimId ? { id, claimId } : { id }),
    researchReport: (id, format) => ipcRenderer.invoke('research:report', format ? { id, format } : { id }),
    researchCapabilities: () => ipcRenderer.invoke('research:capabilities'),

    onPlatformEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('agent:event', h);
      ipcRenderer.on('workflow:event', h);
      ipcRenderer.on('approval:event', h);
      ipcRenderer.on('research:event', h);
      return () => {
        ipcRenderer.removeListener('agent:event', h);
        ipcRenderer.removeListener('workflow:event', h);
        ipcRenderer.removeListener('approval:event', h);
        ipcRenderer.removeListener('research:event', h);
      };
    },
  },
});
