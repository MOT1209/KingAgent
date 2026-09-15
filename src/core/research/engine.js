// The ResearchEngine: §1's pipeline, wired to the platform KingAgent already
// has.
//
// Everything this file does is composition. It owns no storage, no policy
// evaluation, no approval flow and no artifact format of its own — those come
// from the platform's ApprovalManager, PolicyManager, MemoryManager,
// ExecutionTraceStore and ArtifactManager, injected here. What it does own is
// the *order*, the state machine, the budget, cancellation, and the rule that
// nothing is returned that has not passed citation validation.
//
// The stage methods are public (§43) so a caller can drive the pipeline by
// hand — plan without searching, re-verify without re-planning — which is what
// makes the whole thing testable a stage at a time. `run()` is the normal path.

const { EventEmitter } = require('node:events');

const { newId } = require('../workspace/identity');

const {
  createResearchTask, validateResearchTask, transition, spend, recordFailure,
  researchTaskView, RESEARCH_STATUS, RESEARCH_MODES, expired, isPartial,
} = require('./schemas/researchTask');
const { sourceView } = require('./schemas/source');
const { queryView } = require('./schemas/researchQuery');
const { evidenceView } = require('./schemas/evidence');
const { claimView } = require('./schemas/claim');
const { citationView } = require('./schemas/citation');

const { ResearchPlanner } = require('./planner/researchPlanner');
const { routeRequest, ROUTE } = require('./router/researchRouter');
const searchRouter = require('./router/searchRouter');
const { ParallelRetriever } = require('./retrieval/parallelRetriever');
const { normalizeResults } = require('./retrieval/resultNormalizer');
const { deduplicate } = require('./retrieval/deduplicator');
const { rerank } = require('./retrieval/reranker');
const { scoreSources } = require('./quality/sourceQuality');
const { EvidenceStore } = require('./evidence/evidenceStore');
const { EvidenceExtractor } = require('./evidence/evidenceExtractor');
const { rankEvidence } = require('./evidence/evidenceRanker');
const { extractClaims, linkEvidenceToClaims, analyzeAll } = require('./evidence/claimAnalyzer');
const { detect, resolveAll } = require('./evidence/conflictDetector');
const { SourceVerifier } = require('./evidence/sourceVerifier');
const { CitationEngine } = require('./citations/citationEngine');
const { evaluate: evaluateQuality, gapsFrom } = require('./quality/researchEvaluator');
const { Synthesizer } = require('./agents/synthesizer');
const { Reviewer, VERDICT } = require('./agents/reviewer');
const { extractSubjects } = require('./planner/queryPlanner');
const { RESEARCH_EVENTS } = require('./traceEvents');
const { RESEARCH_ACTION } = require('./policies/researchPolicy');
const {
  ResearchCancelledError, ResearchBudgetError, ResearchValidationError, ResearchDeniedError,
} = require('./errors/researchErrors');

// How many extra rounds a reviewer may ask for. Bounded, because "research
// until the reviewer is happy" is an unbounded spend and the reviewer is not
// the one paying (§30).
const MAX_ROUNDS = 3;

class ResearchEngine extends EventEmitter {
  constructor({
    sourceManager,
    provider = null,
    policy = null,
    memory = null,          // ResearchMemory
    traces = null,          // ExecutionTraceStore
    artifacts = null,       // ArtifactManager
    bus = null,
    logger = null,
    config = {},
  } = {}) {
    super();
    if (!sourceManager) throw new TypeError('ResearchEngine requires a SourceManager');
    this._sources = sourceManager;
    this._provider = provider;
    this._policy = policy;
    this._memory = memory;
    this._traces = traces;
    this._artifacts = artifacts;
    this._bus = bus;
    this._logger = logger;
    this._config = { maxRounds: MAX_ROUNDS, ...config };

    this._planner = new ResearchPlanner({ provider, logger });
    this._extractor = new EvidenceExtractor({ provider, logger });
    this._synthesizer = new Synthesizer({ provider, logger });
    this._reviewer = new Reviewer({ provider, logger });

    // One live record per task: the task, its store, its controller. This is
    // what makes `cancel()` and `get()` work without a database.
    this._live = new Map();
  }

  // --- lifecycle ------------------------------------------------------------

