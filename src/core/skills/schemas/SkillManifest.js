// The skill manifest: a capability described as data, validated before anything
// about it is believed.
//
// This file carries the security posture of the whole skill ecosystem, and it
// is the same one core/harness/manifest.js established for execution backends:
//
//   * a manifest is parsed into a fixed shape and every unknown key is dropped;
//   * no manifest field is ever evaluated, interpolated into a shell string, or
//     used as a path without a traversal check;
//   * a manifest may not name something to execute. There is no `command`, no
//     `script`, no `postInstall`, no `env`. Installing a skill must never be a
//     code-execution primitive — a skill contributes *instructions and
//     metadata*, and every action it later takes goes through the existing
//     ToolManager and PolicyManager. Manifests carrying those keys are rejected
//     loudly rather than sanitized, so a publisher learns the model instead of
//     silently shipping something that does nothing.
//   * a manifest may not raise its own trust or lower its own risk. `riskLevel`
//     is corrected upward from the permissions it requests, and trust comes
//     from provenance (registry/SkillSource.js), never from the payload.

const { isPlainObject, isString, nonEmptyString, validId, pickKnown, fail } = require('../../schema/validate');
const { isVersion, isRange } = require('../registry/SkillVersion');
const { validateSource } = require('../registry/SkillSource');
const { isSafeRelativePath } = require('../registry/SkillSource');
const { unknownCategories } = require('../taxonomy');
const {
  RISK_LEVELS, unknownPermissions, derivedRisk, maxRisk, riskRank,
} = require('./SkillPermissionSchema');

const MANIFEST_FIELDS = [
  'id', 'name', 'version', 'description', 'author', 'license', 'homepage', 'docsUrl',
  'source', 'capabilities', 'categories', 'tags', 'dependencies', 'permissions',
  'riskLevel', 'supportedPlatforms', 'entry', 'tools', 'mcp', 'deprecated',
  'deprecationReason', 'keywords',
];

// Keys that would turn "install a skill" into "run this". Rejected by name so
// the error explains the model rather than leaving a publisher guessing why
// their hook never fired.
const FORBIDDEN_FIELDS = Object.freeze([
  'command', 'script', 'scripts', 'exec', 'run', 'install', 'postInstall',
  'preInstall', 'hooks', 'env', 'environment', 'secrets', 'setup', 'binary',
]);

const PLATFORMS = Object.freeze(['windows', 'macos', 'linux']);
const MAX_TAGS = 24;
const MAX_CAPABILITIES = 40;
const MAX_DEPENDENCIES = 32;
const MAX_TEXT = 2000;

// A capability is a dotted, lowercase action name a skill claims to provide:
// `mcp.server.create`, `testing.e2e.run`. It is a *claim*, matched during
// discovery; it grants nothing on its own.
const CAPABILITY = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)*$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,40}$/;

function validateManifest(input, { source: sourceOverride = null } = {}) {
  if (!isPlainObject(input)) return fail(['skill manifest must be an object']);

  for (const key of FORBIDDEN_FIELDS) {
    if (input[key] !== undefined) {
      return fail([
        `skill manifests may not declare "${key}" — a skill contributes instructions and metadata, ` +
        'never something to execute; actions go through the tool manager and the policy engine',
      ]);
    }
  }

  if (!validId(input.id)) return fail([`invalid skill id: ${JSON.stringify(input.id)}`]);
  if (!nonEmptyString(input.name)) return fail(['skill manifest requires a name']);
  if (!isVersion(input.version)) return fail([`skill "${input.id}" requires a semantic version (got ${JSON.stringify(input.version)})`]);
  if (!nonEmptyString(input.description)) return fail([`skill "${input.id}" requires a description`]);
  if (input.description.length > MAX_TEXT) return fail([`skill "${input.id}" description exceeds ${MAX_TEXT} characters`]);
  if (input.author !== undefined && !isString(input.author)) return fail(['author must be a string']);

  const sourceResult = validateSource(sourceOverride || input.source);
  if (!sourceResult.ok) return fail(sourceResult.errors);

  const capabilities = input.capabilities === undefined ? [] : input.capabilities;
  if (!isStringArray(capabilities)) return fail(['capabilities must be an array of strings']);
  if (capabilities.length > MAX_CAPABILITIES) return fail([`a skill may declare at most ${MAX_CAPABILITIES} capabilities`]);
  const badCapability = capabilities.find((c) => !CAPABILITY.test(c));
  if (badCapability !== undefined) return fail([`invalid capability: ${JSON.stringify(badCapability)}`]);

  const categories = input.categories === undefined ? [] : input.categories;
  if (!isStringArray(categories)) return fail(['categories must be an array of strings']);
  if (categories.length === 0) return fail([`skill "${input.id}" must declare at least one category from the KingAgent taxonomy`]);
  const badCategories = unknownCategories(categories);
  if (badCategories.length) return fail([`unknown skill categories: ${badCategories.join(', ')} (see core/skills/taxonomy.js)`]);

  const tags = input.tags === undefined ? [] : input.tags;
  if (!isStringArray(tags)) return fail(['tags must be an array of strings']);
  if (tags.length > MAX_TAGS) return fail([`a skill may declare at most ${MAX_TAGS} tags`]);
  const badTag = tags.find((t) => !TAG.test(t));
  if (badTag !== undefined) return fail([`invalid tag: ${JSON.stringify(badTag)}`]);

  const dependencies = normalizeDependencies(input.dependencies);
  if (!dependencies.ok) return fail(dependencies.errors);

  const permissions = input.permissions === undefined ? [] : input.permissions;
  if (!isStringArray(permissions)) return fail(['permissions must be an array of strings']);
  const badPermissions = unknownPermissions(permissions);
  if (badPermissions.length) return fail([`unknown skill permissions: ${badPermissions.join(', ')}`]);

  if (input.riskLevel !== undefined && !RISK_LEVELS.includes(input.riskLevel)) {
    return fail([`riskLevel must be one of ${RISK_LEVELS.join(', ')} (got ${JSON.stringify(input.riskLevel)})`]);
  }

  const platforms = input.supportedPlatforms === undefined ? [...PLATFORMS] : input.supportedPlatforms;
  if (!Array.isArray(platforms) || platforms.length === 0) return fail(['supportedPlatforms must be a non-empty array']);
  const badPlatform = platforms.find((p) => !PLATFORMS.includes(p));
  if (badPlatform !== undefined) return fail([`unknown platform: ${JSON.stringify(badPlatform)}`]);

  const entry = normalizeEntry(input.entry);
  if (!entry.ok) return fail(entry.errors);

  const tools = input.tools === undefined ? [] : input.tools;
  if (!isStringArray(tools)) return fail(['tools must be an array of tool ids']);

  const mcp = normalizeMcp(input.mcp);
  if (!mcp.ok) return fail(mcp.errors);

  return {
    ok: true,
    manifest: normalizeManifest(input, {
      source: sourceResult.source,
      capabilities,
      categories,
      tags,
      dependencies: dependencies.dependencies,
      permissions,
      platforms,
      entry: entry.entry,
      tools,
      mcp: mcp.mcp,
    }),
  };
}

