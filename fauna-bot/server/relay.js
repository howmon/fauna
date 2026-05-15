/**
 * Fauna Relay — WebSocket client that bridges the Teams bot to the
 * Fauna desktop app running on the user's machine (default :3737).
 *
 * The relay:
 *  - Connects to Fauna desktop via WS at FAUNA_WS_URL
 *  - Authenticates with a shared FAUNA_SECRET token
 *  - Queues outbound requests while disconnected, drains on reconnect
 *  - Maps each request to a Promise so callers can await the response
 *  - Auto-reconnects with exponential back-off (max 30 s)
 *  - Emits 'push' events for unsolicited desktop → Teams notifications
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

const FAUNA_WS_URL  = process.env.FAUNA_WS_URL  || 'ws://localhost:3737/api/teams-relay';
const FAUNA_SECRET  = process.env.FAUNA_SECRET   || '';
const MAX_BACKOFF   = 30_000;

class FaunaRelay extends EventEmitter {
  constructor() {
    super();
    this._ws          = null;
    this._pending     = new Map();   // reqId → { resolve, reject, timer }
    this._queue       = [];          // outbound messages buffered while disconnected
    this._backoff     = 1_000;
    this._reconnTimer = null;
    this._connected   = false;
    this._intentionalClose = false;
  }

  get isConnected() { return this._connected; }

  // ── Connect ──────────────────────────────────────────────────────────────

  connect() {
    if (this._ws) return;
    this._intentionalClose = false;
    this._open();
  }

  disconnect() {
    this._intentionalClose = true;
    if (this._reconnTimer) { clearTimeout(this._reconnTimer); this._reconnTimer = null; }
    if (this._ws) { this._ws.terminate(); this._ws = null; }
    this._connected = false;
  }

  _open() {
    const url = FAUNA_SECRET
      ? `${FAUNA_WS_URL}?secret=${encodeURIComponent(FAUNA_SECRET)}`
      : FAUNA_WS_URL;

    const ws = new WebSocket(url);
    this._ws = ws;

    ws.on('open', () => {
      this._connected = true;
      this._backoff   = 1_000;
      console.log('[fauna-relay] Connected to Fauna desktop');
      this.emit('connect');
      this._drain();
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'response' && msg.reqId && this._pending.has(msg.reqId)) {
        const { resolve, reject, timer } = this._pending.get(msg.reqId);
        this._pending.delete(msg.reqId);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg);
      } else if (msg.type === 'push') {
        // Unsolicited notification from desktop (e.g., task complete)
        this.emit('push', msg);
      }
    });

    ws.on('close', () => {
      this._connected = false;
      this._ws = null;
      if (!this._intentionalClose) {
        this.emit('disconnect');
        this._scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      console.error('[fauna-relay] WS error:', err.message);
      this.emit('error', err);
    });
  }

  _scheduleReconnect() {
    this._reconnTimer = setTimeout(() => {
      console.log('[fauna-relay] Reconnecting…');
      this._open();
    }, this._backoff);
    this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF);
  }

  _drain() {
    while (this._queue.length && this._connected && this._ws?.readyState === WebSocket.OPEN) {
      const { payload, resolve, reject, timer } = this._queue.shift();
      this._send(payload, resolve, reject, timer);
    }
  }

  // ── Send request and await response ──────────────────────────────────────

  request(payload, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msg   = { ...payload, reqId };

      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error('Fauna desktop request timed out'));
      }, timeoutMs);

      if (this._connected && this._ws?.readyState === WebSocket.OPEN) {
        this._send(msg, resolve, reject, timer);
      } else {
        this._queue.push({ payload: msg, resolve, reject, timer });
      }
    });
  }

  _send(msg, resolve, reject, timer) {
    this._pending.set(msg.reqId, { resolve, reject, timer });
    this._ws.send(JSON.stringify(msg), (err) => {
      if (err) {
        this._pending.delete(msg.reqId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ── Convenience helpers ───────────────────────────────────────────────────

  async chat(message, model = '') {
    const res = await this.request({ type: 'chat', message, model });
    return res.text || '';
  }

  async shell(command) {
    const res = await this.request({ type: 'shell', command }, 120_000);
    return { output: res.output || '', exitCode: res.exitCode ?? 0 };
  }

  async browse(url) {
    const res = await this.request({ type: 'browse', url }, 30_000);
    return res.content || '';
  }

  async screenshot() {
    const res = await this.request({ type: 'screenshot' }, 15_000);
    return res.dataUrl || null; // base64 data URL
  }

  async listAgents() {
    const res = await this.request({ type: 'agents/list' });
    return res.agents || [];
  }

  async createTask(description) {
    const res = await this.request({ type: 'task/create', description });
    return res.task || {};
  }

  async listModels() {
    const res = await this.request({ type: 'models/list' });
    return res.models || [];
  }

  async getPlaybook() {
    const res = await this.request({ type: 'playbook/get' });
    return res.instructions || '';
  }

  async status() {
    if (!this._connected) return { connected: false };
    try {
      const res = await this.request({ type: 'ping' }, 5_000);
      return { connected: true, version: res.version, model: res.activeModel };
    } catch {
      return { connected: false };
    }
  }
}

// Singleton
export const relay = new FaunaRelay();
