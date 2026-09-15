# The skill manifest

Every skill has a machine-readable manifest. It is validated by
`src/core/skills/schemas/SkillManifest.js` before anything about it is believed,
and an invalid manifest is a refusal — never a warning with defaults filled in.

```json
{
  "id": "mcp-builder",
  "name": "MCP Builder",
  "version": "1.0.0",
  "description": "Build production-ready MCP servers.",
  "author": "KingAgent",
  "license": "MIT",
  "homepage": "https://example.com/mcp-builder",
  "categories": ["mcp-builder", "mcp-tool-design", "api-design"],
  "capabilities": ["mcp.server.create", "mcp.tool.design"],
  "dependencies": ["api-design@^1.0.0"],
  "permissions": ["filesystem.read", "filesystem.write", "process.execute"],
  "riskLevel": "high",
  "supportedPlatforms": ["windows", "macos", "linux"],
  "entry": { "instructions": "SKILL.md", "resources": ["examples/tools.md"] },
  "tools": ["fs:read", "fs:write"],
  "mcp": { "servers": [{ "id": "github", "required": false, "tools": ["list_issues"] }] },
  "tags": ["mcp", "server", "tools"]
}
```

## Fields

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | `[a-z][a-z0-9._:-]*` — the identity used everywhere |
| `name` | yes | Human-readable |
| `version` | yes | Strict semver (`1.0.0`, `1.0.0-beta.1`). `latest` and `v1.0` are refused |
| `description` | yes | ≤ 2000 characters |
| `categories` | yes | One or more from the taxonomy (`src/core/skills/taxonomy.js`). Unknown categories are an error |
| `capabilities` | no | Dotted claims used in discovery. A claim, never a grant |
| `dependencies` | no | `"id@^1.0.0"`, `"id"` or `{ id, version }`. Max 32, no duplicates |
| `permissions` | no | From the fixed set below. A *request*, never a grant |
| `riskLevel` | no | Corrected upward from the permissions; never downward |
| `supportedPlatforms` | no | `windows` / `macos` / `linux`; defaults to all three |
| `entry` | no | Relative paths only; traversal is refused. Defaults to `SKILL.md` |
| `tools` | no | Tool ids the skill expects. Intersected with what is registered |
| `mcp.servers` | no | Names servers the skill works with. May not carry `command`, `args` or `env` |
| `tags`, `author`, `license`, `homepage`, `docsUrl`, `deprecated` | no | Metadata |

Unknown keys are dropped. `source` is set by the installer from what was
actually fetched — a publisher's own `source` block is ignored.

## Fields that are refused by name

`command`, `script`, `scripts`, `exec`, `run`, `install`, `postInstall`,
`preInstall`, `hooks`, `env`, `environment`, `secrets`, `setup`, `binary`.

A manifest carrying any of these is rejected with an error explaining the model
rather than being silently sanitized. **Installing a skill must never be a
code-execution primitive.** A skill contributes instructions; actions go through
the tool manager and the policy engine.

## Permissions

| Permission | Policy action | Risk floor |
| --- | --- | --- |
| `filesystem.read` | `filesystem.read` | low |
| `filesystem.write` | `filesystem.write` | medium |
| `filesystem.delete` | `filesystem.delete` | high |
| `process.execute` | `command.run` | high |
| `network.request` | `network.request` | medium |
| `credential.read` | `credential` | critical |
| `mcp.connect` | `mcp.connect` | medium |
| `mcp.tool.invoke` | `mcp.tool.invoke` | medium |
| `agent.delegate` | `agent.delegate` | medium |
| `memory.write` | `memory.write` | low |
| `sandbox.exec` | `sandbox.exec` | high |
| `system.modify` | `system.modify` | critical |

The risk floor is why `riskLevel` is corrected: a manifest asking for
`process.execute` and declaring itself `low` is stored as `high`, with
`declaredRiskLevel: "low"` and `riskRaised: true` kept so the UI and the audit
trail show the correction.

## Provenance (`source`)

Set by the installer, never by the publisher.

| Type | Required | Trust ceiling |
| --- | --- | --- |
| `builtin` | — | `builtin` |
| `local` | `directory` | `workspace` |
| `github` | `repository` (`owner/repo`), optional `ref`, `path` | `community` (only when pinned to a commit sha) |
| `skills.sh` | `slug` | `community` (only once a content digest is recorded) |

Repository names, refs and paths are validated against traversal: `../evil`,
`refs/../..`, absolute paths and Windows drive letters are all refused.

## Layout on disk

A local or GitHub-hosted skill is a directory:

```
my-skill/
  skill.json      (or kingagent.skill.json)
  SKILL.md        the instructions — the `entry.instructions` path
  examples/…      optional resources, each listed in entry.resources
```

## Validating one

```bash
npm run skills -- validate --source=local --id=my-skill --skills-dir=/path/to/skills
```

The output is the full verdict: manifest errors, scanner findings with file and
line, undeclared capabilities, the policy decision, and whether the skill would
run sandboxed or ask for approval.
