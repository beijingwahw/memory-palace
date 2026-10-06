/**
 * DSH Memory Palace — Cordis plugin entry point.
 *
 * Wires up the layered memory stack (store / ingestor / retriever /
 * compressor / graph / injector), exposes services via the Cordis kernel,
 * subscribes to DSH lifecycle hooks (session.start, message.*, tool.*),
 * and registers the fifteen model-callable memory tools when the host
 * implements the DSH TypeScript Tool Contract (ctx.tool).
 *
 * All service events flow through a MemoryEventBus that forwards to
 * ctx.emit — services themselves stay Cordis-agnostic (ports & adapters),
 * and the emitted event names match plugin.json exactly.
 */

import type {
  CordisContext,
  CordisEvent,
  CordisPlugin,
  ToolDefinition,
  ToolContext,
} from './types/cordis.js';
import { randomUUID } from 'node:crypto';
import { MemoryStore, type ScopedStats } from './services/memory-store.js';
import { MemoryIngestor } from './services/memory-ingestor.js';
import { MemoryRetriever } from './services/memory-retriever.js';
import { MemoryCompressor } from './services/memory-compressor.js';
import { MemoryFederation } from './services/memory-federation.js';
import { CoreMemoryService, CORE_BLOCK_NAMES, type CoreBlockName } from './services/core-memory.js';
import { SleepCycle } from './services/sleep.js';
import { Inferencer } from './services/inferencer.js';
import { SpaceMigrator } from './services/space-migrator.js';
import { IntentPredictor } from './services/intent-predictor.js';
import { FeedbackLearner } from './services/feedback-learner.js';
import { Stratifier } from './services/stratifier.js';
import { FederatedRetriever, type PalaceMember } from './services/federated-retriever.js';
import { MemoryReflector } from './services/reflector.js';
import { MemoryGraph, extract } from './services/memory-graph.js';
import { ContextInjector } from './services/context-injector.js';
import { CrdtFederation } from './services/crdt-federation.js';
import { createEmbeddingProvider, cosine, type EmbeddingGateway } from './utils/embedding.js';
import { clamp01 } from './utils/math.js';
import {
  ANONYMOUS_REJECT_MESSAGE,
  applyAnonymousWritePolicy,
  scopeLevels,
  tierDisjunction,
  widestLevel,
  type ScopeLevelClause,
} from './utils/scope.js';
import { parseQueryHints } from './utils/query-understanding.js';
import { ARMS, type Arm } from './utils/bandit.js';
import { clusterByConsensus, detectConflict } from './utils/consensus.js';
import { labelPropagation } from './utils/communities.js';
import { buildAdjacency, shortestPath } from './utils/graph-paths.js';
import { duplicationRatio, gini, median, ratioAtLeast } from './utils/health.js';
import { truncateText as truncate } from './utils/tokenizer.js';
import { invariant } from './utils/invariants.js';
import {
  DEFAULT_CONFIG,
  type AnonymousWritePolicy,
  type MemoryEventBus,
  type MemoryItem,
  type MemoryScope,
  type MemoryScopeKind,
  type PluginConfig,
  type RetrievalHit,
  type RetrievalQuery,
  type RetrievalResult,
  type ScopeSettings,
} from './types/index.js';

/** Helper to safely extract string fields from a Cordis event payload. */
function pickString(
  payload: Record<string, unknown> | undefined,
  key: string,
): string {
  const v = payload?.[key];
  return typeof v === 'string' ? v : '';
}

function pickOptString(
  payload: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = payload?.[key];
  return typeof v === 'string' ? v : undefined;
}

/** Message-event scope with only the fields the event actually carries —
 *  undefined ids are omitted rather than passed as explicit undefined. */
function messageScopeOf(
  event: CordisEvent,
): { userId?: string; workspaceId?: string; sessionId?: string } {
  const scope: { userId?: string; workspaceId?: string; sessionId?: string } = {};
  const userId = pickOptString(event.payload, 'userId');
  const workspaceId = pickOptString(event.payload, 'workspaceId');
  if (userId) scope.userId = userId;
  if (workspaceId) scope.workspaceId = workspaceId;
  if (event.sessionId) scope.sessionId = event.sessionId;
  return scope;
}

/**
 * Narrow catch predicate for the event handlers: ONLY the anonymous-write
 * policy rejection ('reject' tri-state) is swallowed — logged as a warn
 * and the event skipped. Every other ingest failure keeps its historical
 * propagation to the host kernel.
 */
function isAnonymousRejection(err: unknown): boolean {
  return err instanceof Error && err.message.includes(ANONYMOUS_REJECT_MESSAGE);
}

/**
 * Runtime-validate an anonymous-write policy value read from the host's
 * (untyped JSON) options into the declared union. The declared type is
 * granted only AFTER the value survives this check, so the historical
 * install-time throw keeps policing the wire exactly as before.
 */
function validateAnonymousPolicy(v: unknown): AnonymousWritePolicy {
  if (v === 'global' || v === 'quarantine' || v === 'reject') return v;
  throw new Error(
    `[memory-palace] invalid scope.anonymousPolicy "${String(v)}" ` +
      `(legal values: global | quarantine | reject)`,
  );
}

export interface MemoryPalaceOptions extends Omit<Partial<PluginConfig>, 'scope'> {
  /** Provided by Cordis kernel at install time. */
  workspaceDir?: string;
  /**
   * Scope section. TWO accepted forms (mirrored by plugin.json's oneOf):
   *   - legacy scalar kind: 'user' | 'workspace' | 'session'
   *   - object (ScopeSettings): { kind, anonymousPolicy?, adminUserIds? }
   *     — anonymousPolicy is the tri-state policy for writes carrying no
   *     owner id at all; adminUserIds is the admin whitelist for global
   *     side-effect tools (memory_migrate live runs), tri-state on KEY
   *     PRESENCE (absent = single-user trust model).
   * Both normalize at install into config.scope = { kind, anonymousPolicy,
   * adminUserIds? }.
   */
  scope?: MemoryScopeKind | ScopeSettings;
}

const PLUGIN_NAME = 'memory-palace';

/**
 * Weak (guessable) session-id hygiene — D-09's residual risk made
 * observable at the message boundary. The session tier is a
 * bearer-credential visibility group (INVARIANTS I-ACL-17): anyone
 * presenting the sessionId sees the group's rows. That is DESIGN, not a
 * bug — but a host minting guessable ids ("default", "test", "12345678")
 * has dismantled its own group boundary, so the message handlers surface
 * exactly one warn per weak id. Purely advisory: zero behavior change on
 * any ingest path.
 */
const WEAK_SESSION_ID_WORDS = new Set([
  'default', 'session', 'test', 'admin', 'anon', 'common', 'shared',
  'global', 'user', 'tmp', 'debug', 'demo',
]);

/**
 * Cap on distinct weak ids warned about per process. Past the cap new
 * weak ids are skipped SILENTLY: a hostile or misconfigured host could
 * spray unbounded distinct weak ids, and an unbounded per-process
 * registry is exactly the memory bloat this cap exists to prevent (the
 * warn stream itself is already per-id-once).
 */
const WEAK_SESSION_WARN_CAP = 256;

/** Seen-weak-id registry backing the per-id-once warn discipline. */
const warnedSessionIds = new Set<string>();

/**
 * Weak = shorter than 8 chars, purely numeric, or a common word — every
 * shape an uninvited party can enumerate or guess on the first try.
 * 'a1b2c3d9strong' fails all three tests; '12345678' passes length but
 * is pure digits; 'default' hits the wordlist (and the length floor).
 */
function looksWeakSessionId(id: string): boolean {
  if (id.length < 8) return true;
  if (/^\d+$/.test(id)) return true;
  return WEAK_SESSION_ID_WORDS.has(id.toLowerCase());
}

/** Warn once per weak session id (per process); no-op for strong or
 *  already-warned ids, and silent once the registry cap is reached. */
function warnWeakSessionIdOnce(
  logger: CordisContext['logger'],
  sessionId: string | undefined,
): void {
  if (!sessionId) return;
  if (!looksWeakSessionId(sessionId)) return;
  if (warnedSessionIds.has(sessionId)) return;
  if (warnedSessionIds.size >= WEAK_SESSION_WARN_CAP) return;
  warnedSessionIds.add(sessionId);
  logger.warn(
    `[${PLUGIN_NAME}] session id "${sessionId}" is guessable; ` +
      'session tier is a bearer-credential visibility group — ' +
      'use unguessable session ids',
  );
}

/** Re-check mid-session compression + embedder health after N message events. */
const COMPRESS_CHECK_EVERY = 25;

/**
 * Per-context close callbacks, one per plugin install. Signal handlers are
 * hooked at most once per process, but the plugin function runs once per
 * Cordis context — a module-level boolean guard would hook only the FIRST
 * context's closeOnce and leave every later instance's store unclosed on
 * SIGINT/SIGTERM. The signal handler walks the whole registry; each entry
 * is idempotent (double signal, signal-after-dispose) and 'dispose'
 * unregisters its entry so dev-mode reinstalls cannot grow the registry
 * without bound.
 */
const signalCloseCallbacks: Array<() => void> = [];
let signalHandlersHooked = false;

/**
 * Deterministic exploration cadence for the fusion bandit: every
 * EXPLORE_EVERY_N-th model retrieval asks the learner for exploration
 * weights, so under-tried fusion arms keep receiving traffic; every other
 * retrieval serves the greedy learned weights. Module-level because the
 * tool closures outlive any single plugin install / retrieve call — and
 * DELIBERATELY shared across every plugin instance in the process: the
 * exploration beat is a property of the process (one shared cadence), not
 * of any one context, so multiple installs cannot each reset the count
 * and multiply the exploration rate.
 */
const EXPLORE_EVERY_N_RETRIEVALS = 10;
let modelRetrievalCount = 0;

