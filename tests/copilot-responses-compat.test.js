import { describe, expect, it, vi } from 'vitest';
import { enableResponsesCompatibility, toChatCompletion, toResponsesRequest } from '../server/copilot/responses-compat.js';

function response(overrides = {}) {
  return {
    id: 'resp_1', created_at: 123, model: 'gpt-5.6-sol', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } },
    ...overrides,
  };
}

function clientWith(result = response()) {
  return enableResponsesCompatibility({
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'legacy' } }] }) } },
    responses: { create: vi.fn().mockResolvedValue(result) },
  });
}

function eventStream(events) {
  const stream = (async function* () { for (const event of events) yield event; })();
  stream.controller = { abort: vi.fn() };
  return stream;
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const request = { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'Hello' }] };
const functionItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"id":7}' };

describe('Copilot Responses request conversion', () => {
  it('converts token limits without chat-only fields and disables server-side storage', () => {
    expect(toResponsesRequest({
      ...request, stream: true, max_tokens: 100, max_completion_tokens: 200,
      stream_options: { include_usage: true }, reasoning_effort: 'high',
    })).toEqual({
      model: request.model, input: [{ role: 'user', content: 'Hello' }],
      stream: true, max_output_tokens: 200, reasoning: { effort: 'high' },
      store: false, include: ['reasoning.encrypted_content'],
    });
  });

  it('preserves system/developer instructions, text and image input', () => {
    const result = toResponsesRequest({
      ...request,
      messages: [
        { role: 'system', content: 'System instructions' },
        { role: 'developer', content: 'Developer instructions' },
        { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'Describe this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'high' } }] },
      ],
    });
    expect(result.input).toEqual([
      { role: 'system', content: 'System instructions' },
      { role: 'developer', content: 'Developer instructions' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer', annotations: [] }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Describe this' }, { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'high' }] },
    ]);
  });

  it('flattens function schemas and forced tool choice without making optional arguments strict', () => {
    const fn = { name: 'lookup', description: 'Find item', parameters: { type: 'object', properties: { id: { type: 'number' } } } };
    const result = toResponsesRequest({ ...request, tools: [{ type: 'function', function: fn }],
      tool_choice: { type: 'function', function: { name: 'lookup' } }, parallel_tool_calls: false });
    expect(result.tools).toEqual([{ ...fn, type: 'function', strict: false }]);
    expect(result.tool_choice).toEqual({ type: 'function', name: 'lookup' });
    expect(result.parallel_tool_calls).toBe(false);
  });

  it('preserves tool ids, assistant narration, encrypted reasoning and tool outputs in order', () => {
    const reasoning = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted' }];
    const result = toResponsesRequest({ ...request, messages: [
      request.messages[0],
      { role: 'assistant', content: 'Checking', tool_calls: [
        { id: 'call_1', function: { name: 'lookup', arguments: '{"id":7}' } },
        { id: 'call_2', function: { name: 'lookup', arguments: '{"id":8}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Result 7' },
      { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'Result 8' }] },
    ] }, new Map([['call_1', reasoning], ['call_2', reasoning]]));
    expect(result.input).toEqual([
      { role: 'user', content: 'Hello' }, ...reasoning,
      { role: 'assistant', content: 'Checking' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":7}' },
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"id":8}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Result 7' },
      { type: 'function_call_output', call_id: 'call_2', output: 'Result 8' },
    ]);
  });

  it('converts JSON schema output configuration', () => {
    const schema = { name: 'answer', strict: true, schema: { type: 'object', properties: {} } };
    expect(toResponsesRequest({ ...request, response_format: { type: 'json_schema', json_schema: schema } }).text)
      .toEqual({ format: { type: 'json_schema', ...schema } });
    expect(toResponsesRequest({ ...request, response_format: { type: 'json_object' } }).text)
      .toEqual({ format: { type: 'json_object' } });
  });

  it.each([
    { ...request, n: 2 },
    { ...request, tools: [{ type: 'custom' }] },
    { ...request, messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] },
    { ...request, messages: [{ role: 'tool', content: [{ type: 'image_url' }] }] },
    { ...request, messages: [{ role: 'function', content: 'legacy' }] },
  ])('rejects unsupported request shapes explicitly', params => {
    expect(() => toResponsesRequest(params)).toThrow(/Responses API/);
  });
});

