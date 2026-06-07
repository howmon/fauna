#!/usr/bin/env node
// Convert existing fp32 fact embeddings into compact TurboQuant-style records.
// Usage:
//   FAUNA_QUANTIZE_EMBEDDINGS=1 node scripts/quantize-embeddings.cjs
//   FAUNA_QUANTIZE_EMBEDDINGS=1 FAUNA_QUANTIZE_BITS=2 node scripts/quantize-embeddings.cjs
//
// Idempotent and safe to re-run. Quantization only happens when
// FAUNA_QUANTIZE_EMBEDDINGS=1 — otherwise this is a no-op so you can't
// accidentally rewrite the store.

(async () => {
  if (process.env.FAUNA_QUANTIZE_EMBEDDINGS !== '1') {
    console.log('[quantize] FAUNA_QUANTIZE_EMBEDDINGS is not 1 — nothing to do.');
    process.exit(0);
  }
  const { requantizeEmbeddings } = await import('../memory-store.js');
  const { converted } = requantizeEmbeddings();
  const bits = process.env.FAUNA_QUANTIZE_BITS === '2' ? 2 : 4;
  console.log(`[quantize] done. converted=${converted} (bits=${bits})`);
  process.exit(0);
})().catch(e => {
  console.error('[quantize] fatal:', e);
  process.exit(2);
});
