// /api/summarize — compact task-state summarization endpoint.
//
// Given a conversation, produces a <=400 word summary describing the
// original task, what's been done, current state, and key facts. Uses
// the standard Copilot chat completions client.  The actual summarizer
// logic lives in ../lib/summarize-history.js so chat.js can also call it
// in-process for auto-compaction.

import { summarizeHistory } from '../lib/summarize-history.js';

export function registerSummarizeRoutes(app, { getCopilotClient }) {
  app.post('/api/summarize', async (req, res) => {
    const { messages = [], model: requestedModel } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.json({ summary: '' });
    const model = requestedModel || 'claude-sonnet-4.6';
    try {
      const client = getCopilotClient();
      const summary = await summarizeHistory(messages, { client, model });
      res.json({ summary });
    } catch (e) {
      console.error('[summarize] failed:', e && (e.stack || e.message || e));
      res.status(500).json({ error: (e && e.message) || 'summarize failed' });
    }
  });
}
