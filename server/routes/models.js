// /api/models — GitHub Copilot model list endpoint.
//
// Calls Copilot's /models endpoint directly (not the OpenAI SDK's
// models.list()) because the SDK strips out `capabilities` and
// `model_picker_enabled`, which are the official signals for "this is a
// chat-completions model VS Code's picker would show". Without them we
// were exposing embeddings/responses-only/disabled models in the dropdown
// and users hit "model X is not accessible via the /chat/completions
// endpoint".

import { FALLBACK_MODELS } from '../copilot/models.js';

export function registerModelsRoutes(app, { readSavedConfig, getGhToken }) {
  app.get('/api/models', async (req, res) => {
    try {
      const cfg     = readSavedConfig();
      const hasPat  = !!(cfg.pat && cfg.pat.trim());
      const token   = getGhToken();
      const r = await fetch('https://api.githubcopilot.com/models', {
        headers: {
          Authorization:            `Bearer ${token}`,
          'Editor-Version':         'vscode/1.85.0',
          'Copilot-Integration-Id': 'vscode-chat',
          Accept:                   'application/json'
        }
      });
      if (!r.ok) throw new Error(`models endpoint ${r.status}`);
      const body = await r.json();
      const raw  = Array.isArray(body.data) ? body.data : [];

      // When the user explicitly supplied a PAT we trust them and keep every
      // chat model the API exposes (skip the picker-only filter). When auth
      // comes from the CLI/keychain/env, narrow to picker-enabled models —
      // anything else triggers "model not available for integrator copilot-4-cli".
      const apiModels = raw
        .filter(m => {
          if (m?.capabilities?.type !== 'chat') return false;
          if (!hasPat && m.model_picker_enabled === false) return false;
          if (m.policy && m.policy.state && m.policy.state !== 'enabled') return false;
          return true;
        })
        .map(m => {
          const family = m.capabilities?.family || m.id || '';
          const vendor = m.vendor
            || (/claude/i.test(family)  ? 'Anthropic'
              : /gemini/i.test(family)  ? 'Google'
              : /minimax/i.test(family) ? 'Minimax'
              : /grok/i.test(family)    ? 'xAI'
              : 'OpenAI');
          const limits = m.capabilities?.limits || {};
          // Copilot reports the real per-model context window under
          // capabilities.limits.max_context_window_tokens. Fall back to the
          // prompt token cap when only that is exposed.
          const contextWindow = limits.max_context_window_tokens
            || limits.max_prompt_tokens
            || undefined;
          return {
            id:     m.id,
            name:   m.name || m.id,
            vendor,
            fast:   /mini|haiku|flash|small|nano/i.test(m.id),
            vision: !!m.capabilities?.supports?.vision,
            tools:  !!m.capabilities?.supports?.tool_calls,
            contextWindow,
            maxOutputTokens: limits.max_output_tokens || undefined,
          };
        });

      // Only models the live Copilot API actually exposes for this account.
      // FALLBACK_MODELS is reserved for the offline/error path below.
      const models = apiModels.sort((a, b) =>
        (a.vendor || '').localeCompare(b.vendor || '') ||
        (a.name   || '').localeCompare(b.name   || '')
      );

      res.json({ models: models.length ? models : FALLBACK_MODELS });
    } catch (e) {
      res.json({ models: FALLBACK_MODELS });
    }
  });
}
