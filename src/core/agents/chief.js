// ChiefSystem: the shape of the organization, as three calls.
//
// Ahmad plans, Rashid executes, and Rashid creates a specialist when the plan
// needs a capability nobody has. That is the whole hierarchy — and it is
// deliberately a *facade*, not a fourth orchestrator: `plan` is the existing
// router deciding a shape, `execute` is the existing orchestrator, and
// `spawnSpecialist` is the governed agent factory. If this class ever grows a
// planner or a scheduler of its own, it has become the problem.
//
// It exists so a host (and the UI) has one obvious place to say "run my AI
// organization on this", instead of wiring four subsystems in the right order
// every time.

const { TYPES } = require('../events/event-bus');

class ChiefSystem {
  constructor({
    registry,
    orchestrator = null,
    coordinator = null,
    agentFactory = null,
    governor = null,
    runs = null,
    bus = null,
    logger = null,
  } = {}) {
    if (!registry) throw new Error('ChiefSystem requires the agent registry');
    this._registry = registry;
    this._orchestrator = orchestrator;
    this._coordinator = coordinator;
    this._factory = agentFactory;
    this._governor = governor;
    this._runs = runs;
    this._bus = bus;
    this._logger = logger;
  }

  get ahmad() { return this._registry.get('ahmad') || null; }
  get rashid() { return this._registry.get('rashid') || null; }

  // Ahmad's contribution: decide what work exists, without doing any of it.
  plan({ request, agentId = null } = {}) {
    if (!request) throw new Error('chief.plan requires a request');
    if (!this._orchestrator) {
      return { agent: 'ahmad', role: 'chief-planner', decision: null, reason: 'no orchestrator is wired' };
    }
    return {
      agent: 'ahmad',
      role: 'chief-planner',
      decision: this._orchestrator.route({ request, agentId }),
    };
  }

  // Rashid's contribution: get it done, as Rashid, so the run records the
  // executive as the responsible agent rather than "whoever was selected".
  async execute({ request, ...options } = {}) {
    if (!this._orchestrator) throw new Error('chief.execute requires an orchestrator');
    const record = await this._orchestrator.handle({ request, ...options, agentId: 'rashid' });
    if (this._bus) {
      this._bus.emit(TYPES.AGENT_STARTED, { agentId: 'rashid', runId: record.runId || null }, { request: String(request).slice(0, 200), role: 'executive' });
    }
    return record;
  }

  // "I need another specialist." Ahmad plans work that needs a capability the
  // roster lacks; Rashid asks the factory for it. The factory — not this class —
  // decides whether the governor allows it and whether the King must approve.
  async spawnSpecialist({
    role,
    name = null,
    purpose = null,
    systemPrompt = '',
    capabilities = [],
    tools = [],
    skills = [],
    permissions = null,
    modelPolicy = null,
    providerPolicy = null,
    risk = 'low',
    lifetime = 'task',
    rootTaskId = null,
    projectId = null,
    conversationId = null,
  } = {}) {
    if (!this._factory) return { created: false, code: 'NO_FACTORY', reason: 'no agent factory is wired' };
    const proposal = this._factory.propose({
      createdBy: 'rashid',
      parentAgentId: 'rashid',
      rootTaskId,
      projectId,
      conversationId,
      role,
      name,
      purpose,
      systemPrompt,
      capabilities,
      tools,
      skills,
      permissions,
      modelPolicy,
      providerPolicy,
      risk,
      lifetime,
    });
    if (!proposal.ok) {
      return { created: false, code: 'FACTORY_INVALID', reason: proposal.errors.join('; ') };
    }
    // Depth 1: a specialist is one level below the executive, never further.
    return this._factory.create(proposal, { depth: 1 });
  }

  async retireSpecialist(agentId, { reason = 'task complete' } = {}) {
    if (!this._factory) return { destroyed: false, code: 'NO_FACTORY' };
    return this._factory.destroy(agentId, { reason });
  }

  async promoteSpecialist(agentId, { name = null, promotedBy = 'king', reason = 'promoted by the King' } = {}) {
    if (!this._factory) return { promoted: false, code: 'NO_FACTORY' };
    return this._factory.promote(agentId, { name, promotedBy, reason });
  }

  // Who is on the roster right now — the question an organization view asks.
  roster() {
    return {
      system: [this.ahmad, this.rashid].filter(Boolean),
      specialists: this._factory ? this._factory.listDynamic() : [],
      persistent: this._factory ? this._factory.listPersistent() : [],
      live: this._governor ? this._governor.snapshot() : [],
    };
  }

  // The review loop (Ahmad over Rashid's results), as an inspectable call.
  async review({ runId } = {}) {
    if (!this._runs || !runId) return null;
    return this._runs.inspect(runId);
  }
}

module.exports = { ChiefSystem };