  // Create a task. Does not start it — `run` does — so a caller can inspect or
  // adjust before spending anything.
  create(input = {}) {
    const { ok, task, errors } = validateResearchTask(input);
    if (!ok) throw new ResearchValidationError(`invalid research task: ${errors.join('; ')}`);
    // Which limits the caller set explicitly, so a mode change from the
    // classifier cannot silently overwrite them.
    task.modeExplicit = Boolean(input.mode);
    task.explicitLimits = pickExplicit(input);

    const ctx = {
      task,
      store: new EvidenceStore(),
      controller: new AbortController(),
      trace: null,
      rounds: 0,
      cancelled: false,
    };
    // Built after `ctx` exists, because the emit shim closes over it. Replaced
    // on each synthesis pass so a replan never carries ordinals from claims
    // that no longer exist.
    ctx.citations = new CitationEngine({ store: ctx.store, logger: this._logger, emit: (e) => this._emit(ctx, e) });
    ctx.verifier = new SourceVerifier({
      sourceManager: this._sources,
      extractor: this._extractor,
      logger: this._logger,
      emit: (e) => this._emit(ctx, e),
    });
    ctx.retriever = new ParallelRetriever({
      sourceManager: this._sources,
      router: searchRouter,
      logger: this._logger,
      emit: (e) => this._emit(ctx, e),
    });
    this._live.set(task.id, ctx);
    return task;
  }

  // Should this request be researched at all, and how (§2)? Exposed so an agent
  // can ask before creating a task.
  async route(request, { task = null, memoryPolicy = null } = {}) {
    const lookup = this._memory && this._memory.available && memoryPolicy
      ? ({ question, classification }) => this._memory.findAnswer({ question, classification, policy: memoryPolicy })
      : null;
    return routeRequest({ request, task, lookupMemory: lookup });
  }

  get(taskId) {
    const ctx = this._live.get(taskId);
    return ctx ? ctx.task : null;
  }

  list() {
    return [...this._live.values()].map((c) => researchTaskView(c.task));
  }

  // Cancellation (§47): abort the signal every provider call is holding, mark
  // the task, and let the pipeline unwind. Nothing is left running.
  cancel(taskId, reason = 'cancelled by user') {
    const ctx = this._live.get(taskId);
    if (!ctx) return false;
    ctx.cancelled = true;
    ctx.controller.abort();
    if (!['completed', 'failed', 'cancelled'].includes(ctx.task.status)) {
      try { transition(ctx.task, RESEARCH_STATUS.CANCELLED, reason); } catch { /* already terminal */ }
    }
    this._emit(ctx, { type: RESEARCH_EVENTS.RESEARCH_CANCELLED, payload: { taskId, reason } });
    return true;
  }

  dispose(taskId) {
    const ctx = this._live.get(taskId);
    if (ctx && ctx.trace && this._traces) this._traces.completeTrace?.(ctx.trace.traceId);
    return this._live.delete(taskId);
  }

  // --- the pipeline ---------------------------------------------------------

