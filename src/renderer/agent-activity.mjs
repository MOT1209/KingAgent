// The activity stream: what the agent is doing, in operational terms.
//
// This module is where the platform's "never expose chain-of-thought" promise
// becomes a UI decision rather than a hope. The renderer does not receive
// private reasoning — the trace serializer strips it and no event type carries
// it — but a view can still *look* like it is showing deliberation if it dumps
// raw payloads. So this file renders from a fixed vocabulary of operational
// facts: a step, a tool, a file, an artifact, an approval, a delegation.
//
// It is pure presentation logic over the event stream, with no DOM and no
// preload access, so it can be tested in plain node. `mountAgentActivity`
// (bottom) is the thin DOM adapter.

// Event type → how it reads to a person. Anything not on this list is not
// shown: an unknown event is a change somebody made without deciding how a user
// should hear about it, and silence is the safer default.
const LABELS = {
  'orchestration.routed': (e) => `Routed as ${e.payload.mode}`,
  'workspace.created': () => 'Workspace opened',
  'project.detected': (e) => `Project detected: ${e.payload.type}${e.payload.hasGit ? ' · git' : ''}`,
  'context.created': (e) => `Context built (${e.payload.items} items, ~${e.payload.usedTokens} tokens)`,
  'task.plan.created': (e) => `Plan created (${e.payload.stepCount} steps)`,
  'task.step.started': (e) => `${e.payload.title || 'Step'} — running`,
  'task.step.completed': (e) => `${e.payload.title || 'Step'} — done`,
  'task.step.failed': (e) => `${e.payload.title || 'Step'} — failed`,
  'tool.called': (e) => `Using ${e.toolId || e.payload.toolId || 'a tool'}`,
  'tool.completed': (e) => `${e.toolId || 'Tool'} finished`,
  'tool.failed': (e) => `${e.toolId || 'Tool'} failed`,
  'workspace.file.added': (e) => `Created ${e.payload.path}`,
  'workspace.file.modified': (e) => `Changed ${e.payload.path}`,
  'workspace.file.removed': (e) => `Deleted ${e.payload.path}`,
  'artifact.created': (e) => `Artifact: ${e.payload.name} (${e.payload.type})`,
  'memory.write': (e) => `Remembered (${e.payload.importance})`,
  'approval.requested': (e) => `Waiting for approval: ${e.payload.summary || e.payload.action}`,
  'approval.approved': () => 'Approved',
  'approval.rejected': () => 'Rejected',
  'approval.expired': () => 'Approval expired',
  'agent.delegated': (e) => `Delegated to ${e.payload.to}`,
  'agent.handoff': (e) => `Handed off to ${e.payload.to}`,
  'agent.recovery': (e) => `Recovering: ${e.payload.reason || ''}`,
  'task.replanned': () => 'Replanning',
  'state.snapshot.created': () => 'Checkpoint saved',
  'task.completed': () => 'Completed',
  'task.failed': (e) => `Failed: ${e.payload.error || ''}`,
  'task.cancelled': () => 'Cancelled',
  'orchestration.completed': () => 'Run complete',
  'orchestration.failed': (e) => `Run failed: ${e.payload.error || ''}`,
};

const TOOL_NAMES = {
  'fs:read': 'Filesystem', 'fs:list': 'Filesystem', 'fs:write': 'Filesystem',
  'fs:delete': 'Filesystem', 'fs:mkdir': 'Filesystem', 'fs:exists': 'Filesystem',
  'search:grep': 'Search',
  'git:status': 'Git', 'git:log': 'Git', 'git:diff': 'Git',
  'terminal:run': 'Terminal',
};

const STEP_PHASES = ['analyzing', 'planning', 'executing', 'observing', 'evaluating', 'recovering', 'replanning'];

