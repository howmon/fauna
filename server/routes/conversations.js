import { createConversationStore, PayloadTooLargeError, migrateLegacyToSplit } from '../lib/conversation-store.js';
import { extractFacts as extractMemoryFacts } from '../lib/memory-extractor.js';
import { getProject } from '../../project-manager.js';

export function registerConversationRoutes(app, deps) {
  const { fs, path, configDir, getCopilotClient } = deps;
  // The store abstracts away single-file vs split-file storage. Reads/writes
  // are async and serialized through a per-id mutex inside the store. Mode
  // is selected via FAUNA_CONV_STORAGE (default 'single' for compatibility).
  const store = deps.conversationStore || createConversationStore({ configDir });
  const conversationSseClients = new Set();

  // If split mode is active and no split layout exists yet, run the one-time
  // migration in the background so existing users move forward seamlessly
  // the first time they opt in. Failures are logged, not fatal.
  const mode = (process.env.FAUNA_CONV_STORAGE || '').toLowerCase();
  if (mode === 'split' || mode === 'split-only') {
    migrateLegacyToSplit({ configDir })
      .then(r => {
        if (r.skipped) return;
        if (r.errors?.length) {
          console.warn('[conversations] migration completed with errors:', r);
        } else if (r.migrated) {
          console.log(`[conversations] migrated ${r.migrated} conversations to split layout`);
        }
      })
      .catch(e => console.error('[conversations] migration failed:', e.message));
  }

  function sendConversationEvent(type, payload = {}) {
    const data = JSON.stringify({ type, ...payload, ts: Date.now() });
    for (const client of conversationSseClients) {
      try { client.write(`data: ${data}\n\n`); } catch (_) {}
    }
  }

  // ── Memory extraction (Phase 1) ────────────────────────────────────
  // Debounce per conversation: while edits stream in, we coalesce to a
  // single extraction 8s after the last write. Skipped when no project is
  // attached or when the project disables auto-extract.
  const _extractTimers = new Map(); // convId -> Timeout
  const EXTRACT_DEBOUNCE_MS = 8000;

  function _scheduleMemoryExtraction(conv) {
    if (!conv || !conv.id || !conv.projectId) return;
    const project = getProject(conv.projectId);
    if (!project) return;
    const mcfg = project.memoryConfig || {};
    if (mcfg.autoExtract !== 'on-save') return;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    if (messages.length < 2) return;

    const existing = _extractTimers.get(conv.id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      _extractTimers.delete(conv.id);
      try {
        const client = getCopilotClient();
        const aiCaller = async (prompt) => {
          const resp = await client.chat.completions.create({
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 800,
            temperature: 0.2,
          });
          return resp?.choices?.[0]?.message?.content || '';
        };
        const r = await extractMemoryFacts({
          messages,
          projectId: conv.projectId,
          conversationId: conv.id,
          aiCaller,
          autoApprove: mcfg.requireApproval !== true,
        });
        if (r.applied || r.proposals.length) {
          sendConversationEvent('memory_proposal', {
            conversationId: conv.id,
            projectId: conv.projectId,
            applied: r.applied,
            pending: r.proposals.filter(p => p.status === 'pending').length,
          });
        }
      } catch (e) {
        console.warn('[conversations] memory extraction failed:', e?.message || e);
      }
    }, EXTRACT_DEBOUNCE_MS);
    _extractTimers.set(conv.id, t);
  }

  app.get('/api/conversations', async (req, res) => {
    const full = req.query.full === '1' || req.query.full === 'true';
    try {
      const out = await store.list({ full });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Migrate the legacy single-file `conversations.json` into the per-conv
  // split layout. Idempotent and non-destructive: leaves the legacy file in
  // place and writes a timestamped backup. Safe to call repeatedly.
  app.post('/api/conversations/_migrate', async (req, res) => {
    try {
      const force = req.query.force === '1' || req.query.force === 'true' || req.body?.force === true;
      const result = await migrateLegacyToSplit({ configDir, force });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/conversations/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'ready', ts: Date.now() })}\n\n`);
    conversationSseClients.add(res);
    const keepalive = setInterval(() => {
      try { res.write(`: keepalive ${Date.now()}\n\n`); } catch (_) {}
    }, 25000);
    req.on('close', () => {
      clearInterval(keepalive);
      conversationSseClients.delete(res);
    });
  });

  app.get('/api/conversations/:id', async (req, res) => {
    try {
      const conv = await store.get(req.params.id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      res.json(conv);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/conversations/:id', async (req, res) => {
    try {
      const incoming = { ...(req.body || {}), id: req.params.id };
      const conv = await store.put(req.params.id, incoming);
      sendConversationEvent('upsert', { conversation: conv });
      res.json({ ok: true, conversation: conv });
      // Phase 1: fire-and-forget memory extraction when the active project's
      // memoryConfig.autoExtract === 'on-save'. Debounced per-conversation so
      // rapid typing in the UI doesn't trigger N parallel LLM calls.
      try { _scheduleMemoryExtraction(conv); } catch (_) { /* non-fatal */ }
    } catch (e) {
      if (e instanceof PayloadTooLargeError) {
        return res.status(413).json({ error: e.message, detail: e.detail });
      }
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/conversations/:id', async (req, res) => {
    try {
      const deleted = await store.del(req.params.id);
      sendConversationEvent('delete', { id: req.params.id });
      res.json({ ok: true, deleted });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/conversation-title', async (req, res) => {
    try {
      const { messages = [], model: reqModel } = req.body;
      if (!messages.length) return res.status(400).json({ error: 'No messages provided' });

      const client = getCopilotClient();
      const titleModel = reqModel || 'gpt-4.1';
      const systemPrompt = 'You are a helpful assistant that generates short, descriptive titles for conversations. Generate a concise title (3-6 words) that captures the main topic. Return ONLY the title, no quotes, no explanation.';

      const titleMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate a short title for this conversation:\n\n' + messages.map(m => `${m.role}: ${m.content}`).join('\n\n') },
      ];

      const completion = await client.chat.completions.create({
        model: titleModel,
        messages: titleMessages,
        max_tokens: 50,
        temperature: 0.7,
      });

      const title = (completion.choices[0]?.message?.content || 'New conversation').trim();
      res.json({ title });
    } catch (err) {
      console.error('[conversation-title] Error:', err.message);
      try {
        const { messages = [] } = req.body;
        const firstUser = messages.find(m => m.role === 'user');
        const raw = (firstUser && firstUser.content) ? firstUser.content.trim() : '';
        const fallback = raw
          ? raw.replace(/\s+/g, ' ').slice(0, 60).replace(/[^a-zA-Z0-9 ,.'!?-]/g, '').trim() || 'New conversation'
          : 'New conversation';
        res.json({ title: fallback });
      } catch (_) {
        res.json({ title: 'New conversation' });
      }
    }
  });
}