  // The normal path. Every stage is also callable on its own (§43).
  async run(input, { workspace = null, memoryPolicy = null, signal = null } = {}) {
    const task = input && input.id && this._live.has(input.id) ? input : this.create(input);
    const ctx = this._live.get(task.id);
    if (signal) signal.addEventListener('abort', () => this.cancel(task.id, 'caller aborted'), { once: true });

    ctx.trace = this._startTrace(ctx);
    this._emit(ctx, {
      type: RESEARCH_EVENTS.RESEARCH_STARTED,
      payload: { taskId: task.id, question: task.question, mode: task.mode },
    });

    try {
      await this._gate(ctx, RESEARCH_ACTION.START);

      await this.plan(task);
      if (task.queries.length === 0 && task.classification && !task.classification.needsResearch) {
        return this._finish(ctx, { workspace, memoryPolicy, reason: 'this request did not require research' });
      }

      await this.search(task);
      await this.analyze(task);
      if (task.settings.requireVerification || task.requireVerification) await this.verify(task);
      await this.synthesize(task);
      await this.evaluate(task);

      // §39's loop: another round when the work is not good enough yet, up to a
      // bounded number of rounds and always within the same budget.
      //
      // Two triggers, because only deep mode runs a reviewer. With no reviewer
      // the evaluator's own gaps drive the retry — otherwise standard-mode
      // research would notice its quality was weak and do nothing about it.
      while (ctx.rounds < this._config.maxRounds && !ctx.cancelled) {
        const strategy = task.plan.strategy;

        if (!strategy.stages.review) {
          if (task.quality.passed && task.quality.targetsMet) break;
          const gaps = gapsFrom(task.quality, { claims: task.claims, strategy });
          if (gaps.length === 0 || !this._hasBudgetForAnotherRound(task)) break;
          ctx.rounds += 1;
          await this.replan(task, gaps);
          await this.analyze(task);
          await this.synthesize(task);
          await this.evaluate(task);
          continue;
        }

        const review = await this._review(ctx);
        task.review = review;
        if (review.verdict !== VERDICT.NEEDS_MORE_RESEARCH) break;
        if (!this._hasBudgetForAnotherRound(task)) {
          recordFailure(task, { stage: 'review', reason: 'the reviewer asked for more research but the budget is spent' });
          break;
        }
        ctx.rounds += 1;
        await this.replan(task, review.gaps);
        await this.analyze(task);
        await this.synthesize(task);
        await this.evaluate(task);
      }

      return this._finish(ctx, { workspace, memoryPolicy });
    } catch (err) {
      return this._fail(ctx, err, { workspace });
    }
  }

  // 1. plan ------------------------------------------------------------------
  async plan(task) {
    const ctx = this._require(task);
    this._checkpoint(ctx);
    transition(task, RESEARCH_STATUS.PLANNING, 'planning research');
    await this._gate(ctx, RESEARCH_ACTION.PLAN);

    const available = this._sources.allowedTypes(task);
    const { plan, queries } = await this._planner.plan({
      task, capabilities: this._sources.capabilities(), available, signal: ctx.controller.signal,
    });
    task.plan = plan;
    task.classification = plan.classification;
    task.queries.push(...queries);

    this._emit(ctx, {
      type: RESEARCH_EVENTS.RESEARCH_CLASSIFIED,
      payload: {
        category: plan.classification.category,
        mode: plan.strategy.mode,
        sourceTypes: [...plan.strategy.sourceTypes],
        unavailable: [...plan.strategy.unavailableSourceTypes],
        degraded: plan.strategy.degraded,
      },
    });
    this._emit(ctx, {
      type: RESEARCH_EVENTS.QUERY_PLANNED,
      payload: { planId: plan.id, count: queries.length, queries: queries.map((q) => q.text) },
    });
    return plan;
  }

  // 2. search + retrieve -----------------------------------------------------
  async search(task) {
    const ctx = this._require(task);
    this._checkpoint(ctx);
    transition(task, RESEARCH_STATUS.SEARCHING, 'searching');

    const pending = task.queries.filter((q) => q.status === 'planned');
    const { results, stopped } = await ctx.retriever.retrieveAll({
      task, queries: pending, strategy: task.plan.strategy, signal: ctx.controller.signal,
    });
    if (stopped) transitionSafe(task, RESEARCH_STATUS.RETRIEVING, `retrieval stopped: ${stopped}`);
    else transitionSafe(task, RESEARCH_STATUS.RETRIEVING, 'normalizing results');

    return this.retrieve(task, results);
  }

  // 3. normalize, dedup, score, rerank ---------------------------------------
  async retrieve(task, rawResults) {
    const ctx = this._require(task);
    this._checkpoint(ctx);

    const { sources: merged, dropped } = normalizeResults(rawResults);
    const subjects = extractSubjects(task.question);

    // Scored before dedup so the cluster's canonical member is chosen with
    // quality in hand, not just by content length.
    const scored = scoreSources(merged, {
      subjects,
      freshness: task.plan.strategy.freshness,
      relevance: null,
    });

    const { kept, clusters, removed, clusterOf } = deduplicate(scored);
    ctx.store.addSources(scored).setClusters({ clusterOf, clusters });

    this._emit(ctx, {
      type: RESEARCH_EVENTS.SOURCE_DEDUPLICATED,
      payload: { before: merged.length, after: kept.length, removed: removed.length, unusable: dropped.length },
    });

    let ordered = kept;
    if (task.plan.strategy.stages.rerank) {
      const ranked = rerank(kept, {
        query: task.question,
        freshness: task.plan.strategy.freshness,
        clusterSizes: new Map(clusters.map((c) => [c.canonicalId, c.size])),
        authorityOf: (s) => s.authorityScore,
        qualityOf: (s) => s.qualityScore,
      });
      ordered = ranked.map((r) => r.source);
      this._emit(ctx, {
        type: RESEARCH_EVENTS.SOURCES_RERANKED,
        payload: { count: ordered.length, top: ranked.slice(0, 5).map((r) => ({ title: r.source.title, score: Number(r.score.toFixed(3)) })) },
      });
    }

    task.sources = ordered;
    return ordered;
  }

