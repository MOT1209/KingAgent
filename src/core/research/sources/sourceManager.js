// SourceManager: the single funnel every retrieval passes through.
//
// Adapters know how to talk to a kind of source. This knows the rules that
// apply to *all* of them, in a fixed order that no adapter can skip:
//
//   1. the task's own gates  — filesOnly, allowWeb, source preferences (§25)
//   2. the policy engine     — research action + network.request (§32)
//   3. the outbound screen   — no credential leaves in a query (§31)
//   4. the cache             — with freshness-aware keys (§29)
//   5. the provider loop     — first provider, then fallbacks (§35)
//   6. the inbound screen    — injection defanged, credentials refused (§31)
//   7. the budget            — sources counted, ceilings enforced (§30)
//
// Steps 2, 3 and 6 are why this class exists rather than each adapter calling
// providers directly: seven adapters means seven chances to forget one.

const { SOURCE_TYPES, normalizeSource } = require('../schemas/source');
const { withSource } = require('../schemas/researchResult');
const { QUERY_STATUS } = require('../schemas/researchQuery');
const { spend, remaining, recordFailure } = require('../schemas/researchTask');
const { screenContent, screenOutbound, screenUrl } = require('../security/researchSecurity');
const { evaluateSource, actionForSourceType } = require('../policies/researchPolicy');
const { FRESHNESS } = require('../retrieval/retrievalCache');
const {
  SourceUnavailableError, ResearchDeniedError, ResearchBudgetError, ResearchCancelledError, isRetryable,
} = require('../errors/researchErrors');

class SourceManager {
  constructor({
    registry, providers = null, policy = null, cache = null, bus = null, logger = null,
    trace = null, emit = null,
  } = {}) {
    if (!registry) throw new TypeError('SourceManager requires a source registry');
    this._registry = registry;
    this._providers = providers;
    this._policy = policy;
    this._cache = cache;
    this._bus = bus;
    this._logger = logger;
    this._trace = trace;
    // emit({ type, payload }) — the engine's trace/event shim. Injected so this
    // class never reaches into the trace store itself.
    this._emit = typeof emit === 'function' ? emit : () => {};
  }

  get registry() { return this._registry; }
  get providers() { return this._providers; }

  // Which source types may this task use at all? The answer is a fact about the
  // task, decided once, rather than re-derived at every call site.
  allowedTypes(task) {
    if (task.filesOnly) return [SOURCE_TYPES.FILE, SOURCE_TYPES.LOCAL];
    const registered = this._registry.types();
    const preferred = task.sourcePreferences.length ? task.sourcePreferences : registered;
    const out = preferred.filter((t) => registered.includes(t));
    if (!task.allowWeb) {
      const networked = [SOURCE_TYPES.WEB, SOURCE_TYPES.NEWS, SOURCE_TYPES.ACADEMIC,
        SOURCE_TYPES.DISCUSSION, SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB];
      return out.filter((t) => !networked.includes(t));
    }
    return out;
  }

