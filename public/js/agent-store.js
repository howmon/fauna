// ── Agent Store — In-App Store Browser, Install, Publish ─────────────────
// Provides the slide-out store panel, search, categories, install/uninstall,
// publish flow, and developer account management.

var storeState = {
  open: false,
  view: 'browse',        // 'browse' | 'detail' | 'publish'
  agents: [],
  categories: [],
  query: '',
  category: '',
  page: 1,
  totalPages: 1,
  selectedAgent: null,   // full detail object
  loading: false,
  publishStatus: null,   // null | 'uploading' | 'submitted' | 'error'
  account: null,          // { email, name, verified, role } or null
  browseTab: 'store',     // 'store' | 'myagents'
  unreadCount: 0,         // notification badge count
  notifications: [],      // notification list
  notifOpen: false,        // notification panel open
  reviewQueue: [],         // admin review queue
  reviewStatus: 'pending',  // current review filter
  myPublishedSlugs: [],      // slugs of user's published agents (for ownership check)
  enterpriseAuth: null       // populated by private-auth.js if present
};

var STORE_BASE = '/api/store'; // Proxy through our Express server

// ── Store API helpers ────────────────────────────────────────────────────

async function storeApi(endpoint, options) {
  var url = STORE_BASE + endpoint;
  var opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
  // Attach auth token if available
  var token = localStorage.getItem('store-token');
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  var r = await fetch(url, opts);
  if (!r.ok) {
    var err = await r.json().catch(function() { return { error: 'Request failed' }; });
    throw new Error(err.error || 'Request failed');
  }
  return r;
}

// ── Open / close store panel ─────────────────────────────────────────────

// Re-fetch account from backend to pick up verified status changes
async function refreshStoreAccount() {
  if (!localStorage.getItem('store-token')) return;
  try {
    var r = await storeApi('/auth/me');
    var d = await r.json();
    if (storeState.account) {
      var wasVerified = storeState.account.verified;
      storeState.account.verified = d.verified || false;
      storeState.account.role = d.role || storeState.account.role;
      storeState.account.name = d.name || storeState.account.name;
      localStorage.setItem('store-account', JSON.stringify(storeState.account));
      // Re-render if verified status changed
      if (!wasVerified && storeState.account.verified) {
        renderStorePanel();
        renderStoreAccountSettings();
        updateTopbarAccount();
      }
    }
  } catch (_) {}
}

function openAgentStore() {
  storeState.open = true;
  storeState.view = 'browse';
  storeState.browseTab = 'myagents';
  if (typeof openSettingsPage === 'function') openSettingsPage('plugins');
  var panel = document.getElementById('agent-store-panel');
  if (panel) {
    panel.style.display = 'flex';
    panel.classList.add('open');
  }
  loadStoreCategories();
  searchStoreAgents();
  loadUnreadCount();
  refreshStoreAccount();
  if (typeof checkStoreSSOSection === 'function') checkStoreSSOSection();
}

function closeAgentStore() {
  storeState.open = false;
  var panel = document.getElementById('agent-store-panel');
  if (panel) {
    panel.classList.remove('open');
    if (!panel.closest('#settings-panel')) {
      setTimeout(function() { panel.style.display = 'none'; }, 250);
    }
  }
}

// ── Store panel renderer ─────────────────────────────────────────────────

function renderStorePanel() {
  var panel = document.getElementById('agent-store-panel');
  if (!panel) return;

  var embeddedInSettings = !!panel.closest('#settings-panel');
  var isReviewer = storeState.account && ['superadmin','admin','reviewer'].indexOf(storeState.account.role) !== -1;

  var headerHtml =
    '<div class="store-header">' +
      '<span class="store-title"><i class="ti ti-package"></i> Agent Store</span>' +
      '<div class="store-header-actions">' +
        '<button class="store-nav-btn' + (storeState.view === 'browse' ? ' active' : '') + '" onclick="storeNavigate(\'browse\')"><i class="ti ti-grid-dots"></i> Browse</button>' +
        (isReviewer ? '<button class="store-nav-btn' + (storeState.view === 'review' ? ' active' : '') + '" onclick="storeNavigate(\'review\')"><i class="ti ti-shield-check"></i> Review</button>' : '') +
        '<button class="store-nav-btn' + (storeState.view === 'publish' ? ' active' : '') + '" onclick="storeNavigate(\'publish\')"><i class="ti ti-upload"></i> Publish</button>' +
      '</div>' +
      (embeddedInSettings ? '' : '<button class="store-close-btn" onclick="closeAgentStore()" title="Close"><i class="ti ti-x"></i></button>') +
    '</div>';

  var bodyHtml = '';
  switch (storeState.view) {
    case 'browse': bodyHtml = renderStoreBrowse(); break;
    case 'detail': bodyHtml = renderStoreDetail(); break;
    case 'review': bodyHtml = renderStoreReview(); break;
    case 'publish': bodyHtml = renderStorePublish(); break;
  }

  panel.innerHTML = headerHtml + '<div class="store-body">' + bodyHtml + '</div>';
}

function storeNavigate(view) {
  if (view === 'account') {
    openStoreAccount();
    return;
  }
  if (view === 'myagents') {
    storeState.view = 'browse';
    storeState.browseTab = 'myagents';
  } else {
    storeState.view = view;
    if (view === 'browse') storeState.browseTab = 'store';
  }
  storeState.notifOpen = false;
  renderStorePanel();
  if (view === 'browse') searchStoreAgents();
  if (view === 'review') loadReviewQueue();
}

// No-op stubs — real implementations injected by /js/private-auth.js if present
async function checkStoreSSOSection() {}
async function storeLoginWithMicrosoft() {}

// ── Browse view ──────────────────────────────────────────────────────────

function switchBrowseTab(tab) {
  storeState.browseTab = tab;
  renderStorePanel();
  if (tab === 'store') searchStoreAgents();
}

