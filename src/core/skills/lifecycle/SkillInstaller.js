// SkillInstaller: fetch, check, decide, and only then admit a skill.
//
// The pipeline §7 of the brief asks for, in this order and with no shortcuts:
//
//   Source -> Fetch -> Validate -> Trust -> Approval -> Registry -> Enable
//
// Three properties worth stating because they are what the ordering buys:
//
//   * **Nothing executes during an install.** A manifest cannot name a script
//     and there is no install hook (schemas/SkillManifest.js), so installing a
//     hostile skill writes a record and fails a scan — it does not run anything.
//   * **Approval happens before the registry, not after.** A skill the user
//     declined never becomes a row that something else could later enable.
//   * **Dependencies are installed as first-class skills**, through this same
//     path. A dependency is not a trusted payload of its dependent; it is
//     fetched, scanned, policy-checked and approved on its own terms — the
//     alternative is a supply chain where trust is inherited by association.

const { validateSkill } = require('../security/SkillValidator');
const { describeRequest } = require('../security/SkillPermissions');
const { postureFor } = require('../security/SkillTrust');
const { SkillRecord } = require('../registry/SkillMetadata');
const { SKILL_STATES } = require('./states');
const { baseTrust, sourceLabel, withFetchResult } = require('../registry/SkillSource');
const { resolve: resolveDependencies } = require('../loader/SkillDependencyResolver');
const { TYPES } = require('../../events/event-bus');

const MAX_DEPENDENCY_DEPTH = 5;

class SkillInstallError extends Error {
  constructor(message, { code = 'SKILL_INSTALL_FAILED', skillId = null, errors = [], findings = [] } = {}) {
    super(message);
    this.name = 'SkillInstallError';
    this.code = code;
    this.skillId = skillId;
    this.errors = errors;
    this.findings = findings;
  }
}

class SkillInstaller {
  constructor({
    registry,
    sources = {},        // sourceType -> adapter
    policy = null,
    approvals = null,
    cache = null,
    bus = null,
    logger = null,
    platform = null,
    memory = null,
  } = {}) {
    if (!registry) throw new Error('SkillInstaller requires a SkillRegistry');
    this._registry = registry;
    this._sources = sources;
    this._policy = policy;
    this._approvals = approvals;
    this._cache = cache;
    this._bus = bus;
    this._logger = logger;
    this._platform = platform;
    this._memory = memory;
  }

  source(type) {
    const adapter = this._sources[type];
    if (!adapter) throw new SkillInstallError(`no source adapter for "${type}"`, { code: 'SKILL_SOURCE_MISSING' });
    return adapter;
  }

