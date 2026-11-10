import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { compareImages } from '../lib/image-similarity.js';

async function solid(color, width = 40, height = 30) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

describe('compareImages', () => {
  it('reports identical normalized images as an exact match', async () => {
    const image = await solid('#336699');
    await expect(compareImages(image, image, { size: 32 })).resolves.toMatchObject({
      similarity: 1,
      meanAbsoluteError: 0,
      changedPixelRatio: 0,
    });
  });

  it('reports deterministic distance for visibly different images', async () => {
    const result = await compareImages(await solid('#000000'), await solid('#ffffff'), { size: 32 });
    expect(result.similarity).toBe(0);
    expect(result.meanAbsoluteError).toBe(1);
    expect(result.changedPixelRatio).toBe(1);
  });

  it('normalizes different source dimensions before comparison', async () => {
    const result = await compareImages(
      await solid('#123456', 20, 80),
      await solid('#123456', 120, 15),
      { size: 32 },
    );
    expect(result.similarity).toBe(1);
  });
});