function renderStoreBrowse() {
  var tabBar =
    '<div class="browse-tabs">' +
      '<button class="browse-tab' + (storeState.browseTab === 'store' ? ' active' : '') + '" onclick="switchBrowseTab(\'store\')">' +
        '<i class="ti ti-grid-dots"></i> Agent Store</button>' +
      '<button class="browse-tab' + (storeState.browseTab === 'myagents' ? ' active' : '') + '" onclick="switchBrowseTab(\'myagents\')">' +
        '<i class="ti ti-apps"></i> My Agents</button>' +
    '</div>';

  if (storeState.browseTab === 'myagents') {
    return tabBar + renderStoreMyAgents();
  }

  var catOptions = '<option value="">All Categories</option>' +
    storeState.categories.map(function(c) {
      return '<option value="' + escHtml(c.slug) + '"' + (storeState.category === c.slug ? ' selected' : '') + '>' + escHtml(c.name) + '</option>';
    }).join('');

  var searchBar =
    '<div class="store-search-bar">' +
      '<div class="store-search-wrap">' +
        '<i class="ti ti-search"></i>' +
        '<input class="store-search-input" id="store-search" value="' + escHtml(storeState.query) + '" placeholder="Search agents…" oninput="storeState.query=this.value" onkeydown="if(event.key===\'Enter\')searchStoreAgents()">' +
      '</div>' +
      '<select class="store-cat-select" onchange="storeState.category=this.value;searchStoreAgents()">' + catOptions + '</select>' +
    '</div>';

  var agentGrid = '';
  if (storeState.loading) {
    agentGrid = '<div class="store-loading"><div class="builder-loading"><i class="ti ti-loader"></i> Loading agents…</div></div>';
  } else if (!storeState.agents.length) {
    agentGrid = '<div class="store-empty"><i class="ti ti-package-off"></i><p>No agents found</p></div>';
  } else {
    agentGrid = '<div class="store-grid">' +
      storeState.agents.map(function(a) {
        var scoreBadge = a.scanScore >= 90 ? '<i class="ti ti-circle-check" style="color:#22c55e"></i>' : a.scanScore >= 80 ? '<i class="ti ti-alert-triangle" style="color:#eab308"></i>' : '<i class="ti ti-circle-x" style="color:#ef4444"></i>';
        var installed = isAgentInstalled(a.slug);
        var deprecatedBadge = a.deprecated ? '<span class="store-deprecated-badge"><i class="ti ti-alert-triangle"></i> Deprecated</span>' : '';
        var typeBadge = a.hasMcp
          ? '<span class="store-type-badge mcp" title="Uses ' + (a.mcpCount || '') + ' MCP server' + (a.mcpCount > 1 ? 's' : '') + '"><i class="ti ti-plug"></i> MCP</span>'
          : '<span class="store-type-badge agent"><i class="ti ti-robot"></i> Agent</span>';
        var installBtn = installed ?
          '<button class="store-card-btn installed" onclick="event.stopPropagation();uninstallStoreAgent(\'' + escHtml(a.slug) + '\')"><i class="ti ti-circle-check"></i> Installed</button>' :
          '<button class="store-card-btn" onclick="event.stopPropagation();installStoreAgent(\'' + escHtml(a.slug) + '\')">Install</button>';

        return '<div class="store-card" onclick="viewStoreAgent(\'' + escHtml(a.slug) + '\')">' +
          '<div class="store-card-icon"><i class="ti ' + escHtml(a.icon || 'ti-robot') + '"></i></div>' +
          '<div class="store-card-info">' +
            '<div class="store-card-name">' + escHtml(a.displayName) + deprecatedBadge + typeBadge + '</div>' +
            '<div class="store-card-author">by ' + escHtml(a.author ? a.author.name : 'Unknown') + (a.author && a.author.verified ? ' <i class="ti ti-rosette-discount-check" style="color:var(--accent)"></i>' : '') + '</div>' +
            '<div class="store-card-meta">' +
              '<span>' + scoreBadge + ' ' + (a.scanScore || '—') + '</span>' +
              '<span>v' + escHtml(a.version || '1.0.0') + '</span>' +
              '<span>' + formatDownloads(a.downloads || 0) + ' installs</span>' +
              (a.rating > 0 ? '<span><i class="ti ti-star-filled" style="color:#eab308;font-size:12px"></i> ' + Number(a.rating).toFixed(1) + ' <span style="opacity:0.6">(' + (a.ratingCount || 0) + ')</span></span>' : '') +
            '</div>' +
            '<div class="store-card-desc">' + escHtml((a.description || '').substring(0, 80)) + '</div>' +
          '</div>' +
          '<div class="store-card-actions">' + installBtn + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // Pagination
  var pagHtml = '';
  if (storeState.totalPages > 1) {
    pagHtml = '<div class="store-pagination">';
    if (storeState.page > 1) pagHtml += '<button class="store-pag-btn" onclick="storeState.page--;searchStoreAgents()"><i class="ti ti-arrow-left"></i></button>';
    pagHtml += '<span class="store-pag-info">Page ' + storeState.page + ' of ' + storeState.totalPages + '</span>';
    if (storeState.page < storeState.totalPages) pagHtml += '<button class="store-pag-btn" onclick="storeState.page++;searchStoreAgents()"><i class="ti ti-arrow-right"></i></button>';
    pagHtml += '</div>';
  }

  return tabBar + searchBar + agentGrid + pagHtml;
}

function formatDownloads(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function isAgentInstalled(slug) {
  return installedAgents.some(function(a) { return a.name === slug; });
}

// ── Detail view ──────────────────────────────────────────────────────────

function renderStoreDetail() {
  var a = storeState.selectedAgent;
  if (!a) return '<div class="store-loading"><div class="builder-loading"><i class="ti ti-loader"></i> Loading…</div></div>';

  var scoreBadge = a.scanScore >= 90 ? '<i class="ti ti-circle-check" style="color:#22c55e"></i>' : a.scanScore >= 80 ? '<i class="ti ti-alert-triangle" style="color:#eab308"></i>' : '<i class="ti ti-circle-x" style="color:#ef4444"></i>';
  var installed = isAgentInstalled(a.slug);

  var permsHtml = '';
  if (a.permissions) {
    var permItems = [];
    if (a.permissions.shell) permItems.push('<span class="store-perm"><i class="ti ti-terminal-2"></i> Shell</span>');
    if (a.permissions.browser) permItems.push('<span class="store-perm"><i class="ti ti-world-www"></i> Browser</span>');
    if (a.permissions.figma) permItems.push('<span class="store-perm"><i class="ti ti-vector-triangle"></i> Figma</span>');
    if (a.permissions.fileRead && a.permissions.fileRead.length) permItems.push('<span class="store-perm"><i class="ti ti-folder"></i> Read: ' + escHtml(a.permissions.fileRead.join(', ')) + '</span>');
    if (a.permissions.fileWrite && a.permissions.fileWrite.length) permItems.push('<span class="store-perm"><i class="ti ti-file-pencil"></i> Write: ' + escHtml(a.permissions.fileWrite.join(', ')) + '</span>');
    if (a.permissions.network && !a.permissions.network.blockAll) permItems.push('<span class="store-perm"><i class="ti ti-world"></i> Network: ' + escHtml((a.permissions.network.allowedDomains || []).join(', ') || 'all') + '</span>');
    if (permItems.length) permsHtml = '<div class="store-detail-section"><h4>Permissions</h4><div class="store-perms">' + permItems.join('') + '</div></div>';
  }

  var scanHtml = '';
  if (a.scanDetails) {
    var checks = Object.entries(a.scanDetails);
    scanHtml = '<div class="store-detail-section"><h4>Security Scan</h4><div class="store-scan-details">' +
      checks.map(function(entry) {
        var icon = entry[1] === 'pass' ? '<i class="ti ti-circle-check" style="color:#22c55e"></i>' : entry[1] === 'warning' ? '<i class="ti ti-alert-triangle" style="color:#eab308"></i>' : '<i class="ti ti-circle-x" style="color:#ef4444"></i>';
        return '<div class="store-scan-row">' + icon + ' ' + escHtml(entry[0]) + '</div>';
      }).join('') +
    '</div></div>';
  }

  var canEdit = storeState.selectedAgentOwnership &&
    (storeState.selectedAgentOwnership.isOwner || storeState.selectedAgentOwnership.isAdmin);

  var isSuperAdmin = storeState.account && storeState.account.role === 'superadmin';

  var subAgentsHtml = '';
  if (a.subAgents && a.subAgents.length) {
    subAgentsHtml = '<div class="store-detail-section"><h4><i class="ti ti-git-branch"></i> Sub-Agents (' + a.subAgents.length + ')</h4>' +
      '<div class="store-subagents-list">' +
      a.subAgents.map(function(s) {
        return '<div class="store-subagent-row">' +
          '<i class="ti ' + escHtml(s.icon || 'ti-robot') + '"></i>' +
          '<div class="store-subagent-info">' +
            '<span class="store-subagent-name">' + escHtml(s.displayName || s.name) + '</span>' +
            '<span class="store-subagent-desc">' + escHtml(s.description || '') + '</span>' +
          '</div>' +
        '</div>';
      }).join('') +
      '</div></div>';
  }

  var deprecationWarning = '';
  if (a.deprecated) {
    deprecationWarning = '<div class="store-deprecation-banner">' +
      '<i class="ti ti-alert-triangle"></i>' +
      '<div><strong>Deprecated</strong>' +
        (a.deprecationReason ? '<span> — ' + escHtml(a.deprecationReason) + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  var adminActionsHtml = '';
  if (isSuperAdmin) {
    adminActionsHtml = '<div class="store-admin-actions">' +
      '<h4><i class="ti ti-shield-lock"></i> Admin Actions</h4>' +
      '<div class="store-admin-btns">' +
        (a.status === 'approved' ? '<button class="builder-btn secondary small" onclick="adminUnpublish(\'' + escHtml(a.slug) + '\')"><i class="ti ti-eye-off"></i> Unpublish</button>' : '') +
        (!a.deprecated ? '<button class="builder-btn secondary small" onclick="adminDeprecate(\'' + escHtml(a.slug) + '\')"><i class="ti ti-alert-triangle"></i> Deprecate</button>' : '') +
        '<button class="builder-btn secondary small admin-danger" onclick="adminDeleteAgent(\'' + escHtml(a.slug) + '\')"><i class="ti ti-trash"></i> Delete</button>' +
      '</div>' +
      '<div id="admin-action-reason"></div>' +
    '</div>';
  }

  return '<div class="store-detail">' +
    '<button class="store-back-btn" onclick="storeNavigate(\'browse\')"><i class="ti ti-arrow-left"></i> Back to Browse</button>' +
    deprecationWarning +
    '<div class="store-detail-header">' +
      '<div class="store-detail-icon"><i class="ti ' + escHtml(a.icon || 'ti-robot') + '"></i></div>' +
      '<div class="store-detail-info">' +
        '<div class="store-detail-name">' + escHtml(a.displayName) + '</div>' +
        '<div class="store-detail-author">by ' + escHtml(a.author ? a.author.name : 'Unknown') + (a.author && a.author.verified ? ' <span class="store-verified"><i class="ti ti-rosette-discount-check"></i> Verified</span>' : '') + '</div>' +
        '<div class="store-detail-meta">' +
          '<span>' + scoreBadge + ' ' + (a.scanScore || '—') + '/100</span>' +
          '<span>v' + escHtml(a.version || '1.0.0') + '</span>' +
          '<span>' + formatDownloads(a.downloads || 0) + ' installs</span>' +
          (a.rating > 0 ? '<span><i class="ti ti-star-filled" style="color:#eab308"></i> ' + Number(a.rating).toFixed(1) + ' (' + (a.ratingCount || 0) + ' reviews)</span>' : '') +
          '<span>' + escHtml(a.category || '') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="store-detail-actions">' +
        (canEdit ? '<button class="builder-btn secondary" onclick="editPublishedAgent(\'' + escHtml(a.slug) + '\')"><i class="ti ti-pencil"></i> Edit</button>' : '') +
        (installed ?
          '<button class="builder-btn secondary" onclick="uninstallStoreAgent(\'' + escHtml(a.slug) + '\')"><i class="ti ti-trash"></i> Uninstall</button>' :
          '<button class="builder-btn primary" onclick="installStoreAgent(\'' + escHtml(a.slug) + '\')"><i class="ti ti-download"></i> Install</button>') +
      '</div>' +
    '</div>' +
    '<div class="store-detail-section"><h4>Description</h4><p>' + escHtml(a.description || 'No description') + '</p></div>' +
    permsHtml + subAgentsHtml + scanHtml +
    (a.changelog ? '<div class="store-detail-section"><h4>Changelog</h4><p>' + escHtml(a.changelog) + '</p></div>' : '') +
    (a.publishedAt ? '<div class="store-detail-section store-detail-footer">Published ' + new Date(a.publishedAt).toLocaleDateString() + '</div>' : '') +
    adminActionsHtml +
  '</div>';
}

// ── Publish view ─────────────────────────────────────────────────────────

function renderStorePublish() {
  if (!storeState.account) {
    return '<div class="store-publish">' +
      '<div class="builder-empty-state"><i class="ti ti-lock"></i><p>Sign in to your developer account to publish agents.</p></div>' +
      '<button class="builder-btn primary" onclick="openStoreAccount()"><i class="ti ti-user"></i> Sign In / Register</button>' +
    '</div>';
  }

  if (storeState.publishStatus === 'submitted') {
    var vMsg = storeState.publishedVersion ? ' (v' + escHtml(storeState.publishedVersion) + ')' : '';
    return '<div class="store-publish">' +
      '<div class="import-result"><i class="ti ti-circle-check" style="font-size:36px;color:#4ade80"></i>' +
      '<div class="import-result-msg">Agent' + vMsg + ' submitted for review!<br>You\'ll be notified when it\'s approved.</div>' +
      '<button class="builder-btn primary" onclick="storeState.publishStatus=null;storeState.publishedVersion=null;renderStorePanel()">OK</button></div>' +
    '</div>';
  }

  // List installed agents available for publishing (only user-created, not store-installed)
  var publishable = installedAgents.filter(function(a) {
    return !(a._meta && a._meta.installedFromStore);
  });

  var agentList = publishable.length ?
    publishable.map(function(a) {
      var scanBadge = getScanBadgeHtml(a.name) || '<span class="scan-badge"><i class="ti ti-circle" style="color:#9ca3af"></i></span>';
      return '<div class="store-publish-item">' +
        '<i class="ti ' + escHtml(a.icon || 'ti-robot') + '"></i>' +
        '<div class="store-publish-info">' +
          '<span class="store-publish-name">' + escHtml(a.displayName || a.name) + '</span>' +
          '<span class="store-publish-desc">' + escHtml(a.description || '') + '</span>' +
        '</div>' +
        scanBadge +        '<button class="builder-btn secondary small" onclick="closeAgentStore();openAgentBuilder(\'' + escHtml(a.name) + '\')" title="Edit agent"><i class="ti ti-pencil"></i></button>' +        '<button class="builder-btn primary small" onclick="publishAgent(\'' + escHtml(a.name) + '\')"><i class="ti ti-upload"></i> Publish</button>' +
      '</div>';
    }).join('') :
    '<div class="builder-empty-state"><i class="ti ti-package"></i><p>No agents to publish. Create one first!</p></div>';

  return '<div class="store-publish">' +
    '<p class="builder-hint-block">Select an agent to publish to the store. It will be scanned and submitted for admin review. Minimum security score: 80/100.</p>' +
    '<div class="store-publish-list">' + agentList + '</div>' +
  '</div>';
}

// ── Account view ─────────────────────────────────────────────────────────

function renderStoreAccount() {
  if (storeState.account) {
    return '<div class="store-account">' +
      '<div class="store-account-card">' +
        '<i class="ti ti-user-circle" style="font-size:36px;color:var(--accent)"></i>' +
        '<div class="store-account-info">' +
          '<div class="store-account-name">' + escHtml(storeState.account.name) + '</div>' +
          '<div class="store-account-email">' + escHtml(storeState.account.email) + '</div>' +
          (storeState.account.verified ? '<span class="store-verified"><i class="ti ti-rosette-discount-check"></i> Verified Developer</span>' : '<span class="store-unverified">Pending verification</span>') +
        '</div>' +
      '</div>' +
      '<button class="builder-btn secondary" onclick="storeLogout()"><i class="ti ti-logout"></i> Sign Out</button>' +
    '</div>';
  }

  return '<div class="store-account">' +
    '<div class="store-account-tabs">' +
      '<button class="store-tab-btn active" id="store-login-tab" onclick="storeShowTab(\'login\')">Sign In</button>' +
      '<button class="store-tab-btn" id="store-register-tab" onclick="storeShowTab(\'register\')">Register</button>' +
    '</div>' +
    '<div id="store-login-form" class="store-auth-form">' +
      '<input class="builder-input" id="store-login-email" type="email" placeholder="Email">' +
      '<input class="builder-input" id="store-login-password" type="password" placeholder="Password">' +
      '<button class="builder-btn primary" onclick="storeLogin()"><i class="ti ti-login"></i> Sign In</button>' +
      '<div id="store-login-error" class="store-auth-error"></div>' +
      (window._storeSSO ? window._storeSSO.renderLoginExtra() : '') +
    '</div>' +
    '<div id="store-register-form" class="store-auth-form" style="display:none">' +
      '<input class="builder-input" id="store-register-name" placeholder="Developer Name">' +
      '<input class="builder-input" id="store-register-email" type="email" placeholder="Email">' +
      '<input class="builder-input" id="store-register-password" type="password" placeholder="Password">' +
      '<button class="builder-btn primary" onclick="storeRegister()"><i class="ti ti-user-plus"></i> Create Account</button>' +
      '<div id="store-register-error" class="store-auth-error"></div>' +
    '</div>' +
  '</div>';
}

function renderStoreAccountSettings() {
  var panel = document.getElementById('agent-account-panel');
  if (!panel) return;
  panel.innerHTML = renderStoreAccount();
}

function storeShowTab(tab) {
  document.getElementById('store-login-form').style.display = tab === 'login' ? 'flex' : 'none';
  document.getElementById('store-register-form').style.display = tab === 'register' ? 'flex' : 'none';
  document.getElementById('store-login-tab').classList.toggle('active', tab === 'login');
  document.getElementById('store-register-tab').classList.toggle('active', tab === 'register');
}

// ── Store API calls ──────────────────────────────────────────────────────

async function loadStoreCategories() {
  try {
    var r = await storeApi('/categories');
    var d = await r.json();
    storeState.categories = d.categories || d || [];
  } catch (_) {
    storeState.categories = [
      { slug: 'productivity', name: 'Productivity', icon: 'ti-stars' },
      { slug: 'development', name: 'Development', icon: 'ti-code' },
      { slug: 'design', name: 'Design', icon: 'ti-palette' },
      { slug: 'research', name: 'Research', icon: 'ti-search' },
      { slug: 'writing', name: 'Writing', icon: 'ti-pencil' },
      { slug: 'data', name: 'Data & Analysis', icon: 'ti-chart-bar' },
      { slug: 'other', name: 'Other', icon: 'ti-dots' }
    ];
  }
}

async function searchStoreAgents() {
  storeState.loading = true;
  renderStorePanel();

  try {
    var params = '?page=' + storeState.page;
    if (storeState.query) params += '&q=' + encodeURIComponent(storeState.query);
    if (storeState.category) params += '&category=' + encodeURIComponent(storeState.category);

    var r = await storeApi('/agents' + params);
    var d = await r.json();

    storeState.agents = d.agents || d.data || [];
    storeState.totalPages = d.totalPages || d.last_page || 1;
  } catch (_) {
    storeState.agents = [];
    storeState.totalPages = 1;
  }

  storeState.loading = false;
  renderStorePanel();
}

async function viewStoreAgent(slug) {
  storeState.view = 'detail';
  storeState.selectedAgent = null;
  storeState.selectedAgentOwnership = null;
  renderStorePanel();

  try {
    var r = await storeApi('/agents/' + encodeURIComponent(slug));
    storeState.selectedAgent = await r.json();
  } catch (e) {
    storeState.selectedAgent = { slug: slug, displayName: slug, description: 'Failed to load: ' + e.message, scanScore: 0 };
  }
  renderStorePanel();

  // Check ownership in background if signed in
  if (storeState.account && localStorage.getItem('store-token')) {
    try {
      var ow = await storeApi('/agents/' + encodeURIComponent(slug) + '/ownership');
      storeState.selectedAgentOwnership = await ow.json();
      renderStorePanel(); // Re-render with edit button if owner/admin
    } catch (_) {}
  }
}

async function installStoreAgent(slug) {
  showToast('Installing ' + slug + '…');
  try {
    // Download zip directly through proxy
    var _zipToken = localStorage.getItem('store-token');
    var zipR = await fetch('/api/store/agents/' + encodeURIComponent(slug) + '/zip', {
      headers: _zipToken ? { 'Authorization': 'Bearer ' + _zipToken } : {}
    });
    if (!zipR.ok) {
      var errText = await zipR.text();
      showToast('Download failed: ' + (errText || zipR.status)); return;
    }
    var buf = await zipR.arrayBuffer();

    // Import the zip (force overwrite if already installed locally)
    var alreadyInstalled = isAgentInstalled(slug);
    var importUrl = '/api/agents/import' + (alreadyInstalled ? '?force=1' : '');
    var importR = await fetch(importUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: buf
    });
    var result = await importR.json();
    if (result.error) {
      // 409 conflict: agent with same name already exists locally — offer to overwrite
      if (importR.status === 409 || (result.error && result.error.includes('already exists'))) {
        if (confirm(result.error + '\n\nReinstall and overwrite the existing agent?')) {
          var forceR = await fetch('/api/agents/import?force=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: buf
          });
          var forceResult = await forceR.json();
          if (forceResult.error) { showToast('Import failed: ' + forceResult.error); return; }
          result = forceResult;
        } else {
          return;
        }
      } else {
        showToast('Import failed: ' + result.error); return;
      }
    }

    var authorEmail = storeState.account ? storeState.account.email : '';

    // Save meta
    await fetch('/api/agents/' + encodeURIComponent(result.name) + '/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeSlug: slug,
        installedFromStore: true,
        installedAt: new Date().toISOString(),
        storeVersion: '1.0',
        installedBy: authorEmail
      })
    });

    await loadInstalledAgents();
    renderAgentList();
    renderStorePanel();
    showToast(slug + ' installed successfully!');
  } catch (e) {
    showToast('Install failed: ' + e.message);
  }
}

async function uninstallStoreAgent(slug) {
  if (!confirm('Uninstall "' + slug + '"?')) return;
  try {
    var r = await fetch('/api/agents/' + encodeURIComponent(slug), { method: 'DELETE' });
    var d = await r.json();
    if (d.error) { showToast('Uninstall failed: ' + d.error); return; }

    // Deactivate if active
    if (activeAgent && activeAgent.name === slug) {
      deactivateAgent(null);
    }

    await loadInstalledAgents();
    renderAgentList();
    renderStorePanel();
    showToast(slug + ' uninstalled');
  } catch (e) {
    showToast('Uninstall failed: ' + e.message);
  }
}

// ── Publish flow ─────────────────────────────────────────────────────────

async function publishAgent(agentName) {
  if (!storeState.account) {
    showToast('Sign in to publish');
    openStoreAccount();
    return;
  }

  // First scan
  showToast('Scanning ' + agentName + ' before publish…');
  var scanR = await fetch('/api/agents/' + encodeURIComponent(agentName) + '/scan', { method: 'POST' });
  var scanReport = await scanR.json();

  if (scanReport.score < 80) {
    showToast('Security score ' + scanReport.score + '/100 — minimum 80 required to publish');
    showScanReport(scanReport);
    return;
  }

  // Export zip
  storeState.publishStatus = 'uploading';
  renderStorePanel();

  try {
    // Get agent data
    var ar = await fetch('/api/agents/' + encodeURIComponent(agentName));
    var agentData = await ar.json();

    var exportR = await fetch('/api/agent-builder/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agentData)
    });

    if (!exportR.ok) throw new Error('Export failed');
    var zipBlob = await exportR.blob();

    // Upload to store
    var form = new FormData();
    form.append('agent', zipBlob, agentName + '.zip');
    form.append('scanScore', String(scanReport.score));

    var uploadR = await storeApi('/publish', {
      method: 'POST',
      headers: {}, // Let browser set multipart boundary
      body: form
    });

    var result = await uploadR.json();
    if (result.error) throw new Error(result.error);

    storeState.publishStatus = 'submitted';
    storeState.publishedVersion = result.version || null;
    renderStorePanel();
  } catch (e) {
    storeState.publishStatus = 'error';
    renderStorePanel();
    showToast('Publish failed: ' + e.message);
  }
}

