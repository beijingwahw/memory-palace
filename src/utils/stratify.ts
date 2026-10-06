/**
 * Stratification kernel — hippocampus → neocortex, pure and deterministic.
 *
 * The palace's episodic log is the hippocampus: vivid, sequential,
 * expensive. This kernel folds it into neocortical structure — session →
 * week → month → era summary nodes — each a compact, line-oriented digest
 * built by EXTRACTIVE SELECTION at tree scale: every item contributes a
 * candidate line (its first line, code-point-safe) with a computed
 * SALIENCE, and the summarize kernel's extractiveSelect picks which lines
 * earn digest space (salience-ranked, redundancy-aware) BEFORE the
 * core-memory compaction kernel (dedupe, final cap) runs as a second
 * layer. Stacking first lines and letting eviction sort it out compresses
 * by luck; extracting by salience compresses by meaning.
 *
 * Every node is bounded (token cap per level), so a decade-old palace
 * still answers "what was the Q2 era about" from a CONSTANT-size digest.
 * Children are linked upward; the tree is rebuildable from the log at any
 * time (summaries are caches, the episodic stream remains ground truth).
 */

import { compactBlock, type CompactResult } from './core-memory.js';
import { tokenize, approximateTokenCount } from './tokenizer.js';
import { extractiveSelect } from './summarize.js';

export type TreeLevel = 'session' | 'week' | 'month' | 'era';

/**
 * Roll-up ladder with per-level periods and token caps.
 *
 * Honest simplifications, both intentional: `bucketStart` floors to the
 * unix-epoch grid (1970-01-01, a Thursday), so "week" buckets start on
 * Thursdays, not Mondays; and month = 30d is not an integer multiple of
 * week = 7d, so week-bucket boundaries drift across month-bucket boundaries
 * instead of nesting. Calendar precision is not the contract — stable,
 * deterministic, rebuildable buckets are.
 */
export const LEVEL_SPEC: Record<TreeLevel, { periodMs: number; tokenCap: number }> = {
  session: { periodMs: 86_400_000, tokenCap: 120 },
  week: { periodMs: 7 * 86_400_000, tokenCap: 100 },
  month: { periodMs: 30 * 86_400_000, tokenCap: 90 },
  era: { periodMs: 90 * 86_400_000, tokenCap: 80 },
};

/** The roll-up order (each level feeds the next). */
export const LEVEL_ORDER: readonly TreeLevel[] = ['session', 'week', 'month', 'era'];

/**
 * Token reserve subtracted from a level's cap before selection: room for
 * the `[level] ` prefix and join formatting, so the FINAL tokenCount
 * (prefix included) respects the cap.
 */
const PREFIX_RESERVE = 8;

/**
 * Importance a digest node carries when it feeds the next level's
 * roll-up — mirrors the digest tier's semantic-item importance (0.7) the
 * Stratifier stamps on summary items, so the tree's own idea of a digest's
 * worth matches what retrieval sees.
 */
const DIGEST_IMPORTANCE = 0.7;

/**
 * Graph-free salience ladder, borrowed from compactBlock's lineScore
 * keyword set: a line naming a goal/deadline/decision/risk is substance,
 * not filler. Mirrors the regex in utils/core-memory (kept local — the
 * kernel must not depend on the graph for its base scoring).
 */
const SALIENT_KEYWORD_RE = /\b(goal|deadline|owner|decision|blocked|risk|p0|p1)\b/i;

export interface StratifyInput {
  id: string;
  content: string;
  createdAt: number;
  /** Salience seed (0..1) — the Stratifier passes the item's importance. */
  importance: number;
}

export interface TreeNodeDraft {
  level: TreeLevel;
  /** Bucket start (unix ms, aligned to the level's period grid). */
  periodStart: number;
  periodEnd: number;
  content: string;
  tokenCount: number;
  childIds: string[];
}

/** Align a timestamp down to its period bucket start. */
export function bucketStart(ts: number, level: TreeLevel): number {
  const p = LEVEL_SPEC[level].periodMs;
  return Math.floor(ts / p) * p;
}

/** Extractive-selection candidate (utils/summarize contract shape). */
interface SelectCandidate {
  text: string;
  salience: number;
}

/**
 * Salience of one candidate line: importance × (0.8 + 0.2 × normalized
 * freshness within its bucket) + 0.15 if the line names a currently-hot
 * entity + 0.1 if it hits the graph-free keyword ladder. Importance
 * dominates (freshness only swings ±10%); entity/keyword hits are flat
 * boosts an ordinary line cannot outvote.
 */
