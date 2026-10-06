/**
 * MemoryCompressor — keeps the long-term store lean and high-signal.
 *
 * Two compression strategies:
 *
 *  A. Importance-aware eviction: drop low-importance, old, never-accessed
 *     items. Cheap, deterministic, no LLM call required.
 *
 *  B. Semantic distillation: cluster related SEMANTIC items by cosine
 *     similarity and merge each cluster into a single higher-importance
 *     semantic item — optionally through an LLM `summarize` callback;
 *     without one each cluster is reduced by classical extractive
 *     summarization (MMR selection over the members' sentences, with a
 *     per-member coverage floor — see extractiveFallbackClusterText).
 *     Distillation runs over the semantic layer
 *     because that is where candidate chunks accumulate; episodic rows
 *     stay as an append-only log and age out via eviction.
 *
 * Clustering is partitioned and bucketed before any cosine is computed:
 *
 *  - Space + owner partitioning: cosine similarity is only meaningful
 *    within one embedding space (deepseek vectors vs offline-bm25 hashed
 *    vectors are incomparable even at equal width), and distillation must
 *    never merge one owner's memories into another's item. Candidates are
 *    therefore drawn exclusively from the same (embeddingSpace, owner)
 *    partition, where the distill owner = the NUL-separated (userId,
 *    workspaceId, sessionId) triple — deliberately WITHOUT the visibility
 *    tier, so near-duplicates stamped at different tiers still
 *    consolidate (into the narrowest tier, next bullet). Pattern-mining
 *    groups keep the tier-inclusive variant of the key — see
 *    partitionOwnerKey vs patternIdOwner below for why grouping and
 *    persisted pattern ids use different separators.
 *
 *  - Tier inheritance (I-ACL-10): a merged item inherits the NARROWEST
 *    member's visibility tier, plus that member's owner scope and
 *    entityId (TIER_ORDER rank, first-encountered wins ties — see
 *    narrowestOwnerOf). A cluster containing any private row merges AT
 *    that row's tier: compression may narrow visibility — a public
 *    duplicate is folded into the private row's tier — but never widens
 *    it. The historical plurality vote did widen it: a 4×'global' +
 *    3×'user' cluster of one owner merged as 'global'.
 *
 *  - Anchor-projection bucketing (LSH-lite): each item projects its
 *    embedding onto k=4 deterministic pseudo-random anchor directions
 *    (weights from hash32(`${j}:${i}`) mapped to [-1, 1]); the quantized
 *    sign pattern ("+-++") is its bucket key. A seed only compares against
 *    candidates in buckets whose key equals its own or differs in exactly
 *    one position (Hamming distance <= 1), bounding the neighbor search to
 *    O(n · bucketSize) instead of O(n²). The cosine >= threshold gate
 *    remains the final arbiter of actual similarity.
 *
 * Compression is triggered when item counts exceed a threshold (count-based)
 * or when items grow older than half-life × N (age-based).
 *
 * ## Two-phase distillation ("plan then commit")
 *
 * distill obeys the same discipline as the ingestor: phase 1 (outside any
 * transaction, network awaits allowed) partitions/buckets/clusters the
 * candidates, awaits every cluster's merged text (LLM summarize or the
 * zero-LLM extractive fallback) and performs ONE batched embedBatchTagged per (space,
 * owner) partition; phase 2 commits ALL merges — every insertItem(merged)
 * plus every deleteItem(member) — inside ONE store.ingestTx. A crash
 * mid-pass rolls the whole batch back, so a merged item can never coexist
 * with its un-merged originals (no partial-consolidation middle state).
 *
 * `runOnce` runs lifecycle hygiene — TTL expiry sweep, episodic event-log
 * pruning, tombstone GC, pattern mining — on EVERY pass (a low-activity
 * store still needs its logs and tombstones cleaned); only eviction and
 * distillation are gated by shouldRun. Hygiene counts are reported as
 * expiredSwept / eventsPruned / tombstonesPurged / patternsMined.
 *
 * The report's `savedTokens` is computed honestly: from the token count of
 * the ACTUAL merged text versus the sum of its parts (previously the
 * merged item's token count was set to that sum, making savedTokens
 * identically zero), and clamped at zero per cluster and in total so an
 * expanding summary can never report negative savings.
 */

