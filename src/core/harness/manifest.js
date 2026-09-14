// Harness manifest: the declarative description of an execution backend.
//
// A harness is *data* first and adapter second. The manifest is what the
// registry lists, the router matches on, and the UI displays, so it has to be
// validatable without running anything. That is the whole security posture of
// this file: a manifest is parsed as inert values, every unknown key is dropped,
// and no manifest field is ever evaluated. A manifest cannot name an executable
// to run, cannot smuggle a shell string, and cannot declare a secret.
//
// Where the manifest needs the host to *do* something (probe for an installed
// binary, run an installer), the manifest only carries argv hints; the adapter
// asks an injected host callback and refuses if none is wired.

const { isPlainObject, isString, nonEmptyString, validId, pickKnown, fail } = require('../schema/validate');
const { createCapabilities, normalizeCapabilities } = require('./capabilities');

const HARNESS_TYPES = Object.freeze(['cli', 'acp', 'mcp', 'http', 'in-process']);
const PLATFORMS = Object.freeze(['windows', 'macos', 'linux']);
const ENVIRONMENT_MODES = Object.freeze(['minimal', 'inherit', 'allowlist']);
const WORKSPACE_MODES = Object.freeze(['workspace', 'readonly', 'none']);

const MANIFEST_FIELDS = [
  'id', 'name', 'description', 'type', 'provider', 'version', 'platforms',
  'capabilities', 'command', 'supportedModels', 'environmentPolicy',
  'workspacePolicy', 'detect', 'install', 'secretEnv', 'docsUrl', 'homepage',
];

// Never a legitimate manifest key: a default environment variable whose name
// smells like a credential is exactly how a secret ends up in an agent's
// context, which §41 forbids. Manifests declare the *names* of secrets a
// harness reads (secretEnv) and the policy layer decides whether to provide
// them at run time — never a value.
const SECRET_LIKE = /(api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|ssh|auth)/i;