function lineSalience(
  line: string,
  importance: number,
  freshness: number,
  hotEntities?: ReadonlySet<string>,
): number {
  let salience = importance * (0.8 + 0.2 * freshness);
  if (hotEntities && hotEntities.size > 0) {
    const tokenSet = new Set(tokenize(line));
    for (const e of hotEntities) {
      if (tokenSet.has(e.toLowerCase())) {
        salience += 0.15;
        break;
      }
    }
  }
  if (SALIENT_KEYWORD_RE.test(line)) salience += 0.1;
  return salience;
}

/**
 * Build one level's nodes from inputs: bucket by period, then extractively
 * select each bucket's most salient lines into a bounded digest.
 */
export function stratifyLevel(
  inputs: StratifyInput[],
  level: TreeLevel,
  hotEntities?: ReadonlySet<string>,
): TreeNodeDraft[] {
  const { periodMs, tokenCap } = LEVEL_SPEC[level];
  const byBucket = new Map<number, StratifyInput[]>();
  for (const inp of inputs) {
    const start = bucketStart(inp.createdAt, level);
    const arr = byBucket.get(start) ?? [];
    arr.push(inp);
    byBucket.set(start, arr);
  }
  const bodyBudget = Math.max(16, tokenCap - PREFIX_RESERVE);
  const out: TreeNodeDraft[] = [];
  for (const [start, items] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    // Reduce, never spread: a wide bucket would blow the argument stack
    // (audit check 7 guards this exact class).
    const oldest = items.reduce((m, i) => Math.min(m, i.createdAt), Number.POSITIVE_INFINITY);
    const newest = items.reduce((m, i) => Math.max(m, i.createdAt), Number.NEGATIVE_INFINITY);

    const candidates: SelectCandidate[] = [];
    for (const item of items) {
      const line = firstLine(item.content);
      if (!line) continue;
      const freshness = newest > oldest ? (item.createdAt - oldest) / (newest - oldest) : 1;
      candidates.push({
        text: line,
        salience: lineSalience(line, item.importance, freshness, hotEntities),
      });
    }
    if (candidates.length === 0) continue;

    // Layer 1 — extractive selection: salience-ranked, redundancy-aware
    // (lambda 0.7), token-budgeted to cap − reserve. NO `group` is passed:
    // the kernel's group semantic is forced per-group coverage (every
    // group's best line enters uncapped), and each item contributes
    // exactly ONE candidate — grouping by item id would degenerate
    // coverage into keep-all and hand the whole job back to compactBlock's
    // eviction, the exact behavior this upgrade replaces. Ungrouped lines
    // ride the ordinary MMR rounds (kernel contract), whose first pick is
    // always the highest-salience line; the kernel also guarantees a
    // never-empty floor and returns survivors in input (time) order.
    const chosen = extractiveSelect(candidates, { maxTokens: bodyBudget, lambda: 0.7 });

    // Layer 2 — compactBlock over the time-ordered survivors: Jaccard
    // dedupe (cross-item near-duplicates) and the final cap. Double
    // insurance: selection picks which lines deserve space; compaction
    // guarantees the digest stays deduped and bounded.
    const body = chosen.map((c) => c.text).join('\n');
    // hotEntities is spread in (not passed as `hotEntities`, which may be
    // undefined) because exactOptionalPropertyTypes forbids assigning
    // explicit undefined to an optional field.
    const result: CompactResult = compactBlock(body, {
      maxTokens: bodyBudget,
      ...(hotEntities !== undefined ? { hotEntities } : {}),
    });
    if (!result.content) continue;
    const content = `[${level}] ${result.content}`;
    out.push({
      level,
      periodStart: start,
      periodEnd: start + periodMs,
      content,
      tokenCount: approximateTokenCount(content),
      childIds: items.map((i) => i.id),
    });
  }
  return out;
}

/**
 * Full roll-up: sessions from raw inputs, then each higher level from the
 * PREVIOUS level's node drafts (their digests, not the raw stream) — the
 * tree compresses as it rises, exactly like cortical consolidation.
 */
export function buildTree(
  inputs: StratifyInput[],
  hotEntities?: ReadonlySet<string>,
): Map<TreeLevel, TreeNodeDraft[]> {
  const tree = new Map<TreeLevel, TreeNodeDraft[]>();
  let current: StratifyInput[] = inputs;
  for (const level of LEVEL_ORDER) {
    const drafts = stratifyLevel(current, level, hotEntities);
    tree.set(level, drafts);
    // Feed the next level with this level's summaries.
    current = drafts.map((d) => ({
      id: `node:${level}:${d.periodStart}`,
      content: d.content,
      createdAt: d.periodStart,
      importance: DIGEST_IMPORTANCE,
    }));
  }
  return tree;
}

function firstLine(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  // Code-point truncation: slice(0, 160) on UTF-16 units can cut through
  // a surrogate pair and leave an isolated half — invalid text that then
  // flows into digests, hashes and the tokenizer.
  return line.length <= 160 ? line : Array.from(line).slice(0, 160).join('');
}
