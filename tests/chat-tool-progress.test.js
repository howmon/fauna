import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatToolPhaseProgress, formatToolProgress } from '../server/routes/chat.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatSource = fs.readFileSync(path.join(root, 'public/js/chat.js'), 'utf8');
const routeSource = fs.readFileSync(path.join(root, 'server/routes/chat.js'), 'utf8');
const kokoroRouteSource = fs.readFileSync(path.join(root, 'server/routes/kokoro-tts.js'), 'utf8');
const selfToolsSource = fs.readFileSync(path.join(root, 'self-tools.js'), 'utf8');

describe('long-running tool progress', () => {
  it('describes audio synthesis with input size and elapsed time', () => {
    expect(formatToolProgress('fauna_speak', { text: 'hello world' }, 7, 'running'))
      .toBe('Synthesizing 11 characters of audio · 7s');
    expect(formatToolProgress('fauna_speak', { text: 'hello world' }, 9, 'completed'))
      .toBe('Audio ready · 9s');
  });

  it('describes multi-segment podcast synthesis', () => {
    expect(formatToolProgress('fauna_podcast', { segments: [{}, {}, {}] }, 12, 'running'))
      .toBe('Synthesizing 3 podcast segments · 12s');
  });

  it('describes native Kokoro loading, segment, and encoding phases', () => {
    expect(formatToolPhaseProgress('fauna_speak', { phase: 'load-model', fraction: 0.42 }, 3))
      .toBe('Loading speech model · 42% · 3s');
    expect(formatToolPhaseProgress('fauna_speak', { phase: 'synthesize', index: 2, total: 7 }, 8))
      .toBe('Synthesizing audio segment 3 of 7 · 8s');
    expect(formatToolPhaseProgress('fauna_speak', { phase: 'encode', fraction: 0 }, 14))
      .toBe('Encoding MP3 · 14s');
  });

  it('emits progress every second and a final completion event', () => {
    expect(routeSource).toContain("type: 'tool_progress'");
    expect(routeSource).toContain('}, 1000);');
    expect(routeSource).toContain('clearInterval(toolProgressTimer)');
    expect(routeSource).toContain('completed: true');
  });

  it('routes progress by call ID and persists the final status', () => {
    expect(chatSource).toContain('_activityEntryByCallId[callId] = _currentActivityEntry');
    expect(chatSource).toContain("if (evt.type === 'tool_progress')");
    expect(chatSource).toContain('(evt.callId && _activityEntryByCallId[evt.callId])');
    expect(chatSource).toContain("output: entry.output || entry.progress || ''");
  });

  it('propagates Kokoro native progress through the self-tool SSE context', () => {
    expect(kokoroRouteSource).toContain('voice: voiceId, onProgress');
    expect(kokoroRouteSource).toContain("onProgress({ phase: 'encode', fraction: 0 })");
    expect(selfToolsSource).toContain('onProgress: context.onToolProgress');
    expect(routeSource).toContain('formatToolPhaseProgress(toolName, progress, elapsedSeconds)');
  });
});
