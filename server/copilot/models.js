// Static fallback model list used when the live Copilot /models endpoint is unreachable,
// plus the regex for chat-completions-unsupported models.

export const FALLBACK_MODELS = [
  { id: 'claude-sonnet-4.6',     name: 'Claude Sonnet 4.6',     vendor: 'Anthropic', fast: false },
  { id: 'claude-sonnet-4.5',     name: 'Claude Sonnet 4.5',     vendor: 'Anthropic', fast: false },
  { id: 'claude-sonnet-4',       name: 'Claude Sonnet 4',       vendor: 'Anthropic', fast: false },
  { id: 'claude-haiku-4.5',      name: 'Claude Haiku 4.5',      vendor: 'Anthropic', fast: true  },
  { id: 'claude-opus-4.6',       name: 'Claude Opus 4.6',       vendor: 'Anthropic', fast: false },
  { id: 'claude-opus-4.6-1m',    name: 'Claude Opus 4.6 1M',    vendor: 'Anthropic', fast: false },
  { id: 'claude-opus-4.5',       name: 'Claude Opus 4.5',       vendor: 'Anthropic', fast: false },
  { id: 'gpt-4.1',               name: 'GPT-4.1',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-4.1-mini',          name: 'GPT-4.1 mini',          vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-5-mini',            name: 'GPT-5 mini',            vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-5.1',               name: 'GPT-5.1',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.2',               name: 'GPT-5.2',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.4',               name: 'GPT-5.4',               vendor: 'OpenAI',    fast: false },
  { id: 'gpt-5.4-mini',          name: 'GPT-5.4 mini',          vendor: 'OpenAI',    fast: true  },
  { id: 'gpt-4o',                name: 'GPT-4o',                vendor: 'OpenAI',    fast: false },
  { id: 'o3-mini',               name: 'o3-mini',               vendor: 'OpenAI',    fast: false },
  { id: 'minimax-m2.5',          name: 'Minimax M2.5',          vendor: 'Minimax',   fast: true  },
  { id: 'gemini-3.1-pro-preview',name: 'Gemini 3.1 Pro Preview',vendor: 'Google',    fast: false },
  { id: 'gemini-3-flash-preview',name: 'Gemini 3 Flash Preview',vendor: 'Google',    fast: true  },
  { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro',        vendor: 'Google',    fast: false },
  { id: 'gemini-2.0-flash',      name: 'Gemini 2.0 Flash',      vendor: 'Google',    fast: true  },
];

export const CHAT_COMPLETIONS_UNSUPPORTED_RE = /^gpt-5\.5($|[-.])/i;
