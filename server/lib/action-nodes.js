// ── Action Node Registry — pluggable connector nodes for pipelines ─────────
//
// Phase: n8n-parity #3. A connector framework so new integration nodes are a
// small descriptor + executor instead of editing the runner's switch. The
// task runner falls back to this registry for any node type it doesn't handle
// natively.
//
// A node executor receives a context:
//   {
//     input,            // upstream value piped into this node (item.json on fan-out)
//     item,             // the current item ({ json, binary }) when fanning out
//     cfg,              // node.config (already available raw)
//     interp(str),      // interpolate {{ }} expressions for this node
//     resolveCred(id),  // decrypt a credential by id (or null)
//     signal,           // AbortSignal
//   }
// and returns a string/value used as the node's output. Returning an item
// ({ json, binary }) lets a node attach binary data. Throwing (or returning a
// string starting with "Node error") marks the node failed.

import { makeBinary } from './items.js';

// Derive a filename from a URL path (for binary downloads).
function _fileNameFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const last = p.split('/').filter(Boolean).pop();
    return last || null;
  } catch (_) { return null; }
}



// Apply a resolved credential to outgoing fetch headers.
function _applyAuth(headers, cred, cfg) {
  if (!cred) return;
  const d = cred.data || {};
  switch (cred.type) {
    case 'bearer':
      if (d.token) headers['Authorization'] = 'Bearer ' + d.token;
      break;
    case 'oauth2':
      if (d.accessToken) headers['Authorization'] = 'Bearer ' + d.accessToken;
      break;
    case 'basic':
      if (d.username != null) {
        const raw = `${d.username || ''}:${d.password || ''}`;
        headers['Authorization'] = 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
      }
      break;
    case 'apiKey':
    case 'custom': {
      const headerName = cfg.apiKeyHeader || 'X-API-Key';
      const value = d.apiKey || d.token || Object.values(d)[0];
      if (value) headers[headerName] = String(value);
      break;
    }
  }
}

// ── Connector helpers ──────────────────────────────────────────────────────

// Resolve a credential's decrypted data map for a node (or {} if none).
function _cred(cfg, resolveCred) {
  if (!cfg.credentialId || !resolveCred) return {};
  const c = resolveCred(cfg.credentialId);
  return (c && c.data) || {};
}

// Flatten an object to a string-valued form map (one level; nested → JSON).
function _flattenForm(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = v != null && typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

// Shared authed request helper. Returns { text } on success, { error } on
// non-2xx. Pass `form` for x-www-form-urlencoded, else `body` is sent as JSON.
async function _send(url, { headers = {}, body, method = 'POST', form, signal, label }) {
  const h = Object.assign({}, headers);
  let payload;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const resp = await fetch(url, { method, headers: h, body: payload, signal });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) return { error: `Node error: ${label} HTTP ${resp.status} ${resp.statusText} — ${(text || '').slice(0, 200)}` };
  return { text, resp };
}

// Resolve the message body for a node: explicit cfg field, else piped input.
function _textOf(cfg, key, interp, input) {
  return cfg[key] != null && cfg[key] !== '' ? interp(String(cfg[key])) : String(input != null ? input : '');
}

// Factory: incoming-webhook connector (the URL itself is the secret, so no
// credential). `build(text, cfg, interp)` returns the JSON payload object.
function webhookConnector({ label, icon, color, build, fields }) {
  return {
    label, icon, color, credentialType: null,
    fields: fields || [
      { key: 'url', label: 'Webhook URL', type: 'text', placeholder: 'https://...' },
      { key: 'text', label: 'Message', type: 'textarea', placeholder: 'Defaults to the piped input. Use {{ $json.x }}' },
    ],
    async run({ input, cfg, interp, signal }) {
      const url = interp(cfg.url || '');
      if (!url) return `Node error: ${label} node has no webhook URL`;
      const text = _textOf(cfg, 'text', interp, input);
      const r = await _send(url, { body: build(text, cfg, interp), signal, label });
      return r.error || (r.text || JSON.stringify({ ok: true }));
    },
  };
}

