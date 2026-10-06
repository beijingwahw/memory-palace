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
import { invariant } from '../utils/invariants.js';
import { truncateText } from '../utils/tokenizer.js';
import { tokenize, approximateTokenCount } from '../utils/tokenizer.js';
import {
  applyAnonymousWritePolicy,
  resolveWriteTier,
  tierForKind,
  type AnonymousWritePolicy,
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
  // Word-boundary match: "unimportant." must NOT earn the explicit-signal
  // bonus (there is no \b between "un" and "important"), while a genuine
  // "important." still hits (boundary before the period).
  /\bimportant\b/i,
  /关键点?[:：]/,
  /记住[：:]/,
  /重要[:：]/,
];

/**
 * CJK code blocks (Han ext-A/BMP, kana, hangul jamo+syllables, CJK compat
 * ideographs): caseless scripts, excluded from the uppercase-density
 * heuristic's numerator AND denominator — East-Asian text has no case.
 */
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

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

  /**
   * @param anonymousPolicy Tri-state policy for writes carrying NO owner
   *   id at all (see applyAnonymousWritePolicy in utils/scope.ts).
   *   Default 'global' reproduces the historical behavior exactly:
   *   anonymous writes degrade to the global shared bucket.
   */
  constructor(
    private store: MemoryStore,
    private embedder: EmbeddingGateway,
    private scopeKind: MemoryScopeKind = 'user',
    private anonymousPolicy: AnonymousWritePolicy = 'global',
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
    // Empty (or whitespace-only) content is dropped whole: no episodic
    // event row, no semantic items. Event-log noise from empty frames used
    // to accumulate as unsummarized rows nothing could ever retrieve.
    // The empty eventId tells callers "nothing was written".
    if (input.content.trim() === '') {
      return { eventId: '', semanticIds: [] };
    }
    const ts = input.ts ?? Date.now();
    const eventId = randomUUID();
    // ANONYMOUS-WRITE POLICY BOUNDARY: the identity every downstream write
    // attributes — episodic event owner, item owner columns, metadata,
    // graph scope — is the POLICY-CONVERTED identity. Under the default
    // 'global' policy (and for any identified caller, under any policy)
    // this is the very same fields as before, byte-for-byte the
    // historical write. 'quarantine' rewrites a no-id-at-all identity to
    // the '__anonymous__' isolation session (which resolveWriteTier then
    // narrows to the session tier). 'reject' throws HERE — before the
    // embedding round-trip and before any store write — so the caller can
    // drop the whole message atomically.
    const ids: ScopeIdentity = applyAnonymousWritePolicy(
      {
        // exactOptionalPropertyTypes: absent ids are omitted, not bound as
        // explicit undefined — every consumer reads by access (?? / truthy).
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        sessionId: input.sessionId,
      },
      this.anonymousPolicy,
    );
    const visibility = this.tierFor(ids);

    const ev: EpisodicEvent = {
      id: eventId,
      sessionId: ids.sessionId ?? input.sessionId,
      type: 'message',
      payload: {
        role: input.role,
        content: input.content,
        toolName: input.toolName,
      },
      ts,
    };

    // ---- Phase 1: plan (pure compute + network; ZERO store writes) --------
    // Only user/assistant messages become semantic candidates, gated on
    // TOKENS alone (chunker minTokens=16 already drops thin input). The
    // old content.length >= 32 CHARACTER gate discriminated against CJK
    // text — 32 chars is a full paragraph in Chinese — so the gate is now
    // uniformly token-based for zh and en alike.
    // Filtering BEFORE embedding means skipped chunks never cost a vector,
    // and every kept chunk text is embedded in ONE batched call — the whole
    // batch is served by a single space, so tagged[0].space describes every
    // vector in it. This round-trip must finish before the tx opens.
    const isSemanticCandidate = input.role === 'user' || input.role === 'assistant';
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
    // Tagged-batch contract guard: a mismatched length would silently
    // misalign vectors with chunk texts (chunk i embedding chunk j).
    if (tagged.length !== keptChunks.length) {
      throw new Error('embedding gateway violated batch contract');
    }

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

      // Entity extraction happens for user/assistant messages ONLY (the
      // same role gate as semantic candidacy), at the message's visibility
      // tier — private mentions create private entities. System frames
      // carry housekeeping prose, not the user's world model: letting them
      // mint entities would pollute the graph with platform vocabulary.
      const entityNameById =
        this.graphRef && input.content && isSemanticCandidate
          ? this.resolveEntityNames(
              this.graphRef.ingestEntities(input.content, {
                ...ids,
                visibility,
              }),
            )
          : new Map<string, string>();

      const outIds: string[] = [];
      for (let i = 0; i < keptChunks.length; i++) {
        const chunk = keptChunks[i];
        invariant(chunk !== undefined, 'loop index is below keptChunks.length');
        const tag = tagged[i];
        invariant(tag !== undefined, 'tagged length equals keptChunks.length (batch contract checked above)');
        // Hoisted so the optional link can be spread (exactOptionalPropertyTypes).
        const entityId = pickEntityForChunk(chunk.text, entityNameById, this.store);
        const item = this.assembleItem({
          content: chunk.text,
          importance,
          embedding: tag, // same space for the whole batch
          ...(entityId !== undefined ? { entityId } : {}),
          metadata: {
            source: 'session',
            // Reverse reference: EVERY chunk traces back to its episodic
            // event (previously only outIds[0] was linked via
            // markEventSummarized, leaving the other chunks without a
            // traceback path).
            eventId: ev.id,
            // exactOptionalPropertyTypes: owner ids absent from this write
            // are omitted, never bound as explicit undefined.
            ...(ids.sessionId !== undefined ? { sessionId: ids.sessionId } : {}),
            ...(ids.workspaceId !== undefined ? { workspaceId: ids.workspaceId } : {}),
            ...(ids.userId !== undefined ? { userId: ids.userId } : {}),
            role: input.role,
            tokenCount: chunk.tokens,
            // Entities that ACTUALLY occur in this chunk (message-level
            // list filtered by chunk text, case-insensitive). When none
            // occur, empty is more honest than the full message list.
            entities: chunkEntities(chunk.text, entityNameById),
            visibility,
          },
        });
        this.store.insertItem(item, {
          ...(ids.workspaceId !== undefined ? { workspaceId: ids.workspaceId } : {}),
          ...(ids.userId !== undefined ? { userId: ids.userId } : {}),
          ...(ids.sessionId !== undefined ? { sessionId: ids.sessionId } : {}),
        });
        outIds.push(item.id);
      }
      if (outIds.length > 0) {
        const firstId = outIds[0];
        invariant(firstId !== undefined, 'outIds is non-empty, so its first id exists');
        this.store.markEventSummarized(eventId, firstId);
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
    // Same anonymous-write policy boundary as ingestMessage (see there);
    // 'reject' throws before the embed and before the event insert.
    const ids: ScopeIdentity = applyAnonymousWritePolicy(
      {
        // exactOptionalPropertyTypes: same omit-don't-bind rule as ingestMessage.
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        sessionId: input.sessionId,
      },
      this.anonymousPolicy,
    );
    const ts = input.ts ?? Date.now();
    const eventId = randomUUID();
    const ev: EpisodicEvent = {
      id: eventId,
      sessionId: ids.sessionId ?? input.sessionId,
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
              // Reverse reference, same contract as the message path: the
              // failure item traces back to its tool_call episodic event.
              eventId: ev.id,
              // exactOptionalPropertyTypes: owner ids absent from this write
              // are omitted, never bound as explicit undefined.
              ...(ids.sessionId !== undefined ? { sessionId: ids.sessionId } : {}),
              ...(ids.workspaceId !== undefined ? { workspaceId: ids.workspaceId } : {}),
              ...(ids.userId !== undefined ? { userId: ids.userId } : {}),
              toolName: input.toolName,
              tags: ['tool-error'],
              visibility: this.tierFor(ids),
            },
          })
        : null;

    // ---- Phase 2: commit (ONE transaction) ---------------------------------
    this.store.ingestTx((): void => {
      this.store.insertEvent(ev);
      if (item) {
        this.store.insertItem(item, {
          ...(ids.workspaceId !== undefined ? { workspaceId: ids.workspaceId } : {}),
          ...(ids.userId !== undefined ? { userId: ids.userId } : {}),
          ...(ids.sessionId !== undefined ? { sessionId: ids.sessionId } : {}),
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
    /**
     * Skip graph entity extraction for this entry. Derived entries (the
     * Inferencer's "Inferred (78%): Aurora —depends-on→ …" statements)
     * restate entity names as BRAND WORDS inside a template; ingesting
     * them would pollute the graph every night with template vocabulary
     * ("Inferred") and re-stamp mention counts for entities the user
     * never actually mentioned in this sentence.
     */
    skipGraph?: boolean;
    /**
     * Metadata source stamp. Defaults to 'user'; the Inferencer passes
     * 'inferred' so derived rows are distinguishable from user-curated
     * ones by metadata alone, not only by their tags.
     */
    source?: MemoryMetadata['source'];
  }): Promise<string> {
    // Same anonymous-write policy boundary as ingestMessage (see there);
    // 'reject' throws before the embed and before any store write. This
    // entrance is also how the Stratifier digests, Inferencer derived
    // facts and the remember/capsule tools inherit the policy — they all
    // write through here.
    const ids: ScopeIdentity = applyAnonymousWritePolicy(
      {
        // exactOptionalPropertyTypes: all three ids are optional on this
        // entrance — absent ones are omitted, never bound as undefined.
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      },
      this.anonymousPolicy,
    );
    const visibility = this.tierFor(ids, input.visibility);

    // ---- Phase 1: plan (network embed; ZERO store writes) -----------------
    const tagged = await this.embedder.embedTagged(input.content);

    // ---- Phase 2: commit (ONE transaction) ---------------------------------
    // Graph entity/edge upserts and the item insert share a single
    // ingestTx; the item id flows out of the tx callback's return value.
    return this.store.ingestTx((): string => {
      let entityId: string | undefined;
      if (this.graphRef && input.content && !input.skipGraph) {
        const entIds = this.graphRef.ingestEntities(input.content, {
          ...ids,
          visibility,
        });
        entityId = pickEntityForChunk(input.content, this.resolveEntityNames(entIds), this.store);
      }
      const item = this.assembleItem({
        content: input.content,
        importance: input.importance ?? 0.9,
        embedding: tagged,
        // exactOptionalPropertyTypes: no link means no key, not a bound undefined.
        ...(entityId !== undefined ? { entityId } : {}),
        metadata: {
          source: input.source ?? 'user',
          // exactOptionalPropertyTypes: owner ids absent from this write
          // are omitted, never bound as explicit undefined.
          ...(ids.sessionId !== undefined ? { sessionId: ids.sessionId } : {}),
          ...(ids.workspaceId !== undefined ? { workspaceId: ids.workspaceId } : {}),
          ...(ids.userId !== undefined ? { userId: ids.userId } : {}),
          tags: input.tags ?? [],
          tokenCount: approximateTokenCount(input.content),
          visibility,
        },
      });
      this.store.insertItem(item, {
        ...(ids.workspaceId !== undefined ? { workspaceId: ids.workspaceId } : {}),
        ...(ids.userId !== undefined ? { userId: ids.userId } : {}),
        ...(ids.sessionId !== undefined ? { sessionId: ids.sessionId } : {}),
      });
      return item.id;
    });
  }

  /** Map entity ids back to names (for chunk-level linkage). */
  private resolveEntityNames(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of ids) {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- id-keyed read of entities THIS ingestor just wrote at its own tier; the scoped replacements (findEntityAtTier / findEntityInScope) are name-keyed and the store has no id-keyed scoped read, so a migration would change behavior.
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
      // exactOptionalPropertyTypes: no link means no key, not a bound undefined.
      ...(opts.entityId !== undefined ? { entityId: opts.entityId } : {}),
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

/** Regex-escape a literal for embedding into a dynamic pattern. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive occurrence test with word boundaries for pure-ASCII
 * entity names — the same yardstick pickEntityForChunk and chunkEntities
 * share (and the same style as namePresent in utils/inference.ts). A bare
 * substring match would chain a short English name into unrelated common
 * words: the entity "May" must not hit "this may be delayed". Identifier
 * lookarounds on ASCII names prevent that; names carrying other-script
 * characters (Han, mixed-script like "K8s集群") keep plain `includes` —
 * CJK text has no [\w] class for synthetic boundaries to bite on, Han
 * runs are their own boundary.
 */
function nameOccurs(text: string, name: string): boolean {
  if (!/^[\x20-\x7E]+$/.test(name)) return text.includes(name);
  return new RegExp(
    `(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`,
    'i',
  ).test(text);
}

/**
 * Pick the entity that best represents a chunk: among entities whose name
 * occurs in the chunk text (case-insensitive with identifier word
 * boundaries for ASCII names — the same yardstick chunkEntities uses, so
 * a chunk whose text spells "kafka" still links to the "Kafka" entity),
 * the one with the highest mention count (most-established concept wins).
 */
function pickEntityForChunk(
  chunkText: string,
  entityNameById: Map<string, string>,
  store: MemoryStore,
): string | undefined {
  let bestId: string | undefined;
  let bestMentions = -1;
  for (const [id, name] of entityNameById) {
    if (!name || !nameOccurs(chunkText, name)) continue;
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- id-keyed mention-count read of entities the ingestor itself just resolved from its own scoped ingest; the scoped equivalents are name-keyed, so a migration would change behavior.
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
  // Explicit-signal bonus is BOOLEAN: any pattern hit adds +0.25 exactly
  // once ("important" AND "remember this" is not twice as important).
  if (REMEMBER_PATTERNS.some((re) => re.test(content))) score += 0.25;
  // length bonus (caps at 0.15)
  score += Math.min(0.15, content.length / 4000);
  // Uppercase density — a Latin-script signal only. CJK characters carry
  // no case, so they are excluded from BOTH the numerator and the
  // denominator: a mostly-Chinese message with a few English entity
  // names still earns density credit proportional to its Latin content,
  // instead of being diluted by (or diluting) caseless text.
  const toks = tokenize(content);
  const latinToks = toks.filter((t) => !CJK_RE.test(t));
  const caps = latinToks.filter((t) => /^[A-Z]/.test(t)).length;
  score += Math.min(0.1, caps / Math.max(1, latinToks.length));
  // assistant replies are less important than user statements by default
  if (role === 'assistant') score -= 0.05;
  return clamp01(score);
}

/**
 * Entity names that literally occur in a chunk (case-insensitive, with
 * identifier word boundaries for ASCII names — see nameOccurs): the
 * per-chunk metadata field describes the chunk's OWN content. When none
 * of the message's entities occur in this chunk, an empty list is more
 * honest than the full message-level list — precision over recall.
 */
function chunkEntities(text: string, entityNameById: Map<string, string>): string[] {
  const out: string[] = [];
  for (const name of entityNameById.values()) {
    if (name && nameOccurs(text, name)) out.push(name);
  }
  return out;
}

function safeStringify(x: unknown): string {
  try {
    return typeof x === 'string' ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}

