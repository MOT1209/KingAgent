#!/usr/bin/env node
// kingagent skills — the command line over the same skill platform the app uses.
//
// There is no separate implementation here. The CLI constructs the real
// platform (src/core/index.js), calls the same installer, validator, policy
// engine and evaluator the UI does, and prints what they return. That is the
// point: a skill that installs from the CLI and not from the app, or vice
// versa, would mean two security paths, and one of them would be wrong.
//
// Approval: the CLI is a non-interactive host. Anything that needs a human
// decision is refused unless `--yes` is passed, and `--yes` is recorded in the
// audit trail as the approval it is. It never becomes the default.
//
//   node scripts/skills-cli.mjs list [--category=c] [--state=s] [--json]
//   node scripts/skills-cli.mjs search <query> [--remote] [--json]
//   node scripts/skills-cli.mjs info <id>
//   node scripts/skills-cli.mjs plan "<request>"
//   node scripts/skills-cli.mjs validate --source=github --repository=o/r --path=skills/x
//   node scripts/skills-cli.mjs install --source=skills.sh --id=<id> [--yes]
//   node scripts/skills-cli.mjs update [<id>] [--yes]
//   node scripts/skills-cli.mjs remove <id> [--force]
//   node scripts/skills-cli.mjs enable|disable <id>
//   node scripts/skills-cli.mjs audit [--json]
//   node scripts/skills-cli.mjs benchmark
//   node scripts/skills-cli.mjs mcp list|inspect <id>|test <id>|validate <id>

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const { manifestView } = require('../src/core/skills/index.js');

const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...rest] = a.slice(2).split('=');
    return [k, rest.length ? rest.join('=') : true];
  }),
);
const positional = argv.filter((a) => !a.startsWith('--'));
const [command, ...args] = positional;
const JSON_OUT = flags.json === true;

// The HTTP client the remote sources need. Deliberately created *here*, in the
// host, and injected: the core has no HTTP client of its own, so it cannot
// reach the network behind a caller's back.
const http = {
  async getJson(url, { headers = {}, timeoutMs = 10_000 } = {}) {
    const res = await fetchWithTimeout(url, { headers: { ...headers, Accept: 'application/json' } }, timeoutMs);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
  },
  async getText(url, { headers = {}, timeoutMs = 10_000, maxBytes = 512 * 1024 } = {}) {
    const res = await fetchWithTimeout(url, { headers }, timeoutMs);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Error(`${url} returned more than ${maxBytes} bytes`);
    return text;
  },
};

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

function out(value, human) {
  if (JSON_OUT) console.log(JSON.stringify(value, null, 2));
  else human();
}

