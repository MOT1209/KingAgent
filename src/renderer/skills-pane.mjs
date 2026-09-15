// The Skills pane: what is installed, what it is allowed to do, and how it has
// behaved.
//
// Rendered as HTML strings like the rest of the renderer, and every function
// here is pure so the presentation can be tested in plain node
// (tests/skills-pane.test.mjs) without a window.
//
// Three presentation rules this pane is built around, because a skill manager
// that gets them wrong quietly teaches users to click through prompts:
//
//   1. **Provenance and trust are never implied by layout.** A built-in skill
//      and one fetched from a stranger's branch look different and say which
//      they are, in words, on the row itself.
//   2. **A risk level is shown with what caused it.** "high" alone is noise;
//      "high — runs commands, writes files" is a decision a person can make.
//   3. **Unknown is not zero.** A skill that has never run shows "not run yet",
//      never a 0% success rate.

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TRUST_LABEL = {
  builtin: 'Built in',
  workspace: 'Local',
  community: 'Community',
  untrusted: 'Untrusted',
};

const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', critical: 'Critical risk' };

const PERMISSION_LABEL = {
  'filesystem.read': 'reads files',
  'filesystem.write': 'writes files',
  'filesystem.delete': 'deletes files',
  'process.execute': 'runs commands',
  'network.request': 'uses the network',
  'credential.read': 'reads a credential',
  'mcp.connect': 'connects to MCP servers',
  'mcp.tool.invoke': 'calls MCP tools',
  'agent.delegate': 'delegates to agents',
  'memory.write': 'writes memory',
  'sandbox.exec': 'executes in a sandbox',
  'system.modify': 'changes system state',
};

export function permissionSummary(permissions = []) {
  if (!permissions.length) return 'no special permissions';
  return permissions.map((p) => PERMISSION_LABEL[p] || p).join(', ');
}

// "3 of 4 runs succeeded" / "not run yet" — never "0%" for an unrun skill.
export function reliabilityLabel(stats = {}) {
  if (!stats.runs) return 'not run yet';
  const pct = Math.round((stats.successRate || 0) * 100);
  return `${stats.successes}/${stats.runs} runs succeeded (${pct}%)`;
}

export function qualityLabel(quality) {
  if (!quality || quality.score === null || quality.score === undefined) return 'not scored';
  return `${quality.grade} · ${Math.round(quality.score * 100)}/100`;
}

function badge(text, kind) {
  return `<span class="skill-badge skill-badge-${esc(kind)}">${esc(text)}</span>`;
}

export function trustBadge(skill) {
  const tier = (skill.trust && skill.trust.tier) || 'untrusted';
  const verified = skill.trust && skill.trust.verifiedBy;
  const label = TRUST_LABEL[tier] || tier;
  return badge(verified ? `${label} · verified` : label, tier);
}

export function riskBadge(skill) {
  return badge(RISK_LABEL[skill.riskLevel] || skill.riskLevel, `risk-${skill.riskLevel}`);
}

export function stateBadge(skill) {
  return badge(skill.state, `state-${skill.state}`);
}

// One row in the installed list.
export function skillRowHtml(skill) {
  const findings = skill.security && skill.security.findingCount;
  const warnings = [];
  if (skill.security && skill.security.blocked) warnings.push('blocked by the scanner');
  else if (findings) warnings.push(`${findings} scanner finding${findings === 1 ? '' : 's'}`);
  if (skill.riskRaised) warnings.push(`risk raised from ${skill.declaredRiskLevel}`);
  if (skill.deprecated) warnings.push('deprecated');
  if (skill.state === 'quarantined') warnings.push('quarantined');

  return `<li class="skill-row${skill.usable ? '' : ' skill-row-inactive'}" data-skill-id="${esc(skill.id)}">
  <div class="skill-row-head">
    <span class="skill-name">${esc(skill.name)}</span>
    <span class="skill-version">${esc(skill.version)}</span>
    ${trustBadge(skill)}${riskBadge(skill)}${stateBadge(skill)}
  </div>
  <p class="skill-desc">${esc(skill.description)}</p>
  <div class="skill-meta">
    <span title="What this skill is allowed to reach for">${esc(permissionSummary(skill.permissions))}</span>
    <span>${esc(skill.origin)}</span>
    <span>${esc(reliabilityLabel(skill.stats || {}))}</span>
    <span>${esc(qualityLabel(skill.quality))}</span>
  </div>
  ${warnings.length ? `<div class="skill-warnings">${warnings.map((w) => `<span>${esc(w)}</span>`).join('')}</div>` : ''}
  <div class="skill-actions">${actionsHtml(skill)}</div>
</li>`;
}

