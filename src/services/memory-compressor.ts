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
 *     without one the contents are concatenated (the embedding still
 *     consolidates them). Distillation runs over the semantic layer
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
 *    partition, where owner = visibility|userId|workspaceId|sessionId.
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
 * After a real (non-skipped) pass, `runOnce` also runs lifecycle hygiene —
 * TTL expiry sweep, episodic event-log pruning, tombstone GC — and reports
 * their counts as expiredSwept / eventsPruned / tombstonesPurged.
 *
 * The report's `savedTokens` is computed honestly: from the token count of
 * the ACTUAL merged text versus the sum of its parts (previously the
 * merged item's token count was set to that sum, making savedTokens
 * identically zero), and clamped at zero per cluster and in total so an
 * expanding summary can never report negative savings.
 */

import { randomUUID } from 'node:crypto';
import type { EmbeddingGateway } from '../utils/embedding.js';
import { cosine } from '../utils/embedding.js';
import { anchorKey as anchorBucketKey, neighborKeys as neighborBucketKeys } from '../utils/anchors.js';
import { approximateTokenCount } from '../utils/tokenizer.js';
import { minePatterns } from '../utils/pattern-miner.js';
import type { VisibilityTier } from '../utils/scope.js';
import { NOOP_BUS, type MemoryEventBus, type CompressionReport, type MemoryItem } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';

export interface CompressionConfig {
  enabled: boolean;
  triggerCount: number;
  importanceThreshold: number;
  decayHalfLifeDays: number;
}

export interface DistillOptions {
  /** Max clusters to form during semantic distillation. */
  maxClusters?: number;
  /** Max items per cluster to merge. */
  maxPerCluster?: number;
  /** Optional callback to summarize a cluster with an LLM. */
  summarize?: (clusterTexts: string[]) => Promise<string>;
}

/**
 * CompressionReport extended with lifecycle-hygiene counts from runOnce's
 * retention pass. Defined locally so types/index.ts stays untouched; the
 * intersection still satisfies CompressionReport for existing callers.
 */
export type CompressionReportWithRetention = CompressionReport & {
  /** Live items tombstoned by the expiresAt TTL sweep. */
  expiredSwept?: number;
  /** Episodic event rows hard-deleted past the retention window. */
  eventsPruned?: number;
  /** Tombstoned items hard-deleted by GC. */
  tombstonesPurged?: number;
  /** Procedural patterns mined (upserted) by the per-owner mining pass. */
  patternsMined?: number;
};

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

/** The owner scope of one item — the single source of the owner key. */
function ownerScopeOf(item: MemoryItem): OwnerScopeDescriptor {
  return {
    visibility: (item.visibility ?? item.metadata.visibility ?? 'global') as VisibilityTier,
    userId: item.metadata.userId,
    workspaceId: item.metadata.workspaceId,
    sessionId: item.metadata.sessionId,
  };
}

/** Pipe-joined owner key: visibility|userId|workspaceId|sessionId. */
function ownerKey(item: MemoryItem): string {
  const o = ownerScopeOf(item);
  return `${o.visibility}|${o.userId ?? ''}|${o.workspaceId ?? ''}|${o.sessionId ?? ''}`;
}

export class MemoryCompressor {
  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingGateway,
    private cfg: CompressionConfig,
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  /** Decide whether compression should run. */
  shouldRun(): boolean {
    if (!this.cfg.enabled) return false;
    const counts = this.store.countByLayer();
    return (
      counts.episodic + counts.semantic + counts.procedural >= this.cfg.triggerCount
    );
  }

