// Phase 6: the MCP capability layer. Classification, the registry, the bridge
// onto the platform's own ToolManager, and the inspector.
//
// The load-bearing claim these tests defend: an MCP tool cannot be called
// except as a registered tool, which means it cannot be called without the
// permission gate and the policy engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyTool, classifyServer, CLASS_POLICY } = require('../src/core/mcp/classify.js');
const { McpServerRegistry } = require('../src/core/mcp/registry.js');
const { McpToolBridge, toolIdFor } = require('../src/core/mcp/bridge.js');
const { inspect, testPlan } = require('../src/core/mcp/inspector.js');
const { createMcpLayer } = require('../src/core/mcp/index.js');
const { ToolManager } = require('../src/core/tools/manager.js');
const { EventBus } = require('../src/core/events/event-bus.js');
const { PolicyManager, actionForTool } = require('../src/core/policy');

// --- classification ----------------------------------------------------------

test('classify: snake_case, camelCase and dotted names are all tokenized', () => {
  for (const name of ['list_issues', 'listIssues', 'list-issues', 'issues.list']) {
    assert.equal(classifyTool({ name }).class, 'READ_ONLY', name);
  }
});

test('classify: the brief\'s own risk examples come out as stated', () => {
  assert.equal(classifyTool({ name: 'files_read' }).risk, 'low');
  assert.equal(classifyTool({ name: 'files_write' }).risk, 'medium');
  assert.equal(classifyTool({ name: 'shell_execute' }).risk, 'high');
  assert.equal(classifyTool({ name: 'system_delete' }).risk, 'critical');
});

test('classify: a server hint may raise a class but never lower it', () => {
  const lowered = classifyTool({ name: 'delete_repository', annotations: { readOnlyHint: true } });
  assert.equal(lowered.class, 'DESTRUCTIVE');
  assert.equal(lowered.conflicts.length, 1);

  const raised = classifyTool({ name: 'get_page', annotations: { destructiveHint: true } });
  assert.equal(raised.class, 'DESTRUCTIVE');
});

test('classify: an unrecognizable tool defaults to WRITE, not READ_ONLY', () => {
  const result = classifyTool({ name: 'doTheThing' });
  assert.equal(result.class, 'WRITE');
  assert.match(result.evidence.join(' '), /defaulted to WRITE/);
});

test('classify: broad scope escalates a destructive tool to critical', () => {
  assert.equal(classifyTool({ name: 'delete_draft' }).risk, 'high');
  assert.equal(classifyTool({ name: 'delete_all_repositories' }).risk, 'critical');
});

test('classify: every class maps to a policy action and a tool permission level', () => {
  for (const [cls, policy] of Object.entries(CLASS_POLICY)) {
    assert.ok(policy.policyAction, `${cls} has no policy action`);
    assert.ok(['read_only', 'safe', 'moderate', 'destructive'].includes(policy.toolPermission));
  }
});

test('classify: qualified actions let policy target one server or one tool', () => {
  const { tools } = classifyServer({ serverId: 'github', tools: [{ name: 'delete_repo' }] });
  assert.equal(tools[0].qualifiedAction, 'mcp.tool.destructive.github.delete_repo');
});

// --- registry ----------------------------------------------------------------

test('registry: a server records its classified tools and its risk', () => {
  const registry = new McpServerRegistry({});
  const server = registry.register({ id: 'github', tools: [{ name: 'list_issues' }, { name: 'delete_repo' }] });
  assert.equal(server.risk, 'critical');
  assert.equal(server.byClass.READ_ONLY, 1);
  assert.equal(server.trusted, false, 'a configured server is not trusted merely by being present');
});

test('registry: a tool list that changes between connections is reported', () => {
  const registry = new McpServerRegistry({});
  registry.register({ id: 'srv', tools: [{ name: 'list_items' }] });
  const diff = registry.updateTools('srv', [{ name: 'list_items' }, { name: 'run_shell' }]);
  assert.deepEqual(diff.added.map((t) => t.name), ['run_shell']);
  assert.deepEqual(diff.escalations.map((t) => t.name), ['run_shell']);
});

test('registry: transports are validated and http needs a url', () => {
  const registry = new McpServerRegistry({});
  assert.throws(() => registry.register({ id: 'a', transport: 'carrier-pigeon' }), /unknown MCP transport/);
  assert.throws(() => registry.register({ id: 'b', transport: 'http' }), /needs a url/);
  assert.throws(() => registry.register({ id: 'c', transport: 'http', url: 'ftp://x' }), /must be http/);
});