  // Run one query against one source type. Never throws for an ordinary failure
  // — a dead provider, a policy refusal, an empty result set all come back in
  // the return value, because §9 requires one failed source not to end the task.
  //
  // It *does* throw ResearchBudgetError and ResearchCancelledError: those are
  // about the task, not the source, and swallowing them would be the silent
  // overrun §30 forbids.
  async retrieve({ task, query, sourceType, limit = null, signal = null, freshness = FRESHNESS.MODERATE }) {
    const started = Date.now();
    const cap = limit || Math.min(query.maxResults, Math.max(1, remaining(task, 'sources')));
    const outcome = {
      sourceType, queryId: query.id, results: [], fromCache: false,
      providerId: null, adapterId: null, error: null, deniedBy: null, durationMs: 0,
    };

    if (signal && signal.aborted) throw new ResearchCancelledError(task.id, 'signal aborted');

    // 1. task gates
    if (!this.allowedTypes(task).includes(sourceType)) {
      outcome.error = task.filesOnly
        ? 'this task is restricted to its uploaded files'
        : `source type "${sourceType}" is not enabled for this task`;
      outcome.deniedBy = 'task';
      return this._finish(task, query, outcome, started);
    }

    const adapters = this._registry.forType(sourceType);
    if (adapters.length === 0) {
      outcome.error = `no adapter is registered for source type "${sourceType}"`;
      outcome.deniedBy = 'registry';
      return this._finish(task, query, outcome, started);
    }

    // 2. policy — research action, plus network.request for anything outbound
    const decision = await evaluateSource(this._policy, {
      type: sourceType,
      context: {
        agentId: task.agentId, taskId: task.taskId || task.id, sessionId: task.sessionId,
        workspaceId: task.workspaceId,
      },
    });
    if (!decision.allowed) {
      outcome.error = `policy ${decision.effect}: ${decision.reason}`;
      outcome.deniedBy = 'policy';
      outcome.decision = { action: decision.action, effect: decision.effect, policyId: decision.policyId, ruleId: decision.ruleId };
      this._emit({ type: 'SOURCE_REJECTED', payload: { sourceType, queryId: query.id, reason: outcome.error, by: 'policy' } });
      return this._finish(task, query, outcome, started);
    }

    // 3. outbound screen — never put a secret in a search box
    const outbound = screenOutbound(query.text);
    if (!outbound.safe) {
      outcome.error = 'query text looks like it contains a credential; refused to send it to a provider';
      outcome.deniedBy = 'security';
      this._emit({ type: 'SOURCE_REJECTED', payload: { sourceType, queryId: query.id, reason: outcome.error, by: 'security' } });
      return this._finish(task, query, outcome, started);
    }

    // 4. cache
    const key = this._cache ? this._cache.key({ query, sourceType, providerId: 'any', freshness }) : null;
    if (key) {
      const cached = await this._cache.get(key, { freshness });
      if (cached) {
        outcome.fromCache = true;
        outcome.results = cached.map((r) => withSource(r, normalizeSource(r.source)));
        task.usage.cacheHits += 1;
        return this._finish(task, query, outcome, started);
      }
    }

    // 5. the adapter / provider loop
    let lastError = null;
    for (const adapter of adapters) {
      outcome.adapterId = adapter.id;
      // File and MCP adapters are their own providers; everything else resolves
      // through the provider registry and falls back down its list.
      const providers = adapter.providersFrom(this._providers);
      const attempts = providers.length ? providers : [null];

      for (const provider of attempts) {
        if (signal && signal.aborted) throw new ResearchCancelledError(task.id, 'signal aborted');
        try {
          const raw = provider
            ? await adapter.searchWith(provider, { query, limit: cap, signal })
            : await adapter.search({
              query, limit: cap, signal,
              files: task.files,
              onFailure: (f) => recordFailure(task, { stage: 'retrieve', queryId: query.id, reason: f.reason, code: f.code }),
            });
          outcome.providerId = provider ? provider.id : adapter.id;
          spend(task, 'providerCalls', 1);

          // 6. inbound screen + 7. budget
          outcome.results = this._screen(task, raw, query, sourceType);
          if (key && outcome.results.length) {
            await this._cache.set(key, outcome.results, { freshness });
          }
          return this._finish(task, query, outcome, started);
        } catch (err) {
          if (err instanceof ResearchBudgetError || err instanceof ResearchCancelledError) throw err;
          lastError = err;
          const who = provider ? provider.id : adapter.id;
          recordFailure(task, { stage: 'retrieve', queryId: query.id, sourceId: who, reason: err.message, code: err.code || null });
          this._emit({
            type: 'SOURCE_REJECTED',
            payload: { sourceType, queryId: query.id, providerId: who, reason: err.message, retryable: isRetryable(err), by: 'provider' },
          });
          if (this._logger) this._logger.debug(`research source ${sourceType} failed via ${who}`, { reason: err.message });
          // Fall through to the next provider, then the next adapter (§35).
        }
      }
    }

    outcome.error = lastError
      ? lastError.message
      : `no provider is configured for source type "${sourceType}"`;
    outcome.deniedBy = lastError ? 'provider' : 'unconfigured';
    return this._finish(task, query, outcome, started);
  }

