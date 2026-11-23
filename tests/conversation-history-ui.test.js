import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/js/conversations.js', import.meta.url), 'utf8');

class Element {
  children = [];
  dataset = {};
  style = {};
  scrollTop = 0;
  scrollHeight = 100;
  textContent = '';
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get nextSibling() {
    return this.parent?.children[this.parent.children.indexOf(this) + 1] || null;
  }
  insertBefore(child, before) {
    child.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    if (index < 0) throw new Error('Invalid insertion anchor');
    this.children.splice(index, 0, child);
    child.parent = this;
    return child;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(child) { return child === this || this.children.some(node => node.contains(child)); }
  hasChildNodes() { return this.children.length > 0; }
  querySelector() {
    return this.children.find(node => node.className?.split(' ').includes('msg')) ||
      this.children.map(node => node.querySelector()).find(Boolean) || null;
  }
}

function setup(messages, archivedMessages = []) {
  const conv = { id: 'old', title: 'Old conversation', messages, archivedMessages };
  const inner = new Element();
  const elements = new Map();
  const callbacks = [];
  const context = {
    state: { currentId: 'old', model: 'test', conversations: [conv] },
    _convDomCache: { old: inner }, _promptHistIdx: -1, _promptHistDraft: '',
    document: {
      createElement: () => new Element(),
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
    },
    window: {}, getConv: id => id === conv.id ? conv : null,
    getConvInner: () => inner, showConvDom: () => inner,
    setTimeout: callback => callbacks.push(callback), requestAnimationFrame() {},
    updateSysScopeHint() {}, _showConvBrowserTabs() {}, renderArtifactTabs() {},
    showMessages() {}, showEmpty() {}, setBusy() {}, forceScrollBottom() {},
    ensureStreamingPlaceholder() {}, renderConvList() {},
    dbg: vi.fn(),
    appendMessageDOM: vi.fn((_role, content) => {
      if (content === 'broken') throw new Error('Cannot render message');
      const node = new Element();
      node.className = 'msg';
      node.textContent = content;
      inner.appendChild(node);
    }),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('var CONVERSATION_HISTORY_PAGE_SIZE'),
    source.indexOf('function clearConversation()')), context);
  return { context, inner, conv, flush: () => { while (callbacks.length) callbacks.shift()(); } };
}

const messages = length => Array.from({ length }, (_, i) => ({ role: 'user', content: String(i) }));
const texts = element => element.children.filter(node => node.className === 'msg').map(node => node.textContent);

describe('conversation history recovery', () => {
  it('opens only the latest page and restores all earlier pages in order without changing saved history', () => {
    const { context, inner, conv, flush } = setup(messages(65), messages(45));
    const saved = JSON.stringify(conv);
    context.loadConversation('old');
    expect(context.appendMessageDOM).toHaveBeenCalledTimes(20);
    expect(texts(inner)).toEqual(messages(65).slice(-20).map(message => message.content));
    const pager = inner.children.find(node => node.className === 'conv-archive-toggle');
    pager.onclick();
    expect(pager.disabled).toBe(true);
    flush();
    expect(context.appendMessageDOM).toHaveBeenCalledTimes(40);
    expect(texts(inner)).toEqual(messages(65).slice(-40).map(message => message.content));
    pager.onclick(); flush();
    pager.onclick(); flush();
    expect(texts(inner)).toEqual(messages(65).map(message => message.content));
    const archive = inner.children[0];
    const archivePager = archive.firstChild;
    archivePager.onclick(); flush();
    expect(texts(archive)).toEqual(messages(45).slice(-20).map(message => message.content));
    archivePager.onclick(); flush();
    archivePager.onclick(); flush();
    expect(texts(archive)).toEqual(messages(45).map(message => message.content));
    expect(JSON.stringify(conv)).toBe(saved);
    const count = context.appendMessageDOM.mock.calls.length;
    context.loadConversation('old');
    expect(context.appendMessageDOM).toHaveBeenCalledTimes(count);
  });

  it.each(['switch', 'eviction'])('does not replay a pending page after a conversation %s', action => {
    const { context, inner, flush } = setup(messages(40));
    context.loadConversation('old');
    const pager = inner.firstChild;
    pager.onclick();
    if (action === 'switch') context.state.currentId = 'other';
    else delete context._convDomCache.old;
    flush();
    expect(context.appendMessageDOM).toHaveBeenCalledTimes(20);
    expect(pager.disabled).toBe(false);
    if (action === 'switch') {
      context.state.currentId = 'old';
      pager.onclick(); flush();
      expect(context.appendMessageDOM).toHaveBeenCalledTimes(40);
    }
  });

  it('isolates malformed messages and restores legacy text-part content', () => {
    const { context, inner, conv } = setup([
      null, { role: 'user', content: 'broken' },
      { role: 'user', content: [{ type: 'text', text: 'Restored' }, { type: 'image_url' }] },
      { role: 'assistant', content: 'Later message' },
    ]);
    const saved = JSON.stringify(conv);
    context.loadConversation('old');
    expect(context.dbg).toHaveBeenCalledTimes(2);
    expect(texts(inner).slice(-2)).toEqual(['Restored', 'Later message']);
    expect(inner.children[0].textContent).toContain('could not be displayed');
    expect(JSON.stringify(conv)).toBe(saved);
  });
});
