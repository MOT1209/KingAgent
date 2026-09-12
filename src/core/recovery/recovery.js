// Recovery: classify errors and decide what to do next.
//
// Recovery is the safety net between a step failure and the next attempt. It
// classifies the error, decides whether the step is retryable, applies a
// backoff and suggests the next action (retry, replan or fail). The runtime
// uses the result without interpreting the raw error itself.

const { TYPES } = require('../events/event-bus');

const CATEGORIES = Object.freeze({
  TRANSIENT: 'transient',
  TIMEOUT: 'timeout',
  INVALID_INPUT: 'invalid_input',
  PERMISSION_DENIED: 'permission_denied',
  TOOL_FAILURE: 'tool_failure',
  MODEL_FAILURE: 'model_failure',
  ENVIRONMENT_FAILURE: 'environment',
  VALIDATION_FAILURE: 'validation',
  UNKNOWN: 'unknown',
});

const RETRYABLE = new Set([
  CATEGORIES.TRANSIENT,
  CATEGORIES.TIMEOUT,
  CATEGORIES.TOOL_FAILURE,
  CATEGORIES.MODEL_FAILURE,
]);

const BACKOFF_TABLE = {
  [CATEGORIES.TRANSIENT]: 500,
  [CATEGORIES.TIMEOUT]: 1000,
  [CATEGORIES.TOOL_FAILURE]: 300,
  [CATEGORIES.MODEL_FAILURE]: 2000,
};

function classifyError(err) {
  const msg = (err && err.message) || String(err);
  const code = err && err.code;
  if (code === 'TOOL_TIMEOUT' || /timeout/i.test(msg)) return CATEGORIES.TIMEOUT;
  if (code === 'TOOL_ABORTED') return CATEGORIES.TRANSIENT;
  if (code === 'TOOL_DENIED' || code === 'PERMISSION_DENIED' || /permission|denied|eacces|eperm/i.test(msg)) return CATEGORIES.PERMISSION_DENIED;
  if (code === 'TOOL_INVALID_INPUT') return CATEGORIES.INVALID_INPUT;
  if (code === 'TOOL_FAILURE' || code === 'TOOL_DENIED') return CATEGORIES.TOOL_FAILURE;
  if (code === 'MODEL_FAILURE') return CATEGORIES.MODEL_FAILURE;
  if (/EACCES|EPERM|ENOENT|EEXIST|EBUSY/i.test(msg)) return CATEGORIES.ENVIRONMENT_FAILURE;
  if (code === 'VALIDATION_FAILURE' || /valid/i.test(msg)) return CATEGORIES.VALIDATION_FAILURE;
  return CATEGORIES.UNKNOWN;
}

class RecoveryManager {
  constructor({ bus, maxRetries = 2, backoffMs = 300, logger } = {}) {
    this._bus = bus;
    this._maxRetries = maxRetries;
    this._baseBackoff = backoffMs;
    this._logger = logger;
  }

  // Returns { action: 'retry'|'replan'|'fail'|'ask', delayMs?, reason? }
  async recover({ task, step, error }) {
    const category = classifyError(error);
    const attempts = (task.attempts && task.attempts[step.id]) || 0;
    const canRetry = RETRYABLE.has(category) && attempts < this._maxRetries;
    this._bus.emit('recovery.decided', { taskId: task.id, toolId: step.tool && step.tool.id }, { category, attempts, canRetry });

    if (category === CATEGORIES.PERMISSION_DENIED) {
      return { action: 'ask', reason: 'permission denied; requires explicit authorization', category, attempts };
    }

    if (canRetry) {
      const delay = (BACKOFF_TABLE[category] || this._baseBackoff) * Math.pow(2, attempts);
      this._logger && this._logger.info(`retrying step ${step.id}`, { category, attempts: attempts + 1, delay });
      return { action: 'retry', delayMs: delay, reason: `${category} (attempt ${attempts + 1}/${this._maxRetries})`, category, attempts };
    }

    return { action: 'replan', reason: `${category}: ${error.message ? error.message.slice(0, 100) : 'failed'}`, category, attempts };
  }
}

module.exports = { RecoveryManager, CATEGORIES, classifyError };