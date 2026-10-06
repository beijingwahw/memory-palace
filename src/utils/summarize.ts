/**
 * Classical MMR extractive summarization — shared selection kernel,
 * zero-LLM, fully deterministic.
 *
 * A consumer hands in a pool of pre-scored lines (each already carrying a
 * `salience` and optionally a `group` = which source member/entry the line
 * came from); the kernel picks a budget-bounded subset that is both
 * high-salience and mutually non-redundant, and returns the survivors in
 * their ORIGINAL input order so time-ordered prose stays readable.
 *
 * Selection is plain Maximal Marginal Relevance (Goldstein & Carbonell,
 * 1998) over token-set Jaccard similarity:
 *
 *   MMR(line) = λ · salience − (1 − λ) · max Jaccard(line, selected)
 *
 * plus one coverage constraint: when lines carry groups, every group's
 * most salient line is forced into the selection BEFORE the ordinary MMR
 * rounds (at least one line per group), so no contributing source can be
 * summarized away entirely — the property the R8 metamorphic relation
 * ("a merge must keep BOTH members' distinguishing keywords") leans on.
 *
 * Determinism: no randomness anywhere. Every ranking tie is broken by
 * salience DESC then original index ASC, and the returned lines keep
 * input order. Token budgets use approximateTokenCount accumulated line
 * by line; a near-duplicate of an already-selected line is so heavily
 * penalized by the (1−λ)·maxSim term that a finite budget drops it in
 * favor of any fresh content.
 *
 * Consumers:
 *  - memory-compressor's no-LLM distill fallback (sentence pool per
 *    cluster, group = member item id, salience = member importance ×
 *    position decay);
 *  - the stratifier consumes the SAME exported contract for its digest
 *    line selection (its own call sites, this shared kernel).
 */

import { invariant } from './invariants.js';
import { tokenize, approximateTokenCount } from './tokenizer.js';

/** One candidate line for extractive selection. */
export interface SalientLine {
  /** The line's text (already truncated/normalized by the caller). */
  text: string;
  /** Caller-computed importance of the line (higher = more salient). */
  salience: number;
  /**
   * Source identity (member/entry id) for the coverage constraint: every
   * distinct group contributes at least its most salient line. Lines
   * without a group participate only in the ordinary MMR rounds.
   */
  group?: string | number;
}

export interface ExtractiveSelectOptions {
  /** Hard token cap (approximateTokenCount) for the selected lines. */
  maxTokens: number;
  /**
   * MMR trade-off between salience and redundancy. Default 0.7. Higher
   * favors salient lines, lower favors diversity.
   */
  lambda?: number;
}

/** Token-set Jaccard similarity between two texts (0 when either is empty). */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Select a salient, non-redundant, budget-bounded subset of `lines`.
 *
 * Phase order:
 *   1. Coverage — for each distinct group (processed best-line-first),
 *      force-select the group's most salient line. These picks run before
 *      any MMR round and are not subject to the cap: like compactBlock's
 *      "never empty the block" floor, the per-group minimum outranks the
 *      budget when they conflict (a group silently vanishing from a
 *      summary is information loss no token budget justifies).
 *   2. MMR — repeatedly take the unselected line maximizing
 *      λ·salience − (1−λ)·max Jaccard to the selected set; a line that
 *      would overflow the remaining budget is set aside (not selected)
 *      and the next-best candidate is considered.
 *   3. Floor — if nothing at all was selected (e.g. every line is over an
 *      extremely small maxTokens), the single top-ranked line
 *      (salience DESC → index ASC) is returned so the selection is never
 *      empty for non-empty input.
 *
 * The result preserves the ORIGINAL input order of the selected lines.
 */
export function extractiveSelect(
  lines: SalientLine[],
  opts: ExtractiveSelectOptions,
): SalientLine[] {
  if (lines.length === 0) return [];
  const lambda = opts.lambda ?? 0.7;

  // Precompute token sets and per-line token budgets once.
  const tokenSets = lines.map((l) => new Set(tokenize(l.text)));
  const tokenCounts = lines.map((l) => approximateTokenCount(l.text));

  // Canonical deterministic rank: salience DESC, then input index ASC.
  const rank = (i: number, j: number): number => {
    const li = lines[i];
    const lj = lines[j];
    // rank is only ever called with indices produced by lines.map((_, i) => i).
    invariant(li !== undefined && lj !== undefined, 'rank(): indices must address lines');
    return lj.salience - li.salience || i - j;
  };
  const byRank = lines.map((_, i) => i).sort(rank);

  const selected = new Set<number>();
  let used = 0;

  // ---- Phase 1: coverage (per-group best lines, forced) -------------------
  const groupBest = new Map<string | number, number>();
  for (const i of byRank) {
    const line = lines[i];
    if (line === undefined) continue; // byRank carries valid indices only
    const g = line.group;
    if (g === undefined) continue;
    if (!groupBest.has(g)) groupBest.set(g, i); // first in rank order wins
  }
  // Process groups best-line-first so the strongest group's anchor takes
  // the budget before weaker groups' anchors (deterministic order).
  const anchors = [...groupBest.values()].sort(rank);
  for (const i of anchors) {
    selected.add(i);
    const c = tokenCounts[i];
    if (c !== undefined) used += c;
  }

  // ---- Phase 2: MMR rounds under the remaining budget ---------------------
  let pool = lines.map((_, i) => i).filter((i) => !selected.has(i));
  while (pool.length > 0) {
    // Best candidate by MMR; ties broken by the canonical rank.
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const i of pool) {
      const li = lines[i];
      const ti = tokenSets[i];
      if (li === undefined || ti === undefined) continue; // pool holds valid indices
      let maxSim = 0;
      for (const j of selected) {
        const tj = tokenSets[j];
        if (tj === undefined) continue;
        const sim = jaccard(ti, tj);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * li.salience - (1 - lambda) * maxSim;
      if (best === -1 || score > bestScore || (score === bestScore && rank(i, best) < 0)) {
        best = i;
        bestScore = score;
      }
    }
    const bestCount = tokenCounts[best];
    if (bestCount !== undefined && used + bestCount <= opts.maxTokens) {
      selected.add(best);
      used += bestCount;
    }
    // Selected or set aside as over-budget: either way it leaves the pool.
    pool = pool.filter((i) => i !== best);
  }

  // ---- Phase 3: never-empty floor ------------------------------------------
  if (selected.size === 0) {
    const first = byRank[0];
    if (first !== undefined) selected.add(first); // byRank mirrors lines, non-empty here
  }

  // Original input order for time-sequence readability.
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .filter((l): l is SalientLine => l !== undefined);
}
