// Research errors: one family, so a caller can tell "this source is down" from
// "policy said no" from "you asked for something malformed" without string
// matching on messages.
//
// Every error carries a `category` that maps onto core/recovery/recovery.js's
// classifier vocabulary. That is deliberate: the recovery layer already knows
// what to do with a `timeout` or a `transient`, and research does not get its
// own second opinion about whether a retry is sensible.

const CATEGORY = Object.freeze({
  TRANSIENT: 'transient',
  TIMEOUT: 'timeout',
  INVALID_INPUT: 'invalid_input',
  PERMISSION_DENIED: 'permission_denied',
  UNAVAILABLE: 'environment',
  VALIDATION: 'validation',
  BUDGET: 'budget',
  CANCELLED: 'cancelled',
});

class ResearchError extends Error {
  constructor(message, { code = 'RESEARCH_ERROR', category = CATEGORY.VALIDATION, taskId = null, cause = null } = {}) {
    super(message);
    this.name = 'ResearchError';
    this.code = code;
    this.category = category;
    this.taskId = taskId;
    if (cause) this.cause = cause;
  }
}

// A source could not answer. Never fatal to a research task on its own — the
// parallel retriever collects these and carries on (§9 partial failure).
class SourceUnavailableError extends ResearchError {
  constructor(sourceId, reason, { category = CATEGORY.UNAVAILABLE, cause = null } = {}) {
    super(`research source "${sourceId}" is unavailable: ${reason}`, {
      code: 'RESEARCH_SOURCE_UNAVAILABLE', category, cause,
    });
    this.name = 'SourceUnavailableError';
    this.sourceId = sourceId;
    this.reason = reason;
  }
}

class SourceTimeoutError extends SourceUnavailableError {
  constructor(sourceId, timeoutMs) {
    super(sourceId, `timed out after ${timeoutMs}ms`, { category: CATEGORY.TIMEOUT });
    this.name = 'SourceTimeoutError';
    this.code = 'RESEARCH_SOURCE_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

// The policy engine, the domain allow/block lists, or the "files only" rule
// refused this retrieval. Distinct from unavailability: retrying does not help.
class ResearchDeniedError extends ResearchError {
  constructor(message, { action = null, sourceId = null, url = null, decision = null } = {}) {
    super(message, { code: 'RESEARCH_DENIED', category: CATEGORY.PERMISSION_DENIED });
    this.name = 'ResearchDeniedError';
    this.action = action;
    this.sourceId = sourceId;
    this.url = url;
    this.decision = decision;
  }
}

// A limit in §30 was reached. The task stops and summarizes; it does not
// silently keep spending.
class ResearchBudgetError extends ResearchError {
  constructor(limit, used, cap) {
    super(`research budget exhausted: ${limit} ${used}/${cap}`, {
      code: 'RESEARCH_BUDGET_EXHAUSTED', category: CATEGORY.BUDGET,
    });
    this.name = 'ResearchBudgetError';
    this.limit = limit;
    this.used = used;
    this.cap = cap;
  }
}

class ResearchCancelledError extends ResearchError {
  constructor(taskId, reason = 'cancelled') {
    super(`research task ${taskId} was cancelled: ${reason}`, {
      code: 'RESEARCH_CANCELLED', category: CATEGORY.CANCELLED, taskId,
    });
    this.name = 'ResearchCancelledError';
    this.reason = reason;
  }
}

class ResearchValidationError extends ResearchError {
  constructor(message, { field = null } = {}) {
    super(message, { code: 'RESEARCH_INVALID', category: CATEGORY.INVALID_INPUT });
    this.name = 'ResearchValidationError';
    this.field = field;
  }
}

// A citation pointed at something that was never retrieved. This is the one
// research failure that must never be recoverable-by-retry: it means the
// synthesis invented a source, and the answer does not ship (§19, §20).
class CitationIntegrityError extends ResearchError {
  constructor(message, { citationId = null, sourceId = null } = {}) {
    super(message, { code: 'RESEARCH_CITATION_INTEGRITY', category: CATEGORY.VALIDATION });
    this.name = 'CitationIntegrityError';
    this.citationId = citationId;
    this.sourceId = sourceId;
  }
}

// Is this error worth another attempt? Mirrors recovery.js's RETRYABLE set
// rather than restating it, so the two can never drift into disagreeing.
function isRetryable(err) {
  if (!err) return false;
  return err.category === CATEGORY.TRANSIENT
    || err.category === CATEGORY.TIMEOUT
    || err.category === CATEGORY.UNAVAILABLE;
}

module.exports = {
  CATEGORY,
  ResearchError,
  SourceUnavailableError,
  SourceTimeoutError,
  ResearchDeniedError,
  ResearchBudgetError,
  ResearchCancelledError,
  ResearchValidationError,
  CitationIntegrityError,
  isRetryable,
};
