/**
 * Stratifier — builds the neocortex during sleep.
 *
 * Session → week → month → era: each night the SEMANTIC layer's recent
 * items fold into bounded digest nodes (pure stratify kernel) — the
 * episodic stream never enters the tree directly; it reaches the tree
 * only after compression distills it into semantic items. Every
 * ERA/MONTH node is ALSO stored as a retrievable semantic item (tagged
 * 'stratified', metadata.treeNode) — so "what was Q2 about" is answered
 * by retrieval hitting ONE era node, not by scanning a quarter.
 *
 * Idempotence: node ids are deterministic (level + period + owner); a
 * rebuild re-digests, refreshes the linked summary ITEM in place (same
 * id, new digest + new vector — insertItem's ON CONFLICT updates only
 * content columns and never touches tombstones/timestamps), and bumps
 * the node version. The episodic stream remains the ground truth — the
 * tree is a rebuildable cache.
 *
 * Two-phase discipline per node (the palace-wide ingest invariant): the
 * re-embed of a refreshed digest happens OUTSIDE any transaction; the
 * item rewrite and the tree-node upsert commit together inside ONE
 * store.ingestTx.
 */

import { buildTree } from '../utils/stratify.js';
import type { MemoryEventBus, MemoryScopeKind } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import { scopeLevels, widestLevel, type ScopeIdentity } from '../utils/scope.js';
import type { EmbeddingGateway, TaggedEmbedding } from '../utils/embedding.js';
import { approximateTokenCount } from '../utils/tokenizer.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryIngestor } from './memory-ingestor.js';
import type { MemoryGraph } from './memory-graph.js';

export interface StratifyReport {
  nodesBuilt: number;
  byLevel: Record<string, number>;
  eras: string[];
}

/** A planned (phase-1) in-place refresh of a stale summary item. */
interface SummaryRefresh {
  id: string;
  content: string;
  tagged: TaggedEmbedding;
}

export class Stratifier {
  constructor(
    private store: MemoryStore,
    private ingestor: MemoryIngestor,
    private scopeKind: MemoryScopeKind = 'user',
    private bus: MemoryEventBus = NOOP_BUS,
    /** Needed to refresh stale summary vectors; without it refresh degrades off. */
    private gateway?: EmbeddingGateway,
    /**
     * Graph-salience source for the stratify kernel's hot-entity line
     * boost; without it buildTree runs graph-free (no +0.15 boost).
     */
    private graph?: MemoryGraph,
  ) {}

  async stratify(scope: {
    userId?: string;
    workspaceId?: string;
    sessionId?: string;
  }): Promise<StratifyReport> {
    const items = this.store.listItemsByLayerScoped(
      'semantic',
      this.widestLevel(scope),
      500,
    );
    if (items.length === 0) {
      return { nodesBuilt: 0, byLevel: {}, eras: [] };
    }

    // SELF-DIGEST EXCLUSION: last cycle's digests (tagged 'stratified')
    // must not become this cycle's raw material. Feeding them back made
    // each night's digest summarize the PREVIOUS digest plus the raw
    // facts — the summaries nested their own prefixes deeper every cycle
    // ("Summary of summary of …") until the bounded digest was nothing
    // but nested boilerplate. Raw semantic items stay the only input.
    const inputs = items
      .filter((i) => !(i.metadata.tags ?? []).includes('stratified'))
      .map((i) => ({
        id: i.id,
        content: i.content,
        createdAt: i.createdAt,
        // Salience seed for extractive selection: important items' lines
        // outrank filler when the digest budget runs out.
        importance: i.importance,
      }));
    const tree = buildTree(inputs, this.hotEntities(scope));
    const report: StratifyReport = { nodesBuilt: 0, byLevel: {}, eras: [] };

    // Owner key: two users sharing a level+period MUST NOT share a node
    // id, or their tree_nodes rows collide on the unique node_id and each
    // rebuild silently overwrites the other's digest (cross-tenant
    // bleed). Anonymous scope degrades to a shared 'anon' bucket.
    const ownerKey =
      [scope.userId, scope.workspaceId, scope.sessionId].filter(Boolean).join('|') ||
      'anon';

    for (const [level, drafts] of tree) {
      report.byLevel[level] = drafts.length;
      for (const d of drafts) {
        const nodeId = `node:${level}:${d.periodStart}:${ownerKey}`;
        // Era/month/week nodes become retrievable semantic items. An
        // EXISTING linked item is refreshed in place (same id) so the
        // retrieved era summary reflects the LATEST digest, not forever
        // the first version.
        let itemId: string | undefined;
        let refresh: SummaryRefresh | null = null;
        if (level !== 'session') {
          const existing = this.store.listTreeNodes(level, scope.userId, d.periodStart, d.periodStart);
          const prior = existing.find((n) => n.nodeId === nodeId);
          itemId = prior?.itemId ?? undefined;
          if (itemId) {
            refresh = await this.planSummaryRefresh(itemId, d.content);
          } else {
            // DIGEST TIER: write with ONLY the configured kind's owning
            // identity. Under privacy-first tier resolution, passing the
            // full caller scope (which during session.end carries a
            // sessionId) would collapse digest rows onto the SESSION tier
            // — invisible to the owner's very next session, a black hole
            // for exactly the long-horizon periods they summarize. Digests
            // are kind-tier artifacts: they outlive any single session.
            const digestScope = this.digestWriteScope(scope);
            itemId = await this.ingestor.ingestUserMemory({
              content: d.content,
              tags: ['stratified', level],
              importance: 0.7,
              ...(digestScope.userId !== undefined ? { userId: digestScope.userId } : {}),
              ...(digestScope.workspaceId !== undefined
                ? { workspaceId: digestScope.workspaceId }
                : {}),
              ...(digestScope.sessionId !== undefined ? { sessionId: digestScope.sessionId } : {}),
              // Digest rows are SYSTEM artifacts, not user curation:
              // stamping 'system' keeps derived rows distinguishable from
              // user-curated ones by metadata alone (mirrors the
              // Inferencer's 'inferred' stamp) and stops downstream
              // user-write bridges (e.g. the CRDT mirror) from treating
              // a digest as a user-authored memory.
              source: 'system',
            });
          }
        }
        // Phase 2 — commit: the refreshed item and the node upsert share
        // ONE transaction (the embed already happened above, outside).
        this.store.ingestTx((): void => {
          if (refresh) this.commitSummaryRefresh(refresh);
          this.store.upsertTreeNode({
            nodeId,
            level,
            periodStart: d.periodStart,
            periodEnd: d.periodEnd,
            content: d.content,
            tokenCount: d.tokenCount,
            childIds: d.childIds,
            ...(itemId !== undefined ? { itemId } : {}),
            ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
            ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
          });
        });
        report.nodesBuilt++;
        if (level === 'era') {
          report.eras.push(d.content.slice(0, 100));
        }
      }
    }

    this.bus.emit('memory.stratified', report);
    return report;
  }

