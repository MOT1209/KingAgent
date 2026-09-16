// The Researcher: the thin role object that drives the engine for one question.
//
// Kept separate from the engine because §21 describes a *role*, not a second
// pipeline: the researcher decides whether to research at all, picks the depth,
// runs the engine, and hands back a result. Every actual capability —
// retrieval, evidence, citations — belongs to the engine, so this file is
// deliberately short. A researcher that reimplemented any of it would be the
// duplicate architecture §51 forbids.

const { ROUTE } = require('../router/researchRouter');
const { RESEARCH_MODES } = require('../schemas/researchTask');

class Researcher {
  constructor({ engine, logger = null } = {}) {
    if (!engine) throw new TypeError('Researcher requires a ResearchEngine');
    this._engine = engine;
    this._logger = logger;
  }

  // Answer a question. Returns `{ route, result }` — `result` is null when the
  // route was `none` (nothing to research) or `memory` (already known), and the
  // caller is told which, because "I did not research this" and "I researched
  // this and found nothing" are different answers.
  async answer(question, {
    identity = {}, mode = null, files = [], filesOnly = false, allowWeb = true,
    allowedDomains = [], excludedDomains = [], sourcePreferences = [],
    workspace = null, memoryPolicy = null, signal = null, limits = {},
  } = {}) {
    const routing = await this._engine.route(question, {
      task: { filesOnly, files },
      memoryPolicy,
    });

    if (routing.route === ROUTE.NONE) {
      return { route: routing.route, reason: routing.reason, classification: routing.classification, result: null };
    }
    if (routing.route === ROUTE.MEMORY) {
      return {
        route: routing.route, reason: routing.reason, classification: routing.classification,
        memory: routing.memory, result: null,
      };
    }

    const task = this._engine.create({
      question,
      mode: mode || (routing.route === ROUTE.DIRECT ? RESEARCH_MODES.QUICK : routing.classification.suggestedMode),
      files, filesOnly, allowWeb, allowedDomains, excludedDomains, sourcePreferences,
      ...identity, ...limits,
    });

    const result = await this._engine.run(task, { workspace, memoryPolicy, signal });
    return { route: routing.route, reason: routing.reason, classification: routing.classification, result, taskId: task.id };
  }

  cancel(taskId, reason) {
    return this._engine.cancel(taskId, reason);
  }
}

module.exports = { Researcher };