describe('Copilot Responses model routing', () => {
  it.each([
    'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol-fast',
    'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra',
  ])('routes %s to Responses without substituting a model', async model => {
    const client = clientWith();
    const signal = new AbortController().signal;
    await client.chat.completions.create({ ...request, model }, { signal });
    expect(client.responses.create).toHaveBeenCalledWith(expect.objectContaining({ model }), { signal });
  });

  it.each(['gpt-4.1', 'gpt-5.4', 'claude-sonnet-4.6', 'gemini-3.1-pro-preview'])(
    'leaves existing %s chat completions unchanged',
    async model => {
      const client = clientWith();
      const result = await client.chat.completions.create({ ...request, model });
      expect(result.choices[0].message.content).toBe('legacy');
      expect(client.responses.create).not.toHaveBeenCalled();
    },
  );

  it('discovers and remembers a newly Responses-only model from the explicit endpoint error', async () => {
    const error = Object.assign(new Error('unsupported API'), { status: 400, code: 'unsupported_api_for_model' });
    const original = vi.fn().mockRejectedValue(error);
    const client = enableResponsesCompatibility({
      chat: { completions: { create: original } }, responses: { create: vi.fn().mockResolvedValue(response()) },
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await client.chat.completions.create({ ...request, model: 'future-model' });
      await client.chat.completions.create({ ...request, model: 'future-model' });
      expect(original).toHaveBeenCalledTimes(1);
      expect(client.responses.create).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('future-model'));
    } finally { log.mockRestore(); }
  });

  it.each([401, 403, 429, 500])('does not hide HTTP %s errors by retrying a different API', async status => {
    const error = Object.assign(new Error('Request failed'), { status });
    const client = enableResponsesCompatibility({
      chat: { completions: { create: vi.fn().mockRejectedValue(error) } },
      responses: { create: vi.fn() },
    });
    await expect(client.chat.completions.create({ ...request, model: 'gpt-4.1' })).rejects.toBe(error);
    expect(client.responses.create).not.toHaveBeenCalled();
  });

  it('propagates Responses errors instead of falling back to an older model', async () => {
    const client = clientWith();
    const error = Object.assign(new Error('No access to selected model'), { status: 403 });
    client.responses.create.mockRejectedValue(error);
    await expect(client.chat.completions.create(request)).rejects.toBe(error);
    expect(client.responses.create).toHaveBeenCalledTimes(1);
  });

  it('replays encrypted reasoning for tool follow-ups without storing plaintext reasoning', async () => {
    const reasoning = { id: 'rs_1', type: 'reasoning', encrypted_content: 'encrypted', summary: [] };
    const client = clientWith(response({ output: [reasoning, functionItem] }));
    const result = await client.chat.completions.create(request);
    expect(result.choices[0].message.tool_calls[0].id).toBe('call_1');
    await client.chat.completions.create({ ...request, messages: [
      ...request.messages, result.choices[0].message,
      { role: 'tool', tool_call_id: 'call_1', content: '7' },
    ] });
    expect(client.responses.create.mock.calls[1][0].input).toContainEqual(reasoning);
  });
});

describe('Copilot Responses completion conversion', () => {
  it('converts text, refusals, token usage, cache details and reasoning token counts', () => {
    const result = toChatCompletion(response({ output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Answer' }, { type: 'refusal', refusal: 'Refusal' }] },
    ] }));
    expect(result).toMatchObject({
      object: 'chat.completion', model: 'gpt-5.6-sol',
      choices: [{ message: { role: 'assistant', content: 'AnswerRefusal' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } },
    });
  });

  it('converts function calls to normal chat tool calls', () => {
    expect(toChatCompletion(response({ output: [functionItem] })).choices[0]).toEqual({
      index: 0, message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":7}' } },
      ] }, finish_reason: 'tool_calls',
    });
  });

  it.each([['max_output_tokens', 'length'], ['content_filter', 'content_filter']])(
    'maps incomplete %s responses to %s',
    (reason, expected) => {
      expect(toChatCompletion(response({ status: 'incomplete', incomplete_details: { reason } })).choices[0].finish_reason).toBe(expected);
    },
  );

  it('surfaces failed responses', () => {
    expect(() => toChatCompletion(response({ status: 'failed', error: { code: 'server_error', message: 'Upstream failed' } })))
      .toThrow('Upstream failed');
  });
});

