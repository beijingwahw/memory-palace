/**
 * MemoryGraph — scope-isolated knowledge graph with personalized PageRank.
 *
 * Entity extraction runs with provenance hints (@-mention → person, path →
 * file, …) and entities/edges carry the same visibility-tier ACL as memory
 * items: a private mention creates a PRIVATE entity, so one user's graph
 * (entities, edges, ranks) never leaks into another's analytics.
 *
 * Ranking = one pure PageRank kernel (utils/pagerank.ts) with:
 *   - weighted edges (co-occurrence counts)
 *   - temporal decay (stale associations fade by half-life)
 *   - optional personalization: teleport mass concentrated on the query's
 *     entities (PPR / random-walk-with-restart), making GRAPH PROXIMITY to
 *     what the question is about a retrieval signal.
 *
 * Two version-keyed caches (global ranks, per-seed-set PPR) invalidate on
 * the store's monotonic graph-version stamp — immune to the count-collision
 * staleness of size-based cache keys. Both use stale-while-revalidate
 * (RANK_MIN_TTL_MS): every upsert bumps the graph version, so a chatty
 * session would keep the caches perpetually cold; instead a version-stale
 * entry younger than 500ms is served as-is and the FIRST stale call past
 * that window recomputes synchronously. Ranks therefore lag at most ~500ms
 * behind graph writes — retrieval ordering is unaffected in practice.
 */

import { randomUUID } from 'node:crypto';
import { NOOP_BUS, type Entity, type EntityType, type GraphEdge, type MemoryEventBus } from '../types/index.js';
import {
  resolveWriteTier,
  scopeLevels,
  widestLevel,
  type ScopeIdentity,
  type ScopeLevelClause,
  type VisibilityTier,
} from '../utils/scope.js';
import { normalizeRanks, pageRank } from '../utils/pagerank.js';
import type { MemoryStore } from './memory-store.js';

export interface GraphConfig {
  enabled: boolean;
  maxEntities: number;
  pagerankDamping: number;
  pagerankIterations: number;
  pagerankEdgeDecayDays: number;
  /** 1 = pure personalized PR when seeds exist, 0 = pure global. */
  personalizationWeight: number;
}

/** Scope context for entity/edge writes. */
export interface GraphScope extends ScopeIdentity {
  visibility: VisibilityTier;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'we', 'they',
  'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'so', 'not', 'no', 'yes', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'will', 'would', 'should', 'could',
  'can', 'may', 'might', 'shall', 'just', 'also', 'than', 'there', 'here',
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'whose',
]);

