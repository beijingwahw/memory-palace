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
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio mode).
 */

import { createInterface } from 'node:readline';
import { DEFAULT_CONFIG, NOOP_BUS, type PluginConfig } from '../types/index.js';
import { MemoryStore } from '../services/memory-store.js';
import { MemoryIngestor } from '../services/memory-ingestor.js';
import { MemoryGraph } from '../services/memory-graph.js';
import { MemoryRetriever } from '../services/memory-retriever.js';
import { MemoryFederation } from '../services/memory-federation.js';
import { MemoryReflector } from '../services/reflector.js';
import { createEmbeddingProvider } from '../utils/embedding.js';
import { buildToolDefinitions, type ToolFacade } from '../index.js';
import { McpPalaceServer, type JsonRpcRequest } from '../mcp-server.js';

async function main(): Promise<void> {
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    storagePath: process.env['MEMORY_PALACE_DB'] ?? './memory-palace.db',
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      provider: process.env['DEEPSEEK_API_KEY'] ? 'deepseek' : 'offline-bm25',
      apiKey: process.env['DEEPSEEK_API_KEY'],
      dimensions: Number(process.env['MEMORY_PALACE_DIMS'] ?? 1024),
    },
    scope: (process.env['MEMORY_PALACE_SCOPE'] as PluginConfig['scope']) ?? 'user',
  };

  const bus = { emit: (event: string, payload: unknown) => { void event; void payload; } };
  const embedder = createEmbeddingProvider(config.embedding);
  const store = new MemoryStore(
    {
      storagePath: config.storagePath,
      dimensions: embedder.dimensions,
      scope: config.scope,
      activeSpace: embedder.spaces()[0],
    },
    NOOP_BUS,
  );
  const ingestor = new MemoryIngestor(store, embedder, config.scope);
  const graph = new MemoryGraph(store, config.graph, NOOP_BUS);
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
    NOOP_BUS,
  );
  const federation = new MemoryFederation(store, graph, retriever, config.scope, NOOP_BUS);
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
    NOOP_BUS,
  );
  if (config.graph.enabled) ingestor.bindGraph(graph);

  const facade: ToolFacade & { palaceId: string } = {
    config,
    store,
    ingestor,
    retriever,
    graph,
    federation,
    reflector,
    palaceId: process.env['MEMORY_PALACE_ID'] ?? 'mcp-palace',
  };
  const tools = buildToolDefinitions(facade, bus);
  const server = new McpPalaceServer(tools, {
    sessionId: process.env['MEMORY_PALACE_SESSION'] ?? 'mcp',
    userId: process.env['MEMORY_PALACE_USER'],
    workspaceId: process.env['MEMORY_PALACE_WORKSPACE'],
  });

  process.stderr.write(
    `[memory-palace-mcp] ready: ${server.toolNames().length} tools, db=${config.storagePath}, space=${embedder.spaces()[0]}\n`,
  );

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(text) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
      );
      return;
    }
    server
      .handle(msg)
      .then((resp) => {
        // Notifications (no id) get no response, per JSON-RPC.
        if (msg.id === undefined) return;
        process.stdout.write(`${JSON.stringify(resp)}\n`);
      })
      .catch((e) => {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(e) } })}\n`,
        );
      });
  });
  rl.on('close', () => {
    try { store.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}

main().catch((e) => {
  process.stderr.write(`[memory-palace-mcp] fatal: ${String(e)}\n`);
  process.exit(1);
});