  // 4. evidence, claims, conflicts -------------------------------------------
  async analyze(task) {
    const ctx = this._require(task);
    this._checkpoint(ctx);
    transitionSafe(task, RESEARCH_STATUS.ANALYZING, 'extracting evidence');

    const extracted = this._extractor.extractAll({
      sources: task.sources,
      question: task.question,
      onError: (e) => recordFailure(task, { stage: 'extract', sourceId: e.sourceId, reason: e.reason, code: e.code }),
    });
    const ranked = rankEvidence(extracted, {
      store: ctx.store, question: task.question, sourceScoreOf: (s) => s.qualityScore,
    });
    // addEvidence refuses evidence whose source was never retrieved, which is
    // the invariant the citation chain rests on.
    ctx.store.addAllEvidence(ranked);
    task.evidence = ctx.store.allEvidence();
    this._emit(ctx, { type: RESEARCH_EVENTS.EVIDENCE_EXTRACTED, payload: { count: ranked.length, sources: task.sources.length } });

    if (ctx.store.claims().length === 0) {
      const claims = extractClaims({ question: task.question, evidence: task.evidence, store: ctx.store });
      for (const c of claims) {
        this._emit(ctx, { type: RESEARCH_EVENTS.CLAIM_CREATED, payload: { claimId: c.id, text: c.text, material: c.material } });
      }
    }
    linkEvidenceToClaims({
      claims: ctx.store.claims(), evidence: task.evidence, store: ctx.store,
    });

    let conflicts = [];
    if (task.plan.strategy.stages.detectConflicts) {
      conflicts = detect({ store: ctx.store, claims: ctx.store.claims() });
      for (const k of conflicts) {
        this._emit(ctx, {
          type: RESEARCH_EVENTS.CONFLICT_DETECTED,
          payload: { conflictId: k.id, claimId: k.claimId, severity: k.severity, sources: k.sourceIds.length },
        });
      }
      conflicts = resolveAll(conflicts, { store: ctx.store });
      for (const k of conflicts) {
        this._emit(ctx, {
          type: RESEARCH_EVENTS.CONFLICT_RESOLVED,
          payload: { conflictId: k.id, resolution: k.resolution, reason: k.resolutionReason },
        });
      }
    }
    task.conflicts = conflicts;
    task.claims = analyzeAll({ store: ctx.store, conflicts });
    return task.claims;
  }

  // 5. verify ----------------------------------------------------------------
  async verify(task) {
    const ctx = this._require(task);
    this._checkpoint(ctx);
    if (!task.plan.strategy.stages.verify) return null;
    transitionSafe(task, RESEARCH_STATUS.VERIFYING, 'cross-checking claims');

    const report = await ctx.verifier.verify({
      task, claims: task.claims, store: ctx.store, strategy: task.plan.strategy,
      conflicts: task.conflicts, signal: ctx.controller.signal,
      maxClaims: task.plan.strategy.stages.crossVerify ? 5 : 2,
    });
    task.verification = report;

    // New evidence may have created new conflicts, and a conflict found only
    // during verification is exactly the kind worth reporting.
    if (task.plan.strategy.stages.detectConflicts) {
      const fresh = resolveAll(detect({ store: ctx.store, claims: ctx.store.claims() }), { store: ctx.store });
      task.conflicts = fresh;
    }
    task.claims = analyzeAll({ store: ctx.store, conflicts: task.conflicts });
    task.sources = dedupeById([...task.sources, ...ctx.store.sources()]);
    task.evidence = ctx.store.allEvidence();
    return report;
  }