function normalizeManifest(input, parts) {
  const base = pickKnown(input, MANIFEST_FIELDS);
  const declaredRisk = RISK_LEVELS.includes(base.riskLevel) ? base.riskLevel : 'low';
  const floor = derivedRisk(parts.permissions);
  const riskLevel = maxRisk(declaredRisk, floor);
  return Object.freeze({
    id: base.id,
    name: base.name,
    version: base.version,
    description: base.description,
    author: isString(base.author) ? base.author : '',
    license: isString(base.license) ? base.license : '',
    homepage: isString(base.homepage) ? base.homepage : null,
    docsUrl: isString(base.docsUrl) ? base.docsUrl : null,
    source: parts.source,
    capabilities: Object.freeze([...new Set(parts.capabilities)].sort()),
    categories: Object.freeze([...new Set(parts.categories)].sort()),
    tags: Object.freeze([...new Set(parts.tags)].sort()),
    dependencies: parts.dependencies,
    permissions: Object.freeze([...new Set(parts.permissions)].sort()),
    riskLevel,
    // Recorded when the manifest claimed less than its permissions imply. The
    // validator does not fail on it — a publisher being optimistic is common —
    // but the UI and the audit trail show the correction, so an under-declared
    // skill is visible rather than quietly promoted.
    declaredRiskLevel: declaredRisk,
    riskRaised: riskRank(riskLevel) > riskRank(declaredRisk),
    supportedPlatforms: Object.freeze([...new Set(parts.platforms)].sort()),
    entry: parts.entry,
    tools: Object.freeze([...new Set(parts.tools)].sort()),
    mcp: parts.mcp,
    deprecated: base.deprecated === true,
    deprecationReason: isString(base.deprecationReason) ? base.deprecationReason : '',
  });
}

// `["other-skill"]`, `["other-skill@^1.0.0"]` and `[{ id, version }]` all parse;
// the stored shape is always `{ id, range }`.
function normalizeDependencies(input) {
  if (input === undefined || input === null) return { ok: true, dependencies: Object.freeze([]) };
  if (!Array.isArray(input)) return { ok: false, errors: ['dependencies must be an array'] };
  if (input.length > MAX_DEPENDENCIES) return { ok: false, errors: [`a skill may declare at most ${MAX_DEPENDENCIES} dependencies`] };
  const out = [];
  for (const dep of input) {
    let id;
    let range;
    if (isString(dep)) {
      const at = dep.lastIndexOf('@');
      id = at > 0 ? dep.slice(0, at) : dep;
      range = at > 0 ? dep.slice(at + 1) : '*';
    } else if (isPlainObject(dep)) {
      id = dep.id;
      range = dep.version === undefined ? (dep.range === undefined ? '*' : dep.range) : dep.version;
    } else {
      return { ok: false, errors: ['each dependency must be a string or an object'] };
    }
    if (!validId(id)) return { ok: false, errors: [`invalid dependency id: ${JSON.stringify(id)}`] };
    if (!isRange(range)) return { ok: false, errors: [`invalid dependency range for ${id}: ${JSON.stringify(range)}`] };
    if (out.some((d) => d.id === id)) return { ok: false, errors: [`dependency ${id} is declared twice`] };
    out.push(Object.freeze({ id, range: range === undefined ? '*' : String(range) }));
  }
  return { ok: true, dependencies: Object.freeze(out) };
}

