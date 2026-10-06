/**
 * Core types for the DSH Memory Palace plugin.
 *
 * Memory is organized in three layers, mirroring cognitive science:
 *  - episodic:   raw event stream of past sessions (what happened)
 *  - semantic:   distilled, vectorized facts/knowledge (what is known)
 *  - procedural: user preferences and behavioral patterns (how the user works)
 */

/** Visibility tier for memory rows — the ACL's atomic unit (see utils/scope.ts). */
export type VisibilityTier = 'global' | 'user' | 'workspace' | 'session';

/** Single source of truth for the package version (keep in sync with package.json). */
export const VERSION = '0.24.0';

export type MemoryLayer = 'episodic' | 'semantic' | 'procedural';

/** Memory visibility scope. See `utils/scope.ts` for the tier ACL. */
export type MemoryScopeKind = 'user' | 'workspace' | 'session';

/**
 * Tri-state policy for writes that carry NO owner id at all (anonymous
 * callers — no userId, no workspaceId, not even a sessionId). Declared
 * LOCALLY: types/index.ts never imports from utils (dependency direction
 * is utils → types); the semantics and enforcement live in
 * applyAnonymousWritePolicy() in utils/scope.ts.
 *
 *   'global'     — legacy default: the write lands in the global shared
 *                  bucket exactly as it always did (fail-open, kept for
 *                  zero-migration back-compat).
 *   'quarantine' — the write is isolated into the synthetic
 *                  '__anonymous__' session bucket (visibility 'session');
 *                  invisible to every identified user's read cascade.
 *   'reject'     — fail-closed: the ingest throws before any store write
 *                  (for hosts carrying an identity guarantee).
 */
export type AnonymousWritePolicy = 'global' | 'quarantine' | 'reject';

/**
 * The scope config section: the home visibility tier KIND plus the
 * anonymous-write policy. At install time (index.ts MemoryPalaceOptions)
 * the LEGACY scalar form — `scope: 'user'` — is still accepted and
 * normalized into this shape (`{ kind: 'user', anonymousPolicy: 'global' }`),
 * so existing host configs and programmatic callers keep working
 * byte-identically.
 */
export interface ScopeSettings {
  /** Home visibility tier for new memories (see utils/scope.ts). */
  kind: MemoryScopeKind;
  /**
   * Policy for writes carrying no owner id at all — see
   * AnonymousWritePolicy above. Defaults to 'global'.
   */
  anonymousPolicy?: AnonymousWritePolicy;
  /**
   * Admin whitelist for GLOBAL-side-effect tools (memory_migrate's live
   * re-embed). TRI-STATE, keyed on PRESENCE, not value:
   *
   *   key ABSENT   — unconfigured: the single-user trust model. Every
   *                  historical install: any caller may run a live
   *                  migration with confirm:true. DEFAULT_CONFIG
   *                  deliberately omits the key so this is the default.
   *   key PRESENT  — configured: a live call additionally requires the
   *                  caller's tctx.userId to be listed. An undefined
   *                  userId is REJECTED (fail-closed) — an anonymous
   *                  caller can never satisfy a membership check.
   *
   * Present-but-empty ([] or ['']) is a CONFIG ERROR, rejected loudly at
   * install time (index.ts): "configured but nobody allowed" is almost
   * always a typo, and silently accepting it would brick the tool while
   * LOOKING locked down. Elements must be non-empty strings.
   */
  adminUserIds?: string[];
}

/** Caller identity used to scope ingestion and retrieval. */
export interface MemoryScope {
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
}

/**
 * Fire-and-forget event sink (ports & adapters): services stay Cordis-agnostic
 * and the plugin wires this to ctx.emit at install time.
 */
export interface MemoryEventBus {
  emit(event: string, payload: unknown): void;
}

export const NOOP_BUS: MemoryEventBus = { emit() {} };

export interface MemoryItem {
  id: string;
  layer: MemoryLayer;
  content: string;
  embedding?: Float32Array;
  metadata: MemoryMetadata;
  createdAt: number; // unix ms
  updatedAt: number;
  importance: number; // 0..1
  accessCount: number;
  lastAccessedAt: number;
  /** Graph node id (if linked in knowledge graph) */
  entityId?: string;
  /** Visibility tier backing this row (ACL; see utils/scope.ts). */
  visibility?: VisibilityTier;
  /**
   * Owner backfill (populated by MemoryStore.rowToItem from the DB row's
   * owner columns) so JS-side callers can re-check the tier ACL without a
   * second query — see visibleAtLevel() in utils/scope.ts. These mirror
   * the persisted owner columns and are NOT part of the capsule
   * projection (capsules serialize metadata only).
   */
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
}

