// Storyteller — LLM-driven script + search-term generation for the video pipeline.
//
// Mirrors MoneyPrinterTurbo's `app/services/llm.py` prompts so the storytelling
// quality matches the upstream community. We deliberately keep the prompts close
// to verbatim so users get the same hook → beat → CTA rhythm.

import { withTimeout } from '../lib/async-utils.js';

// Hard cap on a single script/terms LLM call so a stalled completion fails
// fast instead of hanging the pipeline (and the Video Studio widget) for
// minutes. These are small generations that finish well inside this window
// when the upstream API is healthy.
const SCRIPT_TIMEOUT_MS = 90_000;

// Some Copilot-served models (observed with Claude Sonnet on certain prompts)
// return an empty `choices: []` while still consuming the entire output-token
// budget — the model "thinks" itself out of any visible content. Retrying the
// SAME model just burns time, so on an empty completion we fall through to a
// known-reliable fallback. gpt-4.1 produces this kind of short script in ~100
// tokens, so it's both cheaper and far more dependable here.
const SCRIPT_FALLBACK_MODEL = 'gpt-4.1';

// Build the ordered list of models to try: the requested model first, then the
// fallback (de-duped so we never call the same model twice).
function _modelChain(primary) {
  const chain = [];
  if (primary) chain.push(primary);
  if (SCRIPT_FALLBACK_MODEL && SCRIPT_FALLBACK_MODEL !== primary) chain.push(SCRIPT_FALLBACK_MODEL);
  return chain.length ? chain : [SCRIPT_FALLBACK_MODEL];
}

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
  let out = String(s || '');
  // Models often disobey "no markdown" and wrap the whole script in a single
  // ```fence```. Unwrap it (keep the inner script) rather than deleting the
  // block — deleting it leaves an empty string and the pipeline then reports
  // "LLM returned empty script" even though the model produced a fine script.
  const wholeFence = out.match(/^\s*```[\w-]*\s*\n([\s\S]*?)\n?\s*```\s*$/);
  if (wholeFence) out = wholeFence[1];
  return out
    .replace(/```[\w-]*\n?/g, '')           // stray fence markers (keep content)
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
  // Try the requested model, then a reliable fallback. An empty completion or
  // a transient API hiccup shouldn't surface as a hard 500: the most common
  // real-world failure is the primary model returning empty `choices`, so the
  // fallback model is what actually rescues the job. Each attempt is bounded by
  // the same timeout so the worst case stays predictable.
  const models = _modelChain(model);
  let lastErr;
  for (const m of models) {
    try {
      const r = await withTimeout(client.chat.completions.create({
        model: m,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.0,
        max_tokens: 1024,
      }), SCRIPT_TIMEOUT_MS, 'video script generation');
      const raw = r?.choices?.[0]?.message?.content || '';
      const script = _stripMarkdown(raw);
      if (!script) {
        // An empty body with choices:[] (some models burn the whole token
        // budget producing nothing) vs. content that stripped to empty — log
        // both so recurring failures are diagnosable without re-running.
        const noChoices = !(r?.choices?.length);
        console.warn('[storyteller] empty script from model=' + m + (noChoices ? ' (no choices returned)' : ' after strip; raw length=' + raw.length) + '; trying next model if any');
        throw new Error('LLM returned empty script (model=' + m + ')');
      }
      return { script, wordCount: _wordCount(script), language, model: m };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('Script generation failed (tried ' + models.join(', ') + '): ' + (lastErr?.message || lastErr));
}

/**
 * Generate stock-footage search terms from the script.
 * Always returns an array of exactly 5 short English terms.
 */
export async function generateTerms({ subject, script, client, model = 'claude-sonnet-4.6' }) {
  if (!script) throw new Error('script is required');
  if (!client) throw new Error('client is required');
  const prompt = _interp(TERMS_PROMPT, { subject: subject || '', script });
  // Same fallback strategy as generateScript: if the primary model returns an
  // empty body, try the reliable fallback before giving up. Terms have a hard
  // fallback below (chunk the script), but a real model response is far better.
  let raw = '';
  for (const m of _modelChain(model)) {
    try {
      const r = await withTimeout(client.chat.completions.create({
        model: m,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 256,
      }), SCRIPT_TIMEOUT_MS, 'video terms generation');
      raw = r?.choices?.[0]?.message?.content || '';
      if (raw.trim()) break;
    } catch (_) { /* try next model */ }
  }
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
