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
import { STEM_RULESET_VERSION, stemAll } from '../utils/stemmer.js';
import {
  scopeLevels,
  tierDisjunction,
  visibleAtLevel,
  type ScopeLevelClause,
  type VisibilityTier,
} from '../utils/scope.js';
import { feedbackVector } from '../utils/prf.js';
import { IVF_MAX_RADIUS, keysWithin as countKeysWithin, probeOrder } from '../utils/ivf.js';
import { clamp01, clampNum } from '../utils/math.js';
import { ARM_RAILS } from '../utils/bandit.js';
import { SemanticQueryCache } from '../utils/query-cache.js';
import { invariant } from '../utils/invariants.js';
import { NOOP_BUS, type MemoryEventBus, type MemoryScope, type MemoryScopeKind } from '../types/index.js';
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
  /** IVF accelerator gate (see types/index.ts). */
  ivf: { enabled: boolean; radius: number; minItems: number };
}

/** Anchor weight for hop-expanded items (no vector component). */
const ENTITY_HOP_WEIGHT = 0.55;

const DAY_MS = 86_400_000;

/** First gateway space, guaranteed non-empty by construction. */
function primarySpace(gateway: EmbeddingGateway): string {
  const first = gateway.spaces()[0];
  invariant(first !== undefined, 'embedding gateway always exposes a space');
  return first;
}

/**
 *  Deterministic serialization of fusionOverrides for the query-cache
 *  paramsKey: keys are sorted before stringifying so two callers that
 *  build the same override map in different insertion orders still share
 *  one cache entry (JSON.stringify alone would bake key order in), and
 *  fields whose value is `undefined` are DROPPED so `{arm: undefined}` —
 *  which JSON.stringify would render as an omitted property — and a map
 *  that simply lacks the arm produce the SAME key. Finally, an override
 *  map with no usable arms (`undefined`, `{}`, all-undefined values) all
 *  collapse onto the single sentinel `'null'`: those are three spellings
 *  of "no overrides", and letting them serialize differently would split
 *  one effective configuration across two cache partitions that can
 *  never hit each other.
 */
function stableFusionKey(
  overrides: Partial<Record<string, number>> | undefined,
): string {
  if (!overrides) return 'null';
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(overrides).sort()) {
    const v = overrides[k];
    if (v !== undefined) sorted[k] = v;
  }
  return Object.keys(sorted).length === 0 ? 'null' : JSON.stringify(sorted);
}

/**
 *  Deterministic serialization of q.filters for the query-cache paramsKey.
 *
 *  Two requirements pull in opposite directions; the resolution below is
 *  deliberate:
 *
 *  - KEY ORDER must not matter — two callers building the same filter map
 *    in different insertion orders are ONE configuration — so keys are
 *    sorted before stringifying (JSON.stringify alone would bake key
 *    order into the key and split one config across two partitions).
 *  - UNDEFINED VALUES MUST SURVIVE the key. passesFilters() gives
 *    `{ tag: undefined }` a real, distinct semantics ("the item must NOT
 *    carry the tag key at all") — plainly different from `{}` (no
 *    constraints) and from "no filters". Plain JSON.stringify omits
 *    undefined-valued properties, so the OLD `JSON.stringify(q.filters
 *    ?? null)` collapsed `{tag: undefined}` and `{}` onto the SAME cache
 *    key while the pipeline treated them differently — a cross-partition
 *    correctness bug, not just wasted warmth. The fix serializes every
 *    key but renders an undefined value as an explicit null MARKER:
 *    `{tag: undefined}` → `'{"tag":null}'`, distinct from `'{}'` and from
 *    the no-filters sentinel `'null'`. Residual tradeoff accepted: a
 *    filter value that is literally null now shares a key with an
 *    undefined one — in passesFilters they differ only for items whose
 *    metadata holds an explicit null, which no metadata writer produces.
 */
function stableFiltersKey(
  filters: Record<string, unknown> | undefined,
): string {
  if (!filters) return 'null';
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(filters).sort()) {
    const v = filters[k];
    sorted[k] = v === undefined ? null : v;
  }
  return JSON.stringify(sorted);
}

/**
 *  Deterministic serialization of q.scope for the query-cache paramsKey:
 *  keys sorted, because `{userId, sessionId}` and `{sessionId, userId}`
 *  are the same scope and must share one cache partition. Unlike
 *  filters, undefined-valued scope fields are semantically INERT here —
 *  every consumer reads them through optional chaining — so letting
 *  JSON.stringify drop them (making `{userId: undefined, sessionId: 's'}`
 *  and `{sessionId: 's'}` one key) is correct, not a loss.
 */
