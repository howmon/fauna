// Storyteller — LLM-driven script + search-term generation for the video pipeline.
//
// Mirrors MoneyPrinterTurbo's `app/services/llm.py` prompts so the storytelling
// quality matches the upstream community. We deliberately keep the prompts close
// to verbatim so users get the same hook → beat → CTA rhythm.

const SCRIPT_PROMPT = `# Role: Short-form Video Scriptwriter

You write punchy, specific, memorable scripts for vertical short-form video (TikTok / Reels / Shorts). Think of the best creators in the space — they earn the next second of attention with concrete detail, surprising specifics, and a real point of view. They do NOT sound like SaaS landing pages.

## Goal
Write a ~{wordsTarget}-word script (~{durationSec}s at a conversational pace) about the subject below.

## Structure
- HOOK (≤8 words): a concrete image, a number, a confession, or an unexpected claim. NOT a rhetorical question. NOT "X is lying to you". NOT "Most people don't realise…".
- BEAT 1: a real moment with a sensory detail (a time of day, a place, a sound, a thing a person did).
- BEAT 2: a sharp turn — escalate, contradict, or zoom in. Reveal something specific.
- BEAT 3: the payoff. A single sentence that lands.
- (Optional) CTA: max one line, only if it feels earned. Otherwise skip it.

## Hard Rules
1. NEVER use these openers or any close variant: "Your X is lying to you", "Most apps just X", "Most people don't realise", "Welcome to", "In this video", "Today we're going to", "Here's the truth about", "Stop doing X".
2. NEVER use marketing words: "game-changer", "revolutionary", "seamlessly", "powerful", "amazing", "next-level", "supercharge", "unlock", "elevate", "transform" (as a verb).
3. NEVER list features in a sentence ("it does X, Y, and Z"). Show one feature through a specific scene instead.
4. NEVER use em-dashes to glue two SaaS clauses together.
5. Concrete > abstract. "Tuesday 2pm, your focus dropped" beats "when productivity dips".
6. Second person, present tense, contractions, conversational. Read it aloud — if it sounds like a press release, rewrite.
7. Each sentence on its own line (helps TTS pacing).
8. Output ONLY the raw spoken script. No markdown, no headings, no stage directions, no quotation marks around the whole thing.
9. Match the language of the subject.

## Good Example (subject: a focus-aware task app)
3:14 pm. You opened Slack instead of the doc that's due.
Your task list didn't notice. It still says "draft the proposal" like nothing happened.
Fauna noticed. It saw the tab switch, the typing slow down, the seventh time you checked your phone.
So it moved the proposal to tomorrow morning and put something easier in front of you.
You finished three things before five. The proposal got done before coffee the next day.

## Bad Example (do NOT write like this)
Your to-do list is lying to you.
Most apps just collect tasks — they never tell you when to actually do them.
Fauna fixes that by turning your list into a live schedule.
(reason: generic opener, SaaS-feature sentence, no concrete moment, no payoff)

## Subject
{subject}

Now write the script. Start with the hook line directly — no preamble, no labels.`;

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
    temperature: 1.0,
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
