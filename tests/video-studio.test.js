// Video Studio pipeline — unit tests.
// These cover the pure / side-effect-free pieces (prompt assembly, subtitle
// timing math, job state machine). Rendering and TTS are mocked via the
// FAUNA_VIDEO_DRY_RUN flag so CI doesn't shell out to ffmpeg / `say`.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { _internals } from '../server/video/storyteller.js';
import { generateScript } from '../server/video/storyteller.js';
import { splitIntoCues, buildCues, cuesToSrt } from '../server/video/narration.js';
import { createJob, getJob, listJobs, patchJob, deleteJob } from '../server/video/job.js';
import { SELF_TOOL_DEFS } from '../self-tools.js';

const JOBS_ROOT = path.join(os.homedir(), '.config', 'fauna', 'video-jobs');
const _createdInTest = [];
function track(j) { _createdInTest.push(j.id); return j; }

// Mock OpenAI-shaped client: each call shifts the next canned completion and
// records the attempt so we can assert retry behavior.
function mockClient(responses) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async () => {
          calls.push(1);
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return { choices: [{ message: { content: next } }] };
        },
      },
    },
  };
}

describe('storyteller prompt assembly', () => {
  it('interpolates subject + wordsTarget', () => {
    const out = _internals._interp(_internals.SCRIPT_PROMPT, {
      subject: 'coffee',
      durationSec: 30,
      wordsTarget: 72,
    });
    expect(out).toContain('coffee');
    expect(out).toContain('72');
  });

  it('strips markdown formatting from script output', () => {
    const cleaned = _internals._stripMarkdown('# Title\n\n**bold** and `code`\n- item');
    expect(cleaned).not.toContain('#');
    expect(cleaned).not.toContain('**');
    expect(cleaned).not.toContain('`');
    expect(cleaned).not.toContain('- ');
  });

  it('unwraps a script wrapped in a single code fence (not delete it)', () => {
    const cleaned = _internals._stripMarkdown('```\nTuesday, 2pm.\nYou opened the wrong tab.\n```');
    expect(cleaned).toBe('Tuesday, 2pm.\nYou opened the wrong tab.');
  });

  it('unwraps a fenced script that carries a language tag', () => {
    const cleaned = _internals._stripMarkdown('```text\n3:14 pm. You opened Slack.\n```');
    expect(cleaned).toBe('3:14 pm. You opened Slack.');
  });
});

describe('generateScript resilience', () => {
  it('retries once when the first completion is empty', async () => {
    const client = mockClient(['', 'Tuesday, 2pm. You opened the wrong tab.']);
    const r = await generateScript({ subject: 'focus', client });
    expect(r.script).toContain('Tuesday');
    expect(client.calls).toHaveLength(2);
  });

  it('retries once when the first call throws, then succeeds', async () => {
    const client = mockClient([new Error('upstream 503'), 'A real script line.']);
    const r = await generateScript({ subject: 'focus', client });
    expect(r.script).toContain('real script');
    expect(client.calls).toHaveLength(2);
  });

  it('throws an actionable error after both attempts fail', async () => {
    const client = mockClient([new Error('boom'), new Error('boom again')]);
    await expect(generateScript({ subject: 'focus', client }))
      .rejects.toThrow(/failed after a retry/i);
    expect(client.calls).toHaveLength(2);
  });

  it('rejects an empty subject before calling the model', async () => {
    const client = mockClient(['unused']);
    await expect(generateScript({ subject: '   ', client }))
      .rejects.toThrow(/subject is required/i);
    expect(client.calls).toHaveLength(0);
  });
});

describe('subtitle timing (character-proportional)', () => {
  it('splits script into sentence-level cues', () => {
    const cues = splitIntoCues('Hello world.\nThis is a test.\nFinal beat.');
    expect(cues).toEqual(['Hello world.', 'This is a test.', 'Final beat.']);
  });

  it('allocates time proportional to char count and never exceeds audio', () => {
    const script = 'A.\nLonger second line.\nMid.';
    const cues = buildCues(script, 10);
    expect(cues).toHaveLength(3);
    expect(cues[0].start).toBe(0);
    // Last cue ends at usable (audio - 0.2s tail) exactly.
    expect(cues[2].end).toBeCloseTo(9.8, 1);
    // Longer middle cue gets more time than the short flanking cues.
    expect(cues[1].end - cues[1].start).toBeGreaterThan(cues[0].end - cues[0].start);
    expect(cues[1].end - cues[1].start).toBeGreaterThan(cues[2].end - cues[2].start);
  });

  it('emits valid SRT formatting', () => {
    const srt = cuesToSrt([{ index: 1, start: 0, end: 1.5, text: 'Hi' }]);
    expect(srt).toMatch(/^1\n00:00:00,000 --> 00:00:01,500\nHi\n/);
  });
});

describe('video job state machine', () => {
  afterEach(() => {
    for (const id of _createdInTest.splice(0)) {
      try { deleteJob(id); } catch (_) {}
    }
  });

  it('creates a job with sane defaults', () => {
    const job = track(createJob({ subject: 'sunsets' }));
    expect(job.params.subject).toBe('sunsets');
    expect(job.params.aspect).toBe('9:16');
    expect(job.params.durationSec).toBe(30);
    expect(job.stepsDone).toEqual([]);
    expect(getJob(job.id).id).toBe(job.id);
  });

  it('clamps duration and rejects unknown aspect', () => {
    const a = track(createJob({ subject: 'x', durationSec: 999, aspect: 'weird' }));
    expect(a.params.durationSec).toBe(120);
    expect(a.params.aspect).toBe('9:16');
  });

  it('patchJob invalidates downstream steps', () => {
    const job = track(createJob({ subject: 'x' }));
    // Pretend we've done all steps.
    const j = getJob(job.id);
    j.stepsDone = ['script', 'terms', 'audio', 'subtitle', 'materials', 'render'];
    fs.writeFileSync(path.join(JOBS_ROOT, job.id, 'job.json'), JSON.stringify(j));

    const { invalidated, job: updated } = patchJob(job.id, { script: 'new text' });
    expect(invalidated).toEqual(expect.arrayContaining(['audio', 'subtitle', 'render']));
    expect(updated.stepsDone).toContain('script');
    expect(updated.stepsDone).toContain('terms');
    expect(updated.stepsDone).toContain('materials');
    expect(updated.stepsDone).not.toContain('audio');
    expect(updated.stepsDone).not.toContain('render');
  });

  it('listJobs returns the created job', () => {
    const a = track(createJob({ subject: 'list-test' }));
    const list = listJobs();
    expect(list.find(x => x.id === a.id)).toBeTruthy();
  });
});

describe('video self-tool registration', () => {
  it('exposes all 6 fauna_video_* tools', () => {
    const names = SELF_TOOL_DEFS.map(d => d.function.name);
    for (const t of ['fauna_video_create', 'fauna_video_run_all', 'fauna_video_step',
                     'fauna_video_patch', 'fauna_video_get', 'fauna_video_list']) {
      expect(names).toContain(t);
    }
  });
});
