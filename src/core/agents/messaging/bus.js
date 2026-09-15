// AgentMessageBus: delivery between agents, with a participant list.
//
// This is *not* the platform EventBus. The EventBus is a broadcast telemetry
// stream anyone may watch; this is addressed delivery with a membership check —
// an agent can only message another agent that the coordinator has admitted to
// the same task. Without that check, "who can talk to whom" is decided by
// whoever writes a `toAgent` string, which in a multi-agent system means a
// model.
//
// Every delivered message is also mirrored onto the platform EventBus as
// `agent.message`, so the trace and the UI see the conversation without being
// able to inject into it.

const { TYPES } = require('../../events/event-bus');
const { validateMessage, MESSAGE_TYPES } = require('./message');

class MessageDeliveryError extends Error {
  constructor(message, { code = 'MESSAGE_DENIED' } = {}) {
    super(message);
    this.name = 'MessageDeliveryError';
    this.code = code;
  }
}

class AgentMessageBus {
  constructor({ bus = null, logger = null, maxInbox = 500, maxHistory = 2000 } = {}) {
    this._bus = bus;
    this._logger = logger;
    this._maxInbox = maxInbox;
    this._maxHistory = maxHistory;
    this._participants = new Map(); // taskId -> Set<agentId>
    this._inbox = new Map();        // agentId -> message[]
    this._subscribers = new Map();  // agentId -> Set<fn>
    this._history = [];             // chronological, bounded
  }

  // Membership is the permission model. The coordinator admits participants
  // when it starts a task and when it delegates; nothing else may.
  join(taskId, agentId) {
    if (!this._participants.has(taskId)) this._participants.set(taskId, new Set());
    this._participants.get(taskId).add(agentId);
    return [...this._participants.get(taskId)];
  }

  leave(taskId, agentId) {
    const set = this._participants.get(taskId);
    if (set) set.delete(agentId);
    return set ? [...set] : [];
  }

  participants(taskId) {
    return [...(this._participants.get(taskId) || [])];
  }

  canSend(taskId, fromAgent, toAgent) {
    const set = this._participants.get(taskId);
    if (!set) return { ok: false, reason: `task ${taskId} has no participants` };
    if (!set.has(fromAgent)) return { ok: false, reason: `${fromAgent} is not a participant of ${taskId}` };
    if (!set.has(toAgent)) return { ok: false, reason: `${toAgent} is not a participant of ${taskId}` };
    return { ok: true };
  }

  send(def) {
    const { ok, message, errors } = validateMessage(def);
    if (!ok) throw new MessageDeliveryError(`invalid agent message: ${errors.join('; ')}`, { code: 'MESSAGE_INVALID' });
    if (!message.taskId) throw new MessageDeliveryError('an agent message requires a taskId', { code: 'MESSAGE_INVALID' });

    const verdict = this.canSend(message.taskId, message.fromAgent, message.toAgent);
    if (!verdict.ok) throw new MessageDeliveryError(`message refused: ${verdict.reason}`);

    if (!this._inbox.has(message.toAgent)) this._inbox.set(message.toAgent, []);
    const box = this._inbox.get(message.toAgent);
    box.push(message);
    if (box.length > this._maxInbox) box.splice(0, box.length - this._maxInbox);

    this._history.push(message);
    if (this._history.length > this._maxHistory) this._history.splice(0, this._history.length - this._maxHistory);

    for (const fn of this._subscribers.get(message.toAgent) || []) {
      try { fn(message); } catch (err) {
        if (this._logger) this._logger.warn('agent message subscriber threw', { error: err.message });
      }
    }

    if (this._bus) {
      this._bus.emit(TYPES.AGENT_MESSAGE, {
        taskId: message.taskId, agentId: message.fromAgent,
        workspaceId: message.workspaceId, traceId: message.traceId,
      }, {
        id: message.id, from: message.fromAgent, to: message.toAgent,
        type: message.type, attachments: message.attachments.length,
      });
    }
    return message;
  }

  // Returns an unsubscribe function, like EventBus.on.
  subscribe(agentId, fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe requires a function');
    if (!this._subscribers.has(agentId)) this._subscribers.set(agentId, new Set());
    this._subscribers.get(agentId).add(fn);
    return () => this._subscribers.get(agentId).delete(fn);
  }

  // Reading drains by default: a message delivered twice is a message acted on
  // twice, which for a DELEGATION is a second execution.
  inbox(agentId, { drain = true, taskId = null } = {}) {
    const box = this._inbox.get(agentId) || [];
    const selected = taskId ? box.filter((m) => m.taskId === taskId) : [...box];
    if (drain) {
      this._inbox.set(agentId, taskId ? box.filter((m) => m.taskId !== taskId) : []);
    }
    return selected;
  }

  peek(agentId) {
    return [...(this._inbox.get(agentId) || [])];
  }

  history({ taskId = null, agentId = null, limit = 200 } = {}) {
    return this._history
      .filter((m) => (!taskId || m.taskId === taskId)
        && (!agentId || m.fromAgent === agentId || m.toAgent === agentId))
      .slice(-limit);
  }

  // Everything for a finished task, so a completed run does not keep its
  // conversation resident forever.
  clearTask(taskId) {
    this._participants.delete(taskId);
    for (const [agentId, box] of this._inbox) {
      this._inbox.set(agentId, box.filter((m) => m.taskId !== taskId));
    }
    this._history = this._history.filter((m) => m.taskId !== taskId);
    return true;
  }
}

module.exports = { AgentMessageBus, MessageDeliveryError, MESSAGE_TYPES };
