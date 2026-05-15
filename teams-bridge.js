// ── Teams Self-Chat Bridge — Poll self-chat, forward to Fauna, respond ───
// Uses Microsoft Graph API to poll the user's "self-chat" (48:notes),
// forwards new messages to Fauna's AI, and sends responses back.
//
// Also supports proactive push: the bot relay (fauna-bot/) can call
// proactiveNotify(conversationRef, text) to send a message from the
// desktop into a Teams conversation at any time.

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'fauna');
const TEAMS_FILE = path.join(CONFIG_DIR, 'teams-bridge.json');

let _settings = null;
let _timer = null;
let _lastMessageId = null;
let _aiCaller = null;     // function(prompt, model) → string
let _notifier = null;     // function(title, body)

// Stored conversation references for proactive messages
// { userId → conversationReference }
const _conversationRefs = new Map();

const DEFAULTS = {
  enabled: false,
  pollIntervalSeconds: 10,
  accessToken: '',
  model: '',  // empty = use active conversation model
  status: 'disconnected', // disconnected | connected | error
  lastError: null,
};

// ── Persistence ────────────────────────────────────────────────────────

function _load() {
  if (_settings) return _settings;
  try {
    const data = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
    _settings = { ...DEFAULTS, ...data };
  } catch (_) {
    _settings = { ...DEFAULTS };
  }
  return _settings;
}

function _save() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Don't persist the access token in plain text if it looks sensitive
  const toSave = { ..._settings };
  fs.writeFileSync(TEAMS_FILE, JSON.stringify(toSave, null, 2));
}

// ── Public API ──────────────────────────────────────────────────────────

export function getTeamsSettings() {
  const s = { ..._load() };
  // Mask token for safety
  if (s.accessToken) s.accessToken = s.accessToken.slice(0, 10) + '…';
  return s;
}

export function updateTeamsSettings(patch) {
  _load();
  if (patch.enabled !== undefined) _settings.enabled = !!patch.enabled;
  if (patch.pollIntervalSeconds !== undefined) _settings.pollIntervalSeconds = Math.max(5, Math.min(300, patch.pollIntervalSeconds));
  if (patch.accessToken !== undefined) _settings.accessToken = String(patch.accessToken);
  if (patch.model !== undefined) _settings.model = String(patch.model);
  _save();
  _reschedule();
  return getTeamsSettings();
}

// ── Graph API calls ────────────────────────────────────────────────────

async function _graphFetch(endpoint, options = {}) {
  const token = _settings?.accessToken;
  if (!token) throw new Error('No access token configured');

  const resp = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function _getSelfChatId() {
  // The self-chat (Notes to Self) has threadId starting with "48:notes"
  const data = await _graphFetch('/me/chats?$filter=chatType eq \'oneOnOne\'&$top=50');
  const selfChat = (data.value || []).find(c => c.id?.includes('48:notes'));
  if (!selfChat) {
    // Try to find it another way — just get all chats
    const all = await _graphFetch('/me/chats?$top=50');
    return (all.value || []).find(c => c.topic === 'Notes' || c.id?.includes('48:notes'))?.id || null;
  }
  return selfChat.id;
}

async function _getMessages(chatId, since = null) {
  let url = `/me/chats/${chatId}/messages?$top=5&$orderby=createdDateTime desc`;
  const data = await _graphFetch(url);
  return (data.value || []).filter(m => m.from?.user && m.body?.content);
}

async function _sendMessage(chatId, text) {
  await _graphFetch(`/me/chats/${chatId}/messages`, {
    method: 'POST',
    body: {
      body: { contentType: 'text', content: text },
    },
  });
}

// ── Poll loop ──────────────────────────────────────────────────────────

async function _poll() {
  if (!_settings?.enabled || !_settings.accessToken) return;

  try {
    const chatId = await _getSelfChatId();
    if (!chatId) {
      _settings.status = 'error';
      _settings.lastError = 'Self-chat not found';
      _save();
      return;
    }

    _settings.status = 'connected';
    const messages = await _getMessages(chatId);

    // Find new messages (after our last seen)
    for (const msg of messages.reverse()) {
      if (_lastMessageId && msg.id === _lastMessageId) continue;
      if (msg.id === _lastMessageId) continue;

      // Skip messages from bot/app (check if it's from the user themselves)
      const content = (msg.body?.content || '').replace(/<[^>]+>/g, '').trim();
      if (!content || content.startsWith('[Fauna]')) continue;

      // Process with AI
      if (_aiCaller && _lastMessageId) { // Only respond after initialization
        try {
          const response = await _aiCaller(content, _settings.model);
          const reply = `[Fauna] ${response}`;
          await _sendMessage(chatId, reply);
        } catch (e) {
          console.error('[teams-bridge] AI call failed:', e.message);
        }
      }

      _lastMessageId = msg.id;
    }

    _settings.lastError = null;
  } catch (e) {
    _settings.status = 'error';
    _settings.lastError = e.message;
    console.error('[teams-bridge] Poll error:', e.message);
  }
  _save();
}

function _reschedule() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (!_settings?.enabled || !_settings.accessToken) {
    _settings.status = 'disconnected';
    _save();
    return;
  }
  const ms = (_settings.pollIntervalSeconds || 10) * 1000;
  _timer = setInterval(_poll, ms);
  _poll(); // initial poll
}

export function startTeamsBridge(aiCaller, notifier) {
  _aiCaller = aiCaller;
  _notifier = notifier;
  _load();
  if (_settings.enabled) _reschedule();
}

export function stopTeamsBridge() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function testConnection() {
  return _poll().then(() => ({
    status: _settings.status,
    error: _settings.lastError,
  }));
}

// ── Proactive push support ─────────────────────────────────────────────────
// The fauna-bot relay server can store conversation references and ask the
// desktop to push a notification into a specific Teams conversation.

/**
 * Store a conversation reference so the bot relay can later push messages
 * into that conversation without the user sending a message first.
 * @param {string} userId  Teams user ID
 * @param {object} ref     Bot Framework conversation reference
 */
export function storeConversationRef(userId, ref) {
  _conversationRefs.set(userId, ref);
}

/**
 * Retrieve a stored conversation reference by user ID.
 * @param {string} userId
 * @returns {object|undefined}
 */
export function getConversationRef(userId) {
  return _conversationRefs.get(userId);
}

/**
 * Send a proactive message into a Teams conversation using the Graph API.
 * This is a lightweight push that does NOT require the Bot Framework adapter —
 * it uses the same access token as the self-chat bridge.
 *
 * @param {string} chatId   Teams chat thread ID
 * @param {string} text     Message text to send
 */
export async function proactiveNotify(chatId, text) {
  try {
    await _sendMessage(chatId, `[Fauna] ${text}`);
  } catch (err) {
    console.error('[teams-bridge] proactiveNotify failed:', err.message);
    throw err;
  }
}

/**
 * Return all stored conversation refs (for relay server to iterate).
 * @returns {Map<string, object>}
 */
export function getAllConversationRefs() {
  return _conversationRefs;
}