export interface MemoryMetadata {
  source: 'session' | 'tool' | 'user' | 'system' | 'inferred';
  sessionId?: string;
  workspaceId?: string;
  userId?: string;
  tags?: string[];
  entities?: string[];
  toolName?: string;
  role?: 'user' | 'assistant' | 'tool' | 'system';
  tokenCount?: number;
  expiresAt?: number;
  /** Which embedding space produced `embedding` (e.g. "deepseek:deepseek-embed"). */
  embeddingSpace?: string;
  /**
   * @deprecated Legacy input alias — the `visibility` column / the
   * item-level `MemoryItem.visibility` field is the single source of
   * truth; this metadata copy is not persisted since 0.20.0 (still read
   * at insert time to derive the tier).
   */
  visibility?: VisibilityTier;
  [extra: string]: unknown;
}

export interface EpisodicEvent {
  id: string;
  sessionId: string;
  type: 'message' | 'tool_call' | 'tool_result' | 'plan' | 'error' | 'summary';
  payload: unknown;
  ts: number;
  /** If summarized into a semantic memory, this points to it */
  summarizedAs?: string;
}

export interface ProceduralPattern {
  id: string;
  pattern: string; // e.g. "prefers-concise-answers"
  description: string;
  evidence: string[]; // memory item ids that support this
  confidence: number; // 0..1
  createdAt: number;
}

export type EntityType =
  | 'person'
  | 'project'
  | 'concept'
  | 'tool'
  | 'file'
  | 'other';

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  mentionCount: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  weight: number;
  createdAt: number;
}

export interface RetrievalQuery {
  query: string;
  /** Pre-computed query vector; assumed to live in the gateway's primary space. */
  queryEmbedding?: Float32Array;
  /** Space id of `queryEmbedding`, when known. */
  queryEmbeddingSpace?: string;
  layers?: MemoryLayer[];
  topK?: number;
  /** Floor on RAW cosine similarity (pre-decay), so the threshold has a
   *  stable meaning independent of item age. */
  minScore?: number;
  mmrLambda?: number;
  filters?: Partial<MemoryMetadata>;
  rerank?: boolean;
  /** Caller identity for scope-filtered retrieval. */
  scope?: MemoryScope;
  /** Only memories created at/after this unix-ms timestamp (pushed to SQL). */
  sinceMs?: number;
  /** Only memories created at/before this unix-ms timestamp (pushed to SQL). */
  untilMs?: number;
  /** Entity ids whose linked items get an extra bounded score boost. */
  boostEntityIds?: string[];
  /** Populate per-hit score decomposition (RetrievalHit.explain). */
  explain?: boolean;
  /** Quoted phrases from the query worth emphasizing during keyword rerank. */
  emphasisPhrases?: string[];
  /** FLASHBACK: retrieve memories as they existed at this unix-ms time
   *  (respects tombstone/supersession timestamps, not just creation). */
  asOfMs?: number;
  /** Learned fusion weights (feedback bandit) overriding config rails. */
  fusionOverrides?: Partial<Record<string, number>>;
  /** INTERNAL — speculative warmth mode: full pipeline, ZERO side effects
   *  (no events, no reinforcement, no trajectory logging). Used by
   *  retriever.prefetch() and the reflector's benchmark probes. */
  speculative?: boolean;
}

/** Per-hit score decomposition — every factor that produced finalScore. */
export interface HitExplanation {
  /** Raw cosine similarity to the query (pre-everything). */
  rawScore: number;
  /** Recency decay factor 0.5^(age/halfLife), 1 when fresh. */
  decayFactor: number;
  /** Importance factor, bounded to [0.5, 1.0]. */
  importanceFactor: number;
  /** Graph-prior multiplier (PageRank zero-mean prior × entity boost). */
  graphMultiplier: number;
  /** Keyword-overlap score added by the optional rerank stage. */
  keywordScore?: number;
  /** How many emphasis phrases had their full token set contained in this
   *  item's tokens (keyword rerank only; set when the query supplied
   *  emphasisPhrases and rerank ran). */
  phraseHits?: number;
  /** Graph-prior breakdown: which entity, its global rank and its PPR
   *  proximity to the query's entities. */
  graph?: {
    entityName?: string;
    globalRank?: number;
    proximityRank?: number;
  };
}

