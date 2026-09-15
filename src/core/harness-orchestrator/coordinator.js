// AgentCoordinator: more than one agent on one job, safely.
//
// §26-32 in one place, because they are one mechanism seen from five angles:
//
//   delegation  a scoped child task with its own permissions and timeout
//   messaging   the structured protocol children report through
//   handoff     ownership moving without a transcript moving with it
//   parallel    several children at once, guarded by file locks
//   review      one agent produces, another evaluates what was produced
//
// Two properties this class is responsible for, and they are the ones that make
// multi-agent worth having rather than worth fearing:
//
//   1. **No child can out-reach its parent.** Every delegation runs through
//      `delegation.containment()` first. A child that asks for a permission
//      level or a path the parent does not have is refused at delegation time.
//   2. **Cancellation is contagious downward.** Cancelling a lead cancels its
//      children, their children, and the harness runs and sandboxes attached to
//      them — otherwise a cancelled task leaves orphan processes behind, which
//      is the failure that makes people distrust agent systems.
//
// Communication is `messages.js`. Nothing here concatenates text into a prompt.

const { randomUUID } = require('node:crypto');
const {
  createDelegation,
  validateDelegation,
  completeDelegation,
  containment,
  delegationView,
  DELEGATION_STATUS,
} = require('./delegation');
const { createMessage, replyTo, createMailbox } = require('./messages');
const { createHandoff, summarizeHandoff, readyToAccept } = require('./handoff');
const { TYPES } = require('../events/event-bus');
const { isString } = require('../schema/validate');

const ROLES = Object.freeze({
  LEAD: 'lead',
  WORKER: 'worker',
  REVIEW: 'reviewer',
  RESEARCH: 'research',
  TESTER: 'tester',
});

// Which roles a task type needs. §26's example — a lead with research, a
// developer and a tester, then a reviewer — is the `code` entry. Kept as a table
// so a host can replace it without touching the coordinator.
const TEAM_TEMPLATES = Object.freeze({
  code: [ROLES.RESEARCH, ROLES.WORKER, ROLES.TESTER, ROLES.REVIEW],
  review: [ROLES.REVIEW],
  research: [ROLES.RESEARCH, ROLES.WORKER],
  test: [ROLES.TESTER, ROLES.REVIEW],
  document: [ROLES.WORKER, ROLES.REVIEW],
});

const MAX_DEPTH = 4;

class DelegationDeniedError extends Error {
  constructor(message, { reasons = [], delegationId = null } = {}) {
    super(message);
    this.name = 'DelegationDeniedError';
    this.code = 'DELEGATION_DENIED';
    this.reasons = reasons;
    this.delegationId = delegationId;
  }
}