// Which file inside the skill carries the instructions, and which optional
// files are readable alongside it. Both are relative paths validated against
// traversal here and re-validated by the source adapter that reads them.
function normalizeEntry(entry) {
  if (entry === undefined || entry === null) {
    return { ok: true, entry: Object.freeze({ instructions: 'SKILL.md', resources: Object.freeze([]) }) };
  }
  if (isString(entry)) {
    if (!isSafeRelativePath(entry)) return { ok: false, errors: [`entry must be a relative path inside the skill: ${JSON.stringify(entry)}`] };
    return { ok: true, entry: Object.freeze({ instructions: entry, resources: Object.freeze([]) }) };
  }
  if (!isPlainObject(entry)) return { ok: false, errors: ['entry must be a string or an object'] };
  const instructions = entry.instructions === undefined ? 'SKILL.md' : entry.instructions;
  if (!isSafeRelativePath(instructions)) return { ok: false, errors: [`entry.instructions must be a relative path: ${JSON.stringify(instructions)}`] };
  const resources = entry.resources === undefined ? [] : entry.resources;
  if (!Array.isArray(resources)) return { ok: false, errors: ['entry.resources must be an array of relative paths'] };
  const badResource = resources.find((r) => !isSafeRelativePath(r));
  if (badResource !== undefined) return { ok: false, errors: [`entry.resources contains an unsafe path: ${JSON.stringify(badResource)}`] };
  return { ok: true, entry: Object.freeze({ instructions, resources: Object.freeze([...resources]) }) };
}

// What an MCP-flavoured skill declares about the servers it expects. Names and
// shapes only: a manifest can say "this skill works with an MCP server called
// github", it can never supply the command that starts one or the token it
// authenticates with. Wiring a server is a separate, human-approved act
// (core/mcp/).
function normalizeMcp(mcp) {
  if (mcp === undefined || mcp === null) return { ok: true, mcp: null };
  if (!isPlainObject(mcp)) return { ok: false, errors: ['mcp must be an object'] };
  const servers = mcp.servers === undefined ? [] : mcp.servers;
  if (!Array.isArray(servers)) return { ok: false, errors: ['mcp.servers must be an array'] };
  const out = [];
  for (const server of servers) {
    const spec = isString(server) ? { id: server } : server;
    if (!isPlainObject(spec)) return { ok: false, errors: ['each mcp server entry must be a string or an object'] };
    if (!validId(spec.id)) return { ok: false, errors: [`invalid mcp server id: ${JSON.stringify(spec.id)}`] };
    if (spec.command !== undefined || spec.args !== undefined || spec.env !== undefined) {
      return { ok: false, errors: ['an mcp server entry may not carry command, args or env — a skill names a server, it does not start one'] };
    }
    const tools = spec.tools === undefined ? [] : spec.tools;
    if (!isStringArray(tools)) return { ok: false, errors: [`mcp.servers[${spec.id}].tools must be an array of tool names`] };
    out.push(Object.freeze({
      id: spec.id,
      required: spec.required === true,
      tools: Object.freeze([...tools].sort()),
      transport: ['stdio', 'http', 'sse'].includes(spec.transport) ? spec.transport : null,
    }));
  }
  return { ok: true, mcp: Object.freeze({ servers: Object.freeze(out) }) };
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => isString(s) && s.length > 0 && s.length <= 200);
}

// A serializable view for IPC and the UI. No functions, no source credentials,
// no instruction text — the pane fetches content separately and only for a
// skill the user opened.
function manifestView(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    license: manifest.license,
    homepage: manifest.homepage,
    docsUrl: manifest.docsUrl,
    source: {
      type: manifest.source.type,
      repository: manifest.source.repository,
      slug: manifest.source.slug,
      ref: manifest.source.ref,
      digest: manifest.source.digest,
    },
    capabilities: [...manifest.capabilities],
    categories: [...manifest.categories],
    tags: [...manifest.tags],
    dependencies: manifest.dependencies.map((d) => ({ id: d.id, range: d.range })),
    permissions: [...manifest.permissions],
    riskLevel: manifest.riskLevel,
    declaredRiskLevel: manifest.declaredRiskLevel,
    riskRaised: manifest.riskRaised,
    supportedPlatforms: [...manifest.supportedPlatforms],
    tools: [...manifest.tools],
    mcp: manifest.mcp ? { servers: manifest.mcp.servers.map((s) => ({ ...s, tools: [...s.tools] })) } : null,
    deprecated: manifest.deprecated,
    deprecationReason: manifest.deprecationReason,
  };
}

module.exports = {
  MANIFEST_FIELDS,
  FORBIDDEN_FIELDS,
  PLATFORMS,
  CAPABILITY,
  validateManifest,
  normalizeManifest,
  normalizeDependencies,
  manifestView,
};
