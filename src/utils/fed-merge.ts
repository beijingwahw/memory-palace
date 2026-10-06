/**
 * Federation merge kernel — pure cross-palace result fusion.
 *
 * N palaces return ranked hits for the same query; the kernel merges them
 * into one pool WITHOUT flattening provenance: every hit carries its
 * source palace. MMR then diversifies ACROSS palaces for free — two
 * near-identical facts from different palaces compete on score, and the
 * loser is demoted exactly as an intra-palace duplicate would be.
 *
 * All functions deterministic and side-effect free.
 */

import { invariant } from './invariants.js';
import { cosine } from './embedding.js';
import { tokenize } from './tokenizer.js';
import type { RetrievalHit, RetrievalResult } from '../types/index.js';

export interface SourcedHit {
  hit: RetrievalHit;
  palace: string;
}

export interface MergeOptions {
  /** MMR lambda (relevance vs diversity). */
  mmrLambda: number;
  /** Final result size. */
  topK: number;
}

/** Merge N palace results into one sourced pool, ranked by finalScore. */
export function mergePools(
  results: ReadonlyMap<string, RetrievalResult>,
): SourcedHit[] {
  const all: SourcedHit[] = [];
  for (const [palace, res] of results) {
    for (const hit of res.hits) {
      all.push({ hit, palace });
    }
  }
  all.sort(
    (a, b) =>
      b.hit.finalScore - a.hit.finalScore ||
      a.palace.localeCompare(b.palace) ||
      a.hit.item.id.localeCompare(b.hit.item.id),
  );
  return all;
}

/** Cross-palace MMR: diversify the merged pool (near-dupes demoted). */
export function federatedMmr(
  pool: SourcedHit[],
  opts: MergeOptions,
): SourcedHit[] {
  if (pool.length === 0) return [];
  const { mmrLambda, topK } = opts;
  const selected: SourcedHit[] = [];
  const remaining = [...pool];

  // Cross-palace similarity: cosine only when BOTH hits carry embeddings
  // of the SAME dimensionality (same — or same-arity — space). When a
  // vector is missing or the arities disagree (different palaces embed
  // in different spaces/dimensions), the pair DEGRADES to a tokenize
  // word-set Jaccard — the same fallback memory-retriever.mmr's
  // pairSimilarity uses — instead of the old flat 0. Treating every
  // vector-less cross-palace pair as "maximally different" silently
  // disabled cross-palace diversification, which is the entire point of
  // this kernel: each selection step collapsed onto pure relevance and
  // near-duplicate facts from different palaces stopped competing, so
  // cross-palace dedup never fired. Token sets are memoized per hit;
  // the memo is keyed by the SourcedHit WRAPPER, not item.id —
  // federation merges palaces with independent id namespaces, so two
  // palaces may legitimately reuse one item id for different content,
  // and a wrapper key cannot alias them.
  const tokenSets = new WeakMap<SourcedHit, Set<string>>();
  const tokensFor = (s: SourcedHit): Set<string> => {
    let t = tokenSets.get(s);
    if (!t) {
      t = new Set(tokenize(s.hit.item.content));
      tokenSets.set(s, t);
    }
    return t;
  };
  const pairSimilarity = (a: SourcedHit, b: SourcedHit): number => {
    const ae = a.hit.item.embedding;
    const be = b.hit.item.embedding;
    if (ae && be && ae.length === be.length) return cosine(ae, be);
    const ta = tokensFor(a);
    const tb = tokensFor(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    return intersection / (ta.size + tb.size - intersection);
  };

  const seed = remaining.shift();
  invariant(seed !== undefined, 'pool is non-empty (returned early above)');
  selected.push(seed);

  while (selected.length < Math.min(topK, pool.length) && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (const [i, cand] of remaining.entries()) {
      let maxSim = 0;
      for (const sel of selected) {
        const s = pairSimilarity(cand, sel);
        if (s > maxSim) maxSim = s;
      }
      const mmrScore = mmrLambda * cand.hit.finalScore - (1 - mmrLambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const chosen = remaining.splice(bestIdx, 1)[0];
    invariant(chosen !== undefined, 'bestIdx was validated >= 0 above');
    selected.push(chosen);
  }
  return selected;
}

/**
 * Aggregate debug info across palaces.
 *
 * `degraded` (passed by the federated retriever) lists members that were
 * isolated this round — timeout, error, or open breaker. Each gets a
 * zero-hit placeholder entry so isolated members stay VISIBLE in the
 * palaces list instead of silently vanishing from the round.
 */
export function aggregateDebug(
  results: ReadonlyMap<string, RetrievalResult>,
  degraded: ReadonlyArray<{ palace: string; circuitOpen: boolean }> = [],
): {
  palaces: Array<{
    name: string;
    hits: number;
    elapsedMs: number;
    /** Present only on degraded placeholder entries (from `degraded`). */
    circuitOpen?: boolean;
  }>;
  totalPool: number;
} {
  const palaces: Array<{
    name: string;
    hits: number;
    elapsedMs: number;
    circuitOpen?: boolean;
  }> = [];
  let totalPool = 0;
  for (const [name, res] of results) {
    palaces.push({ name, hits: res.hits.length, elapsedMs: res.elapsedMs });
    // Pool size = merged hits, one uniform rule (vectorRecall only ever
    // covered the vector pass and undercounted entity-hop recalls).
    totalPool += res.hits.length;
  }
  for (const d of degraded) {
    if (results.has(d.palace)) continue; // answered despite the flag
    palaces.push({ name: d.palace, hits: 0, elapsedMs: 0, circuitOpen: d.circuitOpen });
  }
  palaces.sort((a, b) => a.name.localeCompare(b.name));
  return { palaces, totalPool };
}