import { randomUUID } from 'node:crypto';
import type { EmbeddingGateway, TaggedEmbedding } from '../utils/embedding.js';
import { cosine } from '../utils/embedding.js';
import { anchorKey as anchorBucketKey, neighborKeys as neighborBucketKeys } from '../utils/anchors.js';
import { invariant } from '../utils/invariants.js';
import { approximateTokenCount } from '../utils/tokenizer.js';
import { extractiveSelect, type SalientLine } from '../utils/summarize.js';
import { minePatterns } from '../utils/pattern-miner.js';
import { TIER_ORDER } from '../utils/scope.js';
import type { VisibilityTier } from '../utils/scope.js';
import { NOOP_BUS, type MemoryEventBus, type CompressionReport, type MemoryItem } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';

export interface CompressionConfig {
  enabled: boolean;
  triggerCount: number;
  importanceThreshold: number;
  decayHalfLifeDays: number;
  /** Cosine similarity required to merge two items into one cluster.
   *  Default 0.78. */
  clusterSimilarityThreshold?: number;
  /** Max semantic candidates considered per distill pass. Default 1000. */
  candidateLimit?: number;
  /** Items accessed at least this many times are protected from merging
   *  (hot memories stay intact). Default 3. */
  hotProtectAccessCount?: number;
}

export interface DistillOptions {
  /** Max clusters to form during semantic distillation. */
  maxClusters?: number;
  /** Max items per cluster to merge. */
  maxPerCluster?: number;
  /** Optional callback to summarize a cluster with an LLM. */
  summarize?: (clusterTexts: string[]) => Promise<string>;
  /**
   * Honest trigger label for the report. Callers that already know WHY
   * they are running (runOnce: count/age from its own gate, or 'manual'
   * for a forced sleep) pass it in; when omitted, distill re-derives it
   * from the same triggerReason() check (falling back to 'count'), which
   * is what a bare distill() call used to report.
   */
  trigger?: 'count' | 'age' | 'manual';
}

/**
 * Historical name kept for existing import paths (sleep cycle, services
 * barrel); the lifecycle-hygiene fields (expiredSwept / eventsPruned /
 * tombstonesPurged / patternsMined) have lived in the base
 * CompressionReport in types/index.ts since 0.20, so this is a pure alias.
 * The former local intersection re-declared all four same-named fields and
 * could silently drift from the base type.
 */
export type CompressionReportWithRetention = CompressionReport;

/**
 * Owner identity for clustering AND pattern mining: items are only ever
 * merged (or mined together) when their owner keys match, so one user's
 * memories can never surface inside another user's (or session's)
 * distilled item or mined preference.
 */
export interface OwnerScopeDescriptor {
  visibility: VisibilityTier;
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
}

/**
 * The owner scope of one item — the single source of the owner key.
 * Top-level backfill (populated by rowToItem from the row's ACTUAL owner
 * columns) wins; the metadata copy is a legacy fallback. Reading metadata
 * first was the root cause of cross-owner merges producing "invisible"
 * rows: a member whose metadata.scope fields were stale/missing but whose
 * owner COLUMNS were correct would key into the wrong partition, and the
 * merged row then inherited the wrong owner metadata.
 */