// Factory: OpenAI-compatible chat-completion connector (bearer API key).
function chatConnector({ label, icon, color, endpoint, defaultModel, extraHeaders }) {
  return {
    label, icon, color, credentialType: 'bearer',
    fields: [
      { key: 'model', label: 'Model', type: 'text', placeholder: defaultModel, default: defaultModel },
      { key: 'system', label: 'System prompt', type: 'textarea', placeholder: 'optional' },
      { key: 'prompt', label: 'Prompt', type: 'textarea', placeholder: 'Defaults to the piped input. Use {{ $json.x }}' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'API key as a bearer credential' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred);
      const token = d.token || d.accessToken || d.apiKey;
      if (!token) return `Node error: ${label} requires an API key credential`;
      const model = (cfg.model && interp(cfg.model)) || defaultModel;
      const messages = [];
      if (cfg.system) messages.push({ role: 'system', content: interp(String(cfg.system)) });
      messages.push({ role: 'user', content: _textOf(cfg, 'prompt', interp, input) });
      const headers = Object.assign({ Authorization: 'Bearer ' + token }, extraHeaders || {});
      const r = await _send(endpoint, { headers, body: { model, messages }, signal, label });
      if (r.error) return r.error;
      try {
        const j = JSON.parse(r.text);
        return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || r.text;
      } catch (_) { return r.text; }
    },
  };
}

const NODES = {
  // ── HTTP Request (authed) — generalises the outbound webhook node ────────
  http: {
    label: 'HTTP Request',
    icon: 'ti-api',
    color: '#0891b2',
    credentialType: 'any',
    fields: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://api.example.com/...' },
      { key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      { key: 'headers', label: 'Headers (JSON)', type: 'textarea', placeholder: '{"X-Custom": "value"}' },
      { key: 'body', label: 'Body', type: 'textarea', placeholder: 'Defaults to the piped input. Use {{ $json.x }}' },
      { key: 'responseFormat', label: 'Response', type: 'select', options: ['text', 'binary'], default: 'text' },
      { key: 'credentialId', label: 'Credential', type: 'credential' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const url = interp(cfg.url || '');
      if (!url) return 'Node error: HTTP node has no URL';
      const method = (cfg.method || 'GET').toUpperCase();
      const headers = { 'Content-Type': cfg.contentType || 'application/json' };

      // Custom headers (object or JSON string)
      let extra = cfg.headers;
      if (typeof extra === 'string') { try { extra = JSON.parse(interp(extra)); } catch (_) { extra = null; } }
      if (extra && typeof extra === 'object') {
        for (const [k, v] of Object.entries(extra)) headers[k] = interp(String(v));
      }

      if (cfg.credentialId && resolveCred) {
        _applyAuth(headers, resolveCred(cfg.credentialId), cfg);
      }

      const opts = { method, headers, signal };
      if (method !== 'GET' && method !== 'HEAD') {
        const body = cfg.body != null ? interp(String(cfg.body)) : (input != null ? String(input) : undefined);
        if (body !== undefined) opts.body = body;
      }

      const resp = await fetch(url, opts);

      // Binary response (opt-in): capture the body as a base64 binary
      // attachment instead of text, so downstream nodes can forward files.
      if (cfg.responseFormat === 'binary') {
        const buf = Buffer.from(await resp.arrayBuffer());
        if (!resp.ok) return `Node error: HTTP ${resp.status} ${resp.statusText}`;
        const ctype = resp.headers.get('content-type') || 'application/octet-stream';
        const fileName = cfg.binaryFileName || _fileNameFromUrl(url) || 'download';
        return {
          json: { status: resp.status, contentType: ctype, size: buf.length, fileName },
          binary: { data: makeBinary(buf, { mimeType: ctype.split(';')[0].trim(), fileName, size: buf.length }) },
        };
      }

      const text = await resp.text();
      if (!resp.ok) return `Node error: HTTP ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`;
      return text;
    },
  },

  // ── Slack — post a message via chat.postMessage (bot-token credential) ───
  slack: {
    label: 'Slack',
    icon: 'ti-brand-slack',
    color: '#4a154b',
    credentialType: 'bearer',
    fields: [
      { key: 'channel', label: 'Channel', type: 'text', placeholder: '#general or channel ID' },
      { key: 'text', label: 'Message', type: 'textarea', placeholder: 'Defaults to the piped input. Use {{ $json.x }}' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Bot token (bearer credential)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const cred = cfg.credentialId && resolveCred ? resolveCred(cfg.credentialId) : null;
      const token = cred && cred.data && (cred.data.token || cred.data.accessToken);
      if (!token) return 'Node error: Slack node requires a bearer credential (bot token)';
      const channel = interp(cfg.channel || '');
      if (!channel) return 'Node error: Slack node has no channel';
      const text = cfg.text != null ? interp(String(cfg.text)) : String(input != null ? input : '');

      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ channel, text }),
        signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!data.ok) return 'Node error: Slack API error — ' + (data.error || ('HTTP ' + resp.status));
      return JSON.stringify({ ok: true, ts: data.ts, channel: data.channel });
    },
  },
};