// ── Edit Published Agent (owner / admin inline form) ─────────────────────

function editPublishedAgent(slug) {
  var a = storeState.selectedAgent;
  if (!a) return;

  var panel = document.querySelector('.store-detail');
  if (!panel) return;

  // Replace description section with editable form
  var editHtml =
    '<div class="store-edit-form">' +
      '<h4>Edit Published Agent</h4>' +
      '<label class="builder-label">Display Name</label>' +
      '<input class="builder-input" id="edit-pub-name" value="' + escHtml(a.displayName || '') + '">' +
      '<label class="builder-label">Description</label>' +
      '<textarea class="builder-textarea" id="edit-pub-desc" rows="3">' + escHtml(a.description || '') + '</textarea>' +
      '<label class="builder-label">Icon (ti-* class)</label>' +
      '<input class="builder-input" id="edit-pub-icon" value="' + escHtml(a.icon || 'ti-robot') + '">' +
      '<div class="store-edit-actions">' +
        '<button class="builder-btn primary" onclick="savePublishedAgent(\'' + escHtml(slug) + '\')"><i class="ti ti-check"></i> Save</button>' +
        '<button class="builder-btn secondary" onclick="viewStoreAgent(\'' + escHtml(slug) + '\')"><i class="ti ti-x"></i> Cancel</button>' +
      '</div>' +
    '</div>';

  // Insert below the header
  var existingForm = panel.querySelector('.store-edit-form');
  if (existingForm) { existingForm.remove(); }
  var header = panel.querySelector('.store-detail-header');
  if (header) { header.insertAdjacentHTML('afterend', editHtml); }
}