const MemoryPalacePlugin: CordisPlugin<MemoryPalaceOptions> = (ctx, options = {}) => {
  // ---- scope section: normalize + fail-loud policy validation ----------
  // plugin.json accepts BOTH the legacy scalar kind ('scope': 'user') and
  // the object form ({ kind, anonymousPolicy }). Both normalize here into
  // one resolved pair: `scopeKind` feeds the MemoryScopeKind-typed service
  // constructors; `anonymousPolicy` rides into config.scope (and from
  // there into the ingestor). An invalid policy value throws AT INSTALL
  // with the legal values listed — fail-loud, consistent with the
  // project's config style.
  const scopeOpt = options.scope ?? DEFAULT_CONFIG.scope;
  const anonymousPolicy: AnonymousWritePolicy = validateAnonymousPolicy(
    (typeof scopeOpt === 'object' ? scopeOpt.anonymousPolicy : undefined) ??
      DEFAULT_CONFIG.scope.anonymousPolicy ??
      'global',
  );
  // Admin whitelist for global side-effect tools (memory_migrate live
  // runs). TRI-STATE on key presence — see ScopeSettings.adminUserIds.
  // Present-but-invalid throws AT INSTALL, fail-loud: an empty array is
  // "configured but nobody allowed" (almost always a typo that would brick
  // the tool while LOOKING locked down), and an empty-string element can
  // never match a real caller id yet reads like a working entry. Both are
  // operator errors, surfaced at boot rather than silently absorbed.
  const adminUserIds: string[] | undefined =
    typeof scopeOpt === 'object' ? scopeOpt.adminUserIds : undefined;
  if (adminUserIds !== undefined) {
    if (
      !Array.isArray(adminUserIds) ||
      adminUserIds.length === 0 ||
      !adminUserIds.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      throw new Error(
        '[memory-palace] invalid scope.adminUserIds ' +
          '(must be a non-empty array of non-empty user-id strings)',
      );
    }
  }
  // Wire-tolerant kind read: a host's object-form scope section is untyped
  // JSON and may omit `kind`; the local optional spelling keeps the
  // historical fall-back-to-default behavior for that malformed input.
  const kindFromSection: MemoryScopeKind | undefined =
    typeof scopeOpt === 'object' ? scopeOpt.kind : undefined;
  const scopeKind: MemoryScopeKind =
    typeof scopeOpt === 'object'
      ? (kindFromSection ?? DEFAULT_CONFIG.scope.kind)
      : scopeOpt;

  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...options,
    embedding: { ...DEFAULT_CONFIG.embedding, ...(options.embedding ?? {}) },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...(options.retrieval ?? {}) },
    compression: { ...DEFAULT_CONFIG.compression, ...(options.compression ?? {}) },
    graph: { ...DEFAULT_CONFIG.graph, ...(options.graph ?? {}) },
    injection: { ...DEFAULT_CONFIG.injection, ...(options.injection ?? {}) },
    // Resolved scope section (see above): always the canonical object —
    // even when the caller passed the legacy scalar form. adminUserIds is
    // spread conditionally so the KEY stays absent (not present-undefined)
    // when unconfigured — presence is the tri-state signal the
    // memory_migrate admin gate keys on.
    scope: {
      kind: scopeKind,
      anonymousPolicy,
      ...(adminUserIds ? { adminUserIds } : {}),
    },
  };

  // Substitute ${workspace} token in storagePath
  if (options.workspaceDir && config.storagePath.includes('${workspace}')) {
    config.storagePath = config.storagePath.replace(
      '${workspace}',
      options.workspaceDir,
    );
  }

  // Ports & adapters: services emit through this bus; the adapter forwards
  // to the Cordis kernel. Event names are the ones declared in plugin.json.
  const bus = {
    emit: (event: string, payload: unknown): void => {
      ctx.emit(event, payload);
    },
  };

  const embedder: EmbeddingGateway = createEmbeddingProvider(config.embedding);
  const primarySpace = embedder.spaces()[0];
  const store = new MemoryStore(
    {
      storagePath: config.storagePath,
      dimensions: embedder.dimensions,
      scope: scopeKind,
      ...(primarySpace !== undefined ? { activeSpace: primarySpace } : {}),
      quantization: config.retrieval.quantization,
    },
    bus,
  );
  // 4th argument: the resolved anonymous-write policy — every write that
  // goes through the ingestor (messages, tool calls, user memories, and
  // with them the remember tool, stratifier digests and inferencer
  // facts) inherits it at the single choke point.
  const ingestor = new MemoryIngestor(store, embedder, scopeKind, anonymousPolicy);
  const graph = new MemoryGraph(store, config.graph, bus);
  // Shared retrieval tuning: the reflector must grade the pipeline with
  // EXACTLY the knobs production retrieval serves with, or its
  // recommendations drift away from the behavior they were measured
  // against. One literal, two consumers (both treat it read-only).
  const retrievalTuning = {
    topK: config.retrieval.topK,
    mmrLambda: config.retrieval.mmrLambda,
    minScore: config.retrieval.minScore,
    rerank: config.retrieval.rerank,
    graphBoost: config.retrieval.graphBoost,
    graphPersonalization: config.graph.personalizationWeight,
    decayHalfLifeDays: config.compression.decayHalfLifeDays,
    scope: scopeKind,
    prf: config.retrieval.prf,
    entityHop: config.retrieval.entityHop,
    queryCache: config.retrieval.queryCache,
    ivf: config.retrieval.ivf,
  };
  const retriever = new MemoryRetriever(
    store,
    embedder,
    retrievalTuning,
    config.graph.enabled ? graph : undefined,
    bus,
  );
  const compressor = new MemoryCompressor(store, embedder, config.compression, bus);
  if (config.graph.enabled) ingestor.bindGraph(graph);
  const core = new CoreMemoryService(store, graph, scopeKind, bus);
  const injector = new ContextInjector(retriever, graph, store, config.injection, scopeKind, core);
  const federation = new MemoryFederation(store, graph, retriever, scopeKind, bus, embedder);
  const reflector = new MemoryReflector(
    store,
    embedder,
    retrievalTuning,
    config.graph.enabled ? graph : undefined,
    bus,
  );
  const inferencer = new Inferencer(store, ingestor, scopeKind, bus);
  const migrator = new SpaceMigrator(store, embedder, {}, bus);
  const predictor = new IntentPredictor(store, retriever, graph, scopeKind, bus);
  const learner = config.retrieval.fusionLearning.enabled
    ? new FeedbackLearner(store, bus)
    : null;
  // 5th param (gateway) enables same-id digest refresh so era summaries
  // stay current instead of freezing at their first version. 6th param
  // (graph) feeds the stratify kernel's hot-entity salience boost —
  // same optional-wiring style as the retriever/reflector gate above.
  const stratifier = new Stratifier(
    store,
    ingestor,
    scopeKind,
    bus,
    embedder,
    config.graph.enabled ? graph : undefined,
  );
  const sleep = new SleepCycle(store, compressor, core, inferencer, migrator, stratifier, scopeKind, bus);
  // Capsule provenance must survive restarts: mint the palace id once and
  // persist it in palace_meta (metadata writes deliberately do not bump
  // the data version, so this cannot invalidate the retrieval caches).
  const persistedPalaceId = store.getMeta('palaceId');
  const palaceId = persistedPalaceId ?? randomUUID();
  if (!persistedPalaceId) {
    try {
      store.setMeta('palaceId', palaceId);
    } catch (err) {
      ctx.logger.warn(`[${PLUGIN_NAME}] palaceId persistence failed: ${String(err)}`);
    }
  }
  // CRDT federation: multi-master sync without a coordinator. The stable
  // palaceId doubles as the replica id, so a restarted palace resumes its
  // own Lamport counter space instead of colliding with its own history.
  const crdtFederation = new CrdtFederation(store, palaceId, bus);
  // The federation registers THIS palace as its first member; remote members
  // (other palaces over MCP/capsules) join via facade.federationRouter.addMember.
  const federationRouter = new FederatedRetriever(
    [{ name: 'local', retrieve: (q) => retriever.retrieve(q) } satisfies PalaceMember],
    bus,
  );

  // Register Cordis services ----------------------------------------------
  ctx.service('memory-store', store);
  ctx.service('memory-ingestor', ingestor);
  ctx.service('memory-retriever', retriever);
  ctx.service('memory-compressor', compressor);
  ctx.service('memory-graph', graph);
  ctx.service('context-injector', injector);
  ctx.service('memory-federation', federation);
  ctx.service('memory-reflector', reflector);
  ctx.service('memory-core', core);
  ctx.service('sleep-cycle', sleep);
  ctx.service('memory-inferencer', inferencer);
  ctx.service('space-migrator', migrator);
  ctx.service('intent-predictor', predictor);
  ctx.service('feedback-learner', learner);
  ctx.service('stratifier', stratifier);
  ctx.service('crdt-federation', crdtFederation);
  ctx.service('federated-retriever', federationRouter);

  // Expose a single facade service for ergonomic access. The facade is a
  // public service: any ctx.service('memory-palace') consumer can read it,
  // so the config it exposes carries a redacted embedding API key. The
  // internal wiring above (embedder, store, retriever, …) keeps using the
  // real `config` variable — only the published copy is sanitized.
  const publicConfig: PluginConfig = {
    ...config,
    embedding: {
      ...config.embedding,
      ...(config.embedding.apiKey ? { apiKey: '***redacted***' } : {}),
    },
  };
  const facade = {
    embedder,
    store,
    ingestor,
    retriever,
    compressor,
    graph,
    injector,
    federation,
    reflector,
    core,
    sleep,
    inferencer,
    migrator,
    predictor,
    learner,
    stratifier,
    federationRouter,
    crdtFederation,
    palaceId,
    config: publicConfig,
    stats(scope?: MemoryScope) {
      // DUAL CONTRACT, one method (D-01):
      //  - scope GIVEN → first-class SCOPED counts: statsScoped at the
      //    widest cumulative level of the caller's cascade. Returns ONLY
      //    the scoped census — byTier is a whole-store tenant
      //    distribution, an admin-plane view deliberately NOT mixed into
      //    a scoped response (a caller must not be able to read other
      //    tenants' footprint out of their own counts call).
      //  - scope OMITTED → the ADMIN-PLANE global census (whole-store
      //    counts + byTier tenant distribution), unchanged — management
      //    telemetry for programmatic consumers. Request-facing tools
      //    must never take this branch; audit check 11 pins it.
      if (scope) {
        return { scoped: store.statsScoped(widestLevel(scopeLevels(config.scope.kind, scope))) };
      }
      return store.stats(); // audit-ok: admin-plane dispatch (check 11); tool-layer callers must pass a scope
    },
    async retrieve(query: string, opts: { topK?: number; userId?: string; workspaceId?: string; sessionId?: string } = {}) {
      // Explicit, whitelisted construction. The old `{ query, ...opts,
      // scope: opts }` leaked topK into the scope AND scope ids into the
      // query body — bidirectional pollution of both shapes.
      const q: RetrievalQuery = {
        query,
        ...(opts.topK !== undefined ? { topK: opts.topK } : {}),
        scope: {
          ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
          ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        },
      };
      return retriever.retrieve(q);
    },
    /**
     * Write a user-curated memory ("remember that …"). Identity is now a
     * first-class opt: programmatic callers can specify WHO the memory
     * belongs to (userId / workspaceId / sessionId) — previously the
     * facade only offered the identity-less path, leaving every write to
     * the anonymous write-policy resolution (the mirror asymmetry with
     * facade.retrieve, which always took a scope). Additive optionals, so
     * existing two-arg callers are unaffected.
     */
    async remember(
      content: string,
      opts: {
        tags?: string[];
        importance?: number;
        userId?: string;
        workspaceId?: string;
        sessionId?: string;
      } = {},
    ) {
      return ingestor.ingestUserMemory({
        content,
        ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
        ...(opts.importance !== undefined ? { importance: opts.importance } : {}),
        ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
        ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      });
    },
  };
  ctx.service('memory-palace', facade);

  // Model tools (DSH TypeScript Tool Contract) ------------------------------
  // Registered only when the host provides ctx.tool; the definitions are
  // built unconditionally so tests and programmatic users can reuse them.
  const tools: ToolDefinition[] = buildToolDefinitions(
    facade,
    bus,
    (msg): void => {
      ctx.logger.warn(msg);
    },
  );
  if (typeof ctx.tool === 'function') {
    for (const tool of tools) ctx.tool(tool);
  }

  // Mid-session lifecycle maintenance ---------------------------------------
  // session.end-only compression lets a marathon session grow memory
  // unbounded between checks; both message handlers count ingested events
  // and every COMPRESS_CHECK_EVERY-th one re-runs compression inline (same
  // gates as session.end) and re-probes the embedder's circuit state.
  let messageEventsSinceCheck = 0;

  // Embedding degradation observability. The EmbeddingGateway type does not
  // declare the resilient provider's `degraded` getter, so probe it
  // structurally: `'degraded' in embedder` is false for plain offline
  // gateways (the getter lives on the ResilientEmbeddingProvider
  // prototype), and the narrow cast reads it only when present — offline-
  // by-configuration hosts never log degrade/recover noise.
  let lastDegraded = false;
  const checkEmbedderHealth = (): void => {
    const degraded =
      'degraded' in embedder &&
      (embedder as { degraded?: boolean }).degraded === true;
    if (degraded === lastDegraded) return;
    lastDegraded = degraded;
    if (degraded) {
      ctx.logger.warn(
        '[memory-palace] embedding degraded: serving offline fallback vectors (circuit open)',
      );
    } else {
      ctx.logger.info(
        '[memory-palace] embedding recovered: primary provider back in service',
      );
    }
  };

  /** Called after each message ingest; ticks every COMPRESS_CHECK_EVERY-th. */
  const onMessageMaintenanceTick = async (
    scope: { userId?: string; workspaceId?: string; sessionId?: string },
  ): Promise<void> => {
    messageEventsSinceCheck++;
    if (messageEventsSinceCheck < COMPRESS_CHECK_EVERY) return;
    messageEventsSinceCheck = 0;
    checkEmbedderHealth();
    if (!config.compression.enabled || !compressor.shouldRun()) return;
    try {
      const report = await compressor.runOnce();
      // Core compaction rides the same tick so the self stays current —
      // compacting the caller's FULL scope, not an anonymous void.
      // compactAll is synchronous today (a throw lands in this tick's
      // catch); the Promise.resolve wrap keeps the fire-and-forget safe
      // against a future async compactAll (a rejected promise must never
      // become an unhandledRejection — chaos invariant d).
      void Promise.resolve(core.compactAll(scope)).catch((err: unknown) => {
        ctx.logger.error(
          `[${PLUGIN_NAME}] mid-session core compaction failed: ${String(err)}`,
        );
      });
      // Retention counts are optional (only set after a real, non-skipped
      // pass) — append them only when the report carries them.
      const retention =
        report.expiredSwept !== undefined ||
        report.eventsPruned !== undefined ||
        report.tombstonesPurged !== undefined
          ? ` expiredSwept=${report.expiredSwept ?? 0}` +
            ` eventsPruned=${report.eventsPruned ?? 0}` +
            ` tombstonesPurged=${report.tombstonesPurged ?? 0}`
          : '';
      ctx.logger.info(
        `[${PLUGIN_NAME}] mid-session compression: ` +
          `evictedItems=${report.evictedItems} ` +
          `newSemanticItems=${report.newSemanticItems}${retention}`,
      );
    } catch (err) {
      // Compression is housekeeping: its failure must never break the
      // message ingestion path it runs inside.
      ctx.logger.error(
        `[${PLUGIN_NAME}] mid-session compression failed: ${String(err)}`,
      );
    }
  };

  // Lifecycle hooks --------------------------------------------------------
  ctx.on('session.start', async (event: CordisEvent) => {
    checkEmbedderHealth();
    ctx.logger.info(`[${PLUGIN_NAME}] session.start sid=${event.sessionId}`);
    const opening = pickOptString(event.payload, 'openingMessage');
    if (opening && config.injection.enabled) {
      const injectWorkspaceId = pickOptString(event.payload, 'workspaceId');
      const injectUserId = pickOptString(event.payload, 'userId');
      const injectScope: MemoryScope = {
        sessionId: event.sessionId,
        ...(injectWorkspaceId !== undefined ? { workspaceId: injectWorkspaceId } : {}),
        ...(injectUserId !== undefined ? { userId: injectUserId } : {}),
      };
      try {
        const out = await injector.inject({
          sessionId: event.sessionId,
          intent: opening,
          ...(injectWorkspaceId !== undefined ? { workspaceId: injectWorkspaceId } : {}),
          ...(injectUserId !== undefined ? { userId: injectUserId } : {}),
        });
        ctx.emit('memory.context-injected', out);
      } catch (err) {
        // Injection is context warmth, not a session prerequisite: log
        // and let the session proceed without palace context.
        ctx.logger.error(`[${PLUGIN_NAME}] context injection failed: ${String(err)}`);
      }
      // Speculative warmth: predict this session's follow-ups from the
      // user's trajectory history and warm PPR + the semantic cache NOW.
      // Strictly non-blocking — a slow or failed prefetch must never hold
      // (or break) the session.
      // THE SHAPE IS LOAD-BEARING: with fusionLearning on (the default),
      // the production memory_retrieve tool ALWAYS carries the learner's
      // greedy fusionOverrides, and those ride inside the query-cache
      // paramsKey (stableFusionKey) — warming without them filed every
      // entry in the no-overrides partition the real follow-up never
      // reads, i.e. pure wasted embedding calls. The explore step (every
      // 10th tool retrieval) deliberately keeps its own partition:
      // exploration weights are not a shape production serves twice.
      const warm = learner
        ? { fusionOverrides: learner.weights(injectScope, false) }
        : undefined;
      void predictor
        .prefetch(opening, injectScope, warm)
        .then((warmth) => {
          if (warmth.warmed > 0) {
            ctx.logger.debug(
              `[${PLUGIN_NAME}] prefetched ${warmth.warmed} follow-ups for this intent`,
            );
          }
        })
        .catch((err: unknown) => {
          ctx.logger.warn(`[${PLUGIN_NAME}] prefetch failed: ${String(err)}`);
        });
    }
  });

  ctx.on('session.end', async (event: CordisEvent) => {
    ctx.logger.info(`[${PLUGIN_NAME}] session.end sid=${event.sessionId}`);
    // ANONYMOUS-WRITE POLICY at the sleep boundary: everything sleep
    // hands the scope to (core compaction, inference, stratification —
    // the latter two writing through the ingestor, which re-applies the
    // policy) receives the CONVERTED identity, so anonymous-triggered
    // consolidation lands in the '__anonymous__' bucket instead of the
    // global tier. CONSERVATIVE choice for 'reject': a session.end with
    // NO id at all is skipped outright with a warn — an anonymous
    // trigger has no business driving consolidation at all (its
    // compression phases are store-wide maintenance), and half-sleeping
    // with a fabricated id would be worse. Identified session.ends sleep
    // exactly as before under every policy.
    let sleepScope: { userId?: string; workspaceId?: string; sessionId?: string };
    const endUserId = pickOptString(event.payload, 'userId');
    const endWorkspaceId = pickOptString(event.payload, 'workspaceId');
    try {
      sleepScope = applyAnonymousWritePolicy(
        {
          ...(endUserId !== undefined ? { userId: endUserId } : {}),
          ...(endWorkspaceId !== undefined ? { workspaceId: endWorkspaceId } : {}),
          sessionId: event.sessionId,
        },
        anonymousPolicy,
      );
    } catch (err) {
      ctx.logger.warn(
        `[${PLUGIN_NAME}] session.end skipped (anonymous, anonymousPolicy=reject): ${String(err)}`,
      );
      return;
    }
    // The night shift: compression + pattern mining + core compaction in
    // one failure-isolated pass (emits memory.compressed / memory.slept).
    try {
      const dream = await sleep.sleep(sleepScope);
      ctx.logger.info(`[${PLUGIN_NAME}] slept: ${dream.notes.join(' | ')}`);
    } catch (err) {
      ctx.logger.error(`[${PLUGIN_NAME}] sleep cycle failed: ${String(err)}`);
    }
  });

  ctx.on('message.user', async (event: CordisEvent) => {
    // Entry-position hygiene warn (D-09 residual risk): fires before the
    // empty-message guard and before ingest — zero behavior change.
    warnWeakSessionIdOnce(ctx.logger, event.sessionId);
    // Entity extraction happens ONCE, inside the ingestor (it is
    // graph-bound); a second call here used to double every mention count
    // and co-occurrence edge weight for user messages.
    const content = pickString(event.payload, 'content');
    // Empty-message guard: whitespace-only payloads would otherwise ingest
    // a content-free event row (and mint a pointless episodic event). The
    // ingestor carries the same guard — this is the double insurance at
    // the event boundary.
    if (!content.trim()) return;
    const scope = messageScopeOf(event);
    try {
      await ingestor.ingestMessage({
        role: 'user',
        content,
        sessionId: event.sessionId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
      });
    } catch (err) {
      // anonymousPolicy='reject' drops the message with a warn instead of
      // crashing the handler; any other failure keeps propagating.
      if (isAnonymousRejection(err)) {
        ctx.logger.warn(
          `[${PLUGIN_NAME}] message.user dropped (anonymous, anonymousPolicy=reject)`,
        );
        return;
      }
      throw err;
    }
    await onMessageMaintenanceTick(
      applyAnonymousWritePolicy(scope, anonymousPolicy),
    );
  });

  ctx.on('message.assistant', async (event: CordisEvent) => {
    // Same entry-position hygiene warn as message.user (D-09 residual
    // risk); before the guard and ingest, zero behavior change.
    warnWeakSessionIdOnce(ctx.logger, event.sessionId);
    const content = pickString(event.payload, 'content');
    // Same empty-message guard as message.user (double insurance).
    if (!content.trim()) return;
    const scope = messageScopeOf(event);
    try {
      await ingestor.ingestMessage({
        role: 'assistant',
        content,
        sessionId: event.sessionId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
      });
    } catch (err) {
      if (isAnonymousRejection(err)) {
        ctx.logger.warn(
          `[${PLUGIN_NAME}] message.assistant dropped (anonymous, anonymousPolicy=reject)`,
        );
        return;
      }
      throw err;
    }
    await onMessageMaintenanceTick(
      applyAnonymousWritePolicy(scope, anonymousPolicy),
    );
  });

  ctx.on('tool.call', async (event: CordisEvent) => {
    // Scope pass-through: without userId/workspaceId the ingestor's write
    // tier resolves to global — a tool call from an identified session
    // would land in the anonymous shared bucket.
    const scope = messageScopeOf(event);
    try {
      await ingestor.ingestToolCall({
        toolName: pickString(event.payload, 'toolName') || 'unknown',
        args: event.payload?.['args'],
        result: undefined,
        sessionId: event.sessionId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        success: true,
      });
    } catch (err) {
      if (isAnonymousRejection(err)) {
        ctx.logger.warn(
          `[${PLUGIN_NAME}] tool.call dropped (anonymous, anonymousPolicy=reject)`,
        );
        return;
      }
      throw err;
    }
  });

  ctx.on('tool.result', async (event: CordisEvent) => {
    const error = event.payload?.['error'];
    // Absent error field (undefined/null) = success. An error that is
    // merely falsy — the empty string — is still an error: `!error`
    // would have scored '' as a success.
    const success = error === undefined || error === null;
    // Same scope pass-through as tool.call: a FAILED tool's result text
    // (often carrying sensitive payload fragments) must be distilled at
    // the caller's tier, not into the anonymous global bucket.
    const scope = messageScopeOf(event);
    try {
      await ingestor.ingestToolCall({
        toolName: pickString(event.payload, 'toolName') || 'unknown',
        args: undefined,
        result: event.payload?.['result'],
        sessionId: event.sessionId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        success,
      });
    } catch (err) {
      if (isAnonymousRejection(err)) {
        ctx.logger.warn(
          `[${PLUGIN_NAME}] tool.result dropped (anonymous, anonymousPolicy=reject)`,
        );
        return;
      }
      throw err;
    }
  });

  // CRDT bridge ---------------------------------------------------------------
  // User-authored writes are mirrored as CRDT item-set ops so a peer
  // palace's sync() converges on them (content-addressed ids are the CRDT
  // keys). The store emits 'memory.after-store' after the row has already
  // committed, so this bridge is strictly best-effort: a failed op append
  // is logged and swallowed, never propagated into the ingest path.
  //
  // TX SAFETY: the emit fires synchronously inside putItem — which, on the
  // ingest paths, runs INSIDE ingestTx's open better-sqlite3 transaction.
  // recordSet → appendCrdtOp uses the same store connection synchronously,
  // so the op append simply joins that same transaction (better-sqlite3 is
  // single-connection, fully synchronous: no statement interleaving, no
  // async re-entrancy). The op commits or rolls back atomically with the
  // item row it mirrors.
  ctx.on('memory.after-store', (event: CordisEvent) => {
    const payload = event.payload;
    if (payload?.['source'] !== 'user') return;
    // DERIVED-ENTRY EXCLUSION: only genuine user-authored writes mirror as
    // CRDT item-set ops. The Inferencer stamps derived rows source
    // 'inferred' and the Stratifier stamps digest rows source 'system', so
    // both are naturally excluded by the source check above. Two belt-and-
    // braces guards cover the gaps the source stamp cannot:
    //   1. Legacy/hand-built rows that predate the stamps: the Inferencer's
    //      historical content prefix "Inferred (..%):" is rejected by shape
    //      (backwards compatibility with existing palaces).
    //   2. A parallel-rollout bridge payload that grows a tags field: if
    //      tags ever ride the event, 'stratified' entries stop here.
    const id = payload['id'];
    const content = payload['content'];
    if (typeof id !== 'string' || typeof content !== 'string') return;
    if (content.startsWith('Inferred (')) return;
    const tags = payload['tags'];
    if (Array.isArray(tags) && tags.includes('stratified')) return;
    try {
      crdtFederation.recordSet(id, content);
    } catch (err) {
      ctx.logger.warn(`[${PLUGIN_NAME}] crdt recordSet bridge failed: ${String(err)}`);
    }
  });

  // Graceful shutdown --------------------------------------------------------
  // closeOnce makes disposal idempotent: a host that emits 'dispose' twice,
  // or disposes after a signal already closed the store, must not throw.
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    try {
      store.close();
    } catch {
      /* already closed */
    }
  };
  ctx.on('dispose', () => {
    // Unregister first so a signal arriving during disposal cannot call a
    // half-disposed context's callback, then flush.
    const i = signalCloseCallbacks.indexOf(closeOnce);
    if (i >= 0) signalCloseCallbacks.splice(i, 1);
    closeOnce();
  });

  // Best-effort prompt checkpoint on SIGINT/SIGTERM. Registered only when
  // not already hooked by this module and only under a real process
  // (guards skip bundled/browser runtimes without `process`).
  //
  // LIMITATION (accepted): Node's once-listeners preempt the default
  // termination only while the event loop stays alive — if some other
  // handler calls process.exit, or the host otherwise keeps running, our
  // flush runs first; but if the process exits via default signal
  // behavior, this handler may never run. That is fine: the WAL already
  // guarantees durability even on a hard crash — close() merely
  // checkpoints promptly. We deliberately do NOT call process.exit here;
  // the host decides exit behavior, we only flush.
  if (
    !signalCloseCallbacks.includes(closeOnce) &&
    typeof process === 'object' &&
    typeof process.on === 'function'
  ) {
    signalCloseCallbacks.push(closeOnce);
  }
  if (
    !signalHandlersHooked &&
    typeof process === 'object' &&
    typeof process.on === 'function'
  ) {
    signalHandlersHooked = true;
    const closeAll = (): void => {
      for (const cb of [...signalCloseCallbacks]) cb();
    };
    process.once('SIGINT', closeAll);
    process.once('SIGTERM', closeAll);
  }

  ctx.logger.info(
    `[${PLUGIN_NAME}] installed at ${config.storagePath} ` +
      `(embedder=${embedder.name}, dim=${embedder.dimensions}, ` +
      `space=${embedder.spaces()[0]}, scope=${scopeKind})`,
  );
};

