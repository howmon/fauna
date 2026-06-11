// ── GitHub accounts manager (frontend) ─────────────────────────────────────
//
// Renders a modal listing all linked GitHub accounts, with controls to add a
// new account (via PAT), re-test, or remove existing ones. Exposed as
// window.ghAccounts so the projects hub can open it via "Manage accounts".
//
// API surface (window.ghAccounts):
//   list()       → Promise<Account[]>
//   open()       → opens modal, refreshes list
//   close()      → hides modal
//   add(token, label?) → POST /api/github/accounts
//   test(id)     → POST /api/github/accounts/:id/test
//   remove(id)   → DELETE /api/github/accounts/:id
//
// Server returns metadata only — tokens never reach this code.

(function() {
  var _accounts = [];
  var _onPickCb = null; // when set, clicking an account row resolves a picker

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _toast(msg, isErr) {
    if (typeof window._showToast === 'function') window._showToast(msg, !!isErr);
    else if (isErr) console.error('[gh]', msg);
    else console.log('[gh]', msg);
  }

  async function _list() {
    var r = await fetch('/api/github/accounts');
    if (!r.ok) throw new Error('Could not load GitHub accounts');
    _accounts = await r.json();
    return _accounts;
  }

  async function _add(token, label) {
    var r = await fetch('/api/github/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, label: label || '' }),
    });
    var data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  async function _test(id) {
    var r = await fetch('/api/github/accounts/' + encodeURIComponent(id) + '/test', { method: 'POST' });
    var data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  async function _remove(id) {
    var r = await fetch('/api/github/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) {
      var data = null;
      try { data = await r.json(); } catch (_) {}
      throw new Error((data && data.error) || ('HTTP ' + r.status));
    }
    return true;
  }

  // ── Modal rendering ──────────────────────────────────────────────────────

  function _ensureModal() {
    var el = document.getElementById('gh-accounts-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'gh-accounts-modal';
    el.className = 'gh-modal-backdrop hidden';
    el.innerHTML =
      '<div class="gh-modal" role="dialog" aria-modal="true" aria-labelledby="gh-modal-title">' +
        '<div class="gh-modal-header">' +
          '<h3 id="gh-modal-title"><i class="ti ti-brand-github"></i> GitHub accounts</h3>' +
          '<button class="gh-modal-close" aria-label="Close" onclick="window.ghAccounts.close()"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div class="gh-modal-body">' +
          '<div id="gh-account-list" class="gh-account-list"></div>' +
          '<details class="gh-add-form" id="gh-add-details">' +
            '<summary><i class="ti ti-plus"></i> Add account</summary>' +
            '<div class="gh-add-fields">' +
              '<label class="gh-field-label">Personal access token' +
                '<input type="password" id="gh-add-token" class="gh-input" autocomplete="off" spellcheck="false" placeholder="ghp_… or github_pat_…">' +
              '</label>' +
              '<label class="gh-field-label">Label <span class="gh-field-hint">(optional)</span>' +
                '<input type="text" id="gh-add-label" class="gh-input" placeholder="e.g. work">' +
              '</label>' +
              '<div class="gh-add-hint">Create a token at <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a>. For private repos, grant the <code>repo</code> scope (classic) or <code>contents: read &amp; write</code> + <code>metadata: read</code> (fine-grained).</div>' +
              '<div class="gh-add-actions">' +
                '<button class="gh-btn gh-btn-primary" id="gh-add-submit" onclick="window.ghAccounts._submitAdd()"><i class="ti ti-check"></i> Add account</button>' +
              '</div>' +
            '</div>' +
          '</details>' +
        '</div>' +
      '</div>';
    el.addEventListener('click', function(e) {
      if (e.target === el) _close();
    });
    document.body.appendChild(el);
    return el;
  }

  function _renderList() {
    var host = document.getElementById('gh-account-list');
    if (!host) return;
    if (!_accounts.length) {
      host.innerHTML = '<div class="gh-empty">No accounts yet. Add one below to link GitHub repositories to your projects.</div>';
      return;
    }
    host.innerHTML = _accounts.map(function(a) {
      var avatar = a.avatarUrl
        ? '<img class="gh-account-avatar" src="' + _esc(a.avatarUrl) + '" alt="">'
        : '<div class="gh-account-avatar gh-account-avatar-fallback"><i class="ti ti-user"></i></div>';
      var scopes = (a.scopes || []).length
        ? '<div class="gh-account-scopes">scopes: ' + _esc(a.scopes.join(', ')) + '</div>'
        : '<div class="gh-account-scopes gh-account-scopes-empty">fine-grained PAT (scopes hidden)</div>';
      var err = a.lastError
        ? '<div class="gh-account-error"><i class="ti ti-alert-triangle"></i> ' + _esc(a.lastError) + '</div>'
        : '';
      var clickHandler = _onPickCb
        ? ' onclick="window.ghAccounts._pick(\'' + _esc(a.id) + '\')"'
        : '';
      var pickClass = _onPickCb ? ' gh-account-row-pickable' : '';
      return '<div class="gh-account-row' + pickClass + '" data-id="' + _esc(a.id) + '"' + clickHandler + '>' +
        avatar +
        '<div class="gh-account-meta">' +
          '<div class="gh-account-login">' + _esc(a.login) +
            (a.name && a.name !== a.login ? ' <span class="gh-account-name">' + _esc(a.name) + '</span>' : '') +
          '</div>' +
          scopes +
          err +
        '</div>' +
        '<div class="gh-account-actions">' +
          '<button class="gh-btn gh-btn-ghost" title="Re-test token" onclick="event.stopPropagation();window.ghAccounts._testAndReload(\'' + _esc(a.id) + '\')"><i class="ti ti-refresh"></i></button>' +
          '<button class="gh-btn gh-btn-danger" title="Remove account" onclick="event.stopPropagation();window.ghAccounts._removeAndReload(\'' + _esc(a.id) + '\')"><i class="ti ti-trash"></i></button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function _refresh() {
    try {
      await _list();
      _renderList();
    } catch (e) {
      var host = document.getElementById('gh-account-list');
      if (host) host.innerHTML = '<div class="gh-empty gh-empty-err">' + _esc(e.message) + '</div>';
    }
  }

  function _open(opts) {
    _onPickCb = (opts && typeof opts.onPick === 'function') ? opts.onPick : null;
    var el = _ensureModal();
    el.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    _refresh();
  }

  function _close() {
    var el = document.getElementById('gh-accounts-modal');
    if (el) el.classList.add('hidden');
    document.body.style.overflow = '';
    var resolve = _onPickCb;
    _onPickCb = null;
    if (resolve) resolve(null); // picker dismissed → null
  }

  async function _submitAdd() {
    var tokenEl = document.getElementById('gh-add-token');
    var labelEl = document.getElementById('gh-add-label');
    var btn = document.getElementById('gh-add-submit');
    if (!tokenEl) return;
    var token = (tokenEl.value || '').trim();
    var label = (labelEl && labelEl.value || '').trim();
    if (!token) { _toast('Token is required', true); return; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Validating…'; }
    try {
      var acct = await _add(token, label);
      tokenEl.value = '';
      if (labelEl) labelEl.value = '';
      var det = document.getElementById('gh-add-details');
      if (det) det.open = false;
      _toast('Added @' + acct.login);
      await _refresh();
    } catch (e) {
      _toast(e.message, true);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-check"></i> Add account'; }
    }
  }

  async function _testAndReload(id) {
    try {
      var acct = await _test(id);
      if (acct.lastError) _toast('Test failed: ' + acct.lastError, true);
      else _toast('@' + acct.login + ' is valid');
      await _refresh();
    } catch (e) { _toast(e.message, true); }
  }

  async function _removeAndReload(id) {
    var acct = _accounts.find(function(a) { return a.id === id; });
    var who = acct ? '@' + acct.login : 'this account';
    if (!confirm('Remove ' + who + ' and delete the stored token?')) return;
    try {
      await _remove(id);
      _toast('Removed ' + who);
      await _refresh();
    } catch (e) { _toast(e.message, true); }
  }

  function _pick(id) {
    var cb = _onPickCb;
    _onPickCb = null;
    var el = document.getElementById('gh-accounts-modal');
    if (el) el.classList.add('hidden');
    document.body.style.overflow = '';
    if (cb) cb(_accounts.find(function(a) { return a.id === id; }) || null);
  }

  /**
   * Open the manager in pick mode and resolve to the selected account (or
   * null if the user dismissed it). Used by the project hub link flow.
   */
  function _pickAccount() {
    return new Promise(function(resolve) {
      _open({ onPick: resolve });
    });
  }

  window.ghAccounts = {
    list:               _list,
    open:               _open,
    close:              _close,
    add:                _add,
    test:               _test,
    remove:             _remove,
    pickAccount:        _pickAccount,
    // Internal handlers wired from generated markup:
    _submitAdd:         _submitAdd,
    _testAndReload:     _testAndReload,
    _removeAndReload:   _removeAndReload,
    _pick:              _pick,
  };
})();
