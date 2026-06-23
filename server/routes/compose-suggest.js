// /api/compose/suggest — short, low-latency inline autocomplete for the chat
// composer ("ghost text", Copilot-style). Given the in-progress draft plus a
// little conversation context, it returns a SHORT continuation the UI renders
// after the caret and the user can accept with Tab.
//
// Design goals: cheap and unobtrusive. A small fast model, a tiny token budget,
// strict trimming, and a hard rule that it NEVER surfaces errors — a failed
// suggestion is simply no suggestion.

const SUGGEST_MODEL = 'gpt-4.1';   // fast + reliable for short structured text
const MAX_DRAFT_CHARS = 2000;      // only the tail of a long draft matters
const MAX_CTX_MSGS = 4;
const MAX_CTX_CHARS = 600;
const MAX_SUGGESTION_CHARS = 120;

const SUGGEST_SYSTEM = `You are an inline autocomplete engine for a chat input box, like GitHub Copilot ghost text. The user is mid-sentence writing a message to an AI assistant. Continue their CURRENT draft naturally from exactly where it stops.

Rules:
- Output ONLY the continuation text that comes immediately AFTER the draft — never repeat what they already typed.
- Keep it short: at most ~10 words, usually fewer. Finish the current phrase or thought, not a whole paragraph.
- Match the user's wording, tone, capitalization, and intent. If the draft ends mid-word, finish that word first.
- If the draft ends on a word boundary and your continuation starts a new word, begin it with a single leading space.
- If you cannot confidently predict a useful continuation, output an empty string.
- Plain text only: no quotes, no markdown, no explanations, no trailing punctuation the user didn't imply.`;

// Trim and de-noise a raw model completion so it's safe to drop in as ghost
// text. Exported for unit testing.
export function sanitizeSuggestion(raw, draft) {
  let s = String(raw == null ? '' : raw);
  if (!s) return '';
  s = s.replace(/\r/g, '');
  // Ghost text is single-line — keep only the first line.
  const nl = s.indexOf('\n');
  if (nl !== -1) s = s.slice(0, nl);
  // Strip wrapping quotes/backticks the model sometimes adds.
  s = s.replace(/^\s*["'`]+/, '').replace(/["'`]+\s*$/, '');
  // Drop an echoed copy of the draft if the model restated it.
  const d = String(draft || '').trim();
  if (d && s.trim().toLowerCase().startsWith(d.toLowerCase())) {
    s = s.trim().slice(d.length);
  }
  if (s.length > MAX_SUGGESTION_CHARS) s = s.slice(0, MAX_SUGGESTION_CHARS);
  // Reject continuations that are only whitespace/punctuation — not useful.
  if (!s.replace(/[\s.,;:!?)\]}'"-]/g, '')) return '';
  return s;
}

function buildContextBlock(context) {
  const msgs = Array.isArray(context) ? context.slice(-MAX_CTX_MSGS) : [];
  const lines = msgs.map((m) => {
    if (!m) return '';
    const role = m.role === 'assistant' ? 'Assistant' : 'User';
    let c = typeof m.content === 'string' ? m.content : '';
    c = c.trim();
    if (!c) return '';
    if (c.length > MAX_CTX_CHARS) c = c.slice(0, MAX_CTX_CHARS) + '…';
    return role + ': ' + c;
  }).filter(Boolean);
  return lines.join('\n');
}

export function registerComposeSuggestRoutes(app, { getCopilotClient }) {
  app.post('/api/compose/suggest', async (req, res) => {
    try {
      let text = String((req.body && req.body.text) || '');
      // Trivial drafts get nothing — keeps it unobtrusive and cheap.
      if (text.trim().length < 3) return res.json({ suggestion: '' });
      if (text.length > MAX_DRAFT_CHARS) text = text.slice(-MAX_DRAFT_CHARS);

      const ctxText = buildContextBlock(req.body && req.body.context);
      const userContent =
        (ctxText
          ? 'Recent conversation (for context only — do NOT continue it, only the draft below):\n' + ctxText + '\n\n'
          : '') +
        'Draft so far (continue from the very end):\n<<<\n' + text + '\n>>>\n\nContinuation:';

      const client = getCopilotClient();
      const r = await client.chat.completions.create({
        model: SUGGEST_MODEL,
        temperature: 0.2,
        max_tokens: 24,
        messages: [
          { role: 'system', content: SUGGEST_SYSTEM },
          { role: 'user', content: userContent },
        ],
      });
      const raw = (r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
      res.json({ suggestion: sanitizeSuggestion(raw, text) });
    } catch (e) {
      // Autocomplete must never break the composer — fail silent.
      res.json({ suggestion: '' });
    }
  });
}
