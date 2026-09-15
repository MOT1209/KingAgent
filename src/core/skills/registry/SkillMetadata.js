// SkillRecord: everything the platform knows about one installed skill.
//
// The manifest is what a publisher says; this record is what KingAgent has
// observed. Keeping them in one object but never merging them is the point —
// `record.manifest.riskLevel` is a claim, `record.security.findings` is
// evidence, and the UI shows both. Nothing in here is derived from the payload
// except the manifest itself.
//
// The record is also the unit of persistence: `toJSON()` is what lands in the
// skills collection, `fromJSON()` is what comes back after a restart, and the
// round trip is lossless so a restart never silently re-enables a quarantined
// skill or forgets a failure streak.

const { SKILL_STATES, canTransition, transitionError, isUsable } = require('../lifecycle/states');
const { baseTrust, sourceLabel, trustRank } = require('./SkillSource');
const { manifestView } = require('../schemas/SkillManifest');

const HISTORY_LIMIT = 50;

// How many consecutive failures make a skill a liability rather than a flaky
// one. Three is the point where "unlucky" stops being the better explanation;
// SkillEvaluator quarantines at this threshold.
const FAILURE_QUARANTINE_THRESHOLD = 3;

class SkillRecord {
  constructor({
    manifest,
    state = SKILL_STATES.DISCOVERED,
    trust = null,
    security = null,
    stats = null,
    quality = null,
    contentDigest = null,
    installedAt = null,
    updatedAt = null,
    enabledAt = null,
    lastUsedAt = null,
    history = [],
    now = Date.now(),
  }) {
    if (!manifest || !manifest.id) throw new Error('a skill record requires a validated manifest');
    this.manifest = manifest;
    this.state = state;
    this.trust = Object.freeze({
      tier: (trust && trust.tier) || baseTrust(manifest.source),
      // A tier above the source's own is a human decision and carries who made
      // it. `verifiedBy: null` means nobody has, whatever the tier says.
      verifiedBy: (trust && trust.verifiedBy) || null,
      verifiedAt: (trust && trust.verifiedAt) || null,
      reason: (trust && trust.reason) || '',
    });
    this.security = Object.freeze({
      scanned: Boolean(security && security.scanned),
      scannedAt: (security && security.scannedAt) || null,
      findings: Object.freeze([...((security && security.findings) || [])]),
      sandboxRequired: security ? security.sandboxRequired !== false : true,
      blocked: Boolean(security && security.blocked),
    });
    this.stats = {
      runs: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      totalDurationMs: 0,
      lastRunAt: null,
      lastError: null,
      securityIncidents: 0,
      approvalsGranted: 0,
      approvalsDenied: 0,
      ...(stats || {}),
    };
    this.quality = quality || null;
    this.contentDigest = contentDigest;
    this.installedAt = installedAt;
    this.updatedAt = updatedAt || now;
    this.enabledAt = enabledAt;
    this.lastUsedAt = lastUsedAt;
    this.history = [...history].slice(-HISTORY_LIMIT);
  }

  get id() { return this.manifest.id; }
  get version() { return this.manifest.version; }
  get categories() { return this.manifest.categories; }
  get permissions() { return this.manifest.permissions; }
  get riskLevel() { return this.manifest.riskLevel; }
  get source() { return this.manifest.source; }
  get usable() { return isUsable(this.state) && !this.security.blocked; }

  // The only way the state changes. Returns the record so callers can chain,
  // throws on an illegal move so a caller cannot invent a path through the
  // lifecycle (see lifecycle/states.js).
  transition(to, { reason = '', actor = 'system', now = Date.now() } = {}) {
    if (this.state === to) return this;
    if (!canTransition(this.state, to)) throw new Error(`skill ${this.id}: ${transitionError(this.state, to)}`);
    this.history.push(Object.freeze({ at: now, from: this.state, to, reason, actor }));
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.state = to;
    this.updatedAt = now;
    if (to === SKILL_STATES.ENABLED && !this.enabledAt) this.enabledAt = now;
    if (to === SKILL_STATES.INSTALLED && !this.installedAt) this.installedAt = now;
    return this;
  }

  setTrust({ tier, verifiedBy = null, reason = '', now = Date.now() }) {
    this.trust = Object.freeze({ tier, verifiedBy, verifiedAt: verifiedBy ? now : null, reason });
    this.updatedAt = now;
    return this;
  }

  setSecurity({ scanned = true, findings = [], sandboxRequired = true, blocked = false, now = Date.now() }) {
    this.security = Object.freeze({
      scanned,
      scannedAt: now,
      findings: Object.freeze([...findings]),
      sandboxRequired,
      blocked,
    });
    this.updatedAt = now;
    return this;
  }

