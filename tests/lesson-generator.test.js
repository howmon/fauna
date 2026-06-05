import { describe, it, expect } from 'vitest';
import { generateLessonDSL, validateLesson } from '../server/lesson/generator.js';

// Minimal mock of the OpenAI-style client generateLessonDSL expects. Each call
// shifts the next canned completion off the queue and records the messages it
// was given so we can assert the repair prompt is wired up correctly.
function mockClient(responses) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async ({ messages }) => {
          calls.push(messages);
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
