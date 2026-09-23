// AgentGovernor: the limits that make dynamic agent creation safe.
//
// Dynamic agents are the point of the factory (agents/factory.js), and they are
// also the only way KingAgent could fork-bomb itself. An agent that decides it
// needs a specialist, which decides it needs a specialist, is a loop that looks
// productive in every log line and never terminates. So creation is bounded
// before it is allowed, not discovered to be wrong after.
//
// Every limit here exists because its absence is a specific failure mode:
//
//   maxDepth             infinite delegation chains
//   maxChildren          one agent spawning an unbounded team
//   maxConcurrentAgents  a thousand live agents from many shallow spawns
//   maxRuntimeMs         a stuck agent that never stops billing
//   maxTokenBudget       a single agent burning the whole budget
//   maxCost              the same, in money rather than tokens
//   maxTaskCount         an agent that "helps" forever
//   duplicateWindowMs    the same specialist re-created every second
//   role recursion       an agent creating more copies of its own kind
//
// The governor owns *live* agents only. Persisted definitions (including
// promoted ones) are the registry's business; a released agent stops counting
// against every limit the moment it stops running.

const GOVERNOR_DEFAULTS = Object.freeze({
  maxDepth: 3,
  maxChildren: 6,
  maxConcurrentAgents: 12,
  maxRuntimeMs: 30 * 60 * 1000,
  maxTokenBudget: 500_000,
  maxCost: 25,
  maxTaskCount: 50,
  duplicateWindowMs: 60_000,
  maxSpawnsPerRun: 50,
  // How far back a `usedBy` lookup walks. Bounded so a corrupted parent chain
  // cannot turn a check into an infinite loop.
  maxAncestry: 64,
});

const SPAWN_CODES = Object.freeze({
  TOO_DEEP: 'SPAWN_TOO_DEEP',
  TOO_WIDE: 'SPAWN_TOO_WIDE',
  TOO_MANY: 'SPAWN_TOO_MANY',
  DUPLICATE: 'SPAWN_DUPLICATE',
  RECURSIVE: 'SPAWN_RECURSIVE',
  BUDGET: 'SPAWN_BUDGET_EXCEEDED',
});

const USAGE_CODES = Object.freeze({
  RUNTIME: 'AGENT_RUNTIME_EXCEEDED',
  TOKENS: 'AGENT_TOKEN_BUDGET_EXCEEDED',
  COST: 'AGENT_COST_BUDGET_EXCEEDED',
  TASKS: 'AGENT_TASK_LIMIT_EXCEEDED',
});

class AgentGovernor {
  constructor({ config = {}, logger = null, clock = null } = {}) {
    this._config = { ...GOVERNOR_DEFAULTS, ...config };
    this._logger = logger;
    this._now = clock || (() => Date.now());
    this._live = new Map(); // agentId -> record
    this._spawnCount = 0;
  }

  get config() { return { ...this._config }; }
  get liveCount() { return this._live.size; }

  // A stable identity for "the same specialist". Role alone is too coarse (two
  // honest React specialists can differ), so capabilities are folded in — but
  // sorted, so declaration order cannot make one agent look like two.
  fingerprint({ role = null, capabilities = [], purpose = null } = {}) {
    const caps = [...(capabilities || [])].map(String).sort().join('+');
    return `${role || 'agent'}|${caps}|${purpose ? String(purpose).slice(0, 80) : ''}`;
  }

  register({ agentId, parentAgentId = null, role = null, fingerprint = null, depth = 0, startedAt = null }) {
    if (!agentId) throw new Error('governor.register requires an agentId');
    const record = {
      agentId,
      parentAgentId,
      role,
      fingerprint: fingerprint || this.fingerprint({ role }),
      depth: Number.isFinite(depth) ? depth : 0,
      // `startedAt` may legitimately be 0 (a clock-injected host, a test), so
      // this is a null check rather than a truthiness one.
      startedAt: startedAt === null || startedAt === undefined ? this._now() : startedAt,
      tokens: 0,
      cost: 0,
      tasks: 0,
      children: 0,
      exceeded: null,
    };
    this._live.set(agentId, record);
    this._spawnCount += 1;
    const parent = parentAgentId ? this._live.get(parentAgentId) : null;
    if (parent) parent.children += 1;
    return { ...record };
  }

  release(agentId) {
    return this._live.delete(agentId);
  }

  get(agentId) {
    const record = this._live.get(agentId);
    return record ? { ...record } : null;
  }

  childrenOf(parentAgentId) {
    return [...this._live.values()].filter((r) => r.parentAgentId === parentAgentId).map((r) => r.agentId);
  }

  // Walks up the parent chain, bounded, cycle-safe. Used to answer "is this
  // agent creating a copy of something already above it?".
  ancestry(agentId) {
    const out = [];
    const seen = new Set();
    let cursor = this._live.get(agentId);
    while (cursor && cursor.parentAgentId && out.length < this._config.maxAncestry) {
      const parent = this._live.get(cursor.parentAgentId);
      if (!parent || seen.has(parent.agentId)) break;
      seen.add(parent.agentId);
      out.push({ ...parent });
      cursor = parent;
    }
    return out;
  }