export interface RetrievalHit {
  item: MemoryItem;
  /** Raw cosine similarity to the query (pre-decay, pre-prior). */
  rawScore: number;
  /** Score after decay × importance × graph prior. */
  score: number;
  /** MMR rank contribution (1 / rank) for explainability */
  mmrRank: number;
  /** Final fused score after graph prior, decay and optional keyword rerank */
  finalScore: number;
  /**
   * Final rank AFTER fusion/rerank (1 = best). mmrRank above keeps its
   * MMR-stage meaning and is not recomputed once fusion reorders the pool.
   */
  finalRank?: number;
  /** Cascade level this hit entered the pool at (0 = narrowest tier). */
  scopeLevel?: number;
  /** How this hit was recalled: vector scan or entity-anchor hop. */
  via?: 'vector' | 'entity-hop';
  /** Score decomposition, populated when the query asks for explain:true. */
  explain?: HitExplanation;
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  /** Token count of concatenated hits if used as context */
  totalTokens: number;
  /** Execution time in ms */
  elapsedMs: number;
  /** For debugging / Trajectory integration */
  debug?: {
    vectorRecall: number;
    rerankBoosted: number;
    /** How many scope-widening passes were needed to fill the pool. */
    scopeLevel: number;
    /** True when a near-duplicate query was served from the semantic cache. */
    cacheHit?: boolean;
    /** True when pseudo-relevance feedback re-scored the pool. */
    prfApplied?: boolean;
    /** Items recalled through entity-anchor hops (graph-guided second pass). */
    entityHop?: number;
  };
}

export interface CompressionReport {
  compressedAt: number;
  trigger: 'count' | 'age' | 'size' | 'manual' | 'skipped';
  inputCount: number;
  outputCount: number;
  savedTokens: number;
  newSemanticItems: number;
  evictedItems: number;
  /** Maintainer housekeeping counters (optional — older callers never
   *  produced them; surfaced when the corresponding stage actually ran). */
  expiredSwept?: number;
  eventsPruned?: number;
  tombstonesPurged?: number;
  patternsMined?: number;
}

