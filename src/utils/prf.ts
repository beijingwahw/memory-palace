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
 * With no hits (or an empty depth window) the original query is returned
 * unchanged so the pipeline degrades to a plain first pass.
 */
export function feedbackVector(
  query: Float32Array,
  hitVectors: Float32Array[],
  opts: PrfOptions = {},
): Float32Array {
  const alpha = opts.alpha ?? 0.7;
  const beta = opts.beta ?? 0.3;
  const depth = Math.max(1, opts.depth ?? 3);
  const vs = hitVectors.slice(0, depth).filter((v) => v.length === query.length);
  if (vs.length === 0) return query;

  const centroid = new Float32Array(query.length);
  for (const v of vs) {
    for (let i = 0; i < v.length; i++) centroid[i] += v[i] / vs.length;
  }
  const out = new Float32Array(query.length);
  for (let i = 0; i < query.length; i++) {
    out[i] = alpha * query[i] + beta * centroid[i];
  }
  normalizeInPlace(out);
  return out;
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
      if (query.has(t) || t.length < 3) continue;
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return [...df.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxTokens)
    .map(([t]) => t);
}
