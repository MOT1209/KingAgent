// SessionManager: create, open, pause, resume, stop, complete.
//
// The manager is the only thing that moves a session between states, so the
// events and the snapshots can never disagree about where a session is. It also
// owns the *recovery* contract: a session that was RUNNING when the process
// died comes back as PAUSED rather than RUNNING, because resuming work nobody
// is watching is not recovery, it is a surprise.

const {
  SESSION_STATES,
  SessionLifecycle,
  canTransition,
  isTerminal,
} = require('./lifecycle');
const {
  createSession,
  snapshot,
  summarize,
  attachTask,
  attachArtifact,
  attachSandbox,
  attachHarness,
  attachAgent,
} = require('./session');
const { TYPES } = require('../events/event-bus');

const EVENT_FOR = Object.freeze({
  [SESSION_STATES.RUNNING]: TYPES.SESSION_STARTED,
  [SESSION_STATES.PAUSED]: TYPES.SESSION_PAUSED,
  [SESSION_STATES.COMPLETED]: TYPES.SESSION_COMPLETED,
  [SESSION_STATES.FAILED]: TYPES.SESSION_FAILED,
  [SESSION_STATES.STOPPED]: TYPES.SESSION_STOPPED,
});

class SessionManager {
  constructor({ bus = null, logger = null, store = null, idFactory = null } = {}) {
    this._bus = bus;
    this._logger = logger;
    this._store = store;
    this._sessions = new Map();
    this._machines = new Map();
    this._seq = 0;
    this._idFactory = idFactory || (() => `session-${Date.now().toString(36)}-${(++this._seq).toString(36)}`);
  }

  create(spec = {}) {
    const id = spec.id || this._idFactory();
    if (this._sessions.has(id)) throw new Error(`session "${id}" already exists`);
    const session = createSession({ ...spec, id });
    this._sessions.set(id, session);
    this._machines.set(id, new SessionLifecycle({
      initial: SESSION_STATES.CREATED,
      onChange: ({ from, to, at }) => {
        session.transitions = session.transitions || [];
        session.transitions.push({ from, to, at });
        if (session.transitions.length > 100) session.transitions.shift();
      },
    }));
    this._emit(TYPES.SESSION_CREATED, session, { workspaceId: session.workspaceId, agentIds: [...session.agentIds] });
    this._persist(session);
    return snapshot(session);
  }

  get(id) {
    return this._sessions.get(id) || null;
  }

  view(id) {
    const session = this._sessions.get(id);
    return session ? snapshot(session) : null;
  }

  list(filter = {}) {
    let all = [...this._sessions.values()];
    if (filter.state) all = all.filter((s) => s.state === filter.state);
    if (filter.active === true) all = all.filter((s) => !isTerminal(s.state));
    return all.map(summarize).sort((a, b) => b.createdAt - a.createdAt);
  }

  // Opening a session is a two-step move on purpose: INITIALIZING covers the
  // work a host does before it can accept anything (probing the workspace,
  // detecting the chosen backend), and READY is the honest "open, nothing
  // running yet" state the UI shows.
  initialize(id, note = 'initializing') {
    return this._transition(id, SESSION_STATES.INITIALIZING, note);
  }

  ready(id, note = 'ready') {
    return this._transition(id, SESSION_STATES.READY, note);
  }

  // Starting a brand-new session walks the opening edges rather than jumping:
  // a caller that opens and starts in one move still produces the same state
  // history as one that opens, waits, then starts.
  start(id, note = 'start') {
    const session = this.get(id);
    if (!session) throw new Error(`no session "${id}"`);
    if (session.state === SESSION_STATES.CREATED) {
      this._transition(id, SESSION_STATES.INITIALIZING, 'open');
      this._transition(id, SESSION_STATES.READY, 'opened');
    }
    return this._transition(id, SESSION_STATES.RUNNING, note);
  }

  // WAITING is for a human gate: an approval, a question, a credential. It is
  // not an error state and the session is still usable.
  wait(id, reason = 'awaiting input') {
    return this._transition(id, SESSION_STATES.WAITING, reason);
  }

  pause(id, reason = 'paused') {
    const view = this._transition(id, SESSION_STATES.PAUSED, reason);
    const session = this._sessions.get(id);
    if (session) session.pausedAt = Date.now();
    return view;
  }

  resume(id) {
    return this._transition(id, SESSION_STATES.RUNNING, 'resume');
  }

  complete(id, summary = null) {
    const view = this._transition(id, SESSION_STATES.COMPLETED, 'completed', summary);
    const session = this._sessions.get(id);
    if (session) session.completedAt = Date.now();
    return view;
  }

