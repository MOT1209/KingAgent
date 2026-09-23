// Who is driving a browser session: an agent or a person.
//
// §23 of the target asks for TAKE CONTROL / RETURN CONTROL, and the part that
// actually matters is the sentence after it — "the agent must stop interacting
// with that browser session until control is returned". Enforced in the UI that
// would be a suggestion: a click already in flight lands anyway, and the person
// who took control watches the page move under their hands. So the rule lives
// here, in the one object every browser action already passes through, and a
// refused action is refused rather than left to race.
//
// Sessions are *names*, not objects: the host owns the real Electron webContents
// and this layer only holds who owns the driving. That keeps this file runnable
// in plain node, which is what makes it testable at all.

const { TYPES } = require('../events/event-bus');

const OWNERS = Object.freeze({ AGENT: 'agent', HUMAN: 'human' });

class BrowserControlError extends Error {
  constructor(message, { code = 'BROWSER_DENIED', sessionId = null, owner = null } = {}) {
    super(message);
    this.name = 'BrowserControlError';
    this.code = code;
    this.sessionId = sessionId;
    this.owner = owner;
  }
}

class BrowserControl {
  constructor({ bus = null, logger = null } = {}) {
    this._bus = bus;
    this._logger = logger;
    this._sessions = new Map(); // sessionId -> { owner, agentId, reason, title, since, openedAt }
  }

  // A host opens a session the moment a tab exists. Idempotent on purpose: a
  // host that re-reports a tab (a reload, a second window) must not silently
  // reset an owner a person already took, which would hand the page back to the
  // agent behind their back.
  open(sessionId, { agentId = null, title = '', url = null } = {}) {
    const id = requireSessionId(sessionId);
    const existing = this._sessions.get(id);
    if (existing) {
      if (title) existing.title = String(title).slice(0, 200);
      if (url) existing.url = String(url).slice(0, 4096);
      return this.get(id);
    }
    const session = {
      sessionId: id,
      owner: OWNERS.AGENT,
      agentId: agentId || null,
      reason: '',
      title: String(title || '').slice(0, 200),
      url: url ? String(url).slice(0, 4096) : null,
      openedAt: Date.now(),
      since: Date.now(),
    };
    this._sessions.set(id, session);
    this._emit(TYPES.BROWSER_SESSION_OPENED, session, { agentId });
    return this.get(id);
  }

  close(sessionId, { reason = '' } = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;
    this._sessions.delete(sessionId);
    this._emit(TYPES.BROWSER_SESSION_CLOSED, session, { reason });
    return true;
  }

  get(sessionId) {
    const session = this._sessions.get(sessionId);
    return session ? { ...session } : undefined;
  }

  list({ owner } = {}) {
    const all = [...this._sessions.values()].map((s) => ({ ...s }));
    return owner ? all.filter((s) => s.owner === owner) : all;
  }

  // A person takes the wheel. From here on every agent action on this session is
  // refused until `returnControl` — including actions already queued, because
  // the check happens inside the tool call, not before it.
  takeControl(sessionId, { by = 'king', reason = '' } = {}) {
    const session = this._require(sessionId);
    const from = session.owner;
    session.owner = OWNERS.HUMAN;
    session.reason = String(reason || '').slice(0, 400);
    session.since = Date.now();
    this._emit(TYPES.BROWSER_PAUSED, session, { by, from, reason: session.reason });
    this._transfer(session, { from, to: OWNERS.HUMAN, by });
    return this.get(sessionId);
  }

  returnControl(sessionId, { by = 'king', agentId = null } = {}) {
    const session = this._require(sessionId);
    const from = session.owner;
    session.owner = OWNERS.AGENT;
    if (agentId) session.agentId = agentId;
    session.reason = '';
    session.since = Date.now();
    this._emit(TYPES.BROWSER_RESUMED, session, { by, from });
    this._transfer(session, { from, to: OWNERS.AGENT, by });
    return this.get(sessionId);
  }

  // The gate every browser tool calls before it touches the page.
  //
  // Returns the session so the tool does not have to look it up twice. Throws
  // rather than returning false: a caller that forgot to check must not be able
  // to proceed by ignoring a boolean.
  assertAgentMayAct(sessionId, agentId = null) {
    const session = this._require(sessionId);
    if (session.owner === OWNERS.HUMAN) {
      throw new BrowserControlError(
        `session ${sessionId} is under human control; the agent is paused until control is returned`,
        { code: 'BROWSER_HUMAN_CONTROL', sessionId, owner: OWNERS.HUMAN },
      );
    }
    // A session is owned by one agent at a time. A second agent acting on it is
    // not a permission question but a correctness one — two actors in one tab
    // interleave into a state neither of them intended.
    if (session.agentId && agentId && session.agentId !== agentId) {
      throw new BrowserControlError(
        `session ${sessionId} belongs to agent ${session.agentId}`,
        { code: 'BROWSER_SESSION_OWNED', sessionId, owner: session.agentId },
      );
    }
    if (!session.agentId && agentId) session.agentId = agentId;
    return { ...session };
  }

  // Called by the tools after a successful action so the record reflects where
  // the session actually is, not only where it was opened.
  note(sessionId, { url, title } = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) return undefined;
    if (url) session.url = String(url).slice(0, 4096);
    if (title) session.title = String(title).slice(0, 200);
    return { ...session };
  }

  _require(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new BrowserControlError(`unknown browser session "${sessionId}"`, {
        code: 'BROWSER_NO_SESSION',
        sessionId,
      });
    }
    return session;
  }

  _transfer(session, { from, to, by }) {
    this._emit(TYPES.BROWSER_CONTROL_TRANSFERRED, session, { from, to, by });
  }

  _emit(type, session, payload) {
    if (!this._bus) return;
    this._bus.emit(type, { sessionId: session.sessionId, agentId: session.agentId || null }, {
      ...payload,
      owner: session.owner,
      title: session.title || null,
      url: session.url || null,
    });
  }
}

function requireSessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new BrowserControlError('a browser session needs an id (a non-empty string under 200 chars)', {
      code: 'BROWSER_INVALID_SESSION',
    });
  }
  return value.trim();
}

module.exports = { BrowserControl, BrowserControlError, OWNERS };
