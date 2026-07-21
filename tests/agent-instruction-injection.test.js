import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('active agent instruction loading', () => {
  it('injects instructions automatically without requiring a first tool call', () => {
    const clientPrompt = read('public/js/agent-system.js');
    const toolCatalog = read('self-tools.js');
    const chatRoute = read('server/routes/chat.js');

    expect(clientPrompt).toContain('### Agent Instructions Are Already Loaded');
    expect(clientPrompt).toContain('Begin executing the user');
    expect(clientPrompt).toContain('request immediately.');
    expect(clientPrompt).not.toContain('You MUST call the `fauna_get_agent_instructions` tool as your very first action');

    expect(toolCatalog).toContain('Active-agent instructions are injected automatically');
    expect(toolCatalog).toContain('do not call this routinely at the start of a turn');

    expect(chatRoute).toContain('### AGENT INSTRUCTIONS (AUTHORITATIVE) ###');
    expect(chatRoute).toContain("allMessages.push({ role: 'system', content: body })");
  });
});