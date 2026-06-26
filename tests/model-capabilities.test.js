import { describe, expect, it } from 'vitest';
import { applyModelRequestCompatibility, resolveModelCapabilities } from '../server/llm/model-capabilities.js';

describe('model capability compatibility', () => {
  it('removes reasoning fields for chat-latest models', () => {
    const caps = resolveModelCapabilities({ model: 'gpt-5-chat-latest', supports: { tools: true } });
    const params = applyModelRequestCompatibility({
      model: 'gpt-5-chat-latest',
      reasoning_effort: 'medium',
      temperature: 0.7,
      max_completion_tokens: 1000,
    }, caps);

    expect(params).not.toHaveProperty('reasoning_effort');
    expect(params).not.toHaveProperty('temperature');
    expect(params.max_completion_tokens).toBe(1000);
  });

  it('removes reasoning effort for gpt-5.4 style models', () => {
    const caps = resolveModelCapabilities({ model: 'gpt-5.4' });
    const params = applyModelRequestCompatibility({ model: 'gpt-5.4', reasoning_effort: 'high' }, caps);
    expect(params).not.toHaveProperty('reasoning_effort');
  });

  it('strips tools and stream usage for providers that do not support them', () => {
    const caps = resolveModelCapabilities({
      providerId: 'openai-compat',
      model: 'local-model',
      supports: { tools: false, usageEvents: false, vision: false },
    });
    const params = applyModelRequestCompatibility({
      tools: [{ type: 'function', function: { name: 'x' } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream_options: { include_usage: true },
    }, caps);

    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('tool_choice');
    expect(params).not.toHaveProperty('parallel_tool_calls');
    expect(params).not.toHaveProperty('stream_options');
  });

  it('applies MiniMax request quirks', () => {
    const caps = resolveModelCapabilities({ providerId: 'minimax', model: 'MiniMax-Text-01' });
    const params = applyModelRequestCompatibility({ parallel_tool_calls: false, temperature: 1.7 }, caps);

    expect(params).not.toHaveProperty('parallel_tool_calls');
    expect(params.temperature).toBe(1);
  });
});