describe('Copilot Responses streaming conversion', () => {
  it('streams text and reasoning summaries in the existing shape with final usage', async () => {
    const raw = eventStream([
      { type: 'response.created', response: response({ output: [] }) },
      { type: 'response.reasoning_summary_text.delta', delta: 'Checking' },
      { type: 'response.output_text.delta', delta: 'O' },
      { type: 'response.output_text.delta', delta: 'K' },
      { type: 'response.completed', response: response() },
    ]);
    const client = clientWith(raw);
    const chunks = await drain(await client.chat.completions.create({ ...request, stream: true }));
    expect(chunks.map(chunk => chunk.choices[0].delta.content || '').join('')).toBe('OK');
    expect(chunks.some(chunk => chunk.choices[0].delta.reasoning_content === 'Checking')).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: 'stop' }], usage: { total_tokens: 15 } });
    expect(raw.controller.abort).toHaveBeenCalled();
  });

  it('assigns contiguous indices to parallel tool calls and assembles argument deltas', async () => {
    const second = { ...functionItem, id: 'fc_2', call_id: 'call_2' };
    const output = [{ type: 'reasoning' }, functionItem, second];
    const raw = eventStream([
      { type: 'response.created', response: response({ output: [] }) },
      { type: 'response.output_item.added', output_index: 1, item: { ...functionItem, arguments: '' } },
      { type: 'response.output_item.added', output_index: 2, item: { ...second, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"id":' },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"id":7}' },
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"id":7}' },
      { type: 'response.completed', response: response({ output }) },
    ]);
    const client = clientWith(raw);
    const chunks = await drain(await client.chat.completions.create({ ...request, stream: true }));
    const calls = [];
    for (const chunk of chunks) {
      for (const call of chunk.choices[0].delta.tool_calls || []) {
        calls[call.index] ||= { id: call.id, arguments: '' };
        calls[call.index].arguments += call.function.arguments;
      }
    }
    expect(calls).toEqual([{ id: 'call_1', arguments: '{"id":7}' }, { id: 'call_2', arguments: '{"id":7}' }]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it('recovers complete tool arguments from the final snapshot if deltas were omitted', async () => {
    const client = clientWith(eventStream([
      { type: 'response.completed', response: response({ output: [functionItem] }) },
    ]));
    const chunks = await drain(await client.chat.completions.create({ ...request, stream: true }));
    expect(chunks[0].choices[0].delta.tool_calls[0]).toMatchObject({
      id: 'call_1', function: { name: 'lookup', arguments: '{"id":7}' },
    });
  });

  it('converts incomplete streams and final-only text without reporting success', async () => {
    const client = clientWith(eventStream([
      { type: 'response.incomplete', response: response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) },
    ]));
    const chunks = await drain(await client.chat.completions.create({ ...request, stream: true }));
    expect(chunks[0].choices[0].delta.content).toBe('OK');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('length');
  });

  it.each([
    [{ type: 'error', code: 'server_error', message: 'Failed stream' }],
    [{ type: 'response.failed', response: response({ status: 'failed', error: { message: 'Failed stream' } }) }],
    [{ type: 'response.created', response: response({ output: [] }) }],
    [{ type: 'response.function_call_arguments.delta', output_index: 3, delta: '{}' }],
  ])('surfaces errors and truncated streams explicitly', async event => {
    const raw = eventStream([event]);
    const client = clientWith(raw);
    await expect(drain(await client.chat.completions.create({ ...request, stream: true }))).rejects.toThrow();
    expect(raw.controller.abort).toHaveBeenCalled();
  });

  it('aborts upstream when the consumer stops reading', async () => {
    const raw = eventStream([
      { type: 'response.created', response: response({ output: [] }) },
      { type: 'response.output_text.delta', delta: 'OK' },
    ]);
    const client = clientWith(raw);
    for await (const chunk of await client.chat.completions.create({ ...request, stream: true })) {
      expect(chunk.choices[0].delta.role).toBe('assistant');
      break;
    }
    expect(raw.controller.abort).toHaveBeenCalled();
  });
});