/** What the tools need from the plugin runtime. */
export interface ToolFacade {
  config: PluginConfig;
  /** Embedding gateway (dryRun degradation probing in memory_migrate). */
  embedder: EmbeddingGateway;
  store: MemoryStore;
  ingestor: MemoryIngestor;
  retriever: MemoryRetriever;
  graph: MemoryGraph;
  /** Capsule export/import (inter-agent knowledge transport). */
  federation: MemoryFederation;
  /** Self-consistency retrieval tuning. */
  reflector: MemoryReflector;
  /** Identity of this palace instance (capsule provenance). */
  palaceId: string;
  /** The persistent SELF (core blocks + sleep). */
  core: CoreMemoryService;
  sleep: SleepCycle;
  inferencer: Inferencer;
  migrator: SpaceMigrator;
  predictor: IntentPredictor;
  learner: FeedbackLearner | null;
  stratifier: Stratifier;
  federationRouter: FederatedRetriever;
  /** Multi-master CRDT sync (op log + convergence fingerprint). */
  crdtFederation: CrdtFederation;
  /**
   * Statistics — dual contract (D-01):
   *  - WITH a scope: { scoped: ScopedStats } — per-caller counts at the
   *    widest cumulative level of that scope's cascade. The ONLY form
   *    the tool layer may use; audit check 11 trips on bare no-argument
   *    calls inside tool code (they pool every tenant's rows).
   *  - WITHOUT a scope: the whole-store admin-plane census (management
   *    telemetry incl. the byTier tenant distribution) — reserved for
   *    the facade's programmatic consumers.
   *
   * OPTIONAL only because tool-only hosts assemble a facade without the
   * management-sugar methods (src/bin/mcp-palace.ts): the tools route
   * through scopedStatsOf, which falls back to the IDENTICAL
   * store.statsScoped computation when this member is absent.
   */
  stats?(scope?: MemoryScope): { scoped: ScopedStats } | ReturnType<MemoryStore['stats']>;
}

