function normalizeModelName(model = '') {
  return String(model || '').toLowerCase().replace(/[\s_./:-]+/g, '-');
}

export function resolveModelCapabilities({ providerId = 'copilot', model = '', supports = {} } = {}) {
  const normalized = normalizeModelName(model);
  const caps = {
    tools: true,
    vision: true,
    streaming: true,
    usageEvents: true,
    reasoningEffort: true,
    claudeThinking: false,
    // When true, inject context_management into the API request so Anthropic's
    // server handles truncation rather than relying solely on client-side compaction.
    // Mirrors the strategy used by VS Code Copilot for Claude models.
    serverContextManagement: false,
    parallelToolCalls: true,
    temperature: true,
    maxTokensField: /^(o[1-9]|gpt-5)/i.test(String(model || '')) ? 'max_completion_tokens' : 'max_tokens',
    modelFamily: normalized,
    ...supports,
  };

  if (/claude/.test(normalized)) {
    caps.claudeThinking = true;
    caps.reasoningEffort = false;
    caps.serverContextManagement = true;
  }

  if (/chat-latest/.test(normalized)) {
    caps.reasoningEffort = false;
    caps.temperature = false;
  }

  if (/gpt-5-4|gpt-54|gpt-5-5|gpt-55/.test(normalized)) {
    caps.reasoningEffort = false;
  }

  if (/minimax/.test(normalized) || /minimax/i.test(String(providerId || ''))) {
    caps.parallelToolCalls = false;
    caps.temperature = 'clamp-0-1';
  }

  return caps;
}

export function applyModelRequestCompatibility(params, capabilities = {}) {
  const caps = { ...capabilities };
  if (!caps.tools) {
    delete params.tools;
    delete params.tool_choice;
    delete params.parallel_tool_calls;
  }
  if (!caps.usageEvents) delete params.stream_options;
  if (!caps.reasoningEffort) delete params.reasoning_effort;
  if (!caps.claudeThinking) delete params.thinking;
  if (caps.parallelToolCalls === false) delete params.parallel_tool_calls;
  if (caps.temperature === false) delete params.temperature;
  if (caps.temperature === 'clamp-0-1' && typeof params.temperature === 'number') {
    params.temperature = Math.min(1, Math.max(0.01, params.temperature));
  }
  if (caps.maxTokensField === 'max_completion_tokens' && params.max_tokens) {
    params.max_completion_tokens = params.max_tokens;
    delete params.max_tokens;
  } else if (caps.maxTokensField === 'max_tokens' && params.max_completion_tokens) {
    params.max_tokens = params.max_completion_tokens;
    delete params.max_completion_tokens;
  }
  return params;
}

export { normalizeModelName };