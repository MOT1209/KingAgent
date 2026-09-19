// Agent Router: which Agent, on which Harness, for this task.
//
// §11 lists what the router evaluates (task type, required capabilities,
// workspace, available agents and harnesses, model availability, permissions,
// platform, performance, cost) and §12 lists the strategies. §12 is also
// emphatic that this is *not* autonomous: every decision must be deterministic
// and explainable. So this file has no learning, no randomness and no tie
// broken by iteration order — two identical inputs produce one identical
// answer, and the answer carries the reasons for every candidate it considered.
//
// The shape of the decision:
//
//   { strategy, agentId, harnessId, model, score, reasons[], candidates[] }
//
// `candidates` is the whole shortlist with each one's score and the sentence
// explaining it, which is what the UI shows when someone asks "why that agent?"
//
// Strategies, and what each one is for:
//
//   manual              the caller named both; the router only validates
//   fixed               the agent's own binding decides (agent.metadata.harness)
//   priority            an explicit ordered preference list decides ties
//                        (agent.metadata.harnessPriority), everything else
//                        still has to clear the capability/policy gates first
//   capability          most capable fit — the default
//   best_available      prefer backends this machine actually has installed
//   policy              policy verdict first, capability second
//   cost_aware          cheapest compatible backend first
//   performance_aware   best observed success rate, then fastest

const { TASK_CAPABILITY_HINTS } = require('../harness/presets');
const { TYPES } = require('../events/event-bus');

const ROUTING_STRATEGIES = Object.freeze([
  'manual',
  'fixed',
  'priority',
  'capability',
  'best_available',
  'policy',
  'cost_aware',
  'performance_aware',
]);

// An agent's capability vocabulary comes from agents/definition.js ('read',
// 'write', 'code', 'git', 'run_tests'); a harness declares capability *tags*.
// This is the translation, and it is a table rather than a guess.
const AGENT_CAPABILITY_MAP = Object.freeze({
  read: 'files',
  write: 'files',
  filesystem: 'files',
  code: 'coding',
  coding: 'coding',
  git: 'git',
  run_tests: 'terminal',
  shell: 'terminal',
  terminal: 'terminal',
  repository_analysis: 'files',
  code_search: 'files',
  research: 'research',
  review: 'review',
  report: 'files',
  document: 'files',
  planning: 'planning',
  browser: 'browser',
});

const TASK_TYPE_HINTS = Object.freeze({
  review: ['review', 'diff', 'audit', 'critique'],
  research: ['research', 'investigate', 'find out', 'analyze', 'analyse', 'report'],
  test: ['test', 'tests', 'failing', 'regression', 'coverage'],
  document: ['document', 'readme', 'docs', 'explain'],
  code: ['fix', 'bug', 'implement', 'refactor', 'feature', 'build', 'add'],
});

// Classify a request. Keyword scoring, not a model call: the router must not
// depend on a provider to make its decision, or routing would be unavailable in
// exactly the degraded conditions where a deterministic fallback matters.
function classifyTask(request = '') {
  const text = String(request).toLowerCase();
  const scores = {};
  for (const [type, words] of Object.entries(TASK_TYPE_HINTS)) {
    scores[type] = words.reduce((n, w) => (text.includes(w) ? n + 1 : n), 0);
  }
  let best = 'code';
  let bestScore = 0;
  for (const type of Object.keys(TASK_TYPE_HINTS)) {
    if (scores[type] > bestScore) { best = type; bestScore = scores[type]; }
  }
  return { type: bestScore === 0 ? 'code' : best, scores, required: TASK_CAPABILITY_HINTS[best] || TASK_CAPABILITY_HINTS.code };
}

// What capability tags must a backend declare to take this agent's work?
function requiredTagsFor(agent, taskType) {
  const tags = new Set(TASK_CAPABILITY_HINTS[taskType] || []);
  for (const cap of agent.capabilities || []) {
    const tag = AGENT_CAPABILITY_MAP[cap];
    if (tag) tags.add(tag);
  }
  // An agent that can write needs a filesystem; one that runs tests needs a
  // terminal. Derived from the agent, not from the request text.
  if ((agent.capabilities || []).includes('write')) tags.add('files');
  return [...tags].sort();
}