  // 6. cite + synthesize -----------------------------------------------------
  async synthesize(task) {
    const ctx = this._require(task);
    this._checkpoint(ctx);
    transitionSafe(task, RESEARCH_STATUS.SYNTHESIZING, 'writing the answer');

    // A fresh citation engine per synthesis pass, so a replan does not leave
    // ordinals from claims that no longer exist.
    ctx.citations = new CitationEngine({ store: ctx.store, logger: this._logger, emit: (e) => this._emit(ctx, e) });
    const citations = ctx.citations.citeAll(task.claims);
    task.citations = citations;

    const answer = this._synthesizer.build({
      task,
      claims: task.claims,
      citations,
      conflicts: task.conflicts,
      quality: task.quality,
      bibliography: ctx.citations.bibliography(),
    });
    answer.markdown = this._synthesizer.render(answer);

    const prose = await this._synthesizer.write(answer, { citations, signal: ctx.controller.signal });
    if (prose) answer.prose = prose;

    task.answer = answer;
    return answer;
  }

  // 7. evaluate --------------------------------------------------------------
  async evaluate(task) {
    const ctx = this._require(task);
    this._checkpoint(ctx);
    transitionSafe(task, RESEARCH_STATUS.EVALUATING, 'checking quality');

    const quality = evaluateQuality({
      task, store: ctx.store, claims: task.claims, citations: task.citations,
      conflicts: task.conflicts, strategy: task.plan.strategy,
    });
    task.quality = quality;

    this._emit(ctx, {
      type: RESEARCH_EVENTS.CITATIONS_VALIDATED,
      payload: {
        ok: quality.detail.validation.ok,
        errors: quality.detail.validation.errors,
        warnings: quality.detail.validation.warnings,
        citedMaterialClaims: quality.citationCompleteness,
      },
    });
    this._emit(ctx, {
      type: RESEARCH_EVENTS.RESEARCH_EVALUATED,
      payload: {
        score: quality.score, grade: quality.grade, passed: quality.passed,
        targetsMet: quality.targetsMet, reasons: quality.reasons.slice(0, 6),
      },
    });

    // The answer's caveats are rebuilt now that quality exists; `synthesize`
    // ran before evaluation and could only guess at them.
    if (task.answer) {
      task.answer = this._synthesizer.build({
        task, claims: task.claims, citations: task.citations, conflicts: task.conflicts,
        quality, bibliography: ctx.citations.bibliography(),
      });
      task.answer.markdown = this._synthesizer.render(task.answer);
    }
    return quality;
  }

  // 8. replan ----------------------------------------------------------------
  async replan(task, gaps) {
    const ctx = this._require(task);
    this._checkpoint(ctx);
    transitionSafe(task, RESEARCH_STATUS.PLANNING, `replanning for ${gaps.length} gap(s)`);

    const { plan, queries } = this._planner.replan({
      task, gaps, available: this._sources.allowedTypes(task), capabilities: this._sources.capabilities(),
    });
    if (queries.length === 0) {
      recordFailure(task, { stage: 'replan', reason: 'no new query could be planned for the gaps found' });
      return plan;
    }
    task.plan = plan;
    task.queries.push(...queries);
    this._emit(ctx, {
      type: RESEARCH_EVENTS.RESEARCH_REPLANNED,
      payload: { planId: plan.id, round: ctx.rounds, queries: queries.map((q) => q.text), gaps: gaps.map((g) => g.reason) },
    });
    await this.search(task);
    return plan;
  }

  // --- internals ------------------------------------------------------------

  async _review(ctx) {
    const { task } = ctx;
    const review = await this._reviewer.review({
      task, store: ctx.store, claims: task.claims, citations: task.citations,
      conflicts: task.conflicts, quality: task.quality, strategy: task.plan.strategy,
      answer: task.answer, signal: ctx.controller.signal,
    });
    this._emit(ctx, {
      type: RESEARCH_EVENTS.RESEARCH_REVIEWED,
      payload: { verdict: review.verdict, blocking: review.blocking, findings: review.findings.map((f) => f.check) },
    });
    return review;
  }

  _hasBudgetForAnotherRound(task) {
    return task.usage.queries < task.limits.maxQueries
      && task.usage.sources < task.limits.maxSources
      && !expired(task);
  }

