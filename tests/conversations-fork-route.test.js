import { describe, expect, it, vi } from 'vitest';

vi.mock('../project-manager.js', () => ({ getProject: vi.fn(() => null) }));
vi.mock('../server/lib/sync-engine.js', () => ({ enqueueChange: vi.fn() }));

const { registerConversationRoutes } = await import('../server/routes/conversations.js');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('conversation fork route', () => {
  it('creates a branch at the selected message', async () => {
    const records = new Map();
    records.set('root', {
      id: 'root', title: 'Original', branchDepth: 0,
      messages: [
        { id: 'm1', role: 'user', content: 'one' },
        { id: 'm2', role: 'assistant', content: 'two' },
        { id: 'm3', role: 'user', content: 'three' },
      ],
    });
    const store = {
      get: vi.fn(async id => records.get(id) || null),
      put: vi.fn(async (id, value) => { records.set(id, value); return value; }),
    };
    const routes = new Map();
    const app = {};
    for (const method of ['get', 'post', 'put', 'delete']) {
      app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
    }
    registerConversationRoutes(app, {
      fs: {}, path: {}, configDir: '/tmp', conversationStore: store,
      getCopilotClient: vi.fn(),
    });

    const res = response();
    await routes.get('POST /api/conversations/:id/fork')({
      params: { id: 'root' },
      body: { id: 'branch-1', messageId: 'm2', title: 'Alternate path' },
    }, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.conversation).toMatchObject({
      id: 'branch-1', title: 'Alternate path', parentConversationId: 'root',
      forkedFromMessageId: 'm2', forkedFromMessageIndex: 1, branchDepth: 1,
    });
    expect(res.body.conversation.messages.map(message => message.id)).toEqual(['m1', 'm2']);
  });
});