async function savePublishedAgent(slug) {
  var nameEl = document.getElementById('edit-pub-name');
  var descEl = document.getElementById('edit-pub-desc');
  var iconEl = document.getElementById('edit-pub-icon');
  if (!nameEl || !descEl) return;

  try {
    var r = await storeApi('/agents/' + encodeURIComponent(slug), {
      method: 'PUT',
      body: JSON.stringify({
        display_name: nameEl.value,
        description: descEl.value,
        icon: iconEl ? iconEl.value : undefined
      })
    });
    var result = await r.json();
    if (result.error) throw new Error(result.error);

    showToast('Agent updated successfully');
    // Refresh detail view
    viewStoreAgent(slug);
  } catch (e) {
    showToast('Update failed: ' + e.message);
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────

async function storeLogin() {
  var email = document.getElementById('store-login-email');
  var password = document.getElementById('store-login-password');
  var errorEl = document.getElementById('store-login-error');
  if (!email || !password) return;
  if (!email.value || !password.value) { if (errorEl) errorEl.textContent = 'Email and password required'; return; }

  try {
    var r = await storeApi('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.value, password: password.value })
    });
    var d = await r.json();
    if (d.token) localStorage.setItem('store-token', d.token);
    storeState.account = { name: d.name || d.user?.name || email.value, email: email.value, verified: d.verified || d.user?.verified || false, role: d.role || d.user?.role || 'developer' };
    localStorage.setItem('store-account', JSON.stringify(storeState.account));
    updateTopbarAccount();
    renderStorePanel();
    renderStoreAccountSettings();
  } catch (e) {
    if (errorEl) errorEl.textContent = e.message;
  }
}

async function storeRegister() {
  var name = document.getElementById('store-register-name');
  var email = document.getElementById('store-register-email');
  var password = document.getElementById('store-register-password');
  var errorEl = document.getElementById('store-register-error');
  if (!name || !email || !password) return;
  if (!name.value || !email.value || !password.value) { if (errorEl) errorEl.textContent = 'All fields required'; return; }

  try {
    var r = await storeApi('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: name.value, email: email.value, password: password.value })
    });
    var d = await r.json();
    if (d.token) localStorage.setItem('store-token', d.token);
    storeState.account = { name: name.value, email: email.value, verified: false, role: 'developer' };
    localStorage.setItem('store-account', JSON.stringify(storeState.account));
    updateTopbarAccount();
    renderStorePanel();
    renderStoreAccountSettings();
    showToast('Account created! Check your email for verification.');
  } catch (e) {
    if (errorEl) errorEl.textContent = e.message;
  }
}

function storeLogout() {
  localStorage.removeItem('store-token');
  localStorage.removeItem('store-account');
  storeState.account = null;
  updateTopbarAccount();
  renderStorePanel();
  renderStoreAccountSettings();
}

// ── My Agents view (analytics + installed + published agents) ────────────