  async _finish(ctx, { workspace = null, memoryPolicy = null, reason = '' } = {}) {
    const { task } = ctx;
    if (task.status !== RESEARCH_STATUS.CANCELLED) {
      transitionSafe(task, RESEARCH_STATUS.COMPLETED, reason || (isPartial(task) ? 'completed with partial results' : 'completed'));
    }

    // Artifacts through the platform's own manager (§34).
    if (this._artifacts && workspace) {
      task.artifacts = await this._writeArtifacts(ctx, workspace).catch((err) => {
        recordFailure(task, { stage: 'artifact', reason: err.message });
        return [];
      });
    }

    // Memory last, and only for what the evaluator stood behind (§28).
    if (this._memory && this._memory.available && memoryPolicy && task.quality) {
      const candidates = this._memory.candidates({
        task, claims: task.claims, citations: task.citations, quality: task.quality,
      });
      const summary = this._memory.summaryCandidate({ task, quality: task.quality, claims: task.claims });
      task.memory = await this._memory.commit(summary ? [...candidates, summary] : candidates, {
        policy: memoryPolicy, refs: refsFor(task),
      });
    }

    this._emit(ctx, {
      type: RESEARCH_EVENTS.RESEARCH_COMPLETED,
      payload: {
        taskId: task.id, status: task.status, partial: isPartial(task),
        sources: task.sources.length, claims: task.claims.length, citations: task.citations.length,
        grade: task.quality ? task.quality.grade : null,
      },
    });
    if (ctx.trace && this._traces && typeof this._traces.completeTrace === 'function') {
      this._traces.completeTrace(ctx.trace.traceId, { status: task.status });
    }
    return this.result(task.id);
  }

  async _fail(ctx, err, { workspace: _workspace = null } = {}) {
    const { task } = ctx;
    const cancelled = err instanceof ResearchCancelledError || ctx.cancelled;
    recordFailure(task, { stage: task.status, reason: err.message, code: err.code || null, fatal: !cancelled });
    transitionSafe(task, cancelled ? RESEARCH_STATUS.CANCELLED : RESEARCH_STATUS.FAILED, err.message);

    this._emit(ctx, {
      type: cancelled ? RESEARCH_EVENTS.RESEARCH_CANCELLED : RESEARCH_EVENTS.RESEARCH_FAILED,
      payload: { taskId: task.id, reason: err.message, code: err.code || null },
    });
    if (this._logger) this._logger.warn('research task ended early', { taskId: task.id, reason: err.message });

    // A budget or deadline stop is not a crash: whatever was gathered is
    // returned as a partial result (§30), because half an answer with honest
    // caveats beats an exception.
    if (err instanceof ResearchBudgetError || cancelled) return this.result(task.id);
    if (err instanceof ResearchDeniedError) return this.result(task.id);
    throw err;
  }

  // The serializable result. This is what IPC and the agent layer see.
  result(taskId) {
    const ctx = this._live.get(taskId);
    if (!ctx) return null;
    const { task } = ctx;
    return Object.freeze({
      task: researchTaskView(task),
      classification: task.classification,
      plan: task.plan ? task.plan.summary : null,
      queries: task.queries.map(queryView),
      sources: task.sources.map(sourceView),
      evidence: task.evidence.map(evidenceView),
      claims: task.claims.map(claimView),
      citations: task.citations.map(citationView),
      conflicts: task.conflicts,
      quality: task.quality,
      review: task.review || null,
      answer: task.answer || null,
      bibliography: ctx.citations.bibliography(),
      failures: task.failures,
      artifacts: task.artifacts || [],
      partial: isPartial(task),
    });
  }

  async _writeArtifacts(ctx, workspace) {
    const { task } = ctx;
    const out = [];
    const make = async (name, type, content) => {
      const artifact = await this._artifacts.create({ name, type, content, producedBy: task.agentId || 'research' }, { workspace });
      out.push({ id: artifact.id, name: artifact.name, type: artifact.type });
    };

    // The report is the readable one; the rest are the machine-readable record
    // a later run or an audit needs.
    if (task.answer) await make('research-report.md', 'report', task.answer.prose || task.answer.markdown);
    await make('sources.json', 'dataset', { sources: task.sources.map(sourceView) });
    await make('evidence.json', 'dataset', { evidence: task.evidence.map(evidenceView) });
    await make('citations.json', 'dataset', {
      citations: task.citations.map(citationView),
      bibliography: ctx.citations.bibliography(),
    });
    await make('research-report.json', 'report', {
      question: task.question,
      claims: task.claims.map(claimView),
      conflicts: task.conflicts,
      quality: task.quality,
      review: task.review || null,
    });
    return out;
  }

