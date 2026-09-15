// SkillValidator: the single gate between "a source offered this" and "the
// registry knows about it".
//
// The ten checks §8 of the phase brief asks for, in the order that fails
// cheapest first, each one returning evidence rather than a boolean:
//
//    1. manifest validation      — shape, ids, versions, forbidden keys
//    2. source validation        — provenance parses, paths cannot traverse
//    3. platform compatibility   — will it run on this OS at all
//    4. dependency validation    — declared deps are resolvable in principle
//    5. content scan             — SkillScanner over instructions + resources
//    6. permission analysis      — what it asks for, what that implies
//    7. network requirement      — declared vs. observed in content
//    8. filesystem requirement   — declared vs. observed in content
//    9. policy evaluation        — the platform's own PolicyManager
//   10. sandbox decision         — posture from trust x risk x findings
//
// A validator never installs, never enables, and never runs anything. It
// answers "may this exist here, and under what conditions", and the installer
// acts on that answer.

const { validateManifest } = require('../schemas/SkillManifest');
const { scanSkill } = require('./SkillScanner');
const { evaluatePermissions } = require('./SkillPermissions');
const { decide: decideSandbox } = require('./SkillSandbox');
const { postureFor } = require('./SkillTrust');
const { baseTrust } = require('../registry/SkillSource');
const { SkillRecord } = require('../registry/SkillMetadata');

// Content patterns that imply a capability the manifest should have declared.
// An under-declared skill is not necessarily malicious — it is, however, a
// skill whose approval prompt would have understated what it does, which is
// exactly the thing the user would not forgive.
const IMPLIES_NETWORK = /\b(https?:\/\/|curl\s|wget\s|fetch\(|axios|Invoke-WebRequest|requests\.get)\b/i;
const IMPLIES_FS_WRITE = /\b(writeFile|Set-Content|Out-File|>>?\s*[\w./\\-]+\.(md|json|js|ts|py|txt|yml|yaml)|mkdir\s|touch\s)\b/i;
const IMPLIES_EXEC = /\b(npm\s+run|npx\s|node\s+[\w./-]+|python3?\s+[\w./-]+|bash\s|sh\s+-c|Start-Process|child_process|subprocess)\b/i;

async function validateSkill({
  manifest: rawManifest,
  content = '',
  resources = {},
  source = null,
  policy = null,
  registry = null,
  platform = null,
  context = {},
} = {}) {
  const errors = [];
  const warnings = [];

  // 1 + 2. Manifest and source.
  const parsed = validateManifest(rawManifest, source ? { source } : {});
  if (!parsed.ok) {
    return verdict({ ok: false, errors: parsed.errors, warnings, stage: 'manifest' });
  }
  const manifest = parsed.manifest;
  if (manifest.riskRaised) {
    warnings.push(`declared riskLevel "${manifest.declaredRiskLevel}" was raised to "${manifest.riskLevel}" by the permissions it requests`);
  }
  if (manifest.deprecated) warnings.push(`the publisher marks this skill deprecated: ${manifest.deprecationReason || 'no reason given'}`);

  // 3. Platform.
  if (platform && !manifest.supportedPlatforms.includes(platform)) {
    errors.push(`skill ${manifest.id} does not support ${platform} (supports: ${manifest.supportedPlatforms.join(', ')})`);
    return verdict({ ok: false, errors, warnings, manifest, stage: 'platform' });
  }

  // 4. Dependencies — presence only. Full graph resolution (cycles, version
  // conflicts) belongs to the dependency resolver, which needs the whole
  // registry; this catches the common case early with a better message.
  const missing = [];
  if (registry) {
    for (const dep of manifest.dependencies) {
      if (!registry.satisfiesDependency(dep)) missing.push(`${dep.id}@${dep.range}`);
    }
  }
  if (missing.length) warnings.push(`unresolved dependencies: ${missing.join(', ')} (the installer will try to fetch them)`);

  // 5. Content scan.
  const scan = scanSkill({ manifest, content, resources });
  if (scan.blocked) {
    errors.push(
      `content scan refused ${manifest.id}: ${scan.findings.filter((f) => f.severity === 'critical').map((f) => `${f.summary} (${f.where}:${f.line})`).join('; ')}`,
    );
  }
  for (const f of scan.findings.filter((x) => x.severity === 'warn')) {
    warnings.push(`${f.summary} — ${f.where}:${f.line}`);
  }

  // 6 + 7 + 8. Declared vs. observed capability.
  const declared = new Set(manifest.permissions);
  const wholeText = [content, ...Object.values(resources || {})].join('\n');
  const undeclared = [];
  if (IMPLIES_NETWORK.test(wholeText) && !declared.has('network.request')) undeclared.push('network.request');
  if (IMPLIES_FS_WRITE.test(wholeText) && !declared.has('filesystem.write')) undeclared.push('filesystem.write');
  if (IMPLIES_EXEC.test(wholeText) && !declared.has('process.execute')) undeclared.push('process.execute');
  if (undeclared.length) {
    warnings.push(`content suggests capabilities the manifest does not declare: ${undeclared.join(', ')}`);
  }

  // 9. Policy. The verdict is taken without opening a human loop — installing a
  // skill must not prompt once per permission — and the run path asks for real.
  const permissions = await evaluatePermissions({ policy, manifest, context, askApproval: false });
  if (permissions.denied.length) {
    errors.push(`policy denies ${permissions.denied.join(', ')} for ${manifest.id}`);
  } else if (permissions.undetermined) {
    // Validation without a policy engine is still useful (a CLI check, a test,
    // a publisher linting their own skill) — it just cannot answer the policy
    // question. Say so instead of pretending either answer; the run path
    // refuses outright (SkillPermissions.enforcePermissions).
    warnings.push('permissions could not be evaluated: no policy engine is wired. They are enforced when the skill runs.');
  }

  // 10. Posture: a provisional record is enough, and it is thrown away — the
  // installer builds the real one from this verdict.
  const provisional = new SkillRecord({
    manifest,
    trust: { tier: baseTrust(manifest.source) },
    security: { scanned: true, findings: scan.findings, blocked: scan.blocked },
  });
  const sandbox = decideSandbox(provisional, { findings: scan.findings });
  const posture = postureFor(provisional, { findings: scan.findings });

  return verdict({
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    scan,
    permissions,
    sandbox,
    posture,
    undeclared,
    missingDependencies: missing,
    stage: errors.length === 0 ? 'complete' : 'policy',
  });
}

function verdict({
  ok, errors = [], warnings = [], manifest = null, scan = null, permissions = null,
  sandbox = null, posture = null, undeclared = [], missingDependencies = [], stage = 'manifest',
}) {
  return {
    ok,
    stage,
    errors,
    warnings,
    manifest,
    findings: scan ? scan.findings : [],
    blocked: Boolean(scan && scan.blocked),
    scanSummary: scan ? scan.summary : null,
    permissions,
    sandbox,
    posture,
    undeclaredCapabilities: undeclared,
    missingDependencies,
    validatedAt: Date.now(),
  };
}

module.exports = { validateSkill, IMPLIES_NETWORK, IMPLIES_FS_WRITE, IMPLIES_EXEC };
