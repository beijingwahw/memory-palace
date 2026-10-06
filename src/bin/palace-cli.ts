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
import { invariant } from '../utils/invariants.js';

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
        ...(m.created ? { createdAt: new Date(m.created).getTime() } : {}),
        ...(c.name !== undefined ? { conversation: c.name } : {}),
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
      // human/user → user, assistant → assistant; system/tool bookkeeping
      // nodes stay out of the palace entirely (they are transport metadata,
      // not conversation).
      const raw = msg.author?.role;
      if (raw !== 'assistant' && raw !== 'human' && raw !== 'user') continue;
      const role: ParsedMessage['role'] = raw === 'assistant' ? 'assistant' : 'user';
      out.push({
        role,
        content: text,
        ...(msg.create_time ? { createdAt: msg.create_time * 1000 } : {}),
        ...(c.title !== undefined ? { conversation: c.title } : {}),
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

interface InputEntry {
  path: string;
  format?: string;
}

/**
 * Expand input sources into concrete file entries, carrying each source's
 * explicit format into the directory expansion: `--claude some/dir` forces
 * the claude parser for every file inside, instead of losing the flag the
 * moment the directory entry is replaced by its children (which then fall
 * back to extension sniffing).
 */
function collectInputs(sources: InputEntry[]): InputEntry[] {
  const files: InputEntry[] = [];
  for (const src of sources) {
    if (!existsSync(src.path)) throw new Error(`input not found: ${src.path}`);
    const st = statSync(src.path);
    if (st.isDirectory()) {
      for (const f of readdirSync(src.path)) {
        // Parsers exist for md/json/jsonl/txt only — '.yaml' has no parser
        // and would silently fall through to the md parser with no yield.
        if (/\.(md|json|jsonl|txt)$/i.test(f)) {
          files.push({
            path: join(src.path, f),
            ...(src.format !== undefined ? { format: src.format } : {}),
          });
        }
      }
    } else {
      files.push({
        path: src.path,
        ...(src.format !== undefined ? { format: src.format } : {}),
      });
    }
  }
  return files;
}

// ----------------------------------------------------------------- wiring

const DEFAULT_DIMENSIONS = 1024;

/** MEMORY_PALACE_DIMS → a finite positive number, else the 1024 default
 *  with a warning — a typo'd env var degrades loudly, not silently. */
function dimensionsFromEnv(): number {
  const env = process.env['MEMORY_PALACE_DIMS'];
  if (env === undefined) return DEFAULT_DIMENSIONS; // unset → silent default
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `[palace-cli] invalid MEMORY_PALACE_DIMS="${env}" (must be a positive number), ` +
        `falling back to ${DEFAULT_DIMENSIONS}`,
    );
    return DEFAULT_DIMENSIONS;
  }
  return n;
}

/** FNV-1a 32-bit hash, hex-encoded (short stable suffixes). */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Stable per-conversation session id. A bare `conv:${title}`.slice(0, N)
 * makes long titles that share a prefix collapse into ONE session; the
 * hash32 suffix of the FULL distinguishing string keeps them apart. The
 * base is truncated BEFORE the hash is appended, so the hash suffix is
 * always present in full (a whole-string slice(0, 80) could cut into —
 * or entirely through — the suffix for long titles).
 */
function sessionIdFor(base: string): string {
  return `${base.slice(0, 64)}-${hash32(base)}`;
}

/**
 * Read a text file with any leading UTF-8 BOM stripped.
 *
 * PowerShell redirection (`> file.json`) writes a BOM by default; a BOM
 * welded to the first byte used to break format sniffing (the leading
 * \uFEFF made `text.trimStart().startsWith('{')` false) and leaked into
 * the first markdown heading. One strip point, applied to EVERY input
 * file, keeps all parsers BOM-blind.
 */
