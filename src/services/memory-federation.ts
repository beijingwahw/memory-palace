/**
 * MemoryFederation — executes capsule export/import against this palace.
 *
 * Export walks only memories visible at the caller's scope (the ACL is
 * the export boundary — you can never ship what you cannot see) and
 * strips all owner identity. Import verifies the capsule signature,
 * plans via the pure planner (dedupe by deterministic content ids,
 * contradiction flags), then lands items at the IMPORTER's chosen
 * visibility tier with the importer's ownership — rehydrating entities
 * from names so palace-local graph ids never cross the boundary.
 */

import { randomUUID } from 'node:crypto';
import {
  capsuleEmbedding,
  normalizedContent,
  parseCapsule,
  planImport,
  signCapsule,
  toCapsuleItem,
  verifyCapsule,
  type CapsulePattern,
  type ImportPlan,
  type MemoryCapsule,
} from '../utils/capsule.js';
import { scopeLevels, resolveWriteTier, widestLevel, type ScopeLevelClause, type VisibilityTier } from '../utils/scope.js';
import type { EmbeddingGateway } from '../utils/embedding.js';
import { approximateTokenCount } from '../utils/tokenizer.js';
import type { MemoryEventBus, MemoryItem, MemoryMetadata, MemoryScopeKind } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryGraph } from './memory-graph.js';
import type { MemoryRetriever } from './memory-retriever.js';

/** Legal metadata.source values — a wire-supplied capsule source outside
 *  this set is replaced by the 'import' provenance marker (see
 *  executeImport). */
const LEGAL_ITEM_SOURCES: ReadonlySet<string> = new Set([
  'session',
  'tool',
  'user',
  'system',
  'inferred',
]);

export interface ExportQuery {
  /** Export memories matching a semantic query (retriever-driven). */
  query?: string;
  /** Export everything linked to one entity name. */
  entity?: string;
  /** Export scope: all items visible at the caller's widest level. */
  all?: boolean;
  topK?: number;
  secret?: string;
  palaceId: string;
  scope: { userId?: string; workspaceId?: string; sessionId?: string };
}

export interface ImportOptions {
  capsuleJson: string;
  /** Shared secret; required when the capsule is signed. */
  secret?: string;
  /** Tier for imported items (default 'global' — capsules are shared
   *  knowledge by intent; bind tighter only with care). */
  visibility?: VisibilityTier;
  /** Import conflict-flagged items too (they are otherwise skipped). */
  force?: boolean;
  /** Freshness bound (ms) enforced at parse time: a capsule exported
   *  longer than this ago is rejected before any planning touches the
   *  store — anti-replay for stale knowledge. Omitted → no check. */
  maxAgeMs?: number;
  scope: { userId?: string; workspaceId?: string; sessionId?: string };
}

export interface ImportReport {
  inserted: number;
  duplicates: number;
  conflictsFlagged: number;
  conflictsImported: number;
  entitiesRehydrated: number;
  patternsImported: number;
  palaceId: string;
  exportedAt: number;
  /** Non-fatal import degradations (e.g. items stored without embeddings
   *  after the backfill embed failed). Present only when non-empty. */
  warnings?: string[];
  plan: {
    toInsert: number;
    duplicates: Array<{ id: string; contentPreview: string }>;
    conflicts: Array<{
      capsulePreview: string;
      existingPreview: string;
      reason: string;
    }>;
  };
}

export class MemoryFederation {
  constructor(
    private store: MemoryStore,
    private graph: MemoryGraph,
    private retriever: MemoryRetriever,
    private scopeKind: MemoryScopeKind = 'user',
    private bus: MemoryEventBus = NOOP_BUS,
    /** Optional embedding gateway: lets executeImport backfill vectors for
     *  capsule items that arrived without one (otherwise they land
     *  permanently unretrievable — no vector, no scan hit, ever). */
    private gateway?: EmbeddingGateway,
  ) {}

  private levelFor(scope: ExportQuery['scope'] | ImportOptions['scope']): ScopeLevelClause {
    return widestLevel(scopeLevels(this.scopeKind, scope));
  }

