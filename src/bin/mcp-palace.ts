#!/usr/bin/env node
/**
 * memory-palace-mcp — run the palace as a standalone MCP stdio server.
 *
 * Any MCP client (Claude Desktop, IDE agents, custom orchestrators) can
 * mount the memory palace without DSH:
 *
 *   memory-palace-mcp                          # offline embeddings, ./memory-palace.db
 *   MEMORY_PALACE_DB=/path/palace.db ...       # custom store
 *   DEEPSEEK_API_KEY=sk-... ...                # DeepSeek embeddings (failover kept)
 *   MEMORY_PALACE_USER=u-42 ...                # identity for the ACL (global if unset)
 *   MEMORY_PALACE_ANON_POLICY=quarantine ...   # writes from identity-less callers:
 *                                              # global | quarantine | reject
 *   MEMORY_PALACE_ADMIN_IDS=a,b ...            # admin whitelist for live
 *                                              # memory_migrate (unset = anyone
 *                                              # with confirm:true may run it)
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio mode).
 */

import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CONFIG,
  NOOP_BUS,
  type MemoryScopeKind,
  type PluginConfig,
} from '../types/index.js';
import { MemoryStore } from '../services/memory-store.js';
import { MemoryIngestor } from '../services/memory-ingestor.js';
import { MemoryGraph } from '../services/memory-graph.js';
import { MemoryRetriever } from '../services/memory-retriever.js';
import { MemoryFederation } from '../services/memory-federation.js';
import { CoreMemoryService } from '../services/core-memory.js';
import { MemoryCompressor } from '../services/memory-compressor.js';
import { SleepCycle } from '../services/sleep.js';
import { Inferencer } from '../services/inferencer.js';
import { SpaceMigrator } from '../services/space-migrator.js';
import { IntentPredictor } from '../services/intent-predictor.js';
import { FeedbackLearner } from '../services/feedback-learner.js';
import { Stratifier } from '../services/stratifier.js';
import { FederatedRetriever } from '../services/federated-retriever.js';
import { CrdtFederation } from '../services/crdt-federation.js';
import { MemoryReflector } from '../services/reflector.js';
import { createEmbeddingProvider } from '../utils/embedding.js';
import { invariant } from '../utils/invariants.js';
import { buildToolDefinitions, type ToolFacade } from '../index.js';
import { McpPalaceServer, ERR_PARSE, type JsonRpcRequest } from '../mcp-server.js';

const DEFAULT_DIMENSIONS = 1024;
// 'global' is a visibility tier, not a home MemoryScopeKind — keep it out.
const VALID_SCOPES: ReadonlySet<string> = new Set(['session', 'workspace', 'user']);
const VALID_ANON_POLICIES: ReadonlySet<string> = new Set(['global', 'quarantine', 'reject']);

/** MEMORY_PALACE_DIMS → a finite positive number, else the 1024 default
 *  with a stderr warning — a typo'd env var degrades loudly, not silently. */
function dimensionsFromEnv(): number {
  const env = process.env['MEMORY_PALACE_DIMS'];
  if (env === undefined) return DEFAULT_DIMENSIONS; // unset → silent default
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(
      `[memory-palace-mcp] invalid MEMORY_PALACE_DIMS="${env}" (must be a positive number), ` +
        `falling back to ${DEFAULT_DIMENSIONS}\n`,
    );
    return DEFAULT_DIMENSIONS;
  }
  return n;
}

/** MEMORY_PALACE_SCOPE → a known scope kind, else 'user' with a warning. */
function scopeFromEnv(): MemoryScopeKind {
  const env = process.env['MEMORY_PALACE_SCOPE'];
  if (env === undefined) return 'user';
  if (VALID_SCOPES.has(env)) return env as MemoryScopeKind;
  process.stderr.write(
    `[memory-palace-mcp] invalid MEMORY_PALACE_SCOPE="${env}" ` +
      `(expected session|workspace|user), falling back to "user"\n`,
  );
  return 'user';
}

/** MEMORY_PALACE_ANON_POLICY → a known anonymous-write policy, else 'global'
 *  with a stderr warning — same degrade-loudly discipline as scopeFromEnv.
 *  The inline union is the AnonymousWritePolicy contract (global | quarantine
 *  | reject); spelled locally so this entry point survives the type's exact
 *  export location. */
function anonymousPolicyFromEnv(): 'global' | 'quarantine' | 'reject' {
  const env = process.env['MEMORY_PALACE_ANON_POLICY'];
  if (env === undefined) return 'global'; // unset → zero-config default
  if (VALID_ANON_POLICIES.has(env)) return env as 'global' | 'quarantine' | 'reject';
  process.stderr.write(
    `[memory-palace-mcp] invalid MEMORY_PALACE_ANON_POLICY="${env}" ` +
      `(expected global|quarantine|reject), falling back to "global"\n`,
  );
  return 'global';
}