function readTextFile(file: string): string {
  const raw = readFileSync(file, 'utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** --topk → a positive integer, else the default of 5 with a warning —
 *  same degrade-loudly shape as dimensionsFromEnv (a typo'd flag value
 *  previously became NaN and died inside the retrieval SQL). */
function topKFromArgs(raw: string | undefined): number {
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(
      `[palace-cli] invalid --topk "${raw}" (must be a positive integer), ` +
        `falling back to 5`,
    );
    return 5;
  }
  return n;
}

function buildRuntime(dbPath: string) {
  // One read of the env var keeps the provider choice and the key value
  // paired even if the environment were somehow mutated between reads.
  const deepseekApiKey = process.env['DEEPSEEK_API_KEY'];
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    storagePath: dbPath,
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      provider: deepseekApiKey ? 'deepseek' : 'offline-bm25',
      ...(deepseekApiKey !== undefined ? { apiKey: deepseekApiKey } : {}),
      dimensions: dimensionsFromEnv(),
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
      scope: 'user',
      activeSpace,
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
      ivf: config.retrieval.ivf,
    },
    config.graph.enabled ? graph : undefined,
    NOOP_BUS,
  );
  // Same gate as the plugin/MCP entries: with the graph disabled the
  // ingestor must not feed a service that was never wired up.
  if (config.graph.enabled) ingestor.bindGraph(graph);
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
    if (v) inputs.push({ path: v, ...(format !== undefined ? { format } : {}) });
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // unreachable: i < args.length
    if (arg.startsWith('--')) {
      i++; // skip the flag's value
      continue;
    }
    inputs.push({ path: arg });
  }
  if (inputs.length === 0) {
    console.error('no inputs — pass --claude/--openai/--jsonl/--md <path> or bare paths');
    process.exitCode = 1;
    return;
  }

  const { store, ingestor, graph } = buildRuntime(db);
  // close() lives in finally, aligned with the drain-close discipline of
  // the MCP entry: a mid-ingest throw (bad JSON export, missing input,
  // failed embed) must not leave the SQLite handle open on the way out.
  // The inner try/catch tolerates an already-closed store (close() has no
  // idempotency guard of its own).
  try {
    const files = collectInputs(inputs);
    let messages = 0;
    let docs = 0;

    for (const entry of files) {
      const file = entry.path;
      const explicit = entry.format;
      const text = readTextFile(file);
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
          sessionId: m.conversation
            ? sessionIdFor(`conv:${m.conversation}`)
            : sessionIdFor(`file:${file}`),
          userId,
          ...(m.createdAt !== undefined ? { ts: m.createdAt } : {}),
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
  } finally {
    try {
      store.close();
    } catch {
      // already closed — nothing left to drain
    }
  }
}

async function cmdQuery(args: string[]): Promise<void> {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const db = get('--db') ?? './palace.db';
  const userId = get('--user') ?? 'cli-user';
  const topK = topKFromArgs(get('--topk'));
  const explain = args.includes('--explain');
  // Only value-carrying flags consume their successor; boolean flags like
  // --explain take no value, so the token right after them IS query text.
  // (Regression: skipping the successor of ANY '--' token made --explain
  // eat the first query word.)
  const VALUE_FLAGS = new Set(['--db', '--user', '--topk']);
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue; // unreachable: i < args.length
    if (a.startsWith('--')) continue;
    const prev = i > 0 ? args[i - 1] : undefined;
    if (prev !== undefined && VALUE_FLAGS.has(prev)) continue;
    parts.push(a);
  }
  const query = parts.join(' ');
  if (!query) {
    console.error('usage: palace-cli query --db p.db "query" [--topk N] [--explain]');
    process.exitCode = 1;
    return;
  }
  const { store, retriever } = buildRuntime(db);
  // Same drain-close discipline as cmdIngest: close on EVERY exit path.
  try {
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
  } finally {
    try {
      store.close();
    } catch {
      // already closed — nothing left to drain
    }
  }
}

function cmdStats(args: string[]): void {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const db = get('--db') ?? './palace.db';
  const { store, graph } = buildRuntime(db);
  // Same drain-close discipline as cmdIngest: close on EVERY exit path.
  try {
    const s = store.stats();
    console.log(JSON.stringify({ ...s, spaces: s.spaces, topEntities: graph.stats().topEntities.slice(0, 10) }, null, 2));
  } finally {
    try {
      store.close();
    } catch {
      // already closed — nothing left to drain
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'ingest') await cmdIngest(rest);
  else if (cmd === 'query') await cmdQuery(rest);
  else if (cmd === 'stats') cmdStats(rest);
  else {
    console.error('usage: palace-cli <ingest|query|stats> [flags] — see file header for examples');
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(String(e instanceof Error ? e.stack : e));
  process.exit(1);
});
