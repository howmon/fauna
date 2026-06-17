// Debug endpoint to inspect what Copilot API returns vs what we filter out
// GET /api/models/debug

import { FALLBACK_MODELS } from '../copilot/models.js';

export function registerModelsDebugRoute(app, { readSavedConfig, getGhToken }) {
  app.get('/api/models/debug', async (req, res) => {
    const debug = {
      timestamp: new Date().toISOString(),
      hasPat: false,
      tokenStatus: 'unknown',
      fallbackCount: FALLBACK_MODELS.length,
      fallbackModels: FALLBACK_MODELS.map(m => m.id),
      liveApiResponse: null,
      filteredModels: [],
      rejectedModels: [],
      rejectionReasons: {},
    };

    try {
      const cfg = readSavedConfig();
      debug.hasPat = !!(cfg.pat && cfg.pat.trim());
      
      const token = getGhToken();
      if (!token) {
        debug.tokenStatus = 'missing';
        return res.json(debug);
      }

      debug.tokenStatus = 'present';

      const r = await fetch('https://api.githubcopilot.com/models', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Editor-Version': 'vscode/1.85.0',
          'Copilot-Integration-Id': 'vscode-chat',
          Accept: 'application/json'
        }
      });

      if (!r.ok) {
        debug.liveApiStatus = `${r.status} ${r.statusText}`;
        return res.json(debug);
      }

      const body = await r.json();
      const raw = Array.isArray(body.data) ? body.data : [];
      debug.liveApiResponse = {
        status: 'ok',
        totalModels: raw.length,
        sampleModels: raw.slice(0, 3).map(m => ({
          id: m.id,
          name: m.name,
          capabilities: m.capabilities,
          model_picker_enabled: m.model_picker_enabled,
          policy: m.policy,
          vendor: m.vendor,
        }))
      };

      // Track rejections
      raw.forEach(m => {
        const reasons = [];
        
        if (m?.capabilities?.type !== 'chat') {
          reasons.push(`type=${m?.capabilities?.type}`);
        }
        
        if (!debug.hasPat && m.model_picker_enabled === false) {
          reasons.push('model_picker_enabled=false (no PAT)');
        }
        
        if (m.policy && m.policy.state && m.policy.state !== 'enabled') {
          reasons.push(`policy.state=${m.policy.state}`);
        }

        if (reasons.length > 0) {
          debug.rejectedModels.push(m.id);
          debug.rejectionReasons[m.id] = reasons;
        }
      });

      // Apply same filter logic as models.js
      const apiModels = raw
        .filter(m => {
          if (m?.capabilities?.type !== 'chat') return false;
          if (!debug.hasPat && m.model_picker_enabled === false) return false;
          if (m.policy && m.policy.state && m.policy.state !== 'enabled') return false;
          return true;
        })
        .map(m => ({
          id: m.id,
          name: m.name || m.id,
          vendor: m.vendor || 'unknown',
          fast: /mini|haiku|flash|small|nano/i.test(m.id),
        }));

      debug.filteredModels = apiModels.map(m => m.id);
      debug.filteredCount = apiModels.length;

      res.json(debug);
    } catch (e) {
      debug.error = e.message;
      res.json(debug);
    }
  });
}