  // The decision the factory asks before creating anything. Returns
  // `{ allowed: true }` or `{ allowed: false, code, reason }` — a denial is a
  // structured answer, never a thrown exception, so the caller can record why.
  canSpawn({ parentAgentId = null, depth = 0, role = null, fingerprint = null } = {}) {
    const d = Number.isFinite(depth) ? depth : 0;
    if (d > this._config.maxDepth) {
      return deny(SPAWN_CODES.TOO_DEEP, `depth ${d} exceeds the limit of ${this._config.maxDepth}`);
    }
    // Concurrency is checked before the per-run count: "too many running right
    // now" is the more actionable answer when both limits are already reached.
    if (this._live.size >= this._config.maxConcurrentAgents) {
      return deny(SPAWN_CODES.TOO_MANY, `${this._live.size} agents are already running (limit ${this._config.maxConcurrentAgents})`);
    }
    if (this._spawnCount >= this._config.maxSpawnsPerRun) {
      return deny(SPAWN_CODES.BUDGET, `this run has already spawned ${this._spawnCount} agents (limit ${this._config.maxSpawnsPerRun})`);
    }
    if (parentAgentId) {
      const parent = this._live.get(parentAgentId);
      if (parent && parent.children >= this._config.maxChildren) {
        return deny(SPAWN_CODES.TOO_WIDE, `${parentAgentId} already has ${parent.children} children (limit ${this._config.maxChildren})`);
      }
      // Recursive spawn: the same role already present in this agent's own
      // chain — the parent itself included — means "a specialist spawning
      // another specialist of its own kind", which is how a delegation loop
      // disguises itself as work.
      if (role && this._roleInChain(parentAgentId, role)) {
        return deny(SPAWN_CODES.RECURSIVE, `role "${role}" already exists in the ancestry of ${parentAgentId}`);
      }
    }
    if (fingerprint) {
      const now = this._now();
      const twin = [...this._live.values()].find(
        (r) => r.fingerprint === fingerprint && (now - r.startedAt) <= this._config.duplicateWindowMs,
      );
      if (twin) {
        return deny(SPAWN_CODES.DUPLICATE, `${twin.agentId} with the same fingerprint was created ${now - twin.startedAt}ms ago`);
      }
    }
    return { allowed: true, code: null, reason: null };
  }

  // Records spend and answers whether the agent is now over any budget. Additive
  // only: there is no way to reset an agent's spend from here.
  noteUsage(agentId, { tokens = 0, cost = 0, tasks = 0 } = {}) {
    const record = this._live.get(agentId);
    if (!record) return { ok: false, code: 'GOVERNOR_UNKNOWN_AGENT', reason: `no live agent "${agentId}"` };
    record.tokens += Math.max(0, Number(tokens) || 0);
    record.cost += Math.max(0, Number(cost) || 0);
    record.tasks += Math.max(0, Number(tasks) || 0);
    const breach = this._breach(record, this._now());
    if (breach) record.exceeded = breach;
    return breach ? { ok: false, ...breach } : { ok: true, tokens: record.tokens, cost: record.cost, tasks: record.tasks };
  }

  // Agents that must be shut down now: over runtime or over any budget. The
  // watchdog a host runs on a timer, and the same check `noteUsage` applies.
  sweep(now = this._now()) {
    const out = [];
    for (const record of this._live.values()) {
      const breach = this._breach(record, now);
      if (breach) {
        record.exceeded = breach;
        out.push({ agentId: record.agentId, ...breach });
      }
    }
    return out;
  }

  snapshot(now = this._now()) {
    return [...this._live.values()].map((record) => ({
      ...record,
      runtimeMs: now - record.startedAt,
      overBudget: this._breach(record, now),
    }));
  }

  // For tests and for a run that deliberately wants a clean governor.
  reset() {
    this._live.clear();
    this._spawnCount = 0;
    return true;
  }

  // True when `role` is held by `agentId` or any of its ancestors.
  _roleInChain(agentId, role) {
    const self = this._live.get(agentId);
    if (self && self.role === role) return true;
    return this.ancestry(agentId).some((a) => a.role === role);
  }

  _breach(record, now) {
    const runtimeMs = now - record.startedAt;
    if (runtimeMs > this._config.maxRuntimeMs) {
      return { code: USAGE_CODES.RUNTIME, reason: `runtime ${runtimeMs}ms exceeds the limit of ${this._config.maxRuntimeMs}ms` };
    }
    if (record.tokens > this._config.maxTokenBudget) {
      return { code: USAGE_CODES.TOKENS, reason: `tokens ${record.tokens} exceed the budget of ${this._config.maxTokenBudget}` };
    }
    if (record.cost > this._config.maxCost) {
      return { code: USAGE_CODES.COST, reason: `cost ${record.cost} exceeds the budget of ${this._config.maxCost}` };
    }
    if (record.tasks > this._config.maxTaskCount) {
      return { code: USAGE_CODES.TASKS, reason: `tasks ${record.tasks} exceed the limit of ${this._config.maxTaskCount}` };
    }
    return null;
  }
}

function deny(code, reason) {
  return { allowed: false, code, reason };
}

module.exports = { AgentGovernor, GOVERNOR_DEFAULTS, SPAWN_CODES, USAGE_CODES };