function ownerScopeOf(item: MemoryItem): OwnerScopeDescriptor {
  const userId = item.userId ?? item.metadata.userId;
  const workspaceId = item.workspaceId ?? item.metadata.workspaceId;
  const sessionId = item.sessionId ?? item.metadata.sessionId;
  return {
    visibility:
      item.visibility ??
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy metadata alias fallback by design: the top-level column backfill (rowToItem) wins; this copy only covers pre-0.20 rows still lacking it.
      item.metadata.visibility ??
      'global',
    // exactOptionalPropertyTypes: absent owner ids are omitted from the
    // descriptor, never bound as explicit undefined.
    ...(userId !== undefined ? { userId } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/**
 * MINING-group key: NUL-joined owner scope INCLUDING the visibility tier.
 * Pattern rows are stamped with group[0]'s full owner scope, so a
 * tier-mixed group could stamp patterns mined from private rows 'global'
 * — a real widening; keeping the tier in the key holds every mining
 * group at a single tier. Injective even when ids contain '|' (NUL
 * cannot appear in ids coming off the wire). Distillation deliberately
 * does NOT reuse this key — see distillOwnerKey.
 */
function partitionOwnerKey(item: MemoryItem): string {
  const o = ownerScopeOf(item);
  return `${o.visibility}\u0000${o.userId ?? ''}\u0000${o.workspaceId ?? ''}\u0000${o.sessionId ?? ''}`;
}

/**
 * DISTILL partition key: NUL-joined owner IDENTITY (userId, workspaceId,
 * sessionId) — the visibility tier is deliberately excluded so that
 * near-duplicates of one owner stamped at different tiers still
 * consolidate, into the NARROWEST member's tier via narrowestOwnerOf:
 * such a merge can only narrow visibility (a public duplicate is folded
 * into the private row's tier), never widen it (I-ACL-10). The id triple
 * alone still isolates owners — the tier adds no owner information — and
 * the NUL join stays injective when ids contain '|'.
 */
function distillOwnerKey(item: MemoryItem): string {
  const o = ownerScopeOf(item);
  return `${o.userId ?? ''}\u0000${o.workspaceId ?? ''}\u0000${o.sessionId ?? ''}`;
}

/**
 * PERSISTED-IDENTITY owner encoding: pipe-joined, used only inside the
 * procedural pattern table's row id (`patternIdOwner(item)::pattern`). Unlike the
 * partition key this string is a durable on-disk identity — changing its
 * separator would orphan every existing pattern row and force a full
 * re-mine, so it deliberately keeps the historical '|' join. Theoretical
 * ambiguity (ids containing '|') only risks a pattern-id collision, not a
 * cross-owner merge, and upsert semantics absorb it.
 */
function patternIdOwner(item: MemoryItem): string {
  const o = ownerScopeOf(item);
  return `${o.visibility}|${o.userId ?? ''}|${o.workspaceId ?? ''}|${o.sessionId ?? ''}`;
}

/**
 * A fully-prepared merge, produced in phase 1 and committed in phase 2.
 * Everything the merged MemoryItem needs is frozen here so the phase-2
 * transaction is pure synchronous store writes — EXCEPT the member-derived
 * aggregates (clusterTokens / avgImportance / narrowest-tier
 * representative), which phase 2 recomputes over the members that SURVIVE
 * its hot-protection re-check.
 */
interface MergePlan {
  cluster: MemoryItem[];
  mergedText: string;
  mergedTokens: number;
  embedding: TaggedEmbedding;
}

/**
 * A memory item known to carry a live vector — the distill candidate
 * shape. The type-predicate filter in distillCandidates is what makes the
 * downstream anchor/cosine math non-null without assertions.
 */
type VecItem = MemoryItem & { embedding: Float32Array };

/**
 * The NARROWEST visibility tier among the members plus the representative
 * member at that tier — the member whose owner scope and entityId the
 * merged item inherits. Tier source matches ownerScopeOf: item.visibility
 * wins over metadata.visibility, defaulting to 'global'. Rank comes from
 * TIER_ORDER (narrowest → widest); the strictly-less-than comparison
 * keeps the FIRST member encountered on ties. A plurality vote was the
 * historical bug here — a 4×'global' + 3×'user' cluster of one owner
 * merged as 'global', widening the private rows' visibility. Compression
 * may narrow, never widen (I-ACL-10).
 */
function narrowestOwnerOf(cluster: MemoryItem[]): { tier: VisibilityTier; member: MemoryItem } {
  const first = cluster[0];
  invariant(first !== undefined, 'clusters reaching tier selection always have at least one member');
  let member = first;
  let tier: VisibilityTier =
    member.visibility ??
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy metadata alias fallback (same tier-source rule as ownerScopeOf).
    member.metadata.visibility ??
    'global';
  let rank = TIER_ORDER.indexOf(tier);
  for (const c of cluster) {
    const t: VisibilityTier =
      c.visibility ??
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy metadata alias fallback (same tier-source rule as ownerScopeOf).
      c.metadata.visibility ??
      'global';
    const r = TIER_ORDER.indexOf(t);
    if (r < rank) {
      rank = r;
      tier = t;
      member = c;
    }
  }
  return { tier, member };
}

/**
 * Sentence boundary for the no-LLM distill fallback. Same shape as the
 * chunker's internal SENTENCE_SPLIT (not exported there, so kept local):
 * Latin terminals require following whitespace/EOL (so decimals and
 * abbreviations stay glued), CJK terminals `。！？` split immediately.
 */
const DISTILL_SENTENCE_SPLIT = /(?<=[.!?])(?:\s+|$)|(?<=[。！？])/g;

/** Hard char cap per sentence fed to the extractive selector. */
const DISTILL_SENTENCE_MAX_CHARS = 200;

/** Hard token ceiling for one cluster's no-LLM merged digest. */
const DISTILL_FALLBACK_MAX_TOKENS = 192;

/** Position decay: first sentence ×1.0, k-th sentence ×0.85^k. */
const DISTILL_POSITION_DECAY = 0.85;

/** Split text into trimmed sentences (whole text when no terminal exists). */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const m of text.matchAll(DISTILL_SENTENCE_SPLIT)) {
    const end = m.index + m[0].length;
    const piece = text.slice(cursor, end).trim();
    if (piece) out.push(piece);
    cursor = end;
  }
  const tail = text.slice(cursor).trim();
  if (tail) out.push(tail);
  return out;
}

/** Truncate to at most `n` CODE POINTS (never splits a surrogate pair). */
function truncateCodePoints(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n - 1).join('') + '…';
}

