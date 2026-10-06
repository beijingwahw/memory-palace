/**
 * Intent-trajectory kernel — pure Markov model over query sequences.
 *
 * Agents are creatures of habit: after "deploy the phoenix pipeline" comes
 * "what broke last time", then "show the runbook". This kernel learns
 * those sequences from persisted per-user query logs (query_log) and
 * predicts the follow-ups a new session will actually ask, so the palace
 * can warm its caches BEFORE the question arrives (speculative warmth).
 *
 * Design:
 *   - STATE = the query's deduplicated, sorted, bounded token multiset —
 *     identical phrasings collapse; the model never stores raw history
 *     beyond one exemplar text per state (needed to re-embed the
 *     predicted query).
 *   - TRANSITIONS are first-order: state → next-state counts. Self-loops
 *     (asking the same thing again) are EXCLUDED from prediction — the
 *     cache is already warm from the current query itself.
 *   - UNSEEN states fall back to the GLOBAL next-state distribution
 *     (what tends to follow anything), so even a novel opening intent
 *     gets useful warmth.
 *   - Everything deterministic: counts desc, then key asc.
 */

import { invariant } from './invariants.js';
import { tokenize } from './tokenizer.js';

export interface TrajectoryModel {
  /** stateKey → (nextStateKey → count) */
  transitions: Map<string, Map<string, number>>;
  /** stateKey → representative raw query text (latest occurrence). */
  exemplars: Map<string, string>;
  /** Global next-state distribution (every transition observed). */
  globalNext: Map<string, number>;
  sessionCount: number;
}

export interface Prediction {
  /** Exemplar query text to warm caches with. */
  query: string;
  stateKey: string;
  /** 0..1 — transition share (seen state) or global share (unseen). */
  score: number;
  /** Where the prediction came from. */
  via: 'transition' | 'global';
}

/** Bounded, order-insensitive state key for a query. */
export function stateKey(query: string): string {
  const toks = [...new Set(tokenize(query))].sort();
  return toks.slice(0, 8).join(' ');
}

/**
 * Train on session trajectories (each an ORDERED list of query texts).
 * Sessions shorter than 2 contribute nothing (no transition to observe).
 */
export function trainIntentMarkov(trajectories: readonly string[][]): TrajectoryModel {
  const model: TrajectoryModel = {
    transitions: new Map(),
    exemplars: new Map(),
    globalNext: new Map(),
    sessionCount: 0,
  };
  for (const session of trajectories) {
    if (session.length < 2) continue;
    model.sessionCount++;
    for (let i = 0; i + 1 < session.length; i++) {
      const fromText = session[i];
      const toText = session[i + 1];
      // The loop guard bounds both indices (i and i+1 < session.length).
      invariant(fromText !== undefined && toText !== undefined, 'loop guard bounds both indices');
      const from = stateKey(fromText);
      const to = stateKey(toText);
      model.exemplars.set(from, fromText);
      model.exemplars.set(to, toText);
      if (from === to) continue; // self-loops recorded as exemplars only
      const row = model.transitions.get(from) ?? new Map<string, number>();
      row.set(to, (row.get(to) ?? 0) + 1);
      model.transitions.set(from, row);
      model.globalNext.set(to, (model.globalNext.get(to) ?? 0) + 1);
    }
  }
  return model;
}

/** Rank the likeliest follow-up queries for a current intent. */
export function predictNext(
  model: TrajectoryModel,
  currentQuery: string,
  k = 3,
): Prediction[] {
  const current = stateKey(currentQuery);
  const out: Prediction[] = [];

  const row = model.transitions.get(current);
  if (row && row.size > 0) {
    const total = [...row.values()].reduce((s, n) => s + n, 0);
    const ranked = [...row.entries()]
      .filter(([next]) => next !== current)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, k);
    for (const [next, count] of ranked) {
      const text = model.exemplars.get(next);
      if (!text) continue;
      out.push({ query: text, stateKey: next, score: count / total, via: 'transition' });
    }
    return out;
  }

  // Unseen state: the global "what follows anything" distribution.
  if (model.globalNext.size === 0) return out;
  const globalTotal = [...model.globalNext.values()].reduce((s, n) => s + n, 0);
  const ranked = [...model.globalNext.entries()]
    .filter(([next]) => next !== current)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, k);
  for (const [next, count] of ranked) {
    const text = model.exemplars.get(next);
    if (!text) continue;
    out.push({
      query: text,
      stateKey: next,
      score: count / globalTotal,
      via: 'global',
    });
  }
  return out;
}
