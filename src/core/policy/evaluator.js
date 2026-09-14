// The policy evaluator: pure, total, and explainable.
//
// Given the policies on a scope chain and one action, it returns exactly one
// effect. No I/O, no clock, no approval asking — the manager does those, so
// this function can be tested against every interesting combination and the
// rule it implements is short enough to state in one sentence:
//
//   The most restrictive matching effect wins; ties are broken by the most
//   specific scope, then by document order within that scope.
//
// The trail it returns is the answer to §38's "why was this allowed / blocked /
// gated on approval?", so it is part of the result, not a debugging extra.
//
// Unknown rules are treated as *not matching* rather than as denying: a rule
// with a bad effect is caught at registration (rules.validateRule), and a
// corrupt document must not be able to widen or narrow permissions silently.

const { mostRestrictive, effectRank, rankOf } = require('./scopes');
const { matchingRules } = require('./rules');

const MAX_TRAIL = 12;

function evaluateChain({ policies = [], action, defaultEffect = 'allow' } = {}) {
  if (typeof action !== 'string' || !action) {
    // Never guess an action: an unreadable request is not a request to allow.
    return decision({
      effect: 'deny',
      reason: 'policy evaluation requires an action string',
      defaultEffect,
      matched: false,
    });
  }

  const matches = [];
  for (const entry of policies) {
    const { policy, key } = entry;
    if (!policy || policy.enabled === false) continue;
    for (const rule of matchingRules(policy, action)) {
      matches.push({ rule, policy, key });
    }
  }

  if (matches.length === 0) {
    return decision({
      effect: defaultEffect,
      reason: defaultEffect === 'deny'
        ? `no policy matched ${action}; this install denies by default`
        : `no policy matched ${action}`,
      defaultEffect,
      matched: false,
      action,
    });
  }

  // Fold the ladder. `winner` tracks which match produced the effective effect
  // so the decision can name the scope and policy that decided it.
  let effect = null;
  let winner = null;
  for (const m of matches) {
    const next = mostRestrictive(effect, m.rule.effect);
    if (next !== effect) {
      effect = next;
      winner = m;
      continue;
    }
    // The effect did not change. Attribution moves only to a rule that is
    // *equally* restrictive — a weaker rule that merely matched alongside the
    // winner must never be named as the decider, or a narrow `allow` would take
    // credit for a broad `deny`. Among equals the more specific scope wins, and
    // within a scope the later rule does (document order).
    if (m.rule.effect !== effect) continue;
    if (winner && rankOf(scopeOf(m).scope) >= rankOf(scopeOf(winner).scope)) winner = m;
  }

  const constraints = mergeConstraints(matches, effect);

  return decision({
    effect,
    reason: winner && winner.rule.reason ? winner.rule.reason : defaultReason(effect, action),
    defaultEffect,
    matched: true,
    action,
    winner,
    constraints,
    trail: matches.slice(0, MAX_TRAIL).map((m) => ({
      scope: scopeOf(m).scope,
      scopeId: scopeOf(m).scopeId,
      policyId: m.policy.id,
      ruleId: m.rule.id,
      pattern: m.rule.action,
      effect: m.rule.effect,
      reason: m.rule.reason || '',
    })),
    matchedCount: matches.length,
  });
}

// The normalized §16 result. Every field is always present: an ambiguous
// permission result is the failure mode this shape exists to prevent.
function decision({ effect, reason, defaultEffect, matched, action = null, winner = null, constraints = null, trail = [], matchedCount = 0 }) {
  const win = winner ? scopeOf(winner) : null;
  return Object.freeze({
    allowed: effect !== 'deny',
    requiresApproval: effect === 'approval',
    effect,
    reason,
    policyId: winner ? winner.policy.id : null,
    scope: win ? win.scope : null,
    scopeId: win ? win.scopeId : null,
    ruleId: winner ? winner.rule.id : null,
    constraints,
    matched,
    matchedCount,
    action,
    defaultEffect,
    trail: Object.freeze(trail),
  });
}

function defaultReason(effect, action) {
  if (effect === 'deny') return `${action} is denied by policy`;
  if (effect === 'approval') return `${action} requires approval`;
  return `${action} is allowed by policy`;
}

// Constraints accumulate across every matching *allow* rule so the caller gets
// the union of what each grant permits. A deny contributes none: nothing is
// executable about a denial.
function mergeConstraints(matches, effect) {
  if (effect === 'deny') return null;
  const out = {};
  for (const m of matches) {
    if (m.rule.effect === 'deny' || !m.rule.constraints) continue;
    for (const [k, v] of Object.entries(m.rule.constraints)) {
      if (Array.isArray(v)) {
        out[k] = Array.isArray(out[k]) ? [...new Set([...out[k], ...v])] : [...v];
      } else if (out[k] === undefined) {
        // First writer wins for scalars, i.e. the broadest scope that granted
        // it. A narrower policy that wanted a different ceiling would have said
        // `deny` instead of quietly granting a looser one.
        out[k] = v;
      }
    }
  }
  return Object.keys(out).length ? Object.freeze(out) : null;
}

function scopeOf(match) {
  const idx = String(match.key).indexOf(':');
  const scope = String(match.key).slice(0, idx);
  const id = String(match.key).slice(idx + 1);
  return { scope, scopeId: id === '*' ? null : id };
}

// Is this effect at least as restrictive as that one? Used by tests and by the
// manager when it composes policy with approval.
function atLeastAsRestrictive(a, b) {
  return effectRank(a) >= effectRank(b);
}

module.exports = { evaluateChain, decision, mergeConstraints, atLeastAsRestrictive, MAX_TRAIL };
