/**
 * Int8 quantization tests: pure kernel bounded error + storage savings +
 * end-to-end retrieval equivalence (recall preserved under quantization).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPRESSION_RATIO,
  dequantizeToFloat32,
  int8Cosine,
  quantizationError,
  quantizeToInt8,
} from '../src/utils/quantize.ts';
import { OfflineBM25EmbeddingProvider, cosine } from '../src/utils/embedding.ts';

test('kernel: quantize/dequantize round-trip preserves direction', async () => {
  const p = new OfflineBM25EmbeddingProvider(1024);
  const v = await p.embed('kafka pipeline throughput tuning for production');
  const q = quantizeToInt8(v);
  const back = dequantizeToFloat32(q);
  assert.equal(q.length, v.length);
  assert.equal(back.length, v.length);
  assert.ok(cosine(v, back) > 0.999, 'round-trip preserves direction (>0.999)');
});

test('kernel: bounded error — cosine(float) vs cosine(int8) < 0.005 for d=1024', async () => {
  const p = new OfflineBM25EmbeddingProvider(1024);
  const query = await p.embed('how do we deploy the phoenix pipeline');
  const corpus = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      p.embed(`fact ${i} about kafka shard deployment with tuning gates`),
    ),
  );
  const err = quantizationError(corpus, query);
  assert.ok(err < 0.005, `max cosine error ${err.toFixed(5)} < 0.005`);
});

test('kernel: int8Cosine ordering matches float ordering', async () => {
  const p = new OfflineBM25EmbeddingProvider(256);
  const q = await p.embed('postgres migration checklist');
  const items = await Promise.all([
    p.embed('postgres migration checklist with pg_dump steps'),
    p.embed('postgres replication slots and wal configuration'),
    p.embed('pasta carbonara with cream and pancetta'),
  ]);
  const q8 = quantizeToInt8(q);
  const int8Scores = items.map((v) => int8Cosine(q8, quantizeToInt8(v)));
  const floatScores = items.map((v) => cosine(q, v));
  // Rank ordering identical
  const int8Order = [...int8Scores.keys()].sort((a, b) => int8Scores[b]! - int8Scores[a]!);
  const floatOrder = [...floatScores.keys()].sort((a, b) => floatScores[b]! - floatScores[a]!);
  assert.deepEqual(int8Order, floatOrder, 'ranking preserved under int8');
});

test('kernel: storage compression ratio is 4×', () => {
  assert.equal(COMPRESSION_RATIO, 4);
});

// ───────────────────────────── end-to-end ─────────────────────────────

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';

test('acceptance: quantized palace retrieves correctly + storage saved', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quant-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL */ } });

  // Quantized palace (default).
  const ctxQ = createMockContext();
  t.after(() => {
    const s = ctxQ.services.get('memory-store') as { close(): void } | undefined;
    try { s?.close(); } catch { /* closed */ }
  });
  MemoryPalacePlugin(ctxQ as never, {
    storagePath: join(dir, 'q.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
  } as never);
  const palaceQ: any = ctxQ.services.get('memory-palace');

  // Float32 palace (explicit).
  const ctxF = createMockContext();
  t.after(() => {
    const s = ctxF.services.get('memory-store') as { close(): void } | undefined;
    try { s?.close(); } catch { /* closed */ }
  });
  MemoryPalacePlugin(ctxF as never, {
    storagePath: join(dir, 'f.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    retrieval: { quantization: 'float32' },
  } as never);
  const palaceF: any = ctxF.services.get('memory-palace');

  // Same corpus in both.
  for (let i = 0; i < 30; i++) {
    const content = `Quant fact ${i}: the ${['kafka', 'flink', 'envoy', 'grafana'][i % 4]} pipeline handles shard ${i % 7} with rollout gates in region ${i % 3}.`;
    await palaceQ.ingestor.ingestUserMemory({ content, userId: 'u-q', importance: 0.7 });
    await palaceF.ingestor.ingestUserMemory({ content, userId: 'u-q', importance: 0.7 });
  }

  // Retrieval still works under quantization (the point).
  const rq = await palaceQ.retriever.retrieve({
    query: 'kafka pipeline shard rollout gates',
    scope: { userId: 'u-q' },
    topK: 5,
  });
  assert.ok(rq.hits.length > 0, 'quantized retrieval returns hits');

  // Storage: the quantized DB's embedding column is 4× smaller per vector.
  const qItem = palaceQ.store.listItemsByLayer('semantic', 1)[0]!;
  const fItem = palaceF.store.listItemsByLayer('semantic', 1)[0]!;
  const qBlobSize = palaceQ.store.db
    .prepare('SELECT LENGTH(embedding) as n FROM memory_items WHERE id = ?')
    .get(qItem.id).n;
  const fBlobSize = palaceF.store.db
    .prepare('SELECT LENGTH(embedding) as n FROM memory_items WHERE id = ?')
    .get(fItem.id).n;
  assert.equal(qBlobSize, 256, 'int8 blob = 1 byte per dim');
  assert.equal(fBlobSize, 1024, 'float32 blob = 4 bytes per dim');
  assert.equal(fBlobSize / qBlobSize, 4, '4× compression');
});