// Characters that turn an argv vector into a shell injection when a host
// naively joins it. A manifest command must be an executable name (or argv
// vector) and nothing more.
const SHELL_METACHARACTERS = /[;&|`$><\n\r]/;

function validateManifest(input) {
  if (!isPlainObject(input)) return fail(['harness manifest must be an object']);
  if (!validId(input.id)) return fail([`invalid harness id: ${JSON.stringify(input.id)}`]);
  if (!nonEmptyString(input.name)) return fail(['harness manifest requires a name']);

  const type = input.type || 'cli';
  if (!HARNESS_TYPES.includes(type)) return fail([`unknown harness type: ${JSON.stringify(input.type)}`]);

  const platforms = input.platforms === undefined ? [...PLATFORMS] : input.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0) return fail(['platforms must be a non-empty array']);
  for (const p of platforms) {
    if (!PLATFORMS.includes(p)) return fail([`unknown platform: ${JSON.stringify(p)}`]);
  }

  let capabilities;
  try {
    capabilities = normalizeCapabilities(input.capabilities || []);
  } catch (err) {
    return fail([err.message]);
  }

  if (input.command !== undefined && input.command !== null && !isCommand(input.command)) {
    return fail(['command must be a string or an array of strings with no shell metacharacters']);
  }
  if (input.supportedModels !== undefined && !isStringArray(input.supportedModels)) {
    return fail(['supportedModels must be an array of strings']);
  }
  if (input.secretEnv !== undefined && !isStringArray(input.secretEnv)) {
    return fail(['secretEnv must be an array of environment variable names']);
  }
  if (input.env !== undefined) {
    // Deliberately unsupported: an `env` block is how a manifest would plant a
    // credential in every spawned process. The host injects environment, and
    // only through the policy engine.
    return fail(['manifests may not declare env — environment is granted by policy, never by a manifest']);
  }
  if (input.detect !== undefined && !isPlainObject(input.detect)) return fail(['detect must be an object']);
  if (input.install !== undefined && !isPlainObject(input.install)) return fail(['install must be an object']);
  if (isPlainObject(input.install)) {
    for (const [platform, steps] of Object.entries(input.install)) {
      if (!PLATFORMS.includes(platform)) return fail([`install steps for unknown platform: ${platform}`]);
      if (!Array.isArray(steps) || !steps.every(isCommand)) return fail([`install steps for ${platform} must be argv arrays`]);
    }
  }

  const environmentPolicy = normalizeEnvironmentPolicy(input.environmentPolicy);
  if (!environmentPolicy.ok) return fail(environmentPolicy.errors);
  const workspacePolicy = normalizeWorkspacePolicy(input.workspacePolicy);
  if (!workspacePolicy.ok) return fail(workspacePolicy.errors);

  return {
    ok: true,
    manifest: normalizeManifest(input, { capabilities, environmentPolicy: environmentPolicy.policy, workspacePolicy: workspacePolicy.policy }),
  };
}

function normalizeManifest(input, { capabilities, environmentPolicy, workspacePolicy }) {
  const base = pickKnown(input, MANIFEST_FIELDS);
  return Object.freeze({
    id: base.id,
    name: base.name,
    description: base.description || '',
    type: base.type || 'cli',
    provider: base.provider || base.id,
    version: isString(base.version) ? base.version : 'unknown',
    platforms: Object.freeze([...base.platforms || PLATFORMS].sort()),
    capabilities: createCapabilities({ tags: capabilities, models: base.supportedModels || [] }),
    command: normalizeCommand(base.command),
    environmentPolicy,
    workspacePolicy,
    // Names only — never values. The policy engine decides whether a run may
    // see them, and the host is responsible for keeping them out of logs.
    secretEnv: Object.freeze([...(base.secretEnv || [])].sort()),
    detect: freezeHints(base.detect),
    install: freezeInstall(base.install),
    docsUrl: base.docsUrl || null,
    homepage: base.homepage || null,
  });
}

function normalizeEnvironmentPolicy(policy) {
  if (policy === undefined) return { ok: true, policy: Object.freeze({ mode: 'minimal', allowlist: Object.freeze([]) }) };
  if (!isPlainObject(policy)) return { ok: false, errors: ['environmentPolicy must be an object'] };
  const mode = policy.mode || 'minimal';
  if (!ENVIRONMENT_MODES.includes(mode)) return { ok: false, errors: [`unknown environmentPolicy.mode: ${JSON.stringify(policy.mode)}`] };
  const allowlist = policy.allowlist === undefined ? [] : policy.allowlist;
  if (!isStringArray(allowlist)) return { ok: false, errors: ['environmentPolicy.allowlist must be an array of names'] };
  for (const name of allowlist) {
    if (SECRET_LIKE.test(name)) {
      return { ok: false, errors: [`environmentPolicy.allowlist may not name a credential-shaped variable (${name}); use secretEnv + policy instead`] };
    }
  }
  return { ok: true, policy: Object.freeze({ mode, allowlist: Object.freeze([...allowlist].sort()) }) };
}

function normalizeWorkspacePolicy(policy) {
  if (policy === undefined) return { ok: true, policy: Object.freeze({ mode: 'workspace', allowOutside: false, readPaths: Object.freeze([]), writePaths: Object.freeze([]) }) };
  if (!isPlainObject(policy)) return { ok: false, errors: ['workspacePolicy must be an object'] };
  const mode = policy.mode || 'workspace';
  if (!WORKSPACE_MODES.includes(mode)) return { ok: false, errors: [`unknown workspacePolicy.mode: ${JSON.stringify(policy.mode)}`] };
  for (const key of ['readPaths', 'writePaths']) {
    if (policy[key] !== undefined && !isStringArray(policy[key])) return { ok: false, errors: [`workspacePolicy.${key} must be an array of paths`] };
  }
  // `allowOutside` is the one flag that widens the boundary past the workspace.
  // It is accepted (some backends genuinely need it) but it is always recorded
  // in the snapshot, so the policy engine and the UI can see and refuse it.
  return {
    ok: true,
    policy: Object.freeze({
      mode,
      allowOutside: policy.allowOutside === true,
      readPaths: Object.freeze([...(policy.readPaths || [])].sort()),
      writePaths: Object.freeze([...(policy.writePaths || [])].sort()),
    }),
  };
}

function isCommand(v) {
  if (isString(v)) return v.length > 0 && !SHELL_METACHARACTERS.test(v);
  if (Array.isArray(v)) return v.length > 0 && v.every((part) => isString(part) && !SHELL_METACHARACTERS.test(part));
  return false;
}

function normalizeCommand(v) {
  if (v === undefined || v === null) return null;
  return Object.freeze(isString(v) ? [v] : [...v]);
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => isString(s) && s.length > 0);
}

function freezeHints(detect) {
  if (!isPlainObject(detect)) return Object.freeze({});
  const hints = {};
  if (isString(detect.command) && !SHELL_METACHARACTERS.test(detect.command)) hints.command = detect.command;
  if (isStringArray(detect.paths)) hints.paths = Object.freeze([...detect.paths]);
  if (isString(detect.versionFlag)) hints.versionFlag = detect.versionFlag;
  return Object.freeze(hints);
}

function freezeInstall(install) {
  if (!isPlainObject(install)) return Object.freeze({});
  const out = {};
  for (const [platform, steps] of Object.entries(install)) {
    if (Array.isArray(steps) && steps.every(isCommand)) out[platform] = Object.freeze(steps.map(normalizeCommand));
  }
  return Object.freeze(out);
}

// A serializable view for the UI/IPC. Contains no functions and no secrets.
function manifestView(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    type: manifest.type,
    provider: manifest.provider,
    version: manifest.version,
    platforms: [...manifest.platforms],
    capabilities: [...manifest.capabilities.tags],
    supports: { ...manifest.capabilities.supports },
    models: [...manifest.capabilities.models],
    environmentPolicy: { mode: manifest.environmentPolicy.mode, allowlist: [...manifest.environmentPolicy.allowlist] },
    workspacePolicy: {
      mode: manifest.workspacePolicy.mode,
      allowOutside: manifest.workspacePolicy.allowOutside,
    },
    docsUrl: manifest.docsUrl,
  };
}

module.exports = {
  HARNESS_TYPES,
  PLATFORMS,
  ENVIRONMENT_MODES,
  WORKSPACE_MODES,
  MANIFEST_FIELDS,
  validateManifest,
  normalizeManifest,
  manifestView,
  isCommand,
};
