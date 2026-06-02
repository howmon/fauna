#!/usr/bin/env node
// Backfill embeddings for every fact missing one.
// Usage:
//   node scripts/backfill-embeddings.cjs           # default Copilot embedder
//   node scripts/backfill-embeddings.cjs --batch 32
//   node scripts/backfill-embeddings.cjs --model text-embedding-3-large
//
// Safe to re-run: facts that already have an embedding are skipped, and the
// SHA256 cache keeps us from re-embedding the same text twice.

(async () => {
  const args = process.argv.slice(2);
  const arg = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const batchSize = Math.max(1, parseInt(arg('--batch', '16'), 10) || 16);
  const model = arg('--model', undefined);

  const { listFactsWithoutEmbedding, attachEmbedding } = await import('../memory-store.js');
  const { embedTexts, DEFAULT_EMBED_MODEL } = await import('../server/lib/embeddings.js');
  const useModel = model || DEFAULT_EMBED_MODEL;

  let total = 0;
  let failed = 0;
  // Drain in batches; listFactsWithoutEmbedding re-queries each loop because
  // attachEmbedding mutates the underlying store.
  for (;;) {
    const batch = listFactsWithoutEmbedding({ limit: batchSize });
    if (!batch.length) break;
    const texts = batch.map(f => f.text);
    let vectors;
    try {
      vectors = await embedTexts(texts, { model: useModel });
    } catch (e) {
      console.error(`[backfill] batch failed (${batch.length} facts):`, e.message);
      failed += batch.length;
      // Bail out — most failures (auth, network) won't recover on the next
      // batch and we'd just spin.
      break;
    }
    for (let i = 0; i < batch.length; i++) {
      const r = attachEmbedding(batch[i].id, vectors[i], useModel);
      if (r.ok) total++;
      else failed++;
    }
    console.log(`[backfill] embedded ${total} so far (model=${useModel})`);
  }

  console.log(`[backfill] done. embedded=${total} failed=${failed}`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('[backfill] fatal:', e);
  process.exit(2);
});
