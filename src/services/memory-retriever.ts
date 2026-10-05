/**
 * MemoryRetriever — hybrid recall pipeline (kernel v3).
 *
 *   0. Semantic query cache: near-duplicate questions (cosine ≥ 0.985,
 *      anchor-bucket localized) are served from a data-version-stamped
 *      cache without re-running the pipeline.
 *   1. Per-space query embedding: the store may hold vectors from several
 *      embedding spaces (provider failover, model migration); the query is
 *      embedded once per space and only compared within it.
 *   2. Vector recall via SQL pushdown (mp_cosine inside SQLite), gated on
 *      RAW cosine similarity, with delta-tier progressive widening over
 *      the visibility ACL, optional since/until windows, and optional
 *      as-of FLASHBACK (store state reconstructed at a past instant via
 *      tombstone/supersession timestamps).
 *   3. Pseudo-relevance feedback (Rocchio): the centroid of the top hits
 *      is blended back into the query vector and the pool is re-scored —
 *      zero-LLM query expansion that pulls the query toward the cluster
 *      it landed in (mitigates vocabulary mismatch, the dominant weakness
 *      of sparse/hash embeddings).
 *   4. Entity-anchor hop expansion (graph-guided second pass): items
 *      LINKED to the top hits' entities that the vector gate missed join
 *      the candidate set with a bounded anchor weight — same topic,
 *      different wording.
 *   5. Decay-aware scoring with a zero-mean (P)PR prior; the decay clock
 *      is access-refreshed (max(createdAt, lastAccessedAt)).
 *   6. MMR diversification, then keyword rerank with quoted-phrase emphasis.
 */

import { cosine, type EmbeddingGateway } from '../utils/embedding.js';
import { tokenize } from '../utils/tokenizer.js';
import { approximateTokenCount } from '../utils/tokenizer.js';
import {
  scopeLevels,
  tierDisjunction,
  visibleAtLevel,
  type ScopeLevelClause,
  type VisibilityTier,
} from '../utils/scope.js';
import { feedbackVector } from '../utils/prf.js';
import { clamp01 } from '../utils/math.js';
import { SemanticQueryCache } from '../utils/query-cache.js';
import { NOOP_BUS, type MemoryEventBus, type MemoryScopeKind } from '../types/index.js';
import type {
  MemoryItem,
  MemoryLayer,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
} from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryGraph, PriorDetail } from './memory-graph.js';

export interface RetrieverConfig {
  topK: number;
  mmrLambda: number;
  minScore: number;
  rerank: boolean;
  graphBoost: number;
  /** 1 = pure PPR when seeds exist, 0 = pure global PR. */
  graphPersonalization: number;
  decayHalfLifeDays: number;
  scope: MemoryScopeKind;
  /** Pseudo-relevance feedback (Rocchio) second pass. */
  prf: {
    enabled: boolean;
    alpha: number;
    beta: number;
    depth: number;
  };
  /** Entity-anchor hop expansion (graph-guided second pass). */
  entityHop: boolean;
  /** Deterministic semantic cache for near-duplicate queries. */
  queryCache: boolean;
}

/** Anchor weight for hop-expanded items (no vector component). */
const ENTITY_HOP_WEIGHT = 0.55;

const DAY_MS = 86_400_000;

interface PoolEntry {
  item: MemoryItem;
  rawScore: number;
  /** Cascade level the item was found at (0 = narrowest tier). */
  level: number;
}

export class MemoryRetriever {
  private readonly qcache = new SemanticQueryCache<RetrievalResult>({
    capacity: 32,
    threshold: 0.985,
  });

