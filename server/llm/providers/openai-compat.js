// Generic OpenAI-compatible provider. Used for:
//   - Ollama         (http://localhost:11434/v1)
//   - llama.cpp      (http://localhost:8080/v1)
//   - LM Studio      (http://localhost:1234/v1)
//   - vLLM           (http://<host>:8000/v1)
//   - Jan / Text-Gen-WebUI / arbitrary user-provided endpoint
//
// cfg shape: { baseURL, apiKey?, defaultHeaders?, supports? }
// Capability flags default conservatively — local runtimes vary wildly in
// tool / vision support, so the user (or auto-detect) overrides on a per-
// backend basis.

import OpenAI from 'openai';

export const id = 'openai-compat';
export const label = 'OpenAI-compatible (local)';

export const supports = {
  tools:       false, // most local runtimes don't reliably emit tool_calls
  vision:      false, // a few do (llava, qwen2.5-vl) — flip per-model
  streaming:   true,
  usageEvents: false, // many backends ignore stream_options.include_usage
  embeddings:  true,  // /v1/embeddings is widely supported
};

function _normalizeBaseURL(url) {
  if (!url) throw new Error('openai-compat provider requires baseURL');
  // Strip trailing slash; the SDK appends /chat/completions etc.
  return String(url).replace(/\/+$/, '');
}

export function getClient(cfg = {}) {
  const baseURL = _normalizeBaseURL(cfg.baseURL);
  // Most local runtimes ignore the API key but the SDK requires a non-empty
  // string. "sk-no-key" is the well-known placeholder used by Ollama docs.
  const apiKey = (cfg.apiKey && String(cfg.apiKey).trim()) || 'sk-no-key';
  return new OpenAI({
    baseURL,
    apiKey,
    defaultHeaders: cfg.defaultHeaders || {},
    // Local servers can be slow on first prompt (model warm-up); generous
    // timeout avoids spurious aborts on cold-start.
    timeout: 5 * 60 * 1000,
  });
}

// List models via the standard /v1/models endpoint. Used by the picker.
export async function listModels(cfg = {}) {
  const baseURL = _normalizeBaseURL(cfg.baseURL);
  const apiKey = (cfg.apiKey && String(cfg.apiKey).trim()) || 'sk-no-key';
  try {
    const r = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(cfg.defaultHeaders || {}),
      },
      // Quick fail for picker UX.
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return [];
    const d = await r.json().catch(() => ({}));
    const items = Array.isArray(d?.data) ? d.data : [];
    return items.map(m => ({
      id:      m.id,
      family:  m.id,
      vendor:  cfg.vendorLabel || 'Local',
      // Local context windows aren't reported in /v1/models. Leave undefined
      // so the token-budget table can apply a safe default (see chat.js).
      contextWindow: m.context_length || m.context_window || undefined,
    }));
  } catch (_) {
    return [];
  }
}

// Lightweight reachability check used by the discovery route + UI health
// indicator. Returns { ok, latencyMs, modelCount, error? }.
export async function probe(cfg = {}) {
  const baseURL = _normalizeBaseURL(cfg.baseURL);
  const apiKey = (cfg.apiKey && String(cfg.apiKey).trim()) || 'sk-no-key';
  const started = Date.now();
  try {
    const r = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(cfg.defaultHeaders || {}),
      },
      signal: AbortSignal.timeout(1500),
    });
    const latencyMs = Date.now() - started;
    if (!r.ok) return { ok: false, latencyMs, error: `HTTP ${r.status}` };
    const d = await r.json().catch(() => ({}));
    const items = Array.isArray(d?.data) ? d.data : [];
    return { ok: true, latencyMs, modelCount: items.length };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: e.message || String(e) };
  }
}
