// ── Fauna Cloud Sync — settings page + status pill ────────────────────────
//
// Talks to /api/sync/* on the local Express server. Renders into
// #cloud-sync-mount inside the Settings panel and keeps the sidebar pill
// (#cloud-sync-pill) updated with the pending push count.
//
// State is fetched on each render and after every action (login/logout/
// sync now). We poll every 15 s while the settings page is visible so the
// pending-push count reflects in-flight work without needing SSE.

(function () {
  'use strict';

  var SYNC_BASE = (typeof faunaApiBase === 'function') ? faunaApiBase() : '';
  var _pollTimer = null;
  // Per-project "starting pending count" so we can render a determinate
  // % bar. We use a high-water mark seen since the page mounted: the bar
  // is 0% when current == hwm, 100% when current == 0. Resets to the
  // current value when the queue clears (so a fresh wave of edits
  // doesn't show a stale "98%").
  var _projHwm = Object.create(null);

  function _api(path, opts) {
    return fetch(SYNC_BASE + path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts || {})).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    });
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _fmtTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      var now = Date.now();
      var diff = (now - d.getTime()) / 1000;
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.round(diff / 60) + ' min ago';
      if (diff < 86400) return Math.round(diff / 3600) + ' hr ago';
      return d.toLocaleDateString();
    } catch (_) { return iso; }
  }

  // ── Status pill in the settings nav ───────────────────────────────────
  function _updatePill(status) {
    var pill = document.getElementById('cloud-sync-pill');
    if (!pill) return;
    if (!status || !status.loggedIn) {
      pill.style.display = 'none';
      pill.textContent = '';
      return;
    }
    if (status.pendingPush > 0) {
      pill.style.display = '';
      pill.textContent = String(status.pendingPush);
      pill.title = status.pendingPush + ' change(s) pending push';
    } else {
      pill.style.display = '';
      pill.textContent = '✓';
      pill.title = 'Synced';
    }
  }

  // ── Render: signed-out form ───────────────────────────────────────────
  // The Agent Store sign-in dialog already authenticates against the same
  // backend (see public/js/agent-store.js — token in localStorage['store-token']).
  // We surface that as the primary path so users don't sign in twice.
  // Direct email/password lives behind an Advanced disclosure as a fallback
  // for unusual cases (different server URL, or when the store panel is
  // unavailable).
  function _renderSignedOut(session) {
    var mount = document.getElementById('cloud-sync-mount');
    if (!mount) return;
    var hasStoreUi = (typeof window.openStoreAccount === 'function') ||
                     (typeof window.openAgentStore === 'function');
    mount.innerHTML = [
      '<div style="max-width:520px">',
      '  <h3 style="margin-top:0">Enable Fauna Cloud sync</h3>',
      '  <p class="muted">Sync your conversations and projects across Mac and Windows. Files stay on your machines — only metadata and chat history move through the cloud.</p>',
      '  <div id="cs-error" class="muted" style="color:var(--color-danger);min-height:1.2em;margin:8px 0"></div>',
      (hasStoreUi
        ? '<button class="settings-row-btn primary" id="cs-store-signin-btn">' +
          '  <i class="ti ti-user"></i> Sign in with your Fauna account' +
          '</button>' +
          '<p class="muted" style="font-size:12px;margin:8px 0 16px">' +
          '  Opens the same sign-in used by the Agent Store. After signing in, sync starts automatically.' +
          '</p>'
        : ''),
      '  <details style="margin:8px 0">',
      '    <summary class="muted" style="cursor:pointer">Advanced: sign in with email &amp; password</summary>',
      '    <div class="settings-row" style="margin-top:10px">',
      '      <label>Email</label>',
      '      <input type="email" id="cs-email" class="settings-input" placeholder="you@example.com" autocomplete="username">',
      '    </div>',
      '    <div class="settings-row">',
      '      <label>Password</label>',
      '      <input type="password" id="cs-password" class="settings-input" autocomplete="current-password">',
      '    </div>',
      '    <div class="settings-row">',
      '      <label>Server URL</label>',
      '      <input type="url" id="cs-baseurl" class="settings-input" value="' + _esc(session.baseUrl || '') + '" placeholder="https://agentstore.pointlabel.com">',
      '    </div>',
      '    <button class="settings-row-btn" id="cs-login-btn" style="margin-top:6px">',
      '      <i class="ti ti-cloud-upload"></i> Sign in &amp; enable sync',
      '    </button>',
      '  </details>',
      '</div>'
    ].join('\n');

    var storeBtn = document.getElementById('cs-store-signin-btn');
    if (storeBtn) storeBtn.onclick = _handleStoreSignIn;
    var btn = document.getElementById('cs-login-btn');
    if (btn) btn.onclick = _handleLogin;
    var pw = document.getElementById('cs-password');
    if (pw) pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') _handleLogin(); });
  }

  // ── Render: locked (E2E password prompt) ──────────────────────────────
  // Shown when the sync engine has a valid token but no encryption key.
  // After the user enters the password we POST /api/sync/unlock; on
  // success the engine resumes pulls/pushes immediately.
  function _renderLocked(session) {
    var mount = document.getElementById('cloud-sync-mount');
    if (!mount) return;

    // The locked screen is static — once rendered, there's nothing the
    // background poller or SSE events should update. Bail early if the
    // prompt is already mounted so we don't clobber a password the user
    // is mid-typing. (Without this guard, the 15-second status poll and
    // every push:end/pull:end SSE event wipe the input.)
    var existing = document.getElementById('cs-unlock-pwd');
    if (existing) return;

    var user = session.user || {};
    mount.innerHTML = [
      '<div style="max-width:520px">',
      '  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">',
      '    <i class="ti ti-lock" style="font-size:22px;color:var(--color-primary)"></i>',
      '    <div>',
      '      <div style="font-weight:600;color:var(--color-text)">End-to-end encryption</div>',
      '      <div class="muted" style="font-size:12px;color:var(--color-muted)">Signed in as ' + _esc(user.email || user.name || '') + '</div>',
      '    </div>',
      '  </div>',
      '  <div class="settings-section" style="padding:14px;border-radius:8px;background:var(--color-subtleSurface);border:1px solid var(--color-border);color:var(--color-text)">',
      '    <p style="margin:0 0 8px"><strong>This device is locked.</strong></p>',
      '    <p class="muted" style="font-size:13px;margin:0 0 12px;color:var(--color-muted)">Your conversations, projects, and files are encrypted on this device with a key derived from your account password. Sync stays paused until you unlock.</p>',
      '    <p class="muted" style="font-size:12px;margin:0 0 12px;color:var(--color-muted)">The server only ever sees ciphertext. Your password and key never leave this machine.</p>',
      '    <div class="settings-row" style="margin:0">',
      '      <label>Password</label>',
      '      <input type="password" id="cs-unlock-pwd" class="settings-input" autocomplete="current-password" autofocus>',
      '    </div>',
      '    <button class="settings-row-btn primary" id="cs-unlock-btn" style="margin-top:8px">',
      '      <i class="ti ti-lock-open"></i> Unlock sync',
      '    </button>',
      '    <div id="cs-unlock-msg" class="muted" style="margin-top:8px;min-height:1.2em;font-size:12px"></div>',
      '  </div>',
      '  <div style="margin-top:14px">',
      '    <button class="settings-row-btn" id="cs-logout-btn"><i class="ti ti-logout"></i> Sign out</button>',
      '  </div>',
      '</div>'
    ].join('\n');

    var btn = document.getElementById('cs-unlock-btn');
    if (btn) btn.onclick = _handleUnlock;
    var pw = document.getElementById('cs-unlock-pwd');
    if (pw) pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') _handleUnlock(); });
    var lo = document.getElementById('cs-logout-btn');
    if (lo) lo.onclick = _handleLogout;
  }

  function _handleUnlock() {
    var pw = (document.getElementById('cs-unlock-pwd') || {}).value || '';
    var msg = document.getElementById('cs-unlock-msg');
    if (!pw) { if (msg) { msg.textContent = 'Password required'; msg.style.color = 'var(--color-danger)'; } return; }
    if (msg) { msg.textContent = 'Deriving key (this takes a moment)…'; msg.style.color = ''; }
    _api('/api/sync/unlock', {
      method: 'POST',
      body: JSON.stringify({ password: pw }),
    }).then(function (r) {
      if (!r.ok || !r.body || !r.body.ok) {
        var err = (r.body && r.body.error) || 'Unlock failed';
        if (msg) { msg.textContent = err; msg.style.color = 'var(--color-danger)'; }
        return;
      }
      window.renderCloudSyncPage();
      try { if (typeof _showToast === 'function') _showToast('Unlocked — sync resumed'); } catch (_) {}
    }).catch(function (e) {
      if (msg) { msg.textContent = e.message || 'Network error'; msg.style.color = 'var(--color-danger)'; }
    });
  }

  // ── Render: signed-in dashboard ───────────────────────────────────────
  function _renderSignedIn(session, status) {
    // E2E gate: if encryption is required but we don't have a key yet
    // (typical after Agent Store sign-in, or after a logout/lock), render
    // the unlock prompt INSTEAD of the dashboard. Sync is paused server-
    // side until the user enters their password.
    if (status && status.e2e && status.e2e.required && !status.e2e.unlocked) {
      _renderLocked(session);
      return;
    }
    var mount = document.getElementById('cloud-sync-mount');
    if (!mount) return;
    var user = session.user || {};
    var pending = status.pendingPush || 0;
    var byNs = status.pendingByNamespace || {};
    var progress = status.progress || {};
    var lastCursor = '—';
    try {
      var c = status.cursors || {};
      var keys = Object.keys(c);
      if (keys.length) {
        var latest = keys.map(function (k) { return c[k]; }).sort().pop();
        lastCursor = _fmtTime(latest);
      }
    } catch (_) {}

    // Per-namespace breakdown, e.g. "3 conversation, 1 project". Falls back
    // to a flat total when the engine hasn't grouped (older build).
    var nsRows = (status.namespaces || []).map(function (ns) {
      return _esc(ns) + ': ' + (byNs[ns] || 0);
    }).join('  ·  ') || 'none';

    // Live progress block — only shown while a push or pull is in flight.
    // While pushing, render a real <progress> bar; while pulling, show a
    // throbber + per-namespace counts. Last-sync / last-error rows always
    // show.
    var progressBlock = '';
    if (progress.activeOp === 'backfill') {
      // Backfill is enumeration-driven: we know how many ids have been
      // scanned in the current namespace but the total isn't known until
      // the adapter finishes walking. Render an indeterminate bar with
      // a live counter so the user sees motion instead of "Queueing…"
      // followed by silence.
      //
      // For namespaces like project_file the scan itself is the slow
      // step (SHA-1 every file), so we show the higher of "scanned" and
      // "enqueued" — `scanned` ticks during the walk, `enqueued` ticks
      // after the walk while ids are appended to the journal.
      var ns = progress.backfillNs || '…';
      var nsLabel = (ns === 'project_file') ? 'files'
        : (ns === 'conversation') ? 'conversations'
        : (ns === 'project') ? 'projects'
        : (ns === 'checkpoint') ? 'checkpoints'
        : _esc(ns);
      var scanned = Math.max(progress.backfillScanned || 0, progress.backfillEnqueued || 0);
      progressBlock = [
        '<div style="padding:8px 0;border-top:1px solid var(--color-border);margin-top:4px">',
        '  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">',
        '    <span style="color:var(--color-primary)">● Queueing ' + nsLabel + '</span>',
        '    <span style="color:var(--color-muted)">' + scanned + ' scanned</span>',
        '  </div>',
        '  <div style="height:6px;background:var(--color-border);border-radius:3px;overflow:hidden;position:relative">',
        '    <div class="cs-indeterminate" style="position:absolute;height:100%;width:35%;background:var(--color-primary);animation:cs-slide 1.2s ease-in-out infinite"></div>',
        '  </div>',
        '  <style>@keyframes cs-slide{0%{left:-35%}100%{left:100%}}</style>',
        '</div>'
      ].join('');
    } else if (progress.activeOp === 'push' && progress.pushTotal > 0) {
      var pct = Math.min(100, Math.round((progress.pushed / progress.pushTotal) * 100));
      progressBlock = [
        '<div style="padding:8px 0;border-top:1px solid var(--color-border);margin-top:4px">',
        '  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">',
        '    <span style="color:var(--color-primary)">● Pushing</span>',
        '    <span style="color:var(--color-muted)">' + progress.pushed + ' / ' + progress.pushTotal + '</span>',
        '  </div>',
        '  <div style="height:6px;background:var(--color-border);border-radius:3px;overflow:hidden">',
        '    <div style="height:100%;width:' + pct + '%;background:var(--color-primary);transition:width 200ms"></div>',
        '  </div>',
        '</div>'
      ].join('');
    } else if (progress.activeOp === 'pull') {
      var pulledTotal = 0;
      var pulledRows = Object.keys(progress.pulledByNs || {}).map(function (ns) {
        pulledTotal += progress.pulledByNs[ns];
        return _esc(ns) + ' ' + progress.pulledByNs[ns];
      }).join(' · ') || 'checking…';
      progressBlock = [
        '<div style="padding:8px 0;border-top:1px solid var(--color-border);margin-top:4px;display:flex;justify-content:space-between;font-size:12px">',
        '  <span style="color:var(--color-primary)">● Pulling</span>',
        '  <span style="color:var(--color-muted)">' + pulledRows + '</span>',
        '</div>'
      ].join('');
    }

    var lastSyncRow = progress.lastSyncedAt
      ? '<div style="display:flex;justify-content:space-between;padding:4px 0">' +
        '<span class="muted" style="color:var(--color-muted)">Last sync</span>' +
        '<span style="color:var(--color-success)">' + _esc(_fmtTime(progress.lastSyncedAt)) + '</span></div>'
      : '';

    // Last error is rendered on its own block so the full text wraps
    // and stays readable. Truncating with text-overflow:ellipsis hid the
    // important parts (status code, upstream reason) behind a hover-only
    // title attribute, which most users never discover.
    var lastErrorRow = (progress.lastError && !progress.activeOp)
      ? '<div style="padding:6px 0;font-size:12px;border-top:1px solid var(--color-border);margin-top:4px">' +
        '<div class="muted" style="color:var(--color-danger);margin-bottom:2px">Last error</div>' +
        '<div style="color:var(--color-danger);word-break:break-word;font-family:var(--theme-font, monospace);font-size:11px;line-height:1.4">' +
        _esc(progress.lastError) + '</div>' +
        '</div>'
      : '';

    var e2eBadge = (status.e2e && status.e2e.required && status.e2e.unlocked)
      ? '<span title="All synced data is end-to-end encrypted on this device" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--color-subtleSurface);border:1px solid var(--color-success);color:var(--color-success);margin-top:2px"><i class="ti ti-lock"></i> End-to-end encrypted</span>'
      : '';

    // Preserve the existing Projects subtree across the innerHTML rewrite
    // so per-project bars don't flicker / re-fetch on every 1s poll tick.
    // We snapshot the inner HTML, restore it below, then update bars
    // in place using the latest status.
    var prevProjects = document.getElementById('cs-projects');
    var prevProjectsHtml = (prevProjects && prevProjects.querySelector('.cs-proj-row'))
      ? prevProjects.innerHTML
      : null;

    mount.innerHTML = [
      '<div style="max-width:560px">',
      '  <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">',
      '    <div style="width:40px;height:40px;border-radius:50%;background:var(--color-subtleSurface);border:1px solid var(--color-border);display:flex;align-items:center;justify-content:center">',
      '      <i class="ti ti-user" style="font-size:22px;color:var(--color-primary)"></i>',
      '    </div>',
      '    <div>',
      '      <div style="font-weight:600;color:var(--color-text)">' + _esc(user.name || user.email || 'Signed in') + '</div>',
      '      <div class="muted" style="font-size:12px;color:var(--color-muted)">' + _esc(user.email || '') + '</div>',
      '      ' + e2eBadge,
      '    </div>',
      '  </div>',
      '  <div class="settings-section" style="padding:12px;border-radius:8px;background:var(--color-subtleSurface);border:1px solid var(--color-border);color:var(--color-text);margin-bottom:14px">',
      '    <div style="display:flex;justify-content:space-between;padding:4px 0">',
      '      <span class="muted" style="color:var(--color-muted)">Status</span>',
      '      <span><span style="color:' + (status.running ? 'var(--color-success)' : 'var(--color-danger)') + '">●</span> ' +
            (status.running ? 'Running' : 'Stopped') + '</span>',
      '    </div>',
      '    <div style="display:flex;justify-content:space-between;padding:4px 0">',
      '      <span class="muted" style="color:var(--color-muted)">Pending push</span>',
      '      <span>' + pending + ' change' + (pending === 1 ? '' : 's') + '</span>',
      '    </div>',
      '    <div style="display:flex;justify-content:space-between;padding:4px 0">',
      '      <span class="muted" style="color:var(--color-muted)">By namespace</span>',
      '      <span style="font-family:var(--theme-font, monospace);font-size:12px">' + nsRows + '</span>',
      '    </div>',
      '    <div style="display:flex;justify-content:space-between;padding:4px 0">',
      '      <span class="muted" style="color:var(--color-muted)">Last pull</span>',
      '      <span>' + _esc(lastCursor) + '</span>',
      '    </div>',
      '    <div style="display:flex;justify-content:space-between;padding:4px 0">',
      '      <span class="muted" style="color:var(--color-muted)">Device id</span>',
      '      <span style="font-family:var(--theme-font, monospace);font-size:11px">' + _esc((status.nodeId || '').slice(0, 12)) + '…</span>',
      '    </div>',
      lastSyncRow,
      lastErrorRow,
      progressBlock,
      '  </div>',
      // Per-project section: rendered async after the initial paint so the
      // first frame doesn't block on /api/sync/projects.
      '  <div id="cs-projects" style="margin-bottom:14px"></div>',
      '  <div style="display:flex;gap:8px;flex-wrap:wrap">',
      '    <button class="settings-row-btn primary" id="cs-syncnow-btn">',
      '      <i class="ti ti-refresh"></i> Sync now',
      '    </button>',
      (status.running
        ? '<button class="settings-row-btn" id="cs-pause-btn"><i class="ti ti-pause"></i> Pause sync</button>'
        : '<button class="settings-row-btn" id="cs-resume-btn"><i class="ti ti-play"></i> Resume sync</button>'),
      '    <button class="settings-row-btn" id="cs-logout-btn">',
      '      <i class="ti ti-logout"></i> Sign out',
      '    </button>',
      '  </div>',
      '  <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">',
      '    <button class="settings-row-btn" id="cs-backfill-btn" title="Re-enqueue every existing local conversation, project, and checkpoint. Use this on a fresh device or after a server-side reset.">',
      '      <i class="ti ti-cloud-upload"></i> Upload all existing data',
      '    </button>',
      '    <button class="settings-row-btn" id="cs-change-pw-btn" title="Change your account password. The Master Key stays the same so all synced data remains accessible \u2014 we just rewrap it under your new password.">',
      '      <i class="ti ti-key"></i> Change password',
      '    </button>',
      '  </div>',
      '  <div id="cs-status-line" class="muted" style="margin-top:10px;min-height:1.2em"></div>',
      '</div>'
    ].join('\n');

    var bind = function (id, fn) { var b = document.getElementById(id); if (b) b.onclick = fn; };
    bind('cs-syncnow-btn', _handleSyncNow);
    bind('cs-pause-btn',   _handlePause);
    bind('cs-resume-btn',  _handleResume);
    bind('cs-logout-btn',  _handleLogout);
    bind('cs-backfill-btn', _handleBackfill);
    bind('cs-change-pw-btn', _handleChangePassword);
    // Only do the full Projects re-render once per signed-in mount; the
    // poll handler updates per-project bars in place to avoid flicker
    // and unnecessary /api/sync/projects refetches.
    if (prevProjectsHtml) {
      var freshHost = document.getElementById('cs-projects');
      if (freshHost) {
        freshHost.innerHTML = prevProjectsHtml;
        _bindProjectToggles(freshHost);
      }
      _updateProjectProgress(status);
    } else {
      _renderProjects();
    }
  }

  // ── Per-project sync controls ─────────────────────────────────────────
  // Wires the per-row checkbox change handler. Extracted so we can re-
  // attach handlers after preserving the rendered project list across a
  // _renderSignedIn() innerHTML rewrite.
  function _bindProjectToggles(host) {
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('.cs-proj-row'), function (row) {
      var cb = row.querySelector('.cs-proj-toggle');
      if (!cb || cb._csBound) return;
      cb._csBound = true;
      cb.addEventListener('change', function () {
        var pid = row.getAttribute('data-pid');
        var excluded = !cb.checked; // unchecked = excluded from sync
        cb.disabled = true;
        _api('/api/sync/projects/' + encodeURIComponent(pid) + '/exclude', {
          method: 'POST',
          body: JSON.stringify({ excluded: excluded }),
        }).then(function (resp) {
          cb.disabled = false;
          if (!resp.ok || !resp.body || !resp.body.ok) {
            // Roll back the visual on failure.
            cb.checked = !cb.checked;
            _setStatusLine((resp.body && resp.body.error) || 'Could not update project sync', true);
            return;
          }
          _renderProjects();
        }).catch(function (e) {
          cb.disabled = false;
          cb.checked = !cb.checked;
          _setStatusLine(e.message || 'Network error', true);
        });
      });
    });
  }

  // Fetches the joined project / pending / excluded list from the server
  // and renders it. Each row gets a toggle switch — flipping it POSTs to
  // /api/sync/projects/:id/exclude and re-renders just this section.
  function _renderProjects() {
    var host = document.getElementById('cs-projects');
    if (!host) return;
    host.innerHTML = '<div class="muted" style="color:var(--color-muted);padding:8px 0">Loading projects…</div>';
    _api('/api/sync/projects').then(function (r) {
      if (!r.ok || !r.body) {
        host.innerHTML = '<div class="muted" style="color:var(--color-danger)">Could not load projects</div>';
        return;
      }
      var projects = (r.body.projects || []).slice();
      // Show projects with pending work first, then alphabetical.
      projects.sort(function (a, b) {
        if ((b.pending || 0) !== (a.pending || 0)) return (b.pending || 0) - (a.pending || 0);
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      var orphan = r.body.unassignedPending || 0;
      var rows = projects.map(function (p) {
        var checked = p.excluded ? '' : 'checked';
        var pending = p.pending || 0;
        // Seed / refresh the per-project hwm so the bar has a denominator
        // to compute against on the very next poll.
        if (pending > 0) {
          _projHwm[p.id] = Math.max(_projHwm[p.id] || 0, pending);
        } else {
          delete _projHwm[p.id];
        }
        var hwm = _projHwm[p.id] || 0;
        var pct = hwm > 0 ? Math.max(0, Math.min(100, Math.round(((hwm - pending) / hwm) * 100))) : 100;
        var pendingBadge = pending
          ? '<span class="cs-proj-badge" style="font-size:11px;padding:1px 6px;border-radius:10px;background:var(--color-primary);color:var(--color-background);margin-left:6px">' + pending + '</span>'
          : '<span class="cs-proj-badge" style="display:none"></span>';
        // Progress bar slot: hidden when there's nothing pending and no
        // history of pending (idle project). Shown otherwise so the user
        // can see push progress for THIS project tick by tick.
        var barDisplay = (pending > 0 || hwm > 0) ? 'block' : 'none';
        var barHtml = [
          '<div class="cs-proj-progress" style="display:' + barDisplay + ';width:100%;margin-top:4px;height:4px;background:var(--color-border);border-radius:2px;overflow:hidden">',
          '  <div class="cs-proj-progress-fill" style="height:100%;width:' + pct + '%;background:var(--color-success);transition:width 250ms ease"></div>',
          '</div>',
          '<div class="cs-proj-progress-label" style="display:' + barDisplay + ';font-size:10px;color:var(--color-muted);margin-top:2px">' + pct + '% synced</div>'
        ].join('');
        return [
          '<label class="cs-proj-row" data-pid="' + _esc(p.id) + '" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 4px;border-bottom:1px solid var(--color-border)">',
          '  <span class="cs-proj-main" style="display:flex;flex-direction:column;min-width:0;flex:1">',
          '    <span style="display:flex;align-items:center;gap:8px;min-width:0">',
          '      <span style="color:var(--color-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc(p.name) + '</span>',
          '      ' + pendingBadge,
          '    </span>',
          '    ' + barHtml,
          '  </span>',
          '  <input type="checkbox" class="cs-proj-toggle" ' + checked + ' aria-label="Sync this project">',
          '</label>'
        ].join('');
      }).join('');
      host.innerHTML = [
        '<div class="settings-section" style="padding:12px;border-radius:8px;background:var(--color-subtleSurface);border:1px solid var(--color-border);color:var(--color-text)">',
        '  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">',
        '    <strong style="color:var(--color-text)">Projects</strong>',
        '    <span class="muted" style="font-size:11px;color:var(--color-muted)">Toggle off to keep a project local-only</span>',
        '  </div>',
        '  <div class="cs-proj-scroll" style="max-height:340px;overflow-y:auto;margin:0 -4px;padding:0 4px">',
        rows || '<div class="muted" style="color:var(--color-muted);padding:8px 0">No projects yet.</div>',
        '  </div>',
        orphan ? '<div class="muted" style="color:var(--color-muted);padding:8px 0 0;font-size:12px">+ ' + orphan + ' pending change' + (orphan === 1 ? '' : 's') + ' not attached to a project</div>' : '',
        '</div>'
      ].join('');
      // Bind the toggles.
      _bindProjectToggles(host);
    }).catch(function (e) {
      host.innerHTML = '<div class="muted" style="color:var(--color-danger)">' + _esc(e.message) + '</div>';
    });
  }

  // In-place updater for the per-project bars + pending badge. Called on
  // every poll tick so the user sees push progress without re-fetching
  // /api/sync/projects (which would lose scroll position and flicker).
  function _updateProjectProgress(status) {
    var host = document.getElementById('cs-projects');
    if (!host) return;
    var byProject = (status && status.pendingByProject) || {};
    var rows = host.querySelectorAll('.cs-proj-row');
    Array.prototype.forEach.call(rows, function (row) {
      var pid = row.getAttribute('data-pid');
      if (!pid) return;
      var pending = byProject[pid] || 0;
      // Update hwm: ratchet up on new work, reset when queue drains so
      // the next wave of edits gets a fresh denominator.
      if (pending > 0) {
        _projHwm[pid] = Math.max(_projHwm[pid] || 0, pending);
      } else if (_projHwm[pid]) {
        delete _projHwm[pid];
      }
      var hwm = _projHwm[pid] || 0;
      var pct = hwm > 0 ? Math.max(0, Math.min(100, Math.round(((hwm - pending) / hwm) * 100))) : 100;
      var badge = row.querySelector('.cs-proj-badge');
      if (badge) {
        if (pending > 0) {
          badge.textContent = String(pending);
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      }
      var bar = row.querySelector('.cs-proj-progress');
      var fill = row.querySelector('.cs-proj-progress-fill');
      var label = row.querySelector('.cs-proj-progress-label');
      var visible = (pending > 0 || hwm > 0) ? 'block' : 'none';
      if (bar) bar.style.display = visible;
      if (label) {
        label.style.display = visible;
        label.textContent = pct + '% synced';
      }
      if (fill) fill.style.width = pct + '%';
    });
  }

  // ── Actions ───────────────────────────────────────────────────────────
  function _setStatusLine(text, isError) {
    var el = document.getElementById('cs-status-line') || document.getElementById('cs-error');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isError ? 'var(--color-danger)' : '';
  }

  function _handleLogin() {
    var email = (document.getElementById('cs-email') || {}).value || '';
    var password = (document.getElementById('cs-password') || {}).value || '';
    var baseUrl = (document.getElementById('cs-baseurl') || {}).value || '';
    if (!email || !password) { _setStatusLine('Email and password required', true); return; }
    _setStatusLine('Signing in…', false);
    _api('/api/sync/login', {
      method: 'POST',
      body: JSON.stringify({ email: email, password: password, baseUrl: baseUrl || undefined }),
    }).then(function (r) {
      if (!r.ok || !r.body || !r.body.ok) {
        var msg = (r.body && (r.body.error || r.body.message)) || 'Sign in failed';
        _setStatusLine(msg, true);
        return;
      }
      window.renderCloudSyncPage();
      try { if (typeof _showToast === 'function') _showToast('Signed in to Fauna Cloud'); } catch (_) {}
    }).catch(function (e) { _setStatusLine(e.message || 'Network error', true); });
  }

  // Open the existing Agent Store sign-in dialog. When the user completes
  // sign-in there, the storeLogin() handler in agent-store.js posts the new
  // token to /api/sync/adopt-token (see hook below). On return, this page
  // re-renders against the updated session state.
  function _handleStoreSignIn() {
    try {
      if (typeof window.openStoreAccount === 'function') {
        window.openStoreAccount();
      } else if (typeof window.openAgentStore === 'function') {
        window.openAgentStore();
      }
    } catch (e) { _setStatusLine(e.message || 'Could not open sign-in', true); }
  }

  function _handleLogout() {
    if (!confirm('Sign out of Fauna Cloud? Local data stays; the engine will stop syncing.')) return;
    _api('/api/sync/logout', { method: 'POST' }).then(function () {
      // Also clear the Agent Store session so both stay in lock-step.
      try {
        localStorage.removeItem('store-token');
        localStorage.removeItem('store-account');
        if (typeof window.storeState === 'object' && window.storeState) {
          window.storeState.account = null;
        }
      } catch (_) {}
      window.renderCloudSyncPage();
    });
  }

  function _handleSyncNow() {
    _setStatusLine('Syncing…', false);
    // Fast-poll for live progress while the sync is running. The POST below
    // resolves only when the engine finishes; the polling refreshes the
    // status card every second so the progress bar moves in real time.
    // Kick the first poll quickly so we catch `activeOp` before the user
    // wonders if anything is happening.
    _scheduleNextPoll(200);
    _api('/api/sync/now', { method: 'POST' }).then(function (r) {
      if (!r.ok) { _setStatusLine((r.body && r.body.error) || 'Sync failed', true); return; }
      _setStatusLine('Synced.', false);
      window.renderCloudSyncPage();
    }).catch(function (e) { _setStatusLine(e.message || 'Network error', true); });
  }

  function _handlePause() {
    _api('/api/sync/stop', { method: 'POST' }).then(function () { window.renderCloudSyncPage(); });
  }

  function _handleResume() {
    _api('/api/sync/start', { method: 'POST' }).then(function (r) {
      if (!r.ok) _setStatusLine((r.body && r.body.error) || 'Could not start sync', true);
      window.renderCloudSyncPage();
    });
  }

  // Re-enqueue every existing local record. Useful on a fresh device or
  // after a server-side wipe — without this the engine only pushes future
  // mutations and pre-existing data sits untouched on this machine.
  function _handleBackfill() {
    _setStatusLine('Queueing existing data…', false);
    _scheduleNextPoll(200);
    _api('/api/sync/backfill', { method: 'POST' }).then(function (r) {
      if (!r.ok) { _setStatusLine((r.body && r.body.error) || 'Backfill failed', true); return; }
      _setStatusLine('Backfill queued. Watching progress…', false);
      window.renderCloudSyncPage();
    }).catch(function (e) { _setStatusLine(e.message || 'Network error', true); });
  }

  // ── Change password ──────────────────────────────────────────────────
  // Renders an inline modal with three password fields and POSTs to
  // /api/sync/change-password. The backend updates the account hash AND
  // the wrapped Master Key in the same DB transaction, so we can't end
  // up half-changed (account password updated but the wrap still under
  // the old password, locking the user out of their own data).
  //
  // The Master Key itself does NOT change — the engine just rewraps it
  // under a freshly derived key, so this is a free operation regardless
  // of how much synced data the user has.
  function _handleChangePassword() {
    if (document.getElementById('cs-pw-modal')) return; // already open
    var html = [
      '<div id="cs-pw-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center" role="dialog" aria-modal="true" aria-label="Change password">',
      '  <div style="background:var(--color-background);border:1px solid var(--color-border);border-radius:10px;padding:22px;width:380px;max-width:92vw;color:var(--color-text)">',
      '    <h3 style="margin:0 0 6px;color:var(--color-text)"><i class="ti ti-key"></i> Change password</h3>',
      '    <p class="muted" style="font-size:12px;color:var(--color-muted);margin:0 0 14px;line-height:1.4">',
      '      Updates your account password AND rotates the encryption wrapper for your synced data in one step. Your Master Key stays the same so all existing data remains accessible.',
      '    </p>',
      '    <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-muted)">Current password</label>',
      '    <input type="password" id="cs-pw-old" autocomplete="current-password" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-subtleSurface);color:var(--color-text);margin-bottom:10px;box-sizing:border-box">',
      '    <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-muted)">New password (min 8 chars)</label>',
      '    <input type="password" id="cs-pw-new" autocomplete="new-password" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-subtleSurface);color:var(--color-text);margin-bottom:10px;box-sizing:border-box">',
      '    <label style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-muted)">Confirm new password</label>',
      '    <input type="password" id="cs-pw-confirm" autocomplete="new-password" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-subtleSurface);color:var(--color-text);margin-bottom:14px;box-sizing:border-box">',
      '    <div id="cs-pw-error" style="color:var(--color-danger);font-size:12px;min-height:1.3em;margin-bottom:10px"></div>',
      '    <div style="display:flex;gap:8px;justify-content:flex-end">',
      '      <button class="settings-row-btn" id="cs-pw-cancel">Cancel</button>',
      '      <button class="settings-row-btn primary" id="cs-pw-submit"><i class="ti ti-check"></i> Change password</button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstChild);

    var modal = document.getElementById('cs-pw-modal');
    var oldPw = document.getElementById('cs-pw-old');
    var newPw = document.getElementById('cs-pw-new');
    var confirmPw = document.getElementById('cs-pw-confirm');
    var errEl = document.getElementById('cs-pw-error');
    var submitBtn = document.getElementById('cs-pw-submit');

    function close() {
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    }
    function setError(msg) { if (errEl) errEl.textContent = msg || ''; }

    document.getElementById('cs-pw-cancel').onclick = close;
    // Click outside the dialog body closes too.
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    function submit() {
      var op = oldPw.value || '';
      var np = newPw.value || '';
      var cp = confirmPw.value || '';
      if (!op || !np) { setError('All fields required'); return; }
      if (np.length < 8) { setError('New password must be at least 8 characters'); return; }
      if (np === op) { setError('New password must differ from current'); return; }
      if (np !== cp) { setError('New passwords do not match'); return; }

      submitBtn.disabled = true;
      setError('');
      _api('/api/sync/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: op, newPassword: np }),
      }).then(function (r) {
        submitBtn.disabled = false;
        if (!r.ok || !r.body || !r.body.ok) {
          var msg = (r.body && (r.body.error || r.body.message)) || 'Could not change password';
          setError(msg);
          return;
        }
        close();
        try { if (typeof _showToast === 'function') _showToast('Password changed'); } catch (_) {}
        _setStatusLine('Password changed.', false);
      }).catch(function (e) {
        submitBtn.disabled = false;
        setError(e.message || 'Network error');
      });
    }

    submitBtn.onclick = submit;
    [oldPw, newPw, confirmPw].forEach(function (el) {
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
    setTimeout(function () { try { oldPw.focus(); } catch (_) {} }, 0);
  }

  // ── Adopt an existing Agent Store token ──────────────────────────────
  // The Agent Store sign-in (public/js/agent-store.js) stores its bearer in
  // localStorage['store-token'] for the SAME agentstore backend the sync
  // engine talks to. If we see a token there but the sync session isn't
  // logged in (e.g. fresh install where the user already signed in via
  // Agent Store), hand the token to the main process so it can decrypt-and-
  // persist it and start the engine — no second sign-in needed.
  //
  // Returns a promise that resolves to true if a token was adopted, false
  // otherwise. Idempotent: safe to call on every render.
  function _tryAdoptStoreToken() {
    var token = null;
    try { token = localStorage.getItem('store-token'); } catch (_) {}
    if (!token) return Promise.resolve(false);
    var acct = null;
    try { acct = JSON.parse(localStorage.getItem('store-account') || 'null'); } catch (_) {}
    return _api('/api/sync/adopt-token', {
      method: 'POST',
      body: JSON.stringify({
        token: token,
        // baseUrl: omitted on purpose — main-process default (FAUNA_AGENTSTORE_URL
        // or compiled-in fallback) is the single source of truth for the
        // backend host. /api/store/* already proxies to that same host.
        user: acct ? { email: acct.email, name: acct.name } : undefined,
      }),
    }).then(function (r) {
      if (!r.ok || !r.body || !r.body.ok) {
        // Stale token in localStorage — clear it so we don't keep retrying.
        if (r.status === 401) {
          try { localStorage.removeItem('store-token'); } catch (_) {}
          try { localStorage.removeItem('store-account'); } catch (_) {}
        }
        return false;
      }
      return true;
    }).catch(function () { return false; });
  }

  // ── Public entry point ────────────────────────────────────────────────
  window.renderCloudSyncPage = function () {
    Promise.all([
      _api('/api/sync/session'),
      _api('/api/sync/status'),
    ]).then(function (results) {
      var session = (results[0] && results[0].body) || {};
      var status  = (results[1] && results[1].body) || {};
      if (session.loggedIn) {
        _renderSignedIn(session, status);
        _updatePill(Object.assign({ loggedIn: true }, status));
        return;
      }
      // Not signed in for sync — try to adopt the existing store-token first.
      return _tryAdoptStoreToken().then(function (adopted) {
        if (adopted) {
          // Re-fetch the now-populated session/status and render signed-in.
          return Promise.all([
            _api('/api/sync/session'),
            _api('/api/sync/status'),
          ]).then(function (r2) {
            var s2 = (r2[0] && r2[0].body) || {};
            var st2 = (r2[1] && r2[1].body) || {};
            if (s2.loggedIn) _renderSignedIn(s2, st2);
            else _renderSignedOut(s2);
            _updatePill(Object.assign({ loggedIn: s2.loggedIn }, st2));
          });
        }
        _renderSignedOut(session);
        _updatePill({ loggedIn: false });
      });
    }).catch(function (e) {
      var mount = document.getElementById('cloud-sync-mount');
      if (mount) mount.innerHTML = '<div class="muted" style="color:var(--color-danger)">Could not load sync status: ' + _esc(e.message) + '</div>';
    });
  };

  // Exposed so other modules (e.g. agent-store.js after a successful login)
  // can flip the sync engine on without the user reopening this page.
  window.cloudSyncAdoptToken = _tryAdoptStoreToken;

  // ── Background pill refresher ─────────────────────────────────────────
  // Update the sidebar pill (and the page if visible) every 15 s when idle,
  // or every 1 s while a push/pull is actively running so the progress bar
  // moves in real time. Stops when the document is hidden so it doesn't
  // drain power.
  function _scheduleNextPoll(delayOverride) {
    if (_pollTimer) clearTimeout(_pollTimer);
    if (document.hidden) return;
    var delay = (typeof delayOverride === 'number') ? delayOverride : 15000;
    _pollTimer = setTimeout(function () {
      _api('/api/sync/status').then(function (r) {
        var status = (r && r.body) || {};
        _api('/api/sync/session').then(function (s) {
          var session = (s && s.body) || {};
          _updatePill(Object.assign({ loggedIn: session.loggedIn }, status));
          // Re-render the page only if it's currently visible to avoid
          // wiping a typed-but-unsubmitted email/password.
          var visible = document.querySelector('.settings-page[data-page="cloud-sync"]');
          if (visible && visible.classList.contains('active') && session.loggedIn) {
            _renderSignedIn(session, status);
          }
          // Fast-poll while a sync is in flight; slow-poll when idle.
          var active = status.progress && status.progress.activeOp;
          _scheduleNextPoll(active ? 1000 : 15000);
        });
      }).catch(function () { _scheduleNextPoll(); });
    }, delay);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) _scheduleNextPoll();
  });

  // Kick off pill state on load.
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(function () { window.renderCloudSyncPage(); _scheduleNextPoll(); }, 1500);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(function () { window.renderCloudSyncPage(); _scheduleNextPoll(); }, 1500);
    });
  }
})();
