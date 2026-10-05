/**
 * Consensus & contradiction detection over retrieved memories.
 *
 * Single-source memories are the weakest form of knowledge. When several
 * retrieved items corroborate each other, the answer deserves higher
 * confidence; when they disagree, the caller must know BEFORE repeating
 * a stale fact. This module clusters retrieval hits and grades each
 * cluster:
 *
 *   - corroboration: items mutually similar (embedding cosine, or token
 *     Jaccard when embeddings are absent) merge into one cluster; the
 *     more independent-ish members, the higher `agreement`.
 *   - contradiction: within a cluster, numeric signatures that diverge
 *     ("PostgreSQL 15" vs "…16…") or negation-polarity flips ("we use
 *     X" vs "we don't use X") mark the cluster conflicted with a reason.
 *     Numeric signatures are unit-aware: dates and versions are extracted
 *     as atomic units (never shattered into digit fragments), and Chinese
 *     negation ignores false-negative bigrams like 不错/不断 (affirmative
 *     idioms that merely contain 不).
 *
 * Heuristic by design (no LLM): it trades nuance for determinism and
 * zero latency. All functions are pure.
 */

import { cosine } from './embedding.js';
import { tokenize } from './tokenizer.js';

export interface ConsensusInput {
  id: string;
  content: string;
  embedding?: Float32Array;
  score: number; // retrieval score, used for ordering
  createdAt?: number;
}

export interface ConsensusCluster<T extends ConsensusInput> {
  members: T[];
  /** 0..1 — how well the cluster corroborates itself. */
  agreement: number;
  /** True when members assert incompatible specifics. */
  conflict: boolean;
  /** Human-readable contradiction reason when conflict is true. */
  conflictReason?: string;
  /** Highest-scored member — the cluster's representative. */
  representative: T;
}

export interface ConsensusOptions {
  /** Cosine/Jaccard needed to merge into the same cluster. Default 0.82. */
  similarityThreshold?: number;
}

/** Cluster hits greedily by mutual similarity, best-scored seeds first. */
export function clusterByConsensus<T extends ConsensusInput>(
  items: T[],
  opts: ConsensusOptions = {},
): ConsensusCluster<T>[] {
  const threshold = opts.similarityThreshold ?? 0.82;
  const ordered = [...items].sort((a, b) => b.score - a.score);
  const clusters: Array<{ seed: T; members: T[]; sims: number[] }> = [];

  for (const item of ordered) {
    let bestIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < clusters.length; i++) {
      const sim = similarity(item, clusters[i].seed);
      if (sim >= threshold && sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      clusters[bestIdx].members.push(item);
      clusters[bestIdx].sims.push(bestSim);
    } else {
      clusters.push({ seed: item, members: [item], sims: [] });
    }
  }

  return clusters.map((c) => {
    const avgSim = c.sims.length
      ? c.sims.reduce((s, x) => s + x, 0) / c.sims.length
      : 0;
    // agreement grows with corroboration count and internal similarity,
    // capped at 1.
    const agreement = Math.min(
      1,
      (0.35 + 0.25 * (c.members.length - 1)) * (0.6 + 0.4 * avgSim),
    );
    const rep = c.members[0]; // ordered by score desc
    let conflict = false;
    let conflictReason: string | undefined;
    for (const other of c.members.slice(1)) {
      const det = detectConflict(rep, other);
      if (det.conflict) {
        conflict = true;
        conflictReason = det.reason;
        break;
      }
    }
    return { members: c.members, agreement, conflict, conflictReason, representative: rep };
  });
}

/** Pairwise contradiction test between two similar statements. */
export function detectConflict(
  a: ConsensusInput,
  b: ConsensusInput,
): { conflict: boolean; reason?: string } {
  const na = numericSignature(a.content);
  const nb = numericSignature(b.content);
  if (na.length > 0 && nb.length > 0 && na.every((x) => !nb.includes(x))) {
    return {
      conflict: true,
      reason: `differing values (${na.join(', ')} vs ${nb.join(', ')})`,
    };
  }
  const pa = negationPolarity(a.content);
  const pb = negationPolarity(b.content);
  if (pa !== pb && sharedSubjectTokens(a.content, b.content) >= 3) {
    return { conflict: true, reason: 'affirmative vs negated statements' };
  }
  return { conflict: false };
}

/** Similarity: embedding cosine when both exist, else token Jaccard. */
export function similarity(a: ConsensusInput, b: ConsensusInput): number {
  if (a.embedding && b.embedding) {
    return cosine(a.embedding, b.embedding);
  }
  const ta = new Set(tokenize(a.content));
  const tb = new Set(tokenize(b.content));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Unit-aware numeric signature extraction.
 *
 * Naive `\d+(\.\d+)?` matching shatters dates: "deployed on 2024-01-15"
 * yields ['2024', '01', '15'], so the disjointness test in `detectConflict`
 * compared digit fragments instead of the DATE as a whole — two statements
 * about different dates could pass as corroborating (shared '2024'), and
 * unrelated digit fragments could collide into false conflicts. Extraction
 * therefore runs in three passes, each consuming its matches (replacing the
 * matched span with spaces) before the next pass sees the text:
 *
 *   1. dates — ISO date/datetime (`2024-01-15`, `2024-1-5`, optionally with
 *      a `T`/space time part) and slash dates (`1/5/24`, `01/05/2024`),
 *      recorded as ONE atomic entry per date, normalized by zero-padding
 *      month/day (so `2024-1-5` == `2024-01-05`);
 *   2. versions — `v1.2`, `1.2.3` style tokens as atomic entries (leading
 *      `v` stripped so `v1.2.3` == `1.2.3`);
 *   3. plain integers/decimals from whatever text remains.
 */

/** ISO date or datetime: `2024-01-15`, `2024-1-5`, `2024-01-15T09:30:00`. */
const ISO_DATE_RE = /\d{4}-\d{1,2}-\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2})?)?/g;
/** Slash date: `1/5/24`, `01/05/2024` (month/day/year). */
const SLASH_DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
/** Version-ish token: `v1.2`, `1.2.3`, `16.4`. */
const VERSION_RE = /\bv?\d+\.\d+(\.\d+)?\b/g;
/** Plain integer/decimal on the remaining (date/version-stripped) text. */
const NUM_RE = /\d+(?:\.\d+)?/g;

