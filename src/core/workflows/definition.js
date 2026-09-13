// Workflow definition schema.
//
// A workflow is a directed graph of typed nodes. Node types:
// start | end | input | output | agent | tool | command | code |
// condition | loop | parallel | approval
//
// The engine executes nodes in order; tool/command/agent nodes are guarded by
// the same permission model as tasks, and approval nodes pause until a human
// (the platform's authorize callback) responds.

const { isPlainObject, isString, validId, fail } = require('../schema/validate');

const NODE_TYPES = Object.freeze([
  'start', 'end', 'input', 'output', 'agent', 'tool', 'command', 'code', 'condition', 'loop', 'parallel', 'approval',
]);

const WORKFLOW_FIELDS = ['id', 'name', 'description', 'version', 'inputs', 'outputs', 'nodes', 'edges', 'settings'];
const NODE_FIELDS = ['id', 'type', 'title', 'config', 'inputs', 'outputs'];

function validateWorkflow(wf) {
  if (!isPlainObject(wf)) return fail(['workflow must be an object']);
  if (!validId(wf.id)) return fail([`invalid workflow id: ${JSON.stringify(wf.id)}`]);
  if (!isString(wf.name) || wf.name.trim() === '') return fail(['workflow requires a name']);
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) return fail(['workflow requires nodes']);
  if (!Array.isArray(wf.edges)) return fail(['workflow requires edges']);

  const byId = new Map();
  for (const n of wf.nodes) {
    if (!validId(n.id)) return fail([`node id must match [a-z0-9._-]: ${JSON.stringify(n.id)}`]);
    if (byId.has(n.id)) return fail([`duplicate node id: ${n.id}`]);
    byId.set(n.id, n);
    if (!Array.isArray(NODE_TYPES) ? false : !NODE_TYPES.includes(n.type)) {
      return fail([`node ${n.id} has unknown type: ${n.type}`]);
    }
  }
  if (![...byId.values()].some((n) => n.type === 'start')) return fail(['workflow must have a start node']);

  for (const e of wf.edges) {
    if (!byId.has(e.from)) return fail([`edge from unknown node ${e.from}`]);
    if (!byId.has(e.to)) return fail([`edge to unknown node ${e.to}`]);
  }

  return { ok: true, workflow: normalizeWorkflow(wf, byId) };
}

function normalizeWorkflow(wf, _byId) {
  return Object.freeze({
    id: wf.id,
    name: wf.name,
    description: wf.description || '',
    version: wf.version || 1,
    inputs: Array.isArray(wf.inputs) ? wf.inputs.map((i) => ({ ...i })) : [],
    outputs: Array.isArray(wf.outputs) ? wf.outputs.map((o) => ({ ...o })) : [],
    nodes: wf.nodes.map((n) => normalizeNode(n)),
    edges: wf.edges.map((e) => ({ from: e.from, to: e.to, when: e.when || null })),
    settings: {
      timeoutMs: (wf.settings && wf.settings.timeoutMs) || 10 * 60 * 1000,
      approvalRequired: !!(wf.settings && wf.settings.approvalRequired),
      maxNodes: (wf.settings && wf.settings.maxNodes) || 200,
    },
  });
}

function normalizeNode(n) {
  return Object.freeze({
    id: n.id,
    type: n.type,
    title: n.title || n.id,
    config: isPlainObject(n.config) ? n.config : {},
    inputs: Array.isArray(n.inputs) ? n.inputs : [],
    outputs: Array.isArray(n.outputs) ? n.outputs : [],
  });
}

module.exports = { validateWorkflow, normalizeWorkflow, NODE_TYPES, WORKFLOW_FIELDS, NODE_FIELDS };