const VALID_LAYERS = new Set(['episodic', 'semantic', 'procedural']);
const VALID_ERA_LEVELS = new Set(['week', 'month', 'era']);

/** Runtime-validate caller-provided layer names — never trust the wire. */
function validateLayers(layers: string[] | undefined) {
  if (!layers || layers.length === 0) return undefined;
  const ok = layers.filter((l): l is 'episodic' | 'semantic' | 'procedural' =>
    VALID_LAYERS.has(l),
  );
  return ok.length > 0 ? ok : undefined;
}

const DAY_MS = 86_400_000;
/**
 * Fallback defaults for memory_remember's write-time scan thresholds.
 * DEFAULT_CONFIG carries the canonical values (types/index.ts); the ?? arm
 * only satisfies the optional field's type when a caller spreads an
 * explicit `undefined` over the merged config — behavior stays identical.
 */
const WRITE_DEDUPE_THRESHOLD_DFLT =
  DEFAULT_CONFIG.retrieval.writeDedupeThreshold ?? 0.92;
const CONFLICT_SCAN_THRESHOLD_DFLT =
  DEFAULT_CONFIG.retrieval.conflictScanThreshold ?? 0.75;

/**
 * Finite-or-default for wire-supplied numeric knobs. NaN/Infinity from a
 * model payload (JSON `NaN`, "abc" coerced upstream, …) must NEVER reach
 * the clamping chain: Math.min/Math.max propagate NaN unchanged and it
 * surfaces later as a SQL "datatype mismatch" far from the cause.
 * `undefined` (field omitted) falls back to the default like `??` would.
 */
function finiteOr(v: number | undefined, dflt: number): number {
  return v !== undefined && Number.isFinite(v) ? v : dflt;
}

/**
 * Threshold sanitation for memory_remember's write-time scans: finiteOr
 * rejects NaN/±Infinity (falling back to the default), then the value is
 * clamped into [lo, hi] so a typo like 42 or -1 can never turn the dedupe
 * scan into an everything-merge (or the conflict scan into a nothing-scan).
 * Bands: writeDedupeThreshold ∈ [0.5, 1] (below 0.5 barely-related rows
 * would merge), conflictScanThreshold ∈ [0, 1].
 */
function clampThreshold(
  v: number | undefined,
  dflt: number,
  lo: number,
  hi: number,
): number {
  return Math.min(hi, Math.max(lo, finiteOr(v, dflt)));
}

/**
 * memory_remember's unified four-state write outcome — one field covering
 * every exit path so callers (and tests) need no inference from field
 * combinations:
 *
 *  - 'created'          — a new row was written; nothing matched.
 *  - 'deduplicated'     — a non-contradictory near-duplicate matched; the
 *                         EXISTING id is returned, no new row stored.
 *  - 'superseded'       — conflicts found AND supersede=true: the outdated
 *                         rows are tombstoned, the new row is effective.
 *  - 'conflict-flagged' — conflicts found but supersede not requested:
 *                         flagged only, every row stays live.
 */
type WriteOutcome = 'created' | 'deduplicated' | 'superseded' | 'conflict-flagged';

/**
 * D-11 made runtime feedback: sparse offline-bm25 vectors (hashed token
 * bags) inflate cosine similarity for template-like content, so a
 * non-created outcome under the offline gateway is likelier a phrasing
 * artifact than a true semantic duplicate. One sentence, attached ONLY
 * when the gateway's primary space is the offline one — dense providers
 * do not need the caveat.
 */
const OFFLINE_SIMILARITY_ADVISORY =
  'sparse offline embeddings inflate similarity for template-like content; ' +
  'use distinct phrasing for intentionally different facts';

/** Link entity names mentioned in a query to graph entity ids (scoped). */
function linkQueryEntities(facade: ToolFacade, query: string, tctx: ToolContext): string[] {
  const levels = scopeLevels(facade.config.scope.kind, scopeOf(tctx));
  const ids: string[] = [];
  for (const { name } of extract(query)) {
    const ent = facade.store.findEntityInScope(name, levels);
    if (ent) ids.push(ent.id);
  }
  return ids;
}

/** Widest cumulative visibility level for a tool caller. */
function toolLevel(facade: ToolFacade, tctx: ToolContext) {
  return widestLevel(scopeLevels(facade.config.scope.kind, scopeOf(tctx)));
}

function scopeOf(tctx: ToolContext): MemoryScope {
  return {
    ...(tctx.userId !== undefined ? { userId: tctx.userId } : {}),
    ...(tctx.workspaceId !== undefined ? { workspaceId: tctx.workspaceId } : {}),
    // ToolContext.sessionId is required — always safe to carry directly.
    sessionId: tctx.sessionId,
  };
}

/**
 * Scoped census for one tool caller. Prefers the facade's dual-contract
 * method (facade stats WITH a scope); tool-only hosts that assemble a
 * facade without the management-sugar methods (src/bin/mcp-palace.ts)
 * fall back to the IDENTICAL store.statsScoped(level) computation, so
 * every host counts from the same scoped source. The scope argument is
 * always a defined object at every call site in this file, so the
 * global branch is unreachable in practice — but the facade's dual
 * contract is typed as a union, and a silent cast would hide a future
 * contract break; fail loud instead (the invariant() discipline).
 */
function scopedStatsOf(
  facade: ToolFacade,
  scope: MemoryScope,
  level: ScopeLevelClause,
): ScopedStats {
  if (facade.stats) {
    const s = facade.stats(scope);
    if (!('scoped' in s)) {
      throw new Error(
        '[memory-palace] stats(scope) returned the global form — scoped contract broken',
      );
    }
    return s.scoped;
  }
  return facade.store.statsScoped(level);
}

/**
 * JS-side visibility guard for rows the scoped queries cannot fetch —
 * restore targets a tombstoned row, and getItemInScope only sees LIVE
 * rows. Mirrors the SQL ACL in utils/scope.ts: the item's tier must
 * occur in one of the caller's cumulative levels AND the item's owner id
 * for that tier must equal the caller's. tierDisjunction builds the
 * caller's condition for exactly that tier (returning null when the
 * caller lacks the owner id for it), and its params carry the caller's
 * owner id to compare against the item's.
 */
function visibleToCaller(
  item: Pick<MemoryItem, 'visibility' | 'metadata'>,
  levels: ScopeLevelClause[],
): boolean {
  // NULL/legacy visibility rows read as global (see buildTierCondition).
  const tier = item.visibility ?? 'global';
  return levels.some((lvl) => {
    if (!lvl.tiers.includes(tier)) return false;
    if (tier === 'global') return true;
    const disj = tierDisjunction([tier], lvl.ids);
    if (!disj) return false; // caller has no owner id for this tier
    const owner =
      tier === 'session'
        ? item.metadata.sessionId
        : tier === 'workspace'
          ? item.metadata.workspaceId
          : item.metadata.userId;
    return disj.params[0] === owner;
  });
}

function compactHit(h: {
  item: {
    id: string;
    layer: string;
    content: string;
    createdAt: number;
    visibility?: string;
    metadata: { sessionId?: string; source?: string };
  };
  rawScore: number;
  finalScore: number;
  via?: 'vector' | 'entity-hop';
  explain?: {
    decayFactor: number;
    importanceFactor: number;
    graphMultiplier: number;
    keywordScore?: number;
    graph?: { entityName?: string; globalRank?: number; proximityRank?: number };
  };
}) {
  return {
    id: h.item.id,
    layer: h.item.layer,
    score: Number(h.finalScore.toFixed(3)),
    rawScore: Number(h.rawScore.toFixed(3)),
    content: truncate(h.item.content, 400),
    createdAt: h.item.createdAt,
    sessionId: h.item.metadata.sessionId,
    source: h.item.metadata.source,
    visibility: h.item.visibility,
    via: h.via,
    explain: h.explain
      ? {
          decay: Number(h.explain.decayFactor.toFixed(3)),
          importance: Number(h.explain.importanceFactor.toFixed(3)),
          graph: Number(h.explain.graphMultiplier.toFixed(3)),
          keyword: h.explain.keywordScore !== undefined ? Number(h.explain.keywordScore.toFixed(3)) : undefined,
          graphEntity: h.explain.graph,
        }
      : undefined,
  };
}

/**
 * Structural view of the store's integrity self-check report (orphan
 * buckets, dangling refs, overdue tombstones). Declared locally instead of
 * imported from memory-store so this file carries NO compile-time
 * dependency on the parallel integrityCheck change — the narrow read in
 * memory_inspect works whether or not the method has landed on MemoryStore.
 */
type IntegritySnapshot = { ok: boolean; details: string[]; [k: string]: unknown };

/**
 * Narrow an unknown integrityCheck() result into the snapshot shape,
 * passing every extra field (counts, findings, …) through untouched.
 * A non-object result (method absent mid-rollout, or a misbehaving build)
 * degrades to an ok:false snapshot — observation never throws.
 */
function toIntegritySnapshot(report: unknown): IntegritySnapshot {
  if (report && typeof report === 'object') {
    const r = report as Record<string, unknown>;
    return {
      ...r,
      ok: r['ok'] === true,
      details: Array.isArray(r['details'])
        ? r['details'].filter((d): d is string => typeof d === 'string')
        : [],
    };
  }
  return { ok: false, error: 'integrityCheck unavailable', details: [] };
}

/**
 * Self-consistency rank reward (DCG-flavored) for memory_why's feedback
 * signal. The old signal was structurally constant: engaged == totalHits
 * (every evidence item counts as engaged), so learn() always received the
 * ratio 1.0 and the bandit never learned anything about RANKING quality.
 * This probe instead re-asks the palace a question it should already know
 * the answer to — the evidence itself — and pays the evidence by where the
 * CURRENT ranking places it.
 *
 * Probe query: the first 160 CODE POINTS of the lexicographically-first
 * evidence item's content (Array.from iterates code points, so a surrogate
 * pair is never cut in half the way a UTF-16 slice could). itemsForEntity
 * Scoped's (importance DESC, created_at DESC) order is deterministic for
 * one fixed store state but not canonical across stores; sorting by the
 * immutable item id makes the probe a pure function of the evidence SET.
 *
 * The retrieval is SPECULATIVE — full pipeline, zero side effects: no
 * touchAccess (warmth must not reinforce), no logQuery (the intent
 * trajectory records real questions, not self-probes), no events, no
 * dataVersion bump. A probe that reinforced its own evidence would be a
 * feedback loop: the signal would grade the ranking AND strengthen it.
 */
async function whySelfConsistencyReward(
  retriever: MemoryRetriever,
  evidence: MemoryItem[],
  scope: MemoryScope,
): Promise<number> {
  const anchor = [...evidence].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  invariant(anchor !== undefined, 'whySelfConsistencyReward is only called with non-empty evidence');
  const probeQuery = Array.from(anchor.content).slice(0, 160).join('');
  const res = await retriever.retrieve({
    query: probeQuery,
    topK: 12,
    scope,
    speculative: true,
  });
  // 1-based final-presentation rank of every evidence item in the probe.
  const rankOf = new Map<string, number>();
  for (let i = 0; i < res.hits.length; i++) {
    const hit = res.hits[i];
    if (hit === undefined) continue;
    rankOf.set(hit.item.id, i + 1);
  }
  let sum = 0;
  for (const ev of evidence) {
    const rank = rankOf.get(ev.id);
    // DCG positional discount on the 1-based rank: 1 → 1.0, 2 → 0.63,
    // 12 → 0.27 — found-but-low is worth less than found-first. An item
    // the ranking never surfaced (rank ∞) contributes the 0.05 floor
    // rather than 0: the evidence demonstrably exists inside the caller's
    // scope, so total absence is mild negative evidence about the ranking,
    // not proof the item is irrelevant.
    sum += rank === undefined ? 0.05 : 1 / Math.log2(rank + 1);
  }
  return clamp01(sum / evidence.length);
}

