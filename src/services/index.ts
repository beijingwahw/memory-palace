/**
 * Service barrel export.
 */

export { MemoryStore, type StoreOptions, type ScanOptions, type ScanHit } from './memory-store.js';
export { scopeLevels as scopeClauses } from '../utils/scope.js';
export type {
  ScopeIdentity,
  ScopeLevelClause,
  VisibilityTier,
} from '../utils/scope.js';
export {
  MemoryIngestor,
  type IngestMessageInput,
  type IngestToolInput,
} from './memory-ingestor.js';
export {
  MemoryRetriever,
  type RetrieverConfig,
} from './memory-retriever.js';
export type { RetrievalQuery } from '../types/index.js';
export {
  MemoryCompressor,
  type CompressionConfig,
  type DistillOptions,
  type CompressionReportWithRetention,
} from './memory-compressor.js';
export {
  MemoryGraph,
  type GraphConfig,
  type GraphScope,
  type ExtractedEntity,
  type PriorDetail,
} from './memory-graph.js';
export {
  ContextInjector,
  type InjectionConfig,
  type InjectionInput,
  type InjectionOutput,
} from './context-injector.js';

// ----- Pure algorithm kernels (for extension authors) -----

export {
  pageRank,
  normalizeRanks,
  type PageRankEdge,
  type PageRankOptions,
} from '../utils/pagerank.js';

export {
  scopeLevels,
  widestLevel,
  tierDisjunction,
  buildTierCondition,
  resolveWriteTier,
  TIER_ORDER,
} from '../utils/scope.js';

export {
  clusterByConsensus,
  detectConflict,
  numericSignature,
  signaturesOf,
  cnNegationCount,
  type ConsensusInput,
  type ConsensusCluster,
  type ConsensusOptions,
} from '../utils/consensus.js';

export {
  parseQueryHints,
  type QueryHints,
} from '../utils/query-understanding.js';

export {
  minePatterns,
  type MinerItem,
  type MinedPattern,
  type MineOptions,
} from '../utils/pattern-miner.js';

export {
  gini,
  median,
  quantile,
  duplicationRatio,
  ratioAtLeast,
  type DuplicationOptions,
} from '../utils/health.js';

export {
  labelPropagation,
  type WeightedEdge,
  type CommunityReport,
} from '../utils/communities.js';

export {
  buildAdjacency,
  shortestPath,
} from '../utils/graph-paths.js';

export {
  CircuitBreaker,
  type BreakerState,
  type BreakerOptions,
} from '../utils/circuit-breaker.js';

export {
  anchorKey,
  neighborKeys,
  anchorPlanes,
  ANCHOR_COUNT,
} from '../utils/anchors.js';

export {
  feedbackVector,
  expansionTokens,
  type PrfOptions,
} from '../utils/prf.js';

export {
  SemanticQueryCache,
  type SemanticQueryCacheOptions,
} from '../utils/query-cache.js';

export { visibleAtLevel } from '../utils/scope.js';

export {
  MemoryFederation,
  type ExportQuery,
  type ImportOptions,
  type ImportReport,
} from './memory-federation.js';

// ----- Service classes (extension authors) ---------------------------------
// Previously only the "core five" services were re-exported; the nine
// below were reachable only via deep imports that the package exports
// field blocks. Re-exported here so external extensions can type and
// construct them from the barrel like everything else.

export {
  CoreMemoryService,
  CORE_BLOCK_NAMES,
  DEFAULT_BLOCK_CAP,
  type CoreBlock,
  type CoreBlockName,
  type CoreHistoryEntry,
  type CoreWriteResult,
} from './core-memory.js';

export { SleepCycle, type DreamReport } from './sleep.js';

export {
  Inferencer,
  type InferenceReport,
} from './inferencer.js';

export {
  SpaceMigrator,
  type MigrationTickResult,
} from './space-migrator.js';

export {
  IntentPredictor,
  type PrefetchReport,
} from './intent-predictor.js';

export {
  FeedbackLearner,
  type LearnReport,
} from './feedback-learner.js';

export {
  Stratifier,
  type StratifyReport,
} from './stratifier.js';

export {
  FederatedRetriever,
  type PalaceMember,
} from './federated-retriever.js';

export {
  CrdtFederation,
  type SyncReport,
} from './crdt-federation.js';

// ----- Genesis invariant layer ----------------------------------------------

export { invariant, assertNamedParamParity } from '../utils/invariants.js';

export {
  MemoryReflector,
  type ReflectionReport,
  type ReflectionSweep,
} from './reflector.js';

export {
  canonicalJson,
  capsuleItemId,
  parseCapsule,
  planImport,
  signCapsule,
  verifyCapsule,
  toCapsuleItem,
  normalizedContent,
  type MemoryCapsule,
  type CapsuleItem,
  type CapsulePattern,
  type ImportPlan,
  type ImportConflict,
} from '../utils/capsule.js';

export {
  buildBenchmark,
  mrr,
  rankOf,
  recallAtK,
  reflectionGrid,
  objective,
  type BenchEntry,
  type ReflectionParams,
} from '../utils/reflection.js';

export { clamp01, clampNum } from '../utils/math.js';
export { McpPalaceServer, MCP_PROTOCOL_VERSION } from '../mcp-server.js';
export { VERSION } from '../types/index.js';

// HTTP federation transport (server + member client) — re-exported here
// so extension authors reach it from the package barrel.
export * from '../transport/index.js';
