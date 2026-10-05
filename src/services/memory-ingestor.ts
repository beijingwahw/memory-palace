/**
 * MemoryIngestor — converts incoming events into structured memory items.
 *
 * Three ingest paths:
 *  1. message.user / message.assistant → episodic event + candidate semantic chunk
 *  2. tool.call / tool.result          → episodic event with tool context
 *  3. explicit memory_store tool call  → user-curated semantic item
 *
 * Importance is heuristically estimated from:
 *  - presence of explicit signals ("remember this", "important")
 *  - length (longer messages often carry more context)
 *  - tool error vs success
 *  - entity density (number of capitalized tokens)
 *
 * Graph integration: entity extraction runs on EVERY user/assistant
 * message (short ones included — the graph should see them even when the
 * chunker skips them), and each semantic item is linked to the most-often
 * mentioned entity that literally occurs in its chunk text. That link is
 * what lets retrieval apply the PageRank prior and the injector expand a
 * subgraph from real graph nodes.
 *
 * ## Two-phase ingest ("plan then commit")
 *
 * Every ingest path obeys ONE invariant: phase 1 embeds (network), phase 2
 * commits (single tx).
 *  - Phase 1 (plan) is pure computation plus the embedding round-trip:
 *    chunking, importance estimation, and ONE batched embedBatchTagged call
 *    covering every kept chunk text (a batch is served by a single space).
 *    No store writes happen here.
 *  - Phase 2 (commit) performs ALL writes for the ingest — event row,
 *    graph entity/edge upserts, per-chunk item inserts, event
 *    summarization — inside ONE store.ingestTx transaction: a single
 *    atomic commit, one WAL flush, and one coalesced graph-version stamp
 *    instead of dozens of autocommits. The graph's ingestEntities joins
 *    the outer transaction automatically (ingestTx nesting).
 *
 * The invariant is what keeps the SQLite write lock safe: a slow or hung
 * remote embedding gateway can never hold the transaction open, because
 * the network call is finished before the transaction begins.
 */

import { randomUUID } from 'node:crypto';
import type { EmbeddingGateway, TaggedEmbedding } from '../utils/embedding.js';
import { chunkText } from '../utils/chunker.js';
import { clamp01 } from '../utils/math.js';
import { truncateText } from '../utils/tokenizer.js';
import { tokenize, approximateTokenCount } from '../utils/tokenizer.js';
import {
  resolveWriteTier,
  tierForKind,
  type ScopeIdentity,
  type VisibilityTier,
} from '../utils/scope.js';
import type {
  MemoryItem,
  MemoryLayer,
  MemoryMetadata,
  MemoryScopeKind,
  EpisodicEvent,
} from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryGraph } from './memory-graph.js';

const REMEMBER_PATTERNS = [
  /remember (this|that|these)/i,
  /don't forget/i,
  /important[:\s]/i,
  /关键点?[:：]/,
  /记住[：:]/,
  /重要[:：]/,
];

export interface IngestMessageInput {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  sessionId: string;
  workspaceId?: string;
  userId?: string;
  toolName?: string;
  ts?: number;
}

export interface IngestToolInput {
  toolName: string;
  args: unknown;
  result: unknown;
  sessionId: string;
  workspaceId?: string;
  userId?: string;
  success?: boolean;
  ts?: number;
}

