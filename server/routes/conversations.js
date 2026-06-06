import { createConversationStore, PayloadTooLargeError, migrateLegacyToSplit } from '../lib/conversation-store.js';
import { extractFacts as extractMemoryFacts } from '../lib/memory-extractor.js';
import { getProject } from '../../project-manager.js';
import { generateMini, tryMini, isModelCached as isMiniCached, warmupMini, getMiniModelId, isLocalMiniEnabled } from '../llm/local-mini.js';

// Normalize a model-generated title: strip wrapping quotes, a leading "Title:"
// label, surrounding whitespace/markdown, and collapse to a single short line.
// Small local models sometimes add quotes or a prefix despite instructions.
function _cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let t = raw.trim();
  // Take only the first non-empty line (models may add explanation after).
  t = (t.split(/\r?\n/).find(l => l.trim()) || '').trim();
  t = t.replace(/^\s*(?:title|conversation title)\s*[:\-]\s*/i, '');
  t = t.replace(/^["'`*_\s]+|["'`*_.\s]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 80);
}


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
        // Local-first memory extraction: the bundled mini model handles this
        // short, structured (JSON facts) task with no AI key. If the local
        // weights aren't cached or it returns nothing usable, fall back to
        // Copilot so a fact is never silently dropped.
        const aiCaller = async (prompt) => {
          const local = await tryMini(
            [{ role: 'user', content: prompt }],
            { maxTokens: 800, temperature: 0.2 }
          );
          if (local) return local;
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
    // Allow the alternate-loopback-host EventSource (page on localhost, stream
    // on 127.0.0.1 or vice-versa) so persistent streams use a separate socket
    // pool from request traffic. See faunaStreamUrl() in public/js/state.js.
    const _o = req.headers.origin;
    if (_o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(_o)) {
      res.setHeader('Access-Control-Allow-Origin', _o);
      res.setHeader('Vary', 'Origin');
    }
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

      const systemPrompt = 'You are a helpful assistant that generates short, descriptive titles for conversations. Generate a concise title (3-6 words) that captures the main topic. Return ONLY the title, no quotes, no explanation.';
      const titleMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate a short title for this conversation:\n\n' + messages.map(m => `${m.role}: ${m.content}`).join('\n\n') },
      ];

      // Local-first: titles are short and latency-tolerant, so prefer the
      // bundled mini model when its weights are cached (works with no AI key /
      // offline). Falls through to Copilot when not cached or it returns junk.
      const localRaw = await tryMini(titleMessages, { maxTokens: 24, temperature: 0.5 });
      if (localRaw) {
        const local = _cleanTitle(localRaw);
        if (local) return res.json({ title: local, source: 'local', model: getMiniModelId() });
      }

      // Copilot fallback chain — claude-* models can intermittently return
      // empty choices on this endpoint, which previously yielded a bare
      // "New conversation" placeholder that the client would lock in. Try the
      // requested model first, then fall back to the reliable OpenAI minis so a
      // transient empty response doesn't poison the title.
      const client = getCopilotClient();
      const chain = [reqModel || 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1']
        .filter((m, i, a) => m && a.indexOf(m) === i);
      for (const m of chain) {
        try {
          const completion = await client.chat.completions.create({
            model: m,
            messages: titleMessages,
            max_tokens: 50,
            temperature: 0.7,
          });
          const title = _cleanTitle(completion.choices?.[0]?.message?.content);
          if (title) return res.json({ title, source: 'copilot', model: m });
        } catch (e) {
          console.error(`[conversation-title] model=${m} error:`, e.message);
        }
      }

      // Every model failed/returned empty. Derive a slug from the first user
      // message rather than fabricating a generic placeholder, and tag the
      // source so the client can decline to overwrite a good existing title.
      const firstUser = messages.find(m => m.role === 'user');
      const raw = (firstUser && typeof firstUser.content === 'string') ? firstUser.content.trim() : '';
      const slug = raw
        ? raw.replace(/\s+/g, ' ').slice(0, 60).replace(/[^a-zA-Z0-9 ,.'!?-]/g, '').trim()
        : '';
      res.json({ title: slug || 'New conversation', source: slug ? 'fallback' : 'none' });
    } catch (err) {
      console.error('[conversation-title] Error:', err.message);
      try {
        const { messages = [] } = req.body;
        const firstUser = messages.find(m => m.role === 'user');
        const raw = (firstUser && firstUser.content) ? firstUser.content.trim() : '';
        const fallback = raw
          ? raw.replace(/\s+/g, ' ').slice(0, 60).replace(/[^a-zA-Z0-9 ,.'!?-]/g, '').trim()
          : '';
        res.json({ title: fallback || 'New conversation', source: fallback ? 'fallback' : 'none' });
      } catch (_) {
        res.json({ title: 'New conversation', source: 'none' });
      }
    }
  });

  // Real, model-generated "recommended next actions" for a conversation.
  // Uses the existing Copilot connection (the discovered gh token — no separate
  // AI key) with a fast/light model. Returns a JSON array of short, contextual
  // user-facing follow-up actions. On any failure returns an empty list so the
  // UI simply shows no suggestion bar (no canned/regex fallback).
  const SUGGESTION_SYSTEM_PROMPT = [
    'You generate the user\'s most likely next actions in a chat with an AI coding/assistant app.',
    'Given the conversation, return exactly 3 short, specific follow-up actions the USER might take next.',
    'Phrase each as a concise action the user would click — an imperative the assistant can act on',
    '(e.g. "Run the tests", "Explain the auth flow", "Add error handling", "Show me an example").',
    'Rules:',
    '- Each suggestion ≤ 6 words.',
    '- Make them genuinely relevant to what was JUST discussed — not generic filler.',
    '- No duplicates. No numbering. No trailing punctuation.',
    '- Return ONLY a JSON array of 3 strings. No prose, no markdown, no code fences.',
  ].join('\n');

  function _parseSuggestionArray(raw) {
    let s = String(raw || '').trim();
    s = s.replace(/^```[\w-]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    let arr;
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch (_) { return []; }
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      if (typeof item !== 'string') continue;
      const v = item.trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
      if (out.length >= 4) break;
    }
    return out;
  }

  app.post('/api/conversation-suggestions', async (req, res) => {
    try {
      const { messages = [], model: reqModel } = req.body;
      if (!Array.isArray(messages) || !messages.length) {
        return res.status(400).json({ error: 'No messages provided' });
      }

      const convText = messages
        .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
        .join('\n\n')
        .slice(0, 8000);
      const sugMessages = [
        { role: 'system', content: SUGGESTION_SYSTEM_PROMPT },
        { role: 'user', content: 'Conversation so far:\n\n' + convText + '\n\nReturn the JSON array of 3 suggestions now.' },
      ];

      // 1. Local mini model FIRST — fully in-process, no API/network at
      // inference time. Only used inline once the weights are already cached;
      // otherwise we kick off a background download and fall through to Copilot
      // for THIS request so the user isn't blocked on a multi-hundred-MB fetch.
      // Opt-in only (see isLocalMiniEnabled): loading onnxruntime in the main
      // process can crash the app on failure, so it's off unless enabled.
      if (isLocalMiniEnabled()) {
        if (isMiniCached()) {
          try {
            const raw = await generateMini(sugMessages, { maxTokens: 120, temperature: 0.4 });
            const local = _parseSuggestionArray(raw);
            if (local.length) return res.json({ suggestions: local, source: 'local', model: getMiniModelId() });
          } catch (e) {
            console.error('[conversation-suggestions] local model error:', e.message);
          }
        } else {
          // Warm the cache in the background for next time; don't await.
          warmupMini().catch(() => {});
        }
      }

      // 2. Copilot fallback — fast/light model via the existing connection
      // (discovered gh token, no separate AI key). claude-* can return empty
      // choices on this endpoint, so default to the OpenAI minis.
      const client = getCopilotClient();
      const primary = reqModel || 'gpt-4.1-mini';
      const chain = [primary, 'gpt-4.1'].filter((m, i, a) => a.indexOf(m) === i);
      let suggestions = [];
      for (const m of chain) {
        try {
          const completion = await client.chat.completions.create({
            model: m,
            messages: sugMessages,
            max_tokens: 120,
            temperature: 0.4,
          });
          suggestions = _parseSuggestionArray(completion.choices?.[0]?.message?.content);
          if (suggestions.length) break;
        } catch (e) {
          console.error(`[conversation-suggestions] model=${m} error:`, e.message);
        }
      }
      res.json({ suggestions, source: 'copilot' });
    } catch (err) {
      console.error('[conversation-suggestions] Error:', err.message);
      res.json({ suggestions: [] });
    }
  });
}
