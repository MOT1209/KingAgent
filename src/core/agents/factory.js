// AgentFactory: runtime creation of specialists, governed and reversible.
//
// The registry can always *store* a definition — this module is about whether
// it may be created, by whom, under what risk and with what limits. That
// distinction is the whole safety story for dynamic agents: "Rashid can make a
// specialist" is only defensible if there is one place that says no.
//
// Three phases, deliberately separate:
//
//   propose()  build a valid AgentDefinition (no side effects at all)
//   create()   ask the governor, ask for approval if risk requires it, register
//   destroy()  stop counting it against limits and remove the definition
//
// Promotion ('a temporary agent that earned its place') is the same registry
// update with better provenance — it never re-registers an agent, so a run's
// lineage survives being made permanent.

const { TYPES } = require('../events/event-bus');
const { isPlainObject, validId, nonEmptyString } = require('../schema/validate');
const { validateAgentDefinition } = require('./definition');

const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

// Prompt §31, as defaults. `auto` creates and runs; `approve_execution` creates
// the definition but a human authorizes the first run; `approve_creation` gates
// the definition itself; `deny` refuses outright.
const DEFAULT_SPAWN_POLICY = Object.freeze({
  low: 'auto',
  medium: 'approve_execution',
  high: 'approve_creation',
  critical: 'approve_creation',
});

const SPAWN_EFFECTS = Object.freeze(['auto', 'approve_execution', 'approve_creation', 'deny']);

class AgentFactory {
  constructor({
    registry,
    governor = null,
    bus = null,
    logger = null,
    approver = null, // ({ action, summary, risk, proposal }) -> boolean
    spawnPolicy = {},
    clock = null,
  } = {}) {
    if (!registry) throw new Error('AgentFactory requires an agent registry');
    this._registry = registry;
    this._governor = governor;
    this._bus = bus;
    this._logger = logger;
    this._approver = typeof approver === 'function' ? approver : null;
    this._spawnPolicy = { ...DEFAULT_SPAWN_POLICY, ...spawnPolicy };
    this._now = clock || (() => Date.now());
  }

  get spawnPolicy() { return { ...this._spawnPolicy }; }

  setSpawnPolicy(patch = {}) {
    for (const [risk, effect] of Object.entries(patch)) {
      if (!RISK_LEVELS.includes(risk)) continue;
      if (!SPAWN_EFFECTS.includes(effect)) continue;
      this._spawnPolicy[risk] = effect;
    }
    return this.spawnPolicy;
  }

  // Builds a definition without touching the registry. Returns a structured
  // result rather than throwing, so a proposal that is refused for a *reason*
  // can be shown to whoever asked for it.
  propose({
    createdBy = 'rashid',
    parentAgentId = null,
    rootTaskId = null,
    conversationId = null,
    projectId = null,
    role,
    name = null,
    description = null,
    purpose = null,
    systemPrompt = '',
    capabilities = [],
    tools = [],
    skills = [],
    permissions = null,
    modelPolicy = null,
    providerPolicy = null,
    memoryPolicy = null,
    workspacePolicy = null,
    lifetime = 'task',
    risk = 'low',
    id = null,
  } = {}) {
    if (!nonEmptyString(role)) return { ok: false, errors: ['a dynamic agent requires a role'] };
    const normalizedRisk = RISK_LEVELS.includes(risk) ? risk : 'low';
    const agentId = id || mintAgentId(role);
    if (!validId(agentId)) return { ok: false, errors: [`invalid agent id: ${JSON.stringify(agentId)}`] };

    const definition = {
      id: agentId,
      name: name || titleCase(role),
      description: description || purpose || `Dynamically created ${role} agent`,
      systemPrompt,
      model: {
        provider: (providerPolicy && providerPolicy.default) || 'unset',
        id: (modelPolicy && modelPolicy.default) || 'default',
      },
      capabilities: [...capabilities],
      tools: [...tools],
      skills: [...skills],
      ...(isPlainObject(permissions) ? { permissions } : {}),
      ...(isPlainObject(memoryPolicy) ? { memoryPolicy } : {}),
      ...(isPlainObject(workspacePolicy) ? { workspacePolicy } : {}),
      metadata: {
        dynamic: true,
        persistent: false,
        role,
        purpose: purpose || description || null,
        risk: normalizedRisk,
        lifetime,
        createdBy,
        parentAgentId,
        rootTaskId,
        conversationId,
        projectId,
        modelPolicy: isPlainObject(modelPolicy) ? { ...modelPolicy } : null,
        providerPolicy: isPlainObject(providerPolicy) ? { ...providerPolicy } : null,
        lineage: {
          createdBy,
          parentAgentId,
          rootTaskId,
          conversationId,
          projectId,
          createdAt: this._now(),
        },
      },
    };

    const { ok, errors } = validateAgentDefinition(definition);
    if (!ok) return { ok: false, errors };
    return {
      ok: true,
      errors: [],
      risk: normalizedRisk,
      definition,
      fingerprint: this._governor
        ? this._governor.fingerprint({ role, capabilities, purpose })
        : null,
    };
  }

