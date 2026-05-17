export function registerConversationRoutes(app, deps) {
  const { fs, path, configDir, getCopilotClient } = deps;
  const conversationsFile = path.join(configDir, 'conversations.json');
  const conversationSseClients = new Set();

  function readServerConversations() {
    try {
      const data = JSON.parse(fs.readFileSync(conversationsFile, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (_) {
      return [];
    }
  }

  function writeServerConversations(conversations) {
    fs.mkdirSync(configDir, { recursive: true });
    const tmp = conversationsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Array.isArray(conversations) ? conversations : [], null, 2));
    fs.renameSync(tmp, conversationsFile);
  }

  function sendConversationEvent(type, payload = {}) {
    const data = JSON.stringify({ type, ...payload, ts: Date.now() });
    for (const client of conversationSseClients) {
      try { client.write(`data: ${data}\n\n`); } catch (_) {}
    }
  }

  app.get('/api/conversations', (req, res) => {
    const full = req.query.full === '1' || req.query.full === 'true';
    const conversations = readServerConversations()
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    if (full) return res.json(conversations);
    res.json(conversations.map(conv => ({
      id: conv.id,
      title: conv.title,
      model: conv.model,
      projectId: conv.projectId,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
    })));
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

  app.get('/api/conversations/:id', (req, res) => {
    const conv = readServerConversations().find(c => c.id === req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conv);
  });

  app.put('/api/conversations/:id', (req, res) => {
    const conversations = readServerConversations();
    const idx = conversations.findIndex(c => c.id === req.params.id);
    const conv = { ...(req.body || {}), id: req.params.id, updatedAt: req.body?.updatedAt || Date.now() };
    if (!conv.createdAt) conv.createdAt = Date.now();
    if (idx >= 0) conversations[idx] = { ...conversations[idx], ...conv };
    else conversations.push(conv);
    writeServerConversations(conversations);
    sendConversationEvent('upsert', { conversation: conv });
    res.json({ ok: true, conversation: conv });
  });

  app.delete('/api/conversations/:id', (req, res) => {
    const conversations = readServerConversations();
    const next = conversations.filter(c => c.id !== req.params.id);
    writeServerConversations(next);
    sendConversationEvent('delete', { id: req.params.id });
    res.json({ ok: true, deleted: conversations.length - next.length });
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
