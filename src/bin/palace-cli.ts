#!/usr/bin/env node
/**
 * palace-cli — ground the memory palace in REAL data.
 *
 *   palace-cli ingest --db palace.db --user u1 \
 *     --claude ~/Downloads/conversations.json \
 *     --openai ~/Downloads/chatgpt-conversations.json \
 *     --jsonl session-log.jsonl \
 *     --md ./docs
 *
 *   palace-cli query --db palace.db --user u1 "how does scope isolation work" --topk 5 --explain
 *   palace-cli stats --db palace.db
 *
 * Formats (auto-detected per input when flags are omitted):
 *   claude — Claude export: [{ name, chat_messages: [{ sender: 'human'|'assistant', text, created }] }]
 *   openai — ChatGPT export: [{ title, mapping: { id: { message: { author: { role }, content: { parts }, create_time } } } }]
 *   jsonl  — one {role|sender, content|text} object per line
 *   md     — markdown files; each "## " section becomes one memory
 *
 * Ingestion runs the REAL pipeline: chunker → embedding → scoped store →
 * knowledge graph, two-phase transactional — the same code path a live
 * DSH session exercises. Queries run the v3 retrieval kernel with full
 * explain output.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DEFAULT_CONFIG, NOOP_BUS, type PluginConfig } from '../types/index.js';
import { MemoryStore } from '../services/memory-store.js';
import { MemoryIngestor } from '../services/memory-ingestor.js';
import { MemoryGraph } from '../services/memory-graph.js';
import { MemoryRetriever } from '../services/memory-retriever.js';
import { createEmbeddingProvider } from '../utils/embedding.js';

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: number;
  conversation?: string;
}

// ------------------------------------------------------------- format parsers

function parseClaudeExport(json: string): ParsedMessage[] {
  const convos = JSON.parse(json) as Array<{
    name?: string;
    chat_messages?: Array<{ sender?: string; text?: string; created?: number | string }>;
  }>;
  const out: ParsedMessage[] = [];
  for (const c of convos) {
    for (const m of c.chat_messages ?? []) {
      if (!m.text || m.text.length < 32) continue;
      const role = m.sender === 'human' ? 'user' : 'assistant';
      out.push({
        role,
        content: m.text,
        createdAt: m.created ? new Date(m.created).getTime() : undefined,
        conversation: c.name,
      });
    }
  }
  return out;
}

function parseOpenAiExport(json: string): ParsedMessage[] {
  const convos = JSON.parse(json) as Array<{
    title?: string;
    mapping?: Record<
      string,
      { message?: { author?: { role?: string }; content?: { parts?: string[] }; create_time?: number } }
    >;
  }>;
  const out: ParsedMessage[] = [];
  for (const c of convos) {
    const nodes = Object.values(c.mapping ?? {});
    nodes.sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0));
    for (const node of nodes) {
      const msg = node.message;
      if (!msg?.content?.parts) continue;
      const text = msg.content.parts
        .filter((p): p is string => typeof p === 'string')
        .join('\n')
        .trim();
      if (text.length < 32) continue;
      const role = msg.author?.role === 'assistant' ? 'assistant' : 'user';
      if (role !== 'user' && role !== 'assistant') continue;
      out.push({
        role,
        content: text,
        createdAt: msg.create_time ? msg.create_time * 1000 : undefined,
        conversation: c.title,
      });
    }
  }
  return out;
}

function parseJsonl(text: string): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      const content = (o['content'] ?? o['text']) as string | undefined;
      const rawRole = (o['role'] ?? o['sender'] ?? o['type']) as string | undefined;
      if (typeof content !== 'string' || content.length < 32) continue;
      const role = rawRole === 'assistant' || rawRole === 'ai' ? 'assistant' : 'user';
      out.push({ role, content });
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** Markdown: each "## " section (with its body) becomes one memory. */
function parseMarkdown(text: string, fileName: string): Array<{ title: string; body: string }> {
  const lines = text.split('\n');
  const sections: Array<{ title: string; body: string }> = [];
  let title = fileName;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body.length >= 40) sections.push({ title, body });
    buf = [];
  };
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    if (!inFence && /^##\s+/.test(line)) {
      flush();
      title = line.replace(/^##\s+/, '').trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function readInputs(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`input not found: ${p}`);
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) {
        if (/\.(md|json|jsonl|txt|yaml)$/i.test(f)) files.push(join(p, f));
      }
    } else {
      files.push(p);
    }
  }
  return files;
}

// ----------------------------------------------------------------- wiring

function buildRuntime(dbPath: string) {
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    storagePath: dbPath,
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      provider: process.env['DEEPSEEK_API_KEY'] ? 'deepseek' : 'offline-bm25',
      apiKey: process.env['DEEPSEEK_API_KEY'],
      dimensions: Number(process.env['MEMORY_PALACE_DIMS'] ?? 1024),
    },
  };
  const embedder = createEmbeddingProvider(config.embedding);
  const store = new MemoryStore(
    {
      storagePath: config.storagePath,
      dimensions: embedder.dimensions,
      scope: 'user',
      activeSpace: embedder.spaces()[0],
    },
    NOOP_BUS,
  );
  const ingestor = new MemoryIngestor(store, embedder, 'user');
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
      scope: 'user',
      prf: config.retrieval.prf,
      entityHop: config.retrieval.entityHop,
      queryCache: config.retrieval.queryCache,
    },
    config.graph.enabled ? graph : undefined,
    NOOP_BUS,
  );
  ingestor.bindGraph(graph);
  return { store, ingestor, retriever, graph, config };
}

