/**
 * Contrast-based preference mining — the procedural-memory kernel.
 *
 * The procedural layer ("what does the user prefer?") has been dark since
 * v0.1: patterns were never written because extracting them needed an LLM
 * pass. This module is the deterministic replacement: it mines recurring
 * behavioral motifs from memory items with plain statistics, so a wiring
 * step can call it right after compression without any model in the loop.
 *
 * Two pattern families, both built from USER-voice items only
 * (`role === 'user'` or `role === undefined`):
 *
 *   1. Preference patterns (`prefers-<token>`): a token qualifies when it
 *      recurs in enough items (document frequency), on enough distinct
 *      days, AND — the contrast that separates deliberate habits from
 *      incidental vocabulary — in items whose mean importance is at least
 *      the corpus mean. A word the user keeps marking important is a
 *      preference; the same word drifting through low-value chatter is
 *      noise and is rejected.
 *
 *   2. Topic patterns (`topic:<a>+<b>`): among qualifying tokens, pairs
 *      that co-occur inside the same item at least `minSupport` times
 *      become topics, e.g. `topic:helm+kubernetes`.
 *
 * Everything is deterministic: no RNG, no clock reads beyond the injected
 * `now`, stable insertion-order iteration, and a final sort by confidence
 * descending then pattern name ascending. Output is capped at 50 patterns.
 */

import { invariant } from './invariants.js';
import { tokenize } from './tokenizer.js';
import { clamp01 } from './math.js';

/** One memory item offered to the miner. Importance is 0..1. */
export interface MinerItem {
  /** Free text of the memory item. Only user-role items are mined. */
  content: string;
  /** 0..1 salience assigned at ingest; powers the contrast gate. */
  importance: number;
  /** Conversation role; `undefined` is treated as user voice. */
  role?: 'user' | 'assistant' | 'tool' | 'system';
  /** Epoch-ms creation time; distinct days are derived from it. */
  createdAt: number;
  /** Stable item id; when absent, the input-array index (as string) is used. */
  id?: string;
}

/** A mined habit/topic, ready to be written into the procedural tier. */
export interface MinedPattern {
  /** Stable identifier, e.g. `prefers-typescript` or `topic:helm+kubernetes`. */
  pattern: string;
  /** Human-readable summary that cites the support behind it. */
  description: string;
  /** Ids (or index-as-string) of up to 5 supporting items, most important first. */
  evidence: string[];
  /** 0..1 confidence, per the formulas in the minePatterns JSDoc. */
  confidence: number;
  /** Mining timestamp (`opts.now ?? Date.now()`). */
  createdAt: number;
}

export interface MineOptions {
  /** Injected clock for deterministic output. Default `Date.now()`. */
  now?: number;
  /** Minimum document frequency (items containing the token). Default 3. */
  minSupport?: number;
  /** Minimum distinct days the token must appear on. Default 2. */
  minDistinctDays?: number;
}

const DAY_MS = 86_400_000;
const MAX_PATTERNS = 50;
const MAX_EVIDENCE = 5;

/**
 * Small inline stopword set. Tokens shorter than 3 characters are dropped
 * separately (the tokenizer already drops anything below 2), so this list
 * only needs function words of length >= 3 plus common conversational
 * fillers that would otherwise fake "preferences".
 */
const STOPWORDS = new Set([
  'about', 'after', 'all', 'also', 'and', 'any', 'are', 'because', 'been',
  'before', 'being', 'but', 'can', 'could', 'did', 'does', 'doing', 'each',
  'for', 'from', 'had', 'has', 'have', 'here', 'how', 'into', 'just',
  'like', 'more', 'most', 'much', 'not', 'now', 'off', 'once', 'only',
  'other', 'our', 'out', 'over', 'own', 'same', 'should', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'too', 'under', 'until', 'very',
  'was', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'will', 'with', 'would', 'you', 'your', 'yeah', 'okay',
  'get', 'got', 'let', 'please', 'thanks', 'thank', 'want', 'need',
  'make', 'made', 'use', 'used', 'using',
]);

