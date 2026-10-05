/**
 * Memory health metrics — a micro "observability for memory" kernel.
 *
 * A memory store degrades silently: duplicates accumulate, stale items
 * crowd fresh signal, knowledge collapses onto a few entities. These
 * pure statistics quantify that drift so memory_inspect can recommend
 * concrete next actions instead of dumping row counts.
 *
 *   - gini: concentration of PageRank mass (0 =均匀, →1 = monoculture)
 *   - duplicationRatio: sampled share of item pairs that are near-clones
 *   - median / quantiles: age distribution
 *   - staleRatio: share of items older than N half-lives
 */

import { cosine } from './embedding.js';

/** Gini coefficient over non-negative values (0 perfect equality … 1). */
export function gini(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const n = v.length;
  if (n <= 1) return 0;
  const sum = v.reduce((s, x) => s + x, 0);
  if (sum <= 0) return 0;
  // cumulative form: G = (2Σ i·x_i) / (n·Σx) − (n+1)/n
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * v[i];
  return Math.max(0, Math.min(1, (2 * weighted) / (n * sum) - (n + 1) / n));
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

/** Linear-interpolated quantile; 0 on empty input. */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export interface DuplicationOptions {
  /** Cosine above which a pair counts as a near-clone. Default 0.92. */
  threshold?: number;
  /** Cap on examined pairs (deterministic stride sampling). Default 4000. */
  pairLimit?: number;
}

/**
 * Share of sampled item pairs whose cosine exceeds the clone threshold.
 * Deterministic: pairs are enumerated by stride, not RNG, so the metric
 * is comparable across runs.
 */
export function duplicationRatio(
  vectors: Float32Array[],
  opts: DuplicationOptions = {},
): number {
  const threshold = opts.threshold ?? 0.92;
  const pairLimit = opts.pairLimit ?? 4000;
  const n = vectors.length;
  if (n < 2) return 0;
  const totalPairs = (n * (n - 1)) / 2;
  const stride = Math.max(1, Math.ceil(totalPairs / pairLimit));
  let examined = 0;
  let clones = 0;
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      if (k % stride === 0) {
        examined++;
        if (cosine(vectors[i], vectors[j]) >= threshold) clones++;
      }
      k++;
    }
  }
  return examined > 0 ? clones / examined : 0;
}

/** Share of values at/beyond `threshold`. */
export function ratioAtLeast(values: number[], threshold: number): number {
  if (values.length === 0) return 0;
  let over = 0;
  for (const v of values) if (v >= threshold) over++;
  return over / values.length;
}
