// Local-LLM settings UI client.
//
// Talks to /api/llm/* endpoints to discover, probe, save, and clear the
// user's local OpenAI-compatible backend (Ollama, LM Studio, llama.cpp,
// vLLM, etc). When a config is saved, loadModels() in ui.js will merge
// the local provider's models into the picker under a "Local" vendor.
//
// State exposed to the rest of the app:
//   window.faunaLocalLLM = { config, providers, lastDiscovered }
//
// Functions called from index.html attributes:
//   initLocalLLMSettings, discoverLocalLLM, testLocalLLM,
//   saveLocalLLM, clearLocalLLM

(function() {
  window.faunaLocalLLM = window.faunaLocalLLM || {
    config: null,          // { providerId, baseURL, apiKey, defaultModel, overrides }
    providers: [],
    lastDiscovered: [],
  };

  async function fetchJSON(url, opts) {
    var r = await fetch(url, opts);
    var d = await r.json().catch(function() { return {}; });
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }

  async function initLocalLLMSettings() {
    try {
      var [pRes, cRes] = await Promise.all([
        fetchJSON('/api/llm/providers'),
        fetchJSON('/api/llm/config'),
      ]);
      window.faunaLocalLLM.providers = pRes.providers || [];
      window.faunaLocalLLM.config = cRes.config || null;
    } catch (e) {
      console.warn('[local-llm] init failed', e);
    }
    var cfg = window.faunaLocalLLM.config;
    var baseEl  = document.getElementById('local-llm-baseurl');
    var keyEl   = document.getElementById('local-llm-apikey');
    var modelEl = document.getElementById('local-llm-model');
    var oT      = document.getElementById('local-llm-override-tools');
    var oV      = document.getElementById('local-llm-override-vision');
    var clearBtn = document.getElementById('local-llm-clear-btn');
    if (cfg) {
      if (baseEl)  baseEl.value  = cfg.baseURL || '';
      if (keyEl)   keyEl.value   = cfg.apiKey || '';
      if (modelEl) modelEl.value = cfg.defaultModel || '';
      if (oT) oT.checked = !!(cfg.overrides && cfg.overrides.tools);
      if (oV) oV.checked = !!(cfg.overrides && cfg.overrides.vision);
      if (clearBtn) clearBtn.style.display = '';
    } else {
      if (clearBtn) clearBtn.style.display = 'none';
    }
  }

  async function discoverLocalLLM() {
    var listEl = document.getElementById('local-llm-discover-list');
    if (!listEl) return;
    listEl.innerHTML = '<div style="font-size:12px;color:var(--fau-text-dim)">Scanning…</div>';
    try {
      var d = await fetchJSON('/api/llm/discover');
      window.faunaLocalLLM.lastDiscovered = d.backends || [];
      if (!d.backends || !d.backends.length) {
        listEl.innerHTML = '<div style="font-size:12px;color:var(--fau-text-dim)">No local backends detected. Make sure Ollama/LM Studio/llama.cpp is running.</div>';
        return;
      }
      listEl.innerHTML = '';
      d.backends.forEach(function(b) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;background:var(--fau-surface2);border-radius:4px;border:1px solid var(--fau-border)';
        var label = document.createElement('div');
        label.style.cssText = 'flex:1;font-size:13px';
        label.innerHTML = '<strong>' + escapeHtml(b.label) + '</strong> <span style="color:var(--fau-text-dim);font-size:11px">' + escapeHtml(b.baseURL) + '</span><br><span style="font-size:11px;color:var(--fau-text-dim)">' + (b.models || []).length + ' model(s) · ' + b.latencyMs + 'ms</span>';
        var btn = document.createElement('button');
        btn.className = 'settings-row-btn';
        btn.textContent = 'Use';
        btn.onclick = function() {
          document.getElementById('local-llm-baseurl').value = b.baseURL;
          if (b.models && b.models[0]) document.getElementById('local-llm-model').value = b.models[0].id;
        };
        row.appendChild(label);
        row.appendChild(btn);
        listEl.appendChild(row);
      });
    } catch (e) {
      listEl.innerHTML = '<div style="font-size:12px;color:var(--fau-danger,#f88)">Discovery failed: ' + escapeHtml(e.message) + '</div>';
    }
  }

  async function testLocalLLM() {
    var baseURL = document.getElementById('local-llm-baseurl').value.trim();
    var apiKey  = document.getElementById('local-llm-apikey').value.trim();
    var statusEl = document.getElementById('local-llm-status');
    if (!baseURL) { statusEl.textContent = 'Enter a base URL first.'; return; }
    statusEl.textContent = 'Testing…';
    try {
      var d = await fetchJSON('/api/llm/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseURL: baseURL, apiKey: apiKey })
      });
      if (d.ok) {
        statusEl.textContent = '✓ Reachable · ' + d.latencyMs + 'ms · ' + (d.modelCount || 0) + ' model(s)';
        statusEl.style.color = 'var(--fau-success, #4ade80)';
      } else {
        statusEl.textContent = '✗ ' + (d.error || 'unreachable');
        statusEl.style.color = 'var(--fau-danger, #f88)';
      }
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.style.color = 'var(--fau-danger, #f88)';
    }
  }

  async function saveLocalLLM() {
    var baseURL = document.getElementById('local-llm-baseurl').value.trim();
    var apiKey  = document.getElementById('local-llm-apikey').value.trim();
    var model   = document.getElementById('local-llm-model').value.trim();
    var statusEl = document.getElementById('local-llm-status');
    if (!baseURL) { statusEl.textContent = 'Base URL is required.'; statusEl.style.color = 'var(--fau-danger, #f88)'; return; }
    var overrides = {};
    var oT = document.getElementById('local-llm-override-tools');
    var oV = document.getElementById('local-llm-override-vision');
    if (oT && oT.checked) overrides.tools = true;
    if (oV && oV.checked) overrides.vision = true;
    var body = {
      providerId: 'openai-compat',
      baseURL: baseURL,
      apiKey: apiKey || undefined,
      defaultModel: model || undefined,
      overrides: overrides,
    };
    try {
      var d = await fetchJSON('/api/llm/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      window.faunaLocalLLM.config = d.config;
      statusEl.textContent = '✓ Saved. Local models now in the picker.';
      statusEl.style.color = 'var(--fau-success, #4ade80)';
      var clearBtn = document.getElementById('local-llm-clear-btn');
      if (clearBtn) clearBtn.style.display = '';
      if (typeof loadModels === 'function') await loadModels();
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.style.color = 'var(--fau-danger, #f88)';
    }
  }

  async function clearLocalLLM() {
    var statusEl = document.getElementById('local-llm-status');
    try {
      await fetchJSON('/api/llm/config', { method: 'DELETE' });
      window.faunaLocalLLM.config = null;
      statusEl.textContent = 'Disabled. Falling back to Copilot.';
      statusEl.style.color = 'var(--fau-text-dim)';
      var clearBtn = document.getElementById('local-llm-clear-btn');
      if (clearBtn) clearBtn.style.display = 'none';
      if (typeof loadModels === 'function') await loadModels();
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.style.color = 'var(--fau-danger, #f88)';
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function(c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  // Expose to window for inline onclick handlers.
  window.initLocalLLMSettings = initLocalLLMSettings;
  window.discoverLocalLLM     = discoverLocalLLM;
  window.testLocalLLM         = testLocalLLM;
  window.saveLocalLLM         = saveLocalLLM;
  window.clearLocalLLM        = clearLocalLLM;
})();
