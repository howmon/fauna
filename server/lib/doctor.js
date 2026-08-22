// server/lib/doctor.js
// Aggregated self-diagnostic — inspired by Agent-Reach's `doctor` command.
//
// Fauna has many optional integrations (headless browser, LibreOffice slide
// rendering, AI image-gen, stock-photo providers, local LLM endpoints, memory
// and context stores) but the per-feature probes were scattered and siloed.
// This module fans out to those existing probes in parallel and returns ONE
// structured health report so the agent (or a user via `/doctor`) can answer
// "why can't I render this slide / read this page / generate that image" by
// looking instead of guessing.
//
// Design: every check is isolated. A check that throws becomes a `fail` line
// rather than crashing the whole report. Probes are loaded with dynamic
// import() so a missing/broken module degrades to one bad line, and heavy
// deps (OpenAI, playwright) are never pulled in unless the doctor actually
// runs.

import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';
const OFF = 'off';

function _readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

export function buildReadinessSummary(report, inputs = {}) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const capabilities = inputs.capabilities || {};
  const packageManifest = inputs.packageManifest || {};
  const customizations = Array.isArray(capabilities.customizations) ? capabilities.customizations : [];
  const invalidCustomizations = customizations.filter(item => item.validation?.ok === false);
  const coreFailures = checks.filter(check => check.tier === 'core' && check.status !== OK);
  const optionalIssues = checks.filter(check => check.tier !== 'core' && (check.status === WARN || check.status === FAIL));
  const versionValid = /^\d+\.\d+\.\d+$/.test(String(packageManifest.version || ''));

  const readinessChecks = [
    {
      name: 'Core capability health',
      status: coreFailures.length ? FAIL : OK,
      message: coreFailures.length ? `${coreFailures.length} required capability check(s) are not healthy.` : 'All required capability checks are healthy.',
    },
    {
      name: 'Capability manifest',
      status: capabilities.schemaVersion === 2 && Number(capabilities.count) > 0 ? OK : FAIL,
      message: capabilities.schemaVersion === 2 && Number(capabilities.count) > 0
        ? `${capabilities.count} tools and ${customizations.length} customizations are inventoried.`
        : 'Generated capability manifest is missing, empty, or incompatible.',
    },
    {
      name: 'Customization validation',
      status: invalidCustomizations.length ? FAIL : OK,
      message: invalidCustomizations.length
        ? `${invalidCustomizations.length} bundled customization(s) have validation errors.`
        : `${customizations.length} bundled customization(s) are valid.`,
    },
    {
      name: 'Release metadata',
      status: versionValid ? OK : FAIL,
      message: versionValid ? `Package version ${packageManifest.version}.` : 'Package version is missing or not semantic versioning.',
    },
    {
      name: 'Optional integrations',
      status: optionalIssues.length ? WARN : OK,
      message: optionalIssues.length ? `${optionalIssues.length} optional integration(s) are degraded or unavailable.` : 'All optional integration checks are healthy.',
    },
  ];
  const blocked = readinessChecks.some(check => check.status === FAIL);
  const degraded = readinessChecks.some(check => check.status === WARN);
  return {
    schemaVersion: 1,
    status: blocked ? 'blocked' : degraded ? 'degraded' : 'ready',
    checks: readinessChecks,
    counts: {
      ok: readinessChecks.filter(check => check.status === OK).length,
      warn: readinessChecks.filter(check => check.status === WARN).length,
      fail: readinessChecks.filter(check => check.status === FAIL).length,
    },
  };
}

function _canResolve(mod) {
  try { _require.resolve(mod); return true; }
  catch { return false; }
}

async function _probeCommand(command, args = ['--version'], opts = {}) {
  const timeout = opts.timeout || 3000;
  try {
    const r = await execFileAsync(command, args, { timeout, windowsHide: true });
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return { ok: true, detail: text.split('\n').find(Boolean) || `${command} ok` };
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'missing', detail: `${command} not found` };
    if (e?.killed || e?.signal === 'SIGTERM') return { ok: false, reason: 'timeout', detail: `${command} timed out` };
    const text = `${e?.stdout || ''}${e?.stderr || ''}`.trim();
    return { ok: false, reason: 'error', detail: text.split('\n').find(Boolean) || e?.message || `${command} failed` };
  }
}

function _withChannel(result, meta = {}) {
  return {
    ...result,
    channel: meta.channel,
    tier: meta.tier || 'optional',
    backends: meta.backends || [],
    activeBackend: result.activeBackend || null,
  };
}

