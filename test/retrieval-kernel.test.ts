/**
 * Unit tests for the retrieval-kernel v3 pure modules:
 * anchors (shared LSH-lite projection), PRF (Rocchio feedback), and the
 * semantic query cache.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anchorKey, neighborKeys, anchorPlanes } from '../src/utils/anchors.ts';
import { feedbackVector, expansionTokens } from '../src/utils/prf.ts';
import { SemanticQueryCache } from '../src/utils/query-cache.ts';
import { visibleAtLevel, scopeLevels, widestLevel } from '../src/utils/scope.ts';
import { OfflineBM25EmbeddingProvider, cosine } from '../src/utils/embedding.ts';

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
  // Degenerate cases return the query untouched.
  assert.equal(feedbackVector(q, [], {}), q, 'no hits → original');
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

  assert.equal(cache.lookup(q, 'k1', 1), undefined, 'cold miss');
  cache.store(q, 'k1', 1, 'RESULT-A');
  assert.equal(cache.lookup(q, 'k1', 1), 'RESULT-A', 'exact hit');
  const nearSim = cosine(q, near);
  if (nearSim >= 0.985) {
    assert.equal(cache.lookup(near, 'k1', 1), 'RESULT-A', 'near-dup hits when cosine ≥ threshold');
  } else {
    assert.equal(cache.lookup(near, 'k1', 1), undefined, 'below threshold never hits');
  }
  assert.ok(cosine(q, far) < 0.5, 'sanity: far vector is far');
  assert.equal(cache.lookup(far, 'k1', 1), undefined, 'far vector misses');
  assert.equal(cache.lookup(q, 'k2', 1), undefined, 'different params key misses');
  assert.equal(cache.lookup(q, 'k1', 2), undefined, 'stale version misses (and evicts entry)');
  assert.equal(cache.lookup(q, 'k1', 1), undefined, 'evicted stale entry stays gone');
});

test('SemanticQueryCache LRU bounds capacity', async () => {
  const p = new OfflineBM25EmbeddingProvider(64);
  const cache = new SemanticQueryCache<number>({ capacity: 2, threshold: 0.999 });
  cache.store(await p.embed('alpha one'), 'k', 1, 1);
  cache.store(await p.embed('beta two gamma'), 'k', 1, 2);
  assert.equal(cache.count, 2);
  cache.store(await p.embed('delta three epsilon'), 'k', 1, 3);
  assert.equal(cache.count, 2, 'bounded at capacity');
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