  // Screen every returned document, drop the unsafe ones, and stop at the
  // task's source ceiling instead of letting a generous provider blow it.
  _screen(task, results, query, sourceType) {
    const kept = [];
    for (const result of results) {
      if (remaining(task, 'sources') <= kept.length) break;

      const src = result.source;
      // A row whose URL fails the SSRF / allow-list screen never becomes a
      // source, even though we only have its snippet: citing it would invite a
      // reader to a place we refused to go ourselves.
      if (src.url) {
        const urlVerdict = screenUrl(src.url, {
          allowedDomains: task.allowedDomains,
          excludedDomains: task.excludedDomains,
        });
        if (!urlVerdict.ok) {
          this._emit({ type: 'SOURCE_REJECTED', payload: { sourceType, queryId: query.id, url: src.url, reason: urlVerdict.reason, by: 'security' } });
          recordFailure(task, { stage: 'screen', queryId: query.id, reason: `${src.url}: ${urlVerdict.reason}`, code: 'RESEARCH_DENIED' });
          continue;
        }
      }

      const body = screenContent(`${src.title}\n${src.snippet}\n${src.content}`, { sourceId: src.id });
      if (!body.safe) {
        this._emit({ type: 'SOURCE_REJECTED', payload: { sourceType, queryId: query.id, url: src.url, reason: body.refusedReason, by: 'security' } });
        recordFailure(task, { stage: 'screen', queryId: query.id, reason: `${src.url || src.title}: ${body.refusedReason}`, code: 'RESEARCH_DENIED' });
        continue;
      }

      // Re-screen the fields individually so the defanged text is what the rest
      // of the pipeline sees. The combined pass above decided *whether* to keep
      // it; this decides *what* is kept.
      const safeContent = screenContent(src.content, { sourceId: src.id });
      const safeSnippet = screenContent(src.snippet, { sourceId: src.id });
      const screened = normalizeSource({
        ...src,
        content: safeContent.text,
        snippet: safeSnippet.text,
        safety: {
          safe: true,
          screenedAt: body.screenedAt,
          injectionAttempts: body.injectionAttempts,
          findings: body.findings.map((f) => ({ id: f.id, kind: f.kind, severity: f.severity })),
          redactions: body.redactions,
        },
      });
      kept.push(withSource(result, screened));
    }
    if (kept.length) spend(task, 'sources', kept.length);
    return kept;
  }

  _finish(task, query, outcome, started) {
    outcome.durationMs = Date.now() - started;
    query.resultCount += outcome.results.length;
    if (outcome.error) {
      query.errors.push({ sourceId: outcome.sourceType, reason: outcome.error, code: outcome.deniedBy });
    }
    if (outcome.results.length) {
      this._emit({
        type: 'SOURCE_RETRIEVED',
        payload: {
          queryId: query.id, sourceType: outcome.sourceType, count: outcome.results.length,
          providerId: outcome.providerId, fromCache: outcome.fromCache, durationMs: outcome.durationMs,
        },
      });
    }
    return outcome;
  }

  // Full-text fetch for a source we only have a snippet of. Used by the evidence
  // extractor when a snippet is too thin to quote from (§15).
  async fetchFull({ task, source, signal = null }) {
    if (!source.url) return null;
    const verdict = screenUrl(source.url, { allowedDomains: task.allowedDomains, excludedDomains: task.excludedDomains });
    if (!verdict.ok) throw new ResearchDeniedError(`refused to fetch ${source.url}: ${verdict.reason}`, { url: source.url });

    const decision = await evaluateSource(this._policy, {
      type: source.type,
      context: { agentId: task.agentId, taskId: task.taskId || task.id, sessionId: task.sessionId, workspaceId: task.workspaceId },
    });
    if (!decision.allowed) {
      throw new ResearchDeniedError(`policy ${decision.effect} for ${actionForSourceType(source.type)}: ${decision.reason}`, {
        action: decision.action, url: source.url, decision,
      });
    }

    for (const adapter of this._registry.forType(source.type)) {
      for (const provider of adapter.providersFrom(this._providers)) {
        if (!provider.fetch) continue;
        try {
          const doc = await adapter.fetchWith(provider, { url: source.url, signal });
          const screened = screenContent(String(doc.content || doc.text || ''), { sourceId: source.id });
          if (!screened.safe) throw new ResearchDeniedError(`fetched content refused: ${screened.refusedReason}`, { url: source.url });
          spend(task, 'providerCalls', 1);
          return normalizeSource({
            ...source,
            content: screened.text,
            retrievedAt: Date.now(),
            safety: {
              safe: true, screenedAt: screened.screenedAt,
              injectionAttempts: screened.injectionAttempts,
              findings: screened.findings.map((f) => ({ id: f.id, kind: f.kind, severity: f.severity })),
              redactions: screened.redactions,
            },
          });
        } catch (err) {
          if (err instanceof ResearchDeniedError) throw err;
          recordFailure(task, { stage: 'fetch', sourceId: source.id, reason: err.message, code: err.code || null });
        }
      }
    }
    throw new SourceUnavailableError(source.type, `no provider could fetch ${source.url}`);
  }

  // What this install can actually do, and why not where it cannot.
  capabilities() {
    return this._registry.describe(this._providers);
  }
}

module.exports = { SourceManager, QUERY_STATUS };
