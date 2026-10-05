/**
 * DSH Memory Palace — Cordis plugin entry point.
 *
 * Wires up the layered memory stack (store / ingestor / retriever /
 * compressor / graph / injector), exposes services via the Cordis kernel,
 * subscribes to DSH lifecycle hooks (session.start, message.*, tool.*),
 * and registers the five model-callable memory tools when the host
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
import { MemoryStore } from './services/memory-store.js';
import { MemoryIngestor } from './services/memory-ingestor.js';
import { MemoryRetriever } from './services/memory-retriever.js';
import { MemoryCompressor } from './services/memory-compressor.js';
import { MemoryFederation } from './services/memory-federation.js';
import { MemoryReflector } from './services/reflector.js';
import { MemoryGraph, extract } from './services/memory-graph.js';
import { ContextInjector } from './services/context-injector.js';
import { createEmbeddingProvider, type EmbeddingGateway } from './utils/embedding.js';
import {
  scopeLevels,
  tierDisjunction,
  widestLevel,
  type ScopeLevelClause,
} from './utils/scope.js';
import { parseQueryHints } from './utils/query-understanding.js';
import { clusterByConsensus, detectConflict } from './utils/consensus.js';
import { labelPropagation } from './utils/communities.js';
import { buildAdjacency, shortestPath } from './utils/graph-paths.js';
import { duplicationRatio, gini, median, ratioAtLeast } from './utils/health.js';
import {
  DEFAULT_CONFIG,
  type MemoryEventBus,
  type MemoryItem,
  type PluginConfig,
  type RetrievalResult,
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

import { truncateText as truncate } from './utils/tokenizer.js';

export interface MemoryPalaceOptions extends Partial<PluginConfig> {
  /** Provided by Cordis kernel at install time. */
  workspaceDir?: string;
}

const PLUGIN_NAME = 'memory-palace';

/** Re-check mid-session compression + embedder health after N message events. */
const COMPRESS_CHECK_EVERY = 25;

/**
 * Set once this module has installed its SIGINT/SIGTERM hooks. Signal
 * handlers must be registered at most once per process, even when the
 * plugin function runs for several contexts; a plain module-level flag
 * (WeakRef-free) is the registration guard.
 */
let signalHandlersHooked = false;

