// Policy rules: the unit a policy is made of, and the matcher that selects them.
//
// A rule is inert data — `{ id, action, effect, reason, constraints }` — and the
// matcher is a hand-written segment walker, not a RegExp built from user input.
// That is deliberate: a policy document is the one input an attacker would most
// like to turn into a regex, and `new RegExp(pattern)` on a policy string is a
// denial-of-service waiting to happen. The DSL is small enough to enumerate:
//
//   '*'      one segment           'git.*'      matches git.push, git.status
//   '**'     this and everything after    'filesystem.**'  matches filesystem.read.deep
//   exact    literal comparison    'filesystem.delete'
//
// Actions are dot-separated lowercase-ish strings: `filesystem.read`,
// `git.push`, `tool.call.fs:read`, `sandbox.create`, `credential.ANTHROPIC_API_KEY`.

const { isPlainObject, isString, nonEmptyString, fail } = require('../schema/validate');
const { EFFECTS } = require('./scopes');

const RULE_FIELDS = ['id', 'action', 'effect', 'reason', 'constraints', 'description'];

function validateRule(rule) {
  if (!isPlainObject(rule)) return fail(['policy rule must be an object']);
  if (!nonEmptyString(rule.action)) return fail(['policy rule requires an action pattern']);
  if (!isString(rule.action) || /[\s]/.test(rule.action)) return fail([`invalid action pattern: ${JSON.stringify(rule.action)}`]);
  if (!EFFECTS.includes(rule.effect)) {
    return fail([`policy rule effect must be one of ${EFFECTS.join(', ')} (got ${JSON.stringify(rule.effect)})`]);
  }
  if (rule.constraints !== undefined && !isPlainObject(rule.constraints)) {
    return fail(['policy rule constraints must be an object']);
  }
  return { ok: true, rule: normalizeRule(rule) };
}

function normalizeRule(rule) {
  const out = {};
  for (const key of RULE_FIELDS) {
    if (rule[key] !== undefined) out[key] = rule[key];
  }
  out.id = out.id || `rule-${out.action}-${out.effect}`;
  out.reason = out.reason || '';
  out.constraints = isPlainObject(out.constraints) ? freezeConstraints(out.constraints) : null;
  out.description = out.description || '';
  return Object.freeze(out);
}

// Constraints are what the caller may do once allowed — a timeout ceiling, a
// path allowlist, a model list. They are *data handed to the caller*, never an
// instruction to the policy engine, so only primitive shapes survive.
function freezeConstraints(constraints) {
  const out = {};
  for (const [k, v] of Object.entries(constraints)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) out[k] = [...v];
  }
  return Object.freeze(out);
}

// Does a rule's action pattern cover this action?
function matchesAction(pattern, action) {
  if (!isString(pattern) || !isString(action)) return false;
  if (pattern === '**') return true;
  const p = pattern.split('.');
  const a = action.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**') return true; // matches this segment and everything after
    if (i >= a.length) return false;
    if (p[i] === '*') continue; // one segment, any value
    if (p[i] !== a[i]) return false;
  }
  return p.length === a.length;
}

// Select the rules of a policy that apply to an action, keeping their document
// order (a policy is read top-to-bottom, like a firewall).
function matchingRules(policy, action) {
  if (!policy || !Array.isArray(policy.rules)) return [];
  return policy.rules.filter((rule) => matchesAction(rule.action, action));
}

// Which action string does a tool call carry?
//
// Tools may declare their own `policyAction` (so `git:push` can present as
// `git.push` and match the examples in §15), otherwise the call presents as
// `tool.call.<id>`. A tool can name its action but can never *grant* one — the
// policy engine still decides.
function actionForTool(tool) {
  if (!tool) return 'tool.call';
  const declared = tool.policyAction || (tool.permissions && tool.permissions.policyAction);
  return isString(declared) && declared ? declared : `tool.call.${tool.id}`;
}

const ACTION = Object.freeze({
  TOOL_CALL: 'tool.call',
  HARNESS_SELECT: 'harness.select',
  HARNESS_START: 'harness.start',
  SANDBOX_CREATE: 'sandbox.create',
  SANDBOX_EXEC: 'sandbox.exec',
  AGENT_DELEGATE: 'agent.delegate',
  AGENT_HANDOFF: 'agent.handoff',
  WORKSPACE_READ: 'filesystem.read',
  WORKSPACE_WRITE: 'filesystem.write',
  WORKSPACE_DELETE: 'filesystem.delete',
  NETWORK: 'network.request',
  CREDENTIAL: 'credential',
  SESSION_CREATE: 'session.create',
});

module.exports = {
  RULE_FIELDS,
  validateRule,
  normalizeRule,
  matchesAction,
  matchingRules,
  actionForTool,
  freezeConstraints,
  ACTION,
};
