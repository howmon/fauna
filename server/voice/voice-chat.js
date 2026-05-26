// ── Voice chat dispatch (Phase 4b) ───────────────────────────────────────
//
// Bridges an addressed utterance into Fauna's actual chat backend (the
// existing /api/chat SSE endpoint) and streams the assistant's response
// into the TTS engine sentence-by-sentence so playback starts as soon as
// the first sentence is ready — not after the whole reply has arrived.
//
// Why call /api/chat over HTTP loopback instead of importing the route
// directly? Same reason task-runner.js does it: one canonical chat path,
// no duplicated prompt assembly / tool-call plumbing.
//
// Public API:
//   const vc = getVoiceChat({ port, tts });
//   vc.ask(text)           → Promise<{done|aborted|error}>
//   vc.cancel()            → abort in-flight upstream + drain TTS queue
//   vc.reset()             → clear conversation history
//   vc.isBusy()
//
// Conversation history is held in-memory and capped, so follow-up
// utterances naturally retain context within a session without leaking
// into Fauna's persisted conversations.

import { EventEmitter } from 'events';

const SYSTEM_PROMPT =
  'You are Fauna replying through a voice assistant. Keep answers concise ' +
  '(1–3 short sentences unless the user explicitly asks for detail). Use ' +
  'plain spoken language — no markdown, no code fences, no bullet lists, ' +
  'no URLs read aloud. If you need to spell something out, spell it ' +
  'naturally. If the user\'s request is ambiguous, ask one short clarifying ' +
  'question.';

const MAX_HISTORY_TURNS = 12;     // user + assistant pairs combined ≈ 24 messages
const SENTENCE_RE = /([^.!?\n]+[.!?\n]+|[^.!?\n]+$)/g;
// We only flush a "complete" sentence to TTS if it ended with terminal
// punctuation or a newline, OR the buffer is getting long enough that
// waiting longer would feel sluggish.
const MAX_BUFFERED_CHARS_BEFORE_FORCE_FLUSH = 200;

class VoiceChat extends EventEmitter {
  constructor({ port, tts, model, agentName }) {
    super();
    this.port      = port;
    this.tts       = tts;
    this.model     = model || 'claude-sonnet-4.6';
    this.agentName = agentName || null;
    this.history   = [];            // [{role:'user'|'assistant', content}]
    this.inflight  = null;          // AbortController for the current /api/chat fetch
    this.busy      = false;
  }

  isBusy() { return !!this.busy; }

  reset() {
    this.history.length = 0;
    this.cancel();
  }

  cancel() {
    if (this.inflight) {
      try { this.inflight.abort(); } catch (_) {}
      this.inflight = null;
    }
    try { this.tts?.stop(); } catch (_) {}
    this.busy = false;
  }

  async ask(text) {
    const userText = String(text || '').trim();
    if (!userText) return { error: 'empty input' };
    if (this.busy) this.cancel();           // last reply still streaming — drop it

    this.history.push({ role: 'user', content: userText });
    this._trimHistory();

    const controller = new AbortController();
    this.inflight = controller;
    this.busy     = true;
    this.emit('start', { text: userText });

    let assistantFull = '';
    let buffer        = '';
    let firstChunkAt  = 0;

    const flush = (force) => {
      if (!buffer) return;
      // Split into complete sentences; keep any trailing fragment in the buffer.
      const parts = buffer.match(SENTENCE_RE) || [];
      let rest = '';
      const sentences = [];
      for (const p of parts) {
        const trimmed = p.trim();
        if (!trimmed) continue;
        if (/[.!?\n]$/.test(p) || force) sentences.push(trimmed);
        else rest = (rest + ' ' + trimmed).trim();
      }
      buffer = rest;
      if (force && buffer) { sentences.push(buffer.trim()); buffer = ''; }
      for (const s of sentences) {
        const spoken = _stripForSpeech(s);
        if (spoken) this.tts.speak(spoken).catch(() => {});
      }
    };

    try {
      const resp = await fetch(`http://127.0.0.1:${this.port}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          messages:       this.history.slice(),
          model:          this.model,
          systemPrompt:   SYSTEM_PROMPT,
          agentName:      this.agentName,
          thinkingBudget: 'low',
          maxContextTurns: MAX_HISTORY_TURNS,
          // Voice has no UI to satisfy client-side tool calls; disable tools
          // so the chat route doesn't try to round-trip to a renderer that
          // isn't listening. (Server-only tools could be re-enabled later
          // behind a per-call allow-list if useful.)
          noTools:        true,
          clientContext:  'voice',
        }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const errText = resp.ok ? 'no response body' : ('chat API ' + resp.status);
        this.tts.speak('Sorry, I had trouble reaching the assistant.').catch(() => {});
        this._finish('error', { error: errText });
        return { error: errText };
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let sseBuf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });

        // SSE messages are separated by blank lines.
        let idx;
        while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
          const raw = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          const dataLines = raw.split('\n').filter(l => l.startsWith('data: '));
          if (!dataLines.length) continue;
          const payload = dataLines.map(l => l.slice(6)).join('\n');
          let evt;
          try { evt = JSON.parse(payload); } catch (_) { continue; }
          if (evt.type === 'content' && evt.content) {
            if (!firstChunkAt) {
              firstChunkAt = Date.now();
              this.emit('first-token', { ms: firstChunkAt });
            }
            assistantFull += evt.content;
            buffer        += evt.content;
            // Flush completed sentences; force-flush if the buffer is too long
            // (model has been talking in one giant run-on without punctuation).
            flush(buffer.length > MAX_BUFFERED_CHARS_BEFORE_FORCE_FLUSH);
          } else if (evt.type === 'error') {
            this.emit('upstream-error', { error: evt.error });
          }
          // tool_output / client_tool_pending / usage events: ignored for voice.
        }
      }

      // Drain any trailing fragment.
      flush(true);

      const reply = (assistantFull || '').trim();
      if (reply) this.history.push({ role: 'assistant', content: reply });
      this._trimHistory();
      this._finish('done', { reply });
      return { done: true, reply };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        this._finish('aborted', {});
        return { aborted: true };
      }
      this.tts.speak('Sorry, something went wrong.').catch(() => {});
      this._finish('error', { error: err.message });
      return { error: err.message };
    }
  }

  _finish(kind, payload) {
    this.busy     = false;
    this.inflight = null;
    this.emit(kind, payload);
  }

  _trimHistory() {
    if (this.history.length <= MAX_HISTORY_TURNS * 2) return;
    // Keep the most recent N turns.
    this.history.splice(0, this.history.length - MAX_HISTORY_TURNS * 2);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Strip markdown / code / URLs so TTS doesn't read characters literally. */
function _stripForSpeech(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')              // code fences
    .replace(/`([^`]+)`/g, '$1')                  // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')        // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')      // links → link text
    .replace(/https?:\/\/\S+/g, 'a link')         // bare URLs
    .replace(/[*_#>]+/g, '')                      // markdown emphasis / headings
    .replace(/^\s*[-\u2022]\s*/gm, '')            // bullet markers
    .replace(/\s+/g, ' ')
    .trim();
}

let _instance = null;
export function getVoiceChat(opts = {}) {
  if (!_instance) _instance = new VoiceChat(opts);
  return _instance;
}
