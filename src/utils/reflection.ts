/**
 * Reflection — the palace grades its own recall and proposes a better
 * configuration for itself.
 *
 * Self-optimizing retrieval systems need labeled queries, which a memory
 * palace never has. What it DOES have is ground truth of a subtler kind:
 * an item that exists was important enough to store, so a query built
 * FROM the item must find the item (or its nearest neighbors) — a
 * self-consistency benchmark. Each stored item contributes one
 * pseudo-query (its most entity-dense sentence); retrieval runs the REAL
 * pipeline over those queries under different parameter settings, and the
 * setting that maximizes mean reciprocal rank + recall@K wins.
 *
 * This module holds the pure mathematics: benchmark construction, ranking
 * metrics, and the parameter grid. The orchestration (spawning throwaway
 * retrievers over the live store) lives in services/reflector.ts.
 */

import type { MemoryItem } from '../types/index.js';

export interface BenchEntry {
  /** Pseudo-query derived from the item itself. */
  query: string;
  /** The item that must be recalled (its id, for rank lookup). */
  labelItemId: string;
}

export interface BenchmarkOptions {
  /** Max entries (grid sweeps multiply per-entry work). Default 25. */
  maxEntries?: number;
  /** Skip items shorter than this many tokens. Default 8. */
  minTokens?: number;
}

/**
 * Build the self-consistency benchmark: for each suitable item, the
 * pseudo-query is its FIRST sentence, trimmed to 180 chars — the sentence
 * seeds the item's own embedding neighborhood. Items whose first sentence
 * is too short fall back to the whole content trimmed. Deterministic
 * order (input order), capped.
 */
export function buildBenchmark(
  items: MemoryItem[],
  opts: BenchmarkOptions = {},
): BenchEntry[] {
  const maxEntries = opts.maxEntries ?? 25;
  const minTokens = opts.minTokens ?? 8;
  const out: BenchEntry[] = [];
  for (const item of items) {
    if (out.length >= maxEntries) break;
    const first = firstSentence(item.content);
    const query = first.length >= 24 ? first.slice(0, 180) : item.content.slice(0, 180);
    if (countWords(query) < minTokens) continue;
    out.push({ query, labelItemId: item.id });
  }
  return out;
}

/** Mean reciprocal rank over rank positions (null = not found → 0). */
export function mrr(positions: Array<number | null>): number {
  if (positions.length === 0) return 0;
  let sum = 0;
  for (const p of positions) {
    if (p !== null && p > 0) sum += 1 / p;
  }
  return sum / positions.length;
}

/** Share of entries whose label landed in the top K. */
export function recallAtK(positions: Array<number | null>, k: number): number {
  if (positions.length === 0) return 0;
  let hit = 0;
  for (const p of positions) {
    if (p !== null && p >= 1 && p <= k) hit++;
  }
  return hit / positions.length;
}

/** Position (1-based) of `needle` in `ids`, or null when absent. */
export function rankOf(ids: string[], needle: string): number | null {
  const idx = ids.indexOf(needle);
  return idx === -1 ? null : idx + 1;
}

export interface ReflectionParams {
  graphBoost: number;
  prfAlpha: number;
  prfBeta: number;
}

/** Deterministic, deliberately small grid: 4 × 3 × 3 = 36 sweeps. */
export function reflectionGrid(
  base: ReflectionParams,
): ReflectionParams[] {
  const boosts = unique([0, 0.1, base.graphBoost, 0.25]);
  const alphas = unique([0.6, base.prfAlpha, 0.8]);
  const betas = unique([0.2, base.prfBeta, 0.4]);
  const out: ReflectionParams[] = [];
  for (const graphBoost of boosts) {
    for (const prfAlpha of alphas) {
      for (const prfBeta of betas) {
        out.push({ graphBoost, prfAlpha, prfBeta });
      }
    }
  }
  return out;
}

/** Combined objective: MRR weighted 2:1 over recall@K. */
export function objective(mrrValue: number, recallValue: number): number {
  return (2 * mrrValue + recallValue) / 3;
}

function unique(values: number[]): number[] {
  return [...new Set(values.map((v) => Number(v.toFixed(3))))].sort((a, b) => a - b);
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?。！？]*[.!?。！？]/);
  return m ? m[0] : text;
}

function countWords(s: string): number {
  const m = s.match(/[\p{L}\p{N}_]+/gu);
  return m ? m.length : 0;
}
