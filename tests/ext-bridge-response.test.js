import { describe, expect, it } from 'vitest';
import { normalizeRelayCommandResult } from '../server/bridges/ext.js';

describe('extension relay response normalization', () => {
  it('turns relay transport failures into structured application responses', () => {
    expect(normalizeRelayCommandResult(503, { ok: false, error: 'NO_EXT' })).toEqual({
      status: 200,
      data: { ok: false, error: 'NO_EXT' },
    });
  });

  it('preserves caller and validation failures', () => {
    expect(normalizeRelayCommandResult(400, { ok: false, error: 'bad action' })).toEqual({
      status: 400,
      data: { ok: false, error: 'bad action' },
    });
  });
});