function actionsHtml(skill) {
  const button = (action, label, title) => `<button type="button" data-skill-action="${esc(action)}" data-skill-id="${esc(skill.id)}" title="${esc(title)}">${esc(label)}</button>`;
  if (skill.state === 'quarantined') {
    // Deliberately not an "enable" button: a quarantined skill is released to
    // `disabled` first, by a person, and the UI should make that two steps.
    return button('release', 'Release…', 'Release from quarantine into a disabled state. It stays off until you enable it.')
      + button('remove', 'Remove', 'Remove this skill');
  }
  const toggle = skill.usable
    ? button('disable', 'Disable', 'Stop selecting this skill for tasks')
    : button('enable', 'Enable', 'Allow this skill to be selected for tasks');
  const quarantine = skill.usable ? button('quarantine', 'Quarantine', 'Stop this skill for cause; it will need a person to release it') : '';
  return toggle + quarantine + button('update', 'Check for update', 'Check its source for a newer version')
    + (skill.source && skill.source.type === 'builtin' ? '' : button('remove', 'Remove', 'Remove this skill'));
}

// The detail panel for one skill.
export function skillDetailHtml(skill) {
  const findings = (skill.security && skill.security.findings) || [];
  const deps = skill.dependencies || [];
  return `<section class="skill-detail">
  <header>
    <h3>${esc(skill.name)} <small>${esc(skill.id)}@${esc(skill.version)}</small></h3>
    <div>${trustBadge(skill)}${riskBadge(skill)}${stateBadge(skill)}</div>
  </header>
  <p>${esc(skill.description)}</p>
  <dl class="skill-facts">
    <dt>Source</dt><dd>${esc(skill.origin)}${skill.source && skill.source.digest ? ` <code>${esc(String(skill.source.digest).slice(0, 12))}</code>` : ''}</dd>
    <dt>Author</dt><dd>${esc(skill.author || 'unknown')}</dd>
    <dt>Categories</dt><dd>${(skill.categories || []).map((c) => `<code>${esc(c)}</code>`).join(' ')}</dd>
    <dt>Permissions</dt><dd>${esc(permissionSummary(skill.permissions))}</dd>
    <dt>Dependencies</dt><dd>${deps.length ? deps.map((d) => `<code>${esc(d.id)}@${esc(d.range)}</code>`).join(' ') : 'none'}</dd>
    <dt>Sandbox</dt><dd>${skill.security && skill.security.sandboxRequired ? 'runs sandboxed' : 'runs unsandboxed'}</dd>
    <dt>Reliability</dt><dd>${esc(reliabilityLabel(skill.stats || {}))}</dd>
    <dt>Quality</dt><dd>${esc(qualityLabel(skill.quality))}${skill.quality && skill.quality.summary ? `<p class="skill-quality-why">${esc(skill.quality.summary)}</p>` : ''}</dd>
  </dl>
  ${findings.length ? `<div class="skill-findings"><h4>Scanner findings</h4><ul>${findings.map((f) => `<li class="skill-finding-${esc(f.severity)}"><strong>${esc(f.severity)}</strong> ${esc(f.summary)}${f.where ? ` <code>${esc(f.where)}</code>` : ''}</li>`).join('')}</ul></div>` : ''}
  ${(skill.history || []).length ? `<div class="skill-history"><h4>History</h4><ul>${skill.history.slice(-6).reverse().map((h) => `<li>${esc(new Date(h.at).toLocaleString())} — ${esc(h.from)} → ${esc(h.to)}${h.reason ? `: ${esc(h.reason)}` : ''} <small>${esc(h.actor)}</small></li>`).join('')}</ul></div>` : ''}
</section>`;
}