const CODE_FENCE = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
const FILE_PATH = /(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
const HANDLE = /@[a-zA-Z0-9_.-]+/g;
const HASHTAG = /#[a-zA-Z0-9_]+/g;
const IDENT_RE = /\b[A-Z][a-zA-Z0-9_]+\b|\b[a-z]+_[a-z0-9_]+\b|\b[A-Z]{2,}\b/g;

/** Where a candidate name came from — informs its entity type. */
type EntityHint = 'handle' | 'tag' | 'url' | 'path' | 'ident';

/** Extracted candidate: normalized name + provenance hint. */
export interface ExtractedEntity {
  name: string;
  hint: EntityHint;
}

interface RankCacheEntry {
  version: number;
  ranks: Map<string, number>;
  /**
   * Wall-clock time (Date.now()) at which these ranks were computed.
   * Drives the stale-while-revalidate floor: a version-stale entry
   * younger than MemoryGraph.RANK_MIN_TTL_MS is served without
   * recomputation.
   */
  computedAt: number;
}

/** What the retrieval prior reports back per hit. */
export interface PriorDetail {
  entityName?: string;
  globalRank?: number;
  proximityRank?: number;
}

const PPR_CACHE_LIMIT = 16;

export class MemoryGraph {
  /**
   * Stale-while-revalidate freshness floor (ms) for both rank caches.
   * Every entity/edge upsert bumps the graph version, so without SWR a
   * write-heavy session invalidates the caches on each retrieval and
   * pays a full O(iterations × edges) PageRank every time. Policy:
   *
   *   - version match                      → serve fresh, no work
   *   - stale, now − computedAt <  TTL     → serve stale, no recompute
   *   - stale, now − computedAt >= TTL     → recompute now, refresh cache
   *
   * The better-sqlite3 store is synchronous, so the "background"
   * recompute collapses into the first stale call at/after the TTL —
   * the next call sees fresh ranks, and at most one recompute happens
   * per 500ms window even under a storm of writes. Tradeoff: bounded
   * staleness — ranks lag ≤500ms behind graph writes, well below the
   * timescale at which co-occurrence weights shift retrieval ordering
   * in practice.
   */
  private static readonly RANK_MIN_TTL_MS = 500;

  private globalRankCache: RankCacheEntry | null = null;
  private globalRankCacheKey = '';
  private pprCache = new Map<string, RankCacheEntry>();

  constructor(
    private store: MemoryStore,
    private cfg: GraphConfig,
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  /**
   * Extract entities from text and upsert them AT the given scope.
   * Same-name entities at other visibility tiers are deliberately NOT
   * merged — private mentions create private entities.
   */
  ingestEntities(text: string, itemId: string, scope: GraphScope): string[] {
    if (!this.cfg.enabled || !text) return [];
    const found = extract(text);
    const tier = resolveWriteTier(scope.visibility, scope);

    const ids: string[] = [];
    const now = Date.now();
    for (const { name, hint } of found) {
      const existing = this.store.findEntityAtTier(name, tier, scope);
      const entity: Entity = existing ?? {
        id: randomUUID(),
        name,
        type: classify(name, hint),
        aliases: [],
        firstSeenAt: now,
        lastSeenAt: now,
        mentionCount: 0,
      };
      entity.lastSeenAt = now;
      entity.mentionCount += 1;
      this.store.upsertEntity(entity, { ...scope, visibility: tier });
      ids.push(entity.id);
    }

    // Co-occurrence edges (directed both ways; weight accumulates)
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        const edge: GraphEdge = {
          from: ids[i],
          to: ids[j],
          relation: 'co-occurs',
          weight: 1,
          createdAt: now,
        };
        this.store.upsertEdge(edge, { ...scope, visibility: tier });
      }
    }
    if (ids.length > 0) {
      this.bus.emit('memory.graph-updated', { entityIds: ids });
    }
    return ids;
  }

  // ----- Ranking -------------------------------------------------------------

  private rankCacheKey(level: ScopeLevelClause | null): string {
    return level ? level.tiers.join('>') + ':' + JSON.stringify(level.ids) : 'ALL';
  }

  /**
   * PageRank over the scoped subgraph (null level = whole graph, admin
   * view). Weighted, temporally decayed; cache keyed by graph version.
   *
   * Stale-while-revalidate: a version-stale cached entry (same scope key)
   * is served as-is while younger than RANK_MIN_TTL_MS; the first stale
   * call at/after the TTL recomputes synchronously and refreshes the
   * cache, so the next call sees fresh ranks. Bounded staleness: ranks
   * lag ≤500ms behind graph writes — retrieval ordering is unaffected in
   * practice, and a chatty session no longer recomputes PageRank on every
   * retrieval.
   */
  getRanks(level: ScopeLevelClause | null = null): Map<string, number> {
    const key = this.rankCacheKey(level);
    const version = this.store.graphVersion();
    const cached = this.globalRankCacheKey === key ? this.globalRankCache : null;
    if (cached) {
      // Fresh: cache version matches the store's graph version → serve.
      if (cached.version === version) return cached.ranks;
      // Stale but within the freshness floor → serve stale, skip recompute
      // (collapses write-storm recomputes to one per TTL window).
      if (Date.now() - cached.computedAt < MemoryGraph.RANK_MIN_TTL_MS) {
        return cached.ranks;
      }
      // Stale beyond the floor → fall through and recompute NOW so the
      // next call sees fresh ranks.
    }
    const entities = level
      ? this.store.listEntitiesScoped(level, this.cfg.maxEntities)
      : this.store.listEntities(this.cfg.maxEntities);
    const edges = this.scopedEdgesFor(level);
    const ranks = pageRank(
      entities.map((e) => e.id),
      edges,
      {
        damping: this.cfg.pagerankDamping,
        iterations: this.cfg.pagerankIterations,
        edgeDecayDays: this.cfg.pagerankEdgeDecayDays,
      },
    );
    this.globalRankCache = { version, ranks, computedAt: Date.now() };
    this.globalRankCacheKey = key;
    return ranks;
  }

  /**
   * Personalized PageRank: teleport concentrated on `seeds` (the query's
   * entities). Cached per seed-set hash with LRU eviction. Falls back to
   * classic PageRank when seeds are empty or unknown to the scoped graph.
   *
   * Same stale-while-revalidate policy as getRanks: a version-stale hit
   * is still served while younger than RANK_MIN_TTL_MS; the first stale
   * call at/after the TTL recomputes and refreshes. Ranks lag ≤500ms
   * behind graph writes — retrieval ordering is unaffected in practice.
   */
  getPersonalizedRanks(
    seeds: string[],
    level: ScopeLevelClause | null = null,
  ): Map<string, number> {
    if (seeds.length === 0) return this.getRanks(level);
    const key =
      this.rankCacheKey(level) + '|seeds:' + [...seeds].sort().join(',');
    const version = this.store.graphVersion();
    const hit = this.pprCache.get(key);
    if (hit) {
      // Serve when fresh OR stale-but-younger-than the SWR floor; a
      // stale-and-old entry falls through to a synchronous recompute.
      const serve =
        hit.version === version ||
        Date.now() - hit.computedAt < MemoryGraph.RANK_MIN_TTL_MS;
      if (serve) {
        // LRU refresh (fresh hit or stale-within-TTL serve).
        this.pprCache.delete(key);
        this.pprCache.set(key, hit);
        return hit.ranks;
      }
    }
    const entities = level
      ? this.store.listEntitiesScoped(level, this.cfg.maxEntities)
      : this.store.listEntities(this.cfg.maxEntities);
    const edges = this.scopedEdgesFor(level);
    const ranks = pageRank(
      entities.map((e) => e.id),
      edges,
      {
        damping: this.cfg.pagerankDamping,
        iterations: this.cfg.pagerankIterations,
        edgeDecayDays: this.cfg.pagerankEdgeDecayDays,
        seeds,
      },
    );
    this.pprCache.set(key, { version, ranks, computedAt: Date.now() });
    if (this.pprCache.size > PPR_CACHE_LIMIT) {
      const oldest = this.pprCache.keys().next().value;
      if (oldest !== undefined) this.pprCache.delete(oldest);
    }
    return ranks;
  }

  private scopedEdgesFor(level: ScopeLevelClause | null) {
    if (level) return this.store.listEdgesScoped(level);
    return this.store.listEdges().map((e) => ({
      from: e.from,
      to: e.to,
      weight: e.weight,
      lastSeenAt: e.createdAt,
    }));
  }

  /** PageRank normalized to [0, 1] over the scoped graph. */
  getNormalizedRanks(level: ScopeLevelClause | null = null): Map<string, number> {
    return normalizeRanks(this.getRanks(level));
  }

  /** Back-compat public entry point (whole-graph ranks). */
  computePageRank(iterations = 12): Map<string, number> {
    void iterations;
    return this.getRanks(null);
  }

  /** The highest-ranking entity id among `ids` on the scoped graph. */
  topRankedEntity(ids: string[], level: ScopeLevelClause | null = null): string | null {
    if (ids.length === 0) return null;
    const ranks = this.getNormalizedRanks(level);
    let best: string | null = null;
    let bestRank = -1;
    for (const id of ids) {
      const r = ranks.get(id) ?? -1;
      if (r > bestRank) {
        bestRank = r;
        best = id;
      }
    }
    return best;
  }

  /**
   * Build the retrieval prior: a zero-mean multiplier from a blended rank
   *
   *     r(e) = pw · ppr(e) + (1 − pw) · global(e)     (seeds present)
   *     r(e) = global(e)                              (otherwise)
   *
   * normalized per-map to [0,1], then multiplier = 1 + G·(r − r̄) clamped
   * to [1−G, 1+G] — graph centrality/proximity REORDERS results without
   * shifting overall score calibration. Items may list several candidate
   * entities; the strongest (max-rank) one speaks for the item.
   */
  buildRetrievalPrior(params: {
    seeds: string[];
    level: ScopeLevelClause | null;
    graphBoost: number;
    personalizationWeight: number;
  }): (entityIds: string[]) => { mult: number; detail: PriorDetail } {
    const { seeds, level, graphBoost, personalizationWeight } = params;
    const G = Math.max(0, Math.min(0.5, graphBoost));
    if (G <= 0) return () => ({ mult: 1, detail: {} });

    const globalNorm = this.getNormalizedRanks(level);
    if (globalNorm.size === 0) return () => ({ mult: 1, detail: {} });

    const pprNorm =
      seeds.length > 0 ? normalizeRanks(this.getPersonalizedRanks(seeds, level)) : null;
    const pw = pprNorm
      ? Math.max(0, Math.min(1, personalizationWeight))
      : 0;

    // Blend per entity, then compute the population mean.
    const blended = new Map<string, number>();
    for (const [id, g] of globalNorm) {
      const q = pprNorm?.get(id) ?? 0;
      blended.set(id, pw * q + (1 - pw) * g);
    }
    let sum = 0;
    for (const v of blended.values()) sum += v;
    const mean = sum / blended.size;

    // One batched fetch for id→name (a per-id getEntity loop here would
    // cost up to maxEntities point queries on every retrieval).
    const scopedEntities = level
      ? this.store.listEntitiesScoped(level, this.cfg.maxEntities)
      : this.store.listEntities(this.cfg.maxEntities);
    const nameById = new Map<string, string>();
    for (const ent of scopedEntities) nameById.set(ent.id, ent.name);

    return (entityIds: string[]) => {
      let bestRank = mean;
      let bestId: string | null = null;
      for (const id of entityIds) {
        const r = blended.get(id);
        if (r !== undefined && r > bestRank) {
          bestRank = r;
          bestId = id;
        }
      }
      const mult = Math.min(1 + G, Math.max(1 - G, 1 + G * (bestRank - mean)));
      if (!bestId) return { mult, detail: {} };
      return {
        mult,
        detail: {
          entityName: nameById.get(bestId),
          globalRank: Number((globalNorm.get(bestId) ?? 0).toFixed(3)),
          proximityRank: pprNorm
            ? Number((pprNorm.get(bestId) ?? 0).toFixed(3))
            : undefined,
        },
      };
    };
  }

  // ----- Analytics -----------------------------------------------------------

  /** Human-readable subgraph around an entity on the scoped graph. */
  describeSubgraph(
    rootName: string,
    hops = 1,
    maxNodes = 30,
    level: ScopeLevelClause | null = null,
  ): string {
    const root = level
      ? this.store.findEntityInScope(rootName, [level])
      : this.store.findEntityByName(rootName);
    if (!root) return '';
    const allEdges = level ? this.store.listEdgesScoped(level) : this.scopedEdgesFor(null);
    const edges = allEdges.map((e) => ({ from: e.from, to: e.to, weight: e.weight }));
    const nodes = new Map<string, Entity>();
    nodes.set(root.id, root);

    for (let h = 0; h < hops && nodes.size < maxNodes; h++) {
      // Frontier = node ids at the START of this hop (BFS semantics).
      // A Set gives O(1) membership checks inside the edge loop, so each
      // hop costs O(V + E) instead of O(V × E) from linear array scans;
      // nodes discovered mid-hop join the next hop's frontier.
      const frontierSet = new Set(nodes.keys());
      for (const e of edges) {
        if (nodes.size >= maxNodes) break;
        if (frontierSet.has(e.from) && !nodes.has(e.to)) {
          const ent = this.store.getEntity(e.to);
          if (ent) nodes.set(ent.id, ent);
        }
        if (nodes.size >= maxNodes) break;
        if (frontierSet.has(e.to) && !nodes.has(e.from)) {
          const ent = this.store.getEntity(e.from);
          if (ent) nodes.set(ent.id, ent);
        }
      }
    }

    const lines: string[] = [];
    lines.push(`Subgraph around "${rootName}":`);
    for (const [id, ent] of nodes) {
      const rels = edges
        .filter((e) => e.from === id || e.to === id)
        .slice(0, 5)
        .map((e) => `${e.from === id ? '→' : '←'}${'co-occurs'}(${e.weight.toFixed(1)})`)
        .join(' ');
      lines.push(`  - ${ent.name} [${ent.type}, ${ent.mentionCount} mentions] ${rels}`);
    }
    return lines.join('\n');
  }

  /** Resolve entity names at a scope level (multi-entity aggregation). */
  resolveNames(names: string[], level: ScopeLevelClause | null): Map<string, string> {
    if (!level) {
      const out = new Map<string, string>();
      for (const n of names) {
        const ent = this.store.findEntityByName(n);
        if (ent) out.set(n, ent.id);
      }
      return out;
    }
    return this.store.resolveEntityNames(names, level);
  }

  /** Convenience: widest cumulative level for an identity + scope kind. */
  levelFor(kind: 'user' | 'workspace' | 'session', ids: ScopeIdentity): ScopeLevelClause {
    return widestLevel(scopeLevels(kind, ids));
  }

  stats(level: ScopeLevelClause | null = null) {
    const entities = level
      ? this.store.listEntitiesScoped(level)
      : this.store.listEntities();
    const edges = level ? this.store.listEdgesScoped(level) : this.scopedEdgesFor(null);
    return {
      entities: entities.length,
      edges: edges.length,
      topEntities: entities.slice(0, 10).map((e) => ({ name: e.name, count: e.mentionCount })),
    };
  }
}