function renderStoreMyAgents() {
  var agents = getAllAgents();
  var data = typeof getAnalytics === 'function' ? getAnalytics() : { totalInvocations: 0, agents: {}, sessions: [] };
  var agentStats = data.agents || {};
  var analyticsOn = typeof analyticsEnabled !== 'undefined' ? analyticsEnabled : false;

  var localAgents = agents.filter(function(a) { return !(a._meta && a._meta.installedFromStore); });
  var storeAgents = agents.filter(function(a) { return a._meta && a._meta.installedFromStore; });

  var html = '<div class="store-myagents">';

  // ── Header row: count + analytics toggle ──
  html += '<div class="myagents-header-row">' +
    '<span class="myagents-total">' + agents.length + ' agent' + (agents.length !== 1 ? 's' : '') + '</span>' +
    '<label class="myagents-analytics-toggle" title="Usage analytics">' +
      '<input type="checkbox"' + (analyticsOn ? ' checked' : '') + ' onchange="toggleAnalytics(this.checked)">' +
      '<span class="myagents-analytics-track"></span>' +
      '<span class="myagents-analytics-label">Analytics</span>' +
    '</label>' +
  '</div>';

  function agentRow(a, isStore) {
    var st = agentStats[a.name] || { invocations: 0, totalDuration: 0 };
    var iconHtml = typeof agentIconHtml === 'function' ? agentIconHtml(a) : '<i class="ti ' + (a.icon || 'ti-robot') + '"></i>';
    var isPublished = storeState.myPublishedSlugs.indexOf(a.name) !== -1;
    var canEdit = !isStore || (storeState.account && a._meta && a._meta.installedBy === storeState.account.email) || isPublished;
    var badge = isPublished
      ? '<span class="myagent-badge published">Published</span>'
      : isStore
        ? ''
        : '';

    var callsLabel = analyticsOn && st.invocations > 0
      ? '<span class="myagent-calls">' + st.invocations + ' call' + (st.invocations !== 1 ? 's' : '') + '</span>'
      : '';

    return '<div class="myagent-row">' +
      '<div class="myagent-icon">' + iconHtml + '</div>' +
      '<div class="myagent-info">' +
        '<div class="myagent-name">' + escHtml(a.displayName) + badge + '</div>' +
        '<div class="myagent-desc">' + escHtml((a.description || '').substring(0, 72)) + '</div>' +
      '</div>' +
      callsLabel +
      '<div class="myagent-actions">' +
        '<button class="ma-btn primary" onclick="quickActivateAgent(\'' + escHtml(a.name) + '\');closeAgentStore()" title="Use"><i class="ti ti-player-play"></i> Use</button>' +
        (canEdit ? '<button class="ma-btn" onclick="closeAgentStore();openAgentBuilder(\'' + escHtml(a.name) + '\')" title="Edit"><i class="ti ti-pencil"></i></button>' : '') +
        (!isStore && !isPublished && storeState.account ? '<button class="ma-btn" onclick="publishAgent(\'' + escHtml(a.name) + '\')" title="Publish"><i class="ti ti-upload"></i></button>' : '') +
      '</div>' +
    '</div>';
  }

  // ── Local agents ──
  if (localAgents.length) {
    html += '<div class="myagents-group-label">Local</div>';
    html += '<div class="myagents-list">';
    for (var li = 0; li < localAgents.length; li++) html += agentRow(localAgents[li], false);
    html += '</div>';
  } else {
    html += '<div class="store-empty" style="padding:24px 0"><i class="ti ti-code-plus"></i><p>No local agents yet — build one in the Agent Builder</p></div>';
  }

  // ── Store-installed ──
  if (storeAgents.length) {
    html += '<div class="myagents-group-label">From Store</div>';
    html += '<div class="myagents-list">';
    for (var si = 0; si < storeAgents.length; si++) html += agentRow(storeAgents[si], true);
    html += '</div>';
  }

  html += '<div id="myagents-published-section"></div>';

  html += '</div>';

  if (storeState.account && localStorage.getItem('store-token')) {
    loadMyPublishedAgents();
  }

  return html;
}

async function loadMyPublishedAgents() {
  try {
    var r = await storeApi('/dashboard/agents');
    var data = await r.json();
    var published = data.agents || [];
    storeState.myPublishedSlugs = published.map(function(pa) { return pa.slug; });
    if (!published.length) return;

    // Split into installed vs not-installed
    var notInstalled = published.filter(function(pa) { return !isAgentInstalled(pa.slug); });
    var installedPublished = published.filter(function(pa) { return isAgentInstalled(pa.slug); });

    var container = document.getElementById('myagents-published-section');
    if (!container) return;

    var html = '';

    // Show published + installed (with store stats)
    if (installedPublished.length) {
      html += '<div class="myagents-section-title">Published &amp; Installed (' + installedPublished.length + ')</div>';
      html += '<div class="myagents-list">';
      for (var i = 0; i < installedPublished.length; i++) {
        html += renderPublishedAgentRow(installedPublished[i], true);
      }
      html += '</div>';
    }

    // Show published but not installed
    if (notInstalled.length) {
      html += '<div class="myagents-section-title">Published — Not Installed (' + notInstalled.length + ')</div>';
      html += '<div class="myagents-list">';
      for (var j = 0; j < notInstalled.length; j++) {
        html += renderPublishedAgentRow(notInstalled[j], false);
      }
      html += '</div>';
    }

    container.innerHTML = html;

    // Update badges on local agent rows now that myPublishedSlugs is populated
    document.querySelectorAll('.myagent-row:not(.myagent-published)').forEach(function(row) {
      var nameEl = row.querySelector('.myagent-name');
      if (!nameEl) return;
      var badge = nameEl.querySelector('.myagent-badge.local');
      if (!badge) return; // only update local badges
      var agents = getAllAgents();
      var agent = agents.find(function(a) { return a.displayName === nameEl.textContent.replace(/Local|Published/g, '').trim(); });
      if (agent && storeState.myPublishedSlugs.indexOf(agent.name) !== -1) {
        badge.className = 'myagent-badge published';
        badge.innerHTML = '<i class="ti ti-world"></i> Published';
        // Remove publish button if present
        var pubBtn = row.querySelector('.myagent-actions .builder-btn.primary');
        if (pubBtn) pubBtn.remove();
      }
    });
  } catch (_) {
    // Silently ignore — user might not be authenticated or backend is down
  }
}

function renderPublishedAgentRow(pa, installed) {
  var statusClass = pa.status === 'approved' ? 'approved' : pa.status === 'pending' ? 'pending' : 'rejected';
  var statusLabel = pa.status === 'approved' ? 'Live' : pa.status === 'pending' ? 'In Review' : pa.status === 'rejected' ? 'Rejected' : pa.status;
  var statusIcon = pa.status === 'approved' ? 'ti-circle-check' : pa.status === 'pending' ? 'ti-clock' : 'ti-circle-x';

  return '<div class="myagent-row myagent-published">' +
    '<div class="myagent-icon"><i class="ti ' + escHtml(pa.icon || 'ti-robot') + '"></i></div>' +
    '<div class="myagent-info">' +
      '<div class="myagent-name">' + escHtml(pa.displayName) + '</div>' +
      '<div class="myagent-pub-meta">' +
        '<span class="myagent-status ' + statusClass + '"><i class="ti ' + statusIcon + '"></i> ' + statusLabel + '</span>' +
        '<span class="myagent-pub-stat"><i class="ti ti-download"></i> ' + (pa.downloads || 0) + '</span>' +
        (pa.rating > 0 ? '<span class="myagent-pub-stat"><i class="ti ti-star-filled" style="color:#eab308"></i> ' + Number(pa.rating).toFixed(1) + '</span>' : '') +
        '<span class="myagent-pub-stat">v' + escHtml(pa.currentVersion || '1.0') + '</span>' +
      '</div>' +
      (pa.status === 'rejected' && pa.rejectionReason ? '<div class="myagent-rejection"><i class="ti ti-alert-triangle"></i> ' + escHtml(pa.rejectionReason) + '</div>' : '') +
    '</div>' +
    '<div class="myagent-actions">' +
      (installed ? '<button class="builder-btn secondary small" onclick="closeAgentStore();openAgentBuilder(\'' + escHtml(pa.slug) + '\')" title="Edit agent"><i class="ti ti-pencil"></i></button>' : '') +
      '<button class="builder-btn secondary small" onclick="viewStoreAgent(\'' + escHtml(pa.slug) + '\')" title="View in store"><i class="ti ti-eye"></i></button>' +
      (!installed ? '<button class="builder-btn primary small" onclick="installStoreAgent(\'' + escHtml(pa.slug) + '\')" title="Install locally"><i class="ti ti-download"></i></button>' : '') +
    '</div>' +
  '</div>';
}

// ── Review queue (reviewer/admin) ─────────────────────────────────────────

