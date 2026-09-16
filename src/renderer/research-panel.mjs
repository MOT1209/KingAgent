// The research view (§41).
//
// What this shows, and — more importantly — what it does not.
//
// It shows stages, counts and outcomes: queries planned, sources retrieved,
// duplicates removed, evidence extracted, claims verified, conflicts found,
// citations checked. All of that is operational fact, drawn from a fixed
// vocabulary of event types (core/research/traceEvents.js). It never shows a
// model's deliberation — the trace schema has no field for it and the event
// types carry none, so this panel cannot start showing reasoning by accident,
// the same property agent-activity.mjs already holds.
//
// It also refuses to flatter the result. A partial run says partial, a weak
// grade says weak, and a run that could not reach a source type says which one.
// A progress list that only ever shows green ticks teaches people to ignore it.

import { STAGE_ORDER, STAGE_LABEL, summarize, renderProgressLines } from './research-progress.mjs';

const PANEL_CLASS = 'research-panel';

const STYLE = `
.research-panel { display: flex; flex-direction: column; gap: 10px; font: 12px/1.55 system-ui, sans-serif; }
.research-panel .r-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.research-panel .r-q { font-weight: 600; }
.research-panel .r-grade { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
.research-panel .r-grade.strong { color: #2f7d4f; }
.research-panel .r-grade.adequate { color: #6b6f2a; }
.research-panel .r-grade.weak { color: #9a5b1e; }
.research-panel .r-grade.insufficient { color: #a3352c; }
.research-panel .r-steps { list-style: none; margin: 0; padding: 0; }
.research-panel .r-steps li { display: flex; gap: 8px; align-items: baseline; padding: 1px 0; }
.research-panel .r-mark { width: 1.1em; flex: none; text-align: center; }
.research-panel .r-mark.done { color: #2f7d4f; }
.research-panel .r-mark.warn { color: #9a5b1e; }
.research-panel .r-mark.fail { color: #a3352c; }
.research-panel .r-mark.run { color: #4a6ea8; }
.research-panel .r-note { color: var(--muted, #767676); }
.research-panel .r-caveats { margin: 0; padding-left: 16px; color: #9a5b1e; }
.research-panel .r-sources { list-style: none; margin: 0; padding: 0; }
.research-panel .r-sources li { padding: 3px 0; border-top: 1px solid rgba(127,127,127,.18); }
.research-panel .r-ord { color: var(--muted, #767676); }
.research-panel .r-primary { font-size: 10px; border: 1px solid rgba(47,125,79,.5); color: #2f7d4f; border-radius: 3px; padding: 0 4px; margin-left: 5px; }
.research-panel .r-flag { font-size: 10px; border: 1px solid rgba(163,53,44,.5); color: #a3352c; border-radius: 3px; padding: 0 4px; margin-left: 5px; }
.research-panel .r-conflict { border-left: 2px solid #9a5b1e; padding-left: 8px; margin: 4px 0; }
.research-panel .r-empty { color: var(--muted, #767676); font-style: italic; }
.research-panel button { font: inherit; cursor: pointer; }
`;