  constructor(
    private store: MemoryStore,
    private gateway: EmbeddingGateway,
    private cfg: RetrieverConfig,
    private graph?: MemoryGraph,
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  async retrieve(q: RetrievalQuery): Promise<RetrievalResult> {
    const t0 = Date.now();
    const topK = q.topK ?? this.cfg.topK;
    const layers: MemoryLayer[] = q.layers ?? ['semantic', 'procedural'];
    const minScore = q.minScore ?? this.cfg.minScore;
    const mmrLambda = q.mmrLambda ?? this.cfg.mmrLambda;
    const rerank = q.rerank ?? this.cfg.rerank;

    this.bus.emit('memory.before-retrieve', {
      query: q.query,
      layers,
      topK,
      minScore,
      scope: q.scope,
    });

    // 1. Embed the query once per space present in the store.
    const queryBySpace = new Map<string, Float32Array>();
    if (q.queryEmbedding) {
      const space = q.queryEmbeddingSpace ?? this.gateway.spaces()[0];
      queryBySpace.set(space, q.queryEmbedding);
    }
    const storedSpaces = this.store.listEmbeddingSpaces();
    if (storedSpaces.length === 0) {
      // Empty store (or legacy rows only): fall back to the active space.
      storedSpaces.push(this.gateway.spaces()[0]);
    }
    for (const space of storedSpaces) {
      if (queryBySpace.has(space)) continue;
      const vec = await this.gateway.embedIn(space, q.query);
      if (vec) queryBySpace.set(space, vec);
    }
    if (queryBySpace.size === 0) {
      // No space servable right now (e.g. circuit open on the only space).
      const vec = await this.gateway.embed(q.query);
      queryBySpace.set(this.gateway.spaces()[0], vec);
    }

    // 0. Semantic query cache: a near-duplicate question under identical
    //    parameters skips the whole pipeline. The anchor buckets only
    //    LOCALIZE the lookup; the ≥0.985 cosine re-check decides, so a hit
    //    is always a genuine near-duplicate. Cached entries are stamped
    //    with the store's data version — any write invalidates them all.
    const primaryVec = queryBySpace.get(this.gateway.spaces()[0])!;
    const paramsKey = JSON.stringify([
      topK, minScore, mmrLambda, rerank, layers,
      q.scope ?? null, q.sinceMs ?? null, q.untilMs ?? null, q.asOfMs ?? null,
      q.boostEntityIds ?? [], q.emphasisPhrases ?? [],
    ]);
    const dataVersion = this.store.dataVersion();
    if (this.cfg.queryCache) {
      const cached = this.qcache.lookup(primaryVec, paramsKey, dataVersion);
      if (cached) {
        const served: RetrievalResult = {
          ...cached,
          elapsedMs: Date.now() - t0,
          debug: { ...(cached.debug ?? { vectorRecall: 0, rerankBoosted: 0, scopeLevel: 0 }), cacheHit: true },
        };
        this.bus.emit('memory.after-retrieve', {
          query: q.query,
          hits: served.hits.length,
          totalTokens: served.totalTokens,
          elapsedMs: served.elapsedMs,
          cacheHit: true,
        });
        return served;
      }
    }

    // 2-3. Vector recall with progressive scope widening over the
    //      visibility-tier ACL (session → workspace → user → global).
    const levels = scopeLevels(this.cfg.scope, q.scope ?? {});
    const scanLimit = Math.min(Math.max(512, topK * 64), 8192);
    const poolTarget = Math.max(topK * 3, 24);
    const pool = new Map<string, PoolEntry>();
    let scopeLevel = 0;

    /**
     * Scan-level exclusion of already-pooled rows (delta-tier widening).
     *
     * Each cascade level ORs in the next wider tier, so level k+1's
     * cumulative row set is the DISJOINT UNION of level k's rows and the
     * rows of the newly added tiers: a tier condition pairs one distinct
     * `visibility` value with its owner column, so no single row can
     * satisfy two different tiers. Scanning level k+1 with its full
     * cumulative clause would therefore re-score every row already pooled
     * at level k (the audited waste). Instead, every level scans only its
     * DELTA — the tiers it newly adds (level 0's delta is its whole
     * clause) — so rows from narrower tiers are excluded by the SQL WHERE
     * itself and each row is scored exactly once across the cascade.
     *
     * The union of pooled rows, and the level at which each entry entered
     * the pool, are identical to cumulative scanning; the only divergence
     * is strictly positive: a delta scan's LIMIT budget is spent on
     * genuinely new rows instead of being crowded out by already-pooled
     * narrower-tier rows. Hits already in the pool are still
     * post-filtered defensively (cheap Map lookup) so dedup never depends
     * on this disjointness argument holding in every edge case.
     */
    let scannedTiers: ReadonlySet<VisibilityTier> = new Set();
    for (let li = 0; li < levels.length; li++) {
      const level = levels[li];
      const deltaTiers = level.tiers.filter((t) => !scannedTiers.has(t));
      const delta = tierDisjunction(deltaTiers, level.ids);
      const scanScope: ScopeLevelClause | null = delta
        ? {
            sql: ` AND (${delta.sql})`,
            params: delta.params,
            index: level.index,
            tiers: deltaTiers,
            ids: level.ids,
          }
        : null;
      scannedTiers = new Set(level.tiers);
      if (scanScope) {
        for (const [space, queryVec] of queryBySpace) {
          for (const layer of layers) {
            const hits = this.store.scanBySimilarity({
              layer,
              space,
              queryVector: queryVec,
              minScore,
              limit: scanLimit,
              scope: scanScope,
              sinceMs: q.sinceMs,
              untilMs: q.untilMs,
              asOfMs: q.asOfMs,
            });
            for (const h of hits) {
              // Defensive dedup: a row is pooled exactly once, at the
              // narrowest level whose tier makes it visible.
              if (pool.has(h.item.id)) continue;
              if (!passesFilters(h.item, q.filters)) continue;
              pool.set(h.item.id, { item: h.item, rawScore: h.rawScore, level: li });
            }
          }
        }
      }
      scopeLevel = li + 1;
      if (pool.size >= poolTarget) break;
    }

    // 3. Pseudo-relevance feedback (Rocchio): blend the centroid of the
    //    top hits back into each space's query vector and re-score the
    //    pool's raw cosines — pure local math, no re-embedding. Feedback
    //    is computed PER SPACE (centroids are meaningless across spaces)
    //    and only when the pool is deep enough to vote.
    let prfApplied = false;
    if (this.cfg.prf.enabled && pool.size >= this.cfg.prf.depth) {
      const byScore = [...pool.values()].sort((a, b) => b.rawScore - a.rawScore);
      const topBySpace = new Map<string, Float32Array[]>();
      for (const e of byScore) {
        const space = e.item.metadata.embeddingSpace ?? this.gateway.spaces()[0];
        const list = topBySpace.get(space) ?? [];
        if (list.length < this.cfg.prf.depth) {
          if (e.item.embedding) list.push(e.item.embedding);
        }
        topBySpace.set(space, list);
      }
      const feedbackBySpace = new Map<string, Float32Array>();
      for (const [space, vecs] of topBySpace) {
        const qv = queryBySpace.get(space);
        if (!qv || vecs.length === 0) continue;
        feedbackBySpace.set(
          space,
          feedbackVector(qv, vecs, {
            alpha: this.cfg.prf.alpha,
            beta: this.cfg.prf.beta,
            depth: this.cfg.prf.depth,
          }),
        );
      }
      if (feedbackBySpace.size > 0) {
        for (const e of pool.values()) {
          const fv = feedbackBySpace.get(
            e.item.metadata.embeddingSpace ?? this.gateway.spaces()[0],
          );
          if (fv && e.item.embedding) {
            e.rawScore = cosine(fv, e.item.embedding);
          }
        }
        prfApplied = true;
      }
    }

    // 4. Decay + blended zero-mean (P)PR prior, with per-hit decomposition.
    //    Multi-entity aggregation: an item's rank is the best rank among
    //    ALL entities it mentions (linked entityId + metadata.entities).
    const prior = this.graph
      ? this.graph.buildRetrievalPrior({
          seeds: q.boostEntityIds ?? [],
          level: levels[Math.max(0, scopeLevel - 1)] ?? null,
          graphBoost: this.cfg.graphBoost,
          personalizationWeight: this.cfg.graphPersonalization,
        })
      : null;
    const nameToId = this.graph
      ? this.graph.resolveNames(collectEntityNames(pool.values()), levels[Math.max(0, scopeLevel - 1)] ?? null)
      : new Map<string, string>();

    const candidates: RetrievalHit[] = [];
    for (const { item, rawScore, level } of pool.values()) {
      const decayAnchor = Math.max(item.createdAt, item.lastAccessedAt || 0);
      const decayFactor = decayFactorFor(decayAnchor, this.cfg.decayHalfLifeDays);
      const importanceFactor = importanceFactorFor(item.importance);
      let graphMultiplier = 1;
      let detail: PriorDetail | undefined;
      if (prior) {
        const out = prior(entityIdsFor(item, nameToId));
        graphMultiplier = out.mult;
        detail = out.detail;
      }
      const boosted = clamp01(rawScore * decayFactor * importanceFactor * graphMultiplier);
      candidates.push({
        item,
        rawScore,
        score: boosted,
        mmrRank: 0,
        finalScore: boosted,
        scopeLevel: level,
        via: 'vector',
        explain: q.explain
          ? { rawScore, decayFactor, importanceFactor, graphMultiplier, graph: detail }
          : undefined,
      });
    }
    candidates.sort((a, b) => b.score - a.score);

    // 4b. Entity-anchor hop expansion (graph-guided second pass): items
    //     LINKED to the top hits' entities that never entered the vector
    //     pool join the candidates with a bounded anchor weight — recalls
    //     "same topic, different wording" that the vector gate (especially
    //     with sparse fallback embeddings) misses.
    let entityHop = 0;
    const widestUsed = levels[Math.max(0, scopeLevel - 1)] ?? null;
    if (this.cfg.entityHop && this.graph && widestUsed && candidates.length > 0) {
      const anchorEntities = new Set<string>();
      for (const c of candidates.slice(0, 2)) {
        for (const id of entityIdsFor(c.item, nameToId)) anchorEntities.add(id);
      }
      let hopBudget = topK;
      for (const eid of [...anchorEntities].slice(0, 4)) {
        if (hopBudget <= 0) break;
        for (const item of this.store.itemsForEntityScoped(widestUsed, eid, 20)) {
          if (hopBudget <= 0) break;
          if (pool.has(item.id)) continue;
          if (!visibleAtLevel(
            {
              visibility: item.visibility ?? item.metadata.visibility ?? null,
              userId: item.metadata.userId ?? null,
              workspaceId: item.metadata.workspaceId ?? null,
              sessionId: item.metadata.sessionId ?? null,
            },
            widestUsed,
          )) {
            continue;
          }
          if (q.asOfMs !== undefined && item.createdAt > q.asOfMs) continue;
          pool.set(item.id, { item, rawScore: 0, level: scopeLevel - 1 });
          const decayAnchor = Math.max(item.createdAt, item.lastAccessedAt || 0);
          const decayFactor = decayFactorFor(decayAnchor, this.cfg.decayHalfLifeDays);
          const importanceFactor = importanceFactorFor(item.importance);
          let graphMultiplier = 1;
          let detail: PriorDetail | undefined;
          if (prior) {
            const out = prior(entityIdsFor(item, nameToId));
            graphMultiplier = out.mult;
            detail = out.detail;
          }
          const score = clamp01(
            ENTITY_HOP_WEIGHT * decayFactor * importanceFactor * graphMultiplier,
          );
          candidates.push({
            item,
            rawScore: 0,
            score,
            mmrRank: 0,
            finalScore: score,
            scopeLevel: scopeLevel - 1,
            via: 'entity-hop',
            explain: q.explain
              ? { rawScore: 0, decayFactor, importanceFactor, graphMultiplier, graph: detail }
              : undefined,
          });
          entityHop++;
          hopBudget--;
        }
      }
      if (entityHop > 0) candidates.sort((a, b) => b.score - a.score);
    }

    // 5. MMR diversification
    const mmred = mmr(candidates, topK * 2, mmrLambda);
    for (let i = 0; i < mmred.length; i++) {
      mmred[i].mmrRank = i + 1;
    }

    // 6. Keyword rerank (optional): token-overlap score fused with the
    //    decay/prior score, plus quoted-phrase emphasis. A phrase counts as
    //    a hit only when its FULL token set is contained in the item's token
    //    set (bag-of-words containment, order-agnostic); each hit adds a
    //    bounded 0.25 to the keyword score before it is clamped to [0,1].
    //    Phrases influence ONLY this stage — vector recall is
    //    phrase-agnostic — and when rerank is disabled they have no effect.
    let ranked = mmred;
    let rerankBoosted = 0;
    if (rerank) {
      const queryTokens = new Set(tokenize(q.query));
      const emphasisPhrases = q.emphasisPhrases ?? [];
      const phrasesRequested = emphasisPhrases.length > 0;
      // Phrases that tokenize to nothing (e.g. bare punctuation or single
      // letters) carry no evidence and are dropped so the empty set cannot
      // count as a free containment hit against every item.
      const phraseTokenSets = emphasisPhrases
        .map((p) => tokenize(p))
        .filter((tokens) => tokens.length > 0);
      ranked = mmred
        .map((h) => {
          const itemTokens = new Set(tokenize(h.item.content));
          let overlap = 0;
          for (const t of queryTokens) if (itemTokens.has(t)) overlap++;
          const denom = Math.max(1, Math.min(itemTokens.size, queryTokens.size));
          const overlapScore = overlap / denom;
          let phraseHits = 0;
          for (const tokens of phraseTokenSets) {
            if (tokens.every((t) => itemTokens.has(t))) phraseHits++;
          }
          const keywordScore = clamp01(overlapScore + 0.25 * phraseHits);
          const fused = 0.7 * h.score + 0.3 * keywordScore;
          if (fused > h.finalScore) rerankBoosted++;
          const explain = h.explain
            ? {
                ...h.explain,
                keywordScore,
                ...(phrasesRequested ? { phraseHits } : {}),
                graph: h.explain.graph,
              }
            : undefined;
          return { ...h, finalScore: fused, explain };
        })
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, topK);
    } else {
      // Rerank disabled: the keyword stage never runs, so emphasisPhrases
      // are inert by construction.
      ranked = mmred.slice(0, topK);
    }

    // 7. touch access counters for returned items; reinforce=true bumps
    //    importance by a bounded epsilon (+0.01, cap 0.95), so each
    //    retrieval strengthens the memory (the testing effect).
    for (const h of ranked) this.store.touchAccess(h.item.id, true);

    const totalTokens = ranked.reduce(
      (s, h) => s + (h.item.metadata.tokenCount ?? approximateTokenCount(h.item.content)),
      0,
    );

    const result: RetrievalResult = {
      hits: ranked,
      totalTokens,
      elapsedMs: Date.now() - t0,
      debug: {
        vectorRecall: pool.size - entityHop,
        rerankBoosted,
        scopeLevel,
        prfApplied,
        entityHop,
      },
    };
    // Cache a LIGHT copy (embeddings stripped — they are the bulk of the
    // memory footprint and consumers of cached results don't re-score).
    if (this.cfg.queryCache) {
      this.qcache.store(primaryVec, paramsKey, dataVersion, {
        ...result,
        hits: result.hits.map((h) => ({
          ...h,
          item: { ...h.item, embedding: undefined },
        })),
      });
    }
    this.bus.emit('memory.after-retrieve', {
      query: q.query,
      hits: ranked.length,
      totalTokens,
      elapsedMs: result.elapsedMs,
      scopeLevel,
      prfApplied,
      entityHop,
    });
    return result;
  }

