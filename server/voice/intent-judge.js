// ── Intent judge (Phase 3) ───────────────────────────────────────────────
//
// Classifies an incoming utterance into one of:
//
//   'interrupt' — user is interrupting Fauna mid-speech ("stop", "wait",
//                 "cancel", "shut up", "be quiet", "nevermind", "okay stop")
//   'addressed' — user is directly addressing Fauna (wake word matched)
//   'follow-up' — user spoke shortly after a prior addressed turn and the
//                 utterance reads like a continuation, so no wake word is
//                 required to keep the conversation going
//   'ignore'    — ambient speech, not for Fauna
//
// Why rule-based first? It's deterministic, debuggable, zero-cost, and good
// enough for the high-signal commands ("stop", "cancel"). A small-model
// judge (gemma-2b/llama3.2-1b) can be slotted in behind the same
// `classify()` signature later — just pass a different judge into
// utterance-pipeline.
//
// The judge is pure: caller injects context (TTS state, time since last
// addressed turn) so it can be unit-tested without mocking globals.

const INTERRUPT_PATTERNS = [
  /\bstop\b/i,
  /\bwait\b/i,
  /\bhold on\b/i,
  /\bcancel\b/i,
  /\bnever ?mind\b/i,
  /\bshut up\b/i,
  /\bbe quiet\b/i,
  /\bquiet\b/i,
  /\benough\b/i,
];

const FOLLOW_UP_WINDOW_MS = 12_000;

// Utterances shorter than this in characters are unlikely to be real
// follow-up commands (avoid acting on "yeah" / "uh-huh" / "ok").
const MIN_FOLLOW_UP_LEN = 3;

const ACK_PATTERNS = [
  /^(uh ?huh|mm ?hmm|yeah|yep|yes|right|ok(ay)?|sure|cool|got it|gotcha|thanks?|thank you)[\s!.,]*$/i,
];

function looksLikeInterrupt(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Short, command-like utterance dominated by an interrupt keyword.
  if (t.length > 60) return false;          // long sentence: probably not just "stop"
  return INTERRUPT_PATTERNS.some(re => re.test(t));
}

function looksLikeAck(text) {
  return ACK_PATTERNS.some(re => re.test(String(text || '').trim()));
}

/**
 * @param {object} input
 * @param {string} input.text                 raw transcript
 * @param {boolean} input.wakeMatched         did the wake-word matcher fire?
 * @param {string}  [input.command]           cleaned command from wake-word matcher
 * @param {boolean} [input.ttsSpeaking]       is Fauna currently speaking?
 * @param {number}  [input.lastAddressedTs]   ms timestamp of last addressed turn
 * @param {number}  [input.now]               ms (defaults to Date.now())
 * @returns {{intent:'interrupt'|'addressed'|'follow-up'|'ignore', command:string}}
 */
export function classify(input) {
  const {
    text = '',
    wakeMatched = false,
    command = '',
    ttsSpeaking = false,
    lastAddressedTs = 0,
    now = Date.now(),
  } = input || {};

  const trimmed = String(text).trim();

  // 1. Interrupts beat everything when Fauna is speaking.
  if (ttsSpeaking && looksLikeInterrupt(trimmed)) {
    return { intent: 'interrupt', command: '' };
  }

  // 2. Direct address via wake word.
  if (wakeMatched) {
    return { intent: 'addressed', command: command || trimmed };
  }

  // 3. Follow-up: recent addressed turn + non-trivial utterance + not just
  //    an acknowledgement noise.
  const sinceLast = now - (lastAddressedTs || 0);
  if (lastAddressedTs && sinceLast <= FOLLOW_UP_WINDOW_MS) {
    if (trimmed.length >= MIN_FOLLOW_UP_LEN && !looksLikeAck(trimmed)) {
      return { intent: 'follow-up', command: trimmed };
    }
  }

  // 4. Even outside the follow-up window: a bare interrupt while speaking
  //    is still an interrupt (defensive — covered by rule 1 already).

  return { intent: 'ignore', command: '' };
}

/** Default judge object so the pipeline can take a pluggable dependency. */
export const ruleBasedJudge = { classify };

export { FOLLOW_UP_WINDOW_MS };
