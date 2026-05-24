// Copilot provider — wraps the existing getCopilotClient().
// This is the default provider; behavior is unchanged from pre-abstraction.

import { getCopilotClient } from '../../copilot/auth.js';

export const id = 'copilot';
export const label = 'GitHub Copilot';

// Capability flags consumed by the chat pipeline:
//   tools         — model supports OpenAI-style tool_calls streaming
//   vision        — model can ingest image_url content parts
//   streaming     — chat.completions.create({stream:true}) yields chunks
//   usageEvents   — stream_options.include_usage is honored
//   embeddings    — provider has a /v1/embeddings endpoint we can call
export const supports = {
  tools:       true,
  vision:      true,
  streaming:   true,
  usageEvents: true,
  embeddings:  true,
};

export function getClient(_cfg) {
  // Copilot ignores cfg — token comes from gh/keychain via getCopilotClient.
  return getCopilotClient();
}

export async function listModels(_cfg) {
  // The existing /api/models route already calls Copilot's /models directly,
  // so this provider intentionally returns an empty list here — the route is
  // the source of truth. Local providers override this with a real fetch.
  return [];
}