function describe(event) {
  const fn = LABELS[event.type];
  if (!fn) return null;
  try {
    const text = fn({ ...event, payload: event.payload || {} });
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

// Fold the event stream into the state a panel renders. Pure: same events in,
// same state out, so a test can assert the whole view without a DOM.
function reduceActivity(events, { maxLines = 60 } = {}) {
  const state = {
    status: 'idle',
    mode: null,
    agentId: null,
    currentStep: null,
    phase: null,
    steps: [],
    tools: [],
    filesChanged: 0,
    filesCreated: 0,
    filesModified: 0,
    filesDeleted: 0,
    artifacts: [],
    memories: 0,
    approvals: [],
    delegations: [],
    lines: [],
    error: null,
  };

  const toolSet = new Set();
  const stepMap = new Map();

  for (const event of events) {
    const p = event.payload || {};
    if (event.agentId && !state.agentId) state.agentId = event.agentId;

    switch (event.type) {
      case 'orchestration.routed': state.mode = p.mode; state.status = 'working'; break;
      case 'task.started': state.status = 'working'; break;
      case 'task.step.started':
        state.currentStep = p.title || p.stepId || event.nodeId || null;
        stepMap.set(event.nodeId || p.stepId, { id: event.nodeId || p.stepId, title: p.title || null, status: 'running' });
        break;
      case 'task.step.completed': {
        const key = event.nodeId || p.stepId;
        const prev = stepMap.get(key) || { id: key, title: p.title || null };
        stepMap.set(key, { ...prev, status: 'done' });
        break;
      }
      case 'task.step.failed': {
        const key = event.nodeId || p.stepId;
        const prev = stepMap.get(key) || { id: key, title: p.title || null };
        stepMap.set(key, { ...prev, status: 'failed' });
        break;
      }
      case 'tool.called': if (event.toolId || p.toolId) toolSet.add(TOOL_NAMES[event.toolId || p.toolId] || (event.toolId || p.toolId)); break;
      case 'workspace.file.added': state.filesCreated += 1; break;
      case 'workspace.file.modified': state.filesModified += 1; break;
      case 'workspace.file.removed': state.filesDeleted += 1; break;
      case 'artifact.created': state.artifacts.push({ id: p.id, name: p.name, type: p.type }); break;
      case 'memory.write': state.memories += 1; break;
      case 'approval.requested': state.approvals.push({ id: p.requestId, summary: p.summary || p.action, risk: p.risk, status: 'pending' }); break;
      case 'approval.approved':
      case 'approval.rejected':
      case 'approval.expired': {
        const found = state.approvals.find((a) => a.id === p.requestId);
        if (found) found.status = event.type.split('.')[1];
        break;
      }
      case 'agent.delegated': state.delegations.push({ to: p.to, workspaceId: p.childWorkspaceId }); break;
      case 'task.completed':
      case 'orchestration.completed': state.status = 'complete'; state.currentStep = null; break;
      case 'task.failed':
      case 'orchestration.failed': state.status = 'failed'; state.error = p.error || null; break;
      case 'task.cancelled': state.status = 'cancelled'; break;
      default: break;
    }

    if (STEP_PHASES.includes(event.type.replace('task.', ''))) state.phase = event.type.replace('task.', '');

    const line = describe(event);
    if (line) state.lines.push({ at: event.timestamp, type: event.type, text: line });
  }

  if (state.lines.length > maxLines) state.lines = state.lines.slice(-maxLines);
  state.tools = [...toolSet];
  state.steps = [...stepMap.values()];
  state.filesChanged = state.filesCreated + state.filesModified + state.filesDeleted;
  return state;
}

// The compact progress block: ✓ for done, → for running, ✗ for failed. This is
// the "what is it doing?" answer, in operations rather than intentions.
function renderProgress(state) {
  const rows = state.steps.map((s) => {
    const mark = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '→';
    return `${mark} ${s.title || s.id}`;
  });
  if (state.currentStep && !state.steps.some((s) => s.title === state.currentStep)) {
    rows.push(`→ ${state.currentStep}`);
  }
  return rows;
}

function statusDot(status) {
  return status === 'complete' ? 'complete'
    : status === 'failed' ? 'failed'
      : status === 'cancelled' ? 'cancelled'
        : status === 'working' ? 'working' : 'idle';
}

export { reduceActivity, renderProgress, describe, statusDot, LABELS, TOOL_NAMES };
