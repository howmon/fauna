import { describe, it, expect } from 'vitest';
import { generateLessonDSL, validateLesson, _internals } from '../server/lesson/generator.js';

// Minimal mock of the OpenAI-style client generateLessonDSL expects. Each call
// shifts the next canned completion off the queue and records the messages it
// was given so we can assert the repair prompt is wired up correctly.
function mockClient(responses) {
  const calls = [];
  const models = [];
  return {
    calls,
    models,
    chat: {
      completions: {
        create: async ({ messages, model }) => {
          calls.push(messages);
          models.push(model);
          const content = responses.shift();
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

const VALID_DSL = JSON.stringify({
  title: 'Test Lesson',
  voice: 'kokoro:af_bella',
  props: { t1: { kind: 'text', content: 'hi' } },
  scenes: [{ id: 's1', narration: 'Hello there.', actions: [] }],
});

describe('generateLessonDSL', () => {
  it('parses a valid DSL from the model', async () => {
    const client = mockClient([VALID_DSL]);
    const dsl = await generateLessonDSL({ topic: 'x', client });
    expect(validateLesson(dsl).ok).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  it('strips code fences before parsing', async () => {
    const client = mockClient(['```json\n' + VALID_DSL + '\n```']);
    const dsl = await generateLessonDSL({ topic: 'x', client });
    expect(dsl.title).toBe('Test Lesson');
  });

  it('throws a clear error when the model returns no JSON', async () => {
    const client = mockClient(['I cannot do that.']);
    await expect(generateLessonDSL({ topic: 'x', client })).rejects.toThrow(/no JSON object/);
  });

  it('falls back to the next model when the primary returns empty', async () => {
    // First (primary) model returns an empty body; fallback returns valid DSL.
    const client = mockClient(['', VALID_DSL]);
    const dsl = await generateLessonDSL({ topic: 'x', client, model: 'claude-sonnet-4.6' });
    expect(validateLesson(dsl).ok).toBe(true);
    expect(client.calls).toHaveLength(2);
    expect(client.models).toEqual(['claude-sonnet-4.6', 'gpt-4.1']);
  });

  it('throws an actionable error after every model returns empty', async () => {
    const client = mockClient(['', '']);
    await expect(generateLessonDSL({ topic: 'x', client, model: 'claude-sonnet-4.6' }))
      .rejects.toThrow(/Lesson script generation failed \(tried/i);
    expect(client.calls).toHaveLength(2);
  });

  it('injects previous errors into the prompt on a repair pass', async () => {
    const client = mockClient([VALID_DSL]);
    await generateLessonDSL({
      topic: 'x', client,
      repair: { errors: ['scenes[0].narration required', 'prop "p1" has unknown kind "blob"'] },
    });
    const userMsg = client.calls[0].find(m => m.role === 'user').content;
    expect(userMsg).toMatch(/previous attempt was rejected/i);
    expect(userMsg).toContain('scenes[0].narration required');
    expect(userMsg).toContain('unknown kind "blob"');
  });
});

describe('validateLesson layout checks', () => {
  it('accepts a slotted DSL with no coords', () => {
    const dsl = {
      title: 'T', voice: 'kokoro:af_bella',
      props: {
        title: { kind: 'text', content: 'Hello', slot: 'title' },
        body:  { kind: 'text', content: 'World', slot: 'body-center' },
      },
      scenes: [{ id: 's1', narration: 'go', actions: [
        { at: 'start', do: 'write', prop: 'title' },
        { at: 0.5,     do: 'write', prop: 'body' },
      ]}],
    };
    expect(validateLesson(dsl).ok).toBe(true);
  });

  it('rejects two props using the same slot in one scene', () => {
    const dsl = {
      title: 'T', voice: 'kokoro:af_bella',
      props: {
        a: { kind: 'text', content: 'one', slot: 'caption' },
        b: { kind: 'text', content: 'two', slot: 'caption' },
      },
      scenes: [{ id: 's1', narration: 'go', actions: [
        { at: 'start', do: 'write', prop: 'a' },
        { at: 0.5,     do: 'write', prop: 'b' },
      ]}],
    };
    const v = validateLesson(dsl);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/both use slot "caption"/);
  });

  it('rejects unknown slot names', () => {
    const dsl = {
      title: 'T', voice: 'kokoro:af_bella',
      props: { a: { kind: 'text', content: 'x', slot: 'middle' } },
      scenes: [{ id: 's1', narration: 'go', actions: [{ at: 'start', do: 'write', prop: 'a' }]}],
    };
    const v = validateLesson(dsl);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/unknown slot "middle"/);
  });

  it('detects two text props with overlapping bboxes from explicit coords', () => {
    // Two long text captions placed at the same (x,y) — the exact failure
    // mode visible in the user's "functions_scope" screenshot.
    const dsl = {
      title: 'T', voice: 'kokoro:af_bella',
      props: {
        cap1: { kind: 'text', content: 'A caption that is fairly long and wraps across the canvas width.', w: 900 },
        cap2: { kind: 'text', content: 'Another caption right on top of the first one with similar length.', w: 900 },
      },
      scenes: [{ id: 's1', narration: 'go', actions: [
        { at: 'start', do: 'write', prop: 'cap1', x: 100, y: 580 },
        { at: 0.5,     do: 'write', prop: 'cap2', x: 100, y: 580 },
      ]}],
    };
    const v = validateLesson(dsl);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/cap1.*cap2.*overlap|cap2.*cap1.*overlap/);
  });

  it('allows distinct (x,y) placements that do not overlap', () => {
    const dsl = {
      title: 'T', voice: 'kokoro:af_bella',
      props: {
        a: { kind: 'text', content: 'Top', w: 600 },
        b: { kind: 'text', content: 'Bottom', w: 600 },
      },
      scenes: [{ id: 's1', narration: 'go', actions: [
        { at: 'start', do: 'write', prop: 'a', x: 60, y: 80 },
        { at: 0.5,     do: 'write', prop: 'b', x: 60, y: 500 },
      ]}],
    };
    expect(validateLesson(dsl).ok).toBe(true);
  });

  it('rejects props that render outside canvas bounds', () => {
    const dsl = {
      title: 'T', voice: 'kokoro:af_bella',
      canvas: { width: 1280, height: 720 },
      props: {
        panel: { kind: 'code', code: 'print("hello")', w: 700, h: 300 },
      },
      scenes: [{ id: 's1', narration: 'go', actions: [
        { at: 'start', do: 'draw', prop: 'panel', x: 980, y: 520 },
      ]}],
    };
    const v = validateLesson(dsl);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/outside canvas/);
  });
});

describe('deterministic lesson fallback', () => {
  it('builds a DSL that passes validator', () => {
    const dsl = _internals._buildDeterministicFallbackLesson({
      topic: 'python',
      durationMin: 4,
      voice: 'kokoro:af_bella',
    });
    const v = validateLesson(dsl);
    expect(v.ok).toBe(true);
  });

  it('never injects note-mode fallback instructions into narration', () => {
    const dsl = _internals._buildDeterministicFallbackLesson({ topic: 'python' });
    const text = JSON.stringify(dsl).toLowerCase();
    expect(text).not.toContain('deliver the lesson as written notes');
    expect(text).not.toContain('do not retry fauna_lesson_create');
  });
});