// Wrap a single check so it can never throw out of Promise.all.
async function _safe(check) {
  try {
    const r = await check.fn();
    return {
      name: check.name,
      channel: check.channel || check.name,
      tier: check.tier || 'optional',
      backends: check.backends || [],
      activeBackend: r.activeBackend || null,
      status: r.status,
      message: r.message,
      ...(r.fix ? { fix: r.fix } : {}),
    };
  } catch (e) {
    return {
      name: check.name,
      channel: check.channel || check.name,
      tier: check.tier || 'optional',
      backends: check.backends || [],
      activeBackend: null,
      status: FAIL,
      message: 'check error: ' + (e?.message || String(e)),
      fix: check.fix || 'Open Settings, confirm this integration is configured, then rerun Fauna Doctor.',
    };
  }
}

// ── Individual capability checks ──────────────────────────────────────────
// Each returns { status, message, fix? }. Keep messages short and factual.

const CHECKS = [
  {
    name: 'Web fetch',
    channel: 'web-fetch',
    tier: 'core',
    backends: ['built-in fetch'],
    fn: async () => _withChannel({
      status: OK,
      activeBackend: 'built-in fetch',
      message: 'Built-in HTTP fetch available (read-only URL/page/article reads).',
    }),
  },

  {
    name: 'Headless browser',
    channel: 'browser-automation',
    tier: 'optional',
    backends: ['puppeteer-extra', 'playwright-core'],
    fn: async () => {
      // playwright-browse uses puppeteer-extra first, then playwright-core.
      const hasPuppeteer = _canResolve('puppeteer-extra');
      const hasPlaywright = _canResolve('playwright-core');
      if (hasPuppeteer || hasPlaywright) {
        const engines = [
          hasPuppeteer && 'puppeteer-extra',
          hasPlaywright && 'playwright-core',
        ].filter(Boolean).join(' + ');
        return { status: OK, activeBackend: hasPuppeteer ? 'puppeteer-extra' : 'playwright-core', message: `Browser automation available (${engines}).` };
      }
      return {
        status: WARN,
        activeBackend: null,
        message: 'No headless browser engine resolvable — JS-heavy pages, screenshots, and blocked fetches will fall back to plain HTTP.',
        fix: 'Install one of: `npm i playwright-core` (then a Chromium/Edge binary) or `npm i puppeteer-extra puppeteer-extra-plugin-stealth`.',
      };
    },
  },

  {
    name: 'Office / slide rendering',
    channel: 'office-rendering',
    tier: 'optional',
    backends: ['soffice'],
    fn: async () => {
      const { hasSofficeSync } = await import('../lesson/soffice-runtime.js');
      if (hasSofficeSync()) {
        return { status: OK, activeBackend: 'soffice', message: 'LibreOffice found — .pptx/.ppt/.key/.odp can be rasterized to slide images.' };
      }
      return {
        status: WARN,
        activeBackend: null,
        message: 'LibreOffice (soffice) not found — slide/PPTX rendering and Office→image conversion unavailable.',
        fix: 'Install LibreOffice: `brew install --cask libreoffice` (macOS) or https://www.libreoffice.org/download.',
      };
    },
  },

  {
    name: 'AI image generation',
    channel: 'image-generation',
    tier: 'optional',
    backends: ['OpenAI GPT Image'],
    fn: async () => {
      const { availableImageGen } = await import('../media/image-gen.js');
      if (availableImageGen()) {
        return { status: OK, activeBackend: 'OpenAI GPT Image', message: 'OpenAI key configured — fauna_image_gen (GPT Image) available.' };
      }
      return {
        status: WARN,
        activeBackend: null,
        message: 'No OpenAI key — original/illustrated image generation is unavailable (stock photos may still work).',
        fix: 'Add an OpenAI key in Settings → Authentication → API Keys.',
      };
    },
  },

  {
    name: 'Stock images',
    channel: 'stock-images',
    tier: 'optional',
    backends: ['Pexels', 'Unsplash', 'Pixabay'],
    fn: async () => {
      const { availableImageProviders } = await import('../media/stock-images.js');
      const providers = availableImageProviders();
      if (providers.length) {
        return { status: OK, activeBackend: providers[0], message: `Configured providers: ${providers.join(', ')}.` };
      }
      return {
        status: WARN,
        activeBackend: null,
        message: 'No stock-photo provider keys — fauna_stock_image_search will return nothing.',
        fix: 'Add a free Pexels, Unsplash, or Pixabay key in Settings → API Keys.',
      };
    },
  },

  {
    name: 'Local LLM',
    channel: 'llm-provider',
    tier: 'core',
    backends: ['GitHub Copilot', 'local provider'],
    fn: async () => {
      const { readLocalLLMConfig } = await import('../llm/config.js');
      const cfg = readLocalLLMConfig();
      if (cfg && cfg.providerId && cfg.providerId !== 'copilot') {
        const where = cfg.baseURL ? ` (${cfg.baseURL})` : '';
        return { status: OK, activeBackend: cfg.providerId, message: `Local provider configured: ${cfg.providerId}${where}.` };
      }
      // Not configured is NORMAL — Copilot is the default. Report as OK.
      return { status: OK, activeBackend: 'GitHub Copilot', message: 'Using GitHub Copilot (default). No local LLM configured.' };
    },
  },

  {
    name: 'Memory (facts)',
    channel: 'memory-facts',
    tier: 'core',
    backends: ['memory-store'],
    fn: async () => {
      const { getStats } = await import('../../memory-store.js');
      const s = getStats();
      return { status: OK, activeBackend: 'memory-store', message: `${s.total}/${s.maxFacts} facts stored.` };
    },
  },

  {
    name: 'Context store',
    channel: 'context-store',
    tier: 'core',
    backends: ['context-store'],
    fn: async () => {
      const { getStats } = await import('./context-store.js');
      const s = getStats();
      return { status: OK, activeBackend: 'context-store', message: `${s.documents} document(s), ${s.chunks}/${s.maxChunks} chunks indexed.` };
    },
  },

  {
    name: 'GitHub CLI',
    channel: 'github',
    tier: 'optional',
    backends: ['gh'],
    fn: async () => {
      const version = await _probeCommand('gh', ['--version']);
      if (!version.ok) {
        return {
          status: WARN,
          activeBackend: null,
          message: 'GitHub CLI not available — PR/issue workflows fall back to plain git and web APIs when possible.',
          fix: 'Install GitHub CLI with `brew install gh`, then authenticate with `gh auth login`.',
        };
      }
      const auth = await _probeCommand('gh', ['auth', 'status'], { timeout: 5000 });
      if (!auth.ok) {
        return {
          status: WARN,
          activeBackend: 'gh',
          message: 'GitHub CLI installed but not authenticated.',
          fix: 'Run `gh auth login`, then rerun Fauna Doctor.',
        };
      }
      return { status: OK, activeBackend: 'gh', message: 'GitHub CLI installed and authenticated.' };
    },
  },

  {
    name: 'Media tooling',
    channel: 'media-tools',
    tier: 'optional',
    backends: ['ffmpeg-static', 'ffmpeg'],
    fn: async () => {
      if (_canResolve('ffmpeg-static')) {
        return { status: OK, activeBackend: 'ffmpeg-static', message: 'Bundled ffmpeg-static package resolvable.' };
      }
      const ffmpeg = await _probeCommand('ffmpeg', ['-version']);
      if (ffmpeg.ok) return { status: OK, activeBackend: 'ffmpeg', message: `System ffmpeg available (${ffmpeg.detail}).` };
      return {
        status: WARN,
        activeBackend: null,
        message: 'No ffmpeg backend found — audio/video conversion features may be limited.',
        fix: 'Install ffmpeg with `brew install ffmpeg` or reinstall dependencies with `npm install`.',
      };
    },
  },
];

