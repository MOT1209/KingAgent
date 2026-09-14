// The policy engine's public surface.

const {
  POLICY_SCOPES,
  SCOPE_RANK,
  EFFECTS,
  EFFECT_RANK,
  scopeKey,
  parseScopeKey,
  isScope,
  scopeChain,
  chainLabels,
  rankOf,
  effectRank,
  mostRestrictive,
} = require('./scopes');
const {
  RULE_FIELDS,
  ACTION,
  validateRule,
  normalizeRule,
  matchesAction,
  matchingRules,
  actionForTool,
} = require('./rules');
const { evaluateChain, atLeastAsRestrictive } = require('./evaluator');
const { POLICY_SOURCES, validatePolicy, policyView, baselinePolicies } = require('./policy');
const {
  PolicyManager,
  createClosedPolicyManager,
  PolicyError,
  PolicyDeniedError,
  PolicyApprovalRequiredError,
} = require('./manager');

module.exports = {
  // scopes
  POLICY_SCOPES,
  SCOPE_RANK,
  EFFECTS,
  EFFECT_RANK,
  scopeKey,
  parseScopeKey,
  isScope,
  scopeChain,
  chainLabels,
  rankOf,
  effectRank,
  mostRestrictive,
  // rules
  RULE_FIELDS,
  ACTION,
  validateRule,
  normalizeRule,
  matchesAction,
  matchingRules,
  actionForTool,
  // evaluation
  evaluateChain,
  atLeastAsRestrictive,
  // documents
  POLICY_SOURCES,
  validatePolicy,
  policyView,
  baselinePolicies,
  // manager
  PolicyManager,
  createClosedPolicyManager,
  PolicyError,
  PolicyDeniedError,
  PolicyApprovalRequiredError,
};