// The "what will run for this request" preview.
export function planHtml(plan) {
  if (!plan) return '';
  if (!plan.steps.length) {
    return `<div class="skill-plan skill-plan-empty"><p>No installed skill matched this request.</p>${gapsHtml(plan.gaps)}</div>`;
  }
  const phases = plan.pipeline.map((step) => `<li class="skill-phase">
    <span class="skill-phase-label">${esc(step.label || step.phase)}</span>
    <span class="skill-phase-skills">${step.skills.map((s) => `<code>${esc(s.skillId)}</code>`).join(' → ')}</span>
  </li>`).join('');
  const prompts = plan.steps.filter((s) => s.willRequestApproval).map((s) => s.skillId);
  return `<div class="skill-plan">
  <p class="skill-plan-summary">${esc(plan.summary)}</p>
  <ol class="skill-pipeline">${phases}</ol>
  ${prompts.length ? `<p class="skill-plan-approvals">Will ask for approval: ${prompts.map((p) => `<code>${esc(p)}</code>`).join(', ')}</p>` : ''}
  ${gapsHtml(plan.gaps)}
</div>`;
}

function gapsHtml(gaps = []) {
  if (!gaps.length) return '';
  return `<div class="skill-gaps"><h4>Capability gaps</h4><ul>${gaps.map((g) => `<li><code>${esc(g.category)}</code> — ${esc(g.suggestion)}</li>`).join('')}</ul></div>`;
}

// A search result row, installed or not. A remote row never renders as if it
// were installed and never shows a trust tier it has not earned.
export function searchRowHtml(row) {
  return `<li class="skill-search-row" data-skill-id="${esc(row.id)}" data-source="${esc(row.source)}">
  <div class="skill-row-head">
    <span class="skill-name">${esc(row.name)}</span>
    ${row.version ? `<span class="skill-version">${esc(row.version)}</span>` : ''}
    ${badge(row.installed ? 'Installed' : 'Available', row.installed ? 'state-installed' : 'available')}
    ${badge(row.source, 'source')}
  </div>
  <p class="skill-desc">${esc(row.description)}</p>
  <div class="skill-meta">
    ${row.installs ? `<span>${esc(String(row.installs))} installs</span>` : ''}
    ${row.permissions && row.permissions.length ? `<span>${esc(permissionSummary(row.permissions))}</span>` : ''}
    <span class="skill-unverified">not yet fetched or scanned</span>
  </div>
  <div class="skill-actions">
    <button type="button" data-skill-action="inspect" data-skill-id="${esc(row.id)}" data-source="${esc(row.source)}">Inspect</button>
    ${row.installed ? '' : `<button type="button" data-skill-action="install" data-skill-id="${esc(row.id)}" data-source="${esc(row.source)}">Install…</button>`}
  </div>
</li>`;
}