// --- bridge ------------------------------------------------------------------

function bridgeHarness({ policyRules = [], defaultEffect = 'allow' } = {}) {
  const bus = new EventBus();
  const policy = new PolicyManager({ bus, defaultEffect });
  for (const doc of policyRules) policy.register(doc, { source: 'human' });
  const authorized = [];
  const tools = new ToolManager({
    bus,
    authorize: async ({ tool }) => {
      const decision = await policy.evaluate({ action: actionForTool(tool), askApproval: false, context: { toolId: tool.id } });
      authorized.push({ tool: tool.id, effect: decision.effect });
      return decision.effect === 'allow';
    },
  });
  const registry = new McpServerRegistry({ bus });
  const bridge = new McpToolBridge({ tools, registry, bus });
  return { bus, policy, tools, registry, bridge, authorized };
}

const AGENT = { id: 'dev', permissions: { levels: ['read_only', 'safe', 'moderate', 'destructive'], allowDestructive: true } };

test('bridge: MCP tools reach an agent only as registered tools', () => {
  const h = bridgeHarness();
  h.registry.register({ id: 'github', name: 'GitHub', tools: [{ name: 'list_issues' }, { name: 'delete_repo' }] });
  const registered = h.bridge.registerServer('github', { invoke: async () => 'ok' });
  assert.deepEqual(registered.map((t) => t.id).sort(), ['mcp:github:delete_repo', 'mcp:github:list_issues']);
  assert.ok(h.tools.get(toolIdFor('github', 'list_issues')));
});

test('bridge: classification decides the permission level and the policy action', () => {
  const h = bridgeHarness();
  h.registry.register({ id: 'github', tools: [{ name: 'list_issues' }, { name: 'delete_repo' }] });
  h.bridge.registerServer('github', { invoke: async () => 'ok' });
  const read = h.tools.peek(toolIdFor('github', 'list_issues'));
  const destructive = h.tools.peek(toolIdFor('github', 'delete_repo'));
  assert.equal(read.permissions.level, 'read_only');
  assert.equal(read.permissions.requiresAuth, false);
  assert.equal(destructive.permissions.level, 'destructive');
  assert.equal(destructive.permissions.requiresAuth, true);
  assert.equal(destructive.policyAction, 'mcp.tool.destructive.github.delete_repo');
});

test('bridge: a policy denial stops a destructive MCP call', async () => {
  const h = bridgeHarness({
    policyRules: [{
      id: 'no-destructive-mcp', scope: 'global', name: 'no destructive mcp',
      rules: [{ action: 'mcp.tool.destructive.**', effect: 'deny', reason: 'destructive MCP tools are off here' }],
    }],
  });
  h.registry.register({ id: 'github', tools: [{ name: 'delete_repo' }] });
  let invoked = false;
  h.bridge.registerServer('github', { invoke: async () => { invoked = true; return 'done'; } });
  await assert.rejects(
    () => h.tools.execute({ id: toolIdFor('github', 'delete_repo'), input: {}, agent: AGENT }),
    /authorization denied/,
  );
  assert.equal(invoked, false, 'the server was never called');
});

test('bridge: a read-only MCP call goes through and is recorded', async () => {
  const h = bridgeHarness();
  h.registry.register({ id: 'github', tools: [{ name: 'list_issues' }] });
  h.bridge.registerServer('github', { invoke: async ({ tool }) => ({ tool, items: [] }) });
  const out = await h.tools.execute({ id: toolIdFor('github', 'list_issues'), input: {}, agent: AGENT });
  assert.equal(out.ok, true);
  assert.equal(out.data.tool, 'list_issues', 'the original tool name is used on the wire');
  assert.equal(h.registry.get('github').stats.calls, 1);
});

test('bridge: unregistering a server takes its tools off the surface', () => {
  const h = bridgeHarness();
  h.registry.register({ id: 'srv', tools: [{ name: 'list_items' }, { name: 'delete_item' }] });
  h.bridge.registerServer('srv', { invoke: async () => 'x' });
  assert.equal(h.bridge.surface().length, 2);
  const removed = h.bridge.unregisterServer('srv');
  assert.equal(removed.length, 2);
  assert.equal(h.bridge.surface().length, 0);
  assert.equal(h.tools.get(toolIdFor('srv', 'list_items')), undefined);
});