async function cmdIngest(args: string[]): Promise<void> {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const db = get('--db') ?? './palace.db';
  const userId = get('--user') ?? 'cli-user';
  // Inputs come from format flags AND bare paths.
  const inputs: Array<{ path: string; format?: string }> = [];
  const flags: Array<[string, string | undefined]> = [
    ['--claude', 'claude'],
    ['--openai', 'openai'],
    ['--chatgpt', 'openai'],
    ['--jsonl', 'jsonl'],
    ['--md', 'md'],
    ['--file', undefined],
  ];
  for (const [flag, format] of flags) {
    const v = get(flag);
    if (v) inputs.push({ path: v, format });
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      i++; // skip the flag's value
      continue;
    }
    inputs.push({ path: args[i]!, format: undefined });
  }
  if (inputs.length === 0) {
    console.error('no inputs — pass --claude/--openai/--jsonl/--md <path> or bare paths');
    process.exitCode = 1;
    return;
  }

  const { store, ingestor, graph } = buildRuntime(db);
  const files = readInputs(inputs.map((i) => i.path));
  let messages = 0;
  let docs = 0;
  let events = 0;

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi]!;
    const explicit = inputs.find((i) => i.path === file)?.format;
    const text = readFileSync(file, 'utf8');
    const ext = extname(file).toLowerCase();
    const format =
      explicit ??
      (file.endsWith('conversations.json') && /chat_messages/.test(text.slice(0, 4000))
        ? 'claude'
        : /"mapping"/.test(text.slice(0, 4000))
          ? 'openai'
          : ext === '.jsonl' || (ext === '.json' && text.trimStart().startsWith('{'))
            ? 'jsonl'
            : 'md');

    if (format === 'md') {
      for (const sec of parseMarkdown(text, file)) {
        await ingestor.ingestUserMemory({
          content: `# ${sec.title}\n\n${sec.body}`.slice(0, 8000),
          tags: ['doc', sec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)],
          userId,
        });
        docs++;
      }
      continue;
    }

    let parsed: ParsedMessage[] = [];
    if (format === 'claude') parsed = parseClaudeExport(text);
    else if (format === 'openai') parsed = parseOpenAiExport(text);
    else parsed = parseJsonl(text);
    for (const m of parsed) {
      await ingestor.ingestMessage({
        role: m.role,
        content: m.content.slice(0, 8000),
        sessionId: m.conversation ? `conv:${m.conversation}`.slice(0, 80) : `file:${file}`,
        userId,
        ts: m.createdAt,
      });
      messages++;
    }
    console.log(`  [${format}] ${file}: ${parsed.length} messages`);
  }

  const stats = store.stats();
  console.log(
    `\ningested: ${messages} messages + ${docs} doc sections → ` +
      `${stats.items.semantic} semantic items, ${stats.entities} entities, ` +
      `${stats.edges} edges (${stats.sizeBytes} bytes)`,
  );
  console.log(`top entities: ${graph.stats().topEntities.slice(0, 5).map((e) => e.name).join(', ')}`);
  store.close();
}

async function cmdQuery(args: string[]): Promise<void> {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const db = get('--db') ?? './palace.db';
  const userId = get('--user') ?? 'cli-user';
  const topK = Number(get('--topk') ?? 5);
  const explain = args.includes('--explain');
  const query = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--db' && args[i - 1] !== '--user' && args[i - 1] !== '--topk').join(' ');
  if (!query) {
    console.error('usage: palace-cli query --db p.db "query" [--topk N] [--explain]');
    process.exitCode = 1;
    return;
  }
  const { store, retriever } = buildRuntime(db);
  const res = await retriever.retrieve({ query, topK, scope: { userId }, explain: true });
  console.log(`\nquery: "${query}"  →  ${res.hits.length} hits, ${res.elapsedMs}ms, ` +
    `pool=${res.debug?.vectorRecall} scopeLevel=${res.debug?.scopeLevel} ` +
    `prf=${res.debug?.prfApplied} hop=${res.debug?.entityHop} cache=${res.debug?.cacheHit ?? false}`);
  for (const h of res.hits) {
    console.log(`\n  [${h.finalScore.toFixed(3)}] (${h.item.layer}${h.via === 'entity-hop' ? '/hop' : ''}) ${h.item.content.slice(0, 160).replace(/\n/g, ' ')}…`);
    if (explain && h.explain) {
      const g = h.explain.graph;
      console.log(
        `        raw=${h.explain.rawScore.toFixed(3)} decay=${h.explain.decayFactor.toFixed(2)} ` +
          `imp=${h.explain.importanceFactor.toFixed(2)} graph=${h.explain.graphMultiplier.toFixed(2)}` +
          (h.explain.keywordScore !== undefined ? ` kw=${h.explain.keywordScore.toFixed(2)}` : '') +
          (g?.entityName ? ` entity="${g.entityName}"(${g.globalRank}/${g.proximityRank ?? '-'})` : ''),
      );
    }
  }
  store.close();
}

async function cmdStats(args: string[]): Promise<void> {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const db = get('--db') ?? './palace.db';
  const { store, graph } = buildRuntime(db);
  const s = store.stats();
  console.log(JSON.stringify({ ...s, spaces: s.spaces, topEntities: graph.stats().topEntities.slice(0, 10) }, null, 2));
  store.close();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'ingest') await cmdIngest(rest);
  else if (cmd === 'query') await cmdQuery(rest);
  else if (cmd === 'stats') await cmdStats(rest);
  else {
    console.error('usage: palace-cli <ingest|query|stats> [flags] — see file header for examples');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.stack : e));
  process.exit(1);
});
