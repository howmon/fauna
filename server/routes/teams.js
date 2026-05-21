// Teams integration bundle: Self-Chat Bridge routes, Bot Server management
// routes, and Teams Relay WebSocket endpoint. Extracted from server.js.
//
// `createTeamsBundle(deps)` returns `{ registerRoutes, attachRelay }`. Late-
// bound deps (`getInternalAICaller`, `getDesktopCapturer`, `getActiveModel`)
// are passed as thunks because they're set/reassigned at server bootstrap.

import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';

import {
  getTeamsSettings, updateTeamsSettings, testConnection as teamsTestConnection,
} from '../../teams-bridge.js';
import {
  getBotConfig, updateBotConfig, getBotStatus, startBot, stopBot,
} from '../../teams-bot-manager.js';
import { createTask } from '../../task-manager.js';
import { getCopilotClient } from '../copilot/auth.js';

export function createTeamsBundle({
  iterAgentDirs,
  loadPrefs,
  getInternalAICaller,
  getDesktopCapturer,
  getActiveModel,
  teamsRelaySecret,
}) {
  function registerRoutes(app) {
    // ── Teams Self-Chat Bridge ──────────────────────────────────────────────
    app.get('/api/teams/settings', (req, res) => {
      res.json(getTeamsSettings());
    });

    app.put('/api/teams/settings', (req, res) => {
      const settings = updateTeamsSettings(req.body);
      res.json(settings);
    });

    app.post('/api/teams/test', async (req, res) => {
      try {
        const result = await teamsTestConnection();
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ── Teams Bot Server management ────────────────────────────────────────
    app.get('/api/teams-bot/config', (req, res) => res.json(getBotConfig()));

    app.put('/api/teams-bot/config', (req, res) => res.json(updateBotConfig(req.body)));

    app.get('/api/teams-bot/status', (req, res) => res.json(getBotStatus()));

    app.post('/api/teams-bot/start', (req, res) => {
      if (req.body && Object.keys(req.body).length) updateBotConfig(req.body);
      res.json(startBot());
    });

    app.post('/api/teams-bot/stop', (req, res) => res.json(stopBot()));
  }

  // ── Teams Relay WebSocket endpoint ────────────────────────────────────────
  // The fauna-bot server connects here to forward Teams messages to Fauna AI
  // and relay AI responses back. Authentication uses a shared secret passed
  // as the `secret` query param.

  let _teamsRelayWss = null;

  function _loadAgentsSummary() {
    const agents = [];
    try {
      for (const { name, agentDir } of iterAgentDirs()) {
        const manifestPath = path.join(agentDir, 'agent.json');
        if (!fs.existsSync(manifestPath)) continue;
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (m._parentAgent) continue;
        agents.push({ id: name, name: m.name || name, description: m.description || '' });
      }
    } catch (_) {}
    return agents;
  }

  function attachRelay(server) {
    if (_teamsRelayWss) return;
    _teamsRelayWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
      if (pathname !== '/api/teams-relay') return; // let other handlers deal with it

      // Authenticate via ?secret= query param
      if (teamsRelaySecret) {
        let secret = '';
        try { secret = new URL(req.url, 'http://localhost').searchParams.get('secret') || ''; } catch (_) {}
        if (secret !== teamsRelaySecret) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      _teamsRelayWss.handleUpgrade(req, socket, head, ws => _teamsRelayWss.emit('connection', ws, req));
    });

    _teamsRelayWss.on('connection', (ws) => {
      console.log('[teams-relay] Bot server connected');

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const { reqId, type } = msg;

        const respond = (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'response', reqId, ...data }));
        };

        try {
          switch (type) {
            case 'ping': {
              respond({ version: '1.0', activeModel: getActiveModel() || 'unknown' });
              break;
            }

            case 'chat': {
              const text = await getInternalAICaller()(msg.message || '', msg.model || '');
              respond({ text });
              break;
            }

            case 'shell': {
              const { exec } = await import('child_process');
              const output = await new Promise((res, rej) => {
                exec(msg.command, { timeout: 60000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
                  res({ output: stdout + stderr, exitCode: err ? (err.code || 1) : 0 });
                });
              });
              respond(output);
              break;
            }

            case 'browse': {
              // Simple fetch for text extraction (full browser is more complex)
              const r = await fetch(msg.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
              const html = await r.text();
              const content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                  .replace(/<[^>]+>/g, ' ')
                                  .replace(/\s{2,}/g, ' ')
                                  .trim()
                                  .slice(0, 4000);
              respond({ content });
              break;
            }

            case 'screenshot': {
              const desktopCapturer = getDesktopCapturer();
              if (!desktopCapturer) { respond({ error: 'desktopCapturer not available (not running in Electron)' }); break; }
              const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
              const dataUrl = sources[0]?.thumbnail?.toDataURL() || null;
              respond({ dataUrl });
              break;
            }

            case 'agents/list': {
              respond({ agents: _loadAgentsSummary() });
              break;
            }

            case 'task/create': {
              const task = createTask({ title: msg.title || msg.description, description: msg.description });
              respond({ task: { id: task.id, title: task.title, description: task.description, status: task.status } });
              break;
            }

            case 'models/list': {
              // Return the current provider models list (from the settings cache)
              try {
                const client = getCopilotClient();
                const list = await client.models.list();
                const models = (list.data || []).map(m => ({ id: m.id, name: m.id, provider: 'github-copilot' }));
                respond({ models });
              } catch {
                const active = getActiveModel();
                respond({ models: [{ id: active || 'gpt-4.1', name: active || 'gpt-4.1' }] });
              }
              break;
            }

            case 'playbook/get': {
              const prefs = loadPrefs();
              const instructions = (prefs.playbook || [])
                .filter(p => p.enabled !== false)
                .map(p => p.body || p.content || '')
                .join('\n\n');
              respond({ instructions });
              break;
            }

            default:
              respond({ error: `Unknown request type: ${type}` });
          }
        } catch (err) {
          console.error('[teams-relay] handler error:', err.message);
          const errObj = { error: err.message };
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'response', reqId, ...errObj }));
        }
      });

      ws.on('close', () => console.log('[teams-relay] Bot server disconnected'));
      ws.on('error', (e) => console.error('[teams-relay] WS error:', e.message));
    });
  }

  return { registerRoutes, attachRelay };
}
