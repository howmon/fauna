// /api/summarize — compact task-state summarization endpoint.
//
// Given a conversation, produces a <=400 word summary describing the
// original task, what's been done, current state, and key facts. Uses
// the standard Copilot chat completions client.

// Normalize one conversation message into a plain {role, content} pair that
// the Copilot completions API accepts. Returns null if the message has no
// usable text (e.g. tool calls, empty arrays, attachments-only).
function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  let role = m.role;
  // Copilot only accepts user/assistant/system here.
  if (role !== 'user' && role !== 'assistant' && role !== 'system') role = 'user';
  let text = '';
  if (typeof m.content === 'string') {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    text = m.content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n');
  } else if (m.content && typeof m.content === 'object' && typeof m.content.text === 'string') {
    text = m.content.text;
  }
  text = (text || '').trim();
  if (!text) return null;
  return { role, content: text.slice(0, 3000) };
}

export function registerSummarizeRoutes(app, { getCopilotClient }) {
  app.post('/api/summarize', async (req, res) => {
    const { messages = [], model: requestedModel } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.json({ summary: '' });
    const normalized = messages.map(normalizeMessage).filter(Boolean);
    if (!normalized.length) return res.json({ summary: '' });
    const model = requestedModel || 'claude-sonnet-4.6';
    try {
      const client = getCopilotClient();
      const prompt = [
        { role: 'system', content:
          'You are a concise task-state summarizer. ' +
          'Given a conversation, produce a compact summary (max 400 words) covering:\n' +
          '1. The original task/goal\n' +
          '2. What has already been completed (files created, commands run, results)\n' +
          '3. Current state and any pending steps\n' +
          '4. Key facts discovered (paths, errors, findings)\n' +
          'Write in past tense. Be specific — include file paths, command names, and exact results. ' +
          'Omit greetings, filler, and markdown formatting.'
        },
        ...normalized,
        { role: 'user', content: 'Summarize the conversation above as a compact task-state note.' }
      ];
      const sumParams = { model, messages: prompt, stream: false };
      if (/^(o[1-9]|gpt-5)/.test(model)) { sumParams.max_completion_tokens = 600; }
      else { sumParams.max_tokens = 600; }
      let resp;
      try {
        resp = await client.chat.completions.create(sumParams);
      } catch (modelErr) {
        // If the requested model is rejected (unknown/unavailable), retry once
        // with a known-good default so context compression still succeeds.
        const fallback = 'gpt-4o-mini';
        if (model !== fallback) {
          console.warn('[summarize] model "' + model + '" failed (' + modelErr.message + ') — retrying with ' + fallback);
          sumParams.model = fallback;
          delete sumParams.max_completion_tokens;
          sumParams.max_tokens = 600;
          resp = await client.chat.completions.create(sumParams);
        } else {
          throw modelErr;
        }
      }
      const summary = resp.choices[0]?.message?.content?.trim() || '';
      res.json({ summary });
    } catch (e) {
      console.error('[summarize] failed:', e && (e.stack || e.message || e));
      res.status(500).json({ error: (e && e.message) || 'summarize failed' });
    }
  });
}
