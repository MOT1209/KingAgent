// The Agent Runtime: "Request → Analyze → Plan → Execute → Evaluate → Complete".
//
// This is the heart of Phase 2: it takes a spec, picks an agent, runs the
// analyze → plan → execute loop, evaluates each step, recovers on failure,
// replans when needed, and never leaks chain-of-thought. Every public method
// is async and cancellable via signal.

const { TaskManager } = require('./task-manager');
const { addStepLog, snapshot } = require('./task');
const { Evaluator } = require('./evaluator');
const { Executor } = require('../execution/executor');
const { RecoveryManager } = require('../recovery/recovery');
const stateModule = require('./states');
const { TYPES } = require('../events/event-bus');

class AgentRuntime {
  constructor({
    bus,
    agentRegistry,
    toolManager,
    planner,
    reasoner,
    provider,
    contextBuilder,
    memory,
    logger,
    config,
  }) {
    if (!bus) throw new Error('AgentRuntime requires an EventBus');
    this._bus = bus;
    this._agents = agentRegistry || null;
    this._tools = toolManager;
    this._planner = planner;
    this._reasoner = reasoner;
    this._provider = provider;
    this._contextBuilder = contextBuilder || ((opts) => opts);
    this._memory = memory || null;
    this._logger = logger;
    this._config = config || {};
    this.taskManager = new TaskManager({ bus, store: this._config.taskStore || null });
    this._evaluator = new Evaluator({ provider, logger });
    this._executor = new Executor({ toolManager, bus, logger });
    this._recovery = new RecoveryManager({ bus, maxRetries: this._config.maxRetries || 2, logger });
    this._tasks = new Map(); // id -> { controller }
  }

  get(id) {
    return this.taskManager.get(id);
  }

  history(id) {
    return this.taskManager.history(id);
  }

  listTasks(filter) {
    return this.taskManager.listSummaries(filter);
  }

  pause(id) {
    return this.taskManager.pause(id);
  }

  resume(id) {
    return this.taskManager.resume(id);
  }

  cancel(id, reason) {
    const info = this._tasks.get(id);
    if (info && info.controller) info.controller.abort();
    return this.taskManager.cancel(id, reason);
  }

  // Public entry point: run a user request. Returns the task snapshot; the run
  // continues in the background so the caller can poll history().
  async runAgentTask(spec, { mode } = {}) {
    const agent = this._resolveAgent(spec.agentId);
    const task = this.taskManager.create({
      request: spec.request,
      agentId: agent.id,
      workspace: spec.workspace,
      mode: mode || spec.mode || 'auto',
      options: spec.options || {},
    });
    task.agent = agent;
    this.taskManager.queue(task.id);
    this._bus.emit(TYPES.AGENT_STARTED, { taskId: task.id, agentId: agent.id });

    const controller = new AbortController();
    this._tasks.set(task.id, { controller });
    task._signal = controller.signal;
    this._runLoop(task.id, agent, spec.workspace).catch((err) => {
      if (this._logger) this._logger.error(`runtime.runLoop crashed for ${task.id}`, { error: err.message });
      this.taskManager.fail(task.id, err);
    });
    return snapshot(task);
  }

  async _runLoop(taskId, agent, workspace) {
    const task = this.taskManager.get(taskId);
    if (!task) return;
    try {
      // --- analyze -----------------------------------------------------------
      this.taskManager.start(taskId);
      const context = this._contextBuilder({ task, agent, workspace, toolManager: this._tools });
      task.context = context;
      const analysis = await this._reasoner.analyze(task, context);
      addStepLog(task, { stepId: null, action: 'analyze', summary: analysis.goal });

      // --- plan ----------------------------------------------------------------
      this._transition(taskId, stateModule.STATES.PLANNING, {
        note: 'plan',
        emit: { type: TYPES.TASK_PLANNING, payload: { analysis } },
      });
      const plan = await this._planner.buildPlan({
        request: task.request,
        context,
        agent,
        mode: task.mode,
        signal: task._signal,
      });
      task.plan = plan;
      task.steps = plan.steps;

      // --- execute loop ---------------------------------------------------------
      let guard = 0;
      while (guard++ < 150) {
        if (this._terminal(task)) break;
        if (task.state === stateModule.STATES.PAUSED) { await sleep(100); continue; }

        const ready = await this._executor.readySteps(task.plan, agent, context, task, task._signal);
        if (ready.length === 0) {
          if (task.plan.steps.every((s) => s.status === 'completed')) break;
          if (task.plan.steps.some((s) => s.status === 'failed')) {
            this.taskManager.fail(taskId, new Error('plan has failed steps with no recovery path'));
            break;
          }
          await sleep(50);
          continue;
        }

        if (task.state === stateModule.STATES.PLANNING) {
          this._transition(taskId, stateModule.STATES.EXECUTING, { note: 'execute' });
        }

        for (const step of ready) {
          if (this._terminal(task)) break;
          const result = await this._executor.runStep(task, step, { agent, context, signal: task._signal });
          const judgement = await this._evaluator.evaluateStep(task, step, result, context);
          if (judgement.passed) continue;

          if (this._terminal(task)) break;
          const decision = await this._recovery.recover({ task, step, error: new Error(judgement.reason) });
          if (decision.action === 'retry') {
            step.status = 'pending';
            await sleep(decision.delayMs || 300);
            continue;
          }
          if (decision.action === 'replan') {
            task.replanCount = (task.replanCount || 0) + 1;
            if (task.replanCount > (this._config.maxReplans || 3)) {
              this.taskManager.fail(taskId, new Error(`could not form a working plan after ${task.replanCount} replans`));
              break;
            }
            task.plan = await this._planner.replan(task, judgement.reason, task._signal);
            task.steps = task.plan.steps;
            break; // outer loop regenerates ready steps from the new plan
          }
          if (decision.action === 'ask') {
            this.taskManager.fail(taskId, new Error(`requires human authorization: ${decision.reason}`));
            break;
          }
          this.taskManager.fail(taskId, new Error(judgement.reason));
          break;
        }
      }

      // --- finalize ---------------------------------------------------------------
      if (this._terminal(task)) return;
      const verdict = await this._evaluator.evaluateTask(task, task.plan);
      if (verdict.passed) this.taskManager.complete(taskId, verdict.summary);
      else this.taskManager.fail(taskId, new Error(verdict.summary));
    } catch (err) {
      this.taskManager.fail(taskId, err);
    } finally {
      this._tasks.delete(taskId);
    }
  }

  _terminal(task) {
    return task.state === stateModule.STATES.CANCELLED
      || task.state === stateModule.STATES.CANCELLING
      || task.state === stateModule.STATES.FAILED
      || task.state === stateModule.STATES.COMPLETED;
  }

  _transition(id, to, opts) {
    return this.taskManager._transition(id, to, opts);
  }

  _resolveAgent(agentId) {
    if (this._agents) {
      const id = agentId || 'coder';
      const found = this._agents.get(id);
      if (found) return found;
      const first = this._agents.list({ enabled: true })[0];
      if (first) return first;
    }
    // Fallback when the registry is not wired (unit tests).
    return {
      id: agentId || 'default',
      name: 'default',
      capabilities: ['read', 'write', 'code', 'git', 'run_tests'],
      model: { provider: 'unset', id: 'default' },
      permissions: { levels: ['read_only', 'safe', 'moderate'], allowDestructive: false },
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { AgentRuntime };