/**
 * Zero-LLM distill fallback: reduce one cluster to a classical extractive
 * digest instead of the historical "\n---\n" concatenation.
 *
 * Every member's content is split into sentences; each sentence becomes a
 * SalientLine with
 *   salience = member.importance × 0.85^k   (k = sentence index in the
 *                                            member: first sentence ×1.0)
 *   group    = member item id
 * and the shared MMR kernel (utils/summarize.ts) selects a budget-bounded,
 * non-redundant subset. The per-group COVERAGE floor forces every
 * member's most salient sentence in, which is exactly what the R8
 * metamorphic relation needs: a merge of two members that differ in one
 * keyword (nightly/weekly) keeps BOTH keywords — each member's best (and
 * here only) sentence is group-anchored, so neither can be MMR'd away.
 *
 * Budget: min(sum of member tokenCount metadata, 192) tokens for the
 * selected sentences, with the one-line `[distilled · N memories]` prefix
 * (cluster-size marker, keeps the digest auditable at a glance) counted
 * against that budget. Surviving sentences keep their original relative
 * order (kernel contract) and are joined with single spaces.
 *
 * Deterministic end to end: no randomness, no LLM, pure functions of the
 * cluster contents.
 */
function extractiveFallbackClusterText(cluster: MemoryItem[]): string {
  const lines: SalientLine[] = [];
  for (const member of cluster) {
    const sentences = splitSentences(member.content);
    for (let k = 0; k < sentences.length; k++) {
      const sentence = sentences[k];
      invariant(sentence !== undefined, 'loop index is below sentences.length');
      lines.push({
        text: truncateCodePoints(sentence, DISTILL_SENTENCE_MAX_CHARS),
        salience: member.importance * DISTILL_POSITION_DECAY ** k,
        group: member.id,
      });
    }
  }

  const prefix = `[distilled · ${cluster.length} memories]`;
  const memberTokens = cluster.reduce(
    (s, c) => s + (c.metadata.tokenCount ?? approximateTokenCount(c.content)),
    0,
  );
  const sentenceBudget = Math.max(
    1,
    Math.min(memberTokens, DISTILL_FALLBACK_MAX_TOKENS) - approximateTokenCount(prefix),
  );
  const selected = extractiveSelect(lines, { maxTokens: sentenceBudget });
  return `${prefix} ${selected.map((l) => l.text).join(' ')}`;
}