  fail(id, error) {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`no session "${id}"`);
    const message = error instanceof Error ? error.message : String(error);
    if (session.state === SESSION_STATES.FAILED) return snapshot(session);
    if (!canTransition(session.state, SESSION_STATES.FAILED)) {
      // A session that already finished cleanly cannot fail afterwards.
      return snapshot(session);
    }
    this._transition(id, SESSION_STATES.FAILED, message);
    session.failure = message;
    return snapshot(session);
  }

  stop(id, reason = 'requested') {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`no session "${id}"`);
    if (isTerminal(session.state)) return snapshot(session);
    if (session.state !== SESSION_STATES.STOPPING) this._transition(id, SESSION_STATES.STOPPING, reason);
    return this._transition(id, SESSION_STATES.STOPPED, reason);
  }

  // --- attachments ----------------------------------------------------------

  attachTask(id, taskId) {
    const session = this.get(id);
    if (!session) return null;
    attachTask(session, taskId);
    this._persist(session);
    return snapshot(session);
  }

  attachArtifact(id, artifactId) {
    const session = this.get(id);
    if (!session) return null;
    attachArtifact(session, artifactId);
    this._persist(session);
    return snapshot(session);
  }

  attachSandbox(id, sandboxId) {
    const session = this.get(id);
    if (!session) return null;
    attachSandbox(session, sandboxId);
    return snapshot(session);
  }

  attachHarness(id, harnessId) {
    const session = this.get(id);
    if (!session) return null;
    attachHarness(session, harnessId);
    return snapshot(session);
  }

  attachAgent(id, agentId) {
    const session = this.get(id);
    if (!session) return null;
    attachAgent(session, agentId);
    return snapshot(session);
  }

  countMessages(id) {
    const session = this.get(id);
    if (!session) return null;
    session.messages += 1;
    return session.messages;
  }

  countDelegation(id) {
    const session = this.get(id);
    if (!session) return null;
    session.delegations += 1;
    return session.delegations;
  }

  // Record an approval decision on the session so the UI can show it later
  // without holding the whole approval history.
  recordApproval(id, { requestId, action, granted, at = Date.now() }) {
    const session = this.get(id);
    if (!session) return null;
    session.approvals.push({ requestId, action, granted: Boolean(granted), at });
    if (session.approvals.length > 100) session.approvals.shift();
    return snapshot(session);
  }

  // Recovery entry point. Sessions found in a state that implies work was in
  // flight are parked in PAUSED with a reason, never silently resumed.
  recover({ reason = 'platform restarted' } = {}) {
    const recovered = [];
    for (const session of this._sessions.values()) {
      if (![SESSION_STATES.RUNNING, SESSION_STATES.WAITING, SESSION_STATES.INITIALIZING, SESSION_STATES.READY].includes(session.state)) continue;
      const machine = this._machines.get(session.id);
      if (!machine) continue;
      // A session that never reached RUNNING goes back to READY; one that was
      // running is parked.
      const target = session.state === SESSION_STATES.INITIALIZING || session.state === SESSION_STATES.READY
        ? SESSION_STATES.READY
        : SESSION_STATES.PAUSED;
      if (!machine.can(target)) continue;
      this._transition(session.id, target, `recovery: ${reason}`);
      recovered.push({ id: session.id, state: target });
    }
    return recovered;
  }

  activeSessionFor(workspaceId) {
    return [...this._sessions.values()]
      .filter((s) => s.workspaceId === workspaceId && !isTerminal(s.state))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }

  controlView(id) {
    const session = this._sessions.get(id);
    if (!session) return null;
    return {
      ...snapshot(session),
      agentCount: session.agentIds.length,
      taskCount: session.taskIds.length,
      artifactCount: session.artifactIds.length,
    };
  }

  stats() {
    const byState = {};
    for (const session of this._sessions.values()) byState[session.state] = (byState[session.state] || 0) + 1;
    return { total: this._sessions.size, byState };
  }

  _transition(id, to, note, payload) {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`no session "${id}"`);
    const machine = this._machines.get(id);
    if (machine.can(to)) {
      machine.go(to, note);
      session.state = to;
      session.updatedAt = Date.now();
      if (to === SESSION_STATES.RUNNING && !session.startedAt) session.startedAt = Date.now();
    } else if (to !== session.state) {
      // Already there is fine (idempotent); anything else is a programming
      // error worth surfacing loudly rather than papering over.
      throw new Error(`session "${id}" cannot move from ${session.state} to ${to}`);
    }
    const type = EVENT_FOR[to];
    if (type) this._emit(type, session, payload === undefined ? { note } : { note, summary: payload });
    this._persist(session);
    return snapshot(session);
  }

  _persist(session) {
    if (this._store) this._store.set(`session:${session.id}`, snapshot(session)).catch(() => {});
  }

  _emit(type, session, payload) {
    if (!this._bus) return;
    this._bus.emit(type, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      taskId: session.taskIds.length ? session.taskIds[session.taskIds.length - 1] : null,
      agentId: session.agentIds.length ? session.agentIds[0] : null,
      harnessId: session.harnessIds.length ? session.harnessIds[session.harnessIds.length - 1] : null,
    }, payload);
  }
}

module.exports = { SessionManager, SESSION_STATES };
