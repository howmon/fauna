// ── Agent Sync — Cross-Device Drafts ─────────────────────────────────────
// Pushes local agent changes to the user's private drafts on the store
// backend and pulls remote drafts that are newer (LWW by updatedAt).
// Activated automatically when a store-token is present in localStorage.

(function() {
  var DEBOUNCE_MS = 1500;
  var pending = Object.create(null);  // slug → timeoutId
  var lastPushAt = Object.create(null); // slug → ms
  var pullInFlight = false;
  var pulledThisSession = false;
  var syncDisabled = false;             // true if backend doesn't expose sync yet

  // Treat these statuses as "sync endpoint not deployed" — disable for the session.
  function isUnsupportedStatus(s) {
    return s === 404 || s === 405 || s === 406 || s === 501;
  }

  function disableSync(reason) {
    if (syncDisabled) return;
    syncDisabled = true;
    // Quiet by default — the store backend is optional. Surface via debug
    // only so the console stays clean for users who never opted into sync.
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[agent-sync] disabled for this session:', reason);
    }
  }

  function storeToken() {
    try { return localStorage.getItem('store-token') || ''; } catch (_) { return ''; }
  }

  function authHeaders() {
    var t = storeToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  function slugFromAgentsPath(pathname) {
    // /api/agents/{slug}[/...] — return slug or null
    var m = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)(?:\/|$)/);
    if (!m) return null;
    if (m[1] === 'import' || m[1] === 'scan-zip') return null;
    return m[1];
  }

  function schedulePush(slug) {
    if (syncDisabled) return;
    if (!storeToken()) return;
    if (!slug) return;
    if (pending[slug]) clearTimeout(pending[slug]);
    pending[slug] = setTimeout(function() {
      delete pending[slug];
      pushAgent(slug);
    }, DEBOUNCE_MS);
  }

  function pushAgent(slug) {
    if (syncDisabled) return Promise.resolve();
    if (!storeToken()) return Promise.resolve();
    lastPushAt[slug] = Date.now();
    return fetch('/api/store/sync/push/' + encodeURIComponent(slug), {
      method: 'POST',
      headers: authHeaders(),
    }).then(function(r) {
      if (r.ok) return;
      if (isUnsupportedStatus(r.status)) {
        disableSync('push ' + slug + ' → ' + r.status);
        return;
      }
      console.warn('[agent-sync] push failed', slug, r.status);
    }).catch(function(e) {
      console.warn('[agent-sync] push error', slug, e && e.message);
    });
  }

  function deleteRemote(slug) {
    if (syncDisabled) return Promise.resolve();
    if (!storeToken() || !slug) return Promise.resolve();
    return fetch('/api/store/sync/' + encodeURIComponent(slug), {
      method: 'DELETE',
      headers: authHeaders(),
    }).then(function(r) {
      if (!r.ok && isUnsupportedStatus(r.status)) disableSync('delete → ' + r.status);
    }).catch(function() {});
  }

  function pullAll() {
    if (syncDisabled) return Promise.resolve(null);
    if (!storeToken()) return Promise.resolve(null);
    if (pullInFlight) return Promise.resolve(null);
    pullInFlight = true;
    return fetch('/api/store/sync/pull', {
      method: 'POST',
      headers: authHeaders(),
    }).then(function(r) {
      if (!r.ok) {
        if (isUnsupportedStatus(r.status)) disableSync('pull → ' + r.status);
        return null;
      }
      return r.json();
    }).catch(function() { return null; })
      .then(function(report) {
        pullInFlight = false;
        if (report && (report.pulled || []).length) {
          if (typeof loadInstalledAgents === 'function') {
            try { loadInstalledAgents(); } catch (_) {}
          }
          if (typeof showToast === 'function') {
            showToast('Synced ' + report.pulled.length + ' agent(s) from your account');
          }
        }
        return report;
      });
  }

  // Intercept fetch to detect mutating /api/agents/* calls.
  var _origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var isAgentsMutation =
      typeof url === 'string' &&
      url.indexOf('/api/agents/') === 0 &&
      (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE');

    var p = _origFetch(input, init);
    if (!isAgentsMutation || !storeToken()) return p;

    return p.then(function(resp) {
      if (!resp || !resp.ok) return resp;
      try {
        if (url.indexOf('/api/agents/import') === 0) {
          // Clone, read name from response JSON, push.
          var clone = resp.clone();
          clone.json().then(function(j) {
            if (j && j.name) schedulePush(j.name);
          }).catch(function() {});
        } else {
          var slug = slugFromAgentsPath(new URL(url, window.location.origin).pathname);
          if (slug) {
            if (method === 'DELETE') deleteRemote(slug);
            else schedulePush(slug);
          }
        }
      } catch (_) {}
      return resp;
    });
  };

  // Pull once per session when we have a token (after a short delay so the
  // rest of the app has a chance to render).
  function tryInitialPull() {
    if (pulledThisSession) return;
    if (!storeToken()) return;
    pulledThisSession = true;
    setTimeout(pullAll, 800);
  }

  document.addEventListener('DOMContentLoaded', tryInitialPull);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    tryInitialPull();
  }

  // Re-pull if the token appears later (sign-in flow).
  window.addEventListener('storage', function(e) {
    if (e.key === 'store-token' && e.newValue && !pulledThisSession) {
      pulledThisSession = true;
      pullAll();
    }
  });

  // Public API
  window.agentSync = {
    push: pushAgent,
    pushSoon: schedulePush,
    pull: function() { pulledThisSession = true; return pullAll(); },
    remove: deleteRemote,
    status: function() {
      return fetch('/api/store/sync', { headers: authHeaders() })
        .then(function(r) { return r.ok ? r.json() : null; })
        .catch(function() { return null; });
    },
  };
})();
