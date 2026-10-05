/**
 * Deterministic anchor-plane projection (LSH-lite) — one shared kernel for
 * anywhere "group vectors by coarse direction" is needed:
 *
 *   - the compressor buckets candidate items for sub-quadratic clustering
 *   - the semantic query cache buckets recent query vectors so a
 *     near-duplicate question hits the cache without re-scoring
 *
 * Planes are pseudo-random weights in [-1, 1] derived from a stable hash
 * of (planeIndex, dimensionIndex), so every process derives the SAME
 * planes without coordination or stored state. A vector's bucket key is
 * the sign pattern of its projections ("+-++"); two vectors are bucket
 * neighbors when their keys differ in at most one position (Hamming ≤ 1).
 */

import { hash32 } from './embedding.js';

/** Number of anchor directions. 4 planes → 16 buckets, Hamming-1 fanout 5. */
export const ANCHOR_COUNT = 4;

const planeCache = new Map<number, Float32Array[]>();

/** Memoized anchor planes for a dimension count (weights depend only on (j, i)). */
export function anchorPlanes(dims: number): Float32Array[] {
  const cached = planeCache.get(dims);
  if (cached) return cached;
  const planes: Float32Array[] = [];
  for (let j = 0; j < ANCHOR_COUNT; j++) {
    const w = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
      w[i] = (hash32(`${j}:${i}`) / 0xffffffff) * 2 - 1;
    }
    planes.push(w);
  }
  planeCache.set(dims, planes);
  return planes;
}

/** Quantize the anchor projections of `v` into a sign key like "+-++". */
export function anchorKey(v: Float32Array): string {
  const planes = anchorPlanes(v.length);
  let key = '';
  for (const plane of planes) {
    let proj = 0;
    for (let i = 0; i < v.length; i++) proj += v[i] * plane[i];
    key += proj >= 0 ? '+' : '-';
  }
  return key;
}

/** The key itself plus every key one sign-flip away (Hamming ≤ 1). */
export function neighborKeys(key: string): string[] {
  const keys = [key];
  for (let p = 0; p < key.length; p++) {
    keys.push(key.slice(0, p) + (key[p] === '+' ? '-' : '+') + key.slice(p + 1));
  }
  return keys;
}