  /** Run eviction pass. Returns number of items removed. */
  evict(opts?: { layer?: 'episodic' | 'semantic' | 'procedural'; limit?: number }): number {
    const removed = this.store.evict({
      layer: opts?.layer,
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
   */
  async distill(opts: DistillOptions = {}): Promise<CompressionReportWithRetention> {
    const t0 = Date.now();
    const maxClusters = opts.maxClusters ?? 50;
    const maxPerCluster = opts.maxPerCluster ?? 6;
    const threshold = 0.78; // cosine similarity required to merge

    const items = this.store
      .listItemsByLayer('semantic', 1000)
      .filter((i) => i.embedding && i.accessCount < 3);

    // Partition by embedding space first (cosine across spaces is noise),
    // then by owner (distillation must never mix two owners' memories).
    // The NUL separator keeps the space and owner halves unambiguous.
    const partitions = new Map<string, MemoryItem[]>();
    for (const item of items) {
      const key = `${item.metadata.embeddingSpace ?? 'legacy'}\u0000${ownerKey(item)}`;
      const group = partitions.get(key);
      if (group) group.push(item);
      else partitions.set(key, [item]);
    }

    const clusters: MemoryItem[][] = [];
    const visited = new Set<string>();

    for (const partition of partitions.values()) {
      if (clusters.length >= maxClusters) break;

      // Anchor-projection index for this partition: sign key -> members.
      const buckets = new Map<string, MemoryItem[]>();
      const keyOf = new Map<string, string>();
      for (const item of partition) {
        const key = anchorBucketKey(item.embedding!);
        keyOf.set(item.id, key);
        const members = buckets.get(key);
        if (members) members.push(item);
        else buckets.set(key, [item]);
      }

      for (const seed of partition) {
        if (visited.has(seed.id)) continue;
        const cluster: MemoryItem[] = [seed];
        visited.add(seed.id);

        // Candidates: buckets at Hamming distance <= 1 from the seed's key.
        const candidates: MemoryItem[] = [];
        for (const bucketKey of neighborBucketKeys(keyOf.get(seed.id)!)) {
          for (const cand of buckets.get(bucketKey) ?? []) {
            if (!visited.has(cand.id)) candidates.push(cand);
          }
        }

        // Final similarity gate on real cosine scores.
        const scored = candidates
          .map((other) => ({
            item: other,
            score: cosine(seed.embedding!, other.embedding!),
          }))
          .filter((s) => s.score >= threshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxPerCluster - 1);

        for (const s of scored) {
          cluster.push(s.item);
          visited.add(s.item.id);
        }
        clusters.push(cluster);
        if (clusters.length >= maxClusters) break;
      }
    }

    let newSemanticItems = 0;
    let savedTokens = 0;

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const mergedText = opts.summarize
        ? await opts.summarize(cluster.map((c) => c.content))
        : cluster.map((c) => c.content).join('\n---\n');

      const clusterTokens = cluster.reduce(
        (s, c) => s + (c.metadata.tokenCount ?? approximateTokenCount(c.content)),
        0,
      );
      const mergedTokens = approximateTokenCount(mergedText);

      const avgImportance =
        cluster.reduce((s, c) => s + c.importance, 0) / cluster.length;
      const { vector, space } = await this.embedder.embedTagged(mergedText);
      const now = Date.now();
      // The merged item inherits the DOMINANT visibility of its members —
      // distillation must never widen private memories into the global tier.
      const tierVotes = new Map<string, number>();
      for (const c of cluster) {
        const v = (c.metadata.visibility as string | undefined) ?? 'global';
        tierVotes.set(v, (tierVotes.get(v) ?? 0) + 1);
      }
      let dominantTier = 'global';
      let bestVotes = -1;
      for (const [v, n] of tierVotes) {
        if (n > bestVotes) {
          bestVotes = n;
          dominantTier = v;
        }
      }
      const dominantMember =
        cluster.find((c) => (c.metadata.visibility ?? 'global') === dominantTier) ?? cluster[0];
      const merged: MemoryItem = {
        id: randomUUID(),
        layer: 'semantic',
        content: mergedText,
        embedding: vector,
        metadata: {
          source: 'inferred',
          tags: ['distilled'],
          tokenCount: mergedTokens,
          embeddingSpace: space,
          visibility: dominantTier as MemoryItem['visibility'],
        },
        createdAt: now,
        updatedAt: now,
        importance: Math.min(1, avgImportance + 0.1),
        accessCount: 0,
        lastAccessedAt: now,
        entityId: cluster[0].entityId,
      };
      this.store.insertItem(merged, {
        userId: dominantMember.metadata.userId as string | undefined,
        workspaceId: dominantMember.metadata.workspaceId as string | undefined,
        sessionId: dominantMember.metadata.sessionId as string | undefined,
      });
      newSemanticItems++;
      // Clamp per cluster: a summary that GREW must not report savings.
      savedTokens += Math.max(0, clusterTokens - mergedTokens);

      // Remove originals (they're consolidated)
      for (const c of cluster) this.store.deleteItem(c.id);
    }

    return {
      compressedAt: t0,
      trigger: 'count',
      inputCount: items.length,
      outputCount: this.store.countByLayer().semantic,
      savedTokens: Math.max(0, savedTokens),
      newSemanticItems,
      evictedItems: 0,
    };
  }

  /** Run all compression passes. Convenience entry point. */
  async runOnce(opts?: DistillOptions): Promise<CompressionReportWithRetention> {
    if (!this.shouldRun()) {
      const report: CompressionReportWithRetention = {
        compressedAt: Date.now(),
        trigger: 'skipped',
        inputCount: 0,
        outputCount: this.store.countByLayer().semantic,
        savedTokens: 0,
        newSemanticItems: 0,
        evictedItems: 0,
      };
      this.bus.emit('memory.compressed', report);
      return report;
    }
    const evicted = this.evict();
    const report = await this.distill(opts);
    // Lifecycle hygiene (only after a real pass): enforce expiresAt TTLs,
    // prune the episodic event log past 90 days, and GC tombstones older
    // than 7 days — surfacing the counts on the report.
    const expiredSwept = this.store.sweepExpiredItems();
    const eventsPruned = this.store.deleteEventsOlderThan(90 * 86_400_000);
    const tombstonesPurged = this.store.purgeDeleted(7 * 86_400_000);
    // Procedural-pattern mining (also only after a real pass): the dormant
    // procedural layer comes alive from the same live semantic corpus.
    const patternsMined = this.minePatternsForOwners();
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
   * Grouping reuses the distill owner key (visibility|userId|workspaceId|
   * sessionId), so preferences mined from one owner's memories are never
   * attributed to (or visible by) another owner. Groups with fewer than 8
   * items are skipped — thinner corpora produce noise, not habits.
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
        const key = ownerKey(item);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
      }

      let mined = 0;
      for (const group of groups.values()) {
        if (group.length < 8) continue; // not enough corpus for real habits
        const scope = ownerScopeOf(group[0]);
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
              id: `${ownerKey(group[0])}::${p.pattern}`,
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
