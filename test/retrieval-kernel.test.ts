/**
 * Unit tests for the retrieval-kernel v3 pure modules:
 * anchors (shared LSH-lite projection), PRF (Rocchio feedback), and the
 * semantic query cache — plus the stem-domain keyword-matching regression
 * (retrieval-time inflection folding, I-NT-12).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anchorKey, neighborKeys, anchorPlanes } from '../src/utils/anchors.ts';
import { feedbackVector, expansionTokens } from '../src/utils/prf.ts';
import { SemanticQueryCache } from '../src/utils/query-cache.ts';
import { visibleAtLevel, scopeLevels, widestLevel } from '../src/utils/scope.ts';
import { OfflineBM25EmbeddingProvider, cosine } from '../src/utils/embedding.ts';
import { MemoryStore } from '../src/services/memory-store.ts';
import { MemoryRetriever, type RetrieverConfig } from '../src/services/memory-retriever.ts';
import type { MemoryItem, MemoryScope, RetrievalHit, RetrievalResult } from '../src/types/index.ts';

const DAY = 86_400_000;

test('anchor keys are deterministic, 4-wide, with Hamming-1 fanout', async () => {
  const p = new OfflineBM25EmbeddingProvider(256);
  const v = await p.embed('Kafka pipeline throughput tuning');
  const k1 = anchorKey(v);
  const k2 = anchorKey(v);
  assert.equal(k1, k2, 'same vector → same key');
  assert.equal(k1.length, 4, 'four sign bits');
  assert.match(k1, /^[+-]{4}$/, 'sign alphabet');
  assert.equal(neighborKeys(k1).length, 5, 'self + 4 single flips');
  assert.equal(anchorPlanes(256).length, 4, 'four planes');
  assert.equal(anchorPlanes(64).length, 4, 'memoized per dims');
  // Orthogonal-ish vectors usually land in different buckets.
  const w = await p.embed('completely unrelated pasta carbonara recipe');
  assert.notEqual(anchorKey(w), k1, 'dissimilar vectors split buckets (statistically)');
});

test('Rocchio feedbackVector blends the top-hit centroid and renormalizes', async () => {
  const p = new OfflineBM25EmbeddingProvider(128);
  const q = await p.embed('deploy phoenix pipeline');
  const h1 = await p.embed('deploy phoenix kubernetes pipeline steps');
  const h2 = await p.embed('phoenix deployment uses blue-green');
  const fb = feedbackVector(q, [h1, h2], { alpha: 0.7, beta: 0.3, depth: 3 });
  assert.equal(fb.length, q.length);
  let norm = 0;
  for (let i = 0; i < fb.length; i++) norm += fb[i] * fb[i];
  assert.ok(Math.abs(norm - 1) < 1e-5, 'L2 renormalized');
  // Feedback moved the vector toward the hits' centroid.
  const centroid = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) centroid[i] = (h1[i] + h2[i]) / 2;
  assert.ok(cosine(fb, centroid) > cosine(q, centroid), 'pulled toward centroid');
  // Degenerate cases return the query VALUE untouched — as a defensive
  // copy (never the caller's reference) so mutating the result cannot
  // corrupt the stored query vector.
  assert.deepStrictEqual(feedbackVector(q, [], {}), q, 'no hits → original values');
  assert.notEqual(feedbackVector(q, [], {}), q, 'no hits → defensive copy');
});

test('expansionTokens ranks hit-frequent terms absent from the query', () => {
  const out = expansionTokens(
    ['deploy', 'phoenix'],
    [
      ['deploy', 'phoenix', 'kubernetes', 'canary'],
      ['deploy', 'phoenix', 'kubernetes'],
      ['phoenix', 'kubernetes', 'rollouts'],
    ],
    5,
  );
  assert.equal(out[0], 'kubernetes', 'df=3 ranks first');
  assert.ok(!out.includes('deploy') && !out.includes('phoenix'), 'query terms excluded');
  assert.ok(out.length <= 5, 'capped');
});

test('SemanticQueryCache: hit, near-dup hit, far miss, version + params guards', async () => {
  const p = new OfflineBM25EmbeddingProvider(256);
  const q = await p.embed('how do we deploy phoenix tonight');
  const near = await p.embed('how do we deploy phoenix today');
  const far = await p.embed('pasta carbonara recipe ingredients list');
  const cache = new SemanticQueryCache<string>({ capacity: 4, threshold: 0.985 });

  // Version args are the store's COMPOSITE `<epoch>:<version>` string
  // stamp (MemoryStore.dataVersionStamp — epoch-namespaced since the
  // 32-bit user_version wrap fix); synced from the old bare numbers,
  // comparison semantics (strict !== on identity) are unchanged.
  assert.equal(cache.lookup(q, 'k1', '0:1'), undefined, 'cold miss');
  cache.store(q, 'k1', '0:1', 'RESULT-A');
  assert.equal(cache.lookup(q, 'k1', '0:1'), 'RESULT-A', 'exact hit');
  const nearSim = cosine(q, near);
  if (nearSim >= 0.985) {
    assert.equal(cache.lookup(near, 'k1', '0:1'), 'RESULT-A', 'near-dup hits when cosine ≥ threshold');
  } else {
    assert.equal(cache.lookup(near, 'k1', '0:1'), undefined, 'below threshold never hits');
  }
  assert.ok(cosine(q, far) < 0.5, 'sanity: far vector is far');
  assert.equal(cache.lookup(far, 'k1', '0:1'), undefined, 'far vector misses');
  assert.equal(cache.lookup(q, 'k2', '0:1'), undefined, 'different params key misses');
  assert.equal(cache.lookup(q, 'k1', '0:2'), undefined, 'stale stamp misses (and evicts entry)');
  assert.equal(cache.lookup(q, 'k1', '0:1'), undefined, 'evicted stale entry stays gone');
});

test('SemanticQueryCache LRU bounds capacity', async () => {
  const p = new OfflineBM25EmbeddingProvider(64);
  const cache = new SemanticQueryCache<number>({ capacity: 2, threshold: 0.999 });
  // Same composite-stamp form as above ('<epoch>:<version>' strings).
  cache.store(await p.embed('alpha one'), 'k', '0:1', 1);
  cache.store(await p.embed('beta two gamma'), 'k', '0:1', 2);
  assert.equal(cache.count, 2);
  cache.store(await p.embed('delta three epsilon'), 'k', '0:1', 3);
  assert.equal(cache.count, 2, 'bounded at capacity');
});

test('SemanticQueryCache fallback scan hits near-dups whose anchor key flips ≥2 bits (D-10)', () => {
  // Hand-constructed pair: take a deterministic pseudo-random base vector
  // and nudge it exactly across TWO anchor planes (the two whose
  // projections sit closest to zero) by solving for the perturbation in
  // span{p_i, p_j} — an exact 2×2 Gram solve. The anchor key then flips 2
  // sign bits (outside the Hamming-1 neighborhood the fast path searches)
  // while cosine stays ≈0.998, well above the 0.985 threshold. Before the
  // fallback scan this exact pair produced a cache MISS.
  const dims = 64;
  const planes = anchorPlanes(dims);
  let seed = 20260101;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  const normalize = (v: Float32Array) => {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
    n = Math.sqrt(n);
    return Float32Array.from(v, (x) => x / n);
  };
  const dot = (a: Float32Array, b: Float32Array) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
    return d;
  };
  const base = normalize(Float32Array.from({ length: dims }, () => rand() * 2 - 1));
  const proj = planes.map((p) => dot(base, p));
  const pick = [0, 1, 2, 3]
    .sort((a, b) => Math.abs(proj[a]!) - Math.abs(proj[b]!))
    .slice(0, 2);
  const MARGIN = 0.02;
  const g = [
    [dot(planes[pick[0]]!, planes[pick[0]]!), dot(planes[pick[0]]!, planes[pick[1]]!)],
    [dot(planes[pick[1]]!, planes[pick[0]]!), dot(planes[pick[1]]!, planes[pick[1]]!)],
  ];
  const targets = pick.map((j) => -Math.sign(proj[j]!) * (Math.abs(proj[j]!) + MARGIN));
  const det = g[0]![0]! * g[1]![1]! - g[0]![1]! * g[1]![0]!;
  const alpha = (targets[0]! * g[1]![1]! - g[0]![1]! * targets[1]!) / det;
  const beta = (g[0]![0]! * targets[1]! - targets[0]! * g[1]![0]!) / det;
  const w = normalize(
    Float32Array.from(
      base,
      (b, i) => b + alpha * planes[pick[0]]![i]! + beta * planes[pick[1]]![i]!,
    ),
  );

  // Preconditions: the pair really is a near-duplicate that really sits
  // outside the fast path's Hamming-1 fanout.
  const sim = cosine(base, w);
  const k0 = anchorKey(base);
  const k1 = anchorKey(w);
  const flips = [...k0].reduce((n, c, i) => n + (c === k1[i] ? 0 : 1), 0);
  assert.ok(sim >= 0.985, `cosine ${sim.toFixed(6)} ≥ threshold`);
  assert.ok(flips >= 2, `anchor keys ${k0} vs ${k1} differ in ${flips} bits`);

  const cache = new SemanticQueryCache<string>({ capacity: 4, threshold: 0.985 });
  // '<epoch>:<version>' composite stamp — see the version-guard test above.
  cache.store(base, 'k1', '0:1', 'RESULT-X');
  assert.equal(cache.lookup(w, 'k1', '0:1'), 'RESULT-X', 'fallback scan rescues the out-of-neighborhood near-dup');
  // A far vector still misses — the fallback is an exact check, not a
  // blanket pass, and other paramsKeys stay isolated.
  const far = normalize(
    Float32Array.from({ length: dims }, () => rand() * 2 - 1),
  );
  assert.ok(cosine(base, far) < 0.985, 'sanity: control vector is far');
  assert.equal(cache.lookup(far, 'k1', '0:1'), undefined, 'far vector still misses after fallback');
  assert.equal(cache.lookup(w, 'k2', '0:1'), undefined, 'other paramsKey untouched by fallback');
  assert.equal(cache.count, 1, 'fallback hit does not add entries');
});

test('visibleAtLevel mirrors the tier ACL on materialized rows', () => {
  const levels = scopeLevels('user', { userId: 'u1' });
  const widest = widestLevel(levels);
  assert.ok(
    visibleAtLevel({ visibility: 'user', userId: 'u1' }, widest),
    'own user-tier row visible',
  );
  assert.ok(!visibleAtLevel({ visibility: 'user', userId: 'u2' }, widest), "other user's row hidden");
  assert.ok(visibleAtLevel({ visibility: 'global', userId: null }, widest), 'global visible');
  assert.ok(visibleAtLevel({ visibility: null }, widest), 'legacy NULL reads as global');
  const sessionLevels = scopeLevels('session', { sessionId: 's1', userId: 'u1' });
  assert.ok(
    !visibleAtLevel({ visibility: 'user', userId: 'u1' }, sessionLevels[0]),
    'session level-0 hides user tier',
  );
  assert.ok(
    visibleAtLevel({ visibility: 'session', sessionId: 's1' }, sessionLevels[0]),
    'own session row visible at level 0',
  );
});

test('flashback semantics: tombstone timestamps gate as-of visibility', () => {
  // Pure date math the store's asOf clause encodes in SQL:
  // visible(T) ⇔ created ≤ T ∧ (deleted_at = null ∨ deleted_at > T).
  const created = 1_000;
  const deleted = 2_000;
  const visibleAsOf = (t: number) => created <= t && (deleted === null || deleted > t);
  assert.ok(visibleAsOf(1_500), 'alive mid-life');
  assert.ok(!visibleAsOf(500), 'not yet born');
  assert.ok(!visibleAsOf(2_500), 'tombstoned after deletion');
  assert.ok(visibleAsOf(2_000 - 1), 'visible the instant before deletion');
  void DAY;
});

// ------------------------------------ stem-domain keyword matching (I-NT-12)

test('stem folding (flagship): "how does aurora deploy?" reaches content saying "deploys"', async (t) => {
  // The product-smoke miss that motivated retrieval-time stemming: under
  // offline-bm25 the query token "deploy" and the content token "deploys"
  // hash to DIFFERENT sparse dimensions (raw-token keyword overlap and
  // the vector gate both miss the fold), so the Aurora item ranked below
  // a distractor that merely contained the literal token "deploy". With
  // the keyword rerank matching in stem space, deploys → deploy counts
  // and the folded term outranks the literal one.
  const dir = mkdtempSync(join(tmpdir(), 'stem-'));
  const store = new MemoryStore({
    storagePath: join(dir, 'store.db'),
    dimensions: 256,
    scope: 'user',
  });
  // Windows WAL order proven in integration.test.ts / genesis-retrieval:
  // the store-close hook registers BEFORE the directory-removal hook.
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prov = new OfflineBM25EmbeddingProvider(256);
  const cfg: RetrieverConfig = {
    topK: 2,
    mmrLambda: 0.7,
    minScore: 0,
    rerank: true,
    graphBoost: 0.15,
    graphPersonalization: 0.5,
    decayHalfLifeDays: 0,
    scope: 'user',
    prf: { enabled: false, alpha: 0.7, beta: 0.3, depth: 3 },
    entityHop: false,
    queryCache: false,
    ivf: { enabled: false, radius: 1, minItems: 1 },
  };
  const retriever = new MemoryRetriever(store, prov, cfg);
  const scope: MemoryScope = { userId: 'alice' };

  // Aurora and the distractor are shape-matched: 7 distinct tokens each,
  // exactly one query-dim token each (aurora vs deploy, both df 1, tf 1)
  // — their offline-bm25 cosines against "aurora deploy" are equal by
  // symmetry, and raw-token overlap ties at 1 apiece. Only STEM overlap
  // separates them: deploys folds onto deploy, so the Aurora item carries
  // BOTH query stems while the distractor carries one.
  const ITEMS = [
    { id: 'aurora', content: 'The Aurora service deploys on Kubernetes clusters' },
    { id: 'distractor', content: 'deploy scripts for batch jobs run nightly' },
    { id: 'sourdough', content: 'sourdough bread hydration crust baking notes' },
  ];
  let seq = 0;
  for (const it of ITEMS) {
    seq++;
    const now = 1_700_000_000_000 + seq;
    store.insertItem(
      {
        id: it.id,
        layer: 'semantic',
        content: it.content,
        embedding: await prov.embed(it.content),
        metadata: { source: 'user', embeddingSpace: prov.space },
        createdAt: now,
        updatedAt: now,
        importance: 0.5,
        accessCount: 0,
        lastAccessedAt: now,
      },
      scope,
    );
  }

  // Flagship, verbatim smoke query: the folded deploy↔deploys match must
  // surface the Aurora item.
  const smoke = await retriever.retrieve({ query: 'how does aurora deploy?', scope, topK: 3 });
  assert.ok(smoke.hits.length >= 1, 'hits non-empty');
  assert.ok(
    smoke.hits.some((h) => h.item.id === 'aurora'),
    'Aurora item retrieved for "how does aurora deploy?"',
  );

  // Rank differential: with keyword-heavy fusion the stem edge is
  // decisive — Aurora outranks the literal-deploy distractor whose only
  // lexical advantage is containing the exact query token.
  const ranked = await retriever.retrieve({
    query: 'aurora deploy',
    scope,
    topK: 2,
    fusionOverrides: { vectorWeight: 0.55, keywordWeight: 0.45 },
  });
  const auroraRank = ranked.hits.findIndex((h) => h.item.id === 'aurora') + 1;
  const distractorRank = ranked.hits.findIndex((h) => h.item.id === 'distractor') + 1;
  assert.ok(auroraRank >= 1, 'Aurora in ranked hits');
  assert.ok(distractorRank >= 1, 'distractor in ranked hits');
  assert.ok(
    auroraRank < distractorRank,
    `stem fold outranks literal deploy (aurora #${auroraRank} vs distractor #${distractorRank})`,
  );

  // Control: an unrelated query must not drag the Aurora item in.
  const control = await retriever.retrieve({
    query: 'sourdough bread hydration recipe',
    scope,
    topK: 1,
  });
  assert.equal(control.hits.length, 1);
  assert.equal(control.hits[0]!.item.id, 'sourdough');
  assert.ok(
    !control.hits.some((h) => h.item.id === 'aurora'),
    'unrelated query does not hit Aurora',
  );
});

test('formatAsContext skips oversized hits and still packs smaller successors', (t) => {
  // Hand-built RetrievalResult, no real retrieval: the point is purely the
  // budget walk. formatAsContext is a class method and touches no store
  // state, so a minimal retriever over an in-memory store suffices.
  const store = new MemoryStore({
    storagePath: ':memory:',
    dimensions: 64,
    scope: 'user',
  });
  t.after(() => store.close());
  const retriever = new MemoryRetriever(store, new OfflineBM25EmbeddingProvider(64), {
    topK: 4,
    mmrLambda: 0.7,
    minScore: 0,
    rerank: false,
    graphBoost: 0,
    graphPersonalization: 0.5,
    decayHalfLifeDays: 0,
    scope: 'user',
    prf: { enabled: false, alpha: 0.7, beta: 0.3, depth: 3 },
    entityHop: false,
    queryCache: false,
    ivf: { enabled: false, radius: 1, minItems: 1 },
  });

  const mkItem = (id: string, content: string): MemoryItem => ({
    id,
    layer: 'semantic',
    content,
    metadata: { source: 'user' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: 1_700_000_000_000,
  });
  const mkHit = (item: MemoryItem, finalScore: number): RetrievalHit => ({
    item,
    rawScore: finalScore,
    score: finalScore,
    mmrRank: 0,
    finalScore,
  });
  // Rank order: the huge item FIRST, the tiny one after it. Under the old
  // first-overflow-stops walk the huge entry would terminate the walk and
  // the tiny successor would be dropped with it.
  const huge = mkHit(mkItem('huge', 'enormous wall of text '.repeat(200)), 0.95);
  const tiny = mkHit(mkItem('tiny', 'a small but useful fact'), 0.80);
  const result: RetrievalResult = { hits: [huge, tiny], totalTokens: 0, elapsedMs: 0 };

  const ctx = retriever.formatAsContext(result, 20);
  assert.ok(!ctx.includes('enormous'), 'oversized first hit is skipped, not fatal');
  assert.ok(
    ctx.includes('a small but useful fact'),
    'small successor still fills the budget the oversized hit could not',
  );
  // Order sanity: exactly one line, and it is the tiny item's.
  assert.equal(ctx.split('\n').length, 1);
  assert.ok(ctx.startsWith('[memory:semantic score=0.80]'));
});
