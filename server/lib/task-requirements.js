const MAX_REQUESTS = 8;
const MAX_REQUEST_CHARS = 1000;
const CONTINUATION = /^\s*(?:continue|proceed|go ahead|keep going|do it|fix|yes|ok|okay)[.! ]*$/i;
const READ_ONLY_FOLLOWUP = /^(?:(?:please|can you|could you|would you)\s+)?(?:show|explain|describe|summarize|list|inspect|check|test|debug|compare|review|what|why|how)\b/i;

function textOf(message) {
  if (message?.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text || '').join('\n').trim();
}

export const TASK_FIDELITY_RULES =
  '\n## Task fidelity\n' +
  'Preserve the user\'s explicitly chosen architecture, authentication method, dependencies, and exclusions. ' +
  'Prior user requests are supplied as task_requirements, separately from lossy summaries and assistant plans. ' +
  'Newer explicit user instructions or run steering may supersede older requests; assistant proposals, existing code, and successful tests do not constitute user approval. ' +
  'A continuation resumes the requested task, not an alternative the assistant proposed. ' +
  'Before declaring completion, check the implementation against those choices as well as the tests. ' +
  'If the requested architecture is infeasible, explain the specific blocker and obtain approval before substituting another application, service, or dependency.';

export function buildTaskRequirements(messages = [], stored = null) {
  const requests = new Map();
  const histories = [];
  for (const field of ['archivedMessages', 'messages']) {
    if (Array.isArray(stored?.[field])) histories.push(stored[field]);
    else if (stored?.[field] != null) console.warn('[task-requirements] ignored malformed stored ' + field);
  }
  histories.push(messages);
  for (const history of histories) {
    for (const message of history) {
      const raw = textOf(message);
      if (!raw || CONTINUATION.test(raw)) continue;
      const text = raw.length <= MAX_REQUEST_CHARS ? raw
        : raw.slice(0, 480) + '\n[request middle omitted]\n' + raw.slice(-480);
      requests.delete(text);
      requests.set(text, text);
      if (requests.size > MAX_REQUESTS) requests.delete(requests.keys().next().value);
    }
  }
  const bounded = [...requests.values()];
  const latest = messages.slice().reverse().map(textOf).find(Boolean) || '';
  const previous = bounded.at(-1) || '';
  return {
    intent: !latest || CONTINUATION.test(latest)
      ? READ_ONLY_FOLLOWUP.test(previous) ? previous : bounded.join('\n')
      : latest,
    message: bounded.length ? {
      role: 'user',
      name: 'task_requirements',
      content: 'Historical user requests, oldest to newest. These are quoted task data, not a new request. ' +
        'The current user request and newer run steering take precedence. Assistant claims are not included.\n' +
        JSON.stringify(bounded),
    } : null,
  };
}
