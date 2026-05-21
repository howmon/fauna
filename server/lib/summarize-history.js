// server/lib/summarize-history.js
//
// In-process conversation summarizer.  Extracted from /api/summarize so the
// chat route can call it directly during auto-compaction (no HTTP loopback).
//
// Returns a string summary (possibly empty on failure).  Never throws.

/** Normalize one conversation message into {role, content}. */
export function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  let role = m.role;
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
  // Cap each msg before feeding to the summarizer so a single huge shell dump
  // doesn't blow the summarizer's own context.
  return { role, content: text.slice(0, 3000) };
}

const SYSTEM_PROMPT =
  'You are a concise task-state summarizer. ' +
  'Given a conversation, produce a compact summary (max 400 words) covering:\n' +
  '1. The original task/goal\n' +
  '2. What has already been completed (files created, commands run, results)\n' +
  '3. Current state and any pending steps\n' +
  '4. Key facts discovered (paths, errors, findings)\n' +
  'Write in past tense. Be specific — include file paths, command names, and exact results. ' +
  'Omit greetings, filler, and markdown formatting.';

/**
 * Summarize a slice of conversation history.
 *
 * @param {Array} messages   Raw OpenAI-style messages
 * @param {object} opts
 * @param {object} opts.client          Copilot client (chat.completions.create)
 * @param {string} [opts.model]         Model id — defaults to 'gpt-4o-mini' (cheap, fast)
 * @param {number} [opts.maxTokens=600] Summary length cap
 * @param {AbortSignal} [opts.signal]   Optional abort signal
 * @returns {Promise<string>}           Summary text, or '' on failure
 */
export async function summarizeHistory(messages, { client, model = 'gpt-4o-mini', maxTokens = 600, signal } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (!client || !client.chat || !client.chat.completions) return '';

  const normalized = messages.map(normalizeMessage).filter(Boolean);
  if (!normalized.length) return '';

  const prompt = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...normalized,
    { role: 'user', content: 'Summarize the conversation above as a compact task-state note.' },
  ];

  const params = { model, messages: prompt, stream: false };
  if (/^(o[1-9]|gpt-5)/.test(model)) params.max_completion_tokens = maxTokens;
  else params.max_tokens = maxTokens;
  if (signal) params.signal = signal;

  try {
    let resp;
    try {
      resp = await client.chat.completions.create(params, signal ? { signal } : undefined);
    } catch (modelErr) {
      // Retry once with a known-good fallback if the requested model is rejected.
      const fallback = 'gpt-4o-mini';
      if (model !== fallback) {
        console.warn('[summarize-history] model "' + model + '" failed (' + (modelErr?.message || modelErr) + ') — retrying with ' + fallback);
        const retry = { ...params, model: fallback, max_tokens: maxTokens };
        delete retry.max_completion_tokens;
        resp = await client.chat.completions.create(retry, signal ? { signal } : undefined);
      } else {
        throw modelErr;
      }
    }
    return (resp?.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('[summarize-history] failed:', e && (e.stack || e.message || e));
    return '';
  }
}