class AgentRouter {
  constructor({
    agentRegistry = null,
    harnessRegistry = null,
    policy = null,
    bus = null,
    logger = null,
    platform = null,
    costs = {},
    metrics = null,
  } = {}) {
    this._agents = agentRegistry;
    this._harnesses = harnessRegistry;
    this._policy = policy;
    this._bus = bus;
    this._logger = logger;
    this._platform = platform || currentPlatform();
    this._costs = costs || {};
    this._metrics = metrics || null;
  }

  // The public entry point. Returns a decision, never throws for "nothing
  // available" — an unavailable route is information the caller needs.
  async route({
    request = '',
    taskId = null,
    sessionId = null,
    workspaceId = null,
    strategy = 'capability',
    agentId = null,
    harnessId = null,
    platform = null,
    model = null,
  } = {}) {
    const chosenStrategy = ROUTING_STRATEGIES.includes(strategy) ? strategy : 'capability';
    const os = platform || this._platform;
    const classification = classifyTask(request);
    const agents = this._agentCandidates(agentId);

    if (agents.length === 0) {
      return this._emitDecision({
        strategy: chosenStrategy,
        agentId: null,
        harnessId: null,
        model,
        score: 0,
        reasons: ['no enabled agents are registered'],
        candidates: [],
        classification,
      }, { taskId, sessionId, workspaceId });
    }

    const candidates = [];
    for (const agent of agents) {
      const required = requiredTagsFor(agent, classification.type);
      const resolved = this._harnesses
        ? this._harnesses.resolve({ id: harnessId, capabilities: required, platform: os, model: model || agent.model.id })
        : { harness: null, candidates: [], reasons: ['no harness registry is wired'] };

      if (!resolved.harness) {
        candidates.push({
          agentId: agent.id,
          harnessId: null,
          eligible: false,
          score: -1,
          required,
          reasons: resolved.reasons.length ? resolved.reasons : ['no compatible harness'],
        });
        continue;
      }

      // Every harness that could take this agent, so the strategy sees the
      // whole picture rather than the registry's default pick.
      const eligibleHarnesses = harnessId
        ? [resolved.harness]
        : this._compatibleHarnesses(agent, required, os, model).sort(byHarnessId);

      for (const harness of eligibleHarnesses) {
        const scored = this._scorePair({ agent, harness, classification, required, strategy });
        candidates.push(scored);
      }
    }

    if (this._policy) await this._applyPolicy(candidates, { taskId, sessionId, workspaceId, classification });

    const ranked = candidates
      .filter((c) => c.eligible)
      .sort(byScoreThenIds);

    if (ranked.length === 0) {
      return this._emitDecision({
        strategy: chosenStrategy,
        agentId: null,
        harnessId: null,
        model,
        score: 0,
        reasons: candidates.length
          ? [...new Set(candidates.flatMap((c) => c.reasons))].slice(0, 6)
          : ['no candidates were evaluated'],
        candidates: trimCandidates(candidates),
        classification,
      }, { taskId, sessionId, workspaceId });
    }

    const winner = ranked[0];
    return this._emitDecision({
      strategy: chosenStrategy,
      agentId: winner.agentId,
      harnessId: winner.harnessId,
      model: model || (this._agents && this._agents.get(winner.agentId) ? this._agents.get(winner.agentId).model.id : null),
      score: winner.score,
      reasons: winner.reasons,
      candidates: trimCandidates(candidates),
      classification,
    }, { taskId, sessionId, workspaceId });
  }