/**
 * MEMORY_PALACE_ADMIN_IDS → the scope.adminUserIds whitelist (comma-
 * separated user ids). Tri-state on the ENV VAR: unset → undefined
 * (unconfigured, single-user trust model — zero-config compatibility);
 * set → split on commas and DROP empty segments (trailing commas and
 * "a,,b" are formatting noise, not phantom admins).
 *
 * TRADE-OFF — a set var that filters down to an EMPTY list ("" or ",")
 * degrades to unconfigured with a stderr warning instead of throwing,
 * deliberately DIVERGING from install-time validation where an explicit
 * `adminUserIds: []` is a hard config error: the programmatic form is
 * hand-authored config (a typo worth failing loudly on), while the env
 * form is usually assembled by scripts and a mangled expansion killing
 * the whole server at boot would take the memory palace down over a
 * whitespace bug. Degrading keeps the server useful and the warning
 * still tells the operator their restriction silently lapsed.
 */
function adminIdsFromEnv(): string[] | undefined {
  const env = process.env['MEMORY_PALACE_ADMIN_IDS'];
  if (env === undefined) return undefined; // unset → unconfigured
  const ids = env
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    process.stderr.write(
      '[memory-palace-mcp] MEMORY_PALACE_ADMIN_IDS is set but empty after ' +
        'trimming — treating the admin whitelist as UNCONFIGURED (live ' +
        'memory_migrate open to any caller with confirm:true)\n',
    );
    return undefined;
  }
  return ids;
}

/**
 * Fresh read of stdout's destroyed flag. Reading `process.stdout.destroyed`
 * directly inside writeLine would keep the type narrowed by the FIRST check
 * for the rest of the function — but the flag flips on close/error events
 * that fire during the awaits between chunks, so every check must re-read.
 */
function stdoutDestroyed(): boolean {
  return process.stdout.destroyed;
}