/** Internal per-token accumulator. */
interface TokenStat {
  /** Document frequency: number of user items containing the token. */
  df: number;
  importanceSum: number;
  /** Distinct day numbers (createdAt / DAY_MS) the token appeared on. */
  days: Set<number>;
  /** Supporting items, for evidence extraction. */
  items: EvidenceRef[];
}

/** Internal per-pair (unordered, lexicographically keyed) accumulator. */
interface PairStat {
  a: string;
  b: string;
  /** Number of user items in which both tokens co-occur. */
  count: number;
  days: Set<number>;
  items: EvidenceRef[];
}

interface EvidenceRef {
  importance: number;
  evidenceId: string;
  /** Original input-array index; breaks importance ties deterministically. */
  index: number;
}

/** Up to 5 supporting item ids, most important first, ties by input order. */
function topEvidence(refs: EvidenceRef[]): string[] {
  return [...refs]
    .sort((x, y) => y.importance - x.importance || x.index - y.index)
    .slice(0, MAX_EVIDENCE)
    .map((r) => r.evidenceId);
}

/**
 * Mine preference and topic patterns from memory items.
 *
 * Only user-voice items (`role === 'user'` or `undefined`) are mined. A
 * token (lowercased word, length >= 3, not a stopword) QUALIFIES when all
 * three gates hold — the third is the contrast at the heart of this
 * module ("recurring in high-importance items = deliberate, not
 * incidental"):
 *
 *   1. documentFrequency >= minSupport (default 3)
 *   2. distinctDays     >= minDistinctDays (default 2)
 *   3. meanImportance(token's items) >= meanImportance(all user items)
 *
 * Preference pattern `prefers-<token>`, confidence (exact formula):
 *
 *   confidence = clamp01( 0.30
 *       + 0.15 * min(df - minSupport, 2)                  // repetition past the floor, cap 0.30
 *       + 0.20 * min(distinctDays - 1, 3)                 // day spread, cap 0.60
 *       + 0.20 * clamp01( (meanImportance - corpusMean)
 *                        / max(1 - corpusMean, 1e-9) ) )  // importance contrast, cap 0.20
 *
 * Topic pattern `topic:<a>+<b>` (a < b lexicographically) for each pair
 * of QUALIFYING tokens co-occurring in >= minSupport user items,
 * confidence (exact formula):
 *
 *   confidence = clamp01( 0.40
 *       + 0.20 * min(pairCount - minSupport, 2)           // co-occurrence past the floor, cap 0.40
 *       + 0.10 * min(pairDays - 1, 2) )                   // day spread, cap 0.20
 *
 * Results are sorted by confidence desc, then pattern name asc (ties
 * break deterministically), and capped at 50 patterns. Evidence lists at
 * most 5 supporting item ids (`item.id ?? String(index)`), most
 * important first.
 */
