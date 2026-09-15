# The MCP capability layer

MCP is a first-class skill category *and* a capability layer of its own
(`src/core/mcp/`). The two do different jobs:

* the **skills** (`mcp-builder`, `mcp-client`, `mcp-inspector`, `mcp-security`)
  teach an agent how to build, connect to, test and assess MCP servers;
* the **capability layer** is what actually governs MCP tools at runtime.

## The rule everything else follows

> All MCP tools pass through KingAgent's Tool Manager and Policy Engine.

This is enforced by having no other path. There is no `invokeMcpTool` helper
anywhere in the platform. An MCP tool reaches an agent only by being *registered
as a tool*, at which point it inherits the agent permission gate, the
DESTRUCTIVE authorization gate, the policy evaluation in front of `authorize`,
timeouts, and the event stream.

```
server advertises tools
  → classify        (mcp/classify.js)   what does each tool actually do?
  → registry        (mcp/registry.js)   record it, with the classification
  → bridge          (mcp/bridge.js)     register as `mcp:<server>:<tool>` tools
  → ToolManager + PolicyManager         the same gates as every other tool
```

The core never speaks the protocol: the host owns the client, the transport and
the credentials, and injects an `invoke({ server, tool, input })` callback. That
keeps credentials out of the core and makes the layer testable without a server.

## Classification

Six classes, least to most dangerous: `READ_ONLY`, `WRITE`, `NETWORK`,
`DESTRUCTIVE`, `SYSTEM`, `PRIVILEGED`.

| Class | Policy action | Tool level | Approval |
| --- | --- | --- | --- |
| READ_ONLY | `mcp.tool.read` | read_only | no |
| WRITE | `mcp.tool.write` | moderate | no |
| NETWORK | `network.request` | moderate | no |
| DESTRUCTIVE | `mcp.tool.destructive` | destructive | yes |
| SYSTEM | `command.run` | destructive | yes |
| PRIVILEGED | `credential` | destructive | yes |

**A server's own hints may raise a tool's class. They may never lower it.**
`readOnlyHint: true` on `delete_repository` does not make it read-only; the name
wins and the contradiction is reported as a finding. An unrecognizable tool
defaults to `WRITE`, not `READ_ONLY` — defaulting an unknown to the
safest-sounding class is how `doThing` ends up running without a prompt.

**Scope escalates risk.** `delete_draft` is high; `delete_all_repositories`,
`drop_database`, `system_delete` are critical, because a tool whose name reaches
beyond a single object should not share an approval prompt with one that does not.

This reproduces the brief's examples exactly:

```
mcp.files.read      → low
mcp.files.write     → medium
mcp.shell.execute   → high
mcp.system.delete   → critical
```

## Writing policy for MCP

Actions are qualified per server and tool, so a deployment can gate at any level:

```js
{ action: 'mcp.tool.destructive.**',              effect: 'deny' }      // all servers
{ action: 'mcp.tool.destructive.github.**',       effect: 'approval' }  // one server
{ action: 'mcp.tool.destructive.github.delete_repo', effect: 'deny' }   // one tool
```

## Inspection before connecting

`mcp.inspect()` reads a server's advertised descriptor critically and reports:

* **what it can do** — every tool classified, with the evidence
* **whether it is well built** — thin descriptions, missing schemas, undescribed
  parameters, too many tools to choose between
* **what it would cost you** — destructive, system and privileged tools; plain
  http transport; servers with no read-only path at all
* **the prompt-injection surface** — tools returning content other people wrote
  (issues, comments, emails, pages). Their output is data, never instructions.

```bash
npm run skills -- mcp inspect github
npm run skills -- mcp test github      # a test plan, not a test runner
```

The report states its own limits in the payload: *static analysis of the
advertised descriptor only. Nothing was called.* A clean inspection is not a
clearance.

## Tool-list changes

A server's advertised tools can change between connections. `updateTools()`
records the diff, re-classifies, and surfaces **escalations** — a newly added
DESTRUCTIVE, SYSTEM or PRIVILEGED tool — as the significant event it is, rather
than absorbing it silently.

## Quarantine

`layer.quarantine(id, { reason })` removes the server's tools from the tool
surface *first*, then changes its state. That order matters: no call can slip
through between the decision and the effect.

## Skills that declare MCP servers

A manifest may name servers it works with:

```json
"mcp": { "servers": [{ "id": "github", "required": false, "tools": ["list_issues"] }] }
```

It names them. It cannot supply a command, arguments or environment — those keys
are refused — so a skill can never wire up or start a server. That remains a host
action with a human behind it.