function stableScopeKey(scope: MemoryScope | undefined): string {
  if (!scope) return 'null';
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(scope).sort()) {
    sorted[k] = scope[k as keyof MemoryScope];
  }
  return JSON.stringify(sorted);
}

/**
 *  Bandit-arm override clamped into the arm's hard rails (ARM_RAILS in
 *  utils/bandit.ts). fusionOverrides is an open map: the FeedbackLearner
 *  clamps its own writes, but any other caller can hand the retriever an
 *  out-of-track value — and neither feedbackVector() nor the keyword
 *  fusion below applies ANY clamping of its own, so a negative or
 *  oversized value would poison the Rocchio blend or the fused score
 *  directly. Applies to ALL FIVE arms — prfAlpha/prfBeta, the rerank
 *  fusion arms (vectorWeight/keywordWeight), and the (P)PR prior gain
 *  graphBoost. The static config fallback passes through UNTOUCHED: only
 *  learned overrides are rail-bound, so a config that deliberately sits
 *  outside the rails keeps behaving exactly as configured.
 */
function clampedArmOverride(
  overrides: Partial<Record<string, number>> | undefined,
  arm: 'vectorWeight' | 'keywordWeight' | 'graphBoost' | 'prfAlpha' | 'prfBeta',
  fallback: number,
): number {
  const v = overrides?.[arm];
  if (v === undefined) return fallback;
  return clampNum(v, ARM_RAILS[arm].min, ARM_RAILS[arm].max);
}

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

    if (!q.speculative) {
      this.bus.emit('memory.before-retrieve', {
        query: q.query,
        layers,
        topK,
        minScore,
        scope: q.scope,
      });
    }

    // 1. Embed the query once per space present in the store.
    const queryBySpace = new Map<string, Float32Array>();
    if (q.queryEmbedding) {
      const space = q.queryEmbeddingSpace ?? primarySpace(this.gateway);
      queryBySpace.set(space, q.queryEmbedding);
    }
    const storedSpaces = this.store.listEmbeddingSpaces();
    if (storedSpaces.length === 0) {
      // Empty store (or legacy rows only): fall back to the active space.
      storedSpaces.push(primarySpace(this.gateway));
    }
    for (const space of storedSpaces) {
      if (queryBySpace.has(space)) continue;
      const vec = await this.gateway.embedIn(space, q.query);
      if (vec) queryBySpace.set(space, vec);
    }
    if (queryBySpace.size === 0) {
      // No space servable right now (e.g. circuit open on the only space).
      // embed() either resolves a real Float32Array or throws, so the map
      // always receives a vector here (same contract the per-space embed
      // above relies on through its null check).
      const vec = await this.gateway.embed(q.query);
      queryBySpace.set(primarySpace(this.gateway), vec);
    }
    if (queryBySpace.size === 0) {
      // Embedding entirely unavailable (all spaces failed AND the primary
      // fallback returned nothing): recall nothing instead of violating
      // the primaryVec assertion below with an undefined vector.
      const empty: RetrievalResult = {
        hits: [],
        totalTokens: 0,
        elapsedMs: Date.now() - t0,
        debug: { vectorRecall: 0, rerankBoosted: 0, scopeLevel: 0 },
      };
      if (!q.speculative) {
        this.bus.emit('memory.after-retrieve', {
          query: q.query,
          hits: 0,
          totalTokens: 0,
          elapsedMs: empty.elapsedMs,
          scopeLevel: 0,
          prfApplied: false,
          entityHop: 0,
        });
      }
      return empty;
    }

    // 0. Semantic query cache: a near-duplicate question under identical
    //    parameters skips the whole pipeline. The anchor buckets only
    //    LOCALIZE the lookup; the ≥0.985 cosine re-check decides, so a hit
    //    is always a genuine near-duplicate. Cached entries are stamped
    //    with the store's COMPOSITE version stamp (dataVersionStamp() →
    //    `<epoch>:<version>`) — any write invalidates them all, and the
    //    epoch half keeps the identity wrap-proof at the 32-bit
    //    user_version ceiling.
    // Cache anchor vector: the primary space when it embedded, else any
    // servable space's vector (failover). At this point the map is
    // guaranteed non-empty by the early return above (the invariant below
    // pins that contract) — the same query text anchors consistently in
    // whichever space served it, and near-duplicate checks never cross
    // spaces.
    // Determinism of the "any" pick: queryBySpace is a Map, and Map
    // iteration order is INSERTION order — an explicit queryEmbedding
    // space first, then the store's spaces in listEmbeddingSpaces() order
    // (one fixed SQL plan per database state). For a given store state
    // and query, the fallback therefore always selects the SAME space's
    // vector; it is arbitrary only across different store states, never
    // between two identical calls.
    const fallbackVec = [...queryBySpace.values()][0];
    invariant(fallbackVec !== undefined, 'queryBySpace is non-empty (early return above)');
    const primaryVec = queryBySpace.get(primarySpace(this.gateway)) ?? fallbackVec;
    const paramsKey = JSON.stringify([
      topK, minScore, mmrLambda, rerank, layers,
      // Stem-domain matching version: the keyword rerank below matches
      // query/item tokens in FOLDED (stemmed) space, so which items a
      // query matches depends on the stem ruleset — a behavior the data
      // version does NOT cover (stemming changes no stored rows). Pinning
      // the ruleset constant into the cache identity means a future rule
      // change or rollback can never serve results that were scored under
      // the other folding rules as cache hits. The rest of paramsKey
      // (query identity semantics) is untouched: stem is match-time
      // behavior, not query identity (I-NT-12).
      STEM_RULESET_VERSION,
      stableScopeKey(q.scope), q.sinceMs ?? null, q.untilMs ?? null, q.asOfMs ?? null,
      q.boostEntityIds ?? [], q.emphasisPhrases ?? [],
      // Filters and learned fusion overrides change WHICH items a query
      // may return and how they score, so they belong to the cache
      // identity: without them a filtered query could be served an
      // unfiltered near-duplicate's entry (and vice versa). Filters and
      // scope go through their stable serializers (sorted keys; filters
      // keep undefined-valued keys via a null marker — see
      // stableFiltersKey). explain is included too (it changes the
      // returned payload shape).
      stableFiltersKey(q.filters),
      stableFusionKey(q.fusionOverrides),
      q.explain ?? false,
    ]);
    const dataStamp = this.store.dataVersionStamp();
    if (this.cfg.queryCache) {
      const cached = this.qcache.lookup(primaryVec, paramsKey, dataStamp);
      if (cached) {
        // Shallow-copy every SERVED hit (and its item): the stored entry
        // stays owned by the cache, so a caller mutating a returned hit
        // must never write through into the entry and corrupt every
        // future serve of it.
        const served: RetrievalResult = {
          ...cached,
          hits: cached.hits.map((h) => ({ ...h, item: { ...h.item } })),
          elapsedMs: Date.now() - t0,
          debug: { ...(cached.debug ?? { vectorRecall: 0, rerankBoosted: 0, scopeLevel: 0 }), cacheHit: true },
        };
        if (!q.speculative) {
          // A cache hit is still a REAL user query: log it into the
          // trajectory so near-duplicate re-asks keep training the Markov
          // predictor — previously they vanished from the trajectory
          // exactly when the cache happened to be warm, silently biasing
          // the learned sequences toward cache-cold phrasings. logQuery
          // does NOT bump the store's dataVersion, so this cannot
          // self-invalidate the cache it was just served from.
          const { userId, workspaceId } = q.scope ?? {};
          this.store.logQuery({
            sessionId: q.scope?.sessionId ?? '',
            ...(userId !== undefined ? { userId } : {}),
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            query: q.query,
          });
          this.bus.emit('memory.after-retrieve', {
            query: q.query,
            hits: served.hits.length,
            totalTokens: served.totalTokens,
            elapsedMs: served.elapsedMs,
            cacheHit: true,
          });
        }
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
      // li < levels.length pins the slot; the guard never fires.
      if (level === undefined) continue;
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
            // scanWithIvf owns pooling (across escalation radii AND the
            // exact fallback) so widened probes never re-score a row.
            this.scanWithIvf(
              layer, space, queryVec, minScore, scanLimit, scanScope, q,
              pool, poolTarget, li,
            );
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
      // Learned fusion overrides (bandit) replace the static Rocchio blend
      // weights when present — prfAlpha/prfBeta are two of the five arms
      // and now actually steer retrieval. The override value is clamped
      // INTO the arm rails here (defense in depth: feedbackVector does no
      // clamping of its own, so an out-of-track value must never reach it
      // directly); an absent override keeps the static config value.
      const prfAlpha = clampedArmOverride(q.fusionOverrides, 'prfAlpha', this.cfg.prf.alpha);
      const prfBeta = clampedArmOverride(q.fusionOverrides, 'prfBeta', this.cfg.prf.beta);
      const byScore = [...pool.values()].sort((a, b) => b.rawScore - a.rawScore);
      const topBySpace = new Map<string, Float32Array[]>();
      for (const e of byScore) {
        const space = e.item.metadata.embeddingSpace ?? primarySpace(this.gateway);
        // Dimension guard BEFORE the row may vote for a space's centroid:
        // the space's query vector and the row's embedding must agree in
        // arity. NULL-space legacy rows (or half-finished migrations) can
        // claim a space whose query has a different dimensionality —
        // letting them in would corrupt that space's centroid. Skip the
        // row rather than score it in the wrong space.
        const qv = queryBySpace.get(space);
        if (!qv || !e.item.embedding || e.item.embedding.length !== qv.length) {
          continue;
        }
        const list = topBySpace.get(space) ?? [];
        if (list.length < this.cfg.prf.depth) list.push(e.item.embedding);
        topBySpace.set(space, list);
      }
      const feedbackBySpace = new Map<string, Float32Array>();
      for (const [space, vecs] of topBySpace) {
        const qv = queryBySpace.get(space);
        if (!qv || vecs.length === 0) continue;
        feedbackBySpace.set(
          space,
          feedbackVector(qv, vecs, {
            alpha: prfAlpha,
            beta: prfBeta,
            depth: this.cfg.prf.depth,
          }),
        );
      }
      if (feedbackBySpace.size > 0) {
        // DELIBERATE ("PRF threshold softening", registered as an I-series
        // invariant): NO second minScore filter runs on the re-scored
        // rows below. minScore semantics anchor to the PRE-PRF raw cosine
        // (the SQL gate above); a pool row re-scored below minScore by the
        // Rocchio blend stays in the fusion by design — this is the
        // softening working, not a missed filter. Do not "fix".
        for (const e of pool.values()) {
          const fv = feedbackBySpace.get(
            e.item.metadata.embeddingSpace ?? primarySpace(this.gateway),
          );
          // Same arity guard on the re-score pass: a mismatched row keeps
          // its SQL-computed rawScore instead of getting a garbage cosine
          // against another space's feedback vector.
          if (fv && e.item.embedding && e.item.embedding.length === fv.length) {
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
      ? this.graph.buildRetrievalPrior(
          {
            seeds: q.boostEntityIds ?? [],
            level: levels[Math.max(0, scopeLevel - 1)] ?? null,
            graphBoost: this.cfg.graphBoost,
            personalizationWeight: this.cfg.graphPersonalization,
          },
          {
            // graphBoost is a learned bandit arm like the other four:
            // the override replaces the static config value when present
            // and goes through the SAME ARM_RAILS clamp. Relying only on
            // buildRetrievalPrior's internal [0, 0.5] backstop would open
            // a rail vacuum above 0.25 — values the bandit itself can
            // never learn (its own writes are railed) but a raw
            // fusionOverrides caller could silently serve.
            graphBoost: clampedArmOverride(
              q.fusionOverrides,
              'graphBoost',
              this.cfg.graphBoost,
            ),
          },
        )
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
        ...(q.explain
          ? {
              explain: {
                rawScore,
                decayFactor,
                importanceFactor,
                graphMultiplier,
                ...(detail !== undefined ? { graph: detail } : {}),
              },
            }
          : {}),
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
    // FLASHBACK exclusion: under asOfMs, itemsForEntityScoped evaluates its
    // CURRENT LIVE predicates (tombstone/supersession state as of NOW), so
    // hop candidates cannot be faithfully reconstructed at the historical
    // instant. The vector scan rebuilds history via SQL; the hop path has
    // no such reconstruction — prefer skipping the expansion entirely over
    // leaking items that did not exist (or have since changed state) at
    // the requested instant.
    if (
      this.cfg.entityHop && this.graph && widestUsed && candidates.length > 0 &&
      q.asOfMs === undefined
    ) {
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
          // Hop candidates must satisfy the SAME constraints the vector
          // scan pushes down to SQL — otherwise the hop path is a bypass
          // that re-admits items the query explicitly excluded. The chain
          // below mirrors the vector path's order — tier ACL first (the
          // SQL WHERE enforces visibility before anything else in the
          // main scan), then the JS-side metadata filters, then the
          // layer/time windows — though admission is what matters: all
          // five are pure predicates over the item, so the admitted SET
          // is identical under any ordering.
          if (!visibleAtLevel(
            {
              // Legacy pre-0.20 rows may carry their tier ONLY in the
              // metadata copy; item.visibility (the column) wins whenever
              // present, so dropping the fallback would re-tier those rows
              // as global.
              // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate legacy-row fallback read
              visibility: item.visibility ?? item.metadata.visibility ?? null,
              userId: item.metadata.userId ?? null,
              workspaceId: item.metadata.workspaceId ?? null,
              sessionId: item.metadata.sessionId ?? null,
            },
            widestUsed,
          )) {
            continue;
          }
          if (!passesFilters(item, q.filters)) continue;
          if (!layers.includes(item.layer)) continue;
          if (q.sinceMs !== undefined && item.createdAt < q.sinceMs) continue;
          if (q.untilMs !== undefined && item.createdAt > q.untilMs) continue;
          // (No asOfMs check needed here: flashback queries never reach
          // the hop block at all — see the exclusion above.)
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
            ...(q.explain
              ? {
                  explain: {
                    rawScore: 0,
                    decayFactor,
                    importanceFactor,
                    graphMultiplier,
                    ...(detail !== undefined ? { graph: detail } : {}),
                  },
                }
              : {}),
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
      const h = mmred[i];
      // i < mmred.length pins the slot; the guard never fires.
      if (h === undefined) continue;
      h.mmrRank = i + 1;
    }

    // 6. Keyword rerank (optional): token-overlap score fused with the
    //    Learned fusion weights (bandit) override the static blend when
    //    provided. Both arms are clamped INTO their rails here — the same
    //    defense-in-depth prfAlpha/prfBeta get above — because the rails
    //    bound each arm INDIVIDUALLY (vectorWeight ≤ 0.85,
    //    keywordWeight ≤ 0.45) while their SUM can reach 1.30: an
    //    unclamped or hostile override could push the fused score past 1
    //    (or negative). clamp01 on the fusion closes both ends, so
    //    finalScore stays a probability in [0, 1] no matter what the
    //    bandit — or a raw fusionOverrides caller — hands in.
    //    The keyword score is token overlap plus quoted-phrase emphasis:
    //    a phrase counts as a hit only when its FULL token set is
    //    contained in the item's token set (bag-of-words containment,
    //    order-agnostic); each hit adds a bounded 0.25 to the keyword
    //    score before it is clamped to [0,1]. Phrases influence ONLY
    //    this stage — vector recall is phrase-agnostic — and when rerank
    //    is disabled they have no effect.
    //    Stem domain: both comparisons below run on FOLDED tokens
    //    (stemAll) so inflectional variants count as the same term —
    //    "how does aurora deploy?" matches content saying "deploys".
    //    Folding is match-time only: tokenize, the offline BM25 hashing
    //    and every embedding input stay raw-domain (I-NT-12).
    const vw = clampedArmOverride(q.fusionOverrides, 'vectorWeight', 0.7);
    const kw = clampedArmOverride(q.fusionOverrides, 'keywordWeight', 0.3);
    let ranked = mmred;
    let rerankBoosted = 0;
    if (rerank) {
      const queryTokens = new Set(tokenize(q.query));
      const queryStems = new Set(stemAll([...queryTokens]));
      const emphasisPhrases = q.emphasisPhrases ?? [];
      const phrasesRequested = emphasisPhrases.length > 0;
      // Phrases that tokenize to nothing (e.g. bare punctuation or single
      // letters) carry no evidence and are dropped so the empty set cannot
      // count as a free containment hit against every item.
      const phraseStemLists = emphasisPhrases
        .map((p) => stemAll(tokenize(p)))
        .filter((stems) => stems.length > 0);
      ranked = mmred
        .map((h) => {
          const itemTokens = new Set(tokenize(h.item.content));
          const itemStems = new Set(stemAll([...itemTokens]));
          // Numerator in the stem domain: distinct folded query terms the
          // item also carries. The DENOMINATOR keeps the original
          // (unstemmed) token-set sizes: the formula's meaning — share of
          // the smaller side's vocabulary that matches — is defined on
          // what was actually written, and stemming can only merge
          // numerator terms, never inflate the denominator (folded sets
          // are never larger than their raw sources, so overlap ≤ denom
          // still holds).
          let overlap = 0;
          for (const t of queryStems) if (itemStems.has(t)) overlap++;
          const denom = Math.max(1, Math.min(itemTokens.size, queryTokens.size));
          const overlapScore = overlap / denom;
          let phraseHits = 0;
          for (const stems of phraseStemLists) {
            if (stems.every((t) => itemStems.has(t))) phraseHits++;
          }
          const keywordScore = clamp01(overlapScore + 0.25 * phraseHits);
          // clamp01: the railed weights sum to at most 1.30 (0.85 + 0.45)
          // and both inputs live in [0,1], so the fusion itself can land
          // above 1 — the clamp keeps finalScore a probability.
          const fused = clamp01(vw * h.score + kw * keywordScore);
          if (fused > h.finalScore) rerankBoosted++;
          const priorExplain = h.explain;
          const explain =
            priorExplain !== undefined
              ? {
                  ...priorExplain,
                  keywordScore,
                  ...(phrasesRequested ? { phraseHits } : {}),
                  ...(priorExplain.graph !== undefined ? { graph: priorExplain.graph } : {}),
                }
              : undefined;
          return {
            ...h,
            finalScore: fused,
            ...(explain !== undefined ? { explain } : {}),
          };
        })
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, topK);
    } else {
      // Rerank disabled: the keyword stage never runs, so emphasisPhrases
      // are inert by construction.
      ranked = mmred.slice(0, topK);
    }
    // finalRank: 1-based position in the FINAL presentation order, assigned
    // identically on the keyword-fused ranking and the rerank-off
    // truncation. mmrRank deliberately keeps its MMR-stage semantics (it
    // is an explainability signal, not the display order).
    for (let i = 0; i < ranked.length; i++) {
      const h = ranked[i];
      // i < ranked.length pins the slot; the guard never fires.
      if (h === undefined) continue;
      h.finalRank = i + 1;
    }

    // 7. touch access counters for returned items; reinforce=true bumps
    //    importance by a bounded epsilon (+0.01, cap 0.95), so each
    //    retrieval strengthens the memory (the testing effect).
    //    SPECULATIVE probes touch nothing — warmth must not reinforce.
    if (!q.speculative) {
      for (const h of ranked) this.store.touchAccess(h.item.id, true);
      const { userId, workspaceId } = q.scope ?? {};
      this.store.logQuery({
        sessionId: q.scope?.sessionId ?? '',
        ...(userId !== undefined ? { userId } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        query: q.query,
      });
    }

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
    // Cache the result with embeddings INTACT. An earlier version
    // stripped item embeddings before storing ("consumers of cached
    // results don't re-score"), but consumers DO reuse the vectors'
    // geometry — synthesis clustering is embedding-based — so cache hits
    // and fresh queries diverged in exactly the stage that consumed
    // them. The footprint is bounded regardless: capacity 32 entries ×
    // topK hits × ~4KB per embedding is an acceptable price for
    // hit/fresh geometric parity. The stored entry is a shallow-copied
    // DECOUPLING of the returned result: the caller owns its copy, the
    // cache owns its own, and neither can mutate the other.
    // SWR tradeoff: touchAccess deliberately does NOT bump the store's
    // dataVersion, so a served cache hit can carry mildly stale
    // decay/access-refreshed scores until the next real write invalidates
    // the cache — intentional (access warmth is heuristic anyway, and
    // bumping the version on every read would make the cache useless).
    if (this.cfg.queryCache) {
      this.qcache.store(primaryVec, paramsKey, dataStamp, {
        ...result,
        hits: result.hits.map((h) => ({ ...h, item: { ...h.item } })),
      });
    }
    if (!q.speculative) {
      this.bus.emit('memory.after-retrieve', {
        query: q.query,
        hits: ranked.length,
        totalTokens,
        elapsedMs: result.elapsedMs,
        scopeLevel,
        prfApplied,
        entityHop,
      });
    }
    return result;
  }

  /**
   *  One (layer, space) scan with the IVF escalation ladder: probe at
   *  the configured radius; while the pool still needs candidates, widen
   *  the radius — each rung scanning only the bucket keys the wider
   *  radius NEWLY covers. Escalating to IVF_MAX_RADIUS cumulatively
   *  probes every key, which IS the exact scan — so the index can only
   *  trade latency, never recall-sufficiency. Returns the scan hits
   *  (possibly empty).
   */
  private scanWithIvf(
    layer: MemoryLayer,
    space: string,
    queryVec: Float32Array,
    minScore: number,
    scanLimit: number,
    scope: ScopeLevelClause,
    q: RetrievalQuery,
    pool: Map<string, PoolEntry>,
    poolTarget: number,
    level: number,
  ): number {
    const poolInto = (batch: Array<{ item: MemoryItem; rawScore: number }>): number => {
      let added = 0;
      for (const h of batch) {
        // Defensive dedup: a row is pooled exactly once, at the narrowest
        // level whose tier makes it visible.
        if (pool.has(h.item.id)) continue;
        if (!passesFilters(h.item, q.filters)) continue;
        pool.set(h.item.id, { item: h.item, rawScore: h.rawScore, level });
        added++;
      }
      return added;
    };
    const useIvf =
      this.cfg.ivf.enabled &&
      this.store.countItemsInSpace(space) >= this.cfg.ivf.minItems;
    if (!useIvf) {
      return poolInto(
        this.store.scanBySimilarity({
          layer, space, queryVector: queryVec, minScore, limit: scanLimit, scope,
          ...(q.sinceMs !== undefined ? { sinceMs: q.sinceMs } : {}),
          ...(q.untilMs !== undefined ? { untilMs: q.untilMs } : {}),
          ...(q.asOfMs !== undefined ? { asOfMs: q.asOfMs } : {}),
        }),
      );
    }
    const order = probeOrder(queryVec);
    const radii = [this.cfg.ivf.radius, this.cfg.ivf.radius + 1, IVF_MAX_RADIUS]
      .map((r) => Math.max(0, Math.min(IVF_MAX_RADIUS, r)));
    const seenRadii = new Set<number>();
    // Delta-key probing: bucket keys already handed to the store at a
    // narrower radius. Each rung truncates the probe order to
    // keysWithin(r) and scans only the keys NOT already probed — across
    // radii, no bucket is re-read (and no rung's LIMIT budget is re-spent
    // on rows a narrower probe already scored and pooled/deduped).
    //
    // EXACTNESS PROOF (probe-key set equality). radii is non-decreasing
    // after clamping (r ≤ r+1 ≤ MAX, each clamped into [0, MAX]), and
    // keysWithin is monotone non-decreasing in r, so each rung's slice
    // order[0 .. keysWithin(r)) is a SUPERSET of every earlier rung's
    // slice. The delta filter therefore keeps exactly the NEW keys and:
    //
    //   ∪ rungs (slice(r) \ probed-so-far) = slice(max r)
    //       = order[0 .. keysWithin(IVF_MAX_RADIUS))
    //       = order[0 .. Σ_{k≤W} C(W,k)) = order[0 .. 2^W)
    //       = order = keysWithin(MAX) = ALL BUCKET KEYS,
    //
    // with W = IVF_BUCKET_WIDTH: the last rung's slice IS the full probe
    // order, so the cumulative probed-key union equals the exact scan's
    // key set — verified bit-for-bit in test/genesis-retrieval.test.ts
    // against allBucketKeys(). The index can only trade latency, never
    // recall-sufficiency, and that guarantee survives the delta filter.
    //
    // Starvation cannot shortcut the sweep: the only `break` sits AFTER a
    // rung's scan and only when the pool is already satisfied — a pool
    // that never reaches poolTarget runs EVERY rung, ending at the
    // full-radius one, i.e. the exhaustive fallback is always reachable.
    const probedKeys = new Set<string>();
    let added = 0;
    for (const r of radii) {
      if (seenRadii.has(r)) continue;
      seenRadii.add(r);
      const newKeys = order
        .slice(0, countKeysWithin(r))
        .filter((k) => !probedKeys.has(k));
      if (newKeys.length === 0) continue;
      for (const k of newKeys) probedKeys.add(k);
      added += poolInto(
        this.store.scanBySimilarity({
          layer, space, queryVector: queryVec, minScore, limit: scanLimit, scope,
          ...(q.sinceMs !== undefined ? { sinceMs: q.sinceMs } : {}),
          ...(q.untilMs !== undefined ? { untilMs: q.untilMs } : {}),
          ...(q.asOfMs !== undefined ? { asOfMs: q.asOfMs } : {}),
          buckets: newKeys,
        }),
      );
      if (pool.size >= poolTarget) break;
    }
    return added;
  }

  /**
   *  Speculative warmth: run the FULL pipeline for a predicted query —
   *  semantic cache entry stored, PPR computed — with ZERO side effects
   *  (no events, no reinforcement, no trajectory log). Params mirror the
   *  config defaults so a future default-shaped query hits the warm cache.
   *
   *  THE SHAPE IS LOAD-BEARING: the query cache's paramsKey includes
   *  explain and fusionOverrides, so a warm entry only lands in the
   *  partition a REAL query will read if this call mirrors the production
   *  tool shape exactly — hence explain defaults to TRUE here (the
   *  memory_search tool always retrieves with explanations) and learned
   *  fusion overrides of the moment are passed through verbatim. Warm
   *  under any other shape and the cache keys NEVER intersect: warmth
   *  that cannot be hit is pure wasted embedding calls.
   */
  prefetch(
    query: string,
    scope: MemoryScope,
    opts?: { explain?: boolean; fusionOverrides?: Record<string, number> },
  ): Promise<RetrievalResult> {
    return this.retrieve({
      query,
      scope,
      speculative: true,
      topK: this.cfg.topK,
      minScore: this.cfg.minScore,
      mmrLambda: this.cfg.mmrLambda,
      rerank: this.cfg.rerank,
      explain: opts?.explain ?? true,
      ...(opts?.fusionOverrides ? { fusionOverrides: opts.fusionOverrides } : {}),
    });
  }

  /** Format retrieved items as a single context block for prompt injection. */
  formatAsContext(result: RetrievalResult, maxTokens: number): string {
    const lines: string[] = [];
    let used = 0;
    for (const h of result.hits) {
      const header = `[memory:${h.item.layer} score=${h.finalScore.toFixed(2)}]`;
      const body = `${header} ${h.item.content}`;
      const cost = approximateTokenCount(body);
      // Budget walk with skip-and-continue: an entry that does not fit the
      // REMAINING budget is dropped, but the walk keeps going — a later,
      // smaller entry still fills the space the oversized one could not.
      // (The old first-overflow-stops walk punished every small item that
      // happened to rank after one big one.) Rank order of the SURVIVORS
      // is still presentation order; only the skipped gap breaks it.
      if (used + cost > maxTokens) continue;
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

  // Cross-space similarity: cosine only when BOTH items carry embeddings
  // of the same dimensionality (same — or same-arity — space). When a
  // vector is missing or the arities disagree (mixed-space store,
  // mid-migration), the pair DEGRADES to a tokenize word-set Jaccard
  // instead of the old flat 0: treating every cross-space pair as
  // "maximally different" silently disabled diversification in
  // multi-space pools, collapsing each selection step onto pure
  // relevance. Token sets are memoized per item — the pairwise loop
  // below is O(selected × remaining). The memo's Map key is item.id,
  // which is collision-free BY CONSTRUCTION: `candidates` is built from
  // `pool.values()` (a Map keyed by item.id, deduped at insert) plus hop
  // items admitted only when `!pool.has(item.id)`, so every id appears
  // at most once and no item can inherit another's token set. When BOTH
  // items lack embeddings the Jaccard branch itself decides (a shared
  // token still counts; only an EMPTY token set yields 0) — the pair is
  // never short-circuited to 0 merely for being double-unembedded.
  const tokenSets = new Map<string, Set<string>>();
  const tokensFor = (item: MemoryItem): Set<string> => {
    let t = tokenSets.get(item.id);
    if (!t) {
      t = new Set(tokenize(item.content));
      tokenSets.set(item.id, t);
    }
    return t;
  };
  const pairSimilarity = (a: RetrievalHit, b: RetrievalHit): number => {
    const ae = a.item.embedding;
    const be = b.item.embedding;
    if (ae && be && ae.length === be.length) return cosine(ae, be);
    const ta = tokensFor(a.item);
    const tb = tokensFor(b.item);
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    return intersection / (ta.size + tb.size - intersection);
  };

  // Seed with the highest scoring item
  remaining.sort((a, b) => b.score - a.score);
  const seed = remaining.shift();
  invariant(seed !== undefined, 'mmr: seeded from a non-empty list (guarded above)');
  selected.push(seed);

  while (selected.length < topN && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      // i < remaining.length pins the slot; the guard never fires.
      if (cand === undefined) continue;
      let maxSimToSelected = 0;
      for (const sel of selected) {
        const s = pairSimilarity(cand, sel);
        if (s > maxSimToSelected) maxSimToSelected = s;
      }
      const mmrScore = lambda * cand.score - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const picked = remaining.splice(bestIdx, 1)[0];
    if (picked === undefined) break;
    selected.push(picked);
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
