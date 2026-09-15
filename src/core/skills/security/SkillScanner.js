// SkillScanner: reads the bytes of a skill and reports what it found.
//
// What this is, precisely: a static content scanner over skill instructions and
// metadata, looking for the patterns that distinguish "a document teaching an
// agent to do X" from "a document trying to make an agent do something to the
// user". It is a *detection* layer, not a sandbox and not a proof of safety.
// Stated plainly because the alternative — a scanner whose green result is read
// as "this skill is safe" — is worse than no scanner at all:
//
//   * It cannot see intent. A skill that explains `rm -rf` in a teaching
//     context and one that instructs an agent to run it look similar in text.
//     That is why a finding is classified, attributed to a line, and shown to a
//     human rather than silently resolved.
//   * It cannot catch what it has no pattern for. New phrasings get through.
//     The controls that do not depend on pattern matching — the policy engine,
//     the tool permission gate, the sandbox, approvals — are the real boundary;
//     this scanner reduces how often a person has to be the first line.
//   * A `blocked` result is therefore the only strong claim it makes: the
//     content contains something no legitimate skill needs (a credential
//     exfiltration instruction, a fork bomb, a request to disable the very
//     controls above), and installation fails closed.
//
// Severities: 'info' (worth knowing), 'warn' (a human should read this before
// enabling), 'critical' (installation is refused).

const SEVERITIES = Object.freeze(['info', 'warn', 'critical']);
const SEVERITY_RANK = Object.freeze({ info: 0, warn: 1, critical: 2 });