  // Install one skill.
  //
  // `request` names where it comes from: `{ source: 'github', repository, ref,
  // path }`, `{ source: 'skills.sh', id }`, `{ source: 'local', id }`,
  // `{ source: 'builtin', id }`. `actor` is who asked — it lands in the audit
  // trail and is required for any trust decision.
  async install(request, {
    actor = 'user',
    autoEnable = true,
    installDependencies = true,
    depth = 0,
    approve = null,
    context = {},
  } = {}) {
    const sourceType = request.source || 'builtin';
    const adapter = this.source(sourceType);

    // 1. Fetch. The adapter stamps provenance from what it actually read.
    let fetched;
    try {
      fetched = await adapter.fetch(request);
    } catch (err) {
      throw new SkillInstallError(`could not fetch ${request.id || request.path || sourceType}: ${err.message}`, {
        code: 'SKILL_FETCH_FAILED',
        skillId: request.id || null,
      });
    }

    // 2. Validate: manifest, scan, policy, posture.
    const verdict = await validateSkill({
      manifest: fetched.manifest,
      content: fetched.content,
      resources: fetched.resources,
      source: fetched.manifest.source,
      policy: this._policy,
      registry: this._registry,
      platform: this._platform,
      context,
    });
    if (!verdict.ok) {
      this._emit(TYPES.SKILL_REJECTED, { id: request.id || (fetched.manifest && fetched.manifest.id) || 'unknown' }, {
        stage: verdict.stage,
        errors: verdict.errors,
        findings: verdict.findings.filter((f) => f.severity === 'critical').map((f) => f.id),
      });
      throw new SkillInstallError(`skill rejected: ${verdict.errors.join('; ')}`, {
        code: verdict.blocked ? 'SKILL_CONTENT_REFUSED' : 'SKILL_INVALID',
        skillId: fetched.manifest && fetched.manifest.id,
        errors: verdict.errors,
        findings: verdict.findings,
      });
    }
    // Stamp the provenance with the digest of the bytes that were actually
    // read. The validator deliberately drops any digest a publisher put in
    // their own manifest (a self-asserted integrity claim is worthless), so
    // this is the only place a digest is recorded — and it is what lifts a
    // remote skill from `untrusted` to `community` once a person accepts it.
    const manifest = Object.freeze({
      ...verdict.manifest,
      source: withFetchResult(verdict.manifest.source, { digest: fetched.digest, ref: fetched.ref || null }),
    });

    // 3. Already installed at this version? An idempotent install is a no-op
    // that reports itself rather than a duplicate row or an error.
    const existing = this._registry.getExact(manifest.id, manifest.version);
    if (existing && existing.contentDigest === fetched.digest && existing.state !== SKILL_STATES.REMOVED) {
      return { record: existing, installed: false, reason: 'already installed at this version with identical content', verdict };
    }

    // 4. Dependencies, before the skill that needs them, each through this same
    // path. Depth-limited so a malicious manifest chain cannot walk forever.
    const dependencies = [];
    if (installDependencies && manifest.dependencies.length) {
      if (depth >= MAX_DEPENDENCY_DEPTH) {
        throw new SkillInstallError(`dependency chain deeper than ${MAX_DEPENDENCY_DEPTH} while installing ${manifest.id}`, {
          code: 'SKILL_DEPENDENCY_TOO_DEEP',
          skillId: manifest.id,
        });
      }
      for (const dep of manifest.dependencies) {
        if (this._registry.satisfiesDependency(dep)) continue;
        const installed = await this.install(
          { source: sourceType, id: dep.id, repository: request.repository, ref: request.ref, path: request.path ? `${request.path.split('/').slice(0, -1).join('/')}/${dep.id}` : null },
          { actor, autoEnable, installDependencies, depth: depth + 1, approve, context },
        ).catch((err) => {
          throw new SkillInstallError(`${manifest.id} needs ${dep.id}@${dep.range}, which could not be installed: ${err.message}`, {
            code: 'SKILL_DEPENDENCY_FAILED',
            skillId: manifest.id,
          });
        });
        dependencies.push({ id: dep.id, version: installed.record.version, installed: installed.installed });
      }
    }

    // 5. Approval. The decision is taken on the *validated* manifest, so the
    // prompt describes what was actually fetched — including a risk level the
    // validator raised above what the publisher declared.
    const provisional = new SkillRecord({
      manifest,
      trust: { tier: baseTrust(manifest.source) },
      security: { scanned: true, findings: verdict.findings, sandboxRequired: verdict.sandbox.required, blocked: false },
      contentDigest: fetched.digest,
    });
    const posture = postureFor(provisional, { findings: verdict.findings });
    const needsApproval = posture.approval || provisional.trust.tier === 'untrusted' || provisional.trust.tier === 'community';
    if (needsApproval) {
      const granted = await this._askApproval({ manifest, verdict, posture, actor, approve, context });
      provisional.recordApproval({ granted });
      if (!granted) {
        this._emit(TYPES.SKILL_REJECTED, manifest, { stage: 'approval', reason: 'a person declined the installation' });
        throw new SkillInstallError(`installation of ${manifest.id} was not approved`, { code: 'SKILL_INSTALL_DENIED', skillId: manifest.id });
      }
    }

    // 6. Register and move through the lifecycle. The states are not decorative:
    // a skill is `validating` while this happens so a concurrent reader never
    // sees a half-installed skill as usable.
    const record = this._registry.register(provisional, { replace: true });
    this._registry.transition(record, SKILL_STATES.VALIDATING, { reason: 'installing', actor });
    this._registry.transition(record, SKILL_STATES.INSTALLED, { reason: `installed from ${sourceLabel(manifest.source)}`, actor });
    this._emit(TYPES.SKILL_INSTALLED, manifest, {
      source: manifest.source.type,
      origin: sourceLabel(manifest.source),
      trust: record.trust.tier,
      risk: manifest.riskLevel,
      warnings: verdict.warnings,
      actor,
    });

    if (autoEnable) {
      this._registry.transition(record, SKILL_STATES.ENABLED, { reason: 'enabled on install', actor });
    }

    if (this._cache) {
      this._cache.set(`${manifest.id}@${manifest.version}#${manifest.source.type}`, {
        content: fetched.content,
        resources: fetched.resources,
        digest: fetched.digest,
      });
    }

    if (this._logger) {
      this._logger.info(`installed skill ${manifest.id}@${manifest.version}`, {
        source: manifest.source.type, trust: record.trust.tier, risk: manifest.riskLevel, warnings: verdict.warnings.length,
      });
    }

    return { record, installed: true, dependencies, verdict, posture, warnings: verdict.warnings };
  }