  /** Build (and optionally sign) a capsule from this palace. */
  async exportCapsule(q: ExportQuery): Promise<{ capsule: MemoryCapsule; json: string }> {
    const level = this.levelFor(q.scope);
    // NaN topK (malformed tool payload) must not reach the SQL LIMIT.
    const topK =
      q.topK !== undefined && Number.isFinite(q.topK) ? q.topK : undefined;
    let items: MemoryItem[] = [];
    if (q.query) {
      const res = await this.retriever.retrieve({
        query: q.query,
        // exactOptionalPropertyTypes: a non-finite topK must OMIT the key,
        // not bind an explicit undefined (RetrievalQuery.topK?: number).
        ...(topK !== undefined ? { topK } : {}),
        scope: q.scope,
      });
      items = res.hits.map((h) => h.item);
    } else if (q.entity) {
      const ent = this.store.findEntityInScope(q.entity, scopeLevels(this.scopeKind, q.scope));
      if (!ent) throw new Error(`entity "${q.entity}" not found in your scope`);
      items = this.store.itemsForEntityScoped(level, ent.id, topK ?? 50);
    } else if (q.all) {
      items = this.store.listItemsByLayerScoped('semantic', level, topK ?? 200);
    } else {
      throw new Error('provide one of: query, entity, or all');
    }

    const capsule: MemoryCapsule = {
      magic: 'dsh-memory-capsule',
      version: 1,
      palaceId: q.palaceId,
      exportedAt: Date.now(),
      items: items.map(toCapsuleItem),
      patterns: this.store
        .listPatternsScoped(level)
        .slice(0, 25)
        .map<CapsulePattern>((p) => ({
          pattern: p.pattern,
          description: p.description,
          confidence: p.confidence,
          evidenceCount: p.evidence.length,
        })),
    };
    const signed = q.secret ? signCapsule(capsule, q.secret) : capsule;
    this.bus.emit('memory.capsule-exported', {
      palaceId: q.palaceId,
      items: signed.items.length,
      patterns: signed.patterns.length,
      signed: Boolean(q.secret),
    });
    return { capsule: signed, json: JSON.stringify(signed) };
  }

  /** Verify + plan an import without touching the store. */
  async planImportFromJson(
    opts: ImportOptions,
  ): Promise<{ capsule: MemoryCapsule; plan: ImportPlan }> {
    // Freshness is enforced at the parse boundary when the importer asked
    // for it: an over-age (replayed) capsule throws here, before signature
    // work, dedupe scans or similarity probes spend anything on it.
    // An omitted maxAgeMs inside parseCapsule means "no check", so the
    // default ImportOptions path is byte-for-byte backwards compatible.
    const capsule = parseCapsule(
      opts.capsuleJson,
      // exactOptionalPropertyTypes: omit rather than bind undefined —
      // parseCapsule reads the property only by access, never by presence.
      opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {},
    );
    if (capsule.signature) {
      if (!opts.secret) throw new Error('capsule is signed: provide the shared secret');
      if (!verifyCapsule(capsule, opts.secret)) {
        throw new Error('capsule signature mismatch (tampered?)');
      }
    }
    // Dedupe is SCOPED to the importer (widest cascade of their levels):
    // the same content held by ANOTHER user at a tier this importer cannot
    // see must not silently block their import. Content is normalized
    // before the lookup — the same rule the capsule-side planner uses.
    const level = this.levelFor(opts.scope);
    const existsScoped = (content: string): boolean =>
      this.store.findItemIdsByContentScoped(level, content).length > 0;
    // Belt & braces, both directions: a legacy store may hold the same
    // fact under its RAW text (irregular whitespace predating
    // normalization), and a capsule only ever carries ONE spelling — you
    // cannot reconstruct the other spelling from it. So exact probes cover
    // both spellings the capsule KNOWS, and a one-shot normalized index of
    // the importer's visible items covers the spelling it cannot know.
    // Imports are rare and bounded; the bounded scan is the honest price
    // of a whitespace-insensitive duplicate verdict.
    const duplicate = new Map<string, boolean>();
    const normalizedIndex = new Set<string>();
    for (const layer of ['episodic', 'semantic', 'procedural'] as const) {
      for (const row of this.store.listItemsByLayerScoped(layer, level, 2000)) {
        normalizedIndex.add(normalizedContent(row.content));
      }
    }
    for (const item of capsule.items) {
      const norm = normalizedContent(item.content);
      if (duplicate.has(norm)) continue;
      duplicate.set(
        norm,
        normalizedIndex.has(norm) ||
          existsScoped(norm) ||
          (norm !== item.content && existsScoped(item.content)),
      );
    }
    // Pre-warm similarity probes: the pure planner is synchronous, the
    // retriever is async — probe each non-duplicate capsule item once,
    // scoped to the importer, then hand the results to the planner.
    // speculative: planning is read-only bookkeeping — these probes must
    // not touchAccess/logQuery and thereby pollute decay counters and the
    // intent trajectory with "queries" nobody actually asked.
    const probes = new Map<string, Array<{ id: string; content: string; similarity: number }>>();
    for (const item of capsule.items) {
      if (duplicate.get(normalizedContent(item.content))) continue;
      const res = await this.retriever.retrieve({
        query: item.content,
        topK: 3,
        minScore: 0.75,
        scope: opts.scope,
        speculative: true,
      });
      probes.set(
        normalizedContent(item.content),
        res.hits.map((h) => ({ id: h.item.id, content: h.item.content, similarity: h.rawScore })),
      );
    }
    const plan = planImport(
      capsule,
      (content) => duplicate.get(normalizedContent(content)) ?? existsScoped(content),
      (content) => probes.get(normalizedContent(content)) ?? [],
    );
    return { capsule, plan };
  }

