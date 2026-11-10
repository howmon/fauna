// Keep existing chat-completion callers working with Copilot's Responses-only models.
const RESPONSES_ONLY_MODEL_RE = /^gpt-(?:5\.[56]|6(?:\.\d+)?)(?:$|[-.])/i;

function responseError(response) {
  const error = new Error(response.error?.message || `Responses API request ${response.status || 'failed'}.`);
  error.code = response.error?.code || response.status;
  return error;
}

function toolOutput(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content) && content.every(part => part.type === 'text')) {
    return content.map(part => part.text).join('\n');
  }
  throw new Error('Responses API compatibility requires text tool outputs.');
}

function messageContent(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map(part => {
    if (part.type === 'text') {
      return message.role === 'assistant'
        ? { type: 'output_text', text: part.text, annotations: [] }
        : { type: 'input_text', text: part.text };
    }
    if (part.type === 'image_url' && message.role === 'user') {
      const image = typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url;
      return { type: 'input_image', image_url: image.url, ...(image.detail ? { detail: image.detail } : {}) };
    }
    throw new Error(`Responses API compatibility does not support ${part.type} content for ${message.role} messages.`);
  });
}

export function toResponsesRequest(params, reasoningByCall = new Map()) {
  if (params.n != null && params.n !== 1) throw new Error('Responses API supports one completion per request.');
  const input = [];
  const includedReasoning = new Set();
  for (const message of params.messages || []) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: toolOutput(message.content) });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) {
      throw new Error(`Responses API compatibility does not support the ${message.role} message role.`);
    }
    for (const call of message.tool_calls || []) {
      const reasoning = reasoningByCall.get(call.id);
      if (reasoning && !includedReasoning.has(reasoning)) {
        input.push(...reasoning);
        includedReasoning.add(reasoning);
      }
    }
    const content = messageContent(message);
    if (content.length) input.push({ role: message.role, content });
    for (const call of message.tool_calls || []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  const request = { model: params.model, input, store: false, include: ['reasoning.encrypted_content'] };
  for (const key of ['stream', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'user', 'service_tier']) {
    if (params[key] !== undefined) request[key] = params[key];
  }
  const maxTokens = params.max_completion_tokens ?? params.max_tokens;
  if (maxTokens != null) request.max_output_tokens = maxTokens;
  if (params.reasoning_effort) request.reasoning = { effort: params.reasoning_effort };
  if (params.tools?.length) {
    request.tools = params.tools.map(tool => {
      if (tool.type !== 'function') throw new Error(`Responses API compatibility does not support ${tool.type} tools.`);
      return { ...tool.function, type: 'function', strict: tool.function.strict ?? false };
    });
  }
  if (params.tool_choice !== undefined) {
    request.tool_choice = params.tool_choice?.type === 'function'
      ? { type: 'function', name: params.tool_choice.function.name }
      : params.tool_choice;
  }
  if (params.response_format) {
    request.text = { format: params.response_format.type === 'json_schema'
      ? { type: 'json_schema', ...params.response_format.json_schema }
      : params.response_format };
  }
  return request;
}

function chatUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens || 0,
    completion_tokens: usage.output_tokens || 0,
    total_tokens: usage.total_tokens ?? ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
    ...(usage.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}),
    ...(usage.output_tokens_details ? { completion_tokens_details: usage.output_tokens_details } : {}),
  };
}

function finishReason(response) {
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
  }
  return response.output?.some(item => item.type === 'function_call') ? 'tool_calls' : 'stop';
}

function responseText(response) {
  return (response.output || []).filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '')
    .join('');
}

