import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerModelsRoutes } from '../server/routes/models.js';
import { runtimeFetch } from '../server/copilot/native-https-fetch.js';
import { FALLBACK_MODELS } from '../server/copilot/models.js';

vi.mock('../server/copilot/native-https-fetch.js', () => ({ runtimeFetch: vi.fn() }));

describe('Live board model discovery', () => {
  let loadModels, route;
  beforeEach(() => {
    vi.clearAllMocks();
    loadModels = registerModelsRoutes({
      get: (_path, handler) => { route = handler; },
    }, { readSavedConfig: () => ({}), getGhToken: () => 'test-token' });
  });

  it('only returns account-enabled chat models and exposes tool support', async () => {
    const model = (id, patch = {}) => ({
      id, model_picker_enabled: true,
      capabilities: { type: 'chat', supports: { tool_calls: true } },
      ...patch,
    });
    runtimeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        model('mai-code-2'),
        model('hidden', { model_picker_enabled: false }),
        model('disabled', { policy: { state: 'disabled' } }),
        model('embedding', { capabilities: { type: 'embeddings' } }),
        model('text-only', { capabilities: { type: 'chat', supports: {} } }),
      ] }),
    });
    const models = await loadModels();
    expect(models.map(m => m.id).sort()).toEqual(['mai-code-2', 'text-only']);
    expect(models.find(m => m.id === 'mai-code-2').tools).toBe(true);
    expect(models.find(m => m.id === 'text-only').tools).toBe(false);
  });

  it('does not present offline defaults as live availability when the list is empty', async () => {
    runtimeFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    expect(await loadModels()).toEqual([]);
    const res = { json: vi.fn() };
    await route({}, res);
    expect(res.json).toHaveBeenCalledWith({ models: FALLBACK_MODELS });
  });

  it('propagates discovery errors to the worker while preserving the picker offline path', async () => {
    runtimeFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(loadModels()).rejects.toThrow('models endpoint 503');
    const res = { json: vi.fn() };
    await route({}, res);
    expect(res.json).toHaveBeenCalledWith({ models: FALLBACK_MODELS });
  });
});