export function minePatterns(items: MinerItem[], opts: MineOptions = {}): MinedPattern[] {
  const now = opts.now ?? Date.now();
  const minSupport = opts.minSupport ?? 3;
  const minDistinctDays = opts.minDistinctDays ?? 2;

  // Mining only ever sees what the user actually said; keep original
  // indexes so evidence can fall back to index-as-string.
  const userItems: Array<{ item: MinerItem; index: number }> = [];
  for (const [index, item] of items.entries()) {
    if (item.role === undefined || item.role === 'user') {
      userItems.push({ item, index });
    }
  }
  if (userItems.length === 0) return [];

  // Corpus mean importance over the mined (user-voice) items — the
  // baseline the contrast gate compares against.
  let corpusImportanceSum = 0;
  for (const { item } of userItems) corpusImportanceSum += item.importance;
  const corpusMean = corpusImportanceSum / userItems.length;

  // Pass 1: per-token stats over user items (deduped per item so repeated
  // words inside one memory do not inflate document frequency).
  const stats = new Map<string, TokenStat>();
  for (const { item, index } of userItems) {
    const day = Math.floor(item.createdAt / DAY_MS);
    const evidenceId = item.id ?? String(index);
    const tokens = new Set(tokenize(item.content));
    for (const token of tokens) {
      if (token.length < 3 || STOPWORDS.has(token)) continue;
      let stat = stats.get(token);
      if (!stat) {
        stat = { df: 0, importanceSum: 0, days: new Set<number>(), items: [] };
        stats.set(token, stat);
      }
      stat.df += 1;
      stat.importanceSum += item.importance;
      stat.days.add(day);
      stat.items.push({ importance: item.importance, evidenceId, index });
    }
  }

  // Contrast gate: keep only tokens that clear all three thresholds.
  const qualified: Array<{
    token: string;
    df: number;
    days: number;
    meanImportance: number;
    items: EvidenceRef[];
  }> = [];
  for (const [token, stat] of stats) {
    if (stat.df < minSupport) continue;
    if (stat.days.size < minDistinctDays) continue;
    const meanImportance = stat.importanceSum / stat.df;
    if (meanImportance < corpusMean) continue; // incidental, not deliberate
    qualified.push({
      token,
      df: stat.df,
      days: stat.days.size,
      meanImportance,
      items: stat.items,
    });
  }

  const importanceSpan = Math.max(1 - corpusMean, 1e-9);
  const patterns: MinedPattern[] = [];

  // Family 1: preference patterns.
  for (const q of qualified) {
    const confidence = clamp01(
      0.3 +
        0.15 * Math.min(q.df - minSupport, 2) +
        0.2 * Math.min(q.days - 1, 3) +
        0.2 * clamp01((q.meanImportance - corpusMean) / importanceSpan),
    );
    patterns.push({
      pattern: `prefers-${q.token}`,
      description:
        `Mentions "${q.token}" in ${q.df} distinct high-importance memories ` +
        `across ${q.days} days (mean importance ${q.meanImportance.toFixed(2)} ` +
        `vs corpus ${corpusMean.toFixed(2)})`,
      evidence: topEvidence(q.items),
      confidence,
      createdAt: now,
    });
  }

  // Family 2: topic patterns from co-occurrence among qualifying tokens.
  const qualifiedTokens = new Set(qualified.map((q) => q.token));
  const pairs = new Map<string, PairStat>();
  for (const { item, index } of userItems) {
    const day = Math.floor(item.createdAt / DAY_MS);
    const evidenceId = item.id ?? String(index);
    // Sorted so pair keys are canonical (a < b) and iteration is stable.
    const present = [...new Set(tokenize(item.content))]
      .filter((t) => qualifiedTokens.has(t))
      .sort();
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const a = present[i];
        const b = present[j];
        // Both indices are bounded by present.length (loop guards).
        invariant(a !== undefined && b !== undefined, 'pair indices bounded by present.length');
        const key = `${a}+${b}`;
        let pair = pairs.get(key);
        if (!pair) {
          pair = { a, b, count: 0, days: new Set<number>(), items: [] };
          pairs.set(key, pair);
        }
        pair.count += 1;
        pair.days.add(day);
        pair.items.push({ importance: item.importance, evidenceId, index });
      }
    }
  }
  for (const pair of pairs.values()) {
    if (pair.count < minSupport) continue;
    const confidence = clamp01(
      0.4 + 0.2 * Math.min(pair.count - minSupport, 2) + 0.1 * Math.min(pair.days.size - 1, 2),
    );
    patterns.push({
      pattern: `topic:${pair.a}+${pair.b}`,
      description:
        `"${pair.a}" and "${pair.b}" recur together in ${pair.count} memories ` +
        `across ${pair.days.size} days`,
      evidence: topEvidence(pair.items),
      confidence,
      createdAt: now,
    });
  }

  // Deterministic total order: confidence desc, then name asc; capped.
  patterns.sort((x, y) => y.confidence - x.confidence || (x.pattern < y.pattern ? -1 : 1));
  return patterns.slice(0, MAX_PATTERNS);
}