const MemoryPalacePlugin: CordisPlugin<MemoryPalaceOptions> = (ctx, options = {}) => {
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...options,
    embedding: { ...DEFAULT_CONFIG.embedding, ...(options.embedding ?? {}) },
    retrieval: { ...DEFAULT_CONFIG.retrieval, ...(options.retrieval ?? {}) },
    compression: { ...DEFAULT_CONFIG.compression, ...(options.compression ?? {}) },
    graph: { ...DEFAULT_CONFIG.graph, ...(options.graph ?? {}) },
    injection: { ...DEFAULT_CONFIG.injection, ...(options.injection ?? {}) },
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
    emit: (event: string, payload: unknown) => ctx.emit(event, payload),
  };

  const embedder: EmbeddingGateway = createEmbeddingProvider(config.embedding);
  const store = new MemoryStore(
    {
      storagePath: config.storagePath,
      dimensions: embedder.dimensions,
      scope: config.scope,
      activeSpace: embedder.spaces()[0],
    },
    bus,
  );
  const ingestor = new MemoryIngestor(store, embedder, config.scope);
  const graph = new MemoryGraph(store, config.graph, bus);
  const retriever = new MemoryRetriever(
    store,
    embedder,
    {
      topK: config.retrieval.topK,
      mmrLambda: config.retrieval.mmrLambda,
      minScore: config.retrieval.minScore,
      rerank: config.retrieval.rerank,
      graphBoost: config.retrieval.graphBoost,
      graphPersonalization: config.graph.personalizationWeight,
      decayHalfLifeDays: config.compression.decayHalfLifeDays,
      scope: config.scope,
      prf: config.retrieval.prf,
      entityHop: config.retrieval.entityHop,
      queryCache: config.retrieval.queryCache,
    },
    config.graph.enabled ? graph : undefined,
    bus,
  );
  const compressor = new MemoryCompressor(store, embedder, config.compression, bus);
  if (config.graph.enabled) ingestor.bindGraph(graph);
  const injector = new ContextInjector(retriever, graph, store, config.injection, config.scope);
  const federation = new MemoryFederation(store, graph, retriever, config.scope, bus);
  const reflector = new MemoryReflector(
    store,
    embedder,
    {
      topK: config.retrieval.topK,
      mmrLambda: config.retrieval.mmrLambda,
      minScore: config.retrieval.minScore,
      rerank: config.retrieval.rerank,
      graphBoost: config.retrieval.graphBoost,
      graphPersonalization: config.graph.personalizationWeight,
      decayHalfLifeDays: config.compression.decayHalfLifeDays,
      scope: config.scope,
      prf: config.retrieval.prf,
      entityHop: config.retrieval.entityHop,
      queryCache: config.retrieval.queryCache,
    },
    config.graph.enabled ? graph : undefined,
    bus,
  );
  const palaceId = randomUUID();

  // Register Cordis services ----------------------------------------------
  ctx.service('memory-store', store);
  ctx.service('memory-ingestor', ingestor);
  ctx.service('memory-retriever', retriever);
  ctx.service('memory-compressor', compressor);
  ctx.service('memory-graph', graph);
  ctx.service('context-injector', injector);
  ctx.service('memory-federation', federation);
  ctx.service('memory-reflector', reflector);

  // Expose a single facade service for ergonomic access. The facade is a
  // public service: any ctx.service('memory-palace') consumer can read it,
  // so the config it exposes carries a redacted embedding API key. The
  // internal wiring above (embedder, store, retriever, …) keeps using the
  // real `config` variable — only the published copy is sanitized.
  const publicConfig: PluginConfig = {
    ...config,
    embedding: {
      ...config.embedding,
      apiKey: config.embedding.apiKey ? '***redacted***' : undefined,
    },
  };
  const facade = {
    store,
    ingestor,
    retriever,
    compressor,
    graph,
    injector,
    federation,
    reflector,
    palaceId,
    config: publicConfig,
    async stats() {
      return store.stats();
    },
    async retrieve(query: string, opts: { topK?: number; userId?: string; workspaceId?: string; sessionId?: string } = {}) {
      return retriever.retrieve({ query, ...opts, scope: opts });
    },
    async remember(
      content: string,
      opts: { tags?: string[]; importance?: number } = {},
    ) {
      return ingestor.ingestUserMemory({ content, ...opts });
    },
  };
  ctx.service('memory-palace', facade);

  // Model tools (DSH TypeScript Tool Contract) ------------------------------
  // Registered only when the host provides ctx.tool; the definitions are
  // built unconditionally so tests and programmatic users can reuse them.
  const tools: ToolDefinition[] = buildToolDefinitions(facade, bus);
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
  const onMessageMaintenanceTick = async (): Promise<void> => {
    messageEventsSinceCheck++;
    if (messageEventsSinceCheck < COMPRESS_CHECK_EVERY) return;
    messageEventsSinceCheck = 0;
    checkEmbedderHealth();
    if (!config.compression.enabled || !compressor.shouldRun()) return;
    try {
      const report = await compressor.runOnce();
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
      const out = await injector.inject({
        sessionId: event.sessionId,
        intent: opening,
        workspaceId: pickOptString(event.payload, 'workspaceId'),
        userId: pickOptString(event.payload, 'userId'),
      });
      ctx.emit('memory.context-injected', out);
    }
  });

  ctx.on('session.end', async (event: CordisEvent) => {
    ctx.logger.info(`[${PLUGIN_NAME}] session.end sid=${event.sessionId}`);
    if (config.compression.enabled && compressor.shouldRun()) {
      ctx.logger.info(`[${PLUGIN_NAME}] running compression`);
      // The compressor itself emits memory.compressed via the bus.
      await compressor.runOnce();
    }
  });

  ctx.on('message.user', async (event: CordisEvent) => {
    // Entity extraction happens ONCE, inside the ingestor (it is
    // graph-bound); a second call here used to double every mention count
    // and co-occurrence edge weight for user messages.
    await ingestor.ingestMessage({
      role: 'user',
      content: pickString(event.payload, 'content'),
      sessionId: event.sessionId,
      workspaceId: pickOptString(event.payload, 'workspaceId'),
      userId: pickOptString(event.payload, 'userId'),
    });
    await onMessageMaintenanceTick();
  });

  ctx.on('message.assistant', async (event: CordisEvent) => {
    await ingestor.ingestMessage({
      role: 'assistant',
      content: pickString(event.payload, 'content'),
      sessionId: event.sessionId,
      workspaceId: pickOptString(event.payload, 'workspaceId'),
      userId: pickOptString(event.payload, 'userId'),
    });
    await onMessageMaintenanceTick();
  });

  ctx.on('tool.call', async (event: CordisEvent) => {
    await ingestor.ingestToolCall({
      toolName: pickString(event.payload, 'toolName') || 'unknown',
      args: event.payload?.['args'],
      result: undefined,
      sessionId: event.sessionId,
      success: true,
    });
  });

  ctx.on('tool.result', async (event: CordisEvent) => {
    const error = event.payload?.['error'];
    const success = !error;
    await ingestor.ingestToolCall({
      toolName: pickString(event.payload, 'toolName') || 'unknown',
      args: undefined,
      result: event.payload?.['result'],
      sessionId: event.sessionId,
      success,
    });
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
  ctx.on('dispose', closeOnce);

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
    !signalHandlersHooked &&
    typeof process === 'object' &&
    typeof process.on === 'function'
  ) {
    signalHandlersHooked = true;
    process.once('SIGINT', closeOnce);
    process.once('SIGTERM', closeOnce);
  }

  ctx.logger.info(
    `[${PLUGIN_NAME}] installed at ${config.storagePath} ` +
      `(embedder=${embedder.name}, dim=${embedder.dimensions}, ` +
      `space=${embedder.spaces()[0]}, scope=${config.scope})`,
  );
};