/** Extract candidate entities with provenance hints, ordered by first match. */
export function extract(text: string): ExtractedEntity[] {
  const byName = new Map<string, EntityHint>();
  const add = (name: string, hint: EntityHint) => {
    if (!byName.has(name)) byName.set(name, hint); // first hint wins
  };

  let m: RegExpExecArray | null;
  CODE_FENCE.lastIndex = 0;
  while ((m = CODE_FENCE.exec(text))) {
    const idents = m[1].match(IDENT_RE);
    if (idents) for (const i of idents) add(i, 'ident');
  }
  FILE_PATH.lastIndex = 0;
  while ((m = FILE_PATH.exec(text))) add(m[0], 'path');
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) add(m[0], 'url');
  HANDLE.lastIndex = 0;
  while ((m = HANDLE.exec(text))) add(m[0].slice(1), 'handle');
  HASHTAG.lastIndex = 0;
  while ((m = HASHTAG.exec(text))) add(m[0].slice(1), 'tag');

  // Capitalized words & identifiers
  const wordIdents = text.match(IDENT_RE);
  if (wordIdents) {
    for (const w of wordIdents) {
      const low = w.toLowerCase();
      if (STOPWORDS.has(low)) continue;
      if (w.length < 2) continue;
      add(w, 'ident');
    }
  }

  return [...byName].map(([name, hint]) => ({ name, hint }));
}

/** Classify using the extraction hint plus name shape. */
export function classify(name: string, hint: EntityHint): EntityType {
  switch (hint) {
    case 'handle':
      return 'person';
    case 'path':
      return 'file';
    case 'url':
      return 'other';
    case 'tag':
      return 'other';
    case 'ident':
      break;
  }
  if (/^[A-Z]{2,}$/.test(name)) return 'other'; // ACRONYM
  return 'concept';
}