/**
 * Composite score×diversity reward for a QUERY-mode capsule export's
 * feedback signal. The old signal was constant 1 (everything exported =
 * engaged); the composite grades the export as a RANKING: relevance
 * (mean finalScore of the served hits, weight 0.6) and coverage
 * (1 − mean pairwise cosine, weight 0.4 — two near-clones answer one
 * question twice, however highly they score).
 *
 * Pairwise cosines skip pairs where either side lacks an embedding or the
 * arities disagree (mixed-space store, mid-migration): a cross-space
 * cosine is garbage geometry, not evidence of (dis)similarity. When NO
 * pair is computable — a single hit, or every pair missing vectors —
 * diversity reads the neutral 0.5: it is undefined, not minimal, and a
 * one-item export must not be punished as "maximally redundant".
 */
function capsuleQueryReward(hits: RetrievalHit[]): number {
  if (hits.length === 0) return 0;
  let scoreSum = 0;
  for (const h of hits) scoreSum += h.finalScore;
  const avgScore = scoreSum / hits.length;
  let cosineSum = 0;
  let pairs = 0;
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const a = hits[i]?.item.embedding;
      const b = hits[j]?.item.embedding;
      if (!a || !b || a.length !== b.length) continue;
      cosineSum += cosine(a, b);
      pairs++;
    }
  }
  const diversity = pairs === 0 ? 0.5 : clamp01(1 - cosineSum / pairs);
  return clamp01(0.6 * avgScore + 0.4 * diversity);
}

