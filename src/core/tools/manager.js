// The ToolManager: register, discover and execute tools with guards.
//
// Every execution goes through one funnel so the runtime can guarantee:
//   - the tool is registered and validates against its input schema
//   - the agent is allowed to use it (permissions.js)
//   - DESTRUCTIVE / requiresAuth tools get an explicit authorization decision
//   - calls time out and abort cleanly, and failures are classified + emitted

const { validateToolDefinition } = require('./definition');
const { PERMISSIONS } = require('./definition');
const { canUseTool, needsAuthorization } = require('./permissions');
const { isPlainObject } = require('../schema/validate');
const { TYPES } = require('../events/event-bus');

class ToolDeniedError extends Error {
  constructor(message, { toolId, reason } = {}) {
    super(message);
    this.name = 'ToolDeniedError';
    this.code = 'TOOL_DENIED';
    this.toolId = toolId;
    this.reason = reason;
  }
}

class ToolError extends Error {
  constructor(message, { code = 'TOOL_FAILURE', toolId, cause } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.toolId = toolId;
    this.cause = cause;
  }
}

class ToolTimeoutError extends ToolError {
  constructor(toolId, timeoutMs) {
    super(`tool ${toolId} timed out after ${timeoutMs}ms`, { code: 'TOOL_TIMEOUT', toolId });
    this.name = 'ToolTimeoutError';
  }
}

class ToolManager {
  constructor({ bus, logger, authorize } = {}) {
    if (!bus) throw new Error('ToolManager requires an EventBus');
    this._bus = bus;
    this._logger = logger || null;
    // authorize({ agent, tool, input, taskId }) -> Promise<boolean>.
    // Overridden per execution, default: deny anything that needs it.
    this._authorize = typeof authorize === 'function' ? authorize : (async () => false);
    this._tools = new Map(); // id -> tool
    this._capIndex = new Map(); // capability -> Set<toolId>
    this._hidden = new Set();
  }

  register(def) {
    const { ok, tool, errors } = validateToolDefinition(def);
    if (!ok) throw new Error(`Invalid tool definition: ${errors.join('; ')}`);
    if (this._tools.has(tool.id)) throw new Error(`Tool "${tool.id}" is already registered`);
    this._tools.set(tool.id, tool);
    for (const cap of tool.capabilities) {
      if (!this._capIndex.has(cap)) this._capIndex.set(cap, new Set());
      this._capIndex.get(cap).add(tool.id);
    }
    if (tool.hidden) this._hidden.add(tool.id);
    return this.get(tool.id);
  }

  unregister(id) {
    const tool = this._tools.get(id);
    if (!tool) return false;
    for (const cap of tool.capabilities) {
      const s = this._capIndex.get(cap);
      if (s) s.delete(id);
    }
    this._hidden.delete(id);
    return this._tools.delete(id);
  }

  get(id) {
    return this._tools.get(id);
  }

  // Public listing for UI / IPC — never returns execute().
  list({ capability, includeHidden = false } = {}) {
    let ids;
    if (capability) ids = [...(this._capIndex.get(capability) || [])];
    else ids = [...this._tools.keys()];
    return ids
      .filter((id) => includeHidden || !this._hidden.has(id))
      .map((id) => this.peek(id));
  }