export class MemoryIngestor {
  private graphRef: MemoryGraph | null = null;

  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingGateway,
    private scopeKind: MemoryScopeKind = 'user',
  ) {}

  /** Attach a graph so entity extraction runs automatically on every ingest. */
  bindGraph(graph: MemoryGraph): void {
    this.graphRef = graph;
  }

  /** Resolve the write tier for this ingest (degrades when ids missing). */
  private tierFor(ids: ScopeIdentity, override?: VisibilityTier): VisibilityTier {
    return resolveWriteTier(override ?? tierForKind(this.scopeKind), ids);
  }

  /**
   * Record an episodic event and (optionally) distill it into semantic memory.
   *
   * Two-phase invariant: phase 1 embeds (network), phase 2 commits (single tx).
   */
  async ingestMessage(input: IngestMessageInput): Promise<{
    eventId: string;
    semanticIds: string[];
  }> {
    const ts = input.ts ?? Date.now();
    const eventId = randomUUID();
    const ids: ScopeIdentity = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    };
    const visibility = this.tierFor(ids);

    const ev: EpisodicEvent = {
      id: eventId,
      sessionId: input.sessionId,
      type: 'message',
      payload: {
        role: input.role,
        content: input.content,
        toolName: input.toolName,
      },
      ts,
    };

    // ---- Phase 1: plan (pure compute + network; ZERO store writes) --------
    // Only user/assistant messages of sufficient length become semantic
    // candidates; chunks under 16 tokens are skipped exactly as before.
    // Filtering BEFORE embedding means skipped chunks never cost a vector,
    // and every kept chunk text is embedded in ONE batched call — the whole
    // batch is served by a single space, so tagged[0].space describes every
    // vector in it. This round-trip must finish before the tx opens.
    const isSemanticCandidate =
      (input.role === 'user' || input.role === 'assistant') && input.content.length >= 32;
    const keptChunks = isSemanticCandidate
      ? chunkText(input.content, {
          maxTokens: 256,
          overlapTokens: 32,
          minTokens: 16,
        }).filter((c) => c.tokens >= 16)
      : [];
    const importance = isSemanticCandidate
      ? estimateImportance(input.content, input.role)
      : 0.5;
    const tagged: TaggedEmbedding[] =
      keptChunks.length > 0
        ? await this.embedder.embedBatchTagged(keptChunks.map((c) => c.text))
        : [];

    // ---- Phase 2: commit (ONE transaction) ---------------------------------
    // insertEvent + graph.ingestEntities + per-chunk insertItem +
    // markEventSummarized all run inside a single ingestTx: one atomic
    // commit instead of dozens of independent autocommits. The graph's
    // ingestEntities performs its own store writes but joins this outer
    // transaction via ingestTx nesting. Entity ids needed for chunk linkage
    // are captured from the tx callback's scope and its return value
    // carries the semantic item ids back out.
    const semanticIds: string[] = this.store.ingestTx((): string[] => {
      this.store.insertEvent(ev);

      // Entity extraction happens for EVERY user/assistant message, at the
      // message's visibility tier — private mentions create private entities.
      const entityNameById =
        this.graphRef && input.content
          ? this.resolveEntityNames(
              this.graphRef.ingestEntities(input.content, eventId, {
                ...ids,
                visibility,
              }),
            )
          : new Map<string, string>();

      const outIds: string[] = [];
      for (let i = 0; i < keptChunks.length; i++) {
        const chunk = keptChunks[i];
        const item = this.assembleItem({
          content: chunk.text,
          importance,
          embedding: tagged[i], // same space for the whole batch
          entityId: pickEntityForChunk(chunk.text, entityNameById, this.store),
          metadata: {
            source: 'session',
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            role: input.role,
            tokenCount: chunk.tokens,
            entities: [...entityNameById.values()],
            visibility,
          },
        });
        this.store.insertItem(item, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          sessionId: input.sessionId,
        });
        outIds.push(item.id);
      }
      if (outIds.length > 0) {
        this.store.markEventSummarized(eventId, outIds[0]);
      }
      return outIds;
    });
    return { eventId, semanticIds };
  }

  /**
   * Record a tool call as an episodic event; failures additionally become
   * semantic items. Two-phase invariant: phase 1 embeds (network), phase 2
   * commits (single tx).
   */
  async ingestToolCall(input: IngestToolInput): Promise<string> {
    const ts = input.ts ?? Date.now();
    const eventId = randomUUID();
    const ev: EpisodicEvent = {
      id: eventId,
      sessionId: input.sessionId,
      type: 'tool_call',
      payload: {
        toolName: input.toolName,
        args: input.args,
        success: input.success,
      },
      ts,
    };

    // ---- Phase 1: plan (network embed; ZERO store writes) -----------------
    // Only failures are distilled into semantic memory: they change future
    // behavior (avoid repeating the call), while successful results are
    // already reflected in the conversation itself. Single text → single
    // embedTagged, still strictly before the transaction opens.
    const item =
      input.success === false
        ? await this.makeSemanticItem({
            content: `Tool ${input.toolName} failed. ${truncateText(
              safeStringify(input.result).slice(0, 1024),
              400,
            )}`,
            importance: 0.7,
            metadata: {
              source: 'tool',
              sessionId: input.sessionId,
              workspaceId: input.workspaceId,
              userId: input.userId,
              toolName: input.toolName,
              tags: ['tool-error'],
              visibility: this.tierFor({
                userId: input.userId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
              }),
            },
          })
        : null;

    // ---- Phase 2: commit (ONE transaction) ---------------------------------
    this.store.ingestTx((): void => {
      this.store.insertEvent(ev);
      if (item) {
        this.store.insertItem(item, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          sessionId: input.sessionId,
        });
        this.store.markEventSummarized(eventId, item.id);
      }
    });
    return eventId;
  }

  /**
   * Explicit user-curated memory: "remember that the API key is in .env".
   * Event-less two-phase ingest: phase 1 embeds (network), phase 2 commits
   * the graph entities + item insert in ONE transaction.
   */
  async ingestUserMemory(input: {
    content: string;
    tags?: string[];
    importance?: number;
    sessionId?: string;
    workspaceId?: string;
    userId?: string;
    /** Visibility override (e.g. remember globally); defaults to scope kind. */
    visibility?: VisibilityTier;
  }): Promise<string> {
    const ids: ScopeIdentity = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    };
    const visibility = this.tierFor(ids, input.visibility);

    // ---- Phase 1: plan (network embed; ZERO store writes) -----------------
    const tagged = await this.embedder.embedTagged(input.content);

    // ---- Phase 2: commit (ONE transaction) ---------------------------------
    // Graph entity/edge upserts and the item insert share a single
    // ingestTx; the item id flows out of the tx callback's return value.
    return this.store.ingestTx((): string => {
      let entityId: string | undefined;
      if (this.graphRef && input.content) {
        const entIds = this.graphRef.ingestEntities(input.content, 'user-memory', {
          ...ids,
          visibility,
        });
        entityId = pickEntityForChunk(input.content, this.resolveEntityNames(entIds), this.store);
      }
      const item = this.assembleItem({
        content: input.content,
        importance: input.importance ?? 0.9,
        embedding: tagged,
        entityId,
        metadata: {
          source: 'user',
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          tags: input.tags ?? [],
          tokenCount: approximateTokenCount(input.content),
          visibility,
        },
      });
      this.store.insertItem(item, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        sessionId: input.sessionId,
      });
      return item.id;
    });
  }

  /** Map entity ids back to names (for chunk-level linkage). */
  private resolveEntityNames(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of ids) {
      const ent = this.store.getEntity(id);
      if (ent) out.set(id, ent.name);
    }
    return out;
  }

  /**
   * Assemble a MemoryItem from a pre-computed space-tagged embedding (the
   * output of phase 1). Synchronous BY DESIGN: it must be callable inside
   * the phase-2 transaction without any network I/O. The space tag is
   * stamped into metadata.embeddingSpace so retrieval never compares
   * vectors across spaces.
   */
  private assembleItem(opts: {
    content: string;
    importance: number;
    metadata: MemoryMetadata;
    embedding: TaggedEmbedding;
    entityId?: string;
    layer?: MemoryLayer;
  }): MemoryItem {
    const now = Date.now();
    return {
      id: randomUUID(),
      layer: opts.layer ?? 'semantic',
      content: opts.content,
      embedding: opts.embedding.vector,
      metadata: { ...opts.metadata, embeddingSpace: opts.embedding.space },
      createdAt: now,
      updatedAt: now,
      importance: clamp01(opts.importance),
      accessCount: 0,
      lastAccessedAt: now,
      entityId: opts.entityId,
    };
  }

  /**
   * Single-embed path (tool-failure items): embeds one text then assembles.
   * Batched paths must NOT use this — they embed in phase 1 via
   * embedBatchTagged / embedTagged and call assembleItem directly so the
   * remote round-trip stays outside the transaction.
   */
  private async makeSemanticItem(opts: {
    content: string;
    importance: number;
    metadata: MemoryMetadata;
    entityId?: string;
    layer?: MemoryLayer;
  }): Promise<MemoryItem> {
    return this.assembleItem({
      ...opts,
      embedding: await this.embedder.embedTagged(opts.content),
    });
  }
}