/** What the tools need from the plugin runtime. */
export interface ToolFacade {
  config: PluginConfig;
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
}

const VALID_LAYERS = new Set(['episodic', 'semantic', 'procedural']);

/** Runtime-validate caller-provided layer names — never trust the wire. */
function validateLayers(layers: string[] | undefined) {
  if (!layers || layers.length === 0) return undefined;
  const ok = layers.filter((l): l is 'episodic' | 'semantic' | 'procedural' =>
    VALID_LAYERS.has(l),
  );
  return ok.length > 0 ? ok : undefined;
}

const DAY_MS = 86_400_000;
const DEDUPE_SIM = 0.92;
const CONFLICT_SCAN_SIM = 0.75;

/** Link entity names mentioned in a query to graph entity ids (scoped). */
function linkQueryEntities(facade: ToolFacade, query: string, tctx: ToolContext): string[] {
  const levels = scopeLevels(facade.config.scope, scopeOf(tctx));
  const ids: string[] = [];
  for (const { name } of extract(query)) {
    const ent = facade.store.findEntityInScope(name, levels);
    if (ent) ids.push(ent.id);
  }
  return ids;
}

/** Widest cumulative visibility level for a tool caller. */
function toolLevel(facade: ToolFacade, tctx: ToolContext) {
  return widestLevel(scopeLevels(facade.config.scope, scopeOf(tctx)));
}