  // Metadata-only view safe to ship to a renderer.
  //
  // `policyAction` is part of the view on purpose. A tool may declare its own
  // policy action (`terminal:run` evaluates as `command.run`, not
  // `tool.call.terminal:run`), and the policy engine gates on *that* string. If
  // the view omitted it, the only action visible to a person — or to a policy
  // UI reading this list — would be the `tool.call.<id>` fallback, and a deny
  // rule written against that would silently never match while the tool kept
  // running. Exposing it keeps "which action do I write a policy for?"
  // answerable from the same data the UI already has (§17).
  peek(id) {
    const t = this._tools.get(id);
    if (!t) return undefined;
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      capabilities: [...t.capabilities],
      permissions: { ...t.permissions },
      policyAction: t.policyAction || null,
      timeoutMs: t.timeoutMs,
    };
  }

  // Which tools would `agent` be allowed to call, optionally filtered by
  // capabilities. Deterministic discovery = the planner can reason about it.
  discover(agent, { capabilities, mode = 'permitted' } = {}) {
    const all = mode === 'all'
      ? [...this._tools.values()]
      : [...this._tools.values()].filter((t) => canUseTool(agent, t).ok);
    let out = all;
    if (capabilities && capabilities.length) {
      out = out.filter((t) => t.capabilities.some((c) => capabilities.includes(c)));
    }
    // Agent-scoped tool ids (agent.tools) restrict to a subset when listed.
    if (Array.isArray(agent.tools) && agent.tools.length) {
      out = out.filter((t) => agent.tools.includes(t.id));
    }
    return out.map((t) => t.id);
  }

  async execute({ id, input, agent, taskId = null, signal, authorize }) {
    const tool = this._tools.get(id);
    if (!tool) throw new ToolError(`unknown tool "${id}"`, { code: 'UNKNOWN_TOOL', toolId: id });

    // 1. permission gate
    const allowed = canUseTool(agent, tool);
    if (!allowed.ok) throw new ToolDeniedError(allowed.reason, { toolId: id, reason: allowed.reason });

    // 2. authorization gate (destructive / requiresAuth)
    if (needsAuthorization(agent, tool)) {
      const decider = authorize || this._authorize;
      try {
        const decision = await decider({ agent, tool, input, taskId });
        if (decision !== true) {
          this._bus.emit(TYPES.TOOL_FAILED, { taskId, toolId: id }, { error: 'authorization denied' });
          throw new ToolDeniedError(`authorization denied for ${id}`, { toolId: id, reason: 'authorization denied' });
        }
      } catch (err) {
        if (err instanceof ToolDeniedError) throw err;
        throw new ToolDeniedError(`authorization lookup failed: ${err.message}`, { toolId: id, reason: err.message });
      }
      this._bus.emit('approval.granted', { taskId, toolId: id }, { tool: id });
    }

    // 3. input validation (ad-hoc structural check against inputSchema props)
    const inputErr = validateInput(tool, input);
    if (inputErr) throw new ToolError(`invalid input for ${id}: ${inputErr}`, { code: 'TOOL_INVALID_INPUT', toolId: id });

    const startedAt = Date.now();
    if (signal && signal.aborted) throw new ToolError('aborted before start', { code: 'TOOL_ABORTED', toolId: id });
    this._bus.emit(TYPES.TOOL_CALLED, { taskId, toolId: id }, { input: descr(input) });

    const timeoutMs = tool.timeoutMs || 30_000;
    try {
      // `agent` and `taskId` are handed to execute() so a tool can apply an
      // identity-dependent rule of its own (the browser tools refuse to act on a
      // session that belongs to another agent). The ToolManager cannot make that
      // judgement for them, and a tool that looks up the agent from its input
      // would be trusting the caller to name itself.
      const result = await withTimeout(signal, timeoutMs, Promise.resolve(tool.execute(normalizeInput(input), { abort: signal, agent, taskId })));
      const durationMs = Date.now() - startedAt;
      this._bus.emit(TYPES.TOOL_COMPLETED, { taskId, toolId: id }, { ok: true, durationMs });
      return { ok: true, data: result, durationMs, toolId: id };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (isAbort(err)) {
        throw new ToolError(`tool ${id} aborted`, { code: 'TOOL_ABORTED', toolId: id });
      }
      if (err instanceof ToolError) {
        this._bus.emit(TYPES.TOOL_FAILED, { taskId, toolId: id }, { error: err.message, code: err.code, durationMs });
        if (this._logger) this._logger.warn(`tool ${id} failed`, { code: err.code, durationMs });
        throw err;
      }
      this._bus.emit(TYPES.TOOL_FAILED, { taskId, toolId: id }, { error: err.message, code: 'TOOL_FAILURE', durationMs });
      if (this._logger) this._logger.warn(`tool ${id} failed`, { message: err.message, durationMs });
      throw new ToolError(`tool ${id} failed: ${err.message}`, { code: 'TOOL_FAILURE', toolId: id, cause: err });
    }
  }
}

// --- execution helpers -----------------------------------------------------

function withTimeout(signal, ms, promise) {
  if (!signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ToolTimeoutError('unknown-tool', ms)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError('unknown-tool', ms)), ms);
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function isAbort(err) {
  return err && (err.name === 'AbortSignalAbortError' || /aborted/i.test(err.message || ''));
}

function validateInput(tool, input) {
  const schema = tool.inputSchema || { type: 'object' };
  if (schema.type === 'object' && schema.properties) {
    for (const [key, rule] of Object.entries(schema.properties)) {
      if (rule.required && input[key] === undefined) return `missing required field "${key}"`;
      if (input[key] !== undefined && rule.type === 'array' && !Array.isArray(input[key])) return `"${key}" must be an array`;
      if (input[key] !== undefined && rule.type === 'string' && typeof input[key] !== 'string') return `"${key}" must be a string`;
      if (input[key] !== undefined && rule.type === 'boolean' && typeof input[key] !== 'boolean') return `"${key}" must be a boolean`;
    }
  }
  return null;
}

function normalizeInput(input) {
  return isPlainObject(input) ? { ...input } : {};
}

function descr(input) {
  // Keep tool call inputs out of logs unless explicitly tiny: inputs may carry
  // file contents or commands. The UI gets the real event; logs get a hint.
  if (!isPlainObject(input)) return {};
  const keys = Object.keys(input);
  if (keys.length <= 3 && keys.every((k) => typeof input[k] === 'string' && input[k].length < 80)) return { ...input };
  return { keys };
}

module.exports = { ToolManager, ToolError, ToolDeniedError, ToolTimeoutError, PERMISSIONS };