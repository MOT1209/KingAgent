// Classifying what an MCP tool actually does.
//
// An MCP server describes its own tools. That description is useful and it is
// not trustworthy: the server author chooses the name, the description and the
// annotations, and a server that wants to be called will describe itself
// helpfully. So classification here follows one rule, stated once and applied
// everywhere in this file:
//
//   **A server's own hints may raise a tool's class. They may never lower it.**
//
// `readOnlyHint: true` on a tool called `delete_repository` does not make it
// read-only; the name wins and the conflict is reported as a finding, because a
// tool whose annotation contradicts its name is worth a human's attention.
//
// Classes, from least to most dangerous:
//
//   READ_ONLY    observes; no state changes anywhere
//   WRITE        creates or modifies state that can be undone
//   NETWORK      reaches outside this machine
//   DESTRUCTIVE  removes or overwrites state that cannot be recovered
//   SYSTEM       runs commands or touches the host outside a workspace
//   PRIVILEGED   credentials, permissions, billing, account control

const CLASSES = Object.freeze(['READ_ONLY', 'WRITE', 'NETWORK', 'DESTRUCTIVE', 'SYSTEM', 'PRIVILEGED']);
const CLASS_RANK = Object.freeze(Object.fromEntries(CLASSES.map((c, i) => [c, i])));

// class -> { risk, policyAction, permission } — the three things the rest of
// the platform needs: how dangerous it is, which policy rule gates it, and
// which tool permission level the ToolManager should register it at.
const CLASS_POLICY = Object.freeze({
  READ_ONLY: { risk: 'low', policyAction: 'mcp.tool.read', toolPermission: 'read_only', requiresAuth: false },
  WRITE: { risk: 'medium', policyAction: 'mcp.tool.write', toolPermission: 'moderate', requiresAuth: false },
  NETWORK: { risk: 'medium', policyAction: 'network.request', toolPermission: 'moderate', requiresAuth: false },
  DESTRUCTIVE: { risk: 'high', policyAction: 'mcp.tool.destructive', toolPermission: 'destructive', requiresAuth: true },
  SYSTEM: { risk: 'high', policyAction: 'command.run', toolPermission: 'destructive', requiresAuth: true },
  PRIVILEGED: { risk: 'critical', policyAction: 'credential', toolPermission: 'destructive', requiresAuth: true },
});

// Name and description patterns, checked in order of severity so the strongest
// signal decides.
//
// They are matched against a *tokenized* name, not the raw one. `_` is a word
// character in a regular expression, so `\blist\b` does not match
// `list_issues` — the single most likely bug in this file, and the one that
// would silently classify every snake_case tool as WRITE. `tokenize()` turns
// `list_issues`, `listIssues` and `list-issues` into `list issues` first.
const SIGNALS = Object.freeze([
  { cls: 'PRIVILEGED', pattern: /\b(credential|secret|token|api[ _-]?key|access[ _-]?key|password|grant|revoke|permission|role|policy|billing|payment|charge|subscribe|invite|admin|impersonate)\b/i },
  { cls: 'SYSTEM', pattern: /\b(exec|execute|shell|bash|powershell|command|spawn|run[_-]?(script|command|process)|process|kill|install|uninstall|sudo|registry|service|reboot|shutdown)\b/i },
  { cls: 'DESTRUCTIVE', pattern: /\b(delete|destroy|drop|remove|purge|truncate|wipe|erase|reset|revert|force[_-]?push|overwrite|rmdir|unlink)\b/i },
  { cls: 'WRITE', pattern: /\b(write|create|update|upsert|set|put|post|patch|edit|modify|add|append|move|rename|copy|upload|publish|merge|commit|deploy|send|comment)\b/i },
  { cls: 'NETWORK', pattern: /\b(fetch|request|http|url|webhook|crawl|scrape|download|browse|curl|api[_-]?call)\b/i },
  { cls: 'READ_ONLY', pattern: /\b(get|read|list|search|find|query|show|describe|inspect|view|fetch[_-]?info|status|count|diff|log)\b/i },
]);

// Words that mean "not one object": the difference between deleting a file and
// deleting the filesystem.
const BROAD_SCOPE = /\b(system|account|organization|org|global|all|everything|database|cluster|production|prod|workspace|repository|repo|bucket|volume|disk)\b/i;

function rank(cls) {
  return CLASS_RANK[cls] === undefined ? -1 : CLASS_RANK[cls];
}

function higher(a, b) {
  if (!a) return b;
  if (!b) return a;
  return rank(a) >= rank(b) ? a : b;
}

