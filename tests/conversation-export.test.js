import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadExportHarness() {
  const source = fs.readFileSync(path.join(process.cwd(), 'public/js/conversations.js'), 'utf8');
  const start = source.indexOf('function _extractToolBlocksFromContent');
  const end = source.indexOf('function exportConversation');
  const sanitizerStart = source.indexOf('function _sanitizeExportContent');
  const sanitizerEnd = source.indexOf('\nfunction exportConversation', sanitizerStart);
  const controlsStart = source.indexOf('function _isSystemControlMessage');
  const displayStart = source.indexOf('function sanitizeUserDisplayContent');
  const context = {
    console: { log: vi.fn(), warn: vi.fn() },
    Date,
    Math,
    navigator: { userAgent: 'test-agent' },
    window: { FAUNA_BUILD: { version: '2.0.0', commit: 'abc123' } },
    state: { model: 'gpt-test', thinkingBudget: 'auto', maxContextTurns: 80 },
    _debugLogs: ['unrelated mailbox secret', 'token=secret'],
  };
  const helpers = source.slice(start, controlsStart)
    + source.slice(controlsStart, sanitizerStart)
    + source.slice(displayStart, sanitizerStart)
    + source.slice(sanitizerStart, sanitizerEnd)
    + '\n;globalThis.__build = _buildConversationExport;';
  vm.runInNewContext(helpers, context);
  return context.__build;
}

describe('conversation transcript export', () => {
  it('filters runtime controls, reindexes messages, and excludes global debug logs', () => {
    const build = loadExportHarness();
    const bundle = build({
      id: 'conv-1',
      createdAt: 100,
      updatedAt: 150,
      lastRequestSnapshot: { model: 'gpt-test', systemPromptChars: 1200 },
      messages: [
        { role: 'user', content: 'hello', timestamp: 200 },
        { role: 'user', content: '[System: continue the plan.]', timestamp: 250 },
        { role: 'assistant', content: 'done', timestamp: 300 },
      ],
    });

    expect(bundle.conversation.messageCount).toBe(2);
    expect(bundle.messages.map(message => message.index)).toEqual([0, 1]);
    expect(bundle.messages.map(message => message.sourceIndex)).toEqual([0, 2]);
    expect(bundle.conversation.updatedAt).toBe(300);
    expect(bundle.conversation.effectiveRequest).toMatchObject({ model: 'gpt-test', systemPromptChars: 1200 });
    expect(bundle).not.toHaveProperty('clientDebugLog');
    expect(JSON.stringify(bundle)).not.toContain('mailbox secret');
    expect(bundle.diagnostics.clientDebugLogIncluded).toBe(false);
  });
});