  // Creates a proposed agent. Every path returns a decision object, so a caller
  // can always explain why an agent does or does not exist.
  async create(proposal, { approver = null, depth = 0 } = {}) {
    const proposed = unwrap(proposal);
    if (!proposed || !proposed.definition) return { created: false, code: 'FACTORY_INVALID', reason: 'create() requires a proposal from propose()' };
    const { definition } = proposed;
    const risk = proposal.risk || definition.metadata.risk || 'low';
    const policy = this._spawnPolicy[risk] || 'auto';

    if (policy === 'deny') {
      this._denied(definition, { code: 'SPAWN_POLICY_DENIED', reason: `spawning a ${risk}-risk agent is denied by policy` });
      return { created: false, code: 'SPAWN_POLICY_DENIED', reason: `spawning a ${risk}-risk agent is denied by policy` };
    }

    // The governor is consulted before anything is asked of a human: there is no
    // point interrupting King to approve an agent that limits forbid anyway.
    if (this._governor) {
      const verdict = this._governor.canSpawn({
        parentAgentId: definition.metadata.parentAgentId,
        depth,
        role: definition.metadata.role,
        fingerprint: proposed.fingerprint,
      });
      if (!verdict.allowed) {
        this._denied(definition, verdict);
        return { created: false, ...verdict };
      }
    }

    const needCreationApproval = policy === 'approve_creation';
    const executionApprovalRequired = policy === 'approve_execution' || policy === 'approve_creation';
    if (needCreationApproval) {
      const decision = await this._ask(approver, {
        action: 'agent.create',
        summary: `Create a ${risk}-risk specialist: ${definition.name}`,
        risk,
        proposal: definition,
      });
      if (!decision.approved) {
        this._denied(definition, { code: decision.code, reason: decision.reason });
        return { created: false, code: decision.code, reason: decision.reason };
      }
    }

    let agent;
    try {
      agent = this._registry.register(definition);
    } catch (err) {
      const reason = err.message;
      this._denied(definition, { code: 'SPAWN_REGISTRY_ERROR', reason });
      return { created: false, code: 'SPAWN_REGISTRY_ERROR', reason };
    }

    if (this._governor) {
      this._governor.register({
        agentId: agent.id,
        parentAgentId: agent.metadata.parentAgentId,
        role: agent.metadata.role,
        fingerprint: proposed.fingerprint,
        depth,
        startedAt: this._now(),
      });
    }

    this._emit(TYPES.AGENT_CREATED, agent, {
      role: agent.metadata.role,
      risk,
      createdBy: agent.metadata.createdBy,
      parentAgentId: agent.metadata.parentAgentId,
      rootTaskId: agent.metadata.rootTaskId,
      dynamic: true,
    });
    return { created: true, agent, executionApprovalRequired, risk };
  }

  // Remove a dynamic agent: it stops counting against every limit and its
  // definition leaves the registry. A persistent agent is *not* destroyed by
  // this — promotion is meant to mean something.
  async destroy(agentId, { reason = 'task complete', force = false } = {}) {
    const agent = this._registry.get(agentId);
    if (!agent) return { destroyed: false, code: 'AGENT_UNKNOWN', reason: `no agent "${agentId}"` };
    if (!agent.metadata.dynamic && !force) {
      return { destroyed: false, code: 'AGENT_PERSISTENT', reason: `"${agentId}" is a persistent agent; demote it first` };
    }
    if (this._governor) this._governor.release(agentId);
    this._registry.unregister(agentId);
    this._emit(TYPES.AGENT_DESTROYED, agent, { reason });
    return { destroyed: true, agentId };
  }