function die(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

async function build() {
  const storeDir = flags.store || path.join(os.homedir(), '.kingagent', 'cli');
  await fs.mkdir(storeDir, { recursive: true });
  const platform = createPlatform({
    storeDir,
    io: {
      skills: {
        directory: flags['skills-dir'] || path.join(os.homedir(), '.kingagent', 'skills'),
        http,
      },
    },
  });
  await platform.initSkills({ actor: 'cli' });
  return platform;
}

// Every approval in the CLI resolves through this one function, so `--yes` is
// the single place consent is expressed and it always prints what was consented
// to before proceeding.
function approver({ manifest, summary, detail, posture }) {
  const name = (manifest && manifest.id) || (detail && detail.skillId) || 'this skill';
  if (flags.yes !== true) {
    console.error(`\nrefused: ${summary || name} needs approval and this is a non-interactive session.`);
    if (posture) console.error(`  why: ${posture.reasons.join('; ')}`);
    if (detail && detail.permissions) console.error(`  it would be allowed to: ${detail.permissions.map((p) => p.description).join(' ')}`);
    console.error('  re-run with --yes if that is what you want.\n');
    return false;
  }
  console.error(`approved by --yes: ${summary || name}`);
  if (posture) console.error(`  reasons: ${posture.reasons.join('; ')}`);
  return true;
}

const COMMANDS = {
  async list(platform) {
    const rows = platform.skills.registry.list({
      category: flags.category || null,
      state: flags.state || null,
      query: flags.query || null,
      sourceType: flags.source || null,
    }).map((r) => r.view());
    out(rows, () => {
      if (!rows.length) return console.log('no skills installed');
      for (const s of rows) {
        console.log(
          `${s.id}@${s.version}`.padEnd(34)
          + `${s.state}`.padEnd(12)
          + `${s.trust.tier}`.padEnd(11)
          + `${s.riskLevel}`.padEnd(9)
          + (s.stats.runs ? `${s.stats.successes}/${s.stats.runs} ok` : 'not run'),
        );
      }
      console.log(`\n${rows.length} skill(s)`);
    });
  },

  async search(platform) {
    const query = args.join(' ');
    if (!query) die('search needs a query');
    const result = await platform.skills.search(query, { includeRemote: flags.remote === true });
    out(result, () => {
      console.log(`installed (${result.installed.length}):`);
      for (const r of result.installed) console.log(`  ${r.id}@${r.version} — ${r.description.slice(0, 70)}`);
      console.log(`\navailable (${result.available.length}):`);
      for (const r of result.available) console.log(`  [${r.source}] ${r.id}${r.version ? `@${r.version}` : ''} — ${r.description.slice(0, 60)}`);
      for (const err of result.errors) console.log(`  ! ${err.source}: ${err.error}`);
    });
  },

  async info(platform) {
    const id = args[0];
    if (!id) die('info needs a skill id');
    const record = platform.skills.registry.get(id);
    if (!record) die(`${id} is not installed`);
    const view = record.view();
    const quality = platform.skills.evaluator.rescore(record);
    out({ ...view, quality }, () => {
      console.log(`${view.name} (${view.id}@${view.version})`);
      console.log(view.description);
      console.log(`\nstate       ${view.state}`);
      console.log(`origin      ${view.origin}`);
      console.log(`trust       ${view.trust.tier}${view.trust.verifiedBy ? ` (verified by ${view.trust.verifiedBy})` : ' (not verified by anyone)'}`);
      console.log(`risk        ${view.riskLevel}${view.riskRaised ? ` (raised from ${view.declaredRiskLevel} by its permissions)` : ''}`);
      console.log(`permissions ${view.permissions.join(', ') || 'none'}`);
      console.log(`categories  ${view.categories.join(', ')}`);
      console.log(`depends on  ${view.dependencies.map((d) => `${d.id}@${d.range}`).join(', ') || 'nothing'}`);
      console.log(`sandbox     ${view.security.sandboxRequired ? 'required' : 'not required'}`);
      console.log(`findings    ${view.security.findingCount}`);
      console.log(`runs        ${view.stats.runs} (${view.stats.successes} ok, ${view.stats.failures} failed)`);
      console.log(`\nquality: ${quality.summary}`);
    });
  },

  async plan(platform) {
    const request = args.join(' ');
    if (!request) die('plan needs a request, e.g. plan "build a REST API"');
    const plan = platform.skills.plan(request);
    out(plan, () => {
      console.log(plan.summary);
      console.log('\ncategories:', plan.categories.map((c) => `${c.category}(${c.score})`).join(' '));
      console.log('\npipeline:');
      for (const step of plan.pipeline) console.log(`  ${step.label.padEnd(16)} ${step.skills.map((s) => s.skillId).join(' -> ')}`);
      for (const step of plan.steps.filter((s) => s.willRequestApproval)) console.log(`\n  ! ${step.skillId} will ask for approval`);
      if (plan.gaps.length) console.log(`\ngaps: ${plan.gaps.map((g) => g.category).join(', ')}`);
    });
  },

  async validate(platform) {
    const request = sourceRequest();
    const verdict = await platform.skills.installer.inspect(request);
    out({ ...verdict, manifest: verdict.manifest ? manifestView(verdict.manifest) : null }, () => {
      console.log(verdict.ok ? 'PASS' : 'FAIL', `— stage: ${verdict.stage}`);
      for (const e of verdict.errors) console.log(`  error: ${e}`);
      for (const w of verdict.warnings) console.log(`  warn:  ${w}`);
      for (const f of verdict.findings) console.log(`  ${f.severity}: ${f.summary} (${f.where}:${f.line})`);
      if (verdict.posture) console.log(`\n  would run sandboxed: ${verdict.posture.sandbox}; approval each run: ${verdict.posture.approval}`);
    });
    if (!verdict.ok) process.exitCode = 2;
  },

  async install(platform) {
    const request = sourceRequest();
    const result = await platform.skills.installer.install(request, { actor: 'cli', approve: approver });
    out({ installed: result.installed, skill: result.record.view() }, () => {
      console.log(result.installed
        ? `installed ${result.record.id}@${result.record.version} (${result.record.trust.tier}, ${result.record.manifest.riskLevel} risk)`
        : `${result.record.id}@${result.record.version}: ${result.reason}`);
      for (const w of result.warnings || []) console.log(`  warn: ${w}`);
      for (const d of result.dependencies || []) console.log(`  dependency: ${d.id}@${d.version}`);
    });
  },

  async update(platform) {
    const id = args[0];
    if (id) {
      const result = await platform.skills.updater.update(id, { actor: 'cli', approve: approver });
      out(result, () => {
        console.log(result.updated ? `${id}: ${result.from} -> ${result.to} (${result.kind})` : `${id}: ${result.reason}`);
        if (result.permissionsAdded && result.permissionsAdded.length) console.log(`  ! new permissions: ${result.permissionsAdded.join(', ')}`);
        if (result.trustReset) console.log('  ! trust was reset — the new version has not been verified by anyone');
      });
      return;
    }
    const checks = await platform.skills.updater.checkAll();
    out(checks, () => {
      for (const c of checks) console.log(`${c.id.padEnd(28)} ${c.current || '?'} ${c.available ? `-> ${c.latest} (${c.kind})` : `· ${c.reason}`}`);
    });
  },

  async remove(platform) {
    const id = args[0];
    if (!id) die('remove needs a skill id');
    const result = await platform.skills.remover.remove(id, { actor: 'cli', force: flags.force === true });
    out(result, () => console.log(`removed ${id} (${result.removed.map((r) => r.version).join(', ')})${result.forced ? ' — forced; dependents may break' : ''}`));
  },

  async enable(platform) {
    const id = args[0];
    if (!id) die('enable needs a skill id');
    const result = await platform.skills.enabler.enable(id, { actor: 'cli' });
    out(result, () => console.log(`${id}: ${result.state}`));
  },

  async disable(platform) {
    const id = args[0];
    if (!id) die('disable needs a skill id');
    const result = platform.skills.enabler.disable(id, { actor: 'cli' });
    out(result, () => console.log(`${id}: ${result.state}`));
  },

  async audit(platform) {
    const report = platform.skills.evaluator.report();
    const concerns = platform.skills.evaluator.concerns();
    out({ report, concerns }, () => {
      for (const row of report) {
        console.log(`${row.id.padEnd(26)} ${String(row.grade).padEnd(11)} ${String(Math.round((row.score || 0) * 100)).padStart(3)}/100  ${row.state.padEnd(11)} ${row.trust.padEnd(10)} runs:${row.runs}`);
      }
      if (concerns.length) {
        console.log('\nneeds attention:');
        for (const c of concerns) console.log(`  ${c.id}: ${c.reason}${c.shouldQuarantine ? ' (should be quarantined)' : ''}`);
      }
    });
  },

  async benchmark(platform) {
    const report = platform.skills.benchmark();
    out(report, () => {
      for (const r of report.results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id.padEnd(22)} recall ${r.recall} precision ${r.precision}${r.missing.length ? ` missing: ${r.missing.join(',')}` : ''}`);
      }
      console.log(`\n${report.passed}/${report.total} scenarios · ${report.measures}`);
    });
    if (report.failed > 0) process.exitCode = 3;
  },

  async mcp(platform) {
    const sub = args[0] || 'list';
    const id = args[1];
    if (sub === 'list') {
      const view = platform.mcp.controlView();
      return out(view, () => {
        if (!view.servers.length) return console.log('no MCP servers registered');
        for (const s of view.servers) console.log(`${s.id.padEnd(20)} ${s.transport.padEnd(7)} ${s.state.padEnd(12)} ${s.risk.padEnd(9)} ${s.tools.length} tools`);
      });
    }
    if (!id) die(`mcp ${sub} needs a server id`);
    const server = platform.mcp.registry.get(id);
    if (!server) die(`no MCP server "${id}" is registered`);
    if (sub === 'inspect' || sub === 'validate') {
      const report = platform.mcp.inspect({
        serverId: id, name: server.name, transport: server.transport, url: server.url,
        tools: server.tools.map((t) => ({ name: t.name, description: t.description || '' })),
      });
      return out(report, () => {
        console.log(`${report.name}: ${report.counts.tools} tools, risk ${report.risk} — ${report.recommendation}`);
        for (const f of report.findings) console.log(`  ${f.severity}: ${f.summary}`);
        console.log(`\n${report.limits}`);
      });
    }
    if (sub === 'test') {
      const plan = platform.mcp.testPlan({ serverId: id, tools: server.tools.map((t) => ({ name: t.name })) });
      return out(plan, () => {
        for (const c of plan.cases) console.log(`  ${c.tool.padEnd(24)} ${c.kind.padEnd(18)} ${c.expect}`);
        console.log(`\n${plan.note}`);
      });
    }
    return die(`unknown mcp subcommand: ${sub}`);
  },
};

function sourceRequest() {
  const source = flags.source;
  if (!source) die('this command needs --source=builtin|local|github|skills.sh');
  return {
    source,
    id: flags.id || args[0] || null,
    repository: flags.repository || null,
    ref: flags.ref || undefined,
    path: flags.path || null,
    dir: flags.dir || null,
  };
}

function usage() {
  console.log(`kingagent skills

  list [--category=] [--state=] [--source=] [--json]
  search <query> [--remote]
  info <id>
  plan "<request>"
  validate --source=<s> [--id=|--repository=|--path=|--ref=]
  install  --source=<s> [--id=|--repository=|--path=|--ref=] [--yes]
  update [<id>] [--yes]
  remove <id> [--force]
  enable <id> | disable <id>
  audit | benchmark
  mcp list | mcp inspect <id> | mcp test <id>

Common flags: --json, --store=<dir>, --skills-dir=<dir>, --yes`);
}

async function main() {
  if (!command || command === 'help' || flags.help) {
    usage();
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    usage();
    die(`unknown command: ${command}`);
  }
  const platform = await build();
  try {
    await handler(platform);
  } finally {
    await platform.dispose().catch(() => {});
  }
}

main().catch((err) => {
  die(err && err.message ? err.message : String(err));
});
