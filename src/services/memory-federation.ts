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
import { scopeLevels, widestLevel, type ScopeLevelClause, type VisibilityTier } from '../utils/scope.js';
import type { MemoryEventBus, MemoryItem, MemoryScopeKind } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryGraph } from './memory-graph.js';
import type { MemoryRetriever } from './memory-retriever.js';

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
  ) {}

  private levelFor(scope: ExportQuery['scope'] | ImportOptions['scope']): ScopeLevelClause {
    return widestLevel(scopeLevels(this.scopeKind, scope ?? {}));
  }

  /** Build (and optionally sign) a capsule from this palace. */
  async exportCapsule(q: ExportQuery): Promise<{ capsule: MemoryCapsule; json: string }> {
    const level = this.levelFor(q.scope);
    let items: MemoryItem[] = [];
    if (q.query) {
      const res = await this.retriever.retrieve({
        query: q.query,
        topK: q.topK ?? 20,
        scope: q.scope,
      });
      items = res.hits.map((h) => h.item);
    } else if (q.entity) {
      const ent = this.store.findEntityInScope(q.entity, scopeLevels(this.scopeKind, q.scope ?? {}));
      if (!ent) throw new Error(`entity "${q.entity}" not found in your scope`);
      items = this.store.itemsForEntityScoped(level, ent.id, q.topK ?? 50);
    } else if (q.all) {
      items = this.store.listItemsByLayerScoped('semantic', level, q.topK ?? 200);
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
    const capsule = parseCapsule(opts.capsuleJson);
    if (capsule.signature) {
      if (!opts.secret) throw new Error('capsule is signed: provide the shared secret');
      if (!verifyCapsule(capsule, opts.secret)) {
        throw new Error('capsule signature mismatch (tampered?)');
      }
    }
    // Pre-warm similarity probes: the pure planner is synchronous, the
    // retriever is async — probe each non-duplicate capsule item once,
    // scoped to the importer, then hand the results to the planner.
    const probes = new Map<string, Array<{ id: string; content: string; similarity: number }>>();
    for (const item of capsule.items) {
      if (this.store.findItemIdsByContent(item.content).length > 0) continue;
      const res = await this.retriever.retrieve({
        query: item.content,
        topK: 3,
        minScore: 0.75,
        scope: opts.scope,
      });
      probes.set(
        normalizedContent(item.content),
        res.hits.map((h) => ({ id: h.item.id, content: h.item.content, similarity: h.rawScore })),
      );
    }
    const plan = planImport(
      capsule,
      (content) => this.store.findItemIdsByContent(content).length > 0,
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
    const tier = opts.visibility ?? 'global';
    const targets = [...plan.toInsert, ...(opts.force ? plan.conflictOnly : [])];

    let inserted = 0;
    let entitiesRehydrated = 0;
    for (const cap of targets) {
      const now = Date.now();
      const embedding = capsuleEmbedding(cap);
      // Rehydrate the entity graph from NAMES under the importer's scope;
      // the multi-entity aggregation of retrieval resolves names at query
      // time, so a linked entityId is optional here.
      if (cap.entities.length > 0) {
        const joined = cap.entities.join(' ');
        const ids = this.graph.ingestEntities(
          `${cap.content}\n${joined}`,
          `capsule-${cap.id}`,
          { ...opts.scope, visibility: tier },
        );
        entitiesRehydrated += ids.length;
      }
      this.store.insertItem(
        {
          id: randomUUID(),
          layer: cap.layer,
          content: cap.content,
          embedding,
          metadata: {
            source: 'user',
            userId: opts.scope.userId,
            workspaceId: opts.scope.workspaceId,
            sessionId: opts.scope.sessionId,
            tags: [...(cap.tags ?? []), 'capsule'],
            entities: cap.entities,
            tokenCount: cap.content.length,
            embeddingSpace: embedding ? cap.embedding?.space : undefined,
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
          userId: opts.scope.userId,
          workspaceId: opts.scope.workspaceId,
          sessionId: opts.scope.sessionId,
        },
      );
      inserted++;
    }

    let patternsImported = 0;
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

    const report: ImportReport = {
      inserted,
      duplicates: plan.duplicates.length,
      conflictsFlagged: plan.conflicts.length,
      conflictsImported: opts.force ? plan.conflictOnly.length : 0,
      entitiesRehydrated,
      patternsImported,
      palaceId: capsule.palaceId,
      exportedAt: capsule.exportedAt,
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