// The MCP section. Tool classes are shown per server because "what can this
// server do" is the question, and the class is the answer the policy engine is
// acting on.
export function mcpServerHtml(server) {
  const classes = Object.entries(server.byClass || {}).map(([cls, n]) => `${n}×${cls.toLowerCase()}`).join(', ');
  return `<li class="mcp-row" data-mcp-id="${esc(server.id)}">
  <div class="skill-row-head">
    <span class="skill-name">${esc(server.name)}</span>
    ${badge(server.transport, 'source')}${badge(server.state, `state-${server.state}`)}${badge(RISK_LABEL[server.risk] || server.risk, `risk-${server.risk}`)}
  </div>
  <div class="skill-meta">
    <span>${esc(String((server.tools || []).length))} tools${classes ? ` (${esc(classes)})` : ''}</span>
    <span>${esc(server.origin || 'host')}</span>
    ${server.trusted ? '' : '<span class="skill-unverified">not marked trusted</span>'}
  </div>
  ${(server.conflicts || []).length ? `<div class="skill-warnings">${server.conflicts.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
  <div class="skill-actions">
    <button type="button" data-mcp-action="inspect" data-mcp-id="${esc(server.id)}">Inspect</button>
    <button type="button" data-mcp-action="explain" data-mcp-id="${esc(server.id)}">What is allowed?</button>
    <button type="button" data-mcp-action="quarantine" data-mcp-id="${esc(server.id)}">Quarantine</button>
  </div>
</li>`;
}

// The whole pane.
export function renderSkillsPane({ skills = [], stats = null, plan = null, sources = [], concerns = [], mcp = null, query = '' } = {}) {
  const byState = stats && stats.byState ? stats.byState : {};
  const head = `<header class="skills-head">
  <h2>Skills</h2>
  <p class="skills-stats">${esc(String(stats ? stats.distinct : skills.length))} installed · ${esc(String(byState.enabled || 0))} enabled · ${esc(String(byState.active || 0))} active${byState.quarantined ? ` · <strong>${esc(String(byState.quarantined))} quarantined</strong>` : ''}</p>
  <input type="search" class="skills-search" value="${esc(query)}" placeholder="Search installed and published skills" aria-label="Search skills" />
</header>`;

  const concernsHtml = concerns.length
    ? `<section class="skills-concerns"><h3>Needs attention</h3><ul>${concerns.map((c) => `<li><code>${esc(c.id)}</code> — ${esc(c.reason)}${c.shouldQuarantine ? ' <strong>(should be quarantined)</strong>' : ''}</li>`).join('')}</ul></section>`
    : '';

  const sourcesHtml = sources.length
    ? `<section class="skills-sources"><h3>Sources</h3><ul>${sources.map((s) => `<li><code>${esc(s.id)}</code> ${s.wired ? 'ready' : '<span class="skill-unverified">not wired in this build</span>'}</li>`).join('')}</ul></section>`
    : '';

  const mcpHtml = mcp
    ? `<section class="skills-mcp"><h3>MCP servers</h3>${(mcp.servers || []).length
      ? `<ul class="mcp-list">${mcp.servers.map(mcpServerHtml).join('')}</ul>`
      : '<p>No MCP servers are registered.</p>'}</section>`
    : '';

  return `<div class="skills-pane">
  ${head}
  ${plan ? planHtml(plan) : ''}
  ${concernsHtml}
  <section class="skills-installed"><h3>Installed</h3>${skills.length ? `<ul class="skill-list">${skills.map(skillRowHtml).join('')}</ul>` : '<p>No skills are installed.</p>'}</section>
  ${mcpHtml}
  ${sourcesHtml}
</div>`;
}

// Wire the pane to the platform. Kept out of the pure functions above so this
// module imports cleanly in a test with no `window`.
export function mountSkillsPane(root, api, { onError = () => {} } = {}) {
  if (!root || !api) return () => {};

  const state = { skills: [], stats: null, plan: null, sources: [], concerns: [], mcp: null, query: '' };

  async function refresh() {
    try {
      const [list, audit, sources, mcp] = await Promise.all([
        api.listSkills({}),
        api.skillAudit(),
        api.skillSources(),
        api.listMcpServers(),
      ]);
      state.skills = (list && list.data && list.data.skills) || (list && list.skills) || [];
      state.stats = (list && list.data && list.data.stats) || (list && list.stats) || null;
      state.concerns = (audit && audit.data && audit.data.concerns) || (audit && audit.concerns) || [];
      state.sources = (sources && sources.data) || sources || [];
      state.mcp = (mcp && mcp.data) || mcp || null;
      root.innerHTML = renderSkillsPane(state);
    } catch (err) {
      onError(err);
    }
  }

  async function act(action, id, dataset) {
    switch (action) {
      case 'enable': return api.enableSkill(id);
      case 'disable': return api.disableSkill(id);
      case 'update': return api.updateSkill(id);
      case 'remove': return api.removeSkill(id);
      case 'quarantine': return api.quarantineSkill(id, 'quarantined from the skills pane');
      case 'release': return api.releaseSkill(id, 'released from the skills pane');
      case 'inspect': return api.inspectSkill({ source: dataset.source, id });
      case 'install': return api.installSkill({ source: dataset.source, id });
      default: return null;
    }
  }

  const onClick = async (event) => {
    const button = event.target.closest('[data-skill-action], [data-mcp-action]');
    if (!button) return;
    const skillAction = button.getAttribute('data-skill-action');
    const mcpAction = button.getAttribute('data-mcp-action');
    button.disabled = true;
    try {
      if (skillAction) await act(skillAction, button.getAttribute('data-skill-id'), button.dataset || {});
      else if (mcpAction === 'quarantine') await api.quarantineMcpServer(button.getAttribute('data-mcp-id'), 'quarantined from the skills pane');
      else if (mcpAction === 'inspect') await api.inspectMcpServer(button.getAttribute('data-mcp-id'));
      else if (mcpAction === 'explain') await api.explainMcpServer(button.getAttribute('data-mcp-id'));
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      button.disabled = false;
    }
  };

  root.addEventListener('click', onClick);
  const unsubscribe = typeof api.onPlatformEvent === 'function'
    ? api.onPlatformEvent((ev) => { if (ev && typeof ev.type === 'string' && ev.type.startsWith('skill.')) refresh(); })
    : () => {};

  refresh();
  return () => {
    root.removeEventListener('click', onClick);
    unsubscribe();
  };
}
