// ── Custom MCP Server Manager ────────────────────────────────────────────────
// Manages the custom MCP servers settings page:
//   - List all configured servers (with live running status)
//   - Add / edit / remove servers
//   - Start / stop individual servers
//   - View recent logs

var mcpMgr = (function () {
  var _servers = [];      // cached list
  var _editingId = null;  // id of server being edited (null = add mode)
  var _showForm = false;
  var _transport = 'stdio'; // current form transport tab
  var _oauthStatus = {};  // id → { authorized }
  var _authModal = null;  // active auth modal state

  // Featured HTTP MCP server presets
  var FEATURED_PRESETS = [
    {
      id: 'preset-m365',
      name: 'Microsoft 365',
      icon: 'ti-brand-office',
      description: 'Outlook, Calendar, OneDrive, Teams, SharePoint & more',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@softeria/ms-365-mcp-server', '--discovery'],
    },
    {
      id: 'preset-m365-work',
      name: 'Microsoft 365 (Work)',
      icon: 'ti-brand-teams',
      description: 'Adds Teams, SharePoint, shared mailboxes & org tools',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@softeria/ms-365-mcp-server', '--org-mode', '--discovery'],
    },
    {
      id: 'preset-github',
      name: 'GitHub',
      icon: 'ti-brand-github',
      description: 'Issues, PRs, code search, repo management',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
    },
    {
      id: 'preset-notion',
      name: 'Notion',
      icon: 'ti-notebook',
      description: 'Databases, pages, comments & blocks',
      transport: 'http',
      url: 'https://api.notion.com/v1/mcp',
    },
    {
      id: 'preset-linear',
      name: 'Linear',
      icon: 'ti-brand-linear',
      description: 'Projects, issues, and team workflows',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
    },
  ];

  // ── API helpers ────────────────────────────────────────────────────────────

  async function _api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(path, opts);
    return r.json();
  }

  // ── Load & render server list ──────────────────────────────────────────────

  async function loadServers() {
    try {
      _servers = await _api('GET', '/api/custom-mcp-servers');
    } catch (_) {
      _servers = [];
    }
    // Load OAuth status for HTTP servers
    await Promise.allSettled(_servers.filter(s => s.transport === 'http').map(async s => {
      try {
        const r = await _api('GET', '/api/custom-mcp-servers/' + s.id + '/oauth/status');
        _oauthStatus[s.id] = r;
      } catch (_) {}
    }));
    renderList();
  }

  function renderList() {
    var el = document.getElementById('mcp-custom-list');
    if (!el) return;

    // Featured presets (only show those not already added)
    var addedUrls = new Set(_servers.filter(s => s.url).map(s => s.url));
    var notAdded = FEATURED_PRESETS.filter(p => !addedUrls.has(p.url));

    var featuredHtml = '';
    if (notAdded.length) {
      featuredHtml =
        '<div class="mcp-featured-section">' +
          '<div class="mcp-featured-title">Featured integrations</div>' +
          '<div class="mcp-featured-grid">' +
          notAdded.map(function (p) {
            return (
              '<div class="mcp-featured-card" onclick="mcpMgr.applyPreset(\'' + p.id + '\')">' +
                '<i class="ti ' + p.icon + ' mcp-featured-icon"></i>' +
                '<div class="mcp-featured-name">' + _esc(p.name) + '</div>' +
                '<div class="mcp-featured-desc">' + _esc(p.description) + '</div>' +
              '</div>'
            );
          }).join('') +
          '</div>' +
        '</div>';
    }

    if (!_servers.length) {
      el.innerHTML =
        featuredHtml +
        '<div class="mcp-empty-row">' +
          '<span>No MCP servers connected</span>' +
          '<button class="mcp-add-btn" onclick="mcpMgr.showForm(null)">' +
            '<i class="ti ti-plus"></i> Add server' +
          '</button>' +
        '</div>';
      return;
    }

    el.innerHTML = _servers.map(function (s) {
      var statusDot = s.running
        ? '<span class="mcp-dot running" title="Running"></span>'
        : '<span class="mcp-dot stopped" title="Stopped"></span>';
      var badge = s.transport === 'http'
        ? '<span class="mcp-transport-badge http">HTTP</span>'
        : '<span class="mcp-transport-badge stdio">STDIO</span>';
      var startStop = s.transport === 'stdio'
        ? (s.running
            ? '<button class="mcp-row-btn" title="Stop" onclick="mcpMgr.stop(\'' + s.id + '\')">' +
                '<i class="ti ti-player-stop"></i></button>'
            : '<button class="mcp-row-btn" title="Start" onclick="mcpMgr.start(\'' + s.id + '\')">' +
                '<i class="ti ti-player-play"></i></button>') +
          '<button class="mcp-row-btn" title="Authenticate (login)" onclick="mcpMgr.openAuthModal(\'' + s.id + '\')">' +
            '<i class="ti ti-login-2"></i></button>'
        : '<button class="mcp-row-btn" title="Refresh tools" onclick="mcpMgr.refreshHttpTools(\'' + s.id + '\')">' +
            '<i class="ti ti-refresh"></i></button>';
      var oauthBadge = '';
      if (s.transport === 'http') {
        var oauthSt = _oauthStatus[s.id];
        oauthBadge = oauthSt && oauthSt.authorized
          ? '<span class="mcp-oauth-badge authorized" title="Authorized">✓ Auth</span>'
          : (s.oauthAuthUrl
              ? '<span class="mcp-oauth-badge unauthorized" title="Not authorized — click to sign in" ' +
                  'onclick="mcpMgr.oauthSignIn(\'' + s.id + '\', \'' + _attr(s.oauthAuthUrl) + '\')" ' +
                  'style="cursor:pointer">Sign in</span>'
              : '');
      }
      return (
        '<div class="mcp-server-row" data-id="' + s.id + '">' +
          '<span class="mcp-row-status">' + statusDot + '</span>' +
          '<span class="mcp-row-name">' + _esc(s.name) + '</span>' +
          badge + oauthBadge +
          '<span class="mcp-row-cmd">' + _esc(s.transport === 'http' ? s.url : s.command) + '</span>' +
          '<div class="mcp-row-actions">' +
            startStop +
            '<button class="mcp-row-btn" title="Edit" onclick="mcpMgr.showForm(\'' + s.id + '\')">' +
              '<i class="ti ti-pencil"></i></button>' +
            '<button class="mcp-row-btn danger" title="Remove" onclick="mcpMgr.remove(\'' + s.id + '\')">' +
              '<i class="ti ti-trash"></i></button>' +
          '</div>' +
        '</div>'
      );
    }).join('') +
    '<div class="mcp-list-footer">' +
      '<button class="mcp-add-btn" onclick="mcpMgr.showForm(null)">' +
        '<i class="ti ti-plus"></i> Add server' +
      '</button>' +
    '</div>' +
    featuredHtml;
  }

  // ── Add / Edit form ────────────────────────────────────────────────────────

  function showForm(id) {
    _editingId = id;
    _showForm = true;
    var server = id ? _servers.find(function (s) { return s.id === id; }) : null;
    _transport = (server && server.transport === 'http') ? 'http' : 'stdio';

    var formEl = document.getElementById('mcp-form-panel');
    if (!formEl) return;

    // Populate args list
    var argsArr = (server && server.args) ? server.args : [''];
    var envArr  = (server && server.env)
      ? Object.entries(server.env).map(function (kv) { return { k: kv[0], v: kv[1] }; })
      : [{ k: '', v: '' }];
    var passthroughArr = (server && server.envPassthrough) ? server.envPassthrough : [''];

    formEl.innerHTML = _buildForm(server, argsArr, envArr, passthroughArr);
    formEl.style.display = '';

    // Hide list, show form
    document.getElementById('mcp-list-panel').style.display = 'none';
    _updateTransportTabs();
  }

  function hideForm() {
    _showForm = false;
    _editingId = null;
    document.getElementById('mcp-form-panel').style.display = 'none';
    document.getElementById('mcp-list-panel').style.display = '';
    loadServers();
  }

  function _buildForm(server, argsArr, envArr, passthroughArr) {
    var title = server ? 'Edit MCP server' : 'Connect to a custom MCP';
    var nameVal       = server ? _attr(server.name) : '';
    var cmdVal        = server ? _attr(server.command || '') : '';
    var urlVal        = server ? _attr(server.url || '') : '';
    var cwdVal        = server ? _attr(server.cwd || '') : '';
    var authHeaderVal = server ? _attr(server.authHeader || '') : '';
    var oauthUrlVal   = server ? _attr(server.oauthAuthUrl || '') : '';

    return (
      '<div class="mcp-form-header">' +
        '<button class="mcp-back-btn" onclick="mcpMgr.hideForm()">' +
          '<i class="ti ti-arrow-left"></i> Back' +
        '</button>' +
        '<div class="mcp-form-title">' + title + '</div>' +
      '</div>' +
      '<div class="mcp-form-body">' +
        '<label class="mcp-field-label">Name</label>' +
        '<input id="mcp-f-name" class="mcp-field-input" type="text" placeholder="MCP server name" value="' + nameVal + '">' +

        '<div class="mcp-transport-tabs">' +
          '<button class="mcp-tab-btn' + (_transport === 'stdio' ? ' active' : '') + '" onclick="mcpMgr.setTransport(\'stdio\')" id="mcp-tab-stdio">STDIO</button>' +
          '<button class="mcp-tab-btn' + (_transport === 'http' ? ' active' : '') + '" onclick="mcpMgr.setTransport(\'http\')" id="mcp-tab-http">Streamable HTTP</button>' +
        '</div>' +

        '<div id="mcp-stdio-fields">' +
          '<label class="mcp-field-label">Command to launch</label>' +
          '<input id="mcp-f-cmd" class="mcp-field-input" type="text" placeholder="openai-dev-mcp serve-sqlite" value="' + cmdVal + '">' +

          '<label class="mcp-field-label">Arguments</label>' +
          '<div id="mcp-args-list">' + _buildArgRows(argsArr) + '</div>' +
          '<button class="mcp-add-row-btn" onclick="mcpMgr.addArg()"><i class="ti ti-plus"></i> Add argument</button>' +

          '<label class="mcp-field-label" style="margin-top:16px">Environment variables</label>' +
          '<div id="mcp-env-list">' + _buildEnvRows(envArr) + '</div>' +
          '<button class="mcp-add-row-btn" onclick="mcpMgr.addEnv()"><i class="ti ti-plus"></i> Add environment variable</button>' +

          '<label class="mcp-field-label" style="margin-top:16px">Environment variable passthrough</label>' +
          '<div id="mcp-passthrough-list">' + _buildPassthroughRows(passthroughArr) + '</div>' +
          '<button class="mcp-add-row-btn" onclick="mcpMgr.addPassthrough()"><i class="ti ti-plus"></i> Add variable</button>' +

          '<label class="mcp-field-label" style="margin-top:16px">Working directory</label>' +
          '<input id="mcp-f-cwd" class="mcp-field-input" type="text" placeholder="~/code" value="' + cwdVal + '">' +
        '</div>' +

        '<div id="mcp-http-fields" style="display:none">' +
          '<label class="mcp-field-label">Server URL</label>' +
          '<input id="mcp-f-url" class="mcp-field-input" type="text" placeholder="https://my-mcp-server.example.com/mcp" value="' + urlVal + '">' +

          '<label class="mcp-field-label" style="margin-top:12px">Authorization header <span class="mcp-field-hint">(optional — e.g. Bearer sk-…)</span></label>' +
          '<input id="mcp-f-authheader" class="mcp-field-input" type="text" placeholder="Bearer sk-xxxxxxxx" value="' + authHeaderVal + '" autocomplete="off">' +

          '<label class="mcp-field-label" style="margin-top:12px">OAuth authorization URL <span class="mcp-field-hint">(optional — enables "Sign in" button)</span></label>' +
          '<input id="mcp-f-oauthurl" class="mcp-field-input" type="text" placeholder="https://auth.example.com/authorize?..." value="' + oauthUrlVal + '">' +
        '</div>' +

        '<div class="mcp-form-actions">' +
          '<button class="mcp-save-btn" onclick="mcpMgr.save()">Save</button>' +
        '</div>' +
      '</div>'
    );
  }

  function _buildArgRows(args) {
    return args.map(function (a, i) {
      return (
        '<div class="mcp-dynamic-row">' +
          '<input class="mcp-field-input mcp-arg-input" type="text" value="' + _attr(a) + '" placeholder="Argument ' + (i + 1) + '">' +
          '<button class="mcp-rm-row-btn" onclick="mcpMgr.removeRow(this)"><i class="ti ti-x"></i></button>' +
        '</div>'
      );
    }).join('');
  }

  function _buildEnvRows(envArr) {
    return envArr.map(function (e) {
      return (
        '<div class="mcp-dynamic-row">' +
          '<input class="mcp-field-input mcp-env-key" type="text" placeholder="Key" value="' + _attr(e.k) + '" style="width:38%">' +
          '<input class="mcp-field-input mcp-env-val" type="text" placeholder="Value" value="' + _attr(e.v) + '" style="flex:1">' +
          '<button class="mcp-rm-row-btn" onclick="mcpMgr.removeRow(this)"><i class="ti ti-x"></i></button>' +
        '</div>'
      );
    }).join('');
  }

  function _buildPassthroughRows(arr) {
    return arr.map(function (v) {
      return (
        '<div class="mcp-dynamic-row">' +
          '<input class="mcp-field-input mcp-pass-input" type="text" value="' + _attr(v) + '" placeholder="VARIABLE_NAME">' +
          '<button class="mcp-rm-row-btn" onclick="mcpMgr.removeRow(this)"><i class="ti ti-x"></i></button>' +
        '</div>'
      );
    }).join('');
  }

  function setTransport(t) {
    _transport = t;
    _updateTransportTabs();
  }

  function _updateTransportTabs() {
    var stdioBtn = document.getElementById('mcp-tab-stdio');
    var httpBtn  = document.getElementById('mcp-tab-http');
    var stdioF   = document.getElementById('mcp-stdio-fields');
    var httpF    = document.getElementById('mcp-http-fields');
    if (!stdioBtn) return;
    stdioBtn.classList.toggle('active', _transport === 'stdio');
    httpBtn.classList.toggle('active', _transport === 'http');
    if (stdioF) stdioF.style.display = _transport === 'stdio' ? '' : 'none';
    if (httpF)  httpF.style.display  = _transport === 'http' ? '' : 'none';
  }

  // Dynamic row helpers
  function addArg() {
    var list = document.getElementById('mcp-args-list');
    if (!list) return;
    var idx = list.querySelectorAll('.mcp-arg-input').length;
    var row = document.createElement('div');
    row.className = 'mcp-dynamic-row';
    row.innerHTML = '<input class="mcp-field-input mcp-arg-input" type="text" placeholder="Argument ' + (idx + 1) + '">' +
      '<button class="mcp-rm-row-btn" onclick="mcpMgr.removeRow(this)"><i class="ti ti-x"></i></button>';
    list.appendChild(row);
  }

  function addEnv() {
    var list = document.getElementById('mcp-env-list');
    if (!list) return;
    var row = document.createElement('div');
    row.className = 'mcp-dynamic-row';
    row.innerHTML = '<input class="mcp-field-input mcp-env-key" type="text" placeholder="Key" style="width:38%">' +
      '<input class="mcp-field-input mcp-env-val" type="text" placeholder="Value" style="flex:1">' +
      '<button class="mcp-rm-row-btn" onclick="mcpMgr.removeRow(this)"><i class="ti ti-x"></i></button>';
    list.appendChild(row);
  }

  function addPassthrough() {
    var list = document.getElementById('mcp-passthrough-list');
    if (!list) return;
    var row = document.createElement('div');
    row.className = 'mcp-dynamic-row';
    row.innerHTML = '<input class="mcp-field-input mcp-pass-input" type="text" placeholder="VARIABLE_NAME">' +
      '<button class="mcp-rm-row-btn" onclick="mcpMgr.removeRow(this)"><i class="ti ti-x"></i></button>';
    list.appendChild(row);
  }

  function removeRow(btn) {
    var row = btn.closest('.mcp-dynamic-row');
    if (row) row.remove();
  }

  // ── Featured preset ───────────────────────────────────────────────────────

  function applyPreset(presetId) {
    var preset = FEATURED_PRESETS.find(function (p) { return p.id === presetId; });
    if (!preset) return;
    _editingId = null;
    _showForm = true;
    _transport = preset.transport || 'http';

    var formEl = document.getElementById('mcp-form-panel');
    if (!formEl) return;

    var argsArr = (preset.args && preset.args.length) ? preset.args : [''];
    formEl.innerHTML = _buildForm(null, argsArr, [{ k: '', v: '' }], ['']);
    formEl.style.display = '';
    document.getElementById('mcp-list-panel').style.display = 'none';
    _updateTransportTabs();

    // Pre-fill fields
    var nameEl = document.getElementById('mcp-f-name');
    if (nameEl) nameEl.value = preset.name || '';

    if (_transport === 'stdio') {
      var cmdEl = document.getElementById('mcp-f-cmd');
      if (cmdEl) cmdEl.value = preset.command || '';
      // Args already injected via _buildForm above
    } else {
      var urlEl = document.getElementById('mcp-f-url');
      if (urlEl) urlEl.value = preset.url || '';
      var oauthEl = document.getElementById('mcp-f-oauthurl');
      if (oauthEl) oauthEl.value = preset.oauthAuthUrl || '';
    }
  }

  // ── STDIO Auth Modal ──────────────────────────────────────────────────────
  // Spawns the server with --login and streams the output so the user can
  // see the device code URL, open it in their browser, and complete auth.

  function openAuthModal(id) {
    var server = _servers.find(function (s) { return s.id === id; });
    if (!server) return;

    // Close any existing modal
    var existing = document.getElementById('mcp-auth-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'mcp-auth-modal';
    modal.className = 'mcp-auth-modal-overlay';
    modal.innerHTML =
      '<div class="mcp-auth-modal">' +
        '<div class="mcp-auth-modal-header">' +
          '<div class="mcp-auth-modal-title"><i class="ti ti-login-2"></i> Authenticate — ' + _esc(server.name) + '</div>' +
          '<button class="mcp-auth-modal-close" onclick="mcpMgr.closeAuthModal()"><i class="ti ti-x"></i></button>' +
        '</div>' +
        '<div class="mcp-auth-modal-hint">Waiting for the server to print a login URL&hellip;</div>' +
        '<div id="mcp-auth-log" class="mcp-auth-log"></div>' +
        '<div class="mcp-auth-modal-footer">' +
          '<button class="mcp-auth-cancel-btn" onclick="mcpMgr.closeAuthModal()">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    _authModal = { id, sse: null };
    _startAuthStream(id);
  }

  function closeAuthModal() {
    if (_authModal && _authModal.sse) {
      _authModal.sse.close();
    }
    _authModal = null;
    var modal = document.getElementById('mcp-auth-modal');
    if (modal) modal.remove();
  }

  function _startAuthStream(id) {
    var logEl = document.getElementById('mcp-auth-log');
    var hintEl = document.querySelector('.mcp-auth-modal-hint');
    var urlPattern = /https?:\/\/[^\s]+/g;
    var codePattern = /[A-Z0-9]{8,12}/g;

    var sse = new EventSource('/api/custom-mcp-servers/' + id + '/auth-stream');
    if (_authModal) _authModal.sse = sse;

    function appendLine(text, cls) {
      if (!logEl) return;
      var line = document.createElement('div');
      line.className = 'mcp-auth-line' + (cls ? ' ' + cls : '');
      // Linkify URLs
      line.innerHTML = _esc(text).replace(/https?:\/\/[^\s]+/g, function (url) {
        return '<a href="' + url + '" target="_blank" class="mcp-auth-url">' + url + '</a>';
      });
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    sse.onmessage = function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (_) { return; }

      if (msg.type === 'start') {
        appendLine(msg.data, 'system');
      } else if (msg.type === 'stdout' || msg.type === 'stderr') {
        appendLine(msg.data, msg.type === 'stderr' ? 'err' : '');
        // Once we see a URL, update hint
        if (urlPattern.test(msg.data) && hintEl) {
          hintEl.textContent = 'Open the URL above in your browser and complete sign-in. This window will close automatically when done.';
        }
      } else if (msg.type === 'error') {
        appendLine('Error: ' + msg.data, 'err');
      } else if (msg.type === 'exit') {
        var code = msg.data;
        appendLine(code === 0 ? '✓ Authentication complete.' : 'Process exited with code ' + code + '.', code === 0 ? 'ok' : 'err');
        sse.close();
        if (code === 0) {
          setTimeout(function () { closeAuthModal(); }, 1800);
        }
      }
    };

    sse.onerror = function () {
      appendLine('Connection to server lost.', 'err');
      sse.close();
    };
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────

  function oauthSignIn(serverId, authUrl) {
    // Open auth URL in system browser; user must manually paste token back.
    // A full OAuth callback server would need a redirect_uri registered with
    // the provider — for now open the URL and show a paste dialog.
    if (typeof electronAPI !== 'undefined' && electronAPI.openExternal) {
      electronAPI.openExternal(authUrl);
    } else {
      window.open(authUrl, '_blank');
    }
    setTimeout(function () {
      var token = prompt('Paste the access token returned by the sign-in flow:');
      if (!token) return;
      _api('POST', '/api/custom-mcp-servers/' + serverId + '/oauth/token', { accessToken: token })
        .then(function () { loadServers(); })
        .catch(function (e) { alert('Failed to set token: ' + e.message); });
    }, 500);
  }

  async function refreshHttpTools(id) {
    try {
      await _api('POST', '/api/custom-mcp-servers/' + id + '/refresh');
    } catch (_) {}
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function save() {
    var name = (document.getElementById('mcp-f-name')?.value || '').trim();
    if (!name) { alert('Please enter a server name.'); return; }

    var payload = { name, transport: _transport };

    if (_transport === 'stdio') {
      var cmd = (document.getElementById('mcp-f-cmd')?.value || '').trim();
      if (!cmd) { alert('Please enter a command to launch.'); return; }
      payload.command = cmd;

      // Args
      var argInputs = document.querySelectorAll('#mcp-args-list .mcp-arg-input');
      payload.args = Array.from(argInputs).map(function (el) { return el.value.trim(); }).filter(Boolean);

      // Env vars
      var envKeys = document.querySelectorAll('#mcp-env-list .mcp-env-key');
      var envVals = document.querySelectorAll('#mcp-env-list .mcp-env-val');
      payload.env = {};
      for (var i = 0; i < envKeys.length; i++) {
        var k = envKeys[i].value.trim();
        if (k) payload.env[k] = envVals[i].value;
      }

      // Passthrough
      var ptInputs = document.querySelectorAll('#mcp-passthrough-list .mcp-pass-input');
      payload.envPassthrough = Array.from(ptInputs).map(function (el) { return el.value.trim(); }).filter(Boolean);

      payload.cwd = (document.getElementById('mcp-f-cwd')?.value || '').trim();
    } else {
      var url = (document.getElementById('mcp-f-url')?.value || '').trim();
      if (!url) { alert('Please enter a server URL.'); return; }
      payload.url = url;

      var authHeader = (document.getElementById('mcp-f-authheader')?.value || '').trim();
      if (authHeader) payload.authHeader = authHeader;

      var oauthAuthUrl = (document.getElementById('mcp-f-oauthurl')?.value || '').trim();
      if (oauthAuthUrl) payload.oauthAuthUrl = oauthAuthUrl;
    }

    try {
      var result;
      if (_editingId) {
        result = await _api('PUT', '/api/custom-mcp-servers/' + _editingId, payload);
      } else {
        result = await _api('POST', '/api/custom-mcp-servers', payload);
      }
      if (!result.ok) { alert('Error: ' + (result.error || 'Unknown error')); return; }
      hideForm();
    } catch (e) {
      alert('Failed to save: ' + e.message);
    }
  }

  // ── Start / stop / remove ─────────────────────────────────────────────────

  async function start(id) {
    await _api('POST', '/api/custom-mcp-servers/' + id + '/start');
    await loadServers();
  }

  async function stop(id) {
    await _api('POST', '/api/custom-mcp-servers/' + id + '/stop');
    await loadServers();
  }

  async function remove(id) {
    var server = _servers.find(function (s) { return s.id === id; });
    var name = server ? server.name : 'this server';
    if (!confirm('Remove "' + name + '"?')) return;
    await _api('DELETE', '/api/custom-mcp-servers/' + id);
    await loadServers();
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function _attr(s) {
    return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    load: loadServers,
    showForm: showForm,
    hideForm: hideForm,
    setTransport: setTransport,
    addArg: addArg,
    addEnv: addEnv,
    addPassthrough: addPassthrough,
    removeRow: removeRow,
    save: save,
    start: start,
    stop: stop,
    remove: remove,
    applyPreset: applyPreset,
    oauthSignIn: oauthSignIn,
    refreshHttpTools: refreshHttpTools,
    openAuthModal: openAuthModal,
    closeAuthModal: closeAuthModal,
  };
})();
