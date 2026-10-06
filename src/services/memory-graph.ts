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
 * Two version-keyed caches — global ranks (a small LRU keyed by scope
 * key) and per-seed-set PPR — invalidate on the store's composite
 * graph-version stamp (`<epoch>:<version>`, see MemoryStore.
 * dataVersionStamp: the epoch half namespaces the 32-bit user_version
 * counter, so a wrap can never alias an old entry's stamp), immune to
 * the count-collision staleness of size-based cache keys. Both use
 * stale-while-revalidate
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
import { extractTypedRelations } from '../utils/inference.js';
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

/**
 * Stopwords for ident classification. Both sides of the comparison are
 * LOWERCASED (the token is lowered, the set holds lowercase entries), so
 * sentence-initial capitals ("The", "Now", "Thanks") are filtered as
 * reliably as mid-sentence ones. Beyond classic function words this set
 * carries the ~40 common sentence-initial function words that otherwise
 * masquerade as entities at the start of an English sentence.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'we', 'they',
  'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'so', 'not', 'no', 'yes', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'will', 'would', 'should', 'could',
  'can', 'may', 'might', 'shall', 'just', 'also', 'than', 'there', 'here',
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'whose',
  // sentence-initial function words (Me/My/Ok/Thanks/Please/Hi/…)
  'me', 'my', 'mine', 'ok', 'okay', 'thanks', 'thank', 'please', 'sure',
  'hi', 'hey', 'hello', 'now', 'let', 'need', 'want', 'know', 'think',
  'good', 'bad', 'new', 'old', 'today', 'tomorrow', 'yesterday',
  'yeah', 'yep', 'nope', 'maybe', 'sorry', 'right', 'well', 'great',
  'nice', 'cool', 'fine', 'alright', 'wow', 'like', 'get', 'got', 'go',
  // service-brand words: derived rows ("Inferred (78%): …") and stratified
  // digests ("[week] …") restate these tokens as template vocabulary —
  // they must never mint entities even when a caller forgets skipGraph.
  'inferred', 'stratified',
]);

/**
 * Well-known tool / infrastructure names (lowercase; compared
 * case-insensitively) so "Docker", "Kubernetes", "Postgres" classify as
 * 'tool' instead of a bare concept.
 */
const TOOL_NAMES = new Set([
  'docker', 'kubernetes', 'k8s', 'kafka', 'postgres', 'postgresql',
  'redis', 'nginx', 'envoy', 'grpc', 'terraform', 'helm', 'grafana',
  'prometheus', 'github', 'git', 'gitlab', 'vscode', 'jenkins',
  'elasticsearch', 'mongodb', 'mysql', 'sqlite', 'webpack', 'vite',
]);

/**
 * Cap on entities extracted from a single message: the co-occurrence
 * edge write is O(n²) in entity count (every ordered pair upserts an
 * edge), so a pathological message must not amplify into thousands of
 * edge upserts.
 */
const MAX_ENTITIES_PER_MESSAGE = 32;

/**
 * Sub-quota for identifier-shaped candidates (code idents lifted from
 * fences plus free-text CamelCase/snake_case/ACRONYM tokens) WITHIN the
 * MAX_ENTITIES_PER_MESSAGE cap. Provenance-backed candidates (handles,
 * paths, URLs, hashtags) are natural mentions of the user's world and
 * keep priority: a message carrying 33 code identifiers must not crowd
 * Aurora/Kafka out of the entity list — which also starved typed-relation
 * extraction (depends-on / deployed-on), whose input is this same list.
 */
const MAX_IDENT_ENTITIES_PER_MESSAGE = 16;

/**
 * Sub-quota for CJK-hinted candidates WITHIN the MAX_ENTITIES_PER_MESSAGE
 * cap (D-16). Quoted spans are user-marked terms, but the suffix/repeat
 * tiers are statistical — the channel stays small enough that a
 * Chinese-heavy message can never crowd the provenance-backed naturals
 * (handles/paths/URLs) out of the entity list, which would also starve
 * typed-relation extraction (its input is this same list).
 */
const MAX_CJK_ENTITIES_PER_MESSAGE = 8;

/**
 * D-16 CJK extraction scope: at least one Han character. Hiragana/Katakana
 * prose shares no entries in the Han suffix list, so only Han runs
 * participate in suffix anchoring; quoted spans must also pass this gate so
 * English curly-quoted phrases stay retrieval-only emphasis.
 */
const HAS_HAN_RE = /\p{Script=Han}/u;
const HAN_RUN_RE = /[\p{Script=Han}]+/gu;

/** User-marked spans: 「…」『…』【…】“…” — the highest-precision CJK signal. */
const CJK_QUOTE_RE = /[「『【“]([^「『【“”」』】]{2,8})[」』】”]/g;

/**
 * Clause-glue characters (particles, pronouns, conjunctions, adverbs) as
 * char codes. Suffix anchoring walks left through the Han run and stops at
 * any of these, so "我们部署了告警服务" yields 告警服务 (the 了 before it is
 * a boundary), never the whole clause. The repeat tier also drops any
 * candidate containing one.
 */
const CJK_BOUNDARY = new Set(
  // Array.from iterates code points — identical to the spread for this
  // BMP-only glue list (every char is a single UTF-16 unit).
  Array.from('的了是在和与及或者把被将已经正很都也就还又才只这那个些我们你们他们她它吧呢啊吗没不对于让到会后').map((c) => c.charCodeAt(0)),
);

/**
 * Multi-char boundary strings — the typed-relation connector vocabulary
 * (依赖 / 部署在 / 使用 / …) plus compound glue. Connectors are exactly the
 * delimiters between two entity mentions ("告警服务依赖时序数据库"), so the
 * suffix walk must stop at them: the term is what lies between a boundary
 * and the system-noun suffix, never the connector itself.
 */
const CJK_BOUNDARY_STRINGS = [
  '部署在', '部署于', '运行在', '运行于', '推送到',
  '依赖', '使用', '采用', '写入', '推送', '流入', '连接', '调用', '属于',
  '以及', '还有',
];
const CJK_BOUNDARY_STRINGS_BY_LENGTH = [...CJK_BOUNDARY_STRINGS].sort(
  (a, b) => b.length - a.length,
);

/** Does a term boundary (glue char or connector string) END at `at`? */
const endsWithBoundary = (run: string, at: number): boolean => {
  if (CJK_BOUNDARY.has(run.charCodeAt(at - 1))) return true;
  for (const s of CJK_BOUNDARY_STRINGS_BY_LENGTH) {
    if (at - s.length >= 0 && run.slice(at - s.length, at) === s) return true;
  }
  return false;
};

/** Does a term boundary (glue char or connector string) START at `at`? */
const startsWithBoundary = (run: string, at: number): boolean => {
  if (CJK_BOUNDARY.has(run.charCodeAt(at))) return true;
  for (const s of CJK_BOUNDARY_STRINGS_BY_LENGTH) {
    if (run.startsWith(s, at)) return true;
  }
  return false;
};

/**
 * Curated system-domain noun suffixes (2+ chars — single-char suffixes like
 * 库/表 are too noisy). Matched longest-first so 时序数据库 resolves via
 * 数据库 rather than leaving a stray shorter window. This is a domain list,
 * not a general NER dictionary — the zero-dependency constraint is the
 * whole point of D-16.
 */
const CJK_SUFFIXES = [
  '消息队列', '微服务', '中间件', '仪表盘', '数据库', '数据源', '数据集',
  '连接池', '负载均衡', '网关', '服务', '系统', '平台', '集群', '代理',
  '缓存', '队列', '配置', '模块', '组件', '索引', '镜像', '容器', '环境',
  '计划', '项目', '任务', '流程', '规则', '策略', '接口', '契约', '事件',
  '日志', '监控', '告警', '报表', '节点', '分片', '副本', '脚本', '仓库',
  '分支', '版本', '补丁', '事务', '终端', '插件', '框架',
];
const CJK_SUFFIXES_BY_LENGTH = [...CJK_SUFFIXES].sort((a, b) => b.length - a.length);

/**
 * Function-word phrases the repeat tier must never promote — a phrase that
 * merely recurs is not thereby a term (contrast-gating, the same philosophy
 * as the pattern miner's ≥3-items / ≥2-days / ≥importance gates).
 */
const CJK_STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '大家', '自己', '现在', '然后',
  '所以', '但是', '因为', '如果', '虽然', '不过', '而且', '以及', '或者',
  '还是', '就是', '这个', '那个', '这些', '那些', '什么', '怎么', '为什么',
  '时候', '一下', '一些', '有点', '可能', '应该', '可以', '需要', '必须',
  '直接', '目前', '今天', '昨天', '明天', '问题', '地方', '东西', '情况',
]);