  /** Format retrieved items as a single context block for prompt injection. */
  formatAsContext(result: RetrievalResult, maxTokens: number): string {
    const lines: string[] = [];
    let used = 0;
    for (const h of result.hits) {
      const header = `[memory:${h.item.layer} score=${h.finalScore.toFixed(2)}]`;
      const body = `${header} ${h.item.content}`;
      const cost = approximateTokenCount(body);
      if (used + cost > maxTokens) break;
      lines.push(body);
      used += cost;
    }
    return lines.join('\n');
  }
}

/**
 * testing-effect decay: recall refreshes the memory's decay clock, mimicking
 * spaced-repetition strengthening.
 */
function decayFactorFor(anchoredAt: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageDays = Math.max(0, (Date.now() - anchoredAt) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Union of entity names mentioned across pool items (bounded). */
function collectEntityNames(entries: Iterable<PoolEntry>): string[] {
  const names = new Set<string>();
  for (const { item } of entries) {
    for (const n of item.metadata.entities ?? []) {
      names.add(n);
      if (names.size >= 50) return [...names];
    }
  }
  return [...names];
}

/** Candidate entity ids for an item: linked entity + resolved mentions. */
function entityIdsFor(item: MemoryItem, nameToId: Map<string, string>): string[] {
  const ids: string[] = [];
  if (item.entityId) ids.push(item.entityId);
  for (const n of item.metadata.entities ?? []) {
    const id = nameToId.get(n);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function importanceFactorFor(importance: number): number {
  // Importance amplifies recall; bounded to [0.5, 1.0] so high-importance
  // items are not artificially boosted past the similarity score.
  return 0.5 + 0.5 * Math.min(1, Math.max(0, importance));
}

/** Maximal Marginal Relevance. Picks items that are relevant AND novel. */
function mmr(items: RetrievalHit[], topN: number, lambda: number): RetrievalHit[] {
  if (items.length === 0) return [];
  const selected: RetrievalHit[] = [];
  const remaining = [...items];

  // Seed with the highest scoring item
  remaining.sort((a, b) => b.score - a.score);
  selected.push(remaining.shift()!);

  while (selected.length < topN && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let maxSimToSelected = 0;
      for (const sel of selected) {
        const s = cand.item.embedding && sel.item.embedding
          ? cosine(cand.item.embedding, sel.item.embedding)
          : 0;
        if (s > maxSimToSelected) maxSimToSelected = s;
      }
      const mmrScore = lambda * cand.score - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected;
}

function passesFilters(item: MemoryItem, filters?: Record<string, unknown>): boolean {
  if (!filters) return true;
  for (const [k, v] of Object.entries(filters)) {
    const mv = (item.metadata as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      if (!(v as unknown[]).includes(mv)) return false;
    } else if (mv !== v) {
      return false;
    }
  }
  return true;
}