  /**
   * Phase 1 of a summary refresh: re-embed the NEW digest over the
   * network with NO transaction held. Best-effort — without a wired
   * gateway, or on a degraded embedder, returns null and the prior
   * summary item is kept as-is (the tree node itself still refreshes).
   */
  private async planSummaryRefresh(
    itemId: string,
    digest: string,
  ): Promise<SummaryRefresh | null> {
    if (!this.gateway) return null;
    try {
      const tagged = await this.gateway.embedTagged(digest);
      return { id: itemId, content: digest, tagged };
    } catch {
      return null;
    }
  }

  /**
   * Phase 2 of a summary refresh (must run inside store.ingestTx):
   * rewrite the linked item UNDER ITS OWN ID with the new content and
   * vector. insertItem's ON CONFLICT only updates content-side columns —
   * tombstones, created_at and access counters stay owned by their
   * dedicated paths, so a refresh can never resurrect a deleted item.
   */
  private commitSummaryRefresh(refresh: SummaryRefresh): void {
    const prior = this.store.getItem(refresh.id);
    if (!prior) return; // purged/expired underneath us — nothing to refresh
    this.store.insertItem(
      {
        ...prior,
        content: refresh.content,
        embedding: refresh.tagged.vector,
        metadata: {
          ...prior.metadata,
          embeddingSpace: refresh.tagged.space,
          tokenCount: approximateTokenCount(refresh.content),
        },
        updatedAt: Date.now(),
      },
      // Reuse the persisted owner columns verbatim: the conflict update
      // rewrites the owner columns, and they must not drift.
      {
        ...(prior.userId !== undefined ? { userId: prior.userId } : {}),
        ...(prior.workspaceId !== undefined ? { workspaceId: prior.workspaceId } : {}),
        ...(prior.sessionId !== undefined ? { sessionId: prior.sessionId } : {}),
      },
    );
  }

  /**
   * Identity for digest-item WRITES: only the configured kind's owning id.
   *
   * resolveWriteTier is privacy-first — the narrowest tier whose owner id
   * is present wins — so feeding the full caller scope (session.end
   * carries a sessionId; a workspace host carries a workspaceId) would
   * collapse digest rows onto that transient narrow tier. A digest is a
   * consolidation artifact of the configured KIND (a user's era outlives
   * the session it was built in): strip the scope down to exactly the
   * kind's own identity and the write lands on the kind tier. Anonymous
   * kind-tier callers degrade to global exactly as before.
   */
  private digestWriteScope(scope: {
    userId?: string;
    workspaceId?: string;
    sessionId?: string;
  }): ScopeIdentity {
    switch (this.scopeKind) {
      case 'session':
        return { ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}) };
      case 'workspace':
        return { ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}) };
      case 'user':
        return { ...(scope.userId !== undefined ? { userId: scope.userId } : {}) };
      default:
        return {};
    }
  }

  /**
   * Currently hot entity names (top normalized PageRank) for the stratify
   * kernel — mirrors CoreMemoryService.hotEntities (the graph-salience
   * core is shared, not forked): same widest-level ranking, same top-25
   * lowercase name set. Wiring it here is what makes the kernel's +0.15
   * hot-entity line boost (utils/stratify lineSalience) actually fire for
   * top-level stratification; without a graph (or with an empty rank
   * table) buildTree stays graph-free and behavior is unchanged.
   */
  private hotEntities(scope: {
    userId?: string;
    workspaceId?: string;
    sessionId?: string;
  }): Set<string> | undefined {
    if (!this.graph) return undefined;
    const level = widestLevel(scopeLevels(this.scopeKind, scope));
    const ranks = this.graph.getNormalizedRanks(level);
    if (ranks.size === 0) return undefined;
    const idToName = new Map(
      this.store.listEntitiesScoped(level, 500).map((e) => [e.id, e.name] as const),
    );
    const top: Array<{ name: string; rank: number }> = [];
    for (const [id, rank] of ranks) {
      const name = idToName.get(id);
      if (name) top.push({ name, rank });
    }
    top.sort((a, b) => b.rank - a.rank);
    return new Set(top.slice(0, 25).map((t) => t.name.toLowerCase()));
  }

  private widestLevel(scope: { userId?: string; workspaceId?: string; sessionId?: string }) {
    return widestLevel(scopeLevels(this.scopeKind, scope));
  }
}