/**
 * Pick the entity that best represents a chunk: among entities whose name
 * literally occurs in the chunk text, the one with the highest mention
 * count (most-established concept wins).
 */
function pickEntityForChunk(
  chunkText: string,
  entityNameById: Map<string, string>,
  store: MemoryStore,
): string | undefined {
  let bestId: string | undefined;
  let bestMentions = -1;
  for (const [id, name] of entityNameById) {
    if (!name || !chunkText.includes(name)) continue;
    const ent = store.getEntity(id);
    const mentions = ent?.mentionCount ?? 0;
    if (mentions > bestMentions) {
      bestMentions = mentions;
      bestId = id;
    }
  }
  return bestId;
}

function estimateImportance(content: string, role: 'user' | 'assistant' | 'tool' | 'system'): number {
  let score = 0.5;
  for (const re of REMEMBER_PATTERNS) {
    if (re.test(content)) score += 0.25;
  }
  // length bonus (caps at 0.15)
  score += Math.min(0.15, content.length / 4000);
  // entity density
  const toks = tokenize(content);
  const caps = toks.filter((t) => /^[A-Z]/.test(t)).length;
  score += Math.min(0.1, caps / 50);
  // assistant replies are less important than user statements by default
  if (role === 'assistant') score -= 0.05;
  return clamp01(score);
}

function safeStringify(x: unknown): string {
  try {
    return typeof x === 'string' ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}

