// ── Agent Vulnerability Scanner — Static analysis for agent security ──────
// Scans agent code (tools, hooks, system prompt) for security vulnerabilities.
// Returns a scored report with findings, severity, and remediation guidance.
// Used locally before import/publish and server-side on store upload.

import path from 'path';
import fs from 'fs';

// ── Check definitions ────────────────────────────────────────────────────

const CHECKS = [
  // ── Critical ──────────────────────────────────────────────────────────
  {
    id: 'env-access',
    name: 'Environment Variable Access',
    severity: 'critical',
    weight: 25,
    description: 'Agent code accesses process.env or environment variables, risking credential exfiltration.',
    patterns: [
      /process\.env/g,
      /Deno\.env/g,
      /\bENV\[/g,
      /os\.environ/g,
      /\$\{?\w*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|API_KEY)\w*\}?/gi,
    ],
    fileTypes: ['js', 'ts', 'py', 'sh'],
  },
  {
    id: 'network-exfil',
    name: 'Network Exfiltration',
    severity: 'critical',
    weight: 25,
    description: 'Agent code makes network requests that could exfiltrate data to undeclared domains.',
    patterns: [
      /\bnew\s+WebSocket\s*\(/g,
      /\bnet\.connect/g,
      /\bnet\.createConnection/g,
      /\bnet\.createServer/g,
      /\bdgram\./g,
      /\brequire\s*\(\s*['"](?:net|dgram|tls|http2)['"]\s*\)/g,
      /\bimport\s+.*\bfrom\s+['"](?:net|dgram|tls|http2)['"]/g,
      /\bchild_process.*curl\b/g,
      /\bchild_process.*wget\b/g,
    ],
    fileTypes: ['js', 'ts'],
  },
  {
    id: 'file-traversal',
    name: 'File Path Traversal',
    severity: 'critical',
    weight: 25,
    description: 'Agent code uses path traversal patterns that could escape the sandbox.',
    patterns: [
      /\.\.\//g,
      /\.\.\\+/g,
      /path\.resolve\s*\([^)]*\.\./g,
      /readFileSync\s*\(\s*['"]\/etc\//g,
      /readFileSync\s*\(\s*['"]\/proc\//g,
      /readFileSync\s*\(\s*['"]~\/\.ssh/g,
      /readFileSync\s*\(\s*['"]~\/\.aws/g,
      /readFileSync\s*\(\s*['"]~\/\.config/g,
    ],
    fileTypes: ['js', 'ts', 'py'],
  },
  {
    id: 'code-injection',
    name: 'Code Injection',
    severity: 'critical',
    weight: 25,
    description: 'Agent code uses eval() or dynamic code execution that could bypass the sandbox.',
    patterns: [
      /\beval\s*\(/g,
      /\bnew\s+Function\s*\(/g,
      /\bvm\.runInNewContext/g,
      /\bvm\.runInThisContext/g,
      /\bvm\.compileFunction/g,
      /\bsetTimeout\s*\(\s*['"`]/g,    // setTimeout("code")
      /\bsetInterval\s*\(\s*['"`]/g,   // setInterval("code")
      /\bimport\s*\(\s*[^)'"]*\+/g,    // dynamic import with concatenation
    ],
    fileTypes: ['js', 'ts'],
  },

  // ── High ──────────────────────────────────────────────────────────────
  {
    id: 'system-info',
    name: 'System Information Access',
    severity: 'high',
    weight: 15,
    description: 'Agent code accesses system information that could fingerprint the host.',
    patterns: [
      /\bos\.hostname\s*\(/g,
      /\bos\.networkInterfaces\s*\(/g,
      /\bos\.userInfo\s*\(/g,
      /\bos\.cpus\s*\(/g,
      /\bos\.homedir\s*\(/g,
      /\bos\.platform\s*\(/g,
      /\bos\.release\s*\(/g,
      /\brequire\s*\(\s*['"]os['"]\s*\)/g,
    ],
    fileTypes: ['js', 'ts'],
  },
  {
    id: 'credential-access',
    name: 'Credential File Access',
    severity: 'high',
    weight: 15,
    description: 'Agent code attempts to read credential files or sensitive directories.',
    patterns: [
      /['"~]\/\.ssh/g,
      /['"~]\/\.aws/g,
      /['"~]\/\.config/g,
      /['"~]\/\.netrc/g,
      /['"~]\/\.npmrc/g,
      /['"~]\/\.pypirc/g,
      /['"~]\/\.docker/g,
      /['"~]\/\.gitconfig/g,
      /['"~]\/\.git-credentials/g,
      /['"]\/etc\/passwd/g,
      /['"]\/etc\/shadow/g,
    ],
    fileTypes: ['js', 'ts', 'py', 'sh'],
  },
  {
    id: 'obfuscation',
    name: 'Code Obfuscation',
    severity: 'high',
    weight: 15,
    description: 'Agent code contains obfuscated strings that could hide malicious payloads.',
    patterns: [
      /atob\s*\(\s*['"][A-Za-z0-9+/]{100,}/g,    // long base64 string in atob()
      /Buffer\.from\s*\(\s*['"][A-Za-z0-9+/]{100,}/g, // long base64 in Buffer.from
      /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){20,}/gi,  // long hex sequences
      /\\u[0-9a-f]{4}(?:\\u[0-9a-f]{4}){20,}/gi,   // long unicode escapes
      /String\.fromCharCode\s*\((?:\s*\d+\s*,){10,}/g, // many charCode calls
    ],
    fileTypes: ['js', 'ts'],
  },

  // ── Medium ────────────────────────────────────────────────────────────
  {
    id: 'excessive-perms',
    name: 'Excessive Permissions',
    severity: 'medium',
    weight: 10,
    description: 'Agent requests unusually broad permissions (shell + network + wide file access).',
    manifestCheck: true,
  },
  {
    id: 'unbounded-network',
    name: 'Unbounded Network Access',
    severity: 'medium',
    weight: 10,
    description: 'Agent requests network access without specifying allowed domains.',
    manifestCheck: true,
  },
  {
    id: 'child-process-spawn',
    name: 'Process Spawning',
    severity: 'medium',
    weight: 10,
    description: 'Agent code spawns child processes outside the controlled shell permission.',
    patterns: [
      /\brequire\s*\(\s*['"]child_process['"]\s*\)/g,
      /\bimport\s+.*\bfrom\s+['"]child_process['"]/g,
      /\bexecSync\s*\(/g,
      /\bspawnSync\s*\(/g,
      /\bexec\s*\(\s*['"]/g,
    ],
    fileTypes: ['js', 'ts'],
  },

  // ── Low ───────────────────────────────────────────────────────────────
  {
    id: 'missing-tests',
    name: 'Missing Test Cases',
    severity: 'low',
    weight: 5,
    description: 'Agent has no test cases in a tests/ directory.',
    structureCheck: true,
  },
  {
    id: 'missing-readme',
    name: 'Missing README',
    severity: 'low',
    weight: 5,
    description: 'Agent has no README.md documentation.',
    structureCheck: true,
  },
  {
    id: 'missing-icon',
    name: 'Missing Icon',
    severity: 'low',
    weight: 5,
    description: 'Agent has no icon image for store listing.',
    structureCheck: true,
  },
];

// ── Scanner engine ───────────────────────────────────────────────────────

/**
 * Scan an agent directory for security vulnerabilities.
 * @param {string} agentDir - Absolute path to the agent directory
 * @returns {ScanReport}
 */
function scanAgent(agentDir) {
  const manifestPath = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(manifestPath)) {
    return { error: 'No agent.json found', score: 0, findings: [], passed: false };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { error: 'Invalid agent.json: ' + e.message, score: 0, findings: [], passed: false };
  }

  const findings = [];

  // 1. Collect all scannable files
  const files = collectFiles(agentDir);

  // 2. Run pattern-based checks on source files
  for (const check of CHECKS) {
    if (check.patterns) {
      for (const file of files) {
        if (!matchesFileType(file.name, check.fileTypes)) continue;
        const hits = runPatternCheck(check, file.content, file.relativePath);
        findings.push(...hits);
      }
    }
  }

  // 3. Run manifest-based checks
  findings.push(...checkManifestPermissions(manifest));

  // 4. Run structure checks
  findings.push(...checkStructure(agentDir, manifest));

  // 5. Calculate score
  const score = calculateScore(findings);

  // 6. Determine severity counts
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    agentName: manifest.name || path.basename(agentDir),
    agentVersion: manifest.version || '0.0.0',
    scanDate: new Date().toISOString(),
    score,
    passed: score >= 80,
    badge: score >= 90 ? 'green' : score >= 80 ? 'yellow' : 'red',
    badgeEmoji: score >= 90 ? '🟢' : score >= 80 ? '🟡' : '🔴',
    counts,
    findings,
    filesScanned: files.length,
  };
}

// ── File collection ──────────────────────────────────────────────────────

function collectFiles(dir, basePath) {
  basePath = basePath || dir;
  const results = [];
  const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.store.json'];
  const MAX_FILE_SIZE = 512 * 1024; // 512KB max per file

  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return results; }

  for (const entry of entries) {
    if (SKIP_DIRS.includes(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }

    if (stat.isDirectory()) {
      results.push(...collectFiles(full, basePath));
    } else if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
      const ext = path.extname(entry).slice(1).toLowerCase();
      if (['js', 'ts', 'py', 'sh', 'json', 'md', 'yaml', 'yml'].includes(ext)) {
        try {
          results.push({
            name: entry,
            relativePath: path.relative(basePath, full),
            content: fs.readFileSync(full, 'utf8'),
          });
        } catch (_) {}
      }
    }
  }

  return results;
}

function matchesFileType(filename, fileTypes) {
  if (!fileTypes || !fileTypes.length) return true;
  const ext = path.extname(filename).slice(1).toLowerCase();
  return fileTypes.includes(ext);
}

// ── Pattern-based analysis ───────────────────────────────────────────────

function runPatternCheck(check, content, filePath) {
  const hits = [];
  const lines = content.split('\n');

  for (const pattern of check.patterns) {
    // Reset regex lastIndex
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      // Find line number
      const before = content.slice(0, match.index);
      const lineNum = before.split('\n').length;
      const lineContent = lines[lineNum - 1] || '';

      hits.push({
        checkId: check.id,
        checkName: check.name,
        severity: check.severity,
        weight: check.weight,
        description: check.description,
        file: filePath,
        line: lineNum,
        column: match.index - before.lastIndexOf('\n'),
        match: match[0].slice(0, 80),
        context: lineContent.trim().slice(0, 120),
      });
    }
  }

  // Deduplicate findings on the same line for the same check
  const seen = new Set();
  return hits.filter(h => {
    const key = h.checkId + ':' + h.file + ':' + h.line;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Manifest-based checks ────────────────────────────────────────────────

function checkManifestPermissions(manifest) {
  const findings = [];
  const perms = manifest.permissions || {};

  // Excessive permissions: shell + network + broad file access
  const hasShell = !!perms.shell;
  const hasNetwork = perms.network && !perms.network.blockAll;
  const hasBroadFile = perms.fileRead?.includes('*') || perms.fileWrite?.includes('*');

  if (hasShell && hasNetwork && hasBroadFile) {
    findings.push({
      checkId: 'excessive-perms',
      checkName: 'Excessive Permissions',
      severity: 'medium',
      weight: 10,
      description: 'Agent requests shell, network, AND wildcard file access. This combination is unusually broad and may indicate over-permissioned design.',
      file: 'agent.json',
      line: 0,
      match: 'shell + network + file:*',
      context: 'permissions: { shell: true, network.blockAll: false, fileRead: ["*"] }',
    });
  }

  // Unbounded network: blockAll=false with no specific domains
  if (perms.network && !perms.network.blockAll) {
    const domains = perms.network.allowedDomains || [];
    if (domains.length === 0 || (domains.length === 1 && domains[0] === '*')) {
      if (domains.length === 0) {
        findings.push({
          checkId: 'unbounded-network',
          checkName: 'Unbounded Network Access',
          severity: 'medium',
          weight: 10,
          description: 'Agent has network access enabled (blockAll: false) but no specific domains listed. Consider adding an explicit domain allowlist.',
          file: 'agent.json',
          line: 0,
          match: 'network.blockAll: false, allowedDomains: []',
          context: 'No domains specified — agent could attempt requests to any domain',
        });
      }
    }
  }

  return findings;
}

// ── Structure checks ─────────────────────────────────────────────────────

function checkStructure(agentDir, manifest) {
  const findings = [];

  // Missing tests
  const testsDir = path.join(agentDir, 'tests');
  if (!fs.existsSync(testsDir) || fs.readdirSync(testsDir).length === 0) {
    findings.push({
      checkId: 'missing-tests',
      checkName: 'Missing Test Cases',
      severity: 'low',
      weight: 5,
      description: 'Agent has no test cases. Adding tests improves trust and enables pre-publish validation.',
      file: 'tests/',
      line: 0,
      match: 'directory missing or empty',
      context: 'Create a tests/ directory with JSON test case files',
    });
  }

  // Missing README
  if (!fs.existsSync(path.join(agentDir, 'README.md'))) {
    findings.push({
      checkId: 'missing-readme',
      checkName: 'Missing README',
      severity: 'low',
      weight: 5,
      description: 'Agent has no README.md. A README is required for store listings and helps users understand the agent.',
      file: 'README.md',
      line: 0,
      match: 'file missing',
      context: 'Create a README.md with usage instructions and examples',
    });
  }

  // Missing icon
  const iconRef = manifest.icon || 'icon.png';
  if (iconRef.startsWith('ti-') || iconRef.startsWith('custom:')) {
    // Tabler icon class or custom icon reference — valid, skip check
  } else if (!fs.existsSync(path.join(agentDir, iconRef))) {
    findings.push({
      checkId: 'missing-icon',
      checkName: 'Missing Icon',
      severity: 'low',
      weight: 5,
      description: 'Agent has no icon image. Icons are displayed in the agent list and store.',
      file: iconRef,
      line: 0,
      match: 'file missing',
      context: 'Add a 128x128 PNG icon',
    });
  }

  return findings;
}

// ── Score calculation ────────────────────────────────────────────────────

function calculateScore(findings) {
  let score = 100;
  // Deduplicate by checkId to avoid double-counting multiple hits of the same issue type
  const seenChecks = new Set();
  for (const f of findings) {
    if (!seenChecks.has(f.checkId)) {
      seenChecks.add(f.checkId);
      score -= f.weight;
    }
  }
  return Math.max(0, score);
}

// ── Report formatting ────────────────────────────────────────────────────

/**
 * Format a scan report for display.
 */
function formatScanReport(report) {
  if (report.error) return '❌ Scan Error: ' + report.error;

  const lines = [];
  lines.push(`## Security Scan: ${report.agentName} v${report.agentVersion}`);
  lines.push('');
  lines.push(`**Score:** ${report.badgeEmoji} ${report.score}/100 — ${report.passed ? 'PASSED' : 'FAILED'}`);
  lines.push(`**Date:** ${report.scanDate}`);
  lines.push(`**Files scanned:** ${report.filesScanned}`);
  lines.push('');

  if (report.counts.critical) lines.push(`- 🔴 **${report.counts.critical}** Critical`);
  if (report.counts.high) lines.push(`- 🟠 **${report.counts.high}** High`);
  if (report.counts.medium) lines.push(`- 🟡 **${report.counts.medium}** Medium`);
  if (report.counts.low) lines.push(`- 🔵 **${report.counts.low}** Low`);

  if (report.findings.length) {
    lines.push('');
    lines.push('### Findings');
    lines.push('');

    // Group by severity
    const bySeverity = { critical: [], high: [], medium: [], low: [] };
    for (const f of report.findings) bySeverity[f.severity].push(f);

    for (const sev of ['critical', 'high', 'medium', 'low']) {
      if (!bySeverity[sev].length) continue;
      const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[sev];
      lines.push(`#### ${icon} ${sev.charAt(0).toUpperCase() + sev.slice(1)}`);
      lines.push('');
      for (const f of bySeverity[sev]) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        lines.push(`- **${f.checkName}** in \`${loc}\``);
        lines.push(`  ${f.description}`);
        if (f.context) lines.push(`  > \`${f.context}\``);
        lines.push('');
      }
    }
  } else {
    lines.push('');
    lines.push('✅ No security issues found!');
  }

  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────────

export {
  scanAgent,
  formatScanReport,
  calculateScore,
  CHECKS,
};