export function toChatCompletion(response) {
  if (response.error || ['failed', 'cancelled'].includes(response.status)) throw responseError(response);
  const calls = (response.output || []).filter(item => item.type === 'function_call').map(item => ({
    id: item.call_id,
    type: 'function',
    function: { name: item.name, arguments: item.arguments },
  }));
  return {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at,
    model: response.model,
    choices: [{ index: 0, message: { role: 'assistant', content: responseText(response) || null,
      ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finishReason(response) }],
    ...(response.usage ? { usage: chatUsage(response.usage) } : {}),
  };
}

async function* chatStream(stream, rememberReasoning) {
  let response = {}, completed = false, text = '';
  const calls = new Map();
  const chunk = (delta, finish = null, usage) => ({
    id: response.id,
    object: 'chat.completion.chunk',
    created: response.created_at,
    model: response.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage: chatUsage(usage) } : {}),
  });
  try {
    for await (const event of stream) {
      if (event.type === 'response.created') {
        response = event.response;
        yield chunk({ role: 'assistant' });
      } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        text += event.delta;
        yield chunk({ content: event.delta });
      } else if (event.type === 'response.reasoning_summary_text.delta') {
        yield chunk({ reasoning_content: event.delta });
      } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
        const item = event.item;
        const call = { index: calls.size, arguments: item.arguments || '' };
        calls.set(event.output_index, call);
        yield chunk({ tool_calls: [{ index: call.index, id: item.call_id, type: 'function',
          function: { name: item.name, arguments: call.arguments } }] });
      } else if (event.type === 'response.function_call_arguments.delta') {
        const call = calls.get(event.output_index);
        if (!call) throw new Error('Responses API returned tool arguments before the function call.');
        call.arguments += event.delta;
        yield chunk({ tool_calls: [{ index: call.index, function: { arguments: event.delta } }] });
      } else if (event.type === 'response.function_call_arguments.done') {
        const call = calls.get(event.output_index);
        if (!call || !event.arguments.startsWith(call.arguments)) throw new Error('Responses API returned inconsistent tool arguments.');
        const remaining = event.arguments.slice(call.arguments.length);
        if (remaining) {
          call.arguments = event.arguments;
          yield chunk({ tool_calls: [{ index: call.index, function: { arguments: remaining } }] });
        }
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        response = event.response;
        if (response.error) throw responseError(response);
        rememberReasoning(response);
        for (const [outputIndex, item] of (response.output || []).entries()) {
          if (item.type !== 'function_call') continue;
          const call = calls.get(outputIndex);
          if (!call) {
            yield chunk({ tool_calls: [{ index: calls.size, id: item.call_id, type: 'function',
              function: { name: item.name, arguments: item.arguments } }] });
            calls.set(outputIndex, { index: calls.size, arguments: item.arguments });
          } else {
            if (!item.arguments.startsWith(call.arguments)) throw new Error('Responses API returned inconsistent final tool arguments.');
            const remaining = item.arguments.slice(call.arguments.length);
            if (remaining) yield chunk({ tool_calls: [{ index: call.index, function: { arguments: remaining } }] });
          }
        }
        if (!text) {
          const finalText = responseText(response);
          if (finalText) yield chunk({ content: finalText });
        }
        completed = true;
        yield chunk({}, finishReason(response), response.usage);
      } else if (event.type === 'error') {
        throw responseError({ status: 'failed', error: event });
      } else if (event.type === 'response.failed' || event.type === 'response.cancelled') {
        throw responseError(event.response || { status: 'failed' });
      }
    }
    if (!completed) throw new Error('Responses API stream ended before a completion event.');
  } finally {
    stream.controller?.abort();
  }
}

export function enableResponsesCompatibility(client) {
  const createChat = client.chat.completions.create.bind(client.chat.completions);
  const responsesModels = new Set();
  const reasoningByCall = new Map();
  const rememberReasoning = response => {
    const reasoning = (response.output || []).filter(item => item.type === 'reasoning' && item.encrypted_content);
    if (!reasoning.length) return;
    for (const item of response.output) {
      if (item.type !== 'function_call') continue;
      reasoningByCall.set(item.call_id, reasoning);
      if (reasoningByCall.size > 256) reasoningByCall.delete(reasoningByCall.keys().next().value);
    }
  };
  const createResponse = async (params, options) => {
    const result = await client.responses.create(toResponsesRequest(params, reasoningByCall), options);
    if (params.stream) return chatStream(result, rememberReasoning);
    rememberReasoning(result);
    return toChatCompletion(result);
  };
  client.chat.completions.create = async (params, options) => {
    if (RESPONSES_ONLY_MODEL_RE.test(params.model) || responsesModels.has(params.model)) return createResponse(params, options);
    try {
      return await createChat(params, options);
    } catch (error) {
      if (error.status !== 400 || (error.code !== 'unsupported_api_for_model' && !/not accessible via the \/chat\/completions endpoint/.test(error.message || ''))) throw error;
      console.info(`[copilot] Routing "${params.model}" through the Responses API; chat completions are unsupported.`);
      responsesModels.add(params.model);
      return createResponse(params, options);
    }
  };
  return client;
}
