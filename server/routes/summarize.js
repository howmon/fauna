// /api/summarize — compact task-state summarization endpoint.
//
// Given a conversation, produces a <=400 word summary describing the
// original task, what's been done, current state, and key facts. Uses
// the standard Copilot chat completions client.

export function registerSummarizeRoutes(app, { getCopilotClient }) {
  app.post('/api/summarize', async (req, res) => {
    const { messages = [], model = 'claude-sonnet-4.6' } = req.body;
    if (!messages.length) return res.json({ summary: '' });
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
        ...messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content.slice(0, 3000)
            : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 3000)
        })),
        { role: 'user', content: 'Summarize the conversation above as a compact task-state note.' }
      ];
      const sumParams = { model, messages: prompt, stream: false };
      if (/^(o[1-9]|gpt-5)/.test(model)) { sumParams.max_completion_tokens = 600; }
      else { sumParams.max_tokens = 600; }
      const resp = await client.chat.completions.create(sumParams);
      const summary = resp.choices[0]?.message?.content?.trim() || '';
      res.json({ summary });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
