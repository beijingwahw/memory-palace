/**
 * Property-style tests — zero-dependency, seed-driven.
 *
 * A tiny deterministic PRNG (mulberry32) generates hundreds of random
 * inputs per property; every iteration must preserve the invariant. Same
 * seed → same inputs → failures are reproducible by construction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkText } from '../src/utils/chunker.ts';
import { pageRank } from '../src/utils/pagerank.ts';
import { canonicalJson, capsuleItemId, signCapsule, verifyCapsule, CAPSULE_MAGIC } from '../src/utils/capsule.ts';
import { feedbackVector } from '../src/utils/prf.ts';
import { OfflineBM25EmbeddingProvider, cosine } from '../src/utils/embedding.ts';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'kafka', 'flink', 'postgres', 'kubernetes', 'envoy', 'canary', 'pipeline',
  'throughput', 'latency', 'dashboard', 'rollout', 'incident', 'pager',
];

function randomText(r: () => number, minLen = 40, maxLen = 400): string {
  const n = minLen + Math.floor(r() * (maxLen - minLen));
  const parts: string[] = [];
  let len = 0;
  while (len < n) {
    const w = WORDS[Math.floor(r() * WORDS.length)] ?? 'alpha';
    parts.push(w);
    len += w.length + 1;
    if (r() < 0.08) parts.push('.\n\n## Heading ' + w); // structural noise
  }
  return parts.join(' ') + '.';
}

test('property: chunker offsets always in bounds, ordered, non-duplicating', () => {
  const r = rng(42);
  for (let iter = 0; iter < 200; iter++) {
    const text = randomText(r);
    const maxTokens = 4 + Math.floor(r() * 60);
    const chunks = chunkText(text, {
      maxTokens,
      overlapTokens: Math.floor(r() * maxTokens),
      minTokens: 1 + Math.floor(r() * 4),
    });
    let prevEnd = -1;
    let prevText = '';
    for (const c of chunks) {
      assert.ok(c.startChar >= 0 && c.endChar <= text.length, 'offsets in bounds');
      assert.ok(c.startChar < c.endChar, 'non-empty span');
      assert.ok(c.endChar >= prevEnd, 'ends never regress');
      assert.ok(c.startChar >= prevEnd - maxTokens * 8, 'windows advance');
      assert.notEqual(c.text, prevText, 'no verbatim duplicate of previous chunk');
      prevEnd = c.endChar;
      prevText = c.text;
    }
  }
});

test('property: PageRank mass is exactly conserved on random graphs', () => {
  const r = rng(7);
  for (let iter = 0; iter < 100; iter++) {
    const n = 2 + Math.floor(r() * 12);
    const nodes = Array.from({ length: n }, (_, i) => 'n' + i);
    const edges: Array<{ from: string; to: string; weight: number }> = [];
    for (let i = 0; i < n * 2; i++) {
      edges.push({
        from: nodes[Math.floor(r() * n)]!,
        to: nodes[Math.floor(r() * n)]!,
        weight: 1 + Math.floor(r() * 10),
      });
    }
    const seeds = r() < 0.5 ? [nodes[Math.floor(r() * n)]!] : undefined;
    const ranks = pageRank(nodes, edges, {
      iterations: 1 + Math.floor(r() * 30),
      edgeDecayDays: r() < 0.5 ? 30 : 0,
      seeds,
      now: 1_700_000_000_000,
    });
    let mass = 0;
    for (const v of ranks.values()) mass += v;
    assert.ok(Math.abs(mass - 1) < 0.01, 'mass ≈ 1, got ' + mass.toFixed(4));
  }
});

test('property: pageRank kernel survives NaN-weight and foreign-node edges', () => {
  // Deterministic poisoned graph: non-finite weights (NaN passes straight
  // through Math.max(0, NaN); ±Infinity would dwarf all other mass) and
  // edges whose endpoints are not in `nodes`. The kernel drops them
  // in-function; conservation must hold regardless (no rank may turn NaN
  // and Σrank must stay ≈ 1 — the poison must not leak into the mass).
  const nodes = ['a', 'b', 'c'];
  const edges: Array<{ from: string; to: string; weight: number }> = [
    { from: 'a', to: 'b', weight: 3 },
    { from: 'b', to: 'c', weight: 2 },
    { from: 'a', to: 'c', weight: 1 },
    { from: 'a', to: 'a', weight: Number.NaN }, // self-loop AND non-finite
    { from: 'c', to: 'a', weight: Number.NaN },
    { from: 'b', to: 'ghost', weight: 5 }, // foreign endpoint
    { from: 'ghost', to: 'c', weight: Number.POSITIVE_INFINITY },
    { from: 'ghostA', to: 'ghostB', weight: 4 }, // both endpoints foreign
  ];
  const ranks = pageRank(nodes, edges, { iterations: 20, now: 1 });
  let mass = 0;
  for (const v of ranks.values()) {
    assert.ok(Number.isFinite(v), 'every rank must be finite, got ' + v);
    assert.ok(v >= 0, 'ranks stay non-negative');
    mass += v;
  }
  assert.equal(ranks.size, nodes.length, 'only the requested nodes are ranked');
  assert.ok(Math.abs(mass - 1) < 0.01, 'mass ≈ 1 despite poisoned edges, got ' + mass.toFixed(4));
});

test('property: capsule canonicalization + signatures survive key reordering', () => {
  const r = rng(99);
  for (let iter = 0; iter < 60; iter++) {
    const content = randomText(r, 30, 120);
    const capsule: import('../src/utils/capsule.ts').MemoryCapsule = {
      magic: CAPSULE_MAGIC,
      version: 1 as const,
      palaceId: 'p' + iter,
      exportedAt: Math.floor(r() * 1e12),
      items: [{
        id: capsuleItemId(content),
        layer: 'semantic' as const,
        content,
        importance: r(),
        createdAt: 1,
        entities: [],
        tags: [],
        source: 'user' as const,
      }],
      patterns: [],
    };
    const secret = 's' + iter;
    const signed = signCapsule(capsule, secret);
    assert.ok(verifyCapsule(signed, secret), 'verify own signature');
    // canonicalJson is order-insensitive by construction:
    const a = canonicalJson({ z: 1, a: { y: 2, b: 3 } });
    const b = canonicalJson({ a: { b: 3, y: 2 }, z: 1 });
    assert.equal(a, b, 'canonical form order-insensitive');
    assert.ok(!verifyCapsule({ ...signed, palaceId: 'evil' }, secret), 'mutation breaks MAC');
  }
});

test('property: PRF feedback stays normalized and query-dominated', async () => {
  const provider = new OfflineBM25EmbeddingProvider(128);
  const r = rng(2024);
  for (let iter = 0; iter < 40; iter++) {
    const q = await provider.embed(randomText(r, 20, 80));
    const hits = await Promise.all(
      Array.from({ length: 1 + Math.floor(r() * 4) }, () => provider.embed(randomText(r, 20, 80))),
    );
    const alpha = 0.5 + r() * 0.5;
    const beta = r() * (1 - alpha);
    const fb = feedbackVector(q, hits, { alpha, beta, depth: 4 });
    let norm = 0;
    for (let i = 0; i < fb.length; i++) norm += fb[i] * fb[i];
    assert.ok(Math.abs(norm - 1) < 1e-5, 'L2 normalized');
    // alpha > beta ⇒ the query dominates the blend direction
    if (hits.length > 0 && alpha > beta + 0.1) {
      const centroid = new Float32Array(q.length);
      for (const h of hits) for (let i = 0; i < h.length; i++) centroid[i] += h[i] / hits.length;
      assert.ok(cosine(fb, q) > cosine(fb, centroid), 'closer to query than to centroid');
    }
  }
});
