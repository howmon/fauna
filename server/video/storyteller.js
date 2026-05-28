// Storyteller — LLM-driven script + search-term generation for the video pipeline.
//
// Mirrors MoneyPrinterTurbo's `app/services/llm.py` prompts so the storytelling
// quality matches the upstream community. We deliberately keep the prompts close
// to verbatim so users get the same hook → beat → CTA rhythm.

const SCRIPT_PROMPT = `# Role: Video Script Generator

## Goals:
Generate a short script for a video based on the given subject, suitable for a vertical short-form clip (TikTok / Reels / Shorts).

## Constrains:
1. the script must be roughly {wordsTarget} words long (~{durationSec}s of narration at conversational pace).
2. structure it as: HOOK (≤8 words, pattern-interrupt) → BEAT 1 (concrete moment) → BEAT 2 (escalate / surprise) → BEAT 3 (payoff) → optional CTA (single line).
3. get straight to the point — never start with "welcome to this video", "in this video", "today we're going to", or any framing.
4. you must not include any markdown, formatting, headings, asterisks, bullets, or stage directions.
5. only return the raw spoken script — nothing else.
6. each sentence on its own line so the TTS engine can pace cleanly.
7. tone is conversational, second-person, no filler.
8. respond in the same language as the video subject.

## Output Example:
You'll never look at sunsets the same way again.
Light from the sun takes eight minutes to reach your eyes.
By the time you see it set, it's already gone.
What you're watching is a memory.

## Subject:
{subject}

Now write the script.`;

const TERMS_PROMPT = `# Role: Video Search Terms Generator

## Goals:
Generate exactly 5 short search terms suitable for finding background stock footage that matches the script.

## Constrains:
1. the search terms are in English only, even if the script is in another language — stock libraries are indexed in English.
2. each term must be 1–3 words, concrete and visual (e.g. "city skyline at night", "coffee being poured", "runner on beach").
3. avoid abstract nouns ("happiness", "success") — prefer things a camera can see.
4. terms should collectively cover the script's narrative arc.
5. return ONLY a JSON array of 5 strings, nothing else. No code fences, no prose.

## Output Example:
["sunset over ocean", "city skyline at night", "coffee being poured", "runner on beach", "stars in the night sky"]

## Video Subject:
{subject}

## Video Script:
{script}

Now return the JSON array.`;

function _interp(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

function _stripMarkdown(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, '')        // fenced code
    .replace(/^\s*#+\s.*$/gm, '')           // headings
    .replace(/[*_`>]/g, '')                  // emphasis chars
    .replace(/^\s*[-•]\s+/gm, '')           // bullets
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')   // markdown links
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function _wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Generate a spoken-narration script.
 * @param {object} args
 * @param {string} args.subject
 * @param {number} [args.durationSec=30]   target spoken duration
 * @param {string} [args.language='en']
 * @param {object} args.client              OpenAI-shaped client (e.g. getCopilotClient())
 * @param {string} [args.model='claude-sonnet-4.6']
 */
export async function generateScript({ subject, durationSec = 30, language = 'en', client, model = 'claude-sonnet-4.6' }) {
  if (!subject || !subject.trim()) throw new Error('subject is required');
  if (!client) throw new Error('client is required');
  // ~2.4 words/sec is conversational US English. Slow voices ~2.0, fast ~2.8.
  const wordsTarget = Math.max(20, Math.round(durationSec * 2.4));
  const prompt = _interp(SCRIPT_PROMPT, { subject, durationSec, wordsTarget });
  const r = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 1024,
  });
  const raw = r?.choices?.[0]?.message?.content || '';
  const script = _stripMarkdown(raw);
  if (!script) throw new Error('LLM returned empty script');
  return { script, wordCount: _wordCount(script), language };
}

/**
 * Generate stock-footage search terms from the script.
 * Always returns an array of exactly 5 short English terms.
 */
export async function generateTerms({ subject, script, client, model = 'claude-sonnet-4.6' }) {
  if (!script) throw new Error('script is required');
  if (!client) throw new Error('client is required');
  const prompt = _interp(TERMS_PROMPT, { subject: subject || '', script });
  const r = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 256,
  });
  const raw = r?.choices?.[0]?.message?.content || '';
  // Try clean JSON, then fall back to a bracket-extraction regex.
  let terms = null;
  try { terms = JSON.parse(raw); } catch (_) {}
  if (!Array.isArray(terms)) {
    const m = raw.match(/\[[\s\S]*?\]/);
    if (m) { try { terms = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!Array.isArray(terms) || terms.some(t => typeof t !== 'string')) {
    // Last-ditch: split the script into noun-phrase-y chunks.
    const fallback = script
      .split(/[.!?\n]+/)
      .map(s => s.trim().split(/\s+/).slice(0, 3).join(' '))
      .filter(Boolean)
      .slice(0, 5);
    terms = fallback.length === 5 ? fallback : ['nature', 'people', 'city', 'sunset', 'closeup'];
  }
  terms = terms.map(t => String(t).trim()).filter(Boolean).slice(0, 5);
  while (terms.length < 5) terms.push(['nature', 'people', 'city', 'sunset', 'closeup'][terms.length]);
  return terms;
}

// Exported for tests so we can verify prompt assembly without hitting an LLM.
export const _internals = { SCRIPT_PROMPT, TERMS_PROMPT, _interp, _stripMarkdown };