  // Temporary → reusable. The definition is updated in place so its lineage
  // (who created it, for which task) is preserved rather than reset.
  promote(agentId, { name = null, promotedBy = 'king', reason = 'promoted by the King' } = {}) {
    const agent = this._registry.get(agentId);
    if (!agent) return { promoted: false, code: 'AGENT_UNKNOWN', reason: `no agent "${agentId}"` };
    if (agent.metadata.persistent === true && agent.metadata.dynamic !== true) {
      return { promoted: false, code: 'AGENT_ALREADY_PERSISTENT', reason: `"${agentId}" is already persistent` };
    }
    const updated = this._registry.update(agentId, {
      ...(name ? { name } : {}),
      metadata: {
        ...agent.metadata,
        dynamic: false,
        persistent: true,
        promotedAt: this._now(),
        promotedBy,
        promotionReason: reason,
      },
    });
    this._emit(TYPES.AGENT_PROMOTED, updated, {
      promotedBy,
      role: updated.metadata.role,
      lineage: updated.metadata.lineage,
    });
    return { promoted: true, agent: updated };
  }

  // The reverse, for an agent promoted by mistake. Lineage is kept either way.
  demote(agentId, { demotedBy = 'king', reason = 'demoted' } = {}) {
    const agent = this._registry.get(agentId);
    if (!agent) return { demoted: false, code: 'AGENT_UNKNOWN', reason: `no agent "${agentId}"` };
    if (agent.metadata.persistent !== true) {
      return { demoted: false, code: 'AGENT_NOT_PERSISTENT', reason: `"${agentId}" is not persistent` };
    }
    const updated = this._registry.update(agentId, {
      metadata: {
        ...agent.metadata,
        dynamic: true,
        persistent: false,
        demotedAt: this._now(),
        demotedBy,
        demotionReason: reason,
      },
    });
    this._emit(TYPES.AGENT_DEMOTED, updated, { demotedBy });
    return { demoted: true, agent: updated };
  }

  listDynamic() {
    return this._registry.list().filter((a) => a.metadata.dynamic === true);
  }

  listPersistent() {
    return this._registry.list().filter((a) => a.metadata.persistent === true);
  }

  // --- internals -----------------------------------------------------------

  async _ask(approver, request) {
    const ask = approver || this._approver;
    if (!ask) {
      return { approved: false, code: 'APPROVAL_UNAVAILABLE', reason: 'this spawn requires human approval but no approver is wired' };
    }
    let verdict;
    try {
      verdict = await ask(request);
    } catch (err) {
      return { approved: false, code: 'APPROVAL_FAILED', reason: `approval failed: ${err.message}` };
    }
    if (verdict === true) return { approved: true };
    if (verdict === false) return { approved: false, code: 'APPROVAL_REJECTED', reason: 'the request was rejected' };
    // An approver that returns an approval record rather than a boolean is
    // accepted too, so an ApprovalManager-backed callback needs no adapter.
    if (verdict && typeof verdict === 'object') {
      const status = verdict.status || (verdict.approved === true ? 'approved' : null);
      if (status === 'approved') return { approved: true };
      return { approved: false, code: 'APPROVAL_REJECTED', reason: `approval ended as ${status || 'unknown'}` };
    }
    return { approved: false, code: 'APPROVAL_REJECTED', reason: 'the approver gave no clear answer' };
  }

  _denied(definition, { code, reason }) {
    this._emit(TYPES.AGENT_SPAWN_DENIED, definition, { code, reason, role: definition.metadata.role });
  }

  _emit(type, agent, payload) {
    if (!this._bus) return;
    this._bus.emit(type, {
      agentId: agent.id,
      agentDefinitionId: agent.id,
      taskId: agent.metadata.rootTaskId || null,
      projectId: agent.metadata.projectId || null,
    }, payload);
  }
}

function unwrap(proposal) {
  if (!proposal || typeof proposal !== 'object') return null;
  if (proposal.ok === false) return null;
  if (proposal.definition) return proposal;
  // A bare definition is accepted so a caller can re-create a persisted agent.
  return { definition: proposal, fingerprint: null, risk: (proposal.metadata && proposal.metadata.risk) || 'low' };
}

function mintAgentId(role) {
  const slug = String(role).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const base = slug && /^[a-z]/.test(slug) ? slug : `agent-${slug}`.slice(0, 32);
  const rand = Math.random().toString(36).slice(2, 8);
  return `dyn-${base}-${rand}`;
}

function titleCase(role) {
  return String(role).split(/[\s_-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

module.exports = { AgentFactory, DEFAULT_SPAWN_POLICY, RISK_LEVELS, SPAWN_EFFECTS, mintAgentId };