// ── Public: run all checks in parallel ────────────────────────────────────
export async function runDoctor() {
  const checks = await Promise.all(CHECKS.map(c => _safe(c)));
  const counts = { ok: 0, warn: 0, fail: 0, off: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const report = { checks, counts, total: checks.length, ts: Date.now() };
  report.readiness = buildReadinessSummary(report, {
    capabilities: _readJson(path.join(ROOT, 'server', 'generated', 'capabilities.json'), {}),
    packageManifest: _readJson(path.join(ROOT, 'package.json'), {}),
  });
  return report;
}

// ── Public: human-readable text report (for the CLI) ──────────────────────
const ICON = { ok: '✅', warn: '⚠️', fail: '❌', off: '○' };

export function formatDoctorReport(report) {
  const lines = ['Fauna Doctor', '='.repeat(40)];
  for (const c of report.checks) {
    const backend = c.activeBackend ? ` [${c.activeBackend}]` : '';
    lines.push(`  ${ICON[c.status] || '•'} ${c.name}${backend} — ${c.message}`);
    if (c.fix && c.status !== OK) lines.push(`       fix: ${c.fix}`);
  }
  lines.push('');
  const { ok, warn, fail, off } = report.counts;
  lines.push(`${ok}/${report.total} healthy` + (warn ? `, ${warn} optional` : '') + (off ? `, ${off} off` : '') + (fail ? `, ${fail} failing` : '') + '.');
  if (report.readiness) lines.push(`Operational readiness: ${report.readiness.status}.`);
  return lines.join('\n');
}

export function formatDoctorPromptSummary(report, opts = {}) {
  const limit = opts.limit || 8;
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  return checks.slice(0, limit).map((c) => {
    const backend = c.activeBackend || 'none';
    return `- ${c.channel || c.name}: ${c.status}; backend=${backend}; ${c.message}`;
  }).join('\n');
}
