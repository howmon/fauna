# @fauna-services/voice

Voice synthesis and recognition service. Provides text-to-speech via Kokoro (local neural TTS) and speech-to-text via Whisper or Parakeet — all running locally with no cloud dependency, embeddable in any desktop or server application.

---

## What It Does

- **Text-to-speech (TTS)** — Kokoro neural TTS engine running in a Worker thread; streams audio chunks over SSE
- **Speech-to-text (STT)** — Whisper.cpp or Parakeet model transcription from audio files or mic streams
- **Dictation pipeline** — real-time dictation: mic → STT → text output stream
- **Voice picker** — exposes available Kokoro voices and OS system voices
- **Model management** — download, list, and delete Whisper/Parakeet model files
- **Audio processing** — noise reduction, silence trimming, format conversion

---

## API

### Synthesise speech (TTS)

```
POST /api/voice/tts
Content-Type: application/json

{
  "text": "Hello, I've finished reviewing your code. Here are my findings.",
  "voice": "af_bella",
  "speed": 1.0,
  "format": "wav"   // 'wav' | 'mp3' | 'ogg'
}
→ SSE stream:
  { type: 'audio_chunk', data: '<base64-encoded PCM chunk>' }
  { type: 'done', durationMs: 2100 }
```

Non-streaming (returns full audio file):

```
POST /api/voice/tts
{ "text": "...", "stream": false }
→ audio/wav binary
```

### List available voices

```
GET /api/voice/tts/voices
→ {
    "kokoro": [
      { "id": "af_bella", "name": "Bella", "language": "en-US", "gender": "female" },
      { "id": "am_adam", "name": "Adam", "language": "en-US", "gender": "male" },
      ...
    ],
    "system": [
      { "id": "com.apple.voice.enhanced.en-US.Samantha", "name": "Samantha (Enhanced)", "language": "en-US" }
    ]
  }
```

### Transcribe audio file (STT)

```
POST /api/voice/stt/transcribe
Content-Type: multipart/form-data

file: <recording.wav>
engine: whisper          // 'whisper' | 'parakeet'
model: base              // 'tiny' | 'base' | 'small' | 'medium' | 'large'
language: en
→ {
    "text": "Review the authentication module for security issues",
    "segments": [{ "start": 0.0, "end": 2.3, "text": "Review the..." }],
    "duration": 4.2,
    "language": "en"
  }
```

### Start real-time dictation (SSE)

```
POST /api/voice/stt/dictate/start
{ "engine": "whisper", "model": "base", "language": "en" }
→ { "sessionId": "dict-uuid" }
```

### Stream audio chunk to active dictation session

```
POST /api/voice/stt/dictate/:sessionId/chunk
Content-Type: audio/raw
Body: raw PCM audio bytes (16kHz, 16-bit, mono)
→ { "partial": "review the auth..." }
```

### Get dictation results (SSE)

```
GET /api/voice/stt/dictate/:sessionId/stream
→ SSE stream:
  { type: 'partial', text: 'review the auth...' }
  { type: 'final', text: 'Review the authentication module.', confidence: 0.96 }
  { type: 'silence', duration: 1.2 }
```

### Stop dictation

```
POST /api/voice/stt/dictate/:sessionId/stop
→ { "transcript": "Review the authentication module for security issues." }
```

---

## Model Management API

### List Whisper models

```
GET /api/voice/stt/models/whisper
→ [{ "name": "base", "size": "142MB", "downloaded": true, "path": "..." }]
```

### Download a Whisper model

```
POST /api/voice/stt/models/whisper/download
{ "model": "small" }
→ SSE stream: { type: 'progress', percent: 45, bytesDownloaded: 64000000 }
```

### Delete a Whisper model

```
DELETE /api/voice/stt/models/whisper/:model
```

### List Parakeet models

```
GET /api/voice/stt/models/parakeet
→ [{ "name": "parakeet-tdt-0.6b-v2", "downloaded": true }]
```

### Download / delete Parakeet model

```
POST /api/voice/stt/models/parakeet/download
DELETE /api/voice/stt/models/parakeet/:model
```

---

## Configuration

```js
import { createVoiceService } from '@fauna-services/voice'

const svc = await createVoiceService({
  port: 4033,
  dataDir: '~/.myapp/voice',
  tts: {
    engine: 'kokoro',
    defaultVoice: 'af_bella',
    defaultSpeed: 1.0,
    workerThreads: 1
  },
  stt: {
    defaultEngine: 'whisper',
    defaultModel: 'base',
    whisperBinaryPath: null,    // auto-detect
    parakeetEnabled: true
  },
  audio: {
    sampleRate: 16000,
    channels: 1,
    noiseReduction: true
  }
})
```

---

## Integration Examples

### Read AI responses aloud in any app

```ts
import { VoiceClient } from '@fauna-services/voice/client'
const voice = new VoiceClient('http://localhost:4033')

// After getting an AI response:
const audioStream = voice.tts({ text: aiResponse, voice: 'af_bella' })
for await (const chunk of audioStream) {
  audioPlayer.pushChunk(chunk)
}
```

### Dictation input for any text field

```ts
const session = await voice.startDictation({ engine: 'whisper', model: 'base' })

// Stream microphone audio to the session
mic.on('data', chunk => voice.sendAudioChunk(session.id, chunk))

// Receive transcript
voice.onFinal(session.id, (text) => {
  textField.value = text
})

// Stop on silence or button press
await voice.stopDictation(session.id)
```

### CLI: transcribe a meeting recording

```bash
fauna-voice transcribe meeting.mp4 --engine whisper --model medium --output meeting-transcript.txt
```

---

## Available Kokoro Voices

| ID | Name | Language | Gender |
|---|---|---|---|
| `af_bella` | Bella | en-US | female |
| `af_sarah` | Sarah | en-US | female |
| `am_adam` | Adam | en-US | male |
| `am_michael` | Michael | en-US | male |
| `bf_emma` | Emma | en-GB | female |
| `bm_george` | George | en-GB | male |

---

## Storage

- `voice.db` — SQLite; transcription history and session state
- `models/whisper/` — downloaded Whisper model files
- `models/parakeet/` — downloaded Parakeet model files
- `recordings/` — optional: save dictation audio for replay

---

## Dependencies

- `kokoro-js` — Kokoro TTS WebAssembly engine
- `whisper.cpp` bindings or `@xenova/transformers` — Whisper STT
- `node-mic` / `node-record-lpcm16` — microphone access (optional)
- `ffmpeg-static` — audio format conversion