export class MemoryCompressor {
  private cfg: CompressionConfig;

  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingGateway,
    cfg: CompressionConfig,
    private bus: MemoryEventBus = NOOP_BUS,
  ) {
    // Fill the tuning knobs that used to be hard-coded so a legacy
    // four-field config behaves exactly as before.
    this.cfg = {
      ...cfg,
      clusterSimilarityThreshold: cfg.clusterSimilarityThreshold ?? 0.78,
      candidateLimit: cfg.candidateLimit ?? 1000,
      hotProtectAccessCount: cfg.hotProtectAccessCount ?? 3,
    };
  }

  /**
   * The distill candidate set: live semantic items with vectors that are
   * not hot (frequently accessed). Both shouldRun's age check and the
   * distill pass itself read from THIS query so the trigger and the pass
   * agree on what "the semantic layer" is.
   */
  private distillCandidates(): VecItem[] {
    return this.store
      .listItemsByLayer('semantic', this.cfg.candidateLimit ?? 1000)
      .filter(
        (i): i is VecItem =>
          Boolean(i.embedding) && i.accessCount < (this.cfg.hotProtectAccessCount ?? 3),
      );
  }

  /**
   * Why a compression pass should run: 'count' when total live items reach
   * triggerCount, 'age' when the semantic layer's OLDEST candidate is
   * older than 2 × decayHalfLifeDays (computed from the same candidate
   * query distill uses), null when neither condition holds.
   */
  private triggerReason(): 'count' | 'age' | null {
    if (!this.cfg.enabled) return null;
    const counts = this.store.countByLayer();
    if (counts.episodic + counts.semantic + counts.procedural >= this.cfg.triggerCount) {
      return 'count';
    }
    // Age-based trigger: a quiet store still needs its oldest semantic
    // entries distilled once decay says they are stale — implemented from
    // the candidate data we already query, not a second scan shape.
    const candidates = this.distillCandidates();
    let minCreatedAt = Number.POSITIVE_INFINITY;
    for (const item of candidates) {
      if (item.createdAt < minCreatedAt) minCreatedAt = item.createdAt;
    }
    if (
      Number.isFinite(minCreatedAt) &&
      Date.now() - minCreatedAt > 2 * this.cfg.decayHalfLifeDays * 86_400_000
    ) {
      return 'age';
    }
    return null;
  }

  /** Decide whether compression should run (count OR age trigger). */
  shouldRun(): boolean {
    return this.triggerReason() !== null;
  }

  /** Run eviction pass. Returns number of items removed. */
  evict(opts?: { layer?: 'episodic' | 'semantic' | 'procedural'; limit?: number }): number {
    const removed = this.store.evict({
      // exactOptionalPropertyTypes: an unset layer filter omits the key.
      ...(opts?.layer !== undefined ? { layer: opts.layer } : {}),
      importanceBelow: this.cfg.importanceThreshold,
      olderThanMs: this.cfg.decayHalfLifeDays * 86_400_000,
      limit: opts?.limit ?? 200,
    });
    return removed;
  }

  /**
   * Distill related semantic items into higher-importance semantic items.
   *
   * Algorithm (greedy single-pass, per (space, owner) partition):
   *   - Bucket every item by its 4-anchor sign key (see module doc).
   *   - For each item not yet summarized, gather candidates from buckets
   *     within Hamming distance 1 of its key, then keep those with
   *     cosine >= threshold (up to maxPerCluster - 1 neighbors).
   *   - Merge each cluster (size >= 2) into a new semantic item;
   *     originals are removed once consolidated.
   *
   * Strictly two-phase (same discipline as the ingestor):
   *   Phase 1 (outside any transaction) — cluster, await every merged
   *   text (LLM summarize or zero-LLM extractive fallback), and embed each partition's
   *   merged texts in ONE batched embedBatchTagged call instead of one
   *   network round-trip per cluster.
   *   Phase 2 (ONE store.ingestTx) — insertItem(merged) + deleteItem
   *   (members) for every cluster synchronously; a crash mid-way rolls
   *   the whole pass back, so merged items and originals can never
   *   coexist in a half-consolidated state.
   *
   * The maxClusters quota counts only REAL merges (clusters of size >= 2);
   * singleton clusters never occupy the quota, and exhausted quotas skip
   * remaining partitions with `continue` so later (space, owner)
   * partitions are revisited on the next pass instead of being starved.
   */
  async distill(opts: DistillOptions = {}): Promise<CompressionReportWithRetention> {
    const t0 = Date.now();
    const maxClusters = opts.maxClusters ?? 50;
    const maxPerCluster = opts.maxPerCluster ?? 6;
    const threshold = this.cfg.clusterSimilarityThreshold ?? 0.78;
    // Honest labeling: prefer the caller-supplied trigger (runOnce knows
    // whether the pass is count-gated, age-gated, or forced/manual);
    // re-derive from the store only when the caller did not say.
    const trigger = opts.trigger ?? this.triggerReason() ?? 'count';

    const items = this.distillCandidates();

    // Partition by embedding space first (cosine across spaces is noise),
    // then by owner (distillation must never mix two owners' memories).
    // The NUL separator keeps the space and owner halves unambiguous.
    const partitions = new Map<string, VecItem[]>();
    for (const item of items) {
      const key = `${item.metadata.embeddingSpace ?? 'legacy'}\u0000${distillOwnerKey(item)}`;
      const group = partitions.get(key);
      if (group) group.push(item);
      else partitions.set(key, [item]);
    }

    // ---- Phase 1: plan (cluster + network; ZERO store writes) -------------
    const visited = new Set<string>();
    const plans: MergePlan[] = [];

    for (const partition of partitions.values()) {
      // Quota gate: only REAL merges count; `continue` (not `break`) so
      // the partition scan itself always completes its bookkeeping and
      // later partitions are not permanently starved.
      if (plans.length >= maxClusters) continue;

      // Anchor-projection index for this partition: sign key -> members.
      const buckets = new Map<string, VecItem[]>();
      const keyOf = new Map<string, string>();
      for (const item of partition) {
        const key = anchorBucketKey(item.embedding);
        keyOf.set(item.id, key);
        const members = buckets.get(key);
        if (members) members.push(item);
        else buckets.set(key, [item]);
      }

      // Only clusters of size >= 2 are real merges; singletons neither
      // occupy the maxClusters quota nor produce a plan.
      const mergeClusters: VecItem[][] = [];
      for (const seed of partition) {
        if (visited.has(seed.id)) continue;
        const cluster: VecItem[] = [seed];
        visited.add(seed.id);

        // Every partition member got an anchor key in the bucketing pass.
        const seedKey = keyOf.get(seed.id);
        invariant(seedKey !== undefined, 'anchor bucket key recorded for every partition member');

        // Candidates: buckets at Hamming distance <= 1 from the seed's key.
        const candidates: VecItem[] = [];
        for (const bucketKey of neighborBucketKeys(seedKey)) {
          for (const cand of buckets.get(bucketKey) ?? []) {
            if (!visited.has(cand.id)) candidates.push(cand);
          }
        }

        // Final similarity gate on real cosine scores.
        const scored = candidates
          .map((other) => ({
            item: other,
            score: cosine(seed.embedding, other.embedding),
          }))
          .filter((s) => s.score >= threshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxPerCluster - 1);

        for (const s of scored) {
          cluster.push(s.item);
          visited.add(s.item.id);
        }
        if (cluster.length >= 2) {
          mergeClusters.push(cluster);
          if (plans.length + mergeClusters.length >= maxClusters) break;
        }
      }
      if (mergeClusters.length === 0) continue;

      // Merged texts (LLM summarize or the zero-LLM extractive fallback)
      // are awaited HERE — a slow callback must never hold the phase-2
      // transaction.
      const mergedTexts: string[] = [];
      for (const cluster of mergeClusters) {
        mergedTexts.push(
          opts.summarize
            ? await opts.summarize(cluster.map((c) => c.content))
            : extractiveFallbackClusterText(cluster),
        );
      }

      // ONE batched embedding per partition: every merged text of this
      // (space, owner) partition shares a single network round-trip
      // (and therefore a single serving space).
      const tagged = await this.embedder.embedBatchTagged(mergedTexts);
      if (tagged.length !== mergedTexts.length) {
        // A mismatched length would silently misalign vectors with texts.
        throw new Error('embedding gateway violated batch contract');
      }

      for (let i = 0; i < mergeClusters.length; i++) {
        const cluster = mergeClusters[i];
        invariant(cluster !== undefined, 'loop index is below mergeClusters.length');
        const mergedText = mergedTexts[i];
        invariant(mergedText !== undefined, 'one merged text is pushed per cluster');
        const embed = tagged[i];
        invariant(embed !== undefined, 'tagged length equals mergedTexts length (batch contract checked above)');
        const mergedTokens = approximateTokenCount(mergedText);
        plans.push({
          cluster,
          mergedText,
          mergedTokens,
          embedding: embed,
        });
      }
    }

    // ---- Phase 2: commit (ONE transaction) ---------------------------------
    // Every insertItem(merged) and tombstoneItem(member) lands in a single
    // ingestTx: a crash mid-pass rolls the whole batch back, so a merged
    // item never coexists with its un-merged originals. The merged item
    // carries the NARROWEST-tier representative member's
    // userId/workspaceId/sessionId and tier — owner metadata must survive
    // distillation or the NEXT round would mix owners into one partition
    // (violating the "never mix owners" rule), and the narrowest tier
    // guarantees the merge never widens visibility (I-ACL-10).
    const { newSemanticItems, savedTokens } = this.store.ingestTx((): {
      newSemanticItems: number;
      savedTokens: number;
    } => {
      let newSemanticItems = 0;
      let savedTokens = 0;
      for (const plan of plans) {
        // Write-side hot re-check: phase 1 clustered from a SNAPSHOT, and
        // retrieval between planning and this commit may have bumped
        // members' accessCount (touchAccess). A member that has gone hot
        // since the snapshot is dropped from the merge; a cluster thereby
        // reduced below 2 members is abandoned whole (a "merge" of one is
        // a copy, not a consolidation).
        const hot = this.cfg.hotProtectAccessCount ?? 3;
        const members = plan.cluster.filter(
          (c) => (this.store.getItem(c.id)?.accessCount ?? 0) < hot,
        );
        if (members.length < 2) continue;

        // Member-derived aggregates are recomputed over the SURVIVORS: a
        // dropped member must not keep contributing to the merged item's
        // tier, importance, token accounting, or owner columns.
        const clusterTokens = members.reduce(
          (s, c) => s + (c.metadata.tokenCount ?? approximateTokenCount(c.content)),
          0,
        );
        const avgImportance =
          members.reduce((s, c) => s + c.importance, 0) / members.length;
        const { tier: narrowestTier, member: representative } = narrowestOwnerOf(members);
        const owner = ownerScopeOf(representative);

        const now = Date.now();
        const merged: MemoryItem = {
          id: randomUUID(),
          layer: 'semantic',
          content: plan.mergedText,
          embedding: plan.embedding.vector,
          metadata: {
            source: 'inferred',
            tags: ['distilled'],
            tokenCount: plan.mergedTokens,
            embeddingSpace: plan.embedding.space,
            visibility: narrowestTier,
            // exactOptionalPropertyTypes: the representative's absent owner
            // ids are omitted, never bound as explicit undefined.
            ...(owner.userId !== undefined ? { userId: owner.userId } : {}),
            ...(owner.workspaceId !== undefined ? { workspaceId: owner.workspaceId } : {}),
            ...(owner.sessionId !== undefined ? { sessionId: owner.sessionId } : {}),
          },
          createdAt: now,
          updatedAt: now,
          importance: Math.min(1, avgImportance + 0.1),
          accessCount: 0,
          lastAccessedAt: now,
          // exactOptionalPropertyTypes: the representative's absent link is
          // omitted, never bound as explicit undefined.
          ...(representative.entityId !== undefined
            ? { entityId: representative.entityId }
            : {}),
        };
        this.store.insertItem(merged, {
          ...(owner.userId !== undefined ? { userId: owner.userId } : {}),
          ...(owner.workspaceId !== undefined ? { workspaceId: owner.workspaceId } : {}),
          ...(owner.sessionId !== undefined ? { sessionId: owner.sessionId } : {}),
        });
        newSemanticItems++;
        // Clamp per cluster: a summary that GREW must not report savings.
        savedTokens += Math.max(0, clusterTokens - plan.mergedTokens);

        // Supersede the originals instead of hard-deleting them: the
        // tombstone keeps every member row recoverable (undo / FLASHBACK)
        // and superseded_by chains it to its successor, so the
        // summarizedAs lineage survives distillation. Tombstoned rows are
        // excluded from every LIVE read by the store's filters.
        for (const c of members) this.store.tombstoneItem(c.id, merged.id);
      }
      return { newSemanticItems, savedTokens };
    });

    return {
      compressedAt: t0,
      trigger,
      inputCount: items.length,
      outputCount: this.store.countByLayer().semantic,
      savedTokens: Math.max(0, savedTokens),
      newSemanticItems,
      evictedItems: 0,
    };
  }

  /**
   * Run all compression passes. Convenience entry point.
   *
   * Lifecycle hygiene — TTL expiry sweep, episodic event-log pruning,
   * tombstone GC, procedural-pattern mining — runs on EVERY pass: a
   * low-activity store whose counts never reach triggerCount still needs
   * its logs pruned and tombstones collected. Only eviction + distillation
   * are gated by shouldRun. (Signature unchanged for the sleep cycle.)
   */
  async runOnce(opts?: DistillOptions): Promise<CompressionReportWithRetention> {
    // Lifecycle hygiene (every pass): enforce expiresAt TTLs, prune the
    // episodic event log past 90 days, GC tombstones older than 7 days,
    // and mine procedural patterns from the live semantic corpus —
    // surfacing the counts on the report.
    const expiredSwept = this.store.sweepExpiredItems();
    const eventsPruned = this.store.deleteEventsOlderThan(90 * 86_400_000);
    const tombstonesPurged = this.store.purgeDeleted(7 * 86_400_000);
    const patternsMined = this.minePatternsForOwners();

    if (!this.shouldRun()) {
      const skipped: CompressionReportWithRetention = {
        compressedAt: Date.now(),
        trigger: 'skipped',
        inputCount: 0,
        outputCount: this.store.countByLayer().semantic,
        savedTokens: 0,
        newSemanticItems: 0,
        evictedItems: 0,
        expiredSwept,
        eventsPruned,
        tombstonesPurged,
        patternsMined,
      };
      this.bus.emit('memory.compressed', skipped);
      return skipped;
    }
    const evicted = this.evict();
    // Pass OUR trigger judgment into distill instead of letting it
    // re-derive (and pseudo-label) one: the report must say why THIS pass
    // ran. Past the shouldRun() gate the reason is count/age; the
    // 'manual' fallback covers a caller that runs the pass despite the
    // store no longer reporting a natural trigger.
    const report = await this.distill({
      ...opts,
      trigger: this.triggerReason() ?? 'manual',
    });
    const full: CompressionReportWithRetention = {
      ...report,
      evictedItems: evicted,
      expiredSwept,
      eventsPruned,
      tombstonesPurged,
      patternsMined,
    };
    this.bus.emit('memory.compressed', full);
    return full;
  }

  /**
   * Mine procedural patterns (user preferences/topics) per OWNER GROUP
   * from the live semantic layer, and upsert each into the procedural
   * pattern table stamped with the group's scope.
   *
   * Grouping uses the TIER-INCLUSIVE owner key (partitionOwnerKey:
   * NUL-separated visibility/userId/workspaceId/sessionId — injective
   * even when ids contain '|') rather than distillation's tier-free id
   * triple: pattern rows are stamped with group[0]'s full scope, so a
   * tier-mixed group could stamp patterns mined from private rows
   * 'global' — a widening distillation guards against but mining must
   * not introduce either. Owners therefore never see another owner's
   * (or session's) distilled item or mined preference. Pattern ROW ids
   * keep the legacy pipe-joined owner prefix (patternIdOwner) for
   * identity stability.
   * Groups with fewer than 8 items are skipped — thinner corpora
   * produce noise, not habits.
   *
   * NOTE: `role` is forced to 'user' for every mined item. Semantic items
   * derive from user/assistant messages but do not record which voice
   * produced them; the pattern miner only counts user-voice items, so
   * treating all of them as user voice is the simplification chosen here
   * (mining everything beats mining nothing, and the importance-contrast
   * gate still filters incidental vocabulary).
   *
   * Wrapped in try/catch: a mining failure must never break compression —
   * it reports 0 and the pass still returns its other results.
   *
   * @returns number of patterns upserted across all owner groups.
   */
  private minePatternsForOwners(): number {
    try {
      const items = this.store.listItemsByLayer('semantic', 1000);

      // Partition by the same owner key the distill pass uses.
      const groups = new Map<string, MemoryItem[]>();
      for (const item of items) {
        const key = partitionOwnerKey(item);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
      }

      let mined = 0;
      for (const group of groups.values()) {
        if (group.length < 8) continue; // not enough corpus for real habits
        const first = group[0];
        invariant(first !== undefined, 'groups smaller than 8 items were skipped above');
        const scope = ownerScopeOf(first);
        const patterns = minePatterns(
          group.map((i) => ({
            content: i.content,
            importance: i.importance,
            role: 'user' as const, // see JSDoc: voice is not recorded on semantic items
            createdAt: i.createdAt,
            id: i.id,
          })),
        );
        for (const p of patterns) {
          this.store.upsertPattern(
            {
              id: `${patternIdOwner(first)}::${p.pattern}`,
              pattern: p.pattern,
              description: p.description,
              evidence: p.evidence,
              confidence: p.confidence,
              createdAt: p.createdAt,
            },
            scope,
          );
          mined++;
        }
      }
      return mined;
    } catch {
      return 0; // never let mining break the compression pass
    }
  }
}