function renderStoreReview() {
  var isSuperAdmin = storeState.account && storeState.account.role === 'superadmin';
  var html = '<div class="store-review">';
  html += '<div class="review-filters">' +
    '<button class="builder-btn small' + (storeState.reviewStatus === 'pending' ? ' primary' : ' secondary') + '" onclick="filterReviewQueue(\'pending\')">Pending</button>' +
    '<button class="builder-btn small' + (storeState.reviewStatus === 'in_review' ? ' primary' : ' secondary') + '" onclick="filterReviewQueue(\'in_review\')">In Review</button>' +
    '<button class="builder-btn small' + (storeState.reviewStatus === 'needs_changes' ? ' primary' : ' secondary') + '" onclick="filterReviewQueue(\'needs_changes\')">Needs Changes</button>' +
    '<button class="builder-btn small' + (storeState.reviewStatus === 'approved' ? ' primary' : ' secondary') + '" onclick="filterReviewQueue(\'approved\')">Approved</button>' +
    '<button class="builder-btn small' + (storeState.reviewStatus === 'rejected' ? ' primary' : ' secondary') + '" onclick="filterReviewQueue(\'rejected\')">Rejected</button>' +
    (isSuperAdmin ? '<button class="builder-btn small' + (storeState.reviewStatus === 'unpublished' ? ' primary' : ' secondary') + '" onclick="filterReviewQueue(\'unpublished\')">Unpublished</button>' : '') +
    (isSuperAdmin ? '<button class="builder-btn small' + (storeState.reviewStatus === 'suspended' ? ' primary' : ' secondary') + '" onclick="filterReviewQueue(\'suspended\')">Suspended</button>' : '') +
  '</div>';

  if (storeState.loading) {
    html += '<div class="store-loading"><div class="loading-spinner"></div></div>';
  } else if (storeState.reviewQueue.length === 0) {
    html += '<div class="store-empty"><i class="ti ti-inbox-off"></i><div>No agents with this status</div></div>';
  } else {
    html += '<div class="review-list">';
    storeState.reviewQueue.forEach(function(agent) {
      html += renderReviewCard(agent);
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderReviewCard(agent) {
  var user = agent.user || {};
  var ver = agent.latest_version || agent.latestVersion || {};
  var submitted = agent.created_at ? new Date(agent.created_at).toLocaleDateString() : '';
  return '<div class="review-card" data-agent-id="' + agent.id + '">' +
    '<div class="review-card-top">' +
      '<div class="review-card-icon"><i class="ti ti-robot"></i></div>' +
      '<div class="review-card-info">' +
        '<div class="review-card-name">' + escHtml(agent.name || agent.slug) + '</div>' +
        '<div class="review-card-meta">by ' + escHtml(user.name || 'Unknown') + ' &middot; v' + escHtml(ver.version || '1.0.0') + ' &middot; ' + submitted + '</div>' +
        '<div class="review-card-desc">' + escHtml(agent.short_description || agent.description || '') + '</div>' +
      '</div>' +
      '<div class="myagent-status ' + (agent.status || 'pending') + '">' + escHtml(agent.status || 'pending') + '</div>' +
    '</div>' +
    '<div class="review-card-actions">' +
      (agent.status !== 'approved' ? '<button class="builder-btn small" style="background:#4ade80;color:#000;border:none" onclick="reviewApprove(' + agent.id + ')"><i class="ti ti-check"></i> Approve</button>' : '') +
      (agent.status !== 'rejected' ? '<button class="builder-btn small" style="background:#ef4444;color:#fff;border:none" onclick="reviewReject(' + agent.id + ')"><i class="ti ti-x"></i> Reject</button>' : '') +
      (agent.status !== 'needs_changes' && agent.status !== 'approved' ? '<button class="builder-btn small secondary" onclick="reviewRequestChanges(' + agent.id + ')"><i class="ti ti-message-dots"></i> Request Changes</button>' : '') +
      (agent.status === 'approved' ? '<button class="builder-btn small secondary" onclick="reviewManageAccess(' + agent.id + ')"><i class="ti ti-lock"></i> Access</button>' : '') +
    '</div>' +
  '</div>';
}

async function loadReviewQueue() {
  storeState.loading = true;
  renderStorePanel();
  try {
    var r = await storeApi('/admin/agents?status=' + encodeURIComponent(storeState.reviewStatus));
    var d = await r.json();
    storeState.reviewQueue = d.data || d || [];
  } catch (e) {
    storeState.reviewQueue = [];
    showToast('Failed to load review queue: ' + e.message);
  }
  storeState.loading = false;
  renderStorePanel();
}

function filterReviewQueue(status) {
  storeState.reviewStatus = status;
  loadReviewQueue();
}

async function reviewApprove(agentId) {
  showApproveAccessDialog(agentId);
}

// Show approve dialog with visibility + access rules
async function showApproveAccessDialog(agentId) {
  var card = document.querySelector('.review-card[data-agent-id="' + agentId + '"]');
  if (!card) return;
  var existing = card.querySelector('.review-approve-panel');
  if (existing) { existing.remove(); return; }

  var panel = document.createElement('div');
  panel.className = 'review-approve-panel review-reason-row';
  panel.innerHTML = '<div style="opacity:0.7;font-size:12px"><i class="ti ti-loader"></i> Loading…</div>';
  card.appendChild(panel);

  // Fetch existing visibility + rules so we don't ask again for what's already set
  var existingVisibility = 'public';
  var existingRules = [];
  try {
    var ar = await storeApi('/admin/agents/' + agentId + '/access-rules');
    var ad = await ar.json();
    existingVisibility = ad.visibility || 'public';
    existingRules = ad.rules || [];
  } catch (_) {}

  panel.innerHTML =
    '<div style="font-size:12px;margin-bottom:6px;opacity:0.8">Visibility</div>' +
    '<div class="review-approve-vis" style="display:flex;gap:6px;margin-bottom:8px">' +
      '<button type="button" class="builder-btn small" data-vis="public"><i class="ti ti-world"></i> Public</button>' +
      '<button type="button" class="builder-btn small" data-vis="restricted"><i class="ti ti-lock"></i> Restricted</button>' +
    '</div>' +
    '<div class="review-approve-rules" style="display:none">' +
      '<div style="font-size:12px;margin-bottom:4px;opacity:0.8">Existing rules (carried over automatically)</div>' +
      '<div class="review-approve-existing-rules" style="margin-bottom:6px"></div>' +
      '<div style="font-size:12px;margin-bottom:4px;opacity:0.8">New rules to add</div>' +
      '<div class="review-approve-rules-list"></div>' +
      '<button type="button" class="builder-btn small secondary" id="review-approve-add-rule"><i class="ti ti-plus"></i> Add rule</button>' +
    '</div>' +
    '<div class="review-reason-btns" style="margin-top:10px">' +
      '<button type="button" class="builder-btn small primary" id="review-approve-submit"><i class="ti ti-check"></i> Approve</button>' +
      '<button type="button" class="builder-btn small secondary" id="review-approve-cancel">Cancel</button>' +
    '</div>';
  card.appendChild(panel);

  // Render existing rules read-only
  var existingContainer = panel.querySelector('.review-approve-existing-rules');
  if (existingRules.length) {
    existingContainer.innerHTML = existingRules.map(function(r) {
      return '<div style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:12px">' +
        '<span style="background:var(--fau-surface2);border-radius:4px;padding:1px 6px">' + escHtml(r.type) + '</span>' +
        '<span style="font-family:monospace;flex:1">' + escHtml(r.value) + '</span>' +
      '</div>';
    }).join('');
  } else {
    existingContainer.innerHTML = '<div style="opacity:0.5;font-size:12px;font-style:italic">None</div>';
  }

  var state = { visibility: existingVisibility, rules: [] };

  function renderRules() {
    var container = panel.querySelector('.review-approve-rules-list');
    container.innerHTML = state.rules.map(function(r, i) {
      return '<div class="review-approve-rule" style="display:flex;gap:6px;margin-bottom:6px">' +
        '<select class="builder-input" data-i="' + i + '" data-field="type" style="flex:0 0 100px">' +
          '<option value="domain"' + (r.type === 'domain' ? ' selected' : '') + '>Domain</option>' +
          '<option value="email"' + (r.type === 'email' ? ' selected' : '') + '>Email</option>' +
          '<option value="user_id"' + (r.type === 'user_id' ? ' selected' : '') + '>User ID</option>' +
        '</select>' +
        '<input class="builder-input" data-i="' + i + '" data-field="value" value="' + escHtml(r.value) + '" placeholder="' + (r.type === 'domain' ? 'example.com' : r.type === 'email' ? 'user@example.com' : 'user id') + '" style="flex:1">' +
        '<button type="button" class="builder-btn small secondary" data-i="' + i + '" data-action="remove"><i class="ti ti-trash"></i></button>' +
      '</div>';
    }).join('');
    container.querySelectorAll('select, input').forEach(function(el) {
      el.onchange = el.oninput = function() {
        var i = parseInt(el.dataset.i, 10);
        state.rules[i][el.dataset.field] = el.value;
      };
    });
    container.querySelectorAll('button[data-action="remove"]').forEach(function(btn) {
      btn.onclick = function() {
        state.rules.splice(parseInt(btn.dataset.i, 10), 1);
        renderRules();
      };
    });
  }

  function setVisibility(vis) {
    state.visibility = vis;
    panel.querySelectorAll('[data-vis]').forEach(function(b) {
      b.classList.toggle('primary', b.dataset.vis === vis);
      b.classList.toggle('secondary', b.dataset.vis !== vis);
    });
    panel.querySelector('.review-approve-rules').style.display = vis === 'restricted' ? '' : 'none';
  }

  panel.querySelectorAll('[data-vis]').forEach(function(b) {
    b.onclick = function() { setVisibility(b.dataset.vis); };
  });
  panel.querySelector('#review-approve-add-rule').onclick = function() {
    state.rules.push({ type: 'domain', value: '' });
    renderRules();
  };
  panel.querySelector('#review-approve-cancel').onclick = function() { panel.remove(); };
  panel.querySelector('#review-approve-submit').onclick = async function() {
    var body = { visibility: state.visibility };
    if (state.visibility === 'restricted') {
      var clean = state.rules
        .map(function(r) { return { type: r.type, value: (r.value || '').trim() }; })
        .filter(function(r) { return r.value; });
      // Only require rules if there are no existing rules already covering it
      if (clean.length === 0 && existingRules.length === 0) {
        showToast('Add at least one rule, or choose Public');
        return;
      }
      if (clean.length > 0) body.access_rules = clean;
    }
    try {
      await storeApi('/admin/agents/' + agentId + '/approve', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      showToast('Agent approved');
      loadReviewQueue();
    } catch (e) {
      showToast('Approve failed: ' + e.message);
    }
  };

  setVisibility(existingVisibility);
}

// Manage access rules on already-approved agents
async function reviewManageAccess(agentId) {
  var card = document.querySelector('.review-card[data-agent-id="' + agentId + '"]');
  if (!card) return;
  var existing = card.querySelector('.review-access-panel');
  if (existing) { existing.remove(); return; }

  var panel = document.createElement('div');
  panel.className = 'review-access-panel review-reason-row';
  panel.innerHTML = '<div style="opacity:0.7;font-size:12px">Loading access rules…</div>';
  card.appendChild(panel);

  async function refresh() {
    try {
      var r = await storeApi('/admin/agents/' + agentId + '/access-rules');
      var d = await r.json();
      render(d.visibility || 'public', d.rules || []);
    } catch (e) {
      panel.innerHTML = '<div style="color:#ef4444">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  function render(visibility, rules) {
    panel.innerHTML =
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">' +
        '<span style="font-size:12px;opacity:0.8">Visibility:</span>' +
        '<button type="button" class="builder-btn small ' + (visibility === 'public' ? 'primary' : 'secondary') + '" data-vis="public"><i class="ti ti-world"></i> Public</button>' +
        '<button type="button" class="builder-btn small ' + (visibility === 'restricted' ? 'primary' : 'secondary') + '" data-vis="restricted"><i class="ti ti-lock"></i> Restricted</button>' +
      '</div>' +
      (rules.length === 0
        ? '<div style="opacity:0.6;font-size:12px;margin-bottom:8px">No access rules. Add one to restrict visibility.</div>'
        : '<div style="margin-bottom:8px">' + rules.map(function(r) {
            return '<div style="display:flex;gap:6px;align-items:center;padding:4px 0">' +
              '<span class="myagent-status" style="font-size:11px">' + escHtml(r.type) + '</span>' +
              '<span style="font-family:monospace;flex:1">' + escHtml(r.value) + '</span>' +
              (r.addedBy ? '<span style="font-size:11px;opacity:0.6">by ' + escHtml(r.addedBy.name) + '</span>' : '') +
              '<button type="button" class="builder-btn small secondary" data-rule-id="' + r.id + '"><i class="ti ti-trash"></i></button>' +
            '</div>';
          }).join('') + '</div>') +
      '<div style="display:flex;gap:6px;margin-bottom:8px">' +
        '<select class="builder-input" id="new-rule-type" style="flex:0 0 100px">' +
          '<option value="domain">Domain</option>' +
          '<option value="email">Email</option>' +
          '<option value="user_id">User ID</option>' +
        '</select>' +
        '<input class="builder-input" id="new-rule-value" placeholder="example.com" style="flex:1">' +
        '<button type="button" class="builder-btn small primary" id="new-rule-add"><i class="ti ti-plus"></i> Add</button>' +
      '</div>' +
      '<div class="review-reason-btns">' +
        '<button type="button" class="builder-btn small secondary" id="access-close">Close</button>' +
      '</div>';

    panel.querySelectorAll('[data-vis]').forEach(function(b) {
      b.onclick = async function() {
        try {
          await storeApi('/admin/agents/' + agentId + '/visibility', {
            method: 'PUT',
            body: JSON.stringify({ visibility: b.dataset.vis }),
          });
          showToast('Visibility updated');
          refresh();
        } catch (e) { showToast('Failed: ' + e.message); }
      };
    });
    panel.querySelectorAll('button[data-rule-id]').forEach(function(btn) {
      btn.onclick = async function() {
        try {
          await storeApi('/admin/agents/' + agentId + '/access-rules/' + btn.dataset.ruleId, { method: 'DELETE' });
          showToast('Rule removed');
          refresh();
        } catch (e) { showToast('Failed: ' + e.message); }
      };
    });
    panel.querySelector('#new-rule-add').onclick = async function() {
      var t = panel.querySelector('#new-rule-type').value;
      var v = panel.querySelector('#new-rule-value').value.trim();
      if (!v) return;
      try {
        await storeApi('/admin/agents/' + agentId + '/access-rules', {
          method: 'POST',
          body: JSON.stringify({ rules: [{ type: t, value: v }] }),
        });
        showToast('Rule added');
        refresh();
      } catch (e) { showToast('Failed: ' + e.message); }
    };
    panel.querySelector('#access-close').onclick = function() { panel.remove(); };
  }

  refresh();
}

function reviewReject(agentId) {
  showReviewReasonInput(agentId, 'reject', 'Rejection reason…', async function(reason) {
    try {
      await storeApi('/admin/agents/' + agentId + '/reject', { method: 'POST', body: JSON.stringify({ reason: reason }) });
      showToast('Agent rejected');
      loadReviewQueue();
    } catch (e) {
      showToast('Reject failed: ' + e.message);
    }
  });
}

function reviewRequestChanges(agentId) {
  showReviewReasonInput(agentId, 'changes', 'What changes are needed?', async function(reason) {
    try {
      await storeApi('/admin/agents/' + agentId + '/request-changes', { method: 'POST', body: JSON.stringify({ reason: reason }) });
      showToast('Changes requested');
      loadReviewQueue();
    } catch (e) {
      showToast('Request failed: ' + e.message);
    }
  });
}

function showReviewReasonInput(agentId, action, placeholder, onSubmit) {
  // Remove any existing reason input
  var existing = document.querySelector('.review-reason-row');
  if (existing) existing.remove();

  var card = document.querySelector('.review-card[data-agent-id="' + agentId + '"]');
  if (!card) return;

  var row = document.createElement('div');
  row.className = 'review-reason-row';
  row.innerHTML =
    '<textarea class="builder-input review-reason-input" placeholder="' + placeholder + '" rows="2"></textarea>' +
    '<div class="review-reason-btns">' +
      '<button class="builder-btn small primary" id="review-reason-submit">Submit</button>' +
      '<button class="builder-btn small secondary" id="review-reason-cancel">Cancel</button>' +
    '</div>';
  card.appendChild(row);

  var input = row.querySelector('.review-reason-input');
  input.focus();

  row.querySelector('#review-reason-submit').onclick = function() {
    var val = input.value.trim();
    if (!val) { input.style.borderColor = '#ef4444'; return; }
    row.remove();
    onSubmit(val);
  };
  row.querySelector('#review-reason-cancel').onclick = function() {
    row.remove();
  };
}

// ── Notifications ─────────────────────────────────────────────────────────

async function loadUnreadCount() {
  if (!storeState.account) {
    storeState.unreadCount = 0;
    syncTopbarNotificationButton();
    return;
  }
  try {
    var r = await storeApi('/notifications/unread-count');
    var d = await r.json();
    storeState.unreadCount = d.count || 0;
    syncTopbarNotificationButton();
  } catch (_) {}
}

function toggleNotificationPanel() {
  storeState.notifOpen = !storeState.notifOpen;
  if (storeState.notifOpen) loadNotifications();
  else renderTopbarNotifications();
  syncTopbarNotificationButton();
}

function closeNotificationPanel() {
  storeState.notifOpen = false;
  renderTopbarNotifications();
  syncTopbarNotificationButton();
}

async function loadNotifications() {
  if (!storeState.account) {
    storeState.notifications = [];
  } else {
    try {
      var r = await storeApi('/notifications');
      var d = await r.json();
      storeState.notifications = d.data || d || [];
    } catch (_) {
      storeState.notifications = [];
    }
  }
  renderTopbarNotifications();
}

function hasFaunaUpdateNotification() {
  var data = typeof _faunaUpdateLastData !== 'undefined' ? _faunaUpdateLastData : null;
  var job = data && data.job;
  return !!(job && (job.running || job.updateAvailable || job.error));
}

function syncTopbarNotificationButton() {
  var btn = document.getElementById('topbar-notif-btn');
  var badge = document.getElementById('topbar-notif-badge');
  if (!btn || !badge) return;
  var hasUpdate = hasFaunaUpdateNotification();
  btn.classList.toggle('active', !!storeState.notifOpen);
  if (storeState.unreadCount > 0) {
    badge.style.display = 'flex';
    badge.textContent = storeState.unreadCount > 99 ? '99+' : String(storeState.unreadCount);
    badge.classList.remove('update-only');
  } else if (hasUpdate) {
    badge.style.display = 'flex';
    badge.textContent = '';
    badge.classList.add('update-only');
  } else {
    badge.style.display = 'none';
    badge.textContent = '';
    badge.classList.remove('update-only');
  }
}

function renderTopbarNotifications() {
  var panel = document.getElementById('topbar-notif-panel');
  if (!panel) return;
  panel.innerHTML = storeState.notifOpen ? renderNotificationPanel() : '';
}

function renderFaunaUpdateNotificationItem() {
  var data = typeof _faunaUpdateLastData !== 'undefined' ? _faunaUpdateLastData : null;
  var job = data && data.job;
  if (!job || (!job.running && !job.updateAvailable && !job.error)) return '';
  var running = !!job.running;
  var icon = job.error ? 'ti-alert-circle notif-error' : running ? 'ti-loader-2 notif-warn' : 'ti-download notif-success';
  var title = job.error ? 'Update failed' : running ? 'Installing update' : 'Fauna update available';
  var body = job.error || job.message || (job.latestSha ? 'Latest build ' + String(job.latestSha).slice(0, 7) : 'A new version is ready to install.');
  var action = !running && !job.error ? '<button type="button" class="store-notif-action" onclick="event.stopPropagation();_installFaunaUpdate()"><i class="ti ti-download"></i> Install</button>' : '';
  if (job.error) action = '<button type="button" class="store-notif-action" onclick="event.stopPropagation();_checkFaunaUpdate()"><i class="ti ti-refresh"></i> Retry</button>';
  return '<div class="store-notif-item unread update-notif-item">' +
    '<i class="ti ' + icon + '"></i>' +
    '<div class="store-notif-content">' +
      '<div class="store-notif-title">' + escHtml(title) + '</div>' +
      '<div class="store-notif-body">' + escHtml(body || '') + '</div>' +
    '</div>' +
    action +
  '</div>';
}

function renderNotificationPanel() {
  var items = storeState.notifications;
  var updateHtml = renderFaunaUpdateNotificationItem();
  var html = '<div class="store-notif-panel">' +
    '<div class="store-notif-header">' +
      '<span>Notifications</span>' +
      '<div class="store-notif-header-actions">' +
        (items.length > 0 ? '<button class="store-notif-markall" onclick="markAllNotificationsRead()">Mark all read</button>' : '') +
        '<button class="store-notif-close" onclick="closeNotificationPanel()" title="Close"><i class="ti ti-x"></i></button>' +
      '</div>' +
    '</div>';

  if (items.length === 0 && !updateHtml) {
    html += '<div class="store-notif-empty"><i class="ti ti-bell-off"></i> No notifications</div>';
  } else {
    html += '<div class="store-notif-list">';
    html += updateHtml;
    items.forEach(function(n) {
      var icon = n.type === 'agent_approved' ? 'ti-circle-check' :
                 n.type === 'agent_rejected' ? 'ti-circle-x' :
                 n.type === 'agent_changes_requested' ? 'ti-message-dots' :
                 n.type === 'agent_suspended' ? 'ti-ban' :
                 n.type === 'agent_update_available' ? 'ti-cloud-download' :
                 n.type === 'agent_unpublished' ? 'ti-eye-off' :
                 n.type === 'agent_deprecated' ? 'ti-alert-triangle' :
                 n.type === 'agent_deleted' ? 'ti-trash' : 'ti-bell';
      var colorCls = n.type === 'agent_approved' || n.type === 'agent_update_available' ? 'notif-success' :
                     n.type === 'agent_rejected' || n.type === 'agent_suspended' || n.type === 'agent_unpublished' || n.type === 'agent_deleted' ? 'notif-error' :
                     n.type === 'agent_deprecated' ? 'notif-warn' : 'notif-warn';
      var unread = !n.read_at ? ' unread' : '';
      var ago = timeAgo(n.created_at);
      html += '<div class="store-notif-item' + unread + '" onclick="markNotificationRead(' + n.id + ')">' +
        '<i class="ti ' + icon + ' ' + colorCls + '"></i>' +
        '<div class="store-notif-content">' +
          '<div class="store-notif-title">' + escHtml(n.title) + '</div>' +
          '<div class="store-notif-body">' + escHtml(n.body || '') + '</div>' +
          '<div class="store-notif-time">' + ago + '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  var now = new Date();
  var diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString();
}

async function markNotificationRead(id) {
  try {
    await storeApi('/notifications/' + id + '/read', { method: 'POST', body: '{}' });
  } catch (_) {}
  storeState.unreadCount = Math.max(0, storeState.unreadCount - 1);
  // Mark locally
  storeState.notifications.forEach(function(n) { if (n.id === id) n.read_at = new Date().toISOString(); });
  syncTopbarNotificationButton();
  renderTopbarNotifications();
}

async function markAllNotificationsRead() {
  try {
    await storeApi('/notifications/read-all', { method: 'POST', body: '{}' });
  } catch (_) {}
  storeState.unreadCount = 0;
  storeState.notifications.forEach(function(n) { n.read_at = n.read_at || new Date().toISOString(); });
  syncTopbarNotificationButton();
  renderTopbarNotifications();
}

// ── Superadmin actions ────────────────────────────────────────────────────

function adminUnpublish(slug) {
  showAdminReasonInput('Unpublish reason…', async function(reason) {
    try {
      // Need agent ID — look it up from selectedAgent
      var a = storeState.selectedAgent;
      if (!a || !a.id) { showToast('Agent not loaded'); return; }
      await storeApi('/admin/agents/' + a.id + '/unpublish', { method: 'POST', body: JSON.stringify({ reason: reason }) });
      showToast('"' + (a.displayName || slug) + '" has been unpublished');
      storeNavigate('browse');
    } catch (e) {
      showToast('Unpublish failed: ' + e.message);
    }
  });
}

function adminDeprecate(slug) {
  showAdminReasonInput('Deprecation reason…', async function(reason) {
    try {
      var a = storeState.selectedAgent;
      if (!a || !a.id) { showToast('Agent not loaded'); return; }
      await storeApi('/admin/agents/' + a.id + '/deprecate', { method: 'POST', body: JSON.stringify({ reason: reason }) });
      showToast('"' + (a.displayName || slug) + '" has been deprecated');
      viewStoreAgent(slug);
    } catch (e) {
      showToast('Deprecate failed: ' + e.message);
    }
  });
}

function adminDeleteAgent(slug) {
  if (!confirm('Permanently delete "' + slug + '" and all its versions? This cannot be undone.')) return;
  showAdminReasonInput('Deletion reason…', async function(reason) {
    try {
      var a = storeState.selectedAgent;
      if (!a || !a.id) { showToast('Agent not loaded'); return; }
      var url = STORE_BASE + '/admin/agents/' + a.id;
      var token = localStorage.getItem('store-token');
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var r = await fetch(url, { method: 'DELETE', headers: headers, body: JSON.stringify({ reason: reason }) });
      if (!r.ok) { var err = await r.json().catch(function() { return {}; }); throw new Error(err.error || 'Delete failed'); }
      showToast('"' + (a.displayName || slug) + '" has been permanently deleted');
      storeNavigate('browse');
    } catch (e) {
      showToast('Delete failed: ' + e.message);
    }
  });
}

function showAdminReasonInput(placeholder, onSubmit) {
  var container = document.getElementById('admin-action-reason');
  if (!container) return;

  container.innerHTML =
    '<div class="admin-reason-row">' +
      '<textarea class="builder-input admin-reason-input" placeholder="' + placeholder + '" rows="2"></textarea>' +
      '<div class="admin-reason-btns">' +
        '<button class="builder-btn small primary" id="admin-reason-submit">Submit</button>' +
        '<button class="builder-btn small secondary" id="admin-reason-cancel">Cancel</button>' +
      '</div>' +
    '</div>';

  var input = container.querySelector('.admin-reason-input');
  input.focus();

  container.querySelector('#admin-reason-submit').onclick = function() {
    var val = input.value.trim();
    if (!val) { input.style.borderColor = '#ef4444'; return; }
    container.innerHTML = '';
    onSubmit(val);
  };
  container.querySelector('#admin-reason-cancel').onclick = function() {
    container.innerHTML = '';
  };
}

// ── Init ─────────────────────────────────────────────────────────────────

function openStoreAccount() {
  if (typeof openSettingsPage === 'function') openSettingsPage('account');
  // Always refresh to pick up latest verified status
  refreshStoreAccount().then(function() { renderStoreAccountSettings(); });
}

function updateTopbarAccount() {
  var btn = document.getElementById('topbar-account-btn');
  if (!btn) return;
  if (storeState.account) {
    btn.classList.add('logged-in');
    btn.title = (storeState.account.name || 'Account') + ' — click to open settings';
  } else {
    btn.classList.remove('logged-in');
    btn.title = 'Account & settings';
  }
}

function initAgentStore() {
  // Restore cached account
  try {
    var cached = localStorage.getItem('store-account');
    if (cached) storeState.account = JSON.parse(cached);
  } catch (_) {}
  // Refresh account in background to pick up verified status changes
  refreshStoreAccount();
  // Fetch unread notification count if logged in
  loadUnreadCount();
  // Update topbar account label
  updateTopbarAccount();
  syncTopbarNotificationButton();
}