  _agentCandidates(agentId) {
    if (!this._agents) return [];
    if (agentId) {
      const one = this._agents.get(agentId);
      return one ? [one] : [];
    }
    return this._agents.list({ enabled: true }).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  _compatibleHarnesses(agent, required, os, model) {
    if (!this._harnesses) return [];
    const out = [];
    for (const spec of this._harnesses.list()) {
      const harness = this._harnesses.get(spec.id);
      if (!harness) continue;
      const verdict = harness.compatible({ required, platform: os });
      if (!verdict.ok) continue;
      const models = harness.supportedModels;
      if (model && models.length > 0 && !models.includes(model)) continue;
      out.push(harness);
    }
    return out;
  }

  _scorePair({ agent, harness, classification, required, strategy }) {
    const reasons = [];
    let score = 0;

    // Capability fit: every required tag present, and fewer surplus tags is a
    // better match (the same "most specific backend" rule the registry uses).
    const declared = new Set(harness.capabilities.tags);
    const surplus = harness.capabilities.tags.filter((t) => !required.includes(t)).length;
    score += 10 + required.length - surplus * 0.25;
    reasons.push(`declares ${required.filter((t) => declared.has(t)).join(', ') || 'no requirements'}`);

    if (classification.type && TASK_CAPABILITY_HINTS[classification.type]) {
      const typeTags = TASK_CAPABILITY_HINTS[classification.type];
      if (typeTags.every((t) => declared.has(t))) {
        score += 3;
        reasons.push(`fits task type "${classification.type}"`);
      }
    }

    // The agent's own model binding, honoured when the harness can drive it.
    if (agent.model && agent.model.id && agent.model.id !== 'default') {
      if (harness.supportedModels.length === 0) {
        reasons.push(`declares no model list; assuming it can drive "${agent.model.id}"`);
      } else if (harness.supportedModels.includes(agent.model.id)) {
        score += 2;
        reasons.push(`supports model "${agent.model.id}"`);
      } else {
        score -= 5;
        reasons.push(`does not list model "${agent.model.id}"`);
      }
    }

    const detection = this._harnesses ? this._harnesses.detected(harness.id) : null;
    const installed = detection ? detection.installed === true : harness.type === 'in-process';
    if (installed) {
      score += 1;
      reasons.push(harness.type === 'in-process' ? 'always available' : 'detected on this machine');
    }

    // The internal runtime is the floor: it is the only backend that is
    // guaranteed present, so it wins ties and is the documented fallback.
    if (harness.id === 'kingagent-runtime') {
      score += 0.5;
      reasons.push('built-in backend');
    }

    score += this._strategyAdjustment({ strategy, harness, agent, required, reasons });

    return {
      agentId: agent.id,
      harnessId: harness.id,
      eligible: true,
      score: round(score),
      required,
      installed,
      reasons,
    };
  }

  // Each strategy is an *adjustment on top of the shared capability score*, not
  // a separate implementation. That is what keeps the reasons comparable
  // between strategies instead of producing seven incompatible rankings.
  _strategyAdjustment({ strategy, harness, agent, reasons }) {
    switch (strategy) {
      case 'fixed': {
        const bound = (agent.metadata && agent.metadata.harness) || null;
        if (bound && harness.id === bound) {
          reasons.push(`agent is bound to ${bound}`);
          return 100;
        }
        if (bound) {
          reasons.push(`agent is bound to ${bound}, not ${harness.id}`);
          return -100;
        }
        return 0;
      }
      // An ordered preference list ("try codex, then claude-code, then
      // whatever else fits") rather than a single hard binding. Position in
      // the list beats capability-score differences of the size this file's
      // other adjustments produce, but a harness the agent doesn't declare a
      // preference for is untouched — it still competes on capability fit.
      case 'priority': {
        const order = (agent.metadata && Array.isArray(agent.metadata.harnessPriority)) ? agent.metadata.harnessPriority : null;
        if (!order || order.length === 0) return 0;
        const rank = order.indexOf(harness.id);
        if (rank === -1) {
          reasons.push('not in the agent\'s harness priority list');
          return 0;
        }
        reasons.push(`priority ${rank + 1} of ${order.length}`);
        return 50 - rank; // strictly decreasing by position, always above capability-only spread
      }
      case 'best_available': {
        const installed = this._harnesses ? this._harnesses.detected(harness.id) : null;
        const present = installed ? installed.installed === true : harness.type === 'in-process';
        if (present) return 20;
        reasons.push('not present on this machine');
        return -20;
      }
      case 'cost_aware': {
        const cost = this._costOf(harness.id);
        reasons.push(cost === null ? 'cost unknown' : `cost ${cost}`);
        return cost === null ? 0 : -cost;
      }
      case 'performance_aware': {
        const m = this._metricsFor(agent.id, harness.id);
        if (!m) { reasons.push('no performance history'); return 0; }
        const rate = m.successRate === null || m.successRate === undefined ? 0.5 : m.successRate;
        const speed = m.avgDurationMs ? Math.min(1, 60_000 / m.avgDurationMs) : 0.5;
        reasons.push(`observed success rate ${rate.toFixed(2)}`);
        return rate * 10 + speed * 5;
      }
      case 'policy':
      case 'manual':
      case 'capability':
      default:
        return 0;
    }
  }

  // Policy filtering is a *filter*, applied before ranking, so a denied pair can
  // never win on score. In `policy` strategy the decision also contributes
  // score, so an explicitly allowed pair outranks an unmentioned one.
  async _applyPolicy(candidates, { taskId, sessionId, workspaceId, classification }) {
    for (const candidate of candidates) {
      if (!candidate.eligible) continue;
      const decision = await this._policy.evaluate({
        action: 'agent.route',
        askApproval: false,
        context: {
          taskId,
          sessionId,
          workspaceId,
          agentId: candidate.agentId,
          harnessId: candidate.harnessId,
        },
      });
      candidate.policyEffect = decision.effect;
      candidate.reasons.push(`policy: ${decision.effect}${decision.policyId ? ` (${decision.policyId})` : ''}`);
      if (decision.effect === 'deny') {
        candidate.eligible = false;
        candidate.score = -1;
      } else if (decision.effect === 'allow') {
        candidate.score = round(candidate.score + 1);
      }
      candidate.classificationType = classification.type;
    }
  }

  _costOf(harnessId) {
    const value = this._costs[harnessId];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  _metricsFor(agentId, harnessId) {
    if (typeof this._metrics === 'function') return this._metrics(agentId, harnessId) || null;
    if (this._metrics && typeof this._metrics.get === 'function') return this._metrics.get(agentId, harnessId) || null;
    return null;
  }

  _emitDecision(decision, refs) {
    const result = Object.freeze({
      ...decision,
      platform: this._platform,
      deterministic: true,
      at: Date.now(),
    });
    if (this._bus) {
      this._bus.emit(TYPES.AGENT_ROUTED, {
        taskId: refs.taskId,
        sessionId: refs.sessionId,
        workspaceId: refs.workspaceId,
        agentId: result.agentId,
        harnessId: result.harnessId,
      }, {
        strategy: result.strategy,
        score: result.score,
        taskType: result.classification.type,
        candidates: result.candidates.length,
        reasons: result.reasons.slice(0, 5),
      });
    }
    if (this._logger) this._logger.debug(`routed to ${result.agentId || 'none'}/${result.harnessId || 'none'}`, { strategy: result.strategy });
    return result;
  }
}

function byScoreThenIds(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.agentId !== b.agentId) return a.agentId < b.agentId ? -1 : 1;
  return a.harnessId < b.harnessId ? -1 : 1;
}

function byHarnessId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// The decision carries a shortlist, not every pair ever considered.
function trimCandidates(candidates, limit = 8) {
  return candidates
    .slice()
    .sort((a, b) => (b.score - a.score) || (a.agentId + a.harnessId < b.agentId + b.harnessId ? -1 : 1))
    .slice(0, limit)
    .map((c) => ({
      agentId: c.agentId,
      harnessId: c.harnessId,
      eligible: c.eligible,
      score: c.score,
      required: c.required,
      reasons: c.reasons.slice(0, 4),
    }));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function currentPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

module.exports = {
  ROUTING_STRATEGIES,
  AGENT_CAPABILITY_MAP,
  TASK_TYPE_HINTS,
  classifyTask,
  requiredTagsFor,
  AgentRouter,
  trimCandidates,
};