// ── Connector catalog ──────────────────────────────────────────────────────
// Each entry is a node descriptor + executor. fetch-only (no extra deps); auth
// comes from the encrypted credential vault. New connectors are a small object.
const CONNECTORS = {
  // Incoming-webhook chat connectors (URL is the secret) ────────────────────
  discord:    webhookConnector({ label: 'Discord',         icon: 'ti-brand-discord', color: '#5865F2', build: (t) => ({ content: t }) }),
  teams:      webhookConnector({ label: 'Microsoft Teams', icon: 'ti-brand-teams',   color: '#6264A7', build: (t) => ({ text: t }) }),
  googlechat: webhookConnector({ label: 'Google Chat',     icon: 'ti-brand-google',  color: '#1A73E8', build: (t) => ({ text: t }) }),
  mattermost: webhookConnector({ label: 'Mattermost',      icon: 'ti-message-2',     color: '#0058CC', build: (t) => ({ text: t }) }),
  rocketchat: webhookConnector({ label: 'Rocket.Chat',     icon: 'ti-rocket',        color: '#F5455C', build: (t) => ({ text: t }) }),

  // OpenAI-compatible LLM chat connectors ───────────────────────────────────
  openai:     chatConnector({ label: 'OpenAI',     icon: 'ti-brand-openai',    color: '#10A37F', endpoint: 'https://api.openai.com/v1/chat/completions',        defaultModel: 'gpt-4o-mini' }),
  groq:       chatConnector({ label: 'Groq',       icon: 'ti-bolt',            color: '#F55036', endpoint: 'https://api.groq.com/openai/v1/chat/completions',   defaultModel: 'llama-3.3-70b-versatile' }),
  mistral:    chatConnector({ label: 'Mistral',    icon: 'ti-wind',            color: '#FF7000', endpoint: 'https://api.mistral.ai/v1/chat/completions',        defaultModel: 'mistral-small-latest' }),
  perplexity: chatConnector({ label: 'Perplexity', icon: 'ti-search',          color: '#20808D', endpoint: 'https://api.perplexity.ai/chat/completions',        defaultModel: 'sonar' }),
  openrouter: chatConnector({ label: 'OpenRouter', icon: 'ti-router',          color: '#6467F2', endpoint: 'https://openrouter.ai/api/v1/chat/completions',     defaultModel: 'openai/gpt-4o-mini' }),
  together:   chatConnector({ label: 'Together AI',icon: 'ti-users-group',     color: '#0F6FFF', endpoint: 'https://api.together.xyz/v1/chat/completions',       defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }),
  deepseek:   chatConnector({ label: 'DeepSeek',   icon: 'ti-brain',           color: '#4D6BFE', endpoint: 'https://api.deepseek.com/chat/completions',         defaultModel: 'deepseek-chat' }),
  xai:        chatConnector({ label: 'xAI Grok',   icon: 'ti-brand-x',         color: '#000000', endpoint: 'https://api.x.ai/v1/chat/completions',             defaultModel: 'grok-2-latest' }),
  anthropic: {
    label: 'Anthropic', icon: 'ti-sparkles', color: '#D4A27F', credentialType: 'apiKey',
    fields: [
      { key: 'model', label: 'Model', type: 'text', placeholder: 'claude-3-5-sonnet-latest', default: 'claude-3-5-sonnet-latest' },
      { key: 'system', label: 'System prompt', type: 'textarea', placeholder: 'optional' },
      { key: 'prompt', label: 'Prompt', type: 'textarea', placeholder: 'Defaults to the piped input' },
      { key: 'maxTokens', label: 'Max tokens', type: 'text', placeholder: '1024', default: '1024' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'API key (apiKey credential)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const key = d.apiKey || d.token || d.accessToken;
      if (!key) return 'Node error: Anthropic requires an API key credential';
      const model = (cfg.model && interp(cfg.model)) || 'claude-3-5-sonnet-latest';
      const body = { model, max_tokens: parseInt(cfg.maxTokens || '1024', 10) || 1024, messages: [{ role: 'user', content: _textOf(cfg, 'prompt', interp, input) }] };
      if (cfg.system) body.system = interp(String(cfg.system));
      const r = await _send('https://api.anthropic.com/v1/messages', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body, signal, label: 'Anthropic' });
      if (r.error) return r.error;
      try { const j = JSON.parse(r.text); return (j.content && j.content[0] && j.content[0].text) || r.text; } catch (_) { return r.text; }
    },
  },

  // Messaging / notifications ───────────────────────────────────────────────
  telegram: {
    label: 'Telegram', icon: 'ti-brand-telegram', color: '#229ED9', credentialType: 'apiKey',
    fields: [
      { key: 'chatId', label: 'Chat ID', type: 'text', placeholder: '@channel or numeric id' },
      { key: 'text', label: 'Message', type: 'textarea', placeholder: 'Defaults to the piped input' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Bot token (apiKey credential)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.apiKey || d.accessToken;
      if (!token) return 'Node error: Telegram requires a bot-token credential';
      const chatId = interp(cfg.chatId || ''); if (!chatId) return 'Node error: Telegram node has no chat ID';
      const r = await _send(`https://api.telegram.org/bot${token}/sendMessage`, { body: { chat_id: chatId, text: _textOf(cfg, 'text', interp, input) }, signal, label: 'Telegram' });
      return r.error || r.text;
    },
  },
  ntfy: {
    label: 'ntfy', icon: 'ti-bell', color: '#2dd4bf', credentialType: null,
    fields: [
      { key: 'url', label: 'Topic URL', type: 'text', placeholder: 'https://ntfy.sh/mytopic' },
      { key: 'title', label: 'Title', type: 'text', placeholder: 'optional' },
      { key: 'text', label: 'Message', type: 'textarea' },
    ],
    async run({ input, cfg, interp, signal }) {
      const url = interp(cfg.url || ''); if (!url) return 'Node error: ntfy node has no topic URL';
      const headers = {}; if (cfg.title) headers.Title = interp(String(cfg.title));
      const resp = await fetch(url, { method: 'POST', headers, body: _textOf(cfg, 'text', interp, input), signal });
      const t = await resp.text().catch(() => '');
      return resp.ok ? t : `Node error: ntfy HTTP ${resp.status} — ${t.slice(0, 200)}`;
    },
  },
  pushover: {
    label: 'Pushover', icon: 'ti-device-mobile-message', color: '#249DF1', credentialType: 'custom',
    fields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'message', label: 'Message', type: 'textarea' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'custom credential with fields: token, user' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); if (!d.token || !d.user) return 'Node error: Pushover requires a custom credential with token and user';
      const form = { token: d.token, user: d.user, message: _textOf(cfg, 'message', interp, input) };
      if (cfg.title) form.title = interp(String(cfg.title));
      const r = await _send('https://api.pushover.net/1/messages.json', { form, signal, label: 'Pushover' });
      return r.error || r.text;
    },
  },
  pushbullet: {
    label: 'Pushbullet', icon: 'ti-bell-ringing', color: '#4AB367', credentialType: 'apiKey',
    fields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'body', label: 'Body', type: 'textarea' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Access token (apiKey credential)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.apiKey || d.token || d.accessToken;
      if (!token) return 'Node error: Pushbullet requires an access-token credential';
      const title = cfg.title ? interp(String(cfg.title)) : '';
      const r = await _send('https://api.pushbullet.com/v2/pushes', { headers: { 'Access-Token': token }, body: { type: 'note', title, body: _textOf(cfg, 'body', interp, input) }, signal, label: 'Pushbullet' });
      return r.error || r.text;
    },
  },

  // Issue trackers / project management ─────────────────────────────────────
  github: {
    label: 'GitHub Issue', icon: 'ti-brand-github', color: '#24292e', credentialType: 'bearer',
    fields: [
      { key: 'repo', label: 'Repo (owner/name)', type: 'text', placeholder: 'octocat/hello-world' },
      { key: 'title', label: 'Issue title', type: 'text' },
      { key: 'body', label: 'Issue body', type: 'textarea', placeholder: 'Defaults to the piped input' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Personal access token (bearer)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.accessToken || d.apiKey;
      if (!token) return 'Node error: GitHub requires a token credential';
      const repo = interp(cfg.repo || ''); if (!repo) return 'Node error: GitHub node has no repo';
      const r = await _send(`https://api.github.com/repos/${repo}/issues`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'Fauna' }, body: { title: interp(cfg.title || '') || 'Untitled', body: _textOf(cfg, 'body', interp, input) }, signal, label: 'GitHub' });
      return r.error || r.text;
    },
  },
  gitlab: {
    label: 'GitLab Issue', icon: 'ti-brand-gitlab', color: '#fc6d26', credentialType: 'apiKey',
    fields: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://gitlab.com' },
      { key: 'projectId', label: 'Project ID', type: 'text' },
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Personal access token (apiKey)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.apiKey || d.accessToken;
      if (!token) return 'Node error: GitLab requires a token credential';
      const base = interp(cfg.baseUrl || '') || 'https://gitlab.com';
      const pid = interp(cfg.projectId || ''); if (!pid) return 'Node error: GitLab node has no project ID';
      const r = await _send(`${base}/api/v4/projects/${encodeURIComponent(pid)}/issues`, { headers: { 'PRIVATE-TOKEN': token }, body: { title: interp(cfg.title || '') || _textOf(cfg, 'title', interp, input) || 'Untitled' }, signal, label: 'GitLab' });
      return r.error || r.text;
    },
  },
  jira: {
    label: 'Jira Issue', icon: 'ti-ticket', color: '#0052CC', credentialType: 'basic',
    fields: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://you.atlassian.net' },
      { key: 'project', label: 'Project key', type: 'text', placeholder: 'ENG' },
      { key: 'summary', label: 'Summary', type: 'text' },
      { key: 'issueType', label: 'Issue type', type: 'text', default: 'Task' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'email + API token (basic)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); if (!d.username) return 'Node error: Jira requires a basic credential (email + API token)';
      const base = interp(cfg.baseUrl || ''); if (!base) return 'Node error: Jira node has no base URL';
      const auth = 'Basic ' + Buffer.from(`${d.username}:${d.password || ''}`, 'utf8').toString('base64');
      const body = { fields: { project: { key: interp(cfg.project || '') }, summary: interp(cfg.summary || '') || _textOf(cfg, 'summary', interp, input), issuetype: { name: interp(cfg.issueType || '') || 'Task' } } };
      const r = await _send(`${base}/rest/api/2/issue`, { headers: { Authorization: auth }, body, signal, label: 'Jira' });
      return r.error || r.text;
    },
  },
  linear: {
    label: 'Linear Issue', icon: 'ti-brand-linear', color: '#5E6AD2', credentialType: 'apiKey',
    fields: [
      { key: 'teamId', label: 'Team ID', type: 'text' },
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'API key (apiKey credential)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const key = d.apiKey || d.token || d.accessToken;
      if (!key) return 'Node error: Linear requires an API key credential';
      const teamId = interp(cfg.teamId || ''); if (!teamId) return 'Node error: Linear node has no team ID';
      const query = 'mutation($t:String!,$n:String!,$d:String){issueCreate(input:{teamId:$t,title:$n,description:$d}){success issue{id identifier url}}}';
      const variables = { t: teamId, n: interp(cfg.title || '') || 'Untitled', d: _textOf(cfg, 'description', interp, input) };
      const r = await _send('https://api.linear.app/graphql', { headers: { Authorization: key }, body: { query, variables }, signal, label: 'Linear' });
      return r.error || r.text;
    },
  },
  trello: {
    label: 'Trello Card', icon: 'ti-brand-trello', color: '#0079BF', credentialType: 'custom',
    fields: [
      { key: 'listId', label: 'List ID', type: 'text' },
      { key: 'name', label: 'Card name', type: 'text' },
      { key: 'desc', label: 'Description', type: 'textarea' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'custom credential with fields: key, token' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); if (!d.key || !d.token) return 'Node error: Trello requires a custom credential with key and token';
      const listId = interp(cfg.listId || ''); if (!listId) return 'Node error: Trello node has no list ID';
      const params = new URLSearchParams({ idList: listId, name: interp(cfg.name || '') || _textOf(cfg, 'name', interp, input), desc: cfg.desc ? interp(String(cfg.desc)) : '', key: d.key, token: d.token });
      const resp = await fetch('https://api.trello.com/1/cards?' + params.toString(), { method: 'POST', signal });
      const t = await resp.text().catch(() => '');
      return resp.ok ? t : `Node error: Trello HTTP ${resp.status} — ${t.slice(0, 200)}`;
    },
  },
  notion: {
    label: 'Notion Page', icon: 'ti-brand-notion', color: '#000000', credentialType: 'bearer',
    fields: [
      { key: 'databaseId', label: 'Database ID', type: 'text' },
      { key: 'title', label: 'Page title', type: 'text', placeholder: 'Defaults to the piped input' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Integration token (bearer)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.accessToken || d.apiKey;
      if (!token) return 'Node error: Notion requires an integration-token credential';
      const dbId = interp(cfg.databaseId || ''); if (!dbId) return 'Node error: Notion node has no database ID';
      const body = { parent: { database_id: dbId }, properties: { Name: { title: [{ text: { content: _textOf(cfg, 'title', interp, input) } }] } } };
      const r = await _send('https://api.notion.com/v1/pages', { headers: { Authorization: 'Bearer ' + token, 'Notion-Version': '2022-06-28' }, body, signal, label: 'Notion' });
      return r.error || r.text;
    },
  },
  airtable: {
    label: 'Airtable Record', icon: 'ti-table', color: '#18BFFF', credentialType: 'bearer',
    fields: [
      { key: 'baseId', label: 'Base ID', type: 'text' },
      { key: 'table', label: 'Table', type: 'text' },
      { key: 'fields', label: 'Fields (JSON)', type: 'textarea', placeholder: '{"Name":"{{ $json.name }}"}' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Personal access token (bearer)' },
    ],
    async run({ cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.accessToken || d.apiKey;
      if (!token) return 'Node error: Airtable requires a token credential';
      const baseId = interp(cfg.baseId || ''); const table = interp(cfg.table || '');
      if (!baseId || !table) return 'Node error: Airtable node needs base ID and table';
      let fields = {};
      if (cfg.fields) { try { fields = JSON.parse(interp(String(cfg.fields))); } catch (_) { return 'Node error: Airtable fields is not valid JSON'; } }
      const r = await _send(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`, { headers: { Authorization: 'Bearer ' + token }, body: { fields }, signal, label: 'Airtable' });
      return r.error || r.text;
    },
  },

  // CRM / payments / email ──────────────────────────────────────────────────
  hubspot: {
    label: 'HubSpot Contact', icon: 'ti-address-book', color: '#FF7A59', credentialType: 'bearer',
    fields: [
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'properties', label: 'Extra properties (JSON)', type: 'textarea', placeholder: '{"firstname":"Ada"}' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Private app token (bearer)' },
    ],
    async run({ cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.accessToken || d.apiKey;
      if (!token) return 'Node error: HubSpot requires a token credential';
      const email = interp(cfg.email || ''); if (!email) return 'Node error: HubSpot node has no email';
      const properties = { email };
      if (cfg.properties) { try { Object.assign(properties, JSON.parse(interp(String(cfg.properties)))); } catch (_) { return 'Node error: HubSpot properties is not valid JSON'; } }
      const r = await _send('https://api.hubapi.com/crm/v3/objects/contacts', { headers: { Authorization: 'Bearer ' + token }, body: { properties }, signal, label: 'HubSpot' });
      return r.error || r.text;
    },
  },
  stripe: {
    label: 'Stripe', icon: 'ti-brand-stripe', color: '#635BFF', credentialType: 'bearer',
    fields: [
      { key: 'resource', label: 'Resource', type: 'text', placeholder: 'customers, payment_intents, ...' },
      { key: 'params', label: 'Params (JSON)', type: 'textarea', placeholder: '{"email":"a@b.com"}' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Secret key (bearer)' },
    ],
    async run({ cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.accessToken || d.apiKey;
      if (!token) return 'Node error: Stripe requires a secret-key credential';
      const resource = interp(cfg.resource || ''); if (!resource) return 'Node error: Stripe node has no resource';
      let params = {};
      if (cfg.params) { try { params = JSON.parse(interp(String(cfg.params))); } catch (_) { return 'Node error: Stripe params is not valid JSON'; } }
      const r = await _send(`https://api.stripe.com/v1/${resource}`, { headers: { Authorization: 'Bearer ' + token }, form: _flattenForm(params), signal, label: 'Stripe' });
      return r.error || r.text;
    },
  },
  sendgrid: {
    label: 'SendGrid Email', icon: 'ti-mail', color: '#1A82E2', credentialType: 'bearer',
    fields: [
      { key: 'to', label: 'To', type: 'text' },
      { key: 'from', label: 'From', type: 'text' },
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'text', label: 'Body', type: 'textarea' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'API key (bearer)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.accessToken || d.apiKey;
      if (!token) return 'Node error: SendGrid requires an API key credential';
      const to = interp(cfg.to || ''); const from = interp(cfg.from || '');
      if (!to || !from) return 'Node error: SendGrid node needs To and From';
      const body = { personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject: interp(cfg.subject || '') || '(no subject)', content: [{ type: 'text/plain', value: _textOf(cfg, 'text', interp, input) }] };
      const r = await _send('https://api.sendgrid.com/v3/mail/send', { headers: { Authorization: 'Bearer ' + token }, body, signal, label: 'SendGrid' });
      return r.error || JSON.stringify({ ok: true });
    },
  },
  mailgun: {
    label: 'Mailgun Email', icon: 'ti-mail-forward', color: '#C02428', credentialType: 'apiKey',
    fields: [
      { key: 'domain', label: 'Domain', type: 'text', placeholder: 'mg.example.com' },
      { key: 'from', label: 'From', type: 'text' },
      { key: 'to', label: 'To', type: 'text' },
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'text', label: 'Body', type: 'textarea' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'API key (apiKey credential)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const key = d.apiKey || d.token;
      if (!key) return 'Node error: Mailgun requires an API key credential';
      const domain = interp(cfg.domain || ''); if (!domain) return 'Node error: Mailgun node has no domain';
      const auth = 'Basic ' + Buffer.from(`api:${key}`, 'utf8').toString('base64');
      const form = { from: interp(cfg.from || ''), to: interp(cfg.to || ''), subject: interp(cfg.subject || '') || '(no subject)', text: _textOf(cfg, 'text', interp, input) };
      const r = await _send(`https://api.mailgun.net/v3/${domain}/messages`, { headers: { Authorization: auth }, form, signal, label: 'Mailgun' });
      return r.error || r.text;
    },
  },
  resend: {
    label: 'Resend Email', icon: 'ti-send', color: '#000000', credentialType: 'bearer',
    fields: [
      { key: 'from', label: 'From', type: 'text' },
      { key: 'to', label: 'To', type: 'text' },
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'text', label: 'Body', type: 'textarea' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'API key (bearer)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const token = d.token || d.accessToken || d.apiKey;
      if (!token) return 'Node error: Resend requires an API key credential';
      const from = interp(cfg.from || ''); const to = interp(cfg.to || '');
      if (!from || !to) return 'Node error: Resend node needs From and To';
      const body = { from, to: [to], subject: interp(cfg.subject || '') || '(no subject)', text: _textOf(cfg, 'text', interp, input) };
      const r = await _send('https://api.resend.com/emails', { headers: { Authorization: 'Bearer ' + token }, body, signal, label: 'Resend' });
      return r.error || r.text;
    },
  },
  twilio: {
    label: 'Twilio SMS', icon: 'ti-message-circle', color: '#F22F46', credentialType: 'basic',
    fields: [
      { key: 'to', label: 'To', type: 'text', placeholder: '+15551234567' },
      { key: 'from', label: 'From', type: 'text', placeholder: '+15557654321' },
      { key: 'text', label: 'Message', type: 'textarea' },
      { key: 'credentialId', label: 'Credential', type: 'credential', hint: 'Account SID + Auth Token (basic)' },
    ],
    async run({ input, cfg, interp, resolveCred, signal }) {
      const d = _cred(cfg, resolveCred); const sid = d.username; const token = d.password;
      if (!sid || !token) return 'Node error: Twilio requires a basic credential (Account SID + Auth Token)';
      const to = interp(cfg.to || ''); const from = interp(cfg.from || '');
      if (!to || !from) return 'Node error: Twilio node needs To and From numbers';
      const auth = 'Basic ' + Buffer.from(`${sid}:${token}`, 'utf8').toString('base64');
      const r = await _send(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { headers: { Authorization: auth }, form: { To: to, From: from, Body: _textOf(cfg, 'text', interp, input) }, signal, label: 'Twilio' });
      return r.error || r.text;
    },
  },
};

Object.assign(NODES, CONNECTORS);

function getActionNode(type) {
  return NODES[type] || null;
}

function isActionNode(type) {
  return Object.prototype.hasOwnProperty.call(NODES, type);
}

// Descriptors for the UI canvas (no executor).
function listActionNodeDescriptors() {
  return Object.entries(NODES).map(([type, def]) => ({
    type, label: def.label, icon: def.icon, color: def.color,
    credentialType: def.credentialType || null,
    fields: def.fields || null,
  }));
}

export { getActionNode, isActionNode, listActionNodeDescriptors, _applyAuth };
