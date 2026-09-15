// McpInspector: reading an MCP server's own description critically.
//
// The inspector answers three questions a person actually has before wiring a
// server into an agent:
//
//   1. What can it do?        — every tool, classified, with the evidence
//   2. Is it well built?      — schemas, descriptions, error contracts, bounds
//   3. What would it cost me? — which tools are destructive, which reach the
//                               network, which touch credentials
//
// Everything here is static analysis of the advertised descriptor. It does not
// call the server, and it says so: a clean inspection means "nothing in what it
// claims is alarming", which is a much weaker statement than "this server is
// safe", and the report repeats that in `limits` so a UI cannot present it as
// a clearance.

const { classifyServer } = require('./classify');

// A tool description shorter than this cannot tell an agent when to use the
// tool, which is the most common reason a capable server is unusable in
// practice.
const MIN_DESCRIPTION = 30;
const MAX_TOOLS_BEFORE_CROWDING = 40;

function inspect({ serverId, name = null, transport = 'stdio', url = null, tools = [], resources = [], prompts = [], serverInfo = {} } = {}) {
  const classification = classifyServer({ serverId, tools });
  const findings = [];

  // --- design quality -------------------------------------------------------
  for (const tool of tools) {
    const label = tool.name || '(unnamed)';
    if (!tool.name) findings.push(finding('design', 'high', 'a tool has no name', label));
    if (!tool.description || tool.description.length < MIN_DESCRIPTION) {
      findings.push(finding('design', 'medium', `"${label}" has little or no description — an agent cannot tell when to use it`, label));
    }
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== 'object') {
      findings.push(finding('design', 'medium', `"${label}" has no input schema, so wrong arguments fail at the server instead of the caller`, label));
    } else {
      const props = Object.keys(schema.properties || {});
      if (props.length && !Array.isArray(schema.required)) {
        findings.push(finding('design', 'low', `"${label}" marks no parameters required; every parameter is optional to the caller`, label));
      }
      for (const [key, prop] of Object.entries(schema.properties || {})) {
        if (prop && !prop.description) findings.push(finding('design', 'low', `"${label}.${key}" has no description`, label));
      }
    }
  }
  if (tools.length > MAX_TOOLS_BEFORE_CROWDING) {
    findings.push(finding('design', 'medium', `${tools.length} tools — beyond roughly ${MAX_TOOLS_BEFORE_CROWDING} an agent's selection accuracy drops sharply; consider task-shaped tools instead of one per endpoint`, null));
  }
  if (tools.length === 0) findings.push(finding('design', 'high', 'the server advertises no tools', null));

  // --- security -------------------------------------------------------------
  for (const tool of classification.tools) {
    if (tool.conflicts.length) {
      for (const conflict of tool.conflicts) findings.push(finding('security', 'high', conflict, tool.name));
    }
    if (tool.class === 'PRIVILEGED') {
      findings.push(finding('security', 'high', `"${tool.name}" reaches credentials, permissions or billing — grant it only with a narrowly scoped token`, tool.name));
    }
    if (tool.class === 'SYSTEM') {
      findings.push(finding('security', 'high', `"${tool.name}" executes commands on the host`, tool.name));
    }
    if (tool.class === 'DESTRUCTIVE' && tool.risk === 'critical') {
      findings.push(finding('security', 'high', `"${tool.name}" destroys state at a broad scope (system, account, database or repository level)`, tool.name));
    }
  }
  if (classification.allWriting) {
    findings.push(finding('security', 'medium', 'every tool on this server changes state — there is no read-only way to use it', null));
  }
  if (transport !== 'stdio' && url && url.startsWith('http://')) {
    findings.push(finding('security', 'high', 'the server is configured over plain http; credentials and tool results travel unencrypted', null));
  }
  // Tools that return attacker-influenced text are the prompt-injection surface.
  // Plurals included: "lists issues" is the common phrasing, and `\bissue\b`
  // does not match "issues".
  const injectionSurface = classification.tools.filter((t) => /\b(issue|comment|email|message|page|web|search|review|thread|ticket|feed|document)s?\b/i.test(`${t.name} ${toolDescription(tools, t.name)}`));
  if (injectionSurface.length) {
    findings.push(finding(
      'security',
      'medium',
      `${injectionSurface.length} tool(s) return content written by other people (${injectionSurface.slice(0, 4).map((t) => t.name).join(', ')}${injectionSurface.length > 4 ? ', …' : ''}) — treat their output as data, never as instructions`,
      null,
    ));
  }

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  return {
    serverId,
    name: name || serverId,
    transport,
    url,
    serverInfo: { ...serverInfo },
    counts: {
      tools: tools.length,
      resources: resources.length,
      prompts: prompts.length,
      byClass: classification.byClass,
    },
    risk: classification.risk,
    highestClass: classification.highestClass,
    tools: classification.tools.map((t) => ({
      name: t.name,
      class: t.class,
      risk: t.risk,
      requiresAuth: t.requiresAuth,
      idempotent: t.idempotent,
      policyAction: t.qualifiedAction,
      evidence: t.evidence,
      description: toolDescription(tools, t.name),
    })),
    findings: findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    bySeverity,
    recommendation: recommend(classification, bySeverity),
    // Said in the payload, not only in a doc comment, so a UI that renders the
    // report cannot accidentally present it as a security clearance.
    limits: 'static analysis of the server\'s advertised descriptor only. Nothing was called; '
      + 'a server can behave differently from how it describes itself, and tool results remain untrusted input.',
    inspectedAt: Date.now(),
  };
}

