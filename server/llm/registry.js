// Provider registry — the single place chat.js (and friends) ask for an LLM
// client. Phase 1 is intentionally additive: existing call sites that import
// getCopilotClient() directly keep working unchanged. New call sites (or
// migrated old ones) use getLLMClient(reqCfg) instead.
//
// Selection precedence:
//   1. Explicit req.body.llm = { providerId, baseURL, apiKey?, model }
//   2. Persisted local-llm.json (if user opted in via settings)
//   3. Copilot (default — preserves current behavior)

import * as copilot      from './providers/copilot.js';
import * as openaiCompat from './providers/openai-compat.js';
import { readLocalLLMConfig } from './config.js';

const PROVIDERS = {
  [copilot.id]:      copilot,
  [openaiCompat.id]: openaiCompat,
};

export function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    label: p.label,
    supports: p.supports,
  }));
}

export function getProvider(providerId) {
  return PROVIDERS[providerId] || null;
}

// Resolve which provider+config to use for an incoming request. Never throws —
// falls back to Copilot if anything is missing.
//
// reqLLM shape (from req.body.llm, optional):
//   { providerId, baseURL, apiKey, model, defaultHeaders, overrides }
export function resolveProviderConfig(reqLLM) {
  // 1. Per-request override wins.
  if (reqLLM && reqLLM.providerId && PROVIDERS[reqLLM.providerId]) {
    return { providerId: reqLLM.providerId, cfg: { ...reqLLM } };
  }

  // 2. Persisted local-LLM config — only honored when the user explicitly
  // opted in (presence of providerId + baseURL).
  const saved = readLocalLLMConfig();
  if (saved && saved.providerId && PROVIDERS[saved.providerId] && saved.baseURL) {
    return { providerId: saved.providerId, cfg: { ...saved } };
  }

  // 3. Default — Copilot.
  return { providerId: copilot.id, cfg: {} };
}

// Build a client + capability bundle ready for chat.js. The capability bundle
// merges provider defaults with any per-config overrides (e.g. user enabling
// "this Ollama model supports tools" toggle).
export function getLLMClient(reqLLM) {
  const { providerId, cfg } = resolveProviderConfig(reqLLM);
  const provider = PROVIDERS[providerId];
  const client = provider.getClient(cfg);
  const supports = { ...provider.supports, ...(cfg.overrides || {}) };
  return {
    client,
    providerId,
    providerLabel: provider.label,
    model: cfg.model || cfg.defaultModel || null,
    supports,
    cfg,
  };
}
