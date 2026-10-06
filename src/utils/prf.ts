/**
 * Pseudo-Relevance Feedback (Rocchio) — the zero-LLM route to the
 * "retrieve → learn from what you found → retrieve again" loop.
 *
 * Instead of asking a model to rewrite the query (HyDE / query expansion
 * via LLM), the FIRST retrieval pass itself supplies the expansion
 * signal: the centroid of the top hits is blended back into the query
 * vector and the candidate pool is re-scored against the feedback vector.
 * The vocabulary of the relevant documents pulls the query toward the
 * cluster it actually landed in — mitigating vocabulary mismatch, the
 * dominant failure mode of sparse/hash embeddings — at the cost of pure
 * local math (no API call, no re-embedding, no latency cliff).
 *
 * Both functions are pure and deterministic.
 */

import { normalizeInPlace } from './embedding.js';

export interface PrfOptions {
  /** Weight of the original query vector. Default 0.7. */
  alpha?: number;
  /** Weight of the top-hit centroid. Default 0.3. */
  beta?: number;
  /** How many top hits form the centroid. Default 3. */
  depth?: number;
}

/**
 * Rocchio feedback vector: `q' = α·q + β·centroid(topHits)`, L2-renormalized.
 * With no hits (or an empty depth window) a copy of the original query is
 * returned unchanged so the pipeline degrades to a plain first pass — a
 * copy, never the caller's reference, so mutating the result cannot
 * corrupt the stored query vector. Zero-norm hit vectors are skipped by
 * the centroid: an all-zero vector carries no direction, and averaging it
 * in would only dilute the centroid toward the origin.
 */
export function feedbackVector(
  query: Float32Array,
  hitVectors: Float32Array[],
  opts: PrfOptions = {},
): Float32Array {
  const alpha = opts.alpha ?? 0.7;
  const beta = opts.beta ?? 0.3;
  const depth = Math.max(1, opts.depth ?? 3);
  const vs = hitVectors
    .slice(0, depth)
    .filter((v) => v.length === query.length && l2NormSquared(v) > 0);
  if (vs.length === 0) return query.slice();

  const centroid = new Float32Array(query.length);
  for (const v of vs) {
    for (let i = 0; i < v.length; i++) {
      // i < v.length pins both slots to numbers; the guards only satisfy
      // the indexer's `| undefined` and never fire.
      const x = v[i];
      const c = centroid[i];
      if (x === undefined || c === undefined) continue;
      centroid[i] = c + x / vs.length;
    }
  }
  const out = new Float32Array(query.length);
  for (let i = 0; i < query.length; i++) {
    const q = query[i];
    const c = centroid[i];
    if (q === undefined || c === undefined) continue;
    out[i] = alpha * q + beta * c;
  }
  normalizeInPlace(out);
  return out;
}

function l2NormSquared(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x === undefined) continue;
    sum += x * x;
  }
  return sum;
}

/**
 * Token-level expansion set: terms frequent across the top hits but absent
 * from the query — useful for keyword-stage emphasis and for explaining
 * what the feedback pass "learned". Ranked by document frequency across
 * hits, tie-broken lexicographically for determinism, capped at maxTokens.
 */
export function expansionTokens(
  queryTokens: string[],
  hitTokenLists: string[][],
  maxTokens = 8,
): string[] {
  const query = new Set(queryTokens);
  const df = new Map<string, number>();
  for (const tokens of hitTokenLists) {
    for (const t of new Set(tokens)) {
      // Minimum length ≥ 2 measured in CODE POINTS: a single astral-plane
      // character token (surrogate pair, UTF-16 length 2) is still one
      // character and stays excluded.
      if (query.has(t) || Array.from(t).length < 2) continue;
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return [...df.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxTokens)
    .map(([t]) => t);
}