// A test plan for a server, derived from what it advertises. Not a test runner:
// executing these means calling a third-party service, which is a decision for
// the person who owns the credentials.
function testPlan({ serverId, tools = [] } = {}) {
  const classification = classifyServer({ serverId, tools });
  return {
    serverId,
    cases: classification.tools.flatMap((tool) => {
      const cases = [
        { tool: tool.name, kind: 'happy-path', expect: 'a structured result within the context budget', risk: tool.risk },
        { tool: tool.name, kind: 'missing-required', expect: 'a structured error naming the missing field, not a stack trace', risk: 'low' },
        { tool: tool.name, kind: 'wrong-type', expect: 'a validation error from the server, not a 500', risk: 'low' },
      ];
      if (tool.class === 'READ_ONLY') {
        cases.push({ tool: tool.name, kind: 'large-result', expect: 'bounded or paginated output', risk: 'low' });
      }
      if (['DESTRUCTIVE', 'SYSTEM', 'PRIVILEGED'].includes(tool.class)) {
        cases.push({
          tool: tool.name,
          kind: 'authorization',
          expect: 'refusal when the credential lacks the scope — never a silent fallback to a broader one',
          risk: tool.risk,
          note: 'run this against a disposable target; it changes state',
        });
      }
      if (tool.idempotent === false && tool.class !== 'READ_ONLY') {
        cases.push({ tool: tool.name, kind: 'retry-safety', expect: 'the server states whether a repeated call is safe', risk: 'medium' });
      }
      return cases;
    }),
    note: 'a server passes only when an agent can complete a real task with it unaided — unit-level cases are necessary, not sufficient',
  };
}

function recommend(classification, bySeverity) {
  if (bySeverity.high > 0) return 'review before connecting: high-severity findings need a person\'s judgement';
  if (classification.risk === 'critical' || classification.risk === 'high') return 'connect with approval gates on its destructive and privileged tools';
  if (bySeverity.medium > 0) return 'usable; address the design findings for better agent accuracy';
  return 'nothing alarming in what it advertises';
}

function toolDescription(tools, name) {
  const tool = tools.find((t) => t.name === name);
  return (tool && tool.description) || '';
}

function finding(kind, severity, summary, tool) {
  return { kind, severity, summary, tool: tool || null };
}

function severityRank(s) {
  return s === 'high' ? 2 : s === 'medium' ? 1 : 0;
}

module.exports = { inspect, testPlan, MIN_DESCRIPTION, MAX_TOOLS_BEFORE_CROWDING };