function createAgentCoordinator({
  bus = null,
  logger = null,
  agentRegistry = null,
  policy = null,
  locks = null,
  artifacts = null,
  sessions = null,
  harnesses = null,
  sandboxes = null,
  runDelegate = null,
} = {}) {
  const delegations = new Map(); // id -> delegation
  const byTask = new Map();      // taskId -> Set<delegationId>
  const byParent = new Map();    // parentDelegationId -> Set<delegationId>
  const reviews = new Map();     // reviewId -> review bundle
  const mailbox = createMailbox();

  // --- delegation -----------------------------------------------------------

  async function delegate(spec = {}) {
    const parentAgent = spec.parentAgentId && agentRegistry ? agentRegistry.get(spec.parentAgentId) : null;
    const childAgent = spec.childAgentId && agentRegistry ? agentRegistry.get(spec.childAgentId) : null;
    const depth = spec.depth || 1;

    if (depth > MAX_DEPTH) {
      throw new DelegationDeniedError(`delegation depth ${depth} exceeds the limit of ${MAX_DEPTH}`);
    }
    if (!childAgent) {
      throw new DelegationDeniedError(`unknown child agent "${spec.childAgentId}"`);
    }

    // Baseline authority: a child inherits the parent's permission set unless a
    // narrower one is asked for. It can never be wider.
    const requested = spec.permissions || (parentAgent ? parentAgent.permissions : null);
    const check = containment(parentAgent || {}, { permissions: requested, scope: spec.scope || (parentAgent ? parentAgent.scope : null) });
    if (!check.ok) {
      throw new DelegationDeniedError(
        `delegation from ${spec.parentAgentId || 'unknown'} to ${childAgent.id} would widen permissions: ${check.reasons.join('; ')}`,
        { reasons: check.reasons },
      );
    }

    if (policy) {
      const decision = await policy.evaluate({
        action: 'agent.delegate',
        askApproval: false,
        context: {
          agentId: spec.parentAgentId,
          taskId: spec.parentTaskId,
          sessionId: spec.sessionId,
          workspaceId: spec.workspaceId,
          harnessId: spec.harnessId,
        },
      });
      if (decision.effect === 'deny') {
        throw new DelegationDeniedError(`delegation denied by policy: ${decision.reason}`, { reasons: [decision.reason] });
      }
    }

    const delegation = createDelegation({
      ...spec,
      role: spec.role || ROLES.WORKER,
      permissions: requested,
      depth,
      parentDelegationId: spec.parentDelegationId || null,
    });

    delegations.set(delegation.id, delegation);
    if (!byTask.has(delegation.parentTaskId)) byTask.set(delegation.parentTaskId, new Set());
    byTask.get(delegation.parentTaskId).add(delegation.id);
    if (delegation.parentDelegationId) {
      if (!byParent.has(delegation.parentDelegationId)) byParent.set(delegation.parentDelegationId, new Set());
      byParent.get(delegation.parentDelegationId).add(delegation.id);
    }

    const message = createMessage({
      type: 'DELEGATION',
      from: delegation.parentAgentId,
      to: delegation.childAgentId,
      taskId: delegation.parentTaskId,
      delegationId: delegation.id,
      traceId: delegation.traceId,
      sessionId: delegation.sessionId,
      harnessId: delegation.harnessId,
      workspaceId: delegation.workspaceId,
      payload: { objective: delegation.objective, scope: { paths: delegation.scope.paths, tools: delegation.scope.tools }, resultSchema: delegation.resultSchema },
    });
    post(message);

    if (bus) {
      bus.emit(TYPES.AGENT_DELEGATED, {
        agentId: delegation.childAgentId,
        taskId: delegation.parentTaskId,
        sessionId: delegation.sessionId,
        harnessId: delegation.harnessId,
        workspaceId: delegation.workspaceId,
        delegationId: delegation.id,
      }, { role: delegation.role, parentAgentId: delegation.parentAgentId, objective: delegation.objective.slice(0, 200), depth: delegation.depth });
    }
    if (sessions && delegation.sessionId) sessions.countDelegation(delegation.sessionId);
    return delegationView(delegation);
  }

  function getDelegation(id) {
    return delegations.get(id) || null;
  }

  function listDelegations(filter = {}) {
    let all = [...delegations.values()];
    if (filter.taskId) all = all.filter((d) => d.parentTaskId === filter.taskId);
    if (filter.status) all = all.filter((d) => d.status === filter.status);
    return all.map(delegationView).sort((a, b) => a.createdAt - b.createdAt);
  }

  function markRunning(id) {
    const d = delegations.get(id);
    if (!d) return null;
    d.status = DELEGATION_STATUS.RUNNING;
    d.startedAt = Date.now();
    return delegationView(d);
  }

  // Finish a delegation and report it through the protocol. Every path that
  // ends a delegation lands here, so a child's result always arrives as a
  // structured RESULT (or ERROR) message instead of being visible only to
  // whoever happened to hold the object.
  function finishDelegation(d, { status = DELEGATION_STATUS.COMPLETED, error = null, artifactIds = [], summary = '' } = {}) {
    // Idempotent for the same terminal state: a caller that finishes a
    // delegation and then reports the result must not blow up, and must not
    // post a second RESULT either. A *different* terminal state (cancelled →
    // completed) is a real contradiction and still throws.
    if (d.status === status) return delegationView(d);
    // A delegation that is reported as finished while still pending simply ran
    // without anyone announcing it — walk the legal edge rather than refusing.
    if (d.status === DELEGATION_STATUS.PENDING) {
      d.status = DELEGATION_STATUS.RUNNING;
      d.startedAt = d.startedAt || Date.now();
    }
    completeDelegation(d, { status, error, artifactIds });
    post(createMessage({
      type: status === DELEGATION_STATUS.FAILED ? 'ERROR' : 'RESULT',
      from: d.childAgentId,
      to: d.parentAgentId || 'lead',
      taskId: d.parentTaskId,
      delegationId: d.id,
      traceId: d.traceId,
      sessionId: d.sessionId,
      payload: status === DELEGATION_STATUS.FAILED ? { error: error || 'delegated task failed' } : { result: { summary, artifactIds } },
    }));
    return delegationView(d);
  }

  function markComplete(id, options = {}) {
    const d = delegations.get(id);
    if (!d) return null;
    return finishDelegation(d, options);
  }

  // The tree the control center renders under "Sub-agents".
  function tree(taskId) {
    const roots = [...delegations.values()]
      .filter((d) => d.parentTaskId === taskId && !d.parentDelegationId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const node = (d) => ({
      ...delegationView(d),
      children: [...(byParent.get(d.id) || [])]
        .map((id) => delegations.get(id))
        .filter(Boolean)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(node),
    });
    return roots.map(node);
  }

  // --- messaging ------------------------------------------------------------

  function post(message) {
    mailbox.post(message);
    if (bus) {
      bus.emit(TYPES.AGENT_MESSAGE, {
        taskId: message.taskId,
        sessionId: message.sessionId,
        agentId: message.from,
        harnessId: message.harnessId,
        delegationId: message.delegationId,
      }, { messageId: message.id, type: message.type, from: message.from, to: message.to });
    }
    if (sessions && message.sessionId) sessions.countMessages(message.sessionId);
    return message;
  }

  // Send from one agent to another through the protocol. `send` is the only
  // way a message enters the system, so every conversation is recorded.
  function send({ type, from, to, payload = {}, taskId = null, delegationId = null, sessionId = null, traceId = null, harnessId = null, inReplyTo = null } = {}) {
    return post(createMessage({ type, from, to, payload, taskId, delegationId, sessionId, traceId, harnessId, inReplyTo }));
  }

  function respondTo(message, { type = 'RESULT', payload = {}, extra = {} } = {}) {
    return post(replyTo(message, { type, payload, extra }));
  }

  function messages({ taskId = null, limit = 100 } = {}) {
    const rows = taskId ? mailbox.forTask(taskId) : mailbox.all();
    return rows.slice(-limit);
  }

  // --- handoff --------------------------------------------------------------

  function handoff({ from, to, taskId = null, delegationId = null, traceId = null, sessionId = null, harnessId = null, handoff: body = {} } = {}) {
    const record = createHandoff({ ...body, from, to, taskId, delegationId, traceId });
    const readiness = readyToAccept(record);
    const message = post(createMessage({
      type: 'HANDOFF',
      from,
      to,
      taskId,
      delegationId,
      traceId,
      sessionId,
      harnessId,
      payload: { handoff: summarizeHandoff(record) },
    }));
    if (bus) {
      bus.emit(TYPES.AGENT_HANDOFF, { taskId, sessionId, agentId: to, harnessId, delegationId }, {
        from, to,
        files: record.relevantFiles.length,
        outstanding: record.outstandingIssues.length,
        ready: readiness.ok,
      });
    }
    const d = delegationId && delegations.get(delegationId);
    if (d) {
      d.handoff = { from, to, at: record.at };
      if (to) d.childAgentId = to;
    }
    return { handoff: summarizeHandoff(record), messageId: message.id, ready: readiness.ok, missing: readiness.missing };
  }

  // --- review (§31, §32) -----------------------------------------------------

  // Build the review *bundle*. §31 is precise about what the reviewer gets —
  // the diff, the artifacts, the test results, the constraints — and equally
  // precise about what it does not: the task history. This function returns
  // exactly that bundle, so a reviewer (on any harness, in any vendor's model)
  // starts from evidence rather than from a retelling of the work.
  function buildReview({ taskId = null, delegationId = null, reviewerAgentId = null, coderAgentId = null, coderHarnessId = null, diff = null, testResults = null, constraints = [], context = null, files = [] } = {}) {
    const artifactIds = [];
    const listed = artifacts && taskId ? artifacts.list({ taskId }) : [];
    for (const a of listed) artifactIds.push(a.id);

    const reviewId = `review-${randomUUID().slice(0, 8)}`;
    const bundle = {
      reviewId,
      taskId,
      delegationId,
      coder: { agentId: coderAgentId, harnessId: coderHarnessId },
      reviewer: { agentId: reviewerAgentId },
      // The evidence, in the order a reviewer wants it.
      taskDiff: diff,
      testResults: testResults,
      constraints: [...(constraints || [])].slice(0, 20),
      artifacts: artifactIds.slice(0, 50),
      files: [...(files || [])].slice(0, 40),
      // `context` is a *summary* supplied by the caller, never the transcript.
      context: context ? String(context).slice(0, 2000) : null,
      createdAt: Date.now(),
      verdict: null,
    };
    reviews.set(reviewId, bundle);
    return bundle;
  }

  function recordReview(reviewId, { verdict, notes = '', reviewerAgentId = null } = {}) {
    const bundle = reviews.get(reviewId);
    if (!bundle) return null;
    if (!['accept', 'request_fix', 'reject'].includes(verdict)) {
      throw new Error(`unknown review verdict: ${JSON.stringify(verdict)}`);
    }
    bundle.verdict = { verdict, notes: String(notes).slice(0, 2000), at: Date.now(), reviewerAgentId };
    if (bundle.delegationId) {
      const d = delegations.get(bundle.delegationId);
      if (d) d.review = bundle.verdict;
    }
    if (bus) {
      bus.emit(TYPES.AGENT_MESSAGE, { taskId: bundle.taskId, agentId: reviewerAgentId, delegationId: bundle.delegationId, sessionId: null }, {
        type: 'REVIEW',
        from: reviewerAgentId,
        to: bundle.coder.agentId,
        verdict,
      });
    }
    return bundle;
  }

  function getReview(reviewId) {
    return reviews.get(reviewId) || null;
  }

  // --- parallel execution (§30) --------------------------------------------

  // Run several delegations at once. Each one takes the file locks its scope
  // names, so two children cannot write the same file: the second is reported
  // as `blocked` and nothing of it runs. That refusal is the point — a
  // conflicting write is not a performance problem, it is data loss.
  async function runParallel(ids, { runner = null } = {}) {
    const run = runner || runDelegate;
    if (typeof run !== 'function') throw new Error('runParallel requires a runner');
    const list = ids.map((id) => delegations.get(id)).filter(Boolean);

    // Deterministic start order and a single lock acquisition round, so the
    // same request always produces the same winner.
    const results = await Promise.all(list.map((d) => runOne(d, run)));
    return results;
  }

  async function runOne(delegation, run) {
    const paths = delegation.scope && Array.isArray(delegation.scope.paths) ? delegation.scope.paths : [];
    const ownerId = delegation.id;
    const acquired = locks ? locks.acquire({ ownerId, taskId: delegation.parentTaskId, paths, mode: 'write' }) : { ok: true, granted: [], conflicts: [] };
    if (!acquired.ok) {
      delegation.status = DELEGATION_STATUS.FAILED;
      delegation.error = `blocked by a file lock held by ${acquired.conflicts.map((c) => c.ownerId).join(', ')}`;
      return { delegationId: delegation.id, status: 'blocked', conflicts: acquired.conflicts, result: null };
    }
    delegation.status = DELEGATION_STATUS.RUNNING;
    delegation.startedAt = Date.now();
    try {
      const result = await run(delegationView(delegation));
      finishDelegation(delegation, { status: DELEGATION_STATUS.COMPLETED, summary: summarizeRunnerResult(result) });
      return { delegationId: delegation.id, status: 'completed', conflicts: [], result };
    } catch (err) {
      finishDelegation(delegation, { status: DELEGATION_STATUS.FAILED, error: err.message });
      if (logger) logger.warn(`delegation ${delegation.id} failed`, { error: err.message });
      return { delegationId: delegation.id, status: 'failed', conflicts: [], error: err.message };
    } finally {
      if (locks) locks.release(ownerId);
    }
  }

  // --- cancellation ---------------------------------------------------------

  // Cancel a delegation and everything below it. Children first, so no child is
  // left running against a parent that has been told to stop.
  async function cancel(delegationId, reason = 'cancelled') {
    const d = delegations.get(delegationId);
    if (!d) return { cancelled: [], reason: 'unknown delegation' };
    const cancelled = [];
    for (const childId of [...(byParent.get(delegationId) || [])]) {
      const child = await cancel(childId, reason);
      cancelled.push(...child.cancelled);
    }
    if (d.status === DELEGATION_STATUS.COMPLETED || d.status === DELEGATION_STATUS.CANCELLED) {
      return { cancelled, reason };
    }
    d.status = DELEGATION_STATUS.CANCELLED;
    d.completedAt = Date.now();
    d.cancellation = { reason, at: Date.now() };
    cancelled.push(d.id);

    // This level only releases its own claim. Stopping the *task's* harness runs
    // and sandboxes is cancelTask's job, done once at the top: a child cancelling
    // its subtree must never tear down a sibling's processes.
    if (locks) locks.release(d.id);
    return { cancelled, reason };
  }

  // Cancel everything belonging to a task — the entry point recovery calls.
  async function cancelTask(taskId, reason = 'task cancelled') {
    const ids = [...(byTask.get(taskId) || [])];
    const cancelled = [];
    for (const id of ids) {
      const result = await cancel(id, reason);
      cancelled.push(...result.cancelled);
    }
    if (harnesses) await harnesses.stopTask(taskId, reason).catch(() => {});
    if (sandboxes) await sandboxes.stopTask(taskId, reason).catch(() => {});
    return cancelled;
  }

  // --- teams ----------------------------------------------------------------

  // Which roles a task of this type should have. Deterministic, from the table.
  function teamFor(taskType = 'code') {
    return [...(TEAM_TEMPLATES[taskType] || TEAM_TEMPLATES.code)];
  }

  function controlView(taskId) {
    const list = listDelegations({ taskId });
    return {
      taskId,
      delegations: list,
      subAgents: list.map((d) => ({
        id: d.id,
        role: d.role,
        agentId: d.childAgentId,
        harnessId: d.harnessId,
        status: d.status,
        objective: d.objective,
      })),
      tree: tree(taskId),
    };
  }

  function stats() {
    const byStatus = {};
    for (const d of delegations.values()) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    return {
      delegations: delegations.size,
      byStatus,
      messages: mailbox.count(),
      reviews: reviews.size,
      locks: locks ? locks.size() : 0,
    };
  }

  return {
    ROLE: ROLES,
    delegate,
    getDelegation,
    listDelegations,
    markRunning,
    markComplete,
    tree,
    send,
    post,
    respondTo,
    mailbox,
    messages,
    handoff,
    buildReview,
    recordReview,
    getReview,
    runParallel,
    runOne,
    cancel,
    cancelTask,
    teamFor,
    controlView,
    stats,
  };
}

// A runner's return value becomes the RESULT summary. Kept tiny on purpose:
// the message carries a summary, and the evidence lives in artifacts.
function summarizeRunnerResult(result) {
  if (!result) return 'completed';
  if (isString(result.summary)) return result.summary.slice(0, 300);
  if (result.ok === false) return `reported failure: ${result.error || 'no reason given'}`.slice(0, 300);
  return 'completed';
}

module.exports = {
  createAgentCoordinator,
  ROLES,
  TEAM_TEMPLATES,
  MAX_DEPTH,
  DelegationDeniedError,
  validateDelegation,
};
