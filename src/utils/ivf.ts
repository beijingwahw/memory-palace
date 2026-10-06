/**
 * IVF partition kernel — deterministic ANN with an exactness ladder.
 *
 * The palace's shared anchor planes (utils/anchors.ts — the same kernel
 * behind compressor bucketing and the query cache) partition every vector
 * into one of 2^ANCHOR_COUNT sign buckets. Retrieval probes buckets in
 * Hamming order around the QUERY's bucket, escalating the radius until the
 * candidate pool is satisfied — radius ∞ (all keys) degenerates EXACTLY to
 * the full linear scan. FAISS semantics, zero dependencies, fully
 * deterministic: same vectors, same buckets, same order, every time.
 *
 * The index is a pure accelerator by construction: correctness NEVER
 * depends on it (the escalation ladder ends in all-keys = exact), only
 * latency does.
 */

import { ANCHOR_COUNT, anchorKey } from './anchors.js';

/**
 * Key width = number of anchor planes. Deriving this from ANCHOR_COUNT
 * (instead of hardcoding a twin constant) keeps bucket count, key length
 * and Hamming radius in lockstep with anchors.ts — change the plane count
 * there and this module follows instead of silently mismatching keys.
 */
export const IVF_BUCKET_WIDTH = ANCHOR_COUNT; // 2^ANCHOR_COUNT buckets
export const IVF_MAX_RADIUS = IVF_BUCKET_WIDTH;

/** All bucket keys, lexicographic (the deterministic full key set). */
export function allBucketKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 1 << IVF_BUCKET_WIDTH; i++) {
    out.push(i.toString(2).padStart(IVF_BUCKET_WIDTH, '0').replace(/0/g, '-').replace(/1/g, '+'));
  }
  return out.sort();
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Probe order for a query vector: its own bucket first, then every bucket
 * by Hamming distance (ties broken lexicographically). Slicing this list
 * at radius r probes the r-neighborhood; the FULL list is the exact scan.
 */
export function probeOrder(queryVector: Float32Array): string[] {
  const home = anchorKey(queryVector);
  return allBucketKeys()
    .map((k) => ({ k, d: hamming(k, home) }))
    .sort((a, b) => a.d - b.d || (a.k < b.k ? -1 : 1))
    .map((e) => e.k);
}

/** Keys within a Hamming radius of the query's bucket (inclusive). */
export function probeKeys(queryVector: Float32Array, radius: number): string[] {
  const r = Math.max(0, Math.min(IVF_MAX_RADIUS, Math.round(radius)));
  return probeOrder(queryVector).slice(0, keysWithin(r));
}

/** How many keys lie within Hamming radius r (C(W,0..r) cumulative, W = width). */
export function keysWithin(radius: number): number {
  let n = 0;
  for (let r = 0; r <= Math.min(radius, IVF_BUCKET_WIDTH); r++) {
    n += choose(IVF_BUCKET_WIDTH, r);
  }
  return n;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
}