  _startTrace(ctx) {
    if (!this._traces || typeof this._traces.createTrace !== 'function') return null;
    const { task } = ctx;
    // A research task started outside an existing run has no trace lineage of
    // its own, and ExecutionTrace requires one. Minting it here — with the
    // platform's own id helper, not a second scheme — and writing it back onto
    // the task is what makes every event this run emits correlate to the same
    // trace, including the ones emitted before the trace object is returned.
    if (!task.traceId) task.traceId = newId('trace');
    return this._traces.createTrace({
      identity: {
        traceId: task.traceId,
        taskId: task.taskId || task.id,
        workspaceId: task.workspaceId,
        agentId: task.agentId,
        projectId: task.projectId,
        sessionId: task.sessionId,
      },
      label: `research: ${task.question.slice(0, 80)}`,
    });
  }

  // One shim for every event the pipeline emits: the trace, the platform bus and
  // this emitter all see the same thing, and none of the stages know about any
  // of them.
  _emit(ctx, { type, payload }) {
    const { task } = ctx;
    if (ctx.trace && this._traces && typeof this._traces.appendEvent === 'function') {
      this._traces.appendEvent(ctx.trace.traceId, type, payload);
    }
    if (this._bus) {
      this._bus.emit(type, {
        taskId: task.taskId || task.id,
        agentId: task.agentId,
        workspaceId: task.workspaceId,
        sessionId: task.sessionId,
        projectId: task.projectId,
        traceId: ctx.trace ? ctx.trace.traceId : task.traceId,
      }, { researchTaskId: task.id, ...payload });
    }
    this.emit('event', { type, taskId: task.id, payload });
    this.emit(type, { taskId: task.id, payload });
  }

  // Policy gate for the engine's own actions. Source-level gating happens in
  // the SourceManager; this covers "may this install start research at all".
  async _gate(ctx, action) {
    if (!this._policy || typeof this._policy.evaluate !== 'function') return true;
    const { task } = ctx;
    const decision = await this._policy.evaluate({
      action,
      context: {
        agentId: task.agentId, taskId: task.taskId || task.id,
        sessionId: task.sessionId, workspaceId: task.workspaceId,
      },
    });
    if (!decision.allowed) {
      throw new ResearchDeniedError(`policy ${decision.effect} for ${action}: ${decision.reason}`, { action, decision });
    }
    return true;
  }

  // Cancellation and deadline are checked between stages, so a cancelled task
  // stops at the next boundary rather than running to completion invisibly.
  _checkpoint(ctx) {
    if (ctx.cancelled || ctx.controller.signal.aborted) {
      throw new ResearchCancelledError(ctx.task.id, ctx.task.statusReason || 'cancelled');
    }
    if (expired(ctx.task)) {
      throw new ResearchCancelledError(ctx.task.id, 'deadline exceeded');
    }
  }

  _require(task) {
    const ctx = this._live.get(task.id);
    if (!ctx) throw new ResearchValidationError(`research task ${task.id} is not live in this engine`);
    return ctx;
  }
}

// A transition the pipeline attempts opportunistically. An illegal one means
// the task already moved somewhere terminal (cancelled, failed) — which is not
// an error here, it is the cancellation working.
function transitionSafe(task, to, reason) {
  try { return transition(task, to, reason); } catch { return task; }
}

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function pickExplicit(input) {
  const out = {};
  for (const k of ['maxQueries', 'maxSources', 'maxConcurrency', 'maxToolCalls', 'timeoutMs']) {
    if (Number.isInteger(input[k])) out[k] = input[k];
  }
  return out;
}

function refsFor(task) {
  return {
    taskId: task.taskId || task.id,
    agentId: task.agentId,
    workspaceId: task.workspaceId,
    sessionId: task.sessionId,
    projectId: task.projectId,
    traceId: task.traceId,
  };
}

module.exports = { ResearchEngine, MAX_ROUNDS, ROUTE, RESEARCH_MODES, createResearchTask, spend };