export interface NumericSignatureUnits {
  /** Atomic date entries (normalized: zero-padded month/day). */
  dates: string[];
  /** Atomic version entries (leading `v` stripped). */
  versions: string[];
  /** Remaining plain integers/decimals. */
  numbers: string[];
}

const pad2 = (s: string): string => s.padStart(2, '0');

/** `2024-1-5 9:30` → `2024-01-05T09:30`; separator canonicalized to `T`. */
function normalizeIsoDate(m: string): string {
  const g =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:([T ])(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
      .exec(m);
  if (!g) return m;
  const [, y, mo, d, , h, mi, s] = g;
  let out = `${y}-${pad2(mo)}-${pad2(d)}`;
  if (h !== undefined) {
    out += `T${pad2(h)}:${mi}${s !== undefined ? `:${s}` : ''}`;
  }
  return out;
}

/** `1/5/24` → `01/05/24` (year kept as written; only month/day padded). */
function normalizeSlashDate(m: string): string {
  const g = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(m);
  if (!g) return m;
  return `${pad2(g[1])}/${pad2(g[2])}/${g[3]}`;
}

/**
 * Extract dates, versions and plain numbers as separate unit lists.
 * Consumed spans are blanked (same-length spaces) before the next pass, so
 * a date's digits can never reappear as plain numbers.
 */
export function signaturesOf(content: string): NumericSignatureUnits {
  const dates: string[] = [];
  const versions: string[] = [];
  const numbers: string[] = [];

  const masked = content
    .replace(ISO_DATE_RE, (m) => {
      dates.push(normalizeIsoDate(m));
      return ' '.repeat(m.length);
    })
    .replace(SLASH_DATE_RE, (m) => {
      dates.push(normalizeSlashDate(m));
      return ' '.repeat(m.length);
    })
    .replace(VERSION_RE, (m) => {
      versions.push(m.replace(/^v/, ''));
      return ' '.repeat(m.length);
    });

  const rest = masked.match(NUM_RE);
  if (rest) for (const n of rest) numbers.push(n);

  return {
    dates: [...new Set(dates)],
    versions: [...new Set(versions)],
    numbers: [...new Set(numbers)],
  };
}

/** Distinct unit-aware numeric entries — the "specifics" of a statement. */
export function numericSignature(content: string): string[] {
  const { dates, versions, numbers } = signaturesOf(content);
  return [...new Set([...dates, ...versions, ...numbers])];
}

const EN_NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'cannot', "don't", 'dont', "doesn't",
  'doesnt', "isn't", 'isnt', "won't", 'wont', 'without', 'avoid',
]);

/**
 * Two-char Chinese idioms that CONTAIN 不 (or similar) but are affirmative:
 * 不错 (fine), 不仅 (not only — paired with 而且, net affirmative), 不断
 * (continuously), 不过 (however), 不胜 (extremely), 不妨 (might as well),
 * 不日 (soon). Counting their 不 as negation flips polarity on praise.
 */
const CN_AFFIRMATIVE_BIGRAMS = new Set([
  '不错', '不仅', '不断', '不过', '不胜', '不妨', '不日',
]);

/** Two-char sequences that genuinely negate. */
const CN_NEGATION_BIGRAMS = new Set([
  '没有', '不会', '不能', '不要', '不用', '无需', '并非', '从未', '别再', '非也',
]);

/**
 * Count Chinese negation occurrences with false-positive idioms skipped.
 *
 * Left-to-right scan: at each position, if an affirmative idiom starts
 * there, consume its 2 chars (no count); if a negation bigram starts there,
 * count 1 and consume its 2 chars. Afterwards, standalone particles 不/别/无
 * are counted only where they were NOT consumed by either bigram class.
 */
export function cnNegationCount(content: string): number {
  let count = 0;
  const consumed = new Array<boolean>(content.length).fill(false);
  for (let i = 0; i < content.length - 1; ) {
    const bigram = content.slice(i, i + 2);
    if (CN_AFFIRMATIVE_BIGRAMS.has(bigram)) {
      consumed[i] = true;
      consumed[i + 1] = true;
      i += 2;
    } else if (CN_NEGATION_BIGRAMS.has(bigram)) {
      count++;
      consumed[i] = true;
      consumed[i + 1] = true;
      i += 2;
    } else {
      i++;
    }
  }
  for (let i = 0; i < content.length; i++) {
    if (consumed[i]) continue;
    const ch = content[i];
    if (ch === '不' || ch === '别' || ch === '无') count++;
  }
  return count;
}

/** Even = affirmative, odd = negated (double negation cancels). */
export function negationPolarity(content: string): number {
  let count = 0;
  for (const tok of tokenize(content)) {
    if (EN_NEGATIONS.has(tok)) count++;
  }
  count += cnNegationCount(content);
  return count % 2;
}

/** How many content tokens two statements share (subject overlap proxy). */
export function sharedSubjectTokens(a: string, b: string): number {
  const tb = new Set(tokenize(b));
  let shared = 0;
  for (const t of new Set(tokenize(a))) {
    if (tb.has(t)) shared++;
  }
  return shared;
}