export interface PluginConfig {
  storagePath: string;
  embedding: {
    provider: 'deepseek' | 'offline-bm25';
    model: string;
    dimensions: number;
    apiKey?: string;
    baseUrl?: string;
  };
  retrieval: {
    topK: number;
    mmrLambda: number;
    minScore: number;
    rerank: boolean;
    /** Weight of the zero-mean PageRank prior (0 disables, typ. 0.1–0.25). */
    graphBoost: number;
    /** Pseudo-relevance feedback: blend the top-hit centroid back into the
     *  query vector and re-score — zero-LLM query expansion. */
    prf: {
      enabled: boolean;
      /** Weight of the original query vector. */
      alpha: number;
      /** Weight of the top-hit centroid. */
      beta: number;
      /** How many top hits form the centroid. */
      depth: number;
    };
    /** Entity-anchor hop expansion: second pass through items linked to the
     *  top hits' entities that the vector gate missed. */
    entityHop: boolean;
    /** Deterministic semantic cache for near-duplicate queries. */
    queryCache: boolean;
    /** Vector storage precision: 'int8' (4× denser, bounded error < 0.002) or 'float32' (exact). */
    quantization: 'int8' | 'float32';
    /** Online fusion learning from engagement feedback (bounded rails). */
    fusionLearning: {
      enabled: boolean;
      /** Learning rate per feedback event (0.01–0.05 sane). */
      lr: number;
    };
    /** Deterministic IVF bucket index (pure accelerator; escalation ends
     * in all-keys = the exact scan — recall never depends on it). */
    ivf: {
      enabled: boolean;
      /** Starting Hamming probe radius (1 = 5/16 buckets). */
      radius: number;
      /** Only engage IVF above this many space items — below it the exact
       * scan is already fast and the join overhead is pure loss. */
      minItems: number;
    };
    /**
     * Raw-cosine floor for memory_remember's write-time NEAR-DUPLICATE
     * scan. An existing hit at/above it that is NOT contradictory returns
     * the existing id (deduplicated) instead of storing a clone; a
     * contradictory one falls through to the conflict/update path — high
     * similarity alone never merges "v16" into "v17". Domain [0.5, 1]:
     * values outside are clamped at use time and NaN/±Infinity fall back
     * to this default (see finiteOr/clampThreshold in index.ts). Default
     * 0.92: only true paraphrases merge.
     */
    writeDedupeThreshold?: number;
    /**
     * Raw-cosine floor for memory_remember's CONFLICT scan: existing
     * memories at/above it are checked for contradictions (differing
     * numeric signatures, affirmative vs negated wording). Deliberately
     * WIDER than writeDedupeThreshold so an update that rewords heavily
     * still gets flagged. Domain [0, 1] — clamped at use time, NaN falls
     * back to this default. Default 0.75.
     */
    conflictScanThreshold?: number;
  };
  compression: {
    enabled: boolean;
    triggerCount: number;
    importanceThreshold: number;
    decayHalfLifeDays: number;
  };
  graph: {
    enabled: boolean;
    maxEntities: number;
    pagerankDamping: number;
    /** Power-iteration rounds for (P)PR. Default 20. */
    pagerankIterations: number;
    /** Half-life (days) for edge-weight recency decay; 0 disables. */
    pagerankEdgeDecayDays: number;
    /** Blend between global PR and personalized PR when seeds exist:
     *  1 = pure PPR, 0 = pure global. Default 0.6. */
    personalizationWeight: number;
  };
  injection: {
    enabled: boolean;
    maxTokens: number;
    systemPromptPrefix: string;
    /** Pre-warm personalized PageRank for the opening intent's entities at
     *  session start (pure local compute, zero API cost). Default true. */
    warmRanks: boolean;
    /** Fraction of the injection budget reserved for core SELF blocks (0 disables). */
    coreBudgetFraction: number;
  };
  scope: ScopeSettings;
}

export const DEFAULT_CONFIG: PluginConfig = {
  storagePath: '${workspace}/.dsh/memory-palace.db',
  embedding: {
    provider: 'deepseek',
    model: 'deepseek-embed',
    dimensions: 1024,
    baseUrl: 'https://api.deepseek.com',
  },
  retrieval: {
    topK: 8,
    mmrLambda: 0.5,
    // Floor on RAW cosine. 0.1 suits sparse offline vectors; raise to ~0.3
    // when using a dense provider.
    minScore: 0.1,
    rerank: true,
    graphBoost: 0.15,
    prf: { enabled: true, alpha: 0.7, beta: 0.3, depth: 3 },
    entityHop: true,
    queryCache: true,
    ivf: { enabled: true, radius: 1, minItems: 2000 },
    quantization: 'int8',
    fusionLearning: { enabled: true, lr: 0.02 },
    // Write-time scan floors for memory_remember (explicit so the defaults
    // are discoverable here rather than buried in index.ts literals).
    writeDedupeThreshold: 0.92,
    conflictScanThreshold: 0.75,
  },
  compression: {
    enabled: true,
    triggerCount: 200,
    importanceThreshold: 0.35,
    decayHalfLifeDays: 14,
  },
  graph: {
    enabled: true,
    maxEntities: 5000,
    pagerankDamping: 0.85,
    pagerankIterations: 20,
    pagerankEdgeDecayDays: 30,
    personalizationWeight: 0.6,
  },
  injection: {
    enabled: true,
    maxTokens: 2000,
    systemPromptPrefix:
      'You have access to a long-term memory palace. When the user references past context, consult it via the memory_retrieve tool before answering.',
    warmRanks: true,
    coreBudgetFraction: 1 / 3,
  },
  // Anonymous-write policy default. 'global' is the SECURITY-COMPATIBLE
  // choice, not the safest one: it reproduces the historical behavior
  // byte-for-byte (anonymous writes degrade to the global shared bucket),
  // so existing installs keep their exact data shape on upgrade. Hosts
  // that want isolation can set 'quarantine' (anonymous writes go to the
  // '__anonymous__' session bucket, invisible to identified users) or
  // 'reject' (fail-closed throw, for identity-guarantee hosts).
  scope: { kind: 'user', anonymousPolicy: 'global' },
};