  /** Execute a planned import. */
  async executeImport(
    capsule: MemoryCapsule,
    plan: ImportPlan,
    opts: ImportOptions,
  ): Promise<ImportReport> {
    // GHOST-ROW FIX: the requested tier goes through the same write-time
    // resolver every other write path uses. Importing at 'user' without a
    // userId (or 'workspace'/'session' without the matching owner id)
    // used to persist visibility='user' with a NULL owner column — a row
    // no cascade level can ever match: invisible to everyone forever,
    // yet still counted in stats and scans' candidate pools.
    const tier = resolveWriteTier(opts.visibility ?? 'global', opts.scope);
    const targets = [...plan.toInsert, ...(opts.force ? plan.conflictOnly : [])];

    // ---- Phase 1: plan (network embeds; ZERO store writes) -----------------
    // A capsule item without a serialized embedding would land permanently
    // unretrievable (no vector ⇒ invisible to the similarity path). When a
    // gateway is wired, backfill its vector now — OUTSIDE any transaction,
    // per the palace-wide two-phase ingest invariant. An embed failure
    // (failover exhausted, degraded provider) degrades to a vector-less
    // row but is recorded in the report instead of silently shipping an
    // unfindable memory.
    const warnings: string[] = [];
    const prepared = targets.map((cap) => ({
      cap,
      embedding: capsuleEmbedding(cap),
      space: cap.embedding?.space,
    }));
    if (this.gateway) {
      for (const p of prepared) {
        if (p.embedding) continue;
        try {
          const tagged = await this.gateway.embedTagged(p.cap.content);
          p.embedding = tagged.vector;
          p.space = tagged.space;
        } catch (err) {
          warnings.push(
            `item ${p.cap.id} stored without an embedding (backfill embed failed: ${String(err)})`,
          );
        }
      }
    }
    // No gateway wired (bare programmatic constructions): behavior is
    // unchanged — a vector-less capsule item imports vector-less.

    // ---- Phase 2: commit (ONE transaction) ---------------------------------
    // Entities, items AND patterns land inside a single ingestTx: a
    // failure mid-import can no longer strand a half-imported capsule
    // (some items in, the rest silently missing).
    let inserted = 0;
    let entitiesRehydrated = 0;
    let patternsImported = 0;
    this.store.ingestTx((): void => {
      for (const { cap, embedding, space } of prepared) {
        const now = Date.now();
        // Rehydrate the entity graph from NAMES under the importer's scope;
        // the multi-entity aggregation of retrieval resolves names at query
        // time, so a linked entityId is optional here.
        if (cap.entities.length > 0) {
          // REHYDRATE-FROM-NAMES: the capsule's entity manifest is the
          // authoritative set the exporter chose to share. Feed the
          // extractor ONLY the name list (one name per line) — never the
          // item content: content routinely mentions entities that are NOT
          // in the manifest, and extracting from it would build entities
          // the exporter never shared, polluting the importer's graph.
          const ids = this.graph.ingestEntities(
            cap.entities.join('\n'),
            { ...opts.scope, visibility: tier },
          );
          entitiesRehydrated += ids.length;
        }
        // Provenance: keep the exporter's source stamp when it is a legal
        // enum value; anything else on the wire becomes 'import'. ('import'
        // is an informational marker outside the closed TS union in
        // types/index.ts — metadata.source is free text at runtime and
        // nothing branches on it, so the marker needs no enum change.)
        const source: MemoryMetadata['source'] = LEGAL_ITEM_SOURCES.has(cap.source)
          ? cap.source
          : ('import' as unknown as MemoryMetadata['source']);
        this.store.insertItem(
          {
            id: randomUUID(),
            layer: cap.layer,
            content: cap.content,
            // exactOptionalPropertyTypes: a vector-less capsule item omits
            // the key rather than binding an explicit undefined.
            ...(embedding !== undefined ? { embedding } : {}),
            metadata: {
              source,
              // exactOptionalPropertyTypes: owner keys are omitted when the
              // importer has no such id (undefined bindings are rejected).
              ...(opts.scope.userId !== undefined ? { userId: opts.scope.userId } : {}),
              ...(opts.scope.workspaceId !== undefined ? { workspaceId: opts.scope.workspaceId } : {}),
              ...(opts.scope.sessionId !== undefined ? { sessionId: opts.scope.sessionId } : {}),
              tags: [...cap.tags, 'capsule'],
              entities: cap.entities,
              tokenCount: approximateTokenCount(cap.content),
              ...(embedding && space !== undefined ? { embeddingSpace: space } : {}),
              visibility: tier,
            },
            createdAt: cap.createdAt,
            updatedAt: now,
            importance: cap.importance,
            accessCount: 0,
            lastAccessedAt: now,
            visibility: tier,
          },
          {
            ...(opts.scope.userId !== undefined ? { userId: opts.scope.userId } : {}),
            ...(opts.scope.workspaceId !== undefined ? { workspaceId: opts.scope.workspaceId } : {}),
            ...(opts.scope.sessionId !== undefined ? { sessionId: opts.scope.sessionId } : {}),
          },
        );
        inserted++;
      }

      for (const p of capsule.patterns) {
        this.store.upsertPattern(
          {
            id: `cap:${p.pattern}`,
            pattern: p.pattern,
            description: p.description,
            evidence: [],
            confidence: p.confidence,
            createdAt: Date.now(),
          },
          { ...opts.scope, visibility: tier },
        );
        patternsImported++;
      }
    });

    const report: ImportReport = {
      inserted,
      duplicates: plan.duplicates.length,
      conflictsFlagged: plan.conflicts.length,
      conflictsImported: opts.force ? plan.conflictOnly.length : 0,
      entitiesRehydrated,
      patternsImported,
      palaceId: capsule.palaceId,
      exportedAt: capsule.exportedAt,
      ...(warnings.length > 0 ? { warnings } : {}),
      plan: {
        toInsert: plan.toInsert.length,
        duplicates: plan.duplicates.slice(0, 5).map((d) => ({
          id: d.id,
          contentPreview: d.content.slice(0, 100),
        })),
        conflicts: plan.conflicts.slice(0, 5).map((c) => ({
          capsulePreview: c.capsuleContent.slice(0, 100),
          existingPreview: c.existingContent.slice(0, 100),
          reason: c.reason,
        })),
      },
    };
    this.bus.emit('memory.capsule-imported', {
      palaceId: capsule.palaceId,
      inserted,
      conflicts: plan.conflicts.length,
      visibility: tier,
    });
    return report;
  }

  /** One-shot import: plan then execute. */
  async importCapsule(opts: ImportOptions): Promise<ImportReport> {
    const { capsule, plan } = await this.planImportFromJson(opts);
    return this.executeImport(capsule, plan, opts);
  }
}

