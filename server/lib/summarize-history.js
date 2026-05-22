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
  'You are a factual task-state summarizer for an in-progress coding/agent session. ' +
  'Your summary will be re-injected into the next AI turn, so accuracy and neutrality matter more than brevity.\n\n' +
  'Produce a compact summary (max 400 words) with these labeled sections:\n' +
  '1. ORIGINAL TASK: the user\'s stated goal, verbatim if short.\n' +
  '2. ACTIONS TAKEN: concrete steps performed — files created/edited (with paths), commands run (with key flags), tools invoked. Past tense, specific.\n' +
  '3. OBSERVED RESULTS: exit codes, error messages, file contents found, test output. Quote exact strings where useful. Do NOT paraphrase success/failure — report only what was literally observed.\n' +
  '4. OPEN / UNVERIFIED: anything that was attempted but NOT yet confirmed working, tests not yet run, files not yet read end-to-end, claims the assistant made that lack evidence.\n' +
  '5. NEXT STEPS: only steps that were explicitly planned or are clearly required to finish the original task. If unsure, write "unclear — needs user confirmation".\n\n' +
  'CRITICAL RULES:\n' +
  '- NEVER write "the goal has been achieved", "task complete", "successfully finished", or any phrasing that asserts completion unless the conversation contains explicit verification (passing tests, exit 0 with expected output, user confirmation).\n' +
  '- NEVER infer success from the absence of errors. If a step ran but was not verified, list it under OPEN / UNVERIFIED.\n' +
  '- NEVER add steps, conclusions, or recommendations not present in the conversation.\n' +
  '- Prefer "ran X, exit Y, stdout contained Z" over "X worked".\n' +
  '- Omit greetings, filler, and decorative markdown. Plain text labeled sections only.';

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
  // NOTE: signal goes in the SDK's request-options arg (second param), NOT in
  // the body params object — putting it in `params` makes the OpenAI SDK try to
  // JSON-serialize an AbortSignal which throws and aborts the whole request.

  try {
    const reqOpts = signal ? { signal } : undefined;
    let resp;
    try {
      resp = await client.chat.completions.create(params, reqOpts);
    } catch (modelErr) {
      // Retry once with a known-good fallback if the requested model is rejected.
      const fallback = 'gpt-4o-mini';
      if (model !== fallback) {
        console.warn('[summarize-history] model "' + model + '" failed (' + (modelErr?.message || modelErr) + ') — retrying with ' + fallback);
        const retry = { ...params, model: fallback, max_tokens: maxTokens };
        delete retry.max_completion_tokens;
        resp = await client.chat.completions.create(retry, reqOpts);
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
