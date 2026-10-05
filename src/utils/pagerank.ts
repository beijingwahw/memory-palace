/**
 * PageRank with three production-grade extensions, in one pure function:
 *
 *   1. WEIGHTED — edge mass flows proportionally to accumulated edge
 *      weight (co-occurrence counts), not raw degree. A link mentioned
 *      together 40 times carries 40× the mass of a single co-mention.
 *
 *   2. TEMPORAL — edge weights decay by recency of last co-occurrence:
 *      w_eff = w · 0.5^(ageDays / halfLife). Fresh associations dominate
 *      stale ones, so ranks track the user's CURRENT focus rather than
 *      their entire history. halfLife ≤ 0 disables decay.
 *
 *   3. PERSONALIZED (PPR) — the teleport vector concentrates on `seeds`
 *      (the query's linked entities) instead of spreading uniformly:
 *      a random-walk-with-restart from what the question is about.
 *      Entities CLOSE to the seeds in the graph earn rank and hand it to
 *      their linked memories — graph proximity becomes a retrieval
 *      signal. Without seeds this degenerates exactly to classic
 *      weighted PageRank (uniform teleport).
 *
 * Dangling-mass redistribution also follows the teleport vector, which
 * keeps total rank mass at exactly 1 for every configuration.
 */

import { clampNum } from './math.js';

export interface PageRankEdge {
  from: string;
  to: string;
  /** Accumulated edge weight (co-occurrence count). */
  weight: number;
  /** Unix-ms of last co-occurrence; enables temporal decay. */
  lastSeenAt?: number;
}

export interface PageRankOptions {
  /** Classic damping. Default 0.85. */
  damping?: number;
  /** Power-iteration rounds. Default 20. */
  iterations?: number;
  /** Personalization seeds; empty/absent → uniform teleport (classic PR). */
  seeds?: string[];
  /** Half-life in days for edge-weight decay; ≤ 0 disables. Default 0. */
  edgeDecayDays?: number;
  /** Injectable clock (unix ms) for determinism in tests. */
  now?: number;
}

const DAY_MS = 86_400_000;

export function pageRank(
  nodes: string[],
  edges: PageRankEdge[],
  opts: PageRankOptions = {},
): Map<string, number> {
  const n = nodes.length;
  if (n === 0) return new Map();

  const damping = clampNum(opts.damping ?? 0.85, 0, 1);
  const iterations = Math.max(1, Math.min(100, Math.round(opts.iterations ?? 20)));
  const decayDays = opts.edgeDecayDays ?? 0;
  const now = opts.now ?? Date.now();

  // Effective (decayed) weights and out-weight sums.
  const outW = new Map<string, number>();
  const inEdges = new Map<string, Array<{ from: string; w: number }>>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    let w = Math.max(0, e.weight);
    if (decayDays > 0 && e.lastSeenAt !== undefined) {
      const ageDays = Math.max(0, (now - e.lastSeenAt) / DAY_MS);
      w *= Math.pow(0.5, ageDays / decayDays);
    }
    if (w <= 1e-9) continue;
    outW.set(e.from, (outW.get(e.from) ?? 0) + w);
    const arr = inEdges.get(e.to) ?? [];
    arr.push({ from: e.from, w });
    inEdges.set(e.to, arr);
  }

  // Teleport vector: uniform over seeds ∩ nodes, else uniform over all.
  const nodeSet = new Set(nodes);
  const seedSet = new Set((opts.seeds ?? []).filter((s) => nodeSet.has(s)));
  const teleport = new Map<string, number>();
  const basis = seedSet.size > 0 ? [...seedSet] : nodes;
  for (const v of nodes) teleport.set(v, 0);
  for (const v of basis) teleport.set(v!, 1 / basis.length);

  let rank = new Map<string, number>();
  for (const v of nodes) rank.set(v, 1 / n);

  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (const v of nodes) {
      if ((outW.get(v) ?? 0) <= 0) dangling += rank.get(v) ?? 0;
    }
    const next = new Map<string, number>();
    for (const v of nodes) {
      let share = 0;
      for (const ie of inEdges.get(v) ?? []) {
        const uw = outW.get(ie.from) ?? 0;
        if (uw > 0) share += ((rank.get(ie.from) ?? 0) * ie.w) / uw;
      }
      const p = teleport.get(v) ?? 0;
      next.set(v, (1 - damping) * p + damping * (share + dangling * p));
    }
    // Renormalize to absorb floating-point drift.
    let sum = 0;
    for (const v of next.values()) sum += v;
    if (sum > 0) {
      for (const [k, v] of next) next.set(k, v / sum);
    }
    rank = next;
  }
  return rank;
}

/** Normalize ranks to [0, 1] by dividing by the maximum. */
export function normalizeRanks(
  ranks: Map<string, number>,
): Map<string, number> {
  let max = 0;
  for (const v of ranks.values()) if (v > max) max = v;
  const out = new Map<string, number>();
  if (max <= 0) return out;
  for (const [k, v] of ranks) out.set(k, v / max);
  return out;
}