test('bridge: a quarantined server cannot be re-registered', () => {
  const h = bridgeHarness();
  h.registry.register({ id: 'srv', tools: [{ name: 'list_items' }] });
  h.registry.setState('srv', 'quarantined', { reason: 'bad behaviour' });
  assert.throws(() => h.bridge.registerServer('srv', { invoke: async () => 'x' }), /quarantined/);
});

test('bridge: registration without a host client is refused', () => {
  const h = bridgeHarness();
  h.registry.register({ id: 'srv', tools: [{ name: 'list_items' }] });
  assert.throws(() => h.bridge.registerServer('srv', {}), /needs an invoke function/);
});

test('bridge: explain() answers what policy would do without calling anything', async () => {
  const h = bridgeHarness({
    policyRules: [{
      id: 'gate', scope: 'global', name: 'gate destructive',
      rules: [{ action: 'mcp.tool.destructive.**', effect: 'approval', reason: 'ask first' }],
    }],
  });
  h.registry.register({ id: 'srv', tools: [{ name: 'list_items' }, { name: 'delete_item' }] });
  h.bridge.registerServer('srv', { invoke: async () => 'x' });
  const explained = await h.bridge.explain('srv', { policy: h.policy });
  assert.equal(explained.explained, true);
  assert.deepEqual(explained.gated, ['delete_item']);
});

// --- inspector ---------------------------------------------------------------

test('inspector: a destructive tool and a http transport are high-severity findings', () => {
  const report = inspect({
    serverId: 'srv', transport: 'http', url: 'http://example.com/mcp',
    tools: [{ name: 'delete_all_records', description: 'Deletes every record in the account.' }],
  });
  assert.equal(report.risk, 'critical');
  assert.ok(report.findings.some((f) => /plain http/.test(f.summary)));
  assert.ok(report.findings.some((f) => /broad scope/.test(f.summary)));
});

test('inspector: thin descriptions and missing schemas are design findings', () => {
  const report = inspect({ serverId: 'srv', tools: [{ name: 'do_thing', description: 'does' }] });
  assert.ok(report.findings.some((f) => f.kind === 'design' && /description/.test(f.summary)));
  assert.ok(report.findings.some((f) => /input schema/.test(f.summary)));
});

test('inspector: the prompt-injection surface is named', () => {
  const report = inspect({
    serverId: 'srv',
    tools: [{ name: 'list_issues', description: 'Lists issues written by users of the repository.' }],
  });
  assert.ok(report.findings.some((f) => /written by other people/.test(f.summary)));
});

test('inspector: the report states what it did not check', () => {
  const report = inspect({ serverId: 'srv', tools: [{ name: 'list_items', description: 'Lists items with pagination support.' }] });
  assert.match(report.limits, /Nothing was called/);
});

test('inspector: a test plan covers error paths and authorization for risky tools', () => {
  const plan = testPlan({ serverId: 'srv', tools: [{ name: 'delete_repo' }, { name: 'list_items' }] });
  const kinds = new Set(plan.cases.filter((c) => c.tool === 'delete_repo').map((c) => c.kind));
  assert.ok(kinds.has('missing-required'));
  assert.ok(kinds.has('authorization'));
  assert.match(plan.note, /real task/);
});

// --- the layer ---------------------------------------------------------------

test('layer: connect classifies, registers and reports in one step', async () => {
  const bus = new EventBus();
  const tools = new ToolManager({ bus, authorize: async () => true });
  const layer = createMcpLayer({ tools, bus });
  const { server, tools: registered, report } = await layer.connect({
    id: 'github', name: 'GitHub', transport: 'stdio',
    tools: [{ name: 'list_issues', description: 'List issues in a repository with filters.' }],
    invoke: async () => 'ok',
  });
  assert.equal(server.state, 'connected');
  assert.equal(registered.length, 1);
  assert.equal(report.counts.tools, 1);
  assert.equal(layer.controlView().surface.length, 1);
});

test('layer: quarantining a server removes its tools before changing its state', () => {
  const bus = new EventBus();
  const tools = new ToolManager({ bus, authorize: async () => true });
  const layer = createMcpLayer({ tools, bus });
  layer.registry.register({ id: 'srv', tools: [{ name: 'run_shell' }] });
  layer.bridge.registerServer('srv', { invoke: async () => 'x' });
  const result = layer.quarantine('srv', { reason: 'exfiltration attempt' });
  assert.equal(result.removed.length, 1);
  assert.equal(layer.registry.get('srv').state, 'quarantined');
  assert.equal(tools.get(toolIdFor('srv', 'run_shell')), undefined);
});