// Classify one tool descriptor as an MCP server advertises it:
// `{ name, description, inputSchema, annotations }`.
function classifyTool(tool = {}) {
  const name = String(tool.name || '');
  const description = String(tool.description || '');
  const haystack = tokenize(name);
  const evidence = [];
  let cls = null;

  for (const signal of SIGNALS) {
    if (signal.pattern.test(haystack)) {
      cls = higher(cls, signal.cls);
      evidence.push(`name matches ${signal.cls.toLowerCase()} pattern`);
      break; // the name is the strongest signal; first (most severe) match wins
    }
  }
  if (!cls) {
    for (const signal of SIGNALS) {
      if (signal.pattern.test(tokenize(description))) {
        cls = higher(cls, signal.cls);
        evidence.push(`description matches ${signal.cls.toLowerCase()} pattern`);
        break;
      }
    }
  }

  // An unclassifiable tool is treated as WRITE, not READ_ONLY. Defaulting an
  // unknown to the safest-sounding class is how an unclassified `doThing` ends
  // up running without a prompt.
  if (!cls) {
    cls = 'WRITE';
    evidence.push('no recognizable signal in the name or description; defaulted to WRITE rather than assumed safe');
  }

  // Server annotations: may raise, never lower.
  const annotations = tool.annotations || {};
  const conflicts = [];
  if (annotations.destructiveHint === true) {
    cls = higher(cls, 'DESTRUCTIVE');
    evidence.push('server annotated it destructive');
  }
  if (annotations.openWorldHint === true) {
    cls = higher(cls, 'NETWORK');
    evidence.push('server annotated it as reaching the open world');
  }
  if (annotations.readOnlyHint === true && rank(cls) > rank('READ_ONLY')) {
    conflicts.push(`the server annotates "${name}" as read-only, but it is classified ${cls}; the annotation was ignored`);
  }
  // An idempotent hint is useful for retry decisions and changes no class.
  const idempotent = annotations.idempotentHint === true;

  const policy = CLASS_POLICY[cls];
  // Scope escalation. `delete_draft` and `delete_all_databases` are both
  // DESTRUCTIVE, and treating them as equally risky is the kind of flattening
  // that gets a production database dropped after one approval prompt that
  // looked like all the others. A destructive or system tool whose name reaches
  // beyond a single object is critical.
  const broadScope = BROAD_SCOPE.test(haystack);
  const risk = broadScope && (cls === 'DESTRUCTIVE' || cls === 'SYSTEM') ? 'critical' : policy.risk;
  if (broadScope && risk !== policy.risk) evidence.push('names a broad target (system, account, all, production), so the risk is critical rather than high');

  return {
    name,
    class: cls,
    risk,
    policyAction: `${policy.policyAction}`,
    toolPermission: policy.toolPermission,
    requiresAuth: policy.requiresAuth,
    idempotent,
    evidence,
    conflicts,
    // The qualified action a policy document can target precisely:
    // `mcp.tool.write.github.create_issue`, so a deployment can allow a whole
    // server, a class of tools, or one tool.
    qualifiedAction: null, // filled by classifyServer, which knows the server id
  };
}

// Classify every tool a server advertises, qualifying each action with the
// server id so policy can be written per server.
function classifyServer({ serverId, tools = [] } = {}) {
  const classified = tools.map((tool) => {
    const result = classifyTool(tool);
    return {
      ...result,
      serverId: serverId || null,
      qualifiedAction: serverId ? `${result.policyAction}.${serverId}.${sanitize(result.name)}` : result.policyAction,
    };
  });

  const byClass = {};
  for (const t of classified) byClass[t.class] = (byClass[t.class] || 0) + 1;
  const worst = classified.reduce((acc, t) => higher(acc, t.class), 'READ_ONLY');
  // The server's risk is the highest risk among its *tools*, not the risk its
  // highest class implies. Those differ whenever a tool was escalated for
  // scope — a server with `delete_all_repositories` is critical, and reading
  // the class table alone would report it as merely high.
  const RISK_ORDER = ['low', 'medium', 'high', 'critical'];
  const risk = classified.reduce(
    (acc, t) => (RISK_ORDER.indexOf(t.risk) > RISK_ORDER.indexOf(acc) ? t.risk : acc),
    'low',
  );

  return {
    serverId: serverId || null,
    tools: classified,
    byClass,
    highestClass: classified.length ? worst : null,
    risk: classified.length ? risk : 'low',
    conflicts: classified.flatMap((t) => t.conflicts),
    // A server with no read-only tools at all is unusual and worth surfacing:
    // it means every call changes something.
    allWriting: classified.length > 0 && classified.every((t) => t.class !== 'READ_ONLY'),
  };
}

// `list_issues` / `listIssues` / `list-issues` -> `list issues`, so the
// word-boundary patterns above see words rather than one identifier.
function tokenize(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:/]+/g, ' ')
    .toLowerCase();
}

// Policy action strings are matched segment by segment (core/policy/rules.js),
// so a tool name with dots would silently create extra segments.
function sanitize(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

module.exports = { CLASSES, CLASS_RANK, CLASS_POLICY, SIGNALS, classifyTool, classifyServer, rank, higher, sanitize, tokenize };