// Only http(s) reaches an href.
//
// Source URLs are screened before they ever become a source, so this is
// defence in depth rather than the only check — but it is the sink, and a
// `javascript:` or `data:` URL arriving here would execute in the app's own
// renderer. A sink that trusts its input is one refactor away from being the
// hole.
function isLinkable(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// Render the live progress list. `state` is what research-progress.mjs's
// reducer produced from the event stream; `status` is the last poll of
// `research:status`, used so a reconnecting window is not stuck on whatever it
// happened to catch on the wire.
function renderProgress(state, status) {
  const list = el('ul', 'r-steps');
  for (const line of renderProgressLines(state, status)) {
    const li = el('li');
    li.append(el('span', `r-mark ${line.mark}`, markGlyph(line.mark)));
    const body = el('span', null, line.text);
    if (line.note) {
      body.append(' ');
      body.append(el('span', 'r-note', line.note));
    }
    li.append(body);
    list.append(li);
  }
  return list;
}

function markGlyph(mark) {
  return mark === 'done' ? '✓' : mark === 'warn' ? '⚠' : mark === 'fail' ? '×' : mark === 'run' ? '…' : '·';
}

function renderSources(sources) {
  if (!sources || sources.length === 0) return el('p', 'r-empty', 'No sources were retrieved.');
  const list = el('ul', 'r-sources');
  for (const [i, s] of sources.entries()) {
    const li = el('li');
    li.append(el('span', 'r-ord', `${i + 1}. `));
    if (s.url && isLinkable(s.url)) {
      const a = el('a', null, s.title || s.url);
      a.href = s.url;
      a.rel = 'noreferrer noopener';
      li.append(a);
    } else if (s.url) {
      // A URL the sink will not link is still shown, as text. Hiding it would
      // leave the reader unable to see what the research actually cited.
      li.append(el('span', null, `${s.title || s.url} (${s.url})`));
    } else {
      li.append(el('span', null, s.title || '(untitled)'));
    }
    if (s.primary) li.append(el('span', 'r-primary', 'primary'));
    // A source that tried to instruct the agent is shown as such. The user is
    // entitled to know which page in their results did that.
    if (s.safety && s.safety.findings > 0) li.append(el('span', 'r-flag', 'flagged'));
    const meta = [s.domain, s.type, s.qualityScore !== null ? `quality ${s.qualityScore.toFixed(2)}` : null]
      .filter(Boolean).join(' · ');
    li.append(el('div', 'r-note', meta));
    list.append(li);
  }
  return list;
}

function renderConflicts(conflicts) {
  if (!conflicts || conflicts.length === 0) return null;
  const wrap = el('div');
  wrap.append(el('h3', null, `${conflicts.length} disagreement${conflicts.length === 1 ? '' : 's'} between sources`));
  for (const c of conflicts) {
    const box = el('div', 'r-conflict');
    for (const p of c.positions) box.append(el('div', null, p.statement));
    box.append(el('div', 'r-note', c.resolution === 'unresolved'
      ? 'Unresolved — the answer states both positions.'
      : c.resolutionReason || c.resolution));
    wrap.append(box);
  }
  return wrap;
}

// The full result view.
function renderResult(result) {
  const root = el('div', PANEL_CLASS);
  const head = el('div', 'r-head');
  head.append(el('span', 'r-q', result.task.question));
  if (result.quality) head.append(el('span', `r-grade ${result.quality.grade}`, result.quality.grade));
  root.append(head);

  if (result.partial) {
    root.append(el('p', 'r-note', 'This is a partial result — some of what was planned did not complete.'));
  }

  if (result.answer) {
    const body = el('div', 'r-answer');
    body.textContent = result.answer.prose || result.answer.markdown || '';
    root.append(body);

    if (result.answer.caveats && result.answer.caveats.length) {
      const ul = el('ul', 'r-caveats');
      for (const c of result.answer.caveats) ul.append(el('li', null, c));
      root.append(ul);
    }
  }

  const conflicts = renderConflicts(result.conflicts);
  if (conflicts) root.append(conflicts);

  root.append(el('h3', null, `Sources (${result.sources.length})`));
  root.append(renderSources(result.sources));

  if (result.quality && result.quality.reasons.length) {
    root.append(el('h3', null, 'Quality notes'));
    const ul = el('ul', 'r-caveats');
    for (const r of result.quality.reasons) ul.append(el('li', null, r));
    root.append(ul);
  }
  return root;
}

// Mount a research view into `host`. Returns a controller with `start`,
// `cancel` and `destroy`; the caller owns placement, so this works in the panel
// and in a pane without knowing about either.
function mountResearch(host, { api = window.kingagent && window.kingagent.agentPlatform } = {}) {
  if (!host || !api || typeof api.startResearch !== 'function') return null;

  if (!document.getElementById('research-panel-style')) {
    const style = el('style');
    style.id = 'research-panel-style';
    style.textContent = STYLE;
    document.head.append(style);
  }

  let taskId = null;
  let state = summarize(null, null);
  let poll = null;
  const view = el('div', PANEL_CLASS);
  host.append(view);

  const paint = (status, result) => {
    view.replaceChildren();
    if (!taskId) {
      view.append(el('p', 'r-empty', 'No research running.'));
      return;
    }
    if (result) { view.append(renderResult(result)); return; }
    const head = el('div', 'r-head');
    head.append(el('span', 'r-q', (status && status.task && status.task.question) || 'Researching…'));
    view.append(head);
    view.append(renderProgress(state, status));
  };

  const stop = () => { if (poll) { clearInterval(poll); poll = null; } };

  const unsubscribe = typeof api.onPlatformEvent === 'function'
    ? api.onPlatformEvent((ev) => {
      if (!taskId || !ev || !ev.type || !ev.type.startsWith('research.')) return;
      if (ev.payload && ev.payload.researchTaskId && ev.payload.researchTaskId !== taskId) return;
      state = summarize(state, ev);
      paint(null, null);
    })
    : () => {};

  async function refresh() {
    if (!taskId) return;
    const res = await api.researchStatus(taskId).catch(() => null);
    const status = res && res.ok ? res.data : null;
    if (!status || !status.found) return;
    const done = ['completed', 'failed', 'cancelled'].includes(status.task.status);
    if (!done) { paint(status, null); return; }
    stop();
    const full = await api.getResearch(taskId).catch(() => null);
    paint(status, full && full.ok && full.data.found ? full.data : null);
  }

  return {
    async start(question, options = {}) {
      stop();
      state = summarize(null, null);
      const res = await api.startResearch({ question, ...options });
      if (!res || !res.ok || !res.data.available) {
        view.replaceChildren(el('p', 'r-empty', (res && res.data && res.data.reason) || 'Research is not available in this build.'));
        return null;
      }
      taskId = res.data.id;
      paint(null, null);
      // Events drive the display; the poll is the safety net for a window that
      // was not open when an event fired.
      poll = setInterval(refresh, 1500);
      return taskId;
    },
    async cancel() {
      if (!taskId) return false;
      const res = await api.cancelResearch(taskId, 'cancelled from the interface');
      await refresh();
      return Boolean(res && res.ok && res.data.cancelled);
    },
    refresh,
    get taskId() { return taskId; },
    destroy() {
      stop();
      unsubscribe();
      view.remove();
    },
  };
}

export { mountResearch, renderResult, renderProgress, renderSources, renderConflicts, isLinkable, STAGE_ORDER, STAGE_LABEL, PANEL_CLASS, STYLE };
