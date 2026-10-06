/**
 * Core-memory compaction kernel — pure, deterministic, zero-LLM.
 *
 * A core block is the palace's SELF: a tiny, line-oriented, hard-capped
 * note (profile / project / goals). Unlike archival memory it is REWRITTEN,
 * not appended to. When a block overflows its token cap the kernel keeps
 * the most valuable lines: deduplicated (token-Jaccard), scored (entity
 * salience, structure, brevity), evicted lowest-first, original order
 * preserved for the survivors.
 */

import { invariant } from './invariants.js';
import { tokenize, approximateTokenCount } from './tokenizer.js';

export interface CompactOptions {
  /** Hard token cap for the block. */
  maxTokens: number;
  /** Entity names currently hot (high PageRank) — lines naming them score higher. */
  hotEntities?: ReadonlySet<string>;
  /** Token-Jaccard at which two lines are duplicates. Default 0.6. */
  dedupeThreshold?: number;
  /**
   * Index at which the "new" lines begin (mergeIntoBlock passes the old
   * line count). Only used as a dedupe-authority tie-break: on equal
   * scores a NEW line outranks an old one, so additions survive merges
   * (freshness wins). Defaults to 0 (every line "new" → plain index
   * tie-break, i.e. legacy compactBlock behavior).
   */
  newFrom?: number;
}

export interface CompactResult {
  content: string;
  /** Surviving line count. */
  kept: number;
  /** Lines evicted (over-cap lowest scorers) or merged as duplicates. */
  removed: number;
  /** Previews of evicted lines (bounded), for dream reports / audit. */
  removedPreviews: string[];
}

/** Split a block into logical lines (bullet or single-line units). */
export function splitLines(content: string): string[] {
  return content
    .split(/\n+/)
    .map((l) => l.trim().replace(/^[-*•]\s*/, ''))
    .filter((l) => l.length > 0);
}

/** Line value: entity salience + structure + brevity. Deterministic. */
export function lineScore(line: string, hotEntities?: ReadonlySet<string>): number {
  let score = 1;
  const tokens = tokenize(line);
  const tokenSet = new Set(tokens);
  if (hotEntities) {
    for (const e of hotEntities) {
      if (tokenSet.has(e.toLowerCase())) score += 0.5;
    }
  }
  if (/^#{1,3}\s/.test(line)) score += 0.4; // structural headers anchor blocks
  if (/^\[[^\]]+\]/.test(line)) score += 0.2; // tagged lines ([scope] …)
  if (/\b(goal|deadline|owner|decision|blocked|risk|p0|p1)\b/i.test(line)) score += 0.4;
  const len = approximateTokenCount(line);
  score += Math.max(0, 1 - len / 40); // brevity bonus, decaying by line length
  return score;
}

/** Token-set Jaccard between two lines. */
export function lineSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Deduplicate + cap a block's lines. Duplicates merge into the
 * higher-scored survivor; over-cap lines are evicted lowest-score-first;
 * survivors keep their original relative order.
 */
export function compactBlock(content: string, opts: CompactOptions): CompactResult {
  const cap = Math.max(16, opts.maxTokens);
  const threshold = opts.dedupeThreshold ?? 0.6;
  const lines = splitLines(content);
  if (lines.length === 0) {
    return { content: '', kept: 0, removed: 0, removedPreviews: [] };
  }

  // Score once, then greedily keep unique lines in original order,
  // dropping near-duplicates of already-kept lines.
  const scores = lines.map((l) => lineScore(l, opts.hotEntities));
  let removed = 0;
  const removedPreviews: string[] = [];
  // Index-backed accessors: every index below is born from `lines`' own
  // domain (map indices, kept-set members, splice results), so a miss is
  // impossible by construction — asserted, never assumed with `!`.
  const scoreAt = (i: number): number => {
    const s = scores[i];
    invariant(s !== undefined, 'score index born from lines.map');
    return s;
  };
  const lineAt = (i: number): string => {
    const l = lines[i];
    invariant(l !== undefined, 'line index born from splitLines output');
    return l;
  };

  // Order candidates best-first for dedupe authority, but track kept order.
  // Tie-break ladder: score DESC → new lines first (index >= newFrom rank
  // ahead, so additions beat equal-scoring old lines — freshness wins) →
  // index ASC.
  const newFrom = opts.newFrom ?? 0;
  const order = lines
    .map((_, i) => i)
    .sort(
      (a, b) =>
        scoreAt(b) - scoreAt(a) ||
        Number(b >= newFrom) - Number(a >= newFrom) ||
        a - b,
    );
  const keptSet = new Set<number>();
  for (const i of order) {
    if (keptSet.has(i)) continue;
    let duplicate = false;
    for (const j of keptSet) {
      if (lineSimilarity(lineAt(i), lineAt(j)) >= threshold) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      removed++;
      continue;
    }
    keptSet.add(i);
  }

  // Now walk original order, token-budgeting; over-cap → evict the
  // lowest-scored lines among the kept set until it fits.
  const idx = [...keptSet].sort((a, b) => a - b);
  const tokensOf = (arr: number[]) =>
    arr.reduce((s, i) => s + approximateTokenCount(lineAt(i)) + 1, 0);
  while (idx.length > 1 && tokensOf(idx) > cap) {
    // evict the single lowest-scoring line (stable tie-break: later line)
    let worst = 0;
    for (let k = 1; k < idx.length; k++) {
      const ki = idx[k];
      const wi = idx[worst];
      invariant(ki !== undefined && wi !== undefined, 'eviction scan stays inside idx');
      if (scoreAt(ki) < scoreAt(wi) || (scoreAt(ki) === scoreAt(wi) && ki > wi)) worst = k;
    }
    const evicted = idx.splice(worst, 1)[0];
    invariant(evicted !== undefined, 'splice(…, 1) removes exactly one');
    removed++;
    // The preview list is bounded for REPORTING only — once full we stop
    // recording previews but NEVER stop evicting. The cap is best-effort:
    // eviction halts at one line (loop guard `idx.length > 1`), so a single
    // oversized line is never dropped entirely — the block always keeps
    // at least one line rather than being emptied to satisfy the cap.
    if (removedPreviews.length < 8) {
      removedPreviews.push(lineAt(evicted).slice(0, 80));
    }
  }

  const keptLines = idx.map((i) => lineAt(i));
  return {
    content: keptLines.join('\n'),
    kept: keptLines.length,
    removed,
    removedPreviews,
  };
}

/**
 * Merge new lines into a block and compact: additions survive duplicates
 * on score ties (freshness wins), then the whole block is capped.
 */
export function mergeIntoBlock(
  existing: string,
  additions: Array<string>,
  opts: CompactOptions,
): CompactResult {
  const existingLines = splitLines(existing);
  const additionLines = additions.map((a) => a.trim()).filter(Boolean);
  const merged = [...existingLines, ...additionLines].join('\n');
  // newFrom marks where the additions begin, making the dedupe-authority
  // tie-break favor them — "additions survive duplicates on score ties".
  return compactBlock(merged, { ...opts, newFrom: existingLines.length });
}
