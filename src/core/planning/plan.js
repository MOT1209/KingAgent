// The plan model: a sequence of steps the executor will walk.
//
// A plan is a list of steps plus metadata. Steps are either sequential,
// parallel or conditionally skipped depending on a prior outcome. The planner
// builds plans; the executor walks them; the runtime records them.

const { isPlainObject, validId, fail } = require('../schema/validate');

const DEFAULT_SETTINGS = {
  maxSteps: 100,
  timeoutMs: 10 * 60 * 1000, // 10 minutes per plan
};

function createPlan({ id, objective, mode = 'structured', steps = [], settings = {} } = {}) {
  if (!id) throw new Error('plan requires an id');
  if (!objective || typeof objective !== 'string') throw new Error('plan requires an objective');
  const plan = {
    id,
    objective,
    mode, // 'simple' | 'structured' | 'autonomous'
    steps: steps.map(createStep),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    createdAt: Date.now(),
  };
  const validation = validatePlan(plan);
  if (!validation.ok) throw new Error(`invalid plan: ${validation.errors.join('; ')}`);
  return plan;
}

function createStep({
  id,
  title,
  action,
  capability, // required capability this step satisfies
  tool, // { id, input? } — concrete tool selection
  dependsOn = [],
  retry = { maxAttempts: 2, backoffMs: 300 },
  verify, // { type: 'output', pattern: /regex/ } | null
  parallel = false,
  mode = 'sequential', // 'sequential' | 'parallel' — controls fan-out in the executor
  timeoutMs,
}) {
  if (!id) throw new Error('step requires an id');
  if (!title) throw new Error(`step ${id} requires a title`);
  if (typeof action !== 'function' && !tool) throw new Error(`step ${id} requires a tool or an action function`);
  return {
    id,
    title,
    action: typeof action === 'function' ? action : null,
    tool: isPlainObject(tool) ? tool : null,
    capability: capability || null,
    dependsOn: [...dependsOn],
    retry: { maxAttempts: 2, backoffMs: 300, ...retry },
    verify: isPlainObject(verify) ? verify : null,
    parallel,
    mode,
    timeoutMs: timeoutMs || null,
    status: 'pending',
    attempts: 0,
    output: null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

function validatePlan(plan) {
  const errors = [];
  if (!Array.isArray(plan.steps)) { errors.push('steps must be an array'); return fail(errors); }
  if (plan.steps.length === 0) { errors.push('plan must have at least one step'); return fail(errors); }
  const ids = new Set();
  for (const s of plan.steps) {
    if (!s || typeof s !== 'object') { errors.push('steps must be objects'); continue; }
    if (!s.id) errors.push('step is missing an id');
    if (ids.has(s.id)) errors.push(`duplicate step id: ${s.id}`);
    ids.add(s.id);
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    for (const dep of deps) {
      if (!ids.has(dep)) errors.push(`step ${s.id} depends on unknown step ${dep}`);
    }
  }
  return errors.length ? fail(errors) : { ok: true, errors: [] };
}

module.exports = { createPlan, createStep, validatePlan, DEFAULT_SETTINGS };