function main(): void {
  const scopeKind = scopeFromEnv();
  const anonymousPolicy = anonymousPolicyFromEnv();
  const adminUserIds = adminIdsFromEnv();
  // One read of the env var keeps the provider choice and the key value
  // paired even if the environment were somehow mutated between reads.
  const deepseekApiKey = process.env['DEEPSEEK_API_KEY'];
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    storagePath: process.env['MEMORY_PALACE_DB'] ?? './memory-palace.db',
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      provider: deepseekApiKey ? 'deepseek' : 'offline-bm25',
      ...(deepseekApiKey !== undefined ? { apiKey: deepseekApiKey } : {}),
      dimensions: dimensionsFromEnv(),
    },
    // scope merges over DEFAULT_CONFIG.scope — anonymousPolicy defaults to
    // 'global' there, so an unset env var boots byte-identical to a palace
    // that never heard of the policy (zero-config compatibility).
    // adminUserIds is spread conditionally so the KEY stays absent when
    // unset — presence is the tri-state signal the memory_migrate admin
    // gate keys on.
    scope: {
      ...DEFAULT_CONFIG.scope,
      kind: scopeKind,
      anonymousPolicy,
      ...(adminUserIds ? { adminUserIds } : {}),
    },
  };

  const embedder = createEmbeddingProvider(config.embedding);
  // Every provider's spaces() returns its fixed non-empty space list —
  // the first entry is the active serving space by contract.
  const activeSpace = embedder.spaces()[0];
  invariant(activeSpace !== undefined, 'embedding provider exposes no spaces');
  const store = new MemoryStore(
    {
      storagePath: config.storagePath,
      dimensions: embedder.dimensions,
      scope: scopeKind,
      activeSpace,
      quantization: config.retrieval.quantization,
    },
    NOOP_BUS,
  );
  // The ingestor owns every user-facing write boundary (message / tool
  // events, remember, import, session.end) — it is where the anonymous
  // policy is enforced, so it takes the resolved policy explicitly.
  const ingestor = new MemoryIngestor(store, embedder, scopeKind, anonymousPolicy);
  const graph = new MemoryGraph(store, config.graph, NOOP_BUS);
  const retrievalOpts = {
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
    retrievalOpts,
    config.graph.enabled ? graph : undefined,
    NOOP_BUS,
  );
  const federation = new MemoryFederation(store, graph, retriever, scopeKind, NOOP_BUS, embedder);
  const compressor = new MemoryCompressor(store, embedder, config.compression, NOOP_BUS);
  const coreSvc = new CoreMemoryService(store, graph, scopeKind, NOOP_BUS);
  const inferencer = new Inferencer(store, ingestor, scopeKind, NOOP_BUS);
  const migrator = new SpaceMigrator(store, embedder, {}, NOOP_BUS);
  const predictor = new IntentPredictor(store, retriever, graph, scopeKind, NOOP_BUS);
  const learner = config.retrieval.fusionLearning.enabled ? new FeedbackLearner(store, NOOP_BUS) : null;
  // 6th param (graph) feeds the stratify kernel's hot-entity salience
  // boost; gated the same way as the retriever/reflector optional graph.
  const stratifier = new Stratifier(
    store,
    ingestor,
    scopeKind,
    NOOP_BUS,
    embedder,
    config.graph.enabled ? graph : undefined,
  );
  const federationRouter = new FederatedRetriever(
    [{ name: 'local', retrieve: (q) => retriever.retrieve(q) }],
    NOOP_BUS,
  );
  const sleepSvc = new SleepCycle(store, compressor, coreSvc, inferencer, migrator, stratifier, scopeKind, NOOP_BUS);
  const reflector = new MemoryReflector(
    store,
    embedder,
    retrievalOpts,
    config.graph.enabled ? graph : undefined,
    NOOP_BUS,
  );
  if (config.graph.enabled) ingestor.bindGraph(graph);

  // Palace identity: once minted it is persisted in the store, so it is
  // stable across restarts; MEMORY_PALACE_ID overrides only the FIRST boot.
  // Persisting (instead of defaulting to a shared literal) means multiple
  // instances on separate DBs never answer to the same palace name.
  const persistedId = store.getMeta('palaceId');
  const palaceId = persistedId ?? process.env['MEMORY_PALACE_ID'] ?? randomUUID();
  if (persistedId === undefined) store.setMeta('palaceId', palaceId);

  // CRDT replica id = persistent palace id; the clock is restored from the
  // op log on boot, so a restart never re-uses (replica, counter) slots.
  const crdtFederation = new CrdtFederation(store, palaceId, NOOP_BUS);

  const facade: ToolFacade = {
    config,
    store,
    ingestor,
    retriever,
    graph,
    federation,
    reflector,
    core: coreSvc,
    sleep: sleepSvc,
    inferencer,
    migrator,
    predictor,
    learner,
    stratifier,
    federationRouter,
    crdtFederation,
    palaceId,
    embedder,
  };
  const tools = buildToolDefinitions(facade, NOOP_BUS);
  // Same tri-state discipline as adminUserIds above: identity keys stay
  // absent when the env var is unset (present-with-undefined would lie
  // about the caller having configured one).
  const sessionUserId = process.env['MEMORY_PALACE_USER'];
  const sessionWorkspaceId = process.env['MEMORY_PALACE_WORKSPACE'];
  const server = new McpPalaceServer(tools, {
    sessionId: process.env['MEMORY_PALACE_SESSION'] ?? 'mcp',
    ...(sessionUserId !== undefined ? { userId: sessionUserId } : {}),
    ...(sessionWorkspaceId !== undefined ? { workspaceId: sessionWorkspaceId } : {}),
  });

  process.stderr.write(
    `[memory-palace-mcp] anonymous-write policy: ${anonymousPolicy} ` +
      `(MEMORY_PALACE_ANON_POLICY: global|quarantine|reject)\n`,
  );
  // Admin banner — only when the whitelist is configured, and COUNT ONLY:
  // the ids themselves are operator identity data, and a startup banner
  // lands in logs that far outlive the process; echoing ids there would
  // leak who holds migration authority to anyone who can read the log.
  if (adminUserIds) {
    process.stderr.write(
      `[memory-palace-mcp] admin whitelist active: ${adminUserIds.length} ` +
        `id(s) may run live memory_migrate (MEMORY_PALACE_ADMIN_IDS)\n`,
    );
  }
  process.stderr.write(
    `[memory-palace-mcp] ready: ${server.toolNames().length} tools, db=${config.storagePath}, space=${embedder.spaces()[0]}\n`,
  );

  // ---- stdio transport ----------------------------------------------------
  // Responses are serialized through a promise chain: lines leave in the
  // order they were produced no matter how the event loop interleaves the
  // async handlers, and a full stdout buffer (write() returning false)
  // back-pressures the whole queue until 'drain' instead of piling up.
  // Large lines (> CHUNK_THRESHOLD) are written in bounded chunks with a
  // setImmediate yield between chunks: one giant synchronous pipe write on
  // Windows blocks the thread for the whole payload, and while blocked the
  // 5s hardExit timer on the drain path can never fire — the process turns
  // into a zombie holding a dead pipe. Chunking keeps every write short
  // and lets the loop breathe between chunks.
  const CHUNK_THRESHOLD = 64 * 1024;
  let writeQueue: Promise<void> = Promise.resolve();
  const writeLine = async (text: string): Promise<void> => {
    try {
      if (stdoutDestroyed()) return;
      if (text.length <= CHUNK_THRESHOLD) {
        if (process.stdout.write(text)) return;
        await waitForDrain();
        return;
      }
      let i = 0;
      while (i < text.length) {
        if (stdoutDestroyed()) return;
        // Do not split a surrogate pair: Node encodes each chunk to UTF-8
        // independently, and a lone high surrogate becomes U+FFFD — silent
        // JSON corruption for CJK-heavy tool payloads.
        let end = Math.min(i + CHUNK_THRESHOLD, text.length);
        if (end < text.length) {
          const code = text.charCodeAt(end - 1);
          if (code >= 0xd800 && code <= 0xdbff) end += 1;
        }
        if (!process.stdout.write(text.slice(i, end))) {
          await waitForDrain();
        }
        i = end;
        // Yield so timers (hardExit, drains) can run between chunks.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch {
      // stdout closed mid-write (EPIPE / aborted drain wait) — nobody left
      // to talk to.
    }
  };
  /** Back-pressure wait for 'drain'; aborts on close/error so an EPIPE
   *  cannot leave the write queue pended forever. */
  const waitForDrain = async (): Promise<void> => {
    const ac = new AbortController();
    const bail = (): void => {
      ac.abort();
    };
    process.stdout.once('close', bail);
    process.stdout.once('error', bail);
    try {
      await once(process.stdout, 'drain', { signal: ac.signal });
    } finally {
      process.stdout.removeListener('close', bail);
      process.stdout.removeListener('error', bail);
    }
  };
  const enqueueWrite = (text: string): void => {
    writeQueue = writeQueue.then(() => writeLine(text));
  };

  // In-flight request bookkeeping so stdin close can drain gracefully.
  let inFlight = 0;
  let drained: (() => void) | undefined;

  // Responses are delivered in REQUEST order: each line takes a sequence
  // number; a finished response parks in `pending` until every earlier
  // request has answered, then the contiguous run is flushed. JSON-RPC
  // itself matches by id and permits reordering, but order-sensitive
  // clients (and humans reading a transcript) are far better served by
  // in-order delivery; the head-of-line cost is negligible for a memory
  // plugin's call pattern.
  let nextSeq = 0;
  let nextToWrite = 0;
  const pendingResponses = new Map<number, string>();

  const flushOrdered = (): void => {
    // Map.get returning undefined IS the end of the contiguous run
    // (response lines are never empty strings — they end in '\n').
    for (;;) {
      const next = pendingResponses.get(nextToWrite);
      if (next === undefined) break;
      enqueueWrite(next);
      pendingResponses.delete(nextToWrite);
      nextToWrite++;
    }
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(text) as JsonRpcRequest;
    } catch {
      enqueueWrite(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'parse error' } })}\n`,
      );
      return;
    }
    const seq = nextSeq++;
    inFlight++;
    server
      .handle(msg)
      .then((resp) => {
        // Notifications (no id) get no response, per JSON-RPC — but they
        // still occupy their sequence slot so ordering holds for the
        // responses around them.
        if (msg.id !== undefined) {
          pendingResponses.set(seq, `${JSON.stringify(resp)}\n`);
        }
      })
      .catch((e: unknown) => {
        pendingResponses.set(
          seq,
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(e) } })}\n`,
        );
      })
      .finally(() => {
        flushOrdered();
        inFlight--;
        if (inFlight === 0 && drained) {
          const resolve = drained;
          drained = undefined;
          resolve();
        }
      });
  });
  rl.on('close', () => {
    // Graceful drain: let in-flight tool calls finish and the write queue
    // flush BEFORE closing the store, so a request whose stdin closed right
    // behind it still gets its response written. A 5s hard timeout forces
    // the exit if a tool call hangs forever — .unref()'d so the timer can
    // never itself keep the event loop (and a normal exit) alive.
    const hardExit = setTimeout(() => process.exit(0), 5000);
    hardExit.unref();
    void (async () => {
      if (inFlight > 0) await new Promise<void>((resolve) => { drained = resolve; });
      await writeQueue;
      clearTimeout(hardExit);
      try { store.close(); } catch { /* already closed */ }
      process.exit(0);
    })();
  });
}

try {
  main();
} catch (e) {
  process.stderr.write(`[memory-palace-mcp] fatal: ${String(e)}\n`);
  process.exit(1);
}