  // One completed run. `securityIncident` is separate from `ok:false` on
  // purpose: a skill that fails is unreliable, a skill that trips a security
  // control is a different problem and is counted as such.
  recordRun({ ok, durationMs = 0, error = null, securityIncident = false, now = Date.now() }) {
    this.stats.runs += 1;
    this.stats.totalDurationMs += Math.max(0, durationMs);
    this.stats.lastRunAt = now;
    if (ok) {
      this.stats.successes += 1;
      this.stats.consecutiveFailures = 0;
      this.stats.lastError = null;
    } else {
      this.stats.failures += 1;
      this.stats.consecutiveFailures += 1;
      this.stats.lastError = error ? String(error).slice(0, 500) : 'unknown failure';
    }
    if (securityIncident) this.stats.securityIncidents += 1;
    this.lastUsedAt = now;
    this.updatedAt = now;
    return this;
  }

  recordApproval({ granted, now = Date.now() }) {
    if (granted) this.stats.approvalsGranted += 1;
    else this.stats.approvalsDenied += 1;
    this.updatedAt = now;
    return this;
  }

  successRate() {
    if (this.stats.runs === 0) return null; // unknown, not zero — see SkillQualityScore
    return this.stats.successes / this.stats.runs;
  }

  averageDurationMs() {
    if (this.stats.runs === 0) return null;
    return Math.round(this.stats.totalDurationMs / this.stats.runs);
  }

  // Should this skill be stopped for safety rather than merely marked failed?
  shouldQuarantine() {
    if (this.stats.securityIncidents > 0) return { quarantine: true, reason: 'a security control was tripped during execution' };
    if (this.stats.consecutiveFailures >= FAILURE_QUARANTINE_THRESHOLD) {
      return { quarantine: true, reason: `${this.stats.consecutiveFailures} consecutive failures` };
    }
    if (this.security.blocked) return { quarantine: true, reason: 'blocked by the security scanner' };
    return { quarantine: false, reason: '' };
  }

  toJSON() {
    return {
      manifest: this.manifest,
      state: this.state,
      trust: { ...this.trust },
      security: { ...this.security, findings: [...this.security.findings] },
      stats: { ...this.stats },
      quality: this.quality ? { ...this.quality } : null,
      contentDigest: this.contentDigest,
      installedAt: this.installedAt,
      updatedAt: this.updatedAt,
      enabledAt: this.enabledAt,
      lastUsedAt: this.lastUsedAt,
      history: this.history.map((h) => ({ ...h })),
    };
  }

  // Renderer-safe: manifest as a view, observations as plain numbers, and the
  // provenance label a person actually reads.
  view() {
    return {
      ...manifestView(this.manifest),
      state: this.state,
      usable: this.usable,
      origin: sourceLabel(this.manifest.source),
      trust: { ...this.trust },
      security: {
        scanned: this.security.scanned,
        scannedAt: this.security.scannedAt,
        blocked: this.security.blocked,
        sandboxRequired: this.security.sandboxRequired,
        findingCount: this.security.findings.length,
        findings: this.security.findings.map((f) => ({ id: f.id, severity: f.severity, summary: f.summary, where: f.where || null })),
      },
      stats: {
        runs: this.stats.runs,
        successes: this.stats.successes,
        failures: this.stats.failures,
        consecutiveFailures: this.stats.consecutiveFailures,
        successRate: this.successRate(),
        averageDurationMs: this.averageDurationMs(),
        securityIncidents: this.stats.securityIncidents,
        approvalsGranted: this.stats.approvalsGranted,
        approvalsDenied: this.stats.approvalsDenied,
        lastRunAt: this.stats.lastRunAt,
        lastError: this.stats.lastError,
      },
      quality: this.quality ? { ...this.quality } : null,
      installedAt: this.installedAt,
      updatedAt: this.updatedAt,
      lastUsedAt: this.lastUsedAt,
      history: this.history.slice(-10).map((h) => ({ ...h })),
    };
  }

  static fromJSON(row) {
    if (!row || !row.manifest) return null;
    return new SkillRecord({
      manifest: Object.freeze(row.manifest),
      state: row.state,
      trust: row.trust,
      security: row.security,
      stats: row.stats,
      quality: row.quality,
      contentDigest: row.contentDigest,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
      enabledAt: row.enabledAt,
      lastUsedAt: row.lastUsedAt,
      history: row.history || [],
    });
  }
}

// Sort helper shared by the registry and the ranking pass: more trusted first.
function byTrust(a, b) {
  return trustRank(b.trust.tier) - trustRank(a.trust.tier);
}

module.exports = { SkillRecord, HISTORY_LIMIT, FAILURE_QUARANTINE_THRESHOLD, byTrust };
