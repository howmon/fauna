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

const _require = createRequire(import.meta.url);

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

function _canResolve(mod) {
  try { _require.resolve(mod); return true; }
  catch { return false; }
}

// Wrap a single check so it can never throw out of Promise.all.
async function _safe(name, fn) {
  try {
    const r = await fn();
    return {
      name,
      status: r.status,
      message: r.message,
      ...(r.fix ? { fix: r.fix } : {}),
    };
  } catch (e) {
    return { name, status: FAIL, message: 'check error: ' + (e?.message || String(e)) };
  }
}

// ── Individual capability checks ──────────────────────────────────────────
// Each returns { status, message, fix? }. Keep messages short and factual.

const CHECKS = [
  {
    name: 'Web fetch',
    fn: async () => ({
      status: OK,
      message: 'Built-in HTTP fetch available (read-only URL/page/article reads).',
    }),
  },

  {
    name: 'Headless browser',
    fn: async () => {
      // playwright-browse uses puppeteer-extra first, then playwright-core.
      const hasPuppeteer = _canResolve('puppeteer-extra');
      const hasPlaywright = _canResolve('playwright-core');
      if (hasPuppeteer || hasPlaywright) {
        const engines = [
          hasPuppeteer && 'puppeteer-extra',
          hasPlaywright && 'playwright-core',
        ].filter(Boolean).join(' + ');
        return { status: OK, message: `Browser automation available (${engines}).` };
      }
      return {
        status: WARN,
        message: 'No headless browser engine resolvable — JS-heavy pages, screenshots, and blocked fetches will fall back to plain HTTP.',
        fix: 'Install one of: `npm i playwright-core` (then a Chromium/Edge binary) or `npm i puppeteer-extra puppeteer-extra-plugin-stealth`.',
      };
    },
  },

  {
    name: 'Office / slide rendering',
    fn: async () => {
      const { hasSofficeSync } = await import('../lesson/soffice-runtime.js');
      if (hasSofficeSync()) {
        return { status: OK, message: 'LibreOffice found — .pptx/.ppt/.key/.odp can be rasterized to slide images.' };
      }
      return {
        status: WARN,
        message: 'LibreOffice (soffice) not found — slide/PPTX rendering and Office→image conversion unavailable.',
        fix: 'Install LibreOffice: `brew install --cask libreoffice` (macOS) or https://www.libreoffice.org/download.',
      };
    },
  },

  {
    name: 'AI image generation',
    fn: async () => {
      const { availableImageGen } = await import('../media/image-gen.js');
      if (availableImageGen()) {
        return { status: OK, message: 'OpenAI key configured — fauna_image_gen (GPT Image) available.' };
      }
      return {
        status: WARN,
        message: 'No OpenAI key — original/illustrated image generation is unavailable (stock photos may still work).',
        fix: 'Add an OpenAI key in Settings → Authentication → API Keys.',
      };
    },
  },

  {
    name: 'Stock images',
    fn: async () => {
      const { availableImageProviders } = await import('../media/stock-images.js');
      const providers = availableImageProviders();
      if (providers.length) {
        return { status: OK, message: `Configured providers: ${providers.join(', ')}.` };
      }
      return {
        status: WARN,
        message: 'No stock-photo provider keys — fauna_stock_image_search will return nothing.',
        fix: 'Add a free Pexels, Unsplash, or Pixabay key in Settings → API Keys.',
      };
    },
  },

  {
    name: 'Local LLM',
    fn: async () => {
      const { readLocalLLMConfig } = await import('../llm/config.js');
      const cfg = readLocalLLMConfig();
      if (cfg && cfg.providerId && cfg.providerId !== 'copilot') {
        const where = cfg.baseURL ? ` (${cfg.baseURL})` : '';
        return { status: OK, message: `Local provider configured: ${cfg.providerId}${where}.` };
      }
      // Not configured is NORMAL — Copilot is the default. Report as OK.
      return { status: OK, message: 'Using GitHub Copilot (default). No local LLM configured.' };
    },
  },

  {
    name: 'Memory (facts)',
    fn: async () => {
      const { getStats } = await import('../../memory-store.js');
      const s = getStats();
      return { status: OK, message: `${s.total}/${s.maxFacts} facts stored.` };
    },
  },

  {
    name: 'Context store',
    fn: async () => {
      const { getStats } = await import('./context-store.js');
      const s = getStats();
      return { status: OK, message: `${s.documents} document(s), ${s.chunks}/${s.maxChunks} chunks indexed.` };
    },
  },
];

// ── Public: run all checks in parallel ────────────────────────────────────
export async function runDoctor() {
  const checks = await Promise.all(CHECKS.map(c => _safe(c.name, c.fn)));
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  return { checks, counts, total: checks.length, ts: Date.now() };
}

// ── Public: human-readable text report (for the CLI) ──────────────────────
const ICON = { ok: '✅', warn: '⚠️', fail: '❌' };

export function formatDoctorReport(report) {
  const lines = ['Fauna Doctor', '='.repeat(40)];
  for (const c of report.checks) {
    lines.push(`  ${ICON[c.status] || '•'} ${c.name} — ${c.message}`);
    if (c.fix && c.status !== OK) lines.push(`       fix: ${c.fix}`);
  }
  lines.push('');
  const { ok, warn, fail } = report.counts;
  lines.push(`${ok}/${report.total} healthy` + (warn ? `, ${warn} optional` : '') + (fail ? `, ${fail} failing` : '') + '.');
  return lines.join('\n');
}