const CODE_FENCE = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
const FILE_PATH = /(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
const HANDLE = /@[a-zA-Z0-9_.-]+/g;
const HASHTAG = /#[a-zA-Z0-9_]+/g;
const IDENT_RE = /\b[A-Z][a-zA-Z0-9_]+\b|\b[a-z]+_[a-z0-9_]+\b|\b[A-Z]{2,}\b/g;

/** Where a candidate name came from — informs its entity type. */
type EntityHint = 'handle' | 'tag' | 'url' | 'path' | 'ident' | 'project' | 'cjk';

/** Extracted candidate: normalized name + provenance hint. */
export interface ExtractedEntity {
  name: string;
  hint: EntityHint;
}

interface RankCacheEntry {
  /**
   * Composite cache stamp from the store (`<epoch>:<version>` string).
   * Freshness comparison is string !==: the epoch prefix keeps the
   * identity wrap-proof at the 32-bit user_version ceiling (a wrapped
   * counter alone would alias old small-version entries as fresh).
   */
  version: string;
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
/** LRU slots for the global-rank cache: enough that alternating scope
 *  queries (e.g. two users, or user + admin view) stop evicting each
 *  other on every call. */
const GLOBAL_RANK_CACHE_LIMIT = 4;

/**
 * Default cap on edges handed to ADMIN/DISPLAY reads (describeSubgraph,
 * stats): memory-bounding for management views, so an unbounded edge table
 * cannot balloon a view's working set. PageRank paths are NOT covered by
 * this default — they pass an explicit Infinity to scopedEdgesFor (see
 * getRanks/getPersonalizedRanks), because truncating the edge set would
 * change the kernel's input and thus the rank values themselves.
 */
const EDGE_VIEW_LIMIT = 10_000;

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

  /** Global ranks per scope key — small LRU (Map re-insert refreshes). */
  private globalRankCache = new Map<string, RankCacheEntry>();
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
   *
   * Per-source back-links are carried elsewhere: the item side holds the
   * link (item.entityId + metadata.entities), while entity rows aggregate
   * mention counts instead of listing their sources. A historical itemId
   * parameter was dead weight and has been removed.
   */
  ingestEntities(text: string, scope: GraphScope): string[] {
    if (!this.cfg.enabled || !text) return [];
    const found = extract(text);
    const tier = resolveWriteTier(scope.visibility, scope);

    const ids: string[] = [];
    // id → name for this ingest's entities, built during the upsert loop:
    // every entity row (fresh or name-matched existing) carries exactly
    // the extracted name, so no re-read is needed below.
    const nameById = new Map<string, string>();
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
      nameById.set(entity.id, entity.name);
    }

    // Co-occurrence edges (directed both ways; weight accumulates)
    for (let i = 0; i < ids.length; i++) {
      const from = ids[i];
      // i/j < ids.length pins both slots; the guards never fire.
      if (from === undefined) continue;
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        const to = ids[j];
        if (to === undefined) continue;
        const edge: GraphEdge = {
          from,
          to,
          relation: 'co-occurs',
          weight: 1,
          createdAt: now,
        };
        this.store.upsertEdge(edge, { ...scope, visibility: tier });
      }
    }
    // TYPED relations: deterministic bilingual patterns lift this
    // message's co-occurrence pairs into semantic edges (depends-on /
    // deployed-on / …). These feed the sleep-time inference engine.
    const names = [...nameById.values()];
    const relations = extractTypedRelations(text, names);
    for (const rel of relations) {
      // resolve names back to ids via this ingest's entities
      const fromId = [...nameById.entries()].find(([, n]) => n === rel.from)?.[0];
      const toId = [...nameById.entries()].find(([, n]) => n === rel.to)?.[0];
      if (!fromId || !toId) continue;
      this.store.upsertEdge(
        { from: fromId, to: toId, relation: rel.relation, weight: 1, createdAt: now },
        { ...scope, visibility: tier },
      );
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
   * view). Weighted, temporally decayed; cache keyed by the composite
   * graph-version stamp (`<epoch>:<version>`) in a small per-scope-key
   * LRU (4 slots), so alternating scopes no longer
   * evict each other on every call.
   *
   * Edges are filtered to the (possibly truncated) node set BEFORE the
   * kernel runs: entities cut off by the maxEntities cap would otherwise
   * leave dangling edges whose rank mass silently distorts the scores of
   * the surviving hub nodes. Conservation is unaffected — dropping an
   * edge removes a mass SOURCE (an out-link that carried rank away from
   * its tail), never rank mass itself: the kernel renormalizes Σrank to
   * exactly 1 on every iteration (see utils/pagerank.ts), so the scoped
   * graph's ranks still sum to 1 after the filter. Guarded by an
   * explicit Σrank≈1 assertion in test/genesis-retrieval.test.ts.
   *
   * Stale-while-revalidate: a version-stale cached entry (same scope key)
   * is served as-is while younger than RANK_MIN_TTL_MS; the first stale
   * call at/after the TTL recomputes synchronously and refreshes the
   * cache, so the next call sees fresh ranks. Bounded staleness: ranks
   * lag ≤500ms behind graph writes — retrieval ordering is unaffected in
   * practice, and a chatty session no longer recomputes PageRank on every
   * retrieval.
   */
  getRanks(
    level: ScopeLevelClause | null = null,
    opts?: { iterations?: number },
  ): Map<string, number> {
    const key =
      this.rankCacheKey(level) +
      (opts?.iterations !== undefined ? `|it:${opts.iterations}` : '');
    const version = this.store.graphVersion();
    const cached = this.globalRankCache.get(key);
    if (cached) {
      // Fresh (version match) OR stale-but-younger-than the SWR floor →
      // serve without recompute, refreshing the LRU position.
      const serve =
        cached.version === version ||
        Date.now() - cached.computedAt < MemoryGraph.RANK_MIN_TTL_MS;
      if (serve) {
        this.globalRankCache.delete(key);
        this.globalRankCache.set(key, cached);
        return cached.ranks;
      }
      // Stale beyond the floor → fall through and recompute NOW so the
      // next call sees fresh ranks.
    }
    const entities = level
      ? this.store.listEntitiesScoped(level, this.cfg.maxEntities)
      : this.store.listEntities(this.cfg.maxEntities);
    const nodeIds = new Set(entities.map((e) => e.id));
    // Infinity — the PageRank input edge set must be the FULL scoped set:
    // a display-style limit here would silently truncate the kernel's
    // input and change every rank value (see scopedEdgesFor).
    const edges = this.scopedEdgesFor(level, Infinity).filter(
      (e) => nodeIds.has(e.from) && nodeIds.has(e.to),
    );
    const ranks = pageRank(
      entities.map((e) => e.id),
      edges,
      {
        damping: this.cfg.pagerankDamping,
        iterations: opts?.iterations ?? this.cfg.pagerankIterations,
        edgeDecayDays: this.cfg.pagerankEdgeDecayDays,
      },
    );
    this.globalRankCache.delete(key);
    this.globalRankCache.set(key, { version, ranks, computedAt: Date.now() });
    if (this.globalRankCache.size > GLOBAL_RANK_CACHE_LIMIT) {
      const oldest = this.globalRankCache.keys().next().value;
      if (oldest !== undefined) this.globalRankCache.delete(oldest);
    }
    return ranks;
  }

  /**
   * Personalized PageRank: teleport concentrated on `seeds` (the query's
   * entities). Cached per seed-set hash with LRU eviction. Falls back to
   * classic PageRank when seeds are empty or unknown to the scoped graph.
   *
   * Same edge policy as getRanks: edges are restricted to both endpoints
   * being inside the (truncated) node set, so rank mass cannot leak
   * through entities the maxEntities cap cut off.
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
    const nodeIds = new Set(entities.map((e) => e.id));
    // Infinity — PPR shares getRanks's policy: the kernel's input edge
    // set is never truncated by the display-read limit.
    const edges = this.scopedEdgesFor(level, Infinity).filter(
      (e) => nodeIds.has(e.from) && nodeIds.has(e.to),
    );
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
    // LRU refresh on the recompute path too, matching getRanks's
    // delete-before-set: a bare set() on an existing key keeps its ORIGINAL
    // Map insertion position, so a seed set that recomputes often (stale
    // past the SWR floor every write) could still be evicted as "oldest"
    // despite being the hottest.
    this.pprCache.delete(key);
    this.pprCache.set(key, { version, ranks, computedAt: Date.now() });
    if (this.pprCache.size > PPR_CACHE_LIMIT) {
      const oldest = this.pprCache.keys().next().value;
      if (oldest !== undefined) this.pprCache.delete(oldest);
    }
    return ranks;
  }

  /**
   * Edges for a scope level, optionally capped for memory-bounded display
   * reads (management-view bound; default EDGE_VIEW_LIMIT). Rank paths pass
   * an explicit Infinity and are therefore unaffected by the cap — both in
   * edge SET (no truncation → identical PageRank input) and in edge ORDER
   * (below/at the cap the array is returned untouched, preserving
   * insertion order).
   *
   * Truncation policy (only on overflow): ORDER BY weight DESC with a
   * from/to lexicographic tiebreak keeps the survivor set deterministic —
   * the heaviest edges win, and equal weights resolve stably by endpoint
   * ids (V8's sort is stable, covering any remainder).
   */
  private scopedEdgesFor(
    level: ScopeLevelClause | null,
    limit: number = EDGE_VIEW_LIMIT,
  ): Array<{ from: string; to: string; relation: string; weight: number; lastSeenAt: number }> {
    let edges: Array<{ from: string; to: string; relation: string; weight: number; lastSeenAt: number }>;
    if (level) {
      edges = this.store.listEdgesScoped(level);
    } else {
      // null level is the whole-graph admin/CLI plane; listEdgesScoped is
      // owner-bound by design and cannot express "all tenants", so no
      // scoped equivalent exists for this branch.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate admin-plane whole-graph read
      edges = this.store.listEdges().map((e) => ({
        from: e.from,
        to: e.to,
        relation: e.relation,
        weight: e.weight,
        lastSeenAt: e.createdAt,
      }));
    }
    if (!Number.isFinite(limit) || edges.length <= limit) return edges;
    return [...edges]
      .sort(
        (x, y) =>
          y.weight - x.weight ||
          (x.from < y.from ? -1 : x.from > y.from ? 1 : 0) ||
          (x.to < y.to ? -1 : x.to > y.to ? 1 : 0),
      )
      .slice(0, limit);
  }

  /** PageRank normalized to [0, 1] over the scoped graph. */
  getNormalizedRanks(level: ScopeLevelClause | null = null): Map<string, number> {
    return normalizeRanks(this.getRanks(level));
  }

  /** Back-compat public entry point (whole-graph ranks). The requested
   *  iteration count is honored — passed through to the kernel (and into
   *  the cache key) instead of being silently discarded. */
  computePageRank(iterations = 12): Map<string, number> {
    return this.getRanks(null, { iterations });
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
   *     r(e) = pw · ppr(e) + (1 − pw) · global(e)     (≥1 seed in graph)
   *     r(e) = global(e)                              (otherwise — including
   *     all-miss seeds: PPR over unknown seeds is uniform teleport, i.e.
   *     global PR re-skinned, so no proximity is mixed in or reported)
   *
   * normalized per-map to [0,1], then multiplier = 1 + G·(r − r̄) clamped
   * to [1−G, 1+G] — graph centrality/proximity REORDERS results without
   * shifting overall score calibration. Items may list several candidate
   * entities; the strongest (max-rank) one speaks for the item.
   */
  buildRetrievalPrior(
    params: {
      seeds: string[];
      level: ScopeLevelClause | null;
      graphBoost: number;
      personalizationWeight: number;
    },
    opts?: { graphBoost?: number },
  ): (entityIds: string[]) => { mult: number; detail: PriorDetail } {
    const { seeds, level, personalizationWeight } = params;
    // Per-call graph-boost override (e.g. feedback-tuned), falling back to
    // the caller's configured boost; still clamped to [0, 0.5]. No other
    // math changes.
    const G = Math.max(0, Math.min(0.5, opts?.graphBoost ?? params.graphBoost));
    if (G <= 0) return () => ({ mult: 1, detail: {} });

    const globalNorm = this.getNormalizedRanks(level);
    if (globalNorm.size === 0) return () => ({ mult: 1, detail: {} });

    // Honest seed gate: personalize only with seeds that actually RESIDE in
    // the scoped graph (globalNorm's key set IS the scoped node set). When
    // seeds were given but none is known, the kernel would silently degrade
    // to uniform teleport — the PPR half of the blend would be global PR in
    // a different skin, yet still mixed in at `pw` and reported as
    // proximityRank in explain. Reporting proximity for that is a lie, so
    // pprNorm stays null instead: pure global prior, no proximity claimed.
    // (The kernel filters seeds ∩ nodes anyway, so passing the pre-filtered
    // seedHit changes no rank values when at least one seed hits.)
    const seedHit = seeds.filter((s) => globalNorm.has(s));
    const pprNorm =
      seedHit.length > 0 ? normalizeRanks(this.getPersonalizedRanks(seedHit, level)) : null;
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
      const entityName = nameById.get(bestId);
      const proximityRank = pprNorm
        ? Number((pprNorm.get(bestId) ?? 0).toFixed(3))
        : undefined;
      return {
        mult,
        detail: {
          ...(entityName !== undefined ? { entityName } : {}),
          globalRank: Number((globalNorm.get(bestId) ?? 0).toFixed(3)),
          ...(proximityRank !== undefined ? { proximityRank } : {}),
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
    let root: Entity | null;
    if (level) {
      root = this.store.findEntityInScope(rootName, [level]);
    } else {
      // null level is the whole-graph admin/CLI plane; findEntityInScope
      // is owner-bound and cannot match across all tenants.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate admin-plane whole-graph read
      root = this.store.findEntityByName(rootName);
    }
    if (!root) return '';
    // Display read: default EDGE_VIEW_LIMIT applies (memory-bounded
    // management view), unlike the rank paths above which pass Infinity.
    const allEdges = this.scopedEdgesFor(level);
    const edges = allEdges.map((e) => ({
      from: e.from,
      to: e.to,
      relation: e.relation,
      weight: e.weight,
    }));
    const nodes = new Map<string, Entity>();
    nodes.set(root.id, root);
    // Neighbor resolution from one scoped entity list instead of per-edge
    // point reads: edges visible at a level are written between entities
    // upserted at that same tier+scope (ingest and inference both pair
    // same-scope endpoints), so every endpoint resolves inside the list —
    // and cross-tenant entities can no longer join a scoped view through
    // an id-only fetch.
    const entityById = new Map<string, Entity>(
      (level ? this.store.listEntitiesScoped(level) : this.store.listEntities()).map(
        (e) => [e.id, e] as const,
      ),
    );

    for (let h = 0; h < hops && nodes.size < maxNodes; h++) {
      // Frontier = node ids at the START of this hop (BFS semantics).
      // A Set gives O(1) membership checks inside the edge loop, so each
      // hop costs O(V + E) instead of O(V × E) from linear array scans;
      // nodes discovered mid-hop join the next hop's frontier.
      const frontierSet = new Set(nodes.keys());
      for (const e of edges) {
        if (nodes.size >= maxNodes) break;
        if (frontierSet.has(e.from) && !nodes.has(e.to)) {
          const ent = entityById.get(e.to);
          if (ent) nodes.set(ent.id, ent);
        }
        if (nodes.size >= maxNodes) break;
        if (frontierSet.has(e.to) && !nodes.has(e.from)) {
          const ent = entityById.get(e.from);
          if (ent) nodes.set(ent.id, ent);
        }
      }
    }

    const lines: string[] = [];
    lines.push(`Subgraph around "${rootName}":`);
    for (const [id, ent] of nodes) {
      // Edge labels report the edge's TRUE relation (depends-on /
      // deployed-on / inf:reaches …), not a blanket 'co-occurs'.
      const rels = edges
        .filter((e) => e.from === id || e.to === id)
        .slice(0, 5)
        .map((e) => `${e.from === id ? '→' : '←'}${e.relation}(${e.weight.toFixed(1)})`)
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
        // null level is the whole-graph admin/CLI plane; the scoped
        // equivalent (resolveEntityNames below) is owner-bound and cannot
        // match across all tenants.
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate admin-plane whole-graph read
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
    // Display read: default EDGE_VIEW_LIMIT applies (bounded), and going
    // through scopedEdgesFor unifies the scoped/legacy branches.
    const edges = this.scopedEdgesFor(level);
    return {
      entities: entities.length,
      edges: edges.length,
      topEntities: entities.slice(0, 10).map((e) => ({ name: e.name, count: e.mentionCount })),
    };
  }
}

/**
 * Extract candidate entities with provenance hints, ordered by first
 * match. Noise guards:
 *  - URLs run BEFORE file paths, and path matches falling inside a URL
 *    span are skipped — a URL's path segment must never masquerade as a
 *    "/example.com/x" file entity.
 *  - @handles exclude email local parts (an "@" preceded by [\w.+-]
 *    belongs to user@example.com, not a mention).
 *  - CJK candidates come from three tiered signals — quoted spans
 *    (「」『』【】“”), system-noun suffix anchoring with clause-glue
 *    boundaries, and exact maximal repeats — under their own sub-quota
 *    (DECISIONS D-16). Pure-ASCII text takes none of these paths.
 *  - The result is capped at MAX_ENTITIES_PER_MESSAGE entries.
 */
export function extract(text: string): ExtractedEntity[] {
  const byName = new Map<string, EntityHint>();
  const add = (name: string, hint: EntityHint) => {
    if (!byName.has(name)) byName.set(name, hint); // first hint wins
  };

  let m: RegExpExecArray | null;
  CODE_FENCE.lastIndex = 0;
  while ((m = CODE_FENCE.exec(text))) {
    // Group 1 (the fenced body) is mandatory in the pattern.
    const body = m[1];
    if (body === undefined) continue;
    const idents = body.match(IDENT_RE);
    if (idents) for (const i of idents) add(i, 'ident');
  }
  // URLs first (see JSDoc): record their spans so the FILE_PATH pass can
  // skip anything inside them.
  const urlSpans: Array<[number, number]> = [];
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    const match = m;
    urlSpans.push([match.index, match.index + match[0].length]);
    add(match[0], 'url');
  }
  FILE_PATH.lastIndex = 0;
  while ((m = FILE_PATH.exec(text))) {
    const match = m;
    const insideUrl = urlSpans.some(([s, e]) => match.index >= s && match.index < e);
    if (!insideUrl) add(match[0], 'path');
  }
  HANDLE.lastIndex = 0;
  while ((m = HANDLE.exec(text))) {
    const match = m;
    // Email local-part guard: "@…" directly preceded by [\w.+-] is an
    // address, not an @-mention handle.
    if (/[\w.+-]/.test(text.charAt(match.index - 1))) continue;
    add(match[0].slice(1), 'handle');
  }
  HASHTAG.lastIndex = 0;
  while ((m = HASHTAG.exec(text))) add(m[0].slice(1), 'tag');

  // ——— CJK multi-signal candidates (D-16): quoted ▸ suffix-anchored ▸
  // exact repeats. Zero-dependency and dictionary-free: only user-marked or
  // statistically salient Han spans become entities, and the channel has
  // its own sub-quota so it can never crowd the naturals. All of this is
  // inert on ASCII text — the English extraction path is byte-identical
  // when no Han character is present.
  const addCjk = (raw: string) => {
    const name = raw.trim();
    if (name.length < 2 || name.length > 8) return;
    if (!HAS_HAN_RE.test(name)) return;
    if (CJK_STOPWORDS.has(name)) return;
    add(name, 'cjk'); // first hint wins — dedupes across the three tiers
  };
  CJK_QUOTE_RE.lastIndex = 0;
  while ((m = CJK_QUOTE_RE.exec(text))) {
    // Group 1 (the quoted span) is mandatory in the pattern.
    const span = m[1];
    if (span !== undefined) addCjk(span);
  }
  HAN_RUN_RE.lastIndex = 0;
  while ((m = HAN_RUN_RE.exec(text))) {
    const run = m[0];
    for (const suffix of CJK_SUFFIXES_BY_LENGTH) {
      let idx = run.indexOf(suffix);
      while (idx !== -1) {
        const after = idx + suffix.length;
        // A system-noun suffix marks the END of a noun phrase: accept the
        // match only when nothing content-bearing follows in-run — run end,
        // a glue char, or a connector (依赖/部署在/…) opening the next
        // phrase. Otherwise the suffix sits mid-phrase (告警 inside
        // 告警服务) and must not mint a fragment.
        if (after === run.length || startsWithBoundary(run, after)) {
          // Walk left (≤5 chars) to the nearest boundary — glue char or
          // connector string ENDING at `start`: the term is the span
          // between that boundary and the suffix end.
          let start = idx;
          const floor = Math.max(0, idx - 5);
          while (start > floor && !endsWithBoundary(run, start)) start--;
          addCjk(run.slice(start, after));
        }
        idx = run.indexOf(suffix, idx + 1);
      }
    }
  }
  // Exact repeats (recall backstop): a 2–6 char Han span occurring ≥2 times
  // in the message, glue-free, kept only in maximal form — 告警服务
  // recurring suppresses its own substrings (告警/警服/服务).
  const subCounts = new Map<string, number>();
  HAN_RUN_RE.lastIndex = 0;
  while ((m = HAN_RUN_RE.exec(text))) {
    const run = m[0];
    for (let i = 0; i < run.length; i++) {
      for (let len = 2; len <= 6 && i + len <= run.length; len++) {
        const sub = run.slice(i, i + len);
        subCounts.set(sub, (subCounts.get(sub) ?? 0) + 1);
      }
    }
  }
  const repeated = [...subCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([sub]) => sub)
    .filter((sub) => !CJK_STOPWORDS.has(sub))
    .filter((sub) => !Array.from(sub).some((ch) => CJK_BOUNDARY.has(ch.charCodeAt(0))));
  for (const sub of repeated) {
    if (!repeated.some((other) => other !== sub && other.includes(sub))) addCjk(sub);
  }

  // Capitalized words & identifiers. The stopword comparison lowercases
  // BOTH sides (token lowered, set stored lowercase).
  const wordIdents = text.match(IDENT_RE);
  if (wordIdents) {
    for (const w of wordIdents) {
      const low = w.toLowerCase();
      if (STOPWORDS.has(low)) continue;
      if (w.length < 2) continue;
      add(w, 'ident');
    }
  }

  // O(n²) co-occurrence write-amplification guard: cap per message, with
  // FAIRNESS inside the cap. The cap is applied to the DEDUPED map —
  // byName has already collapsed repeats (first hint wins). Natural
  // candidates (hint !== 'ident' && hint !== 'cjk': handle/path/url/tag)
  // are kept first in first-match order; CJK candidates fill at most
  // MAX_CJK_ENTITIES_PER_MESSAGE slots and identifier-shaped candidates at
  // most MAX_IDENT_ENTITIES_PER_MESSAGE of the MAX_ENTITIES_PER_MESSAGE
  // total (see those constants' docs for why). Deterministic: same text,
  // same extraction order, same survivor set, every time.
  const entries = [...byName];
  const naturals = entries.filter(([, hint]) => hint !== 'ident' && hint !== 'cjk');
  const cjk = entries
    .filter(([, hint]) => hint === 'cjk')
    .slice(0, MAX_CJK_ENTITIES_PER_MESSAGE);
  const idents = entries
    .filter(([, hint]) => hint === 'ident')
    .slice(0, MAX_IDENT_ENTITIES_PER_MESSAGE);
  return [...naturals, ...cjk, ...idents]
    .slice(0, MAX_ENTITIES_PER_MESSAGE)
    .map(([name, hint]) => ({ name, hint }));
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
    case 'project':
      return 'project';
    case 'ident':
      break;
    case 'cjk':
      break; // shared tail: project-suffix rule (项目/计划) applies to CJK too
  }
  // Project reachability: names ending in "project"/"项目"/"计划". The
  // ASCII suffix needs a word/underscore/hyphen boundary; the CJK suffixes
  // additionally accept a Han-bound compound (数据迁移项目) — Chinese has
  // no word boundaries for the [\s_-] class to bite on.
  if (/(?:^|[\s_-])(?:project|项目|计划)$/i.test(name)) return 'project';
  if (/\p{Script=Han}(?:项目|计划)$/u.test(name)) return 'project';
  // Well-known tooling classifies as 'tool' rather than a bare concept.
  if (TOOL_NAMES.has(name.toLowerCase())) return 'tool';
  if (/^[A-Z]{2,}$/.test(name)) return 'other'; // ACRONYM
  return 'concept';
}