  // Seed the built-in catalogue. Built-ins skip the approval prompt — they are
  // part of the application the user already installed — but they do not skip
  // validation or scanning, which is what catches a corrupted or tampered bundle.
  async installBuiltins({ actor = 'system', autoEnable = true } = {}) {
    const adapter = this._sources.builtin;
    if (!adapter) return { installed: [], skipped: [], failed: [] };
    const installed = [];
    const skipped = [];
    const failed = [];
    for (const listing of await adapter.list()) {
      try {
        const result = await this.install({ source: 'builtin', id: listing.id }, { actor, autoEnable, installDependencies: false });
        (result.installed ? installed : skipped).push(listing.id);
      } catch (err) {
        failed.push({ id: listing.id, error: err.message });
        if (this._logger) this._logger.warn(`built-in skill ${listing.id} could not be installed`, { error: err.message });
      }
    }
    return { installed, skipped, failed };
  }

  // Check a skill without installing it — what the CLI's `skills validate` and
  // the UI's "inspect before install" both call. No registry write, no
  // approval, no side effect.
  async inspect(request, { context = {} } = {}) {
    const adapter = this.source(request.source || 'builtin');
    const fetched = await adapter.fetch(request);
    const verdict = await validateSkill({
      manifest: fetched.manifest,
      content: fetched.content,
      resources: fetched.resources,
      source: fetched.manifest.source,
      policy: this._policy,
      registry: this._registry,
      platform: this._platform,
      context,
    });
    return {
      ...verdict,
      digest: fetched.digest,
      contentBytes: fetched.content.length,
      request: describeRequest(verdict.manifest || fetched.manifest),
    };
  }

  // Would these skills resolve together? Used before a bulk install so a
  // conflict is reported once, up front, rather than halfway through.
  planDependencies(roots) {
    return resolveDependencies({ roots, registry: this._registry, platform: this._platform });
  }

  async _askApproval({ manifest, verdict, posture, actor, approve, context }) {
    const request = describeRequest(manifest);
    const summary = `Install skill "${manifest.name}" (${manifest.id}@${manifest.version}) from ${sourceLabel(manifest.source)}`;
    const detail = {
      ...request,
      trust: posture.tier,
      sandbox: posture.sandbox,
      reasons: posture.reasons,
      warnings: verdict.warnings,
      findings: verdict.findings.map((f) => ({ id: f.id, severity: f.severity, summary: f.summary, where: f.where, line: f.line })),
    };

    // A caller-supplied decision function (the CLI's --yes, a test) is honoured
    // first; otherwise the platform's ApprovalManager owns the loop so the ask
    // is a listable, auditable record like every other approval.
    if (typeof approve === 'function') {
      return (await approve({ manifest, summary, detail, posture, verdict })) === true;
    }
    if (!this._approvals) {
      // Fail closed: an install that needs a human and has no way to reach one
      // does not proceed.
      if (this._logger) this._logger.warn(`skill ${manifest.id} needs approval but no approval manager is wired`);
      return false;
    }
    const { decision } = this._approvals.requestApproval({
      action: 'skill.install',
      summary,
      reason: posture.reasons.join('; '),
      risk: manifest.riskLevel === 'critical' ? 'high' : manifest.riskLevel,
      toolId: null,
      parameters: detail,
      identity: { taskId: context.taskId || null, agentId: context.agentId || null, workspaceId: context.workspaceId || null },
      metadata: { skillId: manifest.id, version: manifest.version, actor },
    });
    const outcome = await decision;
    return outcome === true || (outcome && outcome.approved === true);
  }

  _emit(type, manifest, payload) {
    if (!this._bus) return;
    this._bus.emit(type, { skillId: manifest.id }, { skill: manifest.id, version: manifest.version || null, ...payload });
  }
}

module.exports = { SkillInstaller, SkillInstallError, MAX_DEPENDENCY_DEPTH };
