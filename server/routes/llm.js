// /api/llm/* — local-LLM provider routes:
//   GET    /api/llm/config       — current saved local-LLM config (or null)
//   POST   /api/llm/config       — save new local-LLM config
//   DELETE /api/llm/config       — clear local-LLM config (revert to Copilot)
//   GET    /api/llm/providers    — list registered providers + supports flags
//   GET    /api/llm/discover     — probe well-known local endpoints in parallel
//   POST   /api/llm/probe        — health-check a specific baseURL
//   GET    /api/llm/models       — list models for the currently saved local
//                                  provider (or any explicit baseURL+apiKey)

import { listProviders, getProvider } from '../llm/registry.js';
import {
  readLocalLLMConfig,
  writeLocalLLMConfig,
  clearLocalLLMConfig,
} from '../llm/config.js';
import * as openaiCompat from '../llm/providers/openai-compat.js';

// Well-known local OpenAI-compatible endpoints — probed in parallel by the
// discovery route. Order matters for label preference but not for results.
const WELL_KNOWN_LOCAL = [
  { label: 'Ollama',     baseURL: 'http://localhost:11434/v1' },
  { label: 'LM Studio',  baseURL: 'http://localhost:1234/v1'  },
  { label: 'llama.cpp',  baseURL: 'http://localhost:8080/v1'  },
  { label: 'vLLM',       baseURL: 'http://localhost:8000/v1'  },
  { label: 'Jan',        baseURL: 'http://localhost:1337/v1'  },
  { label: 'Text-Gen-WebUI', baseURL: 'http://localhost:5000/v1' },
];

export function registerLLMRoutes(app) {
  app.get('/api/llm/providers', (_req, res) => {
    res.json({ providers: listProviders() });
  });

  app.get('/api/llm/config', (_req, res) => {
    res.json({ config: readLocalLLMConfig() });
  });

  app.post('/api/llm/config', (req, res) => {
    const cfg = req.body || {};
    if (!cfg.providerId) return res.status(400).json({ error: 'providerId required' });
    if (!getProvider(cfg.providerId)) return res.status(400).json({ error: 'unknown providerId' });
    if (cfg.providerId !== 'copilot' && !cfg.baseURL) {
      return res.status(400).json({ error: 'baseURL required for non-copilot providers' });
    }
    writeLocalLLMConfig(cfg);
    res.json({ ok: true, config: cfg });
  });

  app.delete('/api/llm/config', (_req, res) => {
    clearLocalLLMConfig();
    res.json({ ok: true });
  });

  app.get('/api/llm/discover', async (_req, res) => {
    const probes = await Promise.all(
      WELL_KNOWN_LOCAL.map(async (entry) => {
        const result = await openaiCompat.probe({ baseURL: entry.baseURL });
        if (!result.ok) return null;
        // Pull the model list too so the picker can show them inline.
        const models = await openaiCompat.listModels({
          baseURL: entry.baseURL,
          vendorLabel: entry.label,
        });
        return {
          providerId: 'openai-compat',
          label:      entry.label,
          baseURL:    entry.baseURL,
          latencyMs:  result.latencyMs,
          models,
        };
      })
    );
    res.json({ backends: probes.filter(Boolean) });
  });

  app.post('/api/llm/probe', async (req, res) => {
    const { baseURL, apiKey, defaultHeaders } = req.body || {};
    if (!baseURL) return res.status(400).json({ error: 'baseURL required' });
    const result = await openaiCompat.probe({ baseURL, apiKey, defaultHeaders });
    res.json(result);
  });

  app.get('/api/llm/models', async (req, res) => {
    // Allow caller to pass baseURL/apiKey via query (for the picker's "Test"
    // button). Otherwise read the saved config.
    const baseURL = req.query.baseURL || readLocalLLMConfig()?.baseURL;
    const apiKey  = req.query.apiKey  || readLocalLLMConfig()?.apiKey;
    if (!baseURL) return res.json({ models: [] });
    const models = await openaiCompat.listModels({ baseURL, apiKey });
    res.json({ models });
  });
}