function scopeOf(tctx: ToolContext) {
  return {
    userId: tctx.userId,
    workspaceId: tctx.workspaceId,
    sessionId: tctx.sessionId,
  };
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

/** Build the five model-callable memory tools around the facade. */
function buildToolDefinitions(facade: ToolFacade, bus: MemoryEventBus): ToolDefinition[] {
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
        const result: RetrievalResult = await facade.retriever.retrieve({
          query: input.query,
          topK: input.topK ?? hints.topK,
          layers: validateLayers(input.layers),
          minScore: input.minScore,
          scope: scopeOf(tctx),
          sinceMs: hints.sinceMs,
          untilMs: hints.untilMs,
          boostEntityIds,
          emphasisPhrases: hints.phrases,
          asOfMs: input.asOf,
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
              embedding: h.item.embedding,
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
        'outdated versions, keeping an auditable supersession chain.',
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
        },
      },
      async run(input: { content: string; tags?: string[]; importance?: number; supersede?: boolean; dedupe?: boolean; visibility?: 'session' | 'workspace' | 'user' | 'global' }, tctx: ToolContext) {
        const scope = scopeOf(tctx);
        const incoming = { id: '', content: input.content, score: 1 };

        // Near-duplicate scan. High similarity alone does NOT mean
        // "same fact": an update ("v16" → "v17") is also ~0.95 similar.
        // Dedupe only when similar AND non-contradictory; otherwise fall
        // through to the conflict/update path.
        if (input.dedupe !== false) {
          const dup = await facade.retriever.retrieve({
            query: input.content,
            topK: 3,
            minScore: DEDUPE_SIM,
            scope,
          });
          const best = dup.hits.reduce<null | (typeof dup.hits)[number]>(
            (acc, h) => (!acc || h.rawScore > acc.rawScore ? h : acc),
            null,
          );
          if (best && best.rawScore >= DEDUPE_SIM) {
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
                similarity: Number(best.rawScore.toFixed(3)),
              };
            }
          }
        }

        // Conflict scan against existing memories.
        const related = await facade.retriever.retrieve({
          query: input.content,
          topK: 5,
          minScore: CONFLICT_SCAN_SIM,
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
          tags: input.tags,
          importance: input.importance,
          userId: tctx.userId,
          workspaceId: tctx.workspaceId,
          sessionId: tctx.sessionId,
          visibility: input.visibility,
        });

        let superseded: string[] | undefined;
        if (conflicts.length > 0 && input.supersede) {
          superseded = [];
          for (const c of conflicts) {
            if (facade.store.tombstoneItem(c.id, id)) superseded.push(c.id);
          }
        }

        bus.emit('memory.remembered', { id, conflicts: conflicts.length, superseded: superseded?.length ?? 0 });
        return conflicts.length > 0
          ? { id, deduplicated: false, conflicts, superseded }
          : { id, deduplicated: false };
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
          // Scoped purge: without levels this would hard-delete every
          // tenant's tombstones instead of just the caller's.
          const purged = facade.store.purgeDeleted(
            0,
            scopeLevels(facade.config.scope, scopeOf(tctx)),
          );
          bus.emit('memory.forgotten', { mode: 'purge', count: purged });
          return { mode: 'purge', purged };
        }
        if (input.restore && input.id) {
          // restoreItem targets a tombstoned row, which getItemInScope's
          // LIVE filter cannot see — fetch the row raw and enforce the
          // same visibility ACL in JS before un-deleting it.
          const levels = scopeLevels(facade.config.scope, scopeOf(tctx));
          const tombstoned = facade.store.getItem(input.id);
          if (!tombstoned || !visibleToCaller(tombstoned, levels)) {
            return { mode: 'restore', restored: 0, id: input.id, note: 'id not found in your scope' };
          }
          const restored = facade.store.restoreItem(input.id);
          return { mode: 'restore', restored, id: input.id };
        }
        if (input.entity) {
          const ent = facade.store.findEntityInScope(
            input.entity,
            scopeLevels(facade.config.scope, scopeOf(tctx)),
          );
          if (!ent) return { mode: 'entity', forgotten: 0, note: `entity "${input.entity}" not found in your scope` };
          if (input.dryRun) {
            const items = facade.store.itemsForEntity(ent.id, 50);
            return {
              mode: 'entity',
              dryRun: true,
              entity: { name: ent.name, mentionCount: ent.mentionCount },
              items: items.map((i) => ({ id: i.id, content: truncate(i.content, 120) })),
            };
          }
          const casc = facade.store.deleteEntityCascade(ent.id);
          bus.emit('memory.forgotten', { mode: 'entity', count: casc.items, entity: ent.name });
          return { mode: 'entity', forgotten: casc.items, edgesRemoved: casc.edges, entity: ent.name };
        }
        if (input.query) {
          const res = await facade.retriever.retrieve({
            query: input.query,
            topK: 20,
            minScore: input.minScore ?? 0.5,
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
          return { mode: 'query', forgotten, items: targets };
        }
        if (input.id) {
          // ACL: getItem would fetch any tenant's row; getItemInScope
          // only returns LIVE rows visible to this caller.
          const levels = scopeLevels(facade.config.scope, scopeOf(tctx));
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
        'items — plus a health panel (signal ratio, duplication ratio, age ' +
        'distribution, PageRank concentration/Gini, orphan entities) and ' +
        'concrete maintenance recommendations.',
      parameters: { type: 'object', properties: {} },
      returns: { type: 'object' },
      async run(_input: unknown, tctx: ToolContext) {
        const { store, graph, config } = facade;
        const stats = store.stats();
        const level = toolLevel(facade, tctx);

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
          tombstoned: stats.tombstoned,
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

        return {
          stats,
          graph: graph.stats(level),
          recent: store.listRecentItemsScoped(level, 10),
          health,
          recommendations,
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
          hops: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
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
      async run(input: {
        mode?: string; entity?: string; target?: string;
        hops?: number; maxNodes?: number; limit?: number;
      }, tctx: ToolContext) {
        const { store, graph } = facade;
        const mode = input.mode ?? 'expand';
        const level = toolLevel(facade, tctx);
        const levels = scopeLevels(facade.config.scope, scopeOf(tctx));

        if (mode === 'path') {
          if (!input.entity || !input.target) {
            return { mode, error: 'path mode requires entity and target' };
          }
          const from = store.findEntityInScope(input.entity, levels);
          const to = store.findEntityInScope(input.target, levels);
          if (!from) return { mode, error: `entity "${input.entity}" not found in your scope` };
          if (!to) return { mode, error: `entity "${input.target}" not found in your scope` };
          const adjacency = buildAdjacency(store.listEdgesScoped(level));
          const path = shortestPath(adjacency, from.id, to.id, (input.hops ?? 3) * 2);
          if (!path) {
            return {
              mode,
              path: [],
              note: `no co-occurrence path between "${input.entity}" and "${input.target}" within ${(input.hops ?? 3) * 2} hops`,
            };
          }
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
            .slice(0, input.limit ?? 8)
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
        const subgraph = graph.describeSubgraph(root.name, input.hops ?? 1, input.maxNodes ?? 30, level);
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
          query: input.query,
          entity: input.entity,
          all: input.all,
          topK: input.topK,
          secret: input.secret,
          palaceId: facade.palaceId,
          scope: scopeOf(tctx),
        });
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
          secret: input.secret,
          visibility: input.visibility,
          force: input.force,
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
          maxEntries: input.maxEntries,
        });
        return {
          ...report,
          note: 'Update dsh.yaml retrieval.graphBoost / retrieval.prf.{alpha,beta} to apply',
        };
      },
    },
  ];
}

export default MemoryPalacePlugin;
export { MemoryPalacePlugin, buildToolDefinitions };
export type { PluginConfig };
