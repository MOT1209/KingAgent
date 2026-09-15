// SkillTrust: what provenance and evidence say about a skill, and what that
// implies for how carefully it is run.
//
// Two ideas kept strictly apart:
//
//   trust — where the bytes came from and who vouched for them. Raised only by
//           a person (`verify`), never by the skill, never by usage statistics.
//           A skill that has run 500 times successfully from an unpinned GitHub
//           branch is still untrusted: it can change tomorrow.
//   risk  — what the skill is allowed to reach for. Derived from its declared
//           permissions and corrected upward, never downward.
//
// Those two, crossed, produce the posture: sandbox or not, approval or not.
// Expressing it as a table rather than a chain of ifs is deliberate — this is
// the matrix a security reviewer reads, and it should be readable in one pass.

const { trustRank, baseTrust, isRemote } = require('../registry/SkillSource');
const { riskRank } = require('../schemas/SkillPermissionSchema');
const { highestSeverity } = require('./SkillScanner');

// posture[trust][risk] -> { sandbox, approval }
//
//   sandbox  — execution must be confined (SkillSandbox turns this into a real
//              sandbox through the existing SandboxManager)
//   approval — a person must say yes before the skill runs, every time
//
// Read the top-left corner as the claim it is: a built-in, low-risk skill runs
// without a prompt. Everything else costs something, and remote + high-risk
// costs both.
const POSTURE = Object.freeze({
  builtin: {
    low: { sandbox: false, approval: false },
    medium: { sandbox: false, approval: false },
    high: { sandbox: true, approval: false },
    critical: { sandbox: true, approval: true },
  },
  workspace: {
    low: { sandbox: false, approval: false },
    medium: { sandbox: true, approval: false },
    high: { sandbox: true, approval: true },
    critical: { sandbox: true, approval: true },
  },
  community: {
    low: { sandbox: true, approval: false },
    medium: { sandbox: true, approval: true },
    high: { sandbox: true, approval: true },
    critical: { sandbox: true, approval: true },
  },
  untrusted: {
    low: { sandbox: true, approval: true },
    medium: { sandbox: true, approval: true },
    high: { sandbox: true, approval: true },
    critical: { sandbox: true, approval: true },
  },
});

// The posture for a record, plus why. A scanner finding tightens it: a `warn`
// forces approval even where the table would not, because the whole point of a
// warning is that a person should look.
function postureFor(record, { findings = null } = {}) {
  const tier = (record.trust && record.trust.tier) || baseTrust(record.manifest.source);
  const risk = record.manifest.riskLevel;
  const base = (POSTURE[tier] && POSTURE[tier][risk]) || { sandbox: true, approval: true };
  const reasons = [`trust=${tier}`, `risk=${risk}`];
  let { sandbox, approval } = base;

  const worst = highestSeverity(findings || (record.security && record.security.findings) || []);
  if (worst === 'critical') {
    sandbox = true;
    approval = true;
    reasons.push('the scanner reported a critical finding');
  } else if (worst === 'warn') {
    approval = true;
    reasons.push('the scanner reported a warning a person should read');
  }
  if (record.stats && record.stats.securityIncidents > 0) {
    sandbox = true;
    approval = true;
    reasons.push(`${record.stats.securityIncidents} previous security incident(s)`);
  }
  if (record.manifest.riskRaised) {
    reasons.push(`declared risk ${record.manifest.declaredRiskLevel} was raised to ${risk} by its permissions`);
  }
  return { tier, risk, sandbox, approval, reasons };
}

// Raise a skill's trust. Requires a named human actor — there is no API that
// lets the platform, a policy document or a skill promote itself, which is the
// same no-self-grant rule the policy engine already enforces.
function verify(record, { tier, actor, reason = '', now = Date.now() } = {}) {
  if (!actor || typeof actor !== 'string') {
    throw new Error('raising a skill\'s trust requires a named actor — trust is a human decision');
  }
  if (trustRank(tier) < 0) throw new Error(`unknown trust tier: ${JSON.stringify(tier)}`);
  const ceiling = ceilingFor(record.manifest.source);
  if (trustRank(tier) > trustRank(ceiling)) {
    throw new Error(
      `a ${record.manifest.source.type} skill cannot be trusted above "${ceiling}"` +
      (isRemote(record.manifest.source) && !record.manifest.source.digest
        ? ' — pin it to an immutable ref (a commit sha or a published digest) first'
        : ''),
    );
  }
  record.setTrust({ tier, verifiedBy: actor, reason, now });
  return record;
}

// The highest tier a source can ever reach. A remote source tops out at
// `community` no matter who vouches for it: "a person reviewed this once" and
// "this is part of the product" are different guarantees and the UI must not
// blur them.
function ceilingFor(source) {
  switch (source && source.type) {
    case 'builtin': return 'builtin';
    case 'local': return 'workspace';
    case 'github':
    case 'skills.sh': return 'community';
    default: return 'untrusted';
  }
}

// Revoking is always allowed, from anyone, with no ceiling: lowering trust must
// never be harder than raising it.
function revoke(record, { reason = 'trust revoked', actor = 'system', now = Date.now() } = {}) {
  record.setTrust({ tier: 'untrusted', verifiedBy: null, reason: `${reason} (by ${actor})`, now });
  return record;
}

// A one-line answer for the UI and the CLI's `skills info`.
function explain(record) {
  const posture = postureFor(record);
  const parts = [
    `${record.id}@${record.version} is ${posture.tier}`,
    record.trust.verifiedBy ? `verified by ${record.trust.verifiedBy}` : 'not verified by anyone',
    `risk ${posture.risk}`,
    posture.sandbox ? 'runs sandboxed' : 'runs unsandboxed',
    posture.approval ? 'needs approval each run' : 'runs without a prompt',
  ];
  return { summary: parts.join('; '), ...posture };
}

function riskAtLeast(record, level) {
  return riskRank(record.manifest.riskLevel) >= riskRank(level);
}

module.exports = { POSTURE, postureFor, verify, revoke, ceilingFor, explain, riskAtLeast };