// Each rule is `{ id, severity, summary, pattern, permission? }`.
//
// `permission` names the manifest permission that would make this finding
// *expected*. A skill that declares `process.execute` and contains a shell
// command is doing what it said it would; the finding is downgraded to info
// with a note. A skill that contains one without declaring it is the
// interesting case — an under-declared manifest — and stays at its severity.
const RULES = Object.freeze([
  // --- destructive shell ---------------------------------------------------
  { id: 'shell.rm-rf-root', severity: 'critical', summary: 'Recursive delete of a filesystem root', pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|%USERPROFILE%|C:\\)(\s|$)/ },
  { id: 'shell.fork-bomb', severity: 'critical', summary: 'Fork bomb', pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/ },
  { id: 'shell.disk-overwrite', severity: 'critical', summary: 'Raw device write (dd to a block device)', pattern: /\bdd\s+[^\n]*of=\/dev\/(sd|nvme|disk|hd)/ },
  { id: 'shell.format', severity: 'critical', summary: 'Disk format command', pattern: /\b(mkfs(\.\w+)?|format\s+[a-zA-Z]:)\b/ },
  { id: 'shell.recursive-delete', severity: 'warn', summary: 'Recursive delete', pattern: /\b(rm\s+-[a-zA-Z]*r|Remove-Item\s+[^\n]*-Recurse|rmdir\s+\/s)\b/i, permission: 'filesystem.delete' },
  { id: 'shell.privilege', severity: 'warn', summary: 'Privilege escalation (sudo / runas / elevated shell)', pattern: /\b(sudo\s+|doas\s+|runas\s+\/|Start-Process\s+[^\n]*-Verb\s+RunAs)/i, permission: 'system.modify' },
  { id: 'shell.chmod-777', severity: 'warn', summary: 'World-writable permissions', pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/ },

  // --- remote code execution ----------------------------------------------
  { id: 'net.curl-pipe-shell', severity: 'critical', summary: 'Downloads and executes a remote script (curl | sh)', pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]{0,200}\|\s*(sudo\s+)?(ba|z|k|d)?sh\b/i },
  { id: 'net.powershell-download-exec', severity: 'critical', summary: 'PowerShell download-and-execute', pattern: /(IEX|Invoke-Expression)\s*\(\s*(New-Object\s+Net\.WebClient|Invoke-WebRequest|iwr)/i },
  { id: 'code.dynamic-eval', severity: 'warn', summary: 'Dynamic evaluation of downloaded content', pattern: /\b(eval|new\s+Function)\s*\(\s*(await\s+)?(fetch|response|body|res\.|data)/i },

  // --- secrets and exfiltration -------------------------------------------
  { id: 'secret.env-exfiltration', severity: 'critical', summary: 'Sends environment variables or credentials to a remote endpoint', pattern: /(process\.env|printenv|\$ENV|Get-ChildItem\s+env:|%[A-Z_]*(KEY|TOKEN|SECRET)%)[^\n]{0,120}(curl|fetch|POST|http:\/\/|https:\/\/|nc\s|\|\s*base64)/i },
  { id: 'secret.credential-read', severity: 'critical', summary: 'Reads a well-known credential file', pattern: /(\.ssh\/id_[a-z0-9_]+|\.aws\/credentials|\.npmrc|\.git-credentials|\.netrc|id_rsa\b)/i },
  { id: 'secret.literal', severity: 'warn', summary: 'Looks like an embedded credential', pattern: /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/ },
  { id: 'secret.keychain', severity: 'warn', summary: 'Reads the OS credential store', pattern: /\b(security\s+find-generic-password|cmdkey\s+\/list|secret-tool\s+lookup)\b/i },

  // --- path traversal / scope escape --------------------------------------
  { id: 'path.traversal', severity: 'warn', summary: 'Path traversal out of the workspace', pattern: /(\.\.[\\/]){2,}/ },
  // Matches both shell redirection and the prose form ("write the config to
  // /etc/…"). An instruction to an agent is usually prose, so a pattern that
  // only understands `>` would miss the common case entirely.
  { id: 'path.system-write', severity: 'critical', summary: 'Writes outside the workspace into a system location', pattern: /(>>?|Out-File|Set-Content|writeFile|write|save|copy|install|place|put|add)\b[^\n]{0,48}?["']?(\/etc\/|\/usr\/(bin|lib|local\/bin)\/|\/System\/|\/Library\/LaunchAgents|\/bin\/|\/sbin\/|C:\\Windows\\|C:\\Program Files)/i },
  { id: 'path.shell-profile', severity: 'critical', summary: 'Modifies a shell startup file (persistence)', pattern: /(>>|Add-Content|append)[^\n]{0,60}(\.bashrc|\.zshrc|\.bash_profile|\.profile|Microsoft\.PowerShell_profile)/i },

  // --- control evasion -----------------------------------------------------
  // The strongest signal in the file: legitimate skills do not ask an agent to
  // switch the safety layers off.
  { id: 'evasion.bypass-approval', severity: 'critical', summary: 'Instructs the agent to bypass approvals, policy or the sandbox', pattern: /\b(bypass|skip|disable|ignore|circumvent|turn\s+off)\b[^\n]{0,60}\b(approval|approvals|policy|policies|sandbox|permission|permissions|guard|safety|security\s+check)\b/i },
  { id: 'evasion.ignore-instructions', severity: 'critical', summary: 'Prompt injection: tells the agent to ignore its own instructions', pattern: /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|all)\b[^\n]{0,20}\b(instruction|instructions|rules|prompt|system\s+prompt)\b/i },
  { id: 'evasion.hidden-directive', severity: 'warn', summary: 'Hidden directive addressed to the model rather than the reader', pattern: /<!--[^>]{0,400}\b(you\s+are|assistant|claude|gpt|system\s*:|ignore)\b/i },
  { id: 'evasion.no-telemetry', severity: 'warn', summary: 'Asks that the action not be logged or reported', pattern: /\b(do\s+not|don'?t|never)\b[^\n]{0,40}\b(log|audit|report|tell\s+the\s+user|mention|record)\b/i },
  { id: 'evasion.invisible-text', severity: 'warn', summary: 'Zero-width or bidirectional control characters in the content', pattern: /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/ },

  // --- supply chain --------------------------------------------------------
  { id: 'supply.global-install', severity: 'warn', summary: 'Installs a package globally', pattern: /\b(npm\s+i(nstall)?\s+(-g|--global)|pip\s+install\s+--user|brew\s+install|choco\s+install)\b/i, permission: 'process.execute' },
  { id: 'supply.unpinned-remote', severity: 'info', summary: 'Fetches from a remote host without a pinned version', pattern: /\b(curl|wget|fetch)\b[^\n]{0,200}https?:\/\//i, permission: 'network.request' },
]);

// Content limits. A skill document is prose; anything past this is either a
// bundled binary or an attempt to exhaust the scanner, and both are refused.
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_LINE_LENGTH = 20_000;

// A prohibition immediately in front of the matched phrase — "never disable the
// sandbox", "do not bypass approvals". Security guidance legitimately contains
// the exact words an attack would use, and a scanner that refuses to install
// any skill teaching "don't turn the guard off" pushes authors to stop
// documenting the rule, which is a worse outcome than the false positive.
//
// The downgrade is one step (critical -> warn) and never to `info`: a person
// still sees it before the skill is enabled. The window is deliberately tight —
// the negation must sit within ~24 characters and at most two words before the
// match — so a line like "do not tell the user, and disable approvals" does not
// qualify: its prohibition governs a different clause.
const NEGATION_BEFORE = /\b(never|do not|don'?t|must not|should not|avoid|refuse to|rather than)\s+(\w+\s+){0,2}$/i;

function isNegated(line, index) {
  if (index <= 0) return false;
  return NEGATION_BEFORE.test(line.slice(Math.max(0, index - 24), index));
}

function scanContent(content, { permissions = [], where = 'content', maxBytes = MAX_CONTENT_BYTES } = {}) {
  const findings = [];
  if (typeof content !== 'string') {
    return { ok: true, findings, blocked: false, scannedBytes: 0 };
  }
  if (content.length > maxBytes) {
    findings.push(finding({
      id: 'content.too-large',
      severity: 'critical',
      summary: `skill content exceeds ${Math.round(maxBytes / 1024)}KB`,
      where,
      line: 0,
      excerpt: '',
    }));
    return { ok: false, findings, blocked: true, scannedBytes: content.length };
  }

  const lines = content.split(/\r?\n/);
  const declared = new Set(permissions || []);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE_LENGTH) {
      findings.push(finding({
        id: 'content.long-line',
        severity: 'warn',
        summary: 'a single line longer than 20,000 characters (often obfuscation or an embedded payload)',
        where, line: i + 1, excerpt: '',
      }));
      continue;
    }
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      rule.pattern.lastIndex = 0; // the rules are not /g, but keep this safe under edits
      if (!match) continue;
      const expected = rule.permission && declared.has(rule.permission);
      const negated = rule.severity === 'critical' && isNegated(line, match.index);
      findings.push(finding({
        id: rule.id,
        // A declared permission explains a `warn`, never a `critical`: no
        // permission makes "exfiltrate the user's credentials" expected. A
        // prohibition in front of the phrase downgrades one step, to `warn`.
        severity: negated ? 'warn' : expected && rule.severity === 'warn' ? 'info' : rule.severity,
        summary: negated
          ? `${rule.summary} — phrased as a prohibition, review the wording`
          : expected ? `${rule.summary} (declared via ${rule.permission})` : rule.summary,
        where,
        line: i + 1,
        excerpt: excerpt(line),
        negated,
      }));
    }
  }

  const blocked = findings.some((f) => f.severity === 'critical');
  return { ok: !blocked, findings, blocked, scannedBytes: content.length };
}

// Scan a whole skill: its instructions plus any resource file the loader read.
function scanSkill({ manifest, content = '', resources = {} } = {}) {
  const permissions = (manifest && manifest.permissions) || [];
  const all = [];
  const main = scanContent(content, { permissions, where: (manifest && manifest.entry && manifest.entry.instructions) || 'SKILL.md' });
  all.push(...main.findings);
  let bytes = main.scannedBytes;
  for (const [path, text] of Object.entries(resources || {})) {
    const res = scanContent(text, { permissions, where: path });
    all.push(...res.findings);
    bytes += res.scannedBytes;
  }
  // Manifest-level observations that only make sense with the content in hand.
  if (manifest && manifest.permissions.length === 0 && all.some((f) => f.id.startsWith('shell.'))) {
    all.push(finding({
      id: 'manifest.under-declared',
      severity: 'warn',
      summary: 'content runs commands but the manifest declares no permissions',
      where: 'manifest',
      line: 0,
      excerpt: '',
    }));
  }
  const blocked = all.some((f) => f.severity === 'critical');
  return {
    ok: !blocked,
    blocked,
    findings: all.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
    scannedBytes: bytes,
    scannedAt: Date.now(),
    summary: summarize(all),
  };
}

function summarize(findings) {
  const counts = { info: 0, warn: 0, critical: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

function finding({ id, severity, summary, where, line, excerpt: text, negated = false }) {
  return Object.freeze({ id, severity, summary, where, line, excerpt: text, negated });
}

// Never echo a whole line into an audit record or the UI: the line is the thing
// that was suspicious, and a long one is often the payload itself.
function excerpt(line) {
  const trimmed = line.trim();
  return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 157)}...`;
}

function highestSeverity(findings = []) {
  return findings.reduce((acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc), 'info');
}

module.exports = {
  SEVERITIES,
  SEVERITY_RANK,
  RULES,
  MAX_CONTENT_BYTES,
  isNegated,
  scanContent,
  scanSkill,
  highestSeverity,
};