/** Build the fifteen model-callable memory tools around the facade. */
function buildToolDefinitions(
  facade: ToolFacade,
  bus: MemoryEventBus,
  /** Best-effort warning channel for non-critical side paths (feedback
   *  learning etc.) — defaults to silent so programmatic callers of the
   *  exported builder keep their old two-argument signature. */
  warn: (message: string) => void = () => {},
): ToolDefinition[] {
  return [
    // ------------------------------------------------------------------ retrieve
    {
      name: 'memory_retrieve',
      description:
        'Hybrid long-term memory search with self-query understanding: ' +
        'temporal phrases ("last week", "最近"), quoted emphasis and "top N" ' +
        'are parsed automatically; entity mentions are linked to the knowledge ' +
        'graph and boosted. mode="synthesis" additionally clusters hits into ' +
        'corroborating groups and flags contradictions (e.g. differing version ' +
        'numbers). Every hit carries a score decomposition.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look up in memory' },
          topK: { type: 'integer', minimum: 1, maximum: 50 },
          layers: {
            type: 'array',
            items: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
          },
          mode: { type: 'string', enum: ['facts', 'synthesis'], default: 'facts' },
          minScore: { type: 'number', minimum: 0, maximum: 1 },
          asOf: {
            type: 'integer',
            description: 'FLASHBACK unix-ms: retrieve memories as they existed at this past instant (respects tombstones/supersession, not just creation)',
          },
        },
        required: ['query'],
      },
      returns: {
        type: 'object',
        properties: {
          hits: { type: 'array', items: { type: 'object' } },
          clusters: { type: 'array', items: { type: 'object' } },
          queryUnderstanding: { type: 'object' },
          totalTokens: { type: 'integer' },
          elapsedMs: { type: 'integer' },
        },
      },
      async run(input: { query: string; topK?: number; layers?: string[]; mode?: string; minScore?: number; asOf?: number }, tctx: ToolContext) {
        const hints = parseQueryHints(input.query);
        // Query entities seed the personalized PageRank (graph proximity).
        const boostEntityIds = linkQueryEntities(facade, input.query, tctx);
        const scope = scopeOf(tctx);
        const layers = validateLayers(input.layers);
        // Every EXPLORE_EVERY_N-th model retrieval serves exploration
        // weights so the bandit keeps sampling under-tried fusion arms.
        modelRetrievalCount++;
        const explore = modelRetrievalCount % EXPLORE_EVERY_N_RETRIEVALS === 0;
        // Never trust the wire: NaN falls back to the default BEFORE the
        // clamp chain (Math.min/max propagate NaN straight into the SQL
        // layer as "datatype mismatch"); then clamp every numeric knob.
        const topK = Math.min(50, Math.max(1, Math.round(
          finiteOr(input.topK, finiteOr(hints.topK, facade.config.retrieval.topK)),
        )));
        const minScore = Math.min(1, Math.max(
          0,
          finiteOr(input.minScore, facade.config.retrieval.minScore),
        ));
        // Destructure once so the narrowing survives: isFinite has no type
        // guard, the explicit undefined check below is what narrows.
        const asOfRaw = input.asOf;
        const asOf = asOfRaw !== undefined && Number.isFinite(asOfRaw) && asOfRaw > 0
          ? asOfRaw
          : undefined;
        const result: RetrievalResult = await facade.retriever.retrieve({
          query: input.query,
          topK,
          minScore,
          ...(asOf !== undefined ? { asOfMs: asOf } : {}),
          ...(layers !== undefined ? { layers } : {}),
          scope,
          ...(hints.sinceMs !== undefined ? { sinceMs: hints.sinceMs } : {}),
          ...(hints.untilMs !== undefined ? { untilMs: hints.untilMs } : {}),
          boostEntityIds,
          // QueryHints.phrases is always present (possibly empty).
          emphasisPhrases: hints.phrases,
          // Feedback-closed fusion: learned weights (railed) when enabled.
          ...(facade.learner
            ? { fusionOverrides: facade.learner.weights(scope, explore) }
            : {}),
          explain: true,
        });

        const out: Record<string, unknown> = {
          queryUnderstanding: {
            sinceMs: hints.sinceMs,
            untilMs: hints.untilMs,
            phrases: hints.phrases,
            wantsRecent: hints.wantsRecent,
            boostedEntities: boostEntityIds.length,
          },
          hits: result.hits.map(compactHit),
          totalTokens: result.totalTokens,
          elapsedMs: result.elapsedMs,
          pipeline: result.debug,
        };

        if ((input.mode ?? 'facts') === 'synthesis') {
          out.clusters = clusterByConsensus(
            result.hits.map((h) => ({
              id: h.item.id,
              content: h.item.content,
              ...(h.item.embedding !== undefined ? { embedding: h.item.embedding } : {}),
              score: h.finalScore,
              createdAt: h.item.createdAt,
            })),
          ).map((c) => ({
            representative: {
              id: c.representative.id,
              content: truncate(c.representative.content, 200),
            },
            size: c.members.length,
            agreement: Number(c.agreement.toFixed(2)),
            conflict: c.conflict,
            conflictReason: c.conflictReason,
          }));
        }
        return out;
      },
    },

    // ------------------------------------------------------------------ remember
    {
      name: 'memory_remember',
      description:
        'Persist a fact with write-time intelligence: near-duplicates are ' +
        'detected (returns the existing id instead of storing a clone), and ' +
        'conflicts with existing memories are reported (differing values, ' +
        'affirmative vs negated). supersede=true tombstones the conflicting ' +
        'outdated versions, keeping an auditable supersession chain. Every ' +
        "path reports a unified writeOutcome — 'created' | 'deduplicated' | " +
        "'superseded' | 'conflict-flagged' — plus the triggering pair's " +
        'matchedId/similarity when any existing entry matched.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact to remember' },
          tags: { type: 'array', items: { type: 'string' } },
          importance: { type: 'number', minimum: 0, maximum: 1, default: 0.9 },
          supersede: {
            type: 'boolean',
            default: false,
            description: 'Tombstone conflicting outdated memories',
          },
          dedupe: { type: 'boolean', default: true },
          visibility: {
            type: 'string',
            enum: ['session', 'workspace', 'user', 'global'],
            description: 'Who may see this memory; default = configured scope',
          },
        },
        required: ['content'],
      },
      returns: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          deduplicated: { type: 'boolean' },
          conflicts: { type: 'array', items: { type: 'object' } },
          superseded: { type: 'array', items: { type: 'string' } },
          writeOutcome: {
            type: 'string',
            enum: ['created', 'deduplicated', 'superseded', 'conflict-flagged'],
            description:
              "created = new row written; deduplicated = synonymous merge " +
              'returning the existing id; superseded = conflicts replaced via ' +
              'the supersession chain (old row tombstoned, new one effective); ' +
              'conflict-flagged = conflicts marked WITHOUT replacement',
          },
          matchedId: {
            type: 'string',
            description: 'Existing entry id that triggered the dedupe/conflict',
          },
          similarTo: {
            type: 'string',
            description:
              'Truncated content (200 chars) of the existing entry the new ' +
              'fact was deemed a duplicate of, when writeOutcome=deduplicated',
          },
          similarity: {
            type: 'number',
            description: 'Raw cosine of the triggering pair (4 decimals)',
          },
          conflictReason: {
            type: 'string',
            description: "detectConflict's reason, when a conflict matched",
          },
          advisory: {
            type: 'string',
            description:
              'Present only for non-created outcomes under the offline ' +
              'embedding gateway: sparse vectors inflate similarity for ' +
              'template-like content',
          },
        },
      },
      async run(input: { content: string; tags?: string[]; importance?: number; supersede?: boolean; dedupe?: boolean; visibility?: 'session' | 'workspace' | 'user' | 'global' }, tctx: ToolContext) {
        const scope = scopeOf(tctx);
        const incoming = { id: '', content: input.content, score: 1 };

        // Write-time scan floors from config (retrieval.
        // writeDedupeThreshold / conflictScanThreshold): NaN/±Infinity
        // fall back to the default and out-of-band values are clamped
        // (dedupe into [0.5, 1], conflict scan into [0, 1]) — see
        // clampThreshold. Both are computed per call so a config swap
        // between calls takes effect without reinstall.
        const dedupeSim = clampThreshold(
          facade.config.retrieval.writeDedupeThreshold,
          WRITE_DEDUPE_THRESHOLD_DFLT,
          0.5,
          1,
        );
        const conflictScanSim = clampThreshold(
          facade.config.retrieval.conflictScanThreshold,
          CONFLICT_SCAN_THRESHOLD_DFLT,
          0,
          1,
        );

        /**
         * D-11 runtime feedback: one advisory sentence for NON-created
         * outcomes when the embedding gateway's primary space is the
         * offline one. Defensive optional chain — spaces() is a
         * host-implementable method and an empty array (no space serving
         * yet) must never crash the write path.
         */
        const advisoryFor = (outcome: WriteOutcome): { advisory?: string } => {
          if (outcome === 'created') return {};
          const primary = facade.embedder.spaces()[0];
          return typeof primary === 'string' && primary.startsWith('offline-bm25')
            ? { advisory: OFFLINE_SIMILARITY_ADVISORY }
            : {};
        };

        // Near-duplicate scan. High similarity alone does NOT mean
        // "same fact": an update ("v16" → "v17") is also ~0.95 similar.
        // Dedupe only when similar AND non-contradictory; otherwise fall
        // through to the conflict/update path.
        if (input.dedupe !== false) {
          const dup = await facade.retriever.retrieve({
            query: input.content,
            topK: 3,
            minScore: dedupeSim,
            scope,
          });
          const best = dup.hits.reduce<null | (typeof dup.hits)[number]>(
            (acc, h) => (!acc || h.rawScore > acc.rawScore ? h : acc),
            null,
          );
          if (best && best.rawScore >= dedupeSim) {
            const det = detectConflict(incoming, {
              id: best.item.id,
              content: best.item.content,
              score: best.finalScore,
            });
            if (!det.conflict) {
              return {
                id: best.item.id,
                deduplicated: true,
                similarTo: truncate(best.item.content, 200),
                similarity: Number(best.rawScore.toFixed(4)),
                writeOutcome: 'deduplicated',
                matchedId: best.item.id,
                ...advisoryFor('deduplicated'),
              };
            }
          }
        }

        // Conflict scan against existing memories.
        const related = await facade.retriever.retrieve({
          query: input.content,
          topK: 5,
          minScore: conflictScanSim,
          scope,
        });
        const conflicts: Array<{ id: string; content: string; reason: string }> = [];
        for (const h of related.hits) {
          const det = detectConflict(incoming, { id: h.item.id, content: h.item.content, score: h.finalScore });
          if (det.conflict) {
            conflicts.push({ id: h.item.id, content: truncate(h.item.content, 160), reason: det.reason ?? 'contradiction' });
          }
        }

        const id = await facade.ingestor.ingestUserMemory({
          content: input.content,
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.importance !== undefined ? { importance: input.importance } : {}),
          ...(tctx.userId !== undefined ? { userId: tctx.userId } : {}),
          ...(tctx.workspaceId !== undefined ? { workspaceId: tctx.workspaceId } : {}),
          sessionId: tctx.sessionId,
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        });

        let superseded: string[] | undefined;
        if (conflicts.length > 0 && input.supersede) {
          superseded = [];
          for (const c of conflicts) {
            if (facade.store.tombstoneItem(c.id, id)) superseded.push(c.id);
          }
        }

        bus.emit('memory.remembered', { id, conflicts: conflicts.length, superseded: superseded?.length ?? 0 });
        if (conflicts.length === 0) {
          return { id, deduplicated: false, writeOutcome: 'created' };
        }
        // The triggering pair: the strongest conflicting hit by RAW cosine
        // (result order follows finalScore, which mixes decay/priors in —
        // matchedId/similarity describe the raw trigger, not the rank).
        const conflictIds = new Set(conflicts.map((c) => c.id));
        const matched = related.hits
          .filter((h) => conflictIds.has(h.item.id))
          .reduce<null | (typeof related.hits)[number]>(
            (acc, h) => (!acc || h.rawScore > acc.rawScore ? h : acc),
            null,
          );
        const outcome: WriteOutcome = input.supersede ? 'superseded' : 'conflict-flagged';
        return {
          id,
          deduplicated: false,
          conflicts,
          superseded,
          writeOutcome: outcome,
          matchedId: matched?.item.id,
          similarity: matched ? Number(matched.rawScore.toFixed(4)) : undefined,
          conflictReason: matched
            ? conflicts.find((c) => c.id === matched.item.id)?.reason
            : undefined,
          ...advisoryFor(outcome),
        };
      },
    },

    // ------------------------------------------------------------------ forget
    {
      name: 'memory_forget',
      description:
        'Right-to-be-forgotten with safety rails. Modes: by id, by entity ' +
        '(cascades to linked items + graph edges), or by semantic query ' +
        '(retrieves then tombstones). dryRun=true previews without deleting. ' +
        'Deletes are soft (undo via restore:true) until purge:true hard-deletes ' +
        'tombstones. Scoped: only memories visible to this session.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory item id to forget/restore' },
          entity: { type: 'string', description: 'Entity name: forget its items + graph presence' },
          query: { type: 'string', description: 'Semantic query: forget matching memories' },
          minScore: { type: 'number', minimum: 0, maximum: 1, default: 0.5, description: 'Similarity floor for query mode' },
          dryRun: { type: 'boolean', default: false },
          restore: { type: 'boolean', default: false },
          purge: { type: 'boolean', default: false, description: 'Hard-delete tombstoned items' },
        },
      },
      returns: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          forgotten: { type: 'integer' },
          dryRun: { type: 'boolean' },
          items: { type: 'array', items: { type: 'object' } },
          purged: { type: 'integer' },
        },
      },
      async run(input: {
        id?: string; entity?: string; query?: string; minScore?: number;
        dryRun?: boolean; restore?: boolean; purge?: boolean;
      }, tctx: ToolContext) {
        if (input.purge) {
          // dryRun must gate the ONLY irreversible branch too: purge is
          // hard-delete, so a dry-run preview reports what WOULD go and
          // touches nothing (every other mode already honored dryRun).
          if (input.dryRun) {
            return {
              mode: 'purge',
              dryRun: true,
              wouldPurge: facade.store.countTombstoned(),
            };
          }
          // Scoped purge: without levels this would hard-delete every
          // tenant's tombstones instead of just the caller's.
          const purged = facade.store.purgeDeleted(
            0,
            scopeLevels(facade.config.scope.kind, scopeOf(tctx)),
          );
          bus.emit('memory.forgotten', { mode: 'purge', count: purged });
          return { mode: 'purge', purged };
        }
        if (input.restore && input.id) {
          // restoreItem targets a tombstoned row, which getItemInScope's
          // LIVE filter cannot see — fetch the row raw and enforce the
          // same visibility ACL in JS before un-deleting it.
          const levels = scopeLevels(facade.config.scope.kind, scopeOf(tctx));
          const tombstoned = facade.store.getItem(input.id);
          if (!tombstoned || !visibleToCaller(tombstoned, levels)) {
            return { mode: 'restore', restored: 0, id: input.id, note: 'id not found in your scope' };
          }
          const restored = facade.store.restoreItem(input.id);
          return { mode: 'restore', restored, id: input.id };
        }
        if (input.entity) {
          const levels = scopeLevels(facade.config.scope.kind, scopeOf(tctx));
          const ent = facade.store.findEntityInScope(input.entity, levels);
          if (!ent) return { mode: 'entity', forgotten: 0, note: `entity "${input.entity}" not found in your scope` };
          // Level-scoped preview: itemsForEntity (unscoped) would leak
          // OTHER tenants' item previews through this dry-run response.
          if (input.dryRun) {
            const items = facade.store.itemsForEntityScoped(
              widestLevel(levels),
              ent.id,
              50,
            );
            return {
              mode: 'entity',
              dryRun: true,
              entity: { name: ent.name, mentionCount: ent.mentionCount },
              items: items.map((i) => ({ id: i.id, content: truncate(i.content, 120) })),
            };
          }
          // Scoped cascade: deleteEntityCascade removed rows at ANY tier
          // (including other tenants' items linked to a shared entity).
          // The scoped contract returns entityDeleted=false when the
          // entity row itself is shared outside this level and is kept.
          const casc = facade.store.deleteEntityCascadeScoped(
            widestLevel(levels),
            ent.id,
          );
          bus.emit('memory.forgotten', {
            mode: 'entity',
            count: casc.itemsTombstoned,
            entity: ent.name,
          });
          return {
            mode: 'entity',
            forgotten: casc.itemsTombstoned,
            edgesRemoved: casc.edgesDeleted,
            entityDeleted: casc.entityDeleted,
            entity: ent.name,
            ...(casc.entityDeleted
              ? {}
              : {
                  note:
                    'entity row retained: it is shared with scopes outside yours ' +
                    '(other owners still reference it); your linked items and edges were removed',
                }),
          };
        }
        if (input.query) {
          const res = await facade.retriever.retrieve({
            query: input.query,
            topK: 20,
            minScore: finiteOr(input.minScore, 0.5),
            scope: scopeOf(tctx),
          });
          const targets = res.hits.map((h) => ({ id: h.item.id, content: truncate(h.item.content, 120) }));
          if (input.dryRun) {
            return { mode: 'query', dryRun: true, items: targets };
          }
          let forgotten = 0;
          for (const t of targets) {
            if (facade.store.tombstoneItem(t.id)) forgotten++;
          }
          bus.emit('memory.forgotten', { mode: 'query', count: forgotten, query: input.query });
          if (forgotten > 0 && facade.learner) {
            // Negative engagement signal (reward 0): this query surfaced
            // exactly the content the user wanted GONE — nudge the fusion
            // arms that ranked it up back down. Best-effort only.
            try {
              facade.learner.learn({
                engagedItemIds: [],
                totalHits: targets.length,
                query: input.query,
                scope: scopeOf(tctx),
              });
            } catch (err) {
              warn(`[${PLUGIN_NAME}] forget feedback learn failed: ${String(err)}`);
            }
          }
          return { mode: 'query', forgotten, items: targets };
        }
        if (input.id) {
          // ACL: getItem would fetch any tenant's row; getItemInScope
          // only returns LIVE rows visible to this caller.
          const levels = scopeLevels(facade.config.scope.kind, scopeOf(tctx));
          const item = facade.store.getItemInScope(input.id, levels);
          if (!item) return { mode: 'id', forgotten: 0, note: 'id not found in your scope' };
          const preview = [{ id: item.id, content: truncate(item.content, 120) }];
          if (input.dryRun) return { mode: 'id', dryRun: true, items: preview };
          const ok = facade.store.tombstoneItem(input.id);
          if (ok) bus.emit('memory.forgotten', { mode: 'id', count: 1 });
          return { mode: 'id', forgotten: ok ? 1 : 0, items: preview };
        }
        return { error: 'provide one of: id, entity, query, or purge' };
      },
    },

    // ------------------------------------------------------------------ inspect
    {
      name: 'memory_inspect',
      description:
        'Memory observability: per-layer/space counts, graph shape, recent ' +
        'items — every count is SCOPED to this caller\'s visibility cascade ' +
        '(never a cross-tenant whole-store pool) — plus a health panel ' +
        '(signal ratio, duplication ratio, age distribution, PageRank ' +
        'concentration/Gini, orphan entities) and concrete maintenance ' +
        'recommendations. Includes a store integrity self-check (orphan ' +
        'buckets, dangling refs, overdue tombstones).',
      parameters: { type: 'object', properties: {} },
      returns: { type: 'object' },
      run(_input: unknown, tctx: ToolContext) {
        const { store, graph, config } = facade;
        // SCOPED census (D-01): every count below reflects only what THIS
        // caller may see. The old unscoped read pooled every tenant's
        // numbers into one response — a cross-tenant observability leak.
        const level = toolLevel(facade, tctx);
        const scoped = scopedStatsOf(facade, scopeOf(tctx), level);

        // Scoped sample: the graph stats above are scoped, so the health
        // metrics must sample the same visibility window, not every
        // tenant's semantic items pooled together.
        const live = store.listItemsByLayerScoped('semantic', level, 200);
        const embeddings = live
          .map((i) => i.embedding)
          .filter((e): e is Float32Array => Boolean(e));
        const ages = live.map((i) => (Date.now() - i.createdAt) / DAY_MS);
        const entities = store.listEntitiesScoped(level, config.graph.maxEntities);
        const ranks = graph.getRanks(level);

        const health = {
          sampledItems: live.length,
          sampleScope: 'scoped' as const,
          signalRatio: Number(
            ratioAtLeast(live.map((i) => i.importance), config.compression.importanceThreshold).toFixed(3),
          ),
          duplicationRatio: Number(duplicationRatio(embeddings).toFixed(3)),
          medianAgeDays: Number(median(ages).toFixed(1)),
          staleRatio: Number(
            ratioAtLeast(ages, 2 * config.compression.decayHalfLifeDays).toFixed(3),
          ),
          orphanEntityRatio:
            entities.length > 0
              ? Number((entities.filter((e) => e.mentionCount <= 1).length / entities.length).toFixed(3))
              : 0,
          rankGini: Number(gini([...ranks.values()]).toFixed(3)),
          tombstoned: scoped.tombstones,
          // >1 space among THIS caller's visible items = fragmentation
          // they can observe; memory_migrate heals it store-wide.
          spaceCount: Object.keys(scoped.spaces).length,
          ...(facade.learner
            ? {
                fusionDrift: facade.learner.snapshot(scopeOf(tctx)).arms.map(
                  (a) => `${a.arm}:${a.drift > 0 ? '+' : ''}${a.drift}%`,
                ),
              }
            : {}),
        };

        const recommendations: string[] = [];
        if (health.duplicationRatio > 0.15) {
          recommendations.push(
            `Duplication at ${(health.duplicationRatio * 100).toFixed(0)}%: run compression (distillation merges near-clones).`,
          );
        }
        if (health.staleRatio > 0.5) {
          recommendations.push(
            `${(health.staleRatio * 100).toFixed(0)}% of sampled memories are older than two half-lives: consider evict or a shorter decayHalfLifeDays.`,
          );
        }
        if (health.rankGini > 0.8 && entities.length > 10) {
          recommendations.push(
            `PageRank concentration Gini ${health.rankGini}: knowledge is collapsing onto few entities; diversify ingested topics.`,
          );
        }
        if (health.tombstoned > 50) {
          recommendations.push(
            `${health.tombstoned} tombstoned items on disk: call memory_forget with purge:true to reclaim space.`,
          );
        }
        if (health.orphanEntityRatio > 0.5 && entities.length > 50) {
          recommendations.push(
            `${(health.orphanEntityRatio * 100).toFixed(0)}% of entities have a single mention: graph noise; consider raising extraction specificity.`,
          );
        }
        if (health.signalRatio < 0.3 && live.length >= 20) {
          recommendations.push(
            `Only ${(health.signalRatio * 100).toFixed(0)}% of memories clear the importance threshold: ingest more curated high-value facts.`,
          );
        }

        // Store integrity self-check (orphan buckets, dangling refs,
        // overdue tombstones) — pure observation: a throwing check must
        // degrade to an ok:false snapshot, never take the tool down.
        let integrity: IntegritySnapshot;
        try {
          // integrityCheck() lands on MemoryStore in a parallel change;
          // reading it structurally (not as a typed member) keeps this
          // file compiling against either revision of the store.
          const report = (store as { integrityCheck?: () => unknown }).integrityCheck?.();
          integrity = toIntegritySnapshot(report);
        } catch (err) {
          integrity = { ok: false, error: String(err), details: [] };
        }

        // Response shape: the historical stats keys are kept (items /
        // events / entities / edges / patterns / tombstoned / spaces /
        // sizeBytes) so downstream consumers and smoke invariants keep
        // reading one census — but every COUNT is now the scoped one.
        // sizeBytes is physical storage telemetry (the file is the file;
        // no per-tenant split of pages exists), reached through its own
        // named surface rather than the whole-store census.
        return {
          stats: {
            items: scoped.items,
            events: scoped.events,
            entities: scoped.entities,
            edges: scoped.edges,
            patterns: scoped.patterns,
            tombstoned: scoped.tombstones,
            spaces: scoped.spaces,
            sizeBytes: store.dbSizeBytes(),
          },
          graph: graph.stats(level),
          recent: store.listRecentItemsScoped(level, 10),
          health,
          recommendations,
          integrity,
        };
      },
    },

    // ------------------------------------------------------------------ graph
    {
      name: 'memory_graph',
      description:
        'Knowledge-graph analytics. expand: neighborhood of an entity ' +
        '(with PageRank). path: shortest co-occurrence chain between two ' +
        'entities, answering "how are X and Y related?". communities: ' +
        'label-propagation topic clustering of the whole entity graph.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['expand', 'path', 'communities'], default: 'expand' },
          entity: { type: 'string', description: 'Entity name (expand/path start)' },
          target: { type: 'string', description: 'Path mode: the other endpoint' },
          hops: { type: 'integer', minimum: 1, maximum: 3, default: 3 },
          maxNodes: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 8, description: 'Max communities returned' },
        },
      },
      returns: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          subgraph: { type: 'string' },
          path: { type: 'array', items: { type: 'string' } },
          communities: { type: 'array', items: { type: 'object' } },
        },
      },
      run(input: {
        mode?: string; entity?: string; target?: string;
        hops?: number; maxNodes?: number; limit?: number;
      }, tctx: ToolContext) {
        const { store, graph } = facade;
        const mode = input.mode ?? 'expand';
        const level = toolLevel(facade, tctx);
        const levels = scopeLevels(facade.config.scope.kind, scopeOf(tctx));

        if (mode === 'path') {
          if (!input.entity || !input.target) {
            return { mode, error: 'path mode requires entity and target' };
          }
          const from = store.findEntityInScope(input.entity, levels);
          const to = store.findEntityInScope(input.target, levels);
          if (!from) return { mode, error: `entity "${input.entity}" not found in your scope` };
          if (!to) return { mode, error: `entity "${input.target}" not found in your scope` };
          const adjacency = buildAdjacency(store.listEdgesScoped(level));
          // Hop budget defaults to the schema default (3) — it previously
          // fell back to 1, silently halving every path search when the
          // caller omitted the field. NaN guards on all numeric knobs.
          const hops = finiteOr(input.hops, 3);
          const path = shortestPath(adjacency, from.id, to.id, hops * 2);
          if (!path) {
            return {
              mode,
              path: [],
              note: `no co-occurrence path between "${input.entity}" and "${input.target}" within ${hops * 2} hops`,
            };
          }
          // By-id display lookup: path node ids came from shortestPath over
          // this caller's scoped adjacency, so the ACL was applied upstream;
          // every scoped store read is by NAME, leaving no non-deprecated
          // by-id equivalent to migrate to.
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- id-keyed name resolution over a scope-derived path
          const names = path.map((id) => store.getEntity(id)?.name ?? id);
          return { mode, path: names, hops: path.length - 1 };
        }

        if (mode === 'communities') {
          const entities = store.listEntitiesScoped(level, facade.config.graph.maxEntities);
          if (entities.length === 0) return { mode, communities: [], note: 'graph is empty in your scope' };
          const report = labelPropagation(
            entities.map((e) => e.id),
            store.listEdgesScoped(level).map((e) => ({ a: e.from, b: e.to, weight: e.weight })),
          );
          const rank = graph.getNormalizedRanks(level);
          const nameOf = new Map(entities.map((e) => [e.id, e.name]));
          const communities = report.communities
            .slice(0, finiteOr(input.limit, 8))
            .map((c) => ({
              id: c.label,
              size: c.size,
              top: c.members
                .slice()
                .sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0))
                .slice(0, 8)
                .map((id) => nameOf.get(id) ?? id),
            }));
          return {
            mode,
            communities,
            totalCommunities: report.communities.length,
            cohesion: Number(report.cohesion.toFixed(3)),
          };
        }

        // expand (default)
        if (!input.entity) return { mode, error: 'expand mode requires entity' };
        const root = store.findEntityInScope(input.entity, levels);
        if (!root) return { mode, subgraph: '', note: `entity "${input.entity}" not found in your scope` };
        // ?? 3 to match the JSON-Schema default (the old ?? 1 quietly
        // returned half-empty neighborhoods for callers relying on it).
        const subgraph = graph.describeSubgraph(
          root.name,
          finiteOr(input.hops, 3),
          finiteOr(input.maxNodes, 30),
          level,
        );
        return {
          mode,
          subgraph,
          rootRank: Number((graph.getNormalizedRanks(level).get(root.id) ?? 0).toFixed(3)),
        };
      },
    },

    // -------------------------------------------------------------- capsules
    {
      name: 'memory_capsule_export',
      description:
        'Export a signed Memory Capsule — a portable bundle of this palace\'s ' +
        'knowledge to hand to another agent/palace (onboarding, handover). ' +
        'Content-addressed ids, HMAC tamper evidence, owner identity stripped; ' +
        'only memories visible to this session are exportable.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Export memories matching this semantic query' },
          entity: { type: 'string', description: 'Export memories linked to this entity' },
          all: { type: 'boolean', description: 'Export every visible semantic memory (capped)' },
          topK: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          secret: { type: 'string', description: 'Optional shared secret to HMAC-sign the capsule' },
        },
      },
      returns: {
        type: 'object',
        properties: {
          capsuleJson: { type: 'string' },
          items: { type: 'integer' },
          patterns: { type: 'integer' },
          signed: { type: 'boolean' },
        },
      },
      async run(input: { query?: string; entity?: string; all?: boolean; topK?: number; secret?: string }, tctx: ToolContext) {
        const { capsule, json } = await facade.federation.exportCapsule({
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.entity !== undefined ? { entity: input.entity } : {}),
          ...(input.all !== undefined ? { all: input.all } : {}),
          ...(input.topK !== undefined ? { topK: input.topK } : {}),
          ...(input.secret !== undefined ? { secret: input.secret } : {}),
          palaceId: facade.palaceId,
          scope: scopeOf(tctx),
        });
        if (facade.learner && capsule.items.length > 0) {
          // Exported knowledge = engaged knowledge. Best-effort.
          try {
            // QUERY mode only: the export ran a real ranking to select its
            // items, so the reward grades that ranking (relevance ×
            // diversity — see capsuleQueryReward). ENTITY/ALL modes are
            // bulk curation (graph adjacency / layer sweeps), not ranking
            // judgments — grading them would feed the bandit noise about
            // an ordering they never performed — so they keep the legacy
            // constant-1 ratio semantics (no reward handed over).
            let reward: number | undefined;
            if (input.query) {
              // Degradation chain: a failed probe drops `reward` and
              // learn() falls back to the engaged/totalHits ratio (= 1.0
              // here: every exported item was worth handing over).
              try {
                // Mirror exportCapsule's retrieval EXACTLY (same query,
                // the same NaN-guarded topK, the same scope object;
                // speculative is not part of the cache params key), so a
                // warm query cache serves this probe the very entry the
                // export's own retrieval just stored — identical hits and
                // finalScores with zero re-ranking and zero side effects.
                const probeTopK =
                  input.topK !== undefined && Number.isFinite(input.topK)
                    ? input.topK
                    : undefined;
                const probe = await facade.retriever.retrieve({
                  query: input.query,
                  ...(probeTopK !== undefined ? { topK: probeTopK } : {}),
                  scope: scopeOf(tctx),
                  speculative: true,
                });
                reward = capsuleQueryReward(probe.hits);
              } catch {
                reward = undefined;
              }
            }
            facade.learner.learn({
              engagedItemIds: capsule.items.map((i) => i.id),
              totalHits: capsule.items.length,
              query: input.query ?? '',
              scope: scopeOf(tctx),
              ...(reward !== undefined ? { reward } : {}),
            });
          } catch (err) {
            warn(`[${PLUGIN_NAME}] capsule export feedback learn failed: ${String(err)}`);
          }
        }
        return {
          capsuleJson: json,
          items: capsule.items.length,
          patterns: capsule.patterns.length,
          signed: Boolean(capsule.signature),
        };
      },
    },
    {
      name: 'memory_capsule_import',
      description:
        'Import a Memory Capsule from another palace. Verifies the HMAC ' +
        'signature when present, deduplicates by deterministic content ids, ' +
        'flags contradictions against existing memories, and rebinds every ' +
        'item to THIS identity at the chosen visibility tier (capsules carry ' +
        'no ownership). Use force:true to also import conflict-flagged items.',
      parameters: {
        type: 'object',
        properties: {
          capsule: { type: 'string', description: 'The capsule JSON (from memory_capsule_export)' },
          secret: { type: 'string', description: 'Shared secret to verify a signed capsule' },
          visibility: {
            type: 'string',
            enum: ['global', 'user', 'workspace', 'session'],
            default: 'global',
          },
          force: { type: 'boolean', default: false },
        },
        required: ['capsule'],
      },
      returns: { type: 'object' },
      async run(input: { capsule: string; secret?: string; visibility?: 'global' | 'user' | 'workspace' | 'session'; force?: boolean }, tctx: ToolContext) {
        return facade.federation.importCapsule({
          capsuleJson: input.capsule,
          ...(input.secret !== undefined ? { secret: input.secret } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
          scope: scopeOf(tctx),
        });
      },
    },

    // -------------------------------------------------------------- reflect
    {
      name: 'memory_reflect',
      description:
        'Self-tuning: the palace grades its own recall on a self-consistency ' +
        'benchmark (each memory\'s first sentence must retrieve that memory), ' +
        'sweeps a deterministic parameter grid through the REAL retrieval ' +
        'pipeline, and reports MRR / recall@5 plus a recommended config. ' +
        'Read-only — applying the recommendation is the host\'s decision.',
      parameters: {
        type: 'object',
        properties: {
          maxEntries: { type: 'integer', minimum: 5, maximum: 50, default: 25 },
        },
      },
      returns: { type: 'object' },
      async run(input: { maxEntries?: number }, tctx: ToolContext) {
        const level = toolLevel(facade, tctx);
        const sample = facade.store.listItemsByLayerScoped('semantic', level, 200);
        const report = await facade.reflector.reflect(sample, scopeOf(tctx), {
          ...(input.maxEntries !== undefined ? { maxEntries: input.maxEntries } : {}),
        });
        return {
          ...report,
          note: 'Update dsh.yaml retrieval.graphBoost / retrieval.prf.{alpha,beta} to apply',
        };
      },
    },

    // ----------------------------------------------------------------- core
    {
      name: 'memory_core',
      description:
        'Read / edit the palace\'s persistent SELF — three hard-capped core ' +
        'blocks (profile, project, goals) that are ALWAYS injected at session ' +
        'start. Unlike archival memory these are rewritten, not appended: ' +
        'keep them dense and current. Every edit is versioned (audit ' +
        'history via action:"history"). Compaction dedupes and evicts the ' +
        'least valuable lines when a block exceeds its token cap.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'set', 'append', 'history', 'compact'],
            default: 'read',
          },
          block: { type: 'string', enum: ['profile', 'project', 'goals'] },
          /** set: full replacement content (≤ 4000 chars). */
          content: { type: 'string' },
          /** append: new line(s) to merge in (each ≤ 500 chars, ≤ 10 lines). */
          lines: { type: 'array', items: { type: 'string' }, maxItems: 10 },
          tokenCap: { type: 'integer', minimum: 64, maximum: 512 },
        },
        required: ['action'],
      },
      returns: { type: 'object' },
      run(input: {
        action?: string; block?: string; content?: string;
        lines?: string[]; tokenCap?: number;
      }, tctx: ToolContext) {
        const scope = scopeOf(tctx);
        const action = input.action ?? 'read';
        const validBlocks = new Set<string>(CORE_BLOCK_NAMES);
        const blockName = validBlocks.has(input.block ?? '') ? (input.block as CoreBlockName) : null;

        if (action === 'read') {
          const blocks = facade.core.read(scope);
          return {
            blocks: blocks.map((b) => ({
              name: b.name,
              version: b.version,
              tokenCap: b.tokenCap,
              content: b.content,
            })),
            note: 'These blocks are always injected at session start — keep them dense',
          };
        }
        if (!blockName) {
          return { error: 'set/append/history/compact require block ∈ {profile, project, goals}' };
        }

        if (action === 'set') {
          const content = (input.content ?? '').slice(0, 4000);
          const r = facade.core.set(blockName, content, scope, input.tokenCap);
          return { block: r.block.name, version: r.block.version, compaction: r.compaction };
        }
        if (action === 'append') {
          const lines = (input.lines ?? [])
            .slice(0, 10)
            .map((l) => l.slice(0, 500));
          if (lines.length === 0) return { error: 'append requires lines[]' };
          const r = facade.core.append(blockName, lines, scope, input.tokenCap);
          return { block: r.block.name, version: r.block.version, compaction: r.compaction };
        }
        if (action === 'history') {
          const h = facade.core.history(blockName, scope, 10);
          return { block: blockName, versions: h.length, history: h };
        }
        if (action === 'compact') {
          const results = facade.core.compactAll(scope);
          return {
            blocks: results.map((b) => ({
              name: b.name,
              version: b.version,
              changed: b.changed,
              removed: b.compaction.removed,
            })),
          };
        }
        return { error: `unknown action: ${action}` };
      },
    },

    // -------------------------------------------------------------- fed-search
    {
      name: 'memory_fed_search',
      description:
        'Search ACROSS federated palaces (personal + team + project) in one ' +
        'call. Fans out in parallel with per-palace circuit breakers; every ' +
        'hit is tagged with its source palace. Each member applies its own ' +
        'scope/ACL — the federation merges only what each palace chose to ' +
        'return. Currently registered members appear in the response.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topK: { type: 'integer', minimum: 1, maximum: 32, default: 8 },
        },
        required: ['query'],
      },
      returns: { type: 'object' },
      async run(input: { query: string; topK?: number }, tctx: ToolContext) {
        const topK = Math.min(32, Math.max(1, Math.round(finiteOr(input.topK, 8))));
        const res = await facade.federationRouter.retrieve({
          query: input.query,
          topK,
          scope: scopeOf(tctx),
          explain: true,
        });
        return {
          ...res,
          members: facade.federationRouter.memberNames(),
        };
      },
    },

    // ------------------------------------------------------------------ era
    {
      name: 'memory_era',
      description:
        'Long-horizon comprehension: query the stratification tree ' +
        '(week / month / era digest nodes built during sleep). Answers ' +
        '"what was this period about" from one bounded digest instead of ' +
        'scanning a quarter of raw memories.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['week', 'month', 'era'], default: 'era' },
          sinceMs: { type: 'integer', description: 'Period window start (unix ms)' },
          untilMs: { type: 'integer', description: 'Period window end (unix ms)' },
        },
      },
      returns: { type: 'object' },
      run(input: { level?: string; sinceMs?: number; untilMs?: number }, tctx: ToolContext) {
        // Era digests are per-USER artifacts (tree nodes key on userId):
        // an anonymous caller would read the anonymous bucket's timeline
        // summaries — every user's period digests pooled under the null
        // owner. Refuse instead of leaking the shared bucket.
        if (!tctx.userId) {
          return { error: 'memory_era requires a user scope' };
        }
        // Runtime whitelist — the JSON-Schema enum is advisory, the wire
        // is never trusted.
        const level = input.level ?? 'era';
        if (!VALID_ERA_LEVELS.has(level)) {
          return { error: `level must be one of week|month|era, got "${level}"` };
        }
        // Window bounds: pass ONLY finite numbers through — NaN here
        // surfaces as a SQL datatype mismatch inside listTreeNodes.
        const sinceMs = input.sinceMs !== undefined && Number.isFinite(input.sinceMs)
          ? input.sinceMs
          : undefined;
        const untilMs = input.untilMs !== undefined && Number.isFinite(input.untilMs)
          ? input.untilMs
          : undefined;
        const nodes = facade.store.listTreeNodes(
          level as 'week' | 'month' | 'era',
          tctx.userId,
          sinceMs,
          untilMs,
        );
        return {
          level,
          nodes: nodes.map((n) => ({
            periodStart: n.periodStart,
            periodEnd: n.periodEnd,
            digest: n.content,
            tokenCount: n.tokenCount,
            children: n.childIds.length,
            version: n.version,
          })),
          note: nodes.length === 0 ? 'no tree nodes yet — run memory_sleep' : undefined,
        };
      },
    },

    // ---------------------------------------------------------------- bandit
    {
      name: 'memory_bandit',
      description:
        'Inspect / control the online fusion learner. The palace learns ' +
        'retrieval fusion weights from engagement feedback (items you ' +
        'interacted with after a retrieve), always clamped inside safety ' +
        'rails. Read the arm snapshot + recent rewards, or reset.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'reset'],
            default: 'read',
          },
          arm: { type: 'string', description: 'For reset: one arm (optional; omit = all)' },
        },
      },
      returns: { type: 'object' },
      run(input: { action?: string; arm?: string }, tctx: ToolContext) {
        if (!facade.learner) {
          return { enabled: false, note: 'retrieval.fusionLearning.enabled = false' };
        }
        const scope = scopeOf(tctx);
        if (input.action === 'reset') {
          // Arm whitelist: an unknown arm name used to slice undefined
          // state deep in the bandit and surface as a TypeError; reject
          // it here with the legal set spelled out.
          if (input.arm !== undefined && !(ARMS as readonly string[]).includes(input.arm)) {
            return {
              error: `unknown arm "${input.arm}" — valid arms: ${ARMS.join(', ')}`,
            };
          }
          facade.learner.reset(scope, input.arm ? (input.arm as Arm) : undefined);
          return { reset: true, arms: facade.learner.snapshot(scope).arms };
        }
        return facade.learner.snapshot(scope);
      },
    },

    // --------------------------------------------------------------- migrate
    {
      name: 'memory_migrate',
      description:
        'Heal embedding-space fragmentation: after a provider switch or ' +
        'model upgrade, memories embedded in the OLD space are invisible to ' +
        'retrieval. This re-embeds stranded items into the CURRENT primary ' +
        'space — a physical re-index (content, timestamps, visibility and ' +
        'flashback integrity untouched; audit trail in metadata.migratedFrom). ' +
        'Budget-bounded per call; refuses to run while the embedder is ' +
        'degraded. dryRun reports the fragmentation without embedding; a ' +
        'live run requires confirm:true. When scope.adminUserIds is ' +
        'configured, live runs additionally require the caller userId to ' +
        'be on that admin whitelist (dryRun stays open to everyone).',
      parameters: {
        type: 'object',
        properties: {
          budget: { type: 'integer', minimum: 1, maximum: 512, default: 100, description: 'Max items to re-embed this call' },
          dryRun: { type: 'boolean', default: false },
          confirm: {
            type: 'boolean',
            description:
              'required for a live whole-store re-embed (physical side effect); omit for dryRun',
          },
        },
      },
      returns: { type: 'object' },
      async run(
        input: { budget?: number; dryRun?: boolean; confirm?: boolean },
        tctx: ToolContext,
      ) {
        // ADMIN WHITELIST GATE — live calls only (dryRun is a pure read:
        // stats + degraded probe, zero side effects, so it stays open to
        // everyone for pre-flight assessment). This REPLACES the
        // pre-0.20 widest-tier scope gate, which was removed because it
        // was tautological: scopeLevels' cumulative cascade ALWAYS ends
        // at the global tier — for identified callers and for anonymous
        // ones alike (the anonymous fallback level is global-only) — so
        // `!widestLevel(...).tiers.includes('global')` could never fire
        // and gated nothing. A whole-store physical side effect needs a
        // gate that can actually deny: when an admin whitelist is
        // configured, a live caller's userId must be on it. An undefined
        // userId is REJECTED under a configured whitelist (fail-closed —
        // anonymous callers can never satisfy membership). Unconfigured
        // keeps the historical single-user trust model; the confirm gate
        // below applies independently in both modes.
        const admins = facade.config.scope.adminUserIds;
        const callerId = tctx.userId;
        if (
          !input.dryRun &&
          admins !== undefined &&
          (callerId === undefined || !admins.includes(callerId))
        ) {
          return {
            error:
              'memory_migrate is restricted to configured admins (scope.adminUserIds)',
          };
        }
        // Confirmation gate: a live run rewrites every stranded vector in
        // the store (a physical side effect), so the caller must say
        // confirm:true — the cheap dryRun report stays ungated.
        if (!input.dryRun && input.confirm !== true) {
          return {
            error:
              'memory_migrate requires confirm:true for a live whole-store re-embed (run dryRun first)',
          };
        }
        // Whole-store maintenance census via the NAMED surface (not the
        // generic stats census — audit check 11): space migration is a
        // physical whole-store operation (migrator.tick re-embeds across
        // owners), so the dry-run preview must describe the exact
        // population the live run will touch.
        const spaces = facade.store.spaceOccupancy();
        const target = facade.migrator.targetSpace();
        const stranded = Object.entries(spaces)
          .filter(([s]) => s !== target)
          .reduce((n, [, c]) => n + c, 0);
        if (input.dryRun) {
          return {
            targetSpace: target,
            spaces,
            stranded,
            // Structural probe: only the resilient provider carries the
            // `degraded` getter (plain offline gateways do not).
            degraded:
              (facade.embedder as { degraded?: boolean }).degraded ?? false,
            note: stranded === 0 ? 'no fragmentation' : 'run without dryRun (confirm: true) to migrate',
          };
        }
        const budget = Math.min(512, Math.max(1, Math.round(finiteOr(input.budget, 100))));
        const result = await facade.migrator.tick(budget);
        return {
          ...result,
          note: result.degraded
            ? 'embedder degraded — migration deferred; retry after recovery'
            : result.remaining > 0
              ? `${result.remaining} still stranded — call again to continue`
              : 'all vectors unified',
        };
      },
    },

    // ------------------------------------------------------------------ why
    {
      name: 'memory_why',
      description:
        'Provenance trace: WHY does the palace believe something about an ' +
        'entity? Lists typed relations (direct AND inferred — inferred ' +
        'chains flagged with their confidence), the evidence items that ' +
        'mention it, and where the knowledge originated. The epistemic ' +
        'mirror of memory_retrieve.',
      parameters: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Entity name to trace' },
        },
        required: ['entity'],
      },
      returns: { type: 'object' },
      run: async (input: { entity: string }, tctx: ToolContext) => {
        const levels = scopeLevels(facade.config.scope.kind, scopeOf(tctx));
        const ent = facade.store.findEntityInScope(input.entity, levels);
        if (!ent) {
          return { error: `entity "${input.entity}" not found in your scope` };
        }
        const level = toolLevel(facade, tctx);
        const edges = facade.store.listEdgesScoped(level);
        // By-id display lookup: edge endpoint ids came from this caller's
        // scoped edge list, so the ACL was applied upstream; every scoped
        // store read is by NAME, leaving no non-deprecated by-id
        // equivalent to migrate to.
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- id-keyed name resolution over scope-derived edge endpoints
        const nameOf = (id: string) => facade.store.getEntity(id)?.name ?? id;
        const relations = edges
          .filter((e) => e.from === ent.id || e.to === ent.id)
          .filter((e) => e.relation !== 'co-occurs')
          .slice(0, 20)
          .map((e) => ({
            direction: e.from === ent.id ? 'out' : 'in',
            relation: e.relation,
            inferred: e.relation.startsWith('inf:'),
            confidence: e.relation.startsWith('inf:') ? e.weight : undefined,
            counterparty: e.from === ent.id ? nameOf(e.to) : nameOf(e.from),
          }));
        const evidenceItems = facade.store.itemsForEntityScoped(level, ent.id, 5);
        if (facade.learner && evidenceItems.length > 0) {
          // Positive engagement signal, upgraded from a constant: the agent
          // acted on the ranking that served this entity's evidence
          // (provenance tracing IS engagement), and the derived reward now
          // grades HOW WELL that ranking self-identifies the evidence —
          // see whySelfConsistencyReward. engagedItemIds/totalHits still
          // ride along as evidence bookkeeping. Best-effort only.
          try {
            // Degradation chain: a failed probe (embedding circuit open,
            // store hiccup) drops `reward` from the signal and learn()
            // falls back to the legacy engaged/totalHits ratio — 1.0 here,
            // since every evidence item counts as engaged. The event keeps
            // its bookkeeping and loses only its resolution.
            let reward: number | undefined;
            try {
              reward = await whySelfConsistencyReward(
                facade.retriever,
                evidenceItems,
                scopeOf(tctx),
              );
            } catch {
              reward = undefined;
            }
            facade.learner.learn({
              engagedItemIds: evidenceItems.map((i) => i.id),
              totalHits: evidenceItems.length,
              query: input.entity,
              scope: scopeOf(tctx),
              ...(reward !== undefined ? { reward } : {}),
            });
          } catch (err) {
            warn(`[${PLUGIN_NAME}] why feedback learn failed: ${String(err)}`);
          }
        }
        const evidence = evidenceItems.map((i) => ({
          itemId: i.id,
          content: truncate(i.content, 140),
          importance: i.importance,
          sessionId: i.metadata.sessionId,
          createdAt: i.createdAt,
        }));
        return {
          entity: { name: ent.name, type: ent.type, mentions: ent.mentionCount },
          relations,
          evidence,
        };
      },
    },

    // ---------------------------------------------------------------- sleep
    {
      name: 'memory_sleep',
      description:
        'Run one full consolidation cycle NOW: compression (evict + distill ' +
        '+ mine patterns + retention) followed by core-block compaction ' +
        'against current entity salience. Emits memory.slept with a dream ' +
        'report. Normally automatic (session.end + every 25th message) — ' +
        'call manually to force a night\'s sleep mid-session.',
      parameters: {
        type: 'object',
        properties: {
          forceCompression: { type: 'boolean', default: false },
        },
      },
      returns: { type: 'object' },
      async run(input: { forceCompression?: boolean }, tctx: ToolContext) {
        return facade.sleep.sleep(scopeOf(tctx), {
          ...(input.forceCompression !== undefined
            ? { forceCompression: input.forceCompression }
            : {}),
        });
      },
    },
  ];
}

export default MemoryPalacePlugin;
export { MemoryPalacePlugin, buildToolDefinitions };
export type { PluginConfig };
