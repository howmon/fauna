// ── Wake-word matcher (Phase 2a, text-based) ─────────────────────────────
//
// Strategy: every captured utterance is transcribed by Whisper, then we
// scan the transcript for the wake word (default: "fauna"). If found, we
// strip the wake word and surrounding filler ("hey fauna,", "ok fauna —")
// and treat the remainder as the user's actual command. If the wake word
// is at the end with no trailing command, we keep the previous segment as
// the command (handles patterns like "what do you think, Fauna?").
//
// Why text-based, not Porcupine?
//   - Zero extra native deps.
//   - Whisper-base on Apple Silicon is ~150–250 ms for a 2 s clip; cheap
//     enough that running it on every VAD-bounded utterance is fine.
//   - Same interface (`matchWake(text)`) can later be replaced by an audio
//     wake-word detector without changing the pipeline.
//
// Config (~/.config/fauna/voice.json):
//   { "wakeWords": ["fauna", "hey fauna", "ok fauna"], "wakeRequired": true }

const DEFAULT_WAKE_WORDS = ['fauna', 'hey fauna', 'ok fauna', 'okay fauna'];

// Common whisper mishearings of "Fauna" — extend pragmatically as you
// notice misses in the logs.
const PHONETIC_VARIANTS = [
  'fauna', 'fawna', 'farna', 'forna', 'fana', 'fonna', 'fauno',
];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    // Strip leading/trailing punctuation per word
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPattern(words) {
  const all = new Set();
  for (const w of words) all.add(normalize(w));
  for (const v of PHONETIC_VARIANTS) all.add(v);
  // Multi-word entries are matched as a phrase; single words as a token.
  const escaped = [...all]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length) // longest first ("hey fauna" before "fauna")
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
}

/**
 * Try to find a wake word in `text`. Returns:
 *   { matched: true, command: "..." }   wake word found, command extracted
 *   { matched: false }                  no wake word
 */
export function matchWake(text, opts = {}) {
  const words = Array.isArray(opts.wakeWords) && opts.wakeWords.length
    ? opts.wakeWords
    : DEFAULT_WAKE_WORDS;
  const norm = normalize(text);
  if (!norm) return { matched: false };

  const pat = buildPattern(words);
  const matches = [...norm.matchAll(pat)];
  if (!matches.length) return { matched: false };

  // Take the LAST occurrence — handles "what do you think, Fauna?" cleanly.
  const m = matches[matches.length - 1];
  const before = norm.slice(0, m.index).trim();
  const after  = norm.slice(m.index + m[0].length).trim();

  // Strip leading vocative punctuation/filler from `after`.
  const cleanedAfter = after.replace(/^[\s,.\-:;]*/, '').trim();

  let command;
  if (cleanedAfter.length >= 2) {
    // Wake word came first: "Fauna, what's the weather"
    command = cleanedAfter;
  } else if (before.length >= 2) {
    // Wake word came at the end: "what's the weather, Fauna"
    command = before.replace(/[,.\-:;\s]+$/, '');
  } else {
    // Bare wake word with no payload — treat as "addressed, listening".
    command = '';
  }
  return { matched: true, command };
}

export { DEFAULT_WAKE_WORDS };
