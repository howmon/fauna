// server/routes/chat-misc.js
//
// Smaller chat-related routes that are independent from the main /api/chat
// streaming handler. Extracted to keep server.js focused.
//
//   POST /api/chat/debug-prompt   — prompt-layer inspection or legacy preview
//   POST /api/chat-summary        — short summary of a conversation
//   POST /api/composition/plan    — multi-agent task planner
//
// Deps:
//   - browserBuildContext : the bundled "browser build context" system prompt
//                           string (used by debug-prompt legacy mode)

import { getCopilotClient } from '../copilot/auth.js';

export function registerChatMiscRoutes(app, { browserBuildContext = '' } = {}) {
  // ── /api/chat/debug-prompt ──────────────────────────────────────────────
  app.post('/api/chat/debug-prompt', (req, res) => {
    const { systemPrompt = '', contextSummary = '', clientContext = 'app', noTools = false, promptLayers } = req.body || {};

    // Layer-inspection mode (called by /debug-prompt slash command).
    if (Array.isArray(promptLayers)) {
      const layers = promptLayers.map((l, i) => ({
        order: i + 1,
        name: l.name || `layer-${i + 1}`,
        source: l.source || l.name || '',
        chars: (l.content || '').length,
        truncated: l.truncated || false,
        included: (l.content || '').length > 0,
      }));
      const totalChars = layers.reduce((sum, l) => sum + l.chars, 0);
      return res.json({ ok: true, mode: 'layers', layers, totalChars });
    }

    // Legacy single-system-prompt mode.
    const isCLI = clientContext === 'cli';
    const cliHint = isCLI ? `\n\n## Output Format
You are running in a terminal CLI. Respond in plain, readable text. Do NOT use markdown headers (###), horizontal rules (---), or emojis. Use plain bullet points (- or *) only when a list genuinely helps. Be concise and direct. Never emit browser-action or browser-ext-action code blocks — those do not work in the terminal.` : '';
    const sections = [
      { name: 'client system prompt', content: systemPrompt.trim() + cliHint },
      { name: 'browser build context', content: noTools || isCLI ? '' : browserBuildContext },
      { name: 'task context summary', content: contextSummary ? `\n## Task Context (auto-summarized from earlier conversation)\n${contextSummary}` : '' },
    ].filter(s => s.content);
    const fullSystem = sections.map(s => s.content).join('\n');
    res.json({
      ok: true,
      mode: 'legacy',
      sections: sections.map(s => ({ name: s.name, chars: s.content.length })),
      chars: fullSystem.length,
      systemPrompt: fullSystem,
    });
  });

  // ── /api/chat-summary ───────────────────────────────────────────────────
  // Generate a short conversation summary for agent context handoff.
  app.post('/api/chat-summary', async (req, res) => {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: 'messages required' });
    try {
      const client = getCopilotClient();
      const response = await client.chat.completions.create({
        model: 'claude-sonnet-4.6',
        max_tokens: 500,
        messages: [
          { role: 'system', content: 'Summarise the following conversation in 3-5 concise sentences, capturing the key topics, decisions, and any pending questions. Be factual and brief.' },
          { role: 'user', content: typeof messages === 'string' ? messages : JSON.stringify(messages) }
        ]
      });
      const summary = response.choices?.[0]?.message?.content || '';
      res.json({ summary });
    } catch (_) {
      res.json({ summary: '' });
    }
  });

  // ── /api/composition/plan ───────────────────────────────────────────────
  // Multi-agent composition planner: given a task and a list of agents, assign
  // each agent a sub-task and an execution order.
  app.post('/api/composition/plan', async (req, res) => {
    const { task, agents, conversationContext } = req.body;
    if (!task || !agents || !agents.length) return res.status(400).json({ error: 'task and agents required' });

    const agentDescriptions = agents.map(a =>
      `- **${a.displayName}** (\`${a.name}\`): ${a.description || 'No description'}` +
      (a.systemPrompt ? `\n  Capabilities: ${a.systemPrompt.substring(0, 300)}` : '')
    ).join('\n');

    try {
      const client = getCopilotClient();
      const response = await client.chat.completions.create({
        model: 'claude-sonnet-4.6',
        max_tokens: 1500,
        messages: [
          { role: 'system', content: `You are a task planner for a multi-agent system. Given a user task and a list of available agents with their capabilities, create an execution plan that assigns specific sub-tasks to each agent based on their strengths.

Rules:
- Every agent in the list MUST be assigned a sub-task (they were all explicitly selected by the user)
- Sub-tasks should be complementary, not overlapping
- Each agent should focus on what they're best at
- If agents have sequential dependencies (e.g. design first, then documentation), specify the order
- Be specific about what each agent should do

Respond in this exact JSON format:
{
  "plan": [
    { "agent": "agent-name", "task": "specific instructions for this agent", "order": 1 },
    { "agent": "agent-name", "task": "specific instructions for this agent", "order": 2 }
  ],
  "reasoning": "brief explanation of why tasks were divided this way",
  "mode": "sequential"
}

The "order" field determines execution sequence. Agents with the same order number run in parallel.
The "mode" should be "sequential" when later agents depend on earlier agents' output, or "parallel" when they can work independently.` },
          { role: 'user', content: `## Task\n${task}\n\n## Available Agents\n${agentDescriptions}${conversationContext ? '\n\n## Conversation Context\n' + conversationContext : ''}` }
        ]
      });

      const raw = response.choices?.[0]?.message?.content || '{}';
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
      const plan = JSON.parse(jsonMatch[1].trim());
      res.json(plan);
    } catch (_) {
      // Fallback: simple sequential split
      const fallbackPlan = {
        plan: agents.map((a, i) => ({ agent: a.name, task: task, order: i + 1 })),
        reasoning: 'Fallback: running agents sequentially on the full task',
        mode: 'sequential'
      };
      res.json(fallbackPlan);
    }
  });
}
