import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

describe('chat plan continuation UI contract', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'public/js/chat.js'), 'utf8');

  it('inherits the latest persisted plan for chained streams', () => {
    expect(source).toContain('var _isChainContinuation = !!conv._chainMode;');
    expect(source).toContain("message.role === 'assistant' && message.plan && Array.isArray(message.plan.items)");
    expect(source).toContain('var _currentPlan = _latestPlannedMessage ? _latestPlannedMessage.plan : null;');
  });

  it('surfaces depth exhaustion while preserving the incomplete plan', () => {
    expect(source).toContain('var _planStillIncompleteAtLimit');
    expect(source).toContain('the automatic continuation limit was reached while the plan still has incomplete steps');
    expect(source).toContain('conv._depthLimitNotified = true;');
  });

  it('carries summaries through repeated compaction and preserves messages arriving in flight', async () => {
    const requests = [];
    let resolveSummary;
    const context = {
      state: { model: 'test', currentId: null },
      dbg() {}, saveConversations() {},
      fetch: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return { ok: true, json: () => new Promise(resolve => { resolveSummary = resolve; }) };
      },
    };
    vm.createContext(context);
    const start = source.indexOf('var SUMMARIZE_THRESHOLD =');
    const end = source.indexOf('// Codex-parity: live token-usage', start);
    vm.runInContext(source.slice(start, end), context);
    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: 'Initial message ' + i + 'x'.repeat(3000),
    }));
    const conv = { id: 'test', messages, contextSummary: 'Original goal: preserve evidence.' };
    const first = context.maybeCompressConversation(conv);
    await new Promise(resolve => setImmediate(resolve));
    conv.messages.push({ role: 'user', content: 'New instruction while compaction is running.' });
    resolveSummary({ summary: 'Evidence saved; browser check pending.' });
    await first;
    expect(conv.messages).toHaveLength(7);
    expect(conv.messages.at(-1).content).toContain('New instruction');
    expect(conv.archivedMessages).toHaveLength(6);
    expect(requests[0].previousSummary).toBe('Original goal: preserve evidence.');

    conv.messages.push(...Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: 'Later message ' + i + 'x'.repeat(3000),
    })));
    const second = context.maybeCompressConversation(conv);
    await new Promise(resolve => setImmediate(resolve));
    resolveSummary({ summary: 'Evidence saved; browser now verified.' });
    await second;
    expect(requests[1].previousSummary).toBe('Evidence saved; browser check pending.');
    expect(conv.contextSummary).toBe('Evidence saved; browser now verified.');
    expect(conv.messages).toHaveLength(6);
  });

  it('does not overwrite a newer summary delivered during client compaction', async () => {
    let resolveSummary;
    const context = {
      state: { model: 'test', currentId: null }, dbg() {}, saveConversations() {},
      fetch: async () => ({ ok: true, json: () => new Promise(resolve => { resolveSummary = resolve; }) }),
    };
    vm.createContext(context);
    const start = source.indexOf('var SUMMARIZE_THRESHOLD =');
    vm.runInContext(source.slice(start, source.indexOf('// Codex-parity: live token-usage', start)), context);
    const conv = {
      id: 'test', contextSummary: 'Old summary',
      messages: Array.from({ length: 12 }, () => ({ role: 'user', content: 'x'.repeat(3000) })),
    };
    const compacting = context.maybeCompressConversation(conv);
    await new Promise(resolve => setImmediate(resolve));
    conv.contextSummary = 'Newer server summary with verified evidence';
    conv.contextSummaryUpdatedAt = Date.now() + 1000;
    resolveSummary({ summary: 'Older client summary' });
    await compacting;
    expect(conv.contextSummary).toBe('Newer server summary with verified evidence');
    expect(conv.messages).toHaveLength(12);
    expect(conv.archivedMessages).toBeUndefined();
  });
});