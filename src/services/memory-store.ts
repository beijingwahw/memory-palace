/**
 * MemoryStore — SQLite-backed persistent store for the three memory layers
 * plus the knowledge graph. Uses better-sqlite3 (sync, embedded, no daemon)
 * so the plugin can be installed with zero infrastructure.
 *
 * ## Vector search via SQL pushdown
 *
 * A `mp_cosine(embedding, query)` scalar function is registered with
 * SQLite (deterministic), so similarity scoring, ordering and LIMIT all
 * execute inside the database engine in a single streaming pass. Only the
 * top candidates are ever materialized as JS objects — the scan is not
 * capped at an arbitrary row count, and JS heap stays O(candidates)
 * instead of O(all items).
 *
 * ## Scopes
 *
 * Items carry workspace_id / user_id / session_id columns. Retrieval
 * filters through a scope cascade (session → workspace → user) built by
 * `scopeClauses`; see memory-retriever.ts for the progressive-widening
 * policy.
 *
 * ## Vector spaces
 *
 * Items record which embedding space produced their vector
 * (`embedding_space`). Cosine similarity is only meaningful within one
 * space, so scans are always per-space. Legacy rows written before this
 * column existed are backfilled with the gateway's primary space.
 *
 * ## Item TTL
 *
 * Every read path enforces metadata.expiresAt inline (UNEXPIRED SQL
 * fragment), so expired-but-unswept items are invisible even before
 * sweepExpiredItems() tombstones them — read-time TTL enforcement
 * complementing the set-based sweeper.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { cosine } from '../utils/embedding.js';
import {
  buildTierCondition,
  tierDisjunction,
  type ScopeIdentity,
  type ScopeLevelClause,
  type VisibilityTier,
} from '../utils/scope.js';
import { NOOP_BUS, type MemoryEventBus, type MemoryScopeKind } from '../types/index.js';
import type {
  MemoryItem,
  MemoryLayer,
  MemoryMetadata,
  EpisodicEvent,
  Entity,
  GraphEdge,
} from '../types/index.js';

export interface StoreOptions {
  storagePath: string;
  dimensions: number;
  /** Scope kind applied to reads/writes; see utils/scope.ts tier ACL. */
  scope?: MemoryScopeKind;
  /** Primary embedding space; used to backfill legacy rows and NULL tags. */
  activeSpace?: string;
}

interface ItemRow {
  id: string;
  layer: MemoryLayer;
  content: string;
  embedding: Buffer | null;
  metadata: string;
  created_at: number;
  updated_at: number;
  importance: number;
  access_count: number;
  last_accessed_at: number;
  entity_id: string | null;
  workspace_id: string | null;
  user_id: string | null;
  session_id: string | null;
  embedding_space: string | null;
  visibility: string | null;
}

interface EventRow {
  id: string;
  session_id: string;
  type: EpisodicEvent['type'];
  payload: string;
  ts: number;
  summarized_as: string | null;
}

interface EntityRow {
  id: string;
  name: string;
  type: Entity['type'];
  aliases: string;
  first_seen_at: number;
  last_seen_at: number;
  mention_count: number;
  visibility: string | null;
  user_id: string | null;
  workspace_id: string | null;
  session_id: string | null;
}

export interface ScanOptions {
  layer: MemoryLayer;
  /** Only rows whose embedding lives in this space are scored. */
  space: string;
  queryVector: Float32Array;
  /** Floor on RAW cosine similarity (pre-decay). */
  minScore: number;
  /** Max candidates returned after ordering (best-first). */
  limit: number;
  /** Cumulative visibility-tier level (see utils/scope.ts). */
  scope?: ScopeLevelClause;
  /** Only items created at/after this unix-ms timestamp. */
  sinceMs?: number;
  /** Only items created at/before this unix-ms timestamp. */
  untilMs?: number;
  /** FLASHBACK: reconstruct the store as of this unix-ms instant. */
  asOfMs?: number;
}

/** Filter fragment excluding tombstoned / superseded rows. */
const LIVE = 'deleted_at IS NULL AND superseded_by IS NULL';

/**
 * TTL read-time filter fragment: a row is visible only when it carries
 * no expiry or its expiry is strictly in the future. Carries exactly ONE
 * bound parameter (current unix ms) — every query embedding this fragment
 * must bind Date.now() (via MemoryStore.nowBound()) in the parameter
 * position where the fragment appears in the SQL text.
 */
const UNEXPIRED = " AND (json_extract(metadata, '$.expiresAt') IS NULL OR json_extract(metadata, '$.expiresAt') > ?)";

export interface ScanHit {
  item: MemoryItem;
  rawScore: number;
}

/**
 * Progressive widening cascade over visibility tiers — see utils/scope.ts.
 * (Re-exported here for historical import paths.)
 */
export { scopeLevels as scopeClauses } from '../utils/scope.js';
export type { ScopeLevelClause, VisibilityTier } from '../utils/scope.js';

/** Decode a stored BLOB into a Float32Array (copy: alignment-safe, owned). */
function bufferToF32(b: Buffer): Float32Array {
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  return new Float32Array(ab);
}

export class MemoryStore {
  private db: Database.Database;
  private dims: number;
  private scope: MemoryScopeKind;
  private activeSpace: string | undefined;
  private bus: MemoryEventBus;
  private sqlFnAvailable: boolean;

  constructor(opts: StoreOptions, bus: MemoryEventBus = NOOP_BUS) {
    this.dims = opts.dimensions;
    this.scope = opts.scope ?? 'user';
    this.activeSpace = opts.activeSpace;
    this.bus = bus;
    const path = opts.storagePath;
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.sqlFnAvailable = this.registerCosineFunction();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ----- Data versioning (cache invalidation stamp) -------------------------
  // PRAGMA user_version doubles as a monotonic data-mutation counter: ANY
  // write (items, tombstones, entities, edges, retention) bumps it. The
  // semantic query cache and the PageRank SWR caches compare it to detect
  // staleness — immune to the count-collision failures of size-based keys.

  dataVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  /** Back-compat alias: the graph's ranks key off the same stamp. */
  graphVersion(): number {
    return this.dataVersion();
  }

  private bumpDataVersion(): void {
    this.db.pragma(`user_version = ${this.dataVersion() + 1}`);
  }

  private bumpGraphVersion(): void {
    this.bumpDataVersion();
  }

  private inTxDepth = 0;

  /**
   * Run a batch of writes as ONE transaction: atomic commit, single WAL
   * flush, and a guaranteed graph-version stamp for the whole batch.
   * Nested calls join the outermost transaction (better-sqlite3 turns
   * them into savepoints). Pure reads inside are fine too.
   */
  ingestTx<T>(fn: () => T): T {
    if (this.inTxDepth > 0) return fn(); // join outer batch
    this.inTxDepth = 1;
    const versionBefore = this.graphVersion();
    try {
      const out = this.db.transaction(fn)();
      if (this.graphVersion() === versionBefore) this.bumpGraphVersion();
      return out;
    } finally {
      this.inTxDepth = 0;
    }
  }

  /** Register mp_cosine as a deterministic SQL scalar function. */
  private registerCosineFunction(): boolean {
    const fn = (a: unknown, b: unknown): number => {
      if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return 0;
      if (a.byteLength === 0 || b.byteLength === 0) return 0;
      const r = cosine(bufferToF32(a), bufferToF32(b));
      return Number.isFinite(r) ? r : 0;
    };
    try {
      this.db.function('mp_cosine', { deterministic: true }, fn);
      return true;
    } catch {
      // Very old better-sqlite3 without options — try the plain form.
      try {
        this.db.function('mp_cosine', fn);
        return true;
      } catch {
        return false; // JS-side fallback scan is used instead
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL CHECK (layer IN ('episodic','semantic','procedural')),
        content TEXT NOT NULL,
        embedding BLOB,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL DEFAULT 0,
        entity_id TEXT,
        workspace_id TEXT,
        user_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_layer ON memory_items(layer);
      CREATE INDEX IF NOT EXISTS idx_items_created ON memory_items(created_at);
      CREATE INDEX IF NOT EXISTS idx_items_importance ON memory_items(importance);

      CREATE TABLE IF NOT EXISTS episodic_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts INTEGER NOT NULL,
        summarized_as TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON episodic_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON episodic_events(ts);

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        mention_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

      CREATE TABLE IF NOT EXISTS graph_edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (from_id, to_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_id);

      CREATE TABLE IF NOT EXISTS procedural_patterns (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL
      );
    `);

    // --- v2 migration: session_id + embedding_space -------------------------
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(memory_items)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!cols.has('session_id')) {
      this.db.exec('ALTER TABLE memory_items ADD COLUMN session_id TEXT');
    }
    if (!cols.has('embedding_space')) {
      this.db.exec('ALTER TABLE memory_items ADD COLUMN embedding_space TEXT');
    }
    // --- v3 migration: tombstones + supersession ----------------------------
    if (!cols.has('deleted_at')) {
      this.db.exec('ALTER TABLE memory_items ADD COLUMN deleted_at INTEGER');
    }
    if (!cols.has('superseded_by')) {
      this.db.exec('ALTER TABLE memory_items ADD COLUMN superseded_by TEXT');
    }
    // --- v4 migration: visibility-tier ACL across items/entities/edges ------
    if (!cols.has('visibility')) {
      this.db.exec('ALTER TABLE memory_items ADD COLUMN visibility TEXT');
    }
    const entCols = new Set(
      (this.db.prepare('PRAGMA table_info(entities)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!entCols.has('visibility')) {
      this.db.exec(`
        ALTER TABLE entities ADD COLUMN visibility TEXT;
        ALTER TABLE entities ADD COLUMN user_id TEXT;
        ALTER TABLE entities ADD COLUMN workspace_id TEXT;
        ALTER TABLE entities ADD COLUMN session_id TEXT;
      `);
    }
    const edgeCols = new Set(
      (this.db.prepare('PRAGMA table_info(graph_edges)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!edgeCols.has('visibility')) {
      this.db.exec(`
        ALTER TABLE graph_edges ADD COLUMN visibility TEXT;
        ALTER TABLE graph_edges ADD COLUMN user_id TEXT;
        ALTER TABLE graph_edges ADD COLUMN workspace_id TEXT;
        ALTER TABLE graph_edges ADD COLUMN session_id TEXT;
      `);
    }
    // --- v5 migration: visibility-tier ACL on procedural_patterns ---------
    // Patterns carried no owner columns, so every pattern was visible to
    // every caller. They now mirror the items/entities/edges tier columns;
    // pre-v5 rows backfill as global (they were typically single-user).
    const patCols = new Set(
      (this.db.prepare('PRAGMA table_info(procedural_patterns)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!patCols.has('visibility')) {
      this.db.exec(`
        ALTER TABLE procedural_patterns ADD COLUMN visibility TEXT;
        ALTER TABLE procedural_patterns ADD COLUMN user_id TEXT;
        ALTER TABLE procedural_patterns ADD COLUMN workspace_id TEXT;
        ALTER TABLE procedural_patterns ADD COLUMN session_id TEXT;
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_items_session ON memory_items(session_id);
      CREATE INDEX IF NOT EXISTS idx_items_space ON memory_items(embedding_space);
      CREATE INDEX IF NOT EXISTS idx_items_scope ON memory_items(workspace_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_items_live ON memory_items(layer, deleted_at, superseded_by);
      CREATE INDEX IF NOT EXISTS idx_items_vis ON memory_items(visibility);
      CREATE INDEX IF NOT EXISTS idx_entities_scope ON entities(name, visibility);
      CREATE INDEX IF NOT EXISTS idx_edges_vis ON graph_edges(visibility);
      CREATE INDEX IF NOT EXISTS idx_patterns_scope ON procedural_patterns(visibility);
    `);
    // Backfill: derive each row's tier from its owner columns; rows with no
    // owner are global. Pre-ACL entities/edges were typically single-user,
    // so they backfill as global to preserve behavior.
    this.db.exec(`
      UPDATE memory_items SET visibility = CASE
        WHEN user_id IS NOT NULL THEN 'user'
        WHEN workspace_id IS NOT NULL THEN 'workspace'
        WHEN session_id IS NOT NULL THEN 'session'
        ELSE 'global' END
      WHERE visibility IS NULL;
      UPDATE entities SET visibility = 'global' WHERE visibility IS NULL;
      UPDATE graph_edges SET visibility = 'global' WHERE visibility IS NULL;
      UPDATE procedural_patterns SET visibility = 'global' WHERE visibility IS NULL;
    `);
    // Legacy rows predate space tagging; attribute them to the active space.
    if (this.activeSpace) {
      this.db
        .prepare('UPDATE memory_items SET embedding_space = ? WHERE embedding_space IS NULL')
        .run(this.activeSpace);
    }
  }

  private embeddingToBuffer(v: Float32Array): Buffer {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  private bufferToEmbedding(b: Buffer): Float32Array {
    // Force a copy so we own the ArrayBuffer and downstream code can hold it
    return bufferToF32(b);
  }

  /** Current unix-ms bound for the UNEXPIRED TTL fragment's parameter. */
  private static nowBound(): number {
    return Date.now();
  }

  insertItem(
    item: MemoryItem,
    ctx: { workspaceId?: string; userId?: string; sessionId?: string },
  ): void {
    const space = item.metadata.embeddingSpace ?? this.activeSpace ?? null;
    // Visibility tier: explicit stamp wins; else derive from owner columns.
    const visibility =
      item.metadata.visibility ??
      (ctx.userId
        ? 'user'
        : ctx.workspaceId
          ? 'workspace'
          : ctx.sessionId ?? item.metadata.sessionId
            ? 'session'
            : ('global' as VisibilityTier));
    this.bus.emit('memory.before-store', { id: item.id, layer: item.layer, scope: ctx });
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_items
        (id, layer, content, embedding, metadata, created_at, updated_at,
         importance, access_count, last_accessed_at, entity_id, workspace_id,
         user_id, session_id, embedding_space, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      item.id,
      item.layer,
      item.content,
      item.embedding ? this.embeddingToBuffer(item.embedding) : null,
      JSON.stringify(item.metadata ?? {}),
      item.createdAt,
      item.updatedAt,
      item.importance,
      item.accessCount,
      item.lastAccessedAt,
      item.entityId ?? null,
      ctx.workspaceId ?? null,
      ctx.userId ?? null,
      ctx.sessionId ?? item.metadata.sessionId ?? null,
      space,
      visibility,
    );
    this.bus.emit('memory.after-store', {
      id: item.id,
      layer: item.layer,
      embeddingSpace: space,
      visibility,
    });
    this.bumpDataVersion();
  }

  upsertItem(
    item: MemoryItem,
    ctx: { workspaceId?: string; userId?: string; sessionId?: string },
  ): void {
    this.insertItem(item, ctx);
  }

  getItem(id: string): MemoryItem | null {
    const row = this.db
      .prepare(`SELECT * FROM memory_items WHERE id = ?${UNEXPIRED}`)
      .get(id, MemoryStore.nowBound()) as ItemRow | undefined;
    return row ? this.rowToItem(row) : null;
  }

  deleteItem(id: string): void {
    this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id);
    this.bumpDataVersion();
  }

  /** List LIVE, unexpired items in a layer (importance-first). Used by compression passes. */
  listItemsByLayer(layer: MemoryLayer, limit = 5000): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${LIVE}${UNEXPIRED} AND layer = ?
         ORDER BY importance DESC, created_at DESC LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), layer, limit) as ItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /** LIVE, unexpired items linked to a graph entity (for entity-cascade forget). */
  itemsForEntity(entityId: string, limit = 500): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${LIVE}${UNEXPIRED} AND entity_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), entityId, limit) as ItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * LIVE, unexpired items linked to an entity, restricted to a cumulative
   * scope level — the read path for entity-anchor hop expansion.
   */
  itemsForEntityScoped(
    level: ScopeLevelClause,
    entityId: string,
    limit = 20,
  ): MemoryItem[] {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${LIVE}${UNEXPIRED} AND entity_id = ?
           AND (${disj.sql})
         ORDER BY importance DESC, created_at DESC LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), entityId, ...disj.params, limit) as ItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Soft-delete (tombstone) an item. Tombstoned rows are excluded from
   * all reads but stay on disk until purgeDeleted, enabling undo and
   * audit. Returns false when the id is unknown or already tombstoned.
   */
  tombstoneItem(id: string, supersededBy?: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE memory_items SET deleted_at = ?, superseded_by = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(Date.now(), supersededBy ?? null, id);
    if (res.changes > 0) this.bumpDataVersion();
    return res.changes > 0;
  }

  /** Undo a tombstone. Returns false when nothing to restore. */
  restoreItem(id: string): boolean {
    const res = this.db
      .prepare(
        'UPDATE memory_items SET deleted_at = NULL, superseded_by = NULL WHERE id = ?',
      )
      .run(id);
    if (res.changes > 0) this.bumpDataVersion();
    return res.changes > 0;
  }

  /** Fetch an item only if it is LIVE and visible at the scope levels. */
  getItemInScope(id: string, levels: ScopeLevelClause[]): MemoryItem | null {
    for (const lvl of levels) {
      const disj = tierDisjunction(lvl.tiers, lvl.ids);
      if (!disj) continue;
      const row = this.db
        .prepare(
          `SELECT * FROM memory_items WHERE id = ? AND ${LIVE}${UNEXPIRED} AND (${disj.sql}) LIMIT 1`,
        )
        .get(id, MemoryStore.nowBound(), ...disj.params) as ItemRow | undefined;
      if (row) return this.rowToItem(row);
    }
    return null;
  }

  /**
   * Exact-content membership (capsule import dedupe). Rare-path full scan
   * is acceptable — imports are infrequent and bounded by capsule size.
   */
  findItemIdsByContent(content: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM memory_items WHERE content = ? LIMIT 2')
      .all(content) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** LIVE, unexpired items in a layer, restricted to a cumulative scope level. */
  listItemsByLayerScoped(
    layer: MemoryLayer,
    level: ScopeLevelClause,
    limit = 200,
  ): MemoryItem[] {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${LIVE}${UNEXPIRED} AND layer = ? AND (${disj.sql})
         ORDER BY importance DESC, created_at DESC LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), layer, ...disj.params, limit) as ItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Hard-delete tombstones older than `olderThanMs`. When levels are
   * given, only tombstones visible at the WIDEST level are purged
   * (tenants never purge each other's rows).
   */
  purgeDeleted(olderThanMs = 0, levels?: ScopeLevelClause[]): number {
    const cutoff = Date.now() - olderThanMs;
    let n = 0;
    if (levels && levels.length > 0) {
      const widest = levels[levels.length - 1];
      const disj = tierDisjunction(widest.tiers, widest.ids);
      if (!disj) return 0;
      n = this.db
        .prepare(
          `DELETE FROM memory_items
           WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND (${disj.sql})`,
        )
        .run(cutoff, ...disj.params).changes;
    } else {
      n = this.db
        .prepare('DELETE FROM memory_items WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
        .run(cutoff).changes;
    }
    if (n > 0) this.bumpDataVersion();
    return n;
  }

  /** Hard-delete episodic events older than `olderThanMs` (retention). */
  deleteEventsOlderThan(olderThanMs: number): number {
    return this.db
      .prepare('DELETE FROM episodic_events WHERE ts <= ?')
      .run(Date.now() - olderThanMs).changes;
  }

  /**
   * Enforce metadata.expiresAt TTLs: tombstone (recoverably) every live
   * item whose expiry has passed. Uses SQLite JSON1 for a single set-based
   * sweep — no row materialization in JS.
   */
  sweepExpiredItems(): number {
    const n = this.db
      .prepare(
        `UPDATE memory_items SET deleted_at = ?
         WHERE deleted_at IS NULL AND superseded_by IS NULL
           AND json_extract(metadata, '$.expiresAt') IS NOT NULL
           AND json_extract(metadata, '$.expiresAt') <= ?`,
      )
      .run(Date.now(), Date.now()).changes;
    if (n > 0) this.bumpDataVersion();
    return n;
  }

  /** Number of tombstoned (soft-deleted, not yet purged) items. */
  countTombstoned(): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) as n FROM memory_items WHERE deleted_at IS NOT NULL')
        .get() as { n: number }
    ).n;
  }

  /**
   * Cascade delete for an entity: tombstone its linked items, then remove
   * the entity row and its edges (GDPR-style right-to-be-forgotten unit).
   */
  deleteEntityCascade(entityId: string): { items: number; edges: number } {
    const items = this.itemsForEntity(entityId, 5000);
    let tombstoned = 0;
    for (const it of items) {
      if (this.tombstoneItem(it.id)) tombstoned++;
    }
    const edges = this.db
      .prepare('DELETE FROM graph_edges WHERE from_id = ? OR to_id = ?')
      .run(entityId, entityId).changes;
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(entityId);
    this.bumpGraphVersion();
    return { items: tombstoned, edges };
  }

  /** Most recently created LIVE, unexpired items across layers (for memory_inspect). */
  listRecentItems(limit = 10): Array<{
    id: string;
    layer: MemoryLayer;
    content: string;
    importance: number;
    createdAt: number;
    embeddingSpace: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, layer, content, importance, created_at, embedding_space
         FROM memory_items WHERE ${LIVE}${UNEXPIRED} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), limit) as Array<{
      id: string;
      layer: MemoryLayer;
      content: string;
      importance: number;
      created_at: number;
      embedding_space: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      layer: r.layer,
      content: r.content.length > 120 ? r.content.slice(0, 120) + '…' : r.content,
      importance: r.importance,
      createdAt: r.created_at,
      embeddingSpace: r.embedding_space,
    }));
  }

  /** Most recently created LIVE, unexpired items VISIBLE at a scope level. */
  listRecentItemsScoped(
    level: ScopeLevelClause,
    limit = 10,
  ): ReturnType<MemoryStore['listRecentItems']> {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(
        `SELECT id, layer, content, importance, created_at, embedding_space
         FROM memory_items WHERE ${LIVE}${UNEXPIRED} AND (${disj.sql})
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), ...disj.params, limit) as Array<{
      id: string;
      layer: MemoryLayer;
      content: string;
      importance: number;
      created_at: number;
      embedding_space: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      layer: r.layer,
      content: r.content.length > 120 ? r.content.slice(0, 120) + '…' : r.content,
      importance: r.importance,
      createdAt: r.created_at,
      embeddingSpace: r.embedding_space,
    }));
  }

  /** Distinct embedding spaces present among LIVE items. */
  listEmbeddingSpaces(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT embedding_space FROM memory_items
         WHERE ${LIVE} AND embedding_space IS NOT NULL`,
      )
      .all() as { embedding_space: string }[];
    return rows.map((r) => r.embedding_space);
  }

  /**
   * Similarity scan with scoring pushed down into SQLite. Rows stream
   * through the engine best-first; only `limit` top rows per call are
   * materialized. Thresholding happens on the returned best-first rows,
   * which is equivalent to filtering inside the query as long as limit ≥
   * the number of rows that pass the threshold (callers keep limit ≥ 32×
   * topK for exactly this reason).
   */
  scanBySimilarity(opts: ScanOptions): ScanHit[] {
    const qbuf = this.embeddingToBuffer(opts.queryVector);
    const scope = opts.scope ?? { sql: '', params: [] as unknown[] };
    // Legacy NULL-space rows join the active space's scan.
    const spacePredicate =
      opts.space === this.activeSpace
        ? '(embedding_space = ? OR embedding_space IS NULL)'
        : 'embedding_space = ?';
    const time: string[] = [];
    const timeParams: unknown[] = [];
    if (opts.sinceMs !== undefined) {
      time.push('created_at >= ?');
      timeParams.push(opts.sinceMs);
    }
    if (opts.untilMs !== undefined) {
      time.push('created_at <= ?');
      timeParams.push(opts.untilMs);
    }
    const timeClause = time.length ? ` AND ${time.join(' AND ')}` : '';

    // FLASHBACK (asOfMs): reconstruct the store as of a past instant —
    // items existed then iff created_at <= T, and neither tombstoned nor
    // superseded before T (both record the transition in deleted_at).
    // Expiry is evaluated against T as well, so beliefs whose TTL had not
    // yet elapsed at T remain visible.
    const asOf = opts.asOfMs;
    const liveSql =
      asOf !== undefined ? '(deleted_at IS NULL OR deleted_at > ?)' : LIVE;
    const unexpiredSql =
      asOf !== undefined
        ? " AND (json_extract(metadata, '$.expiresAt') IS NULL OR json_extract(metadata, '$.expiresAt') > ?)"
        : UNEXPIRED;
    const createdLeSql = asOf !== undefined ? ' AND created_at <= ?' : '';
    const asOfParams: unknown[] =
      asOf !== undefined ? [asOf, asOf, asOf] : [];
    const nowParam: unknown[] = asOf !== undefined ? [] : [MemoryStore.nowBound()];

    if (this.sqlFnAvailable) {
      const sql = `
        SELECT *, mp_cosine(embedding, ?) AS score
        FROM memory_items
        WHERE ${liveSql}${unexpiredSql}${createdLeSql} AND layer = ? AND embedding IS NOT NULL
          AND ${spacePredicate}${timeClause}${scope.sql}
        ORDER BY score DESC
        LIMIT ?
      `;
      const rows = this.db
        .prepare(sql)
        .all(
          qbuf,
          ...asOfParams,
          ...nowParam,
          opts.layer,
          opts.space,
          ...timeParams,
          ...scope.params,
          opts.limit,
        ) as Array<ItemRow & { score: number }>;
      return rows
        .filter((r) => r.score >= opts.minScore)
        .map((r) => ({ item: this.rowToItem(r), rawScore: r.score }));
    }

    /**
     * Fallback: JS-side scan (old better-sqlite3 without db.function
     * options). Exact up to the 50,000-row cap and slightly slower than
     * the SQL pushdown — never approximate-by-importance: there is no
     * ORDER BY (rows stream in rowid order via statement iteration), and
     * EVERY row up to the cap is cosine-scored in JS before thresholding,
     * so highly-similar low-importance rows can no longer be cut before
     * they're scored. No full row array is materialized in the JS heap.
     */
    const sql = `
      SELECT * FROM memory_items
      WHERE ${liveSql}${unexpiredSql}${createdLeSql} AND layer = ? AND embedding IS NOT NULL
        AND ${spacePredicate}${timeClause}${scope.sql}
      LIMIT ?
    `;
    const rows = this.db
      .prepare(sql)
      .iterate(
        ...asOfParams,
        ...nowParam,
        opts.layer,
        opts.space,
        ...timeParams,
        ...scope.params,
        Math.max(opts.limit, 50_000),
      ) as IterableIterator<ItemRow>;
    const hits: ScanHit[] = [];
    for (const r of rows) {
      if (!r.embedding) continue;
      const emb = this.bufferToEmbedding(r.embedding);
      const raw = cosine(opts.queryVector, emb);
      if (raw >= opts.minScore) hits.push({ item: this.rowToItem(r), rawScore: raw });
    }
    hits.sort((a, b) => b.rawScore - a.rawScore);
    return hits.slice(0, opts.limit);
  }

  /** Count LIVE, unexpired items per layer. Used to trigger compression. */
  countByLayer(): Record<MemoryLayer, number> {
    const rows = this.db
      .prepare(
        `SELECT layer, COUNT(*) as n FROM memory_items WHERE ${LIVE}${UNEXPIRED} GROUP BY layer`,
      )
      .all(MemoryStore.nowBound()) as { layer: MemoryLayer; n: number }[];
    const out: Record<MemoryLayer, number> = { episodic: 0, semantic: 0, procedural: 0 };
    for (const r of rows) out[r.layer] = r.n;
    return out;
  }

  /**
   * Increment access stats when an item is returned by retrieval. With
   * `reinforce`, also nudge importance up by a bounded epsilon — the
   * "testing effect": recalled memories strengthen.
   */
  touchAccess(id: string, reinforce = false): void {
    if (reinforce) {
      this.db
        .prepare(
          `UPDATE memory_items
           SET access_count = access_count + 1, last_accessed_at = ?,
               importance = MIN(0.95, importance + 0.01)
           WHERE id = ?`,
        )
        .run(Date.now(), id);
      return;
    }
    this.db
      .prepare(
        'UPDATE memory_items SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?',
      )
      .run(Date.now(), id);
  }

  /** Evict items older than cutoff with importance below threshold. */
  evict(opts: {
    layer?: MemoryLayer;
    importanceBelow: number;
    olderThanMs: number;
    limit?: number;
  }): number {
    const cutoff = Date.now() - opts.olderThanMs;
    const limit = opts.limit ?? 500;
    const where: string[] = [LIVE, 'importance < ?', 'created_at < ?'];
    const params: unknown[] = [opts.importanceBelow, cutoff];
    if (opts.layer) {
      where.push('layer = ?');
      params.push(opts.layer);
    }
    const result = this.db
      .prepare(
        `DELETE FROM memory_items WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT ?`,
      )
      .run(...params, limit);
    if (result.changes > 0) this.bumpDataVersion();
    return result.changes;
  }

  // ----- Episodic events ---------------------------------------------------

  insertEvent(ev: EpisodicEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO episodic_events (id, session_id, type, payload, ts, summarized_as)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.id,
        ev.sessionId,
        ev.type,
        JSON.stringify(ev.payload ?? null),
        ev.ts,
        ev.summarizedAs ?? null,
      );
  }

  listEventsBySession(sessionId: string): EpisodicEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM episodic_events WHERE session_id = ? ORDER BY ts ASC')
      .all(sessionId) as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      type: r.type,
      payload: JSON.parse(r.payload),
      ts: r.ts,
      summarizedAs: r.summarized_as ?? undefined,
    }));
  }

  markEventSummarized(eventId: string, semanticItemId: string): void {
    this.db
      .prepare('UPDATE episodic_events SET summarized_as = ? WHERE id = ?')
      .run(semanticItemId, eventId);
  }

  // ----- Knowledge graph (scope-aware) --------------------------------------
  // Entities and edges carry the same visibility-tier ACL as memory items:
  // private mentions create private entities, global ingests bump global
  // ones, and scoped reads widen through the same cumulative cascade.

  upsertEntity(
    entity: Entity,
    scope: { visibility: VisibilityTier } & Partial<ScopeIdentity> = { visibility: 'global' },
  ): void {
    this.db
      .prepare(
        `INSERT INTO entities (id, name, type, aliases, first_seen_at, last_seen_at,
           mention_count, visibility, user_id, workspace_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           aliases=excluded.aliases,
           last_seen_at=excluded.last_seen_at,
           mention_count=entities.mention_count + 1`,
      )
      .run(
        entity.id,
        entity.name,
        entity.type,
        JSON.stringify(entity.aliases),
        entity.firstSeenAt,
        entity.lastSeenAt,
        entity.mentionCount,
        scope.visibility,
        scope.userId ?? null,
        scope.workspaceId ?? null,
        scope.sessionId ?? null,
      );
    this.bumpGraphVersion();
  }

  private entityRowToEntity(row: EntityRow): Entity {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      mentionCount: row.mention_count,
    };
  }

  getEntity(id: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
      | EntityRow
      | undefined;
    return row ? this.entityRowToEntity(row) : null;
  }

  findEntityByName(name: string): Entity | null {
    const row = this.db
      .prepare('SELECT * FROM entities WHERE name = ? LIMIT 1')
      .get(name) as EntityRow | undefined;
    return row ? this.entityRowToEntity(row) : null;
  }

  /** Exact-tier lookup (ingest dedup): same name at the SAME visibility level. */
  findEntityAtTier(
    name: string,
    tier: VisibilityTier,
    ids: ScopeIdentity,
  ): Entity | null {
    const cond = buildTierCondition(tier, ids);
    if (!cond) return null;
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE name = ? AND ${cond.sql} LIMIT 1`)
      .get(name, ...cond.params) as EntityRow | undefined;
    return row ? this.entityRowToEntity(row) : null;
  }

  /** Scoped lookup with widening: narrowest cascade level first. */
  findEntityInScope(name: string, levels: ScopeLevelClause[]): Entity | null {
    for (const lvl of levels) {
      const disj = tierDisjunction(lvl.tiers, lvl.ids);
      if (!disj) continue;
      const row = this.db
        .prepare(`SELECT * FROM entities WHERE name = ? AND (${disj.sql}) LIMIT 1`)
        .get(name, ...disj.params) as EntityRow | undefined;
      if (row) return this.entityRowToEntity(row);
    }
    return null;
  }

  /**
   * Batch-resolve entity NAMES to ids at one cumulative level — powers
   * multi-entity PageRank aggregation without per-name queries. Names are
   * deduped, capped at `limit`, and resolved in chunked `IN (…)` queries
   * (200 names per chunk — SQLite's default bind-parameter ceiling is
   * 999). Each chunk fetches ALL rows matching its names (the tier
   * filter scopes them; no per-name LIMIT) ordered by name, and the
   * FIRST row per name in that order is kept — a deterministic
   * replacement for the old per-name `LIMIT 1` "first match" semantics.
   */
  resolveEntityNames(
    names: string[],
    level: ScopeLevelClause,
    limit = 500,
  ): Map<string, string> {
    const out = new Map<string, string>();
    if (names.length === 0) return out;
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return out;
    const unique = [...new Set(names)].slice(0, limit);
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT name, id FROM entities
           WHERE name IN (${placeholders}) AND (${disj.sql})
           ORDER BY name`,
        )
        .all(...chunk, ...disj.params) as Array<{ name: string; id: string }>;
      for (const row of rows) {
        // First occurrence per name (name-ordered) wins; chunks hold
        // disjoint name sets so cross-chunk collisions cannot occur.
        if (!out.has(row.name)) out.set(row.name, row.id);
      }
    }
    return out;
  }

  listEntities(limit = 5000): Entity[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM entities ORDER BY mention_count DESC, last_seen_at DESC LIMIT ?',
      )
      .all(limit) as EntityRow[];
    return rows.map((r) => this.entityRowToEntity(r));
  }

  /** Entities visible at a cumulative scope level (for scoped PageRank). */
  listEntitiesScoped(level: ScopeLevelClause, limit = 5000): Entity[] {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM entities WHERE (${disj.sql})
         ORDER BY mention_count DESC, last_seen_at DESC LIMIT ?`,
      )
      .all(...disj.params, limit) as EntityRow[];
    return rows.map((r) => this.entityRowToEntity(r));
  }

  upsertEdge(
    edge: GraphEdge,
    scope: { visibility: VisibilityTier } & Partial<ScopeIdentity> = { visibility: 'global' },
  ): void {
    this.db
      .prepare(
        `INSERT INTO graph_edges (from_id, to_id, relation, weight, created_at,
           visibility, user_id, workspace_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
           weight = graph_edges.weight + excluded.weight,
           created_at = excluded.created_at`,
      )
      .run(
        edge.from,
        edge.to,
        edge.relation,
        edge.weight,
        edge.createdAt,
        scope.visibility,
        scope.userId ?? null,
        scope.workspaceId ?? null,
        scope.sessionId ?? null,
      );
    this.bumpGraphVersion();
  }

  listEdges(): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM graph_edges').all() as {
      from_id: string;
      to_id: string;
      relation: string;
      weight: number;
      created_at: number;
    }[];
    return rows.map((r) => ({
      from: r.from_id,
      to: r.to_id,
      relation: r.relation,
      weight: r.weight,
      createdAt: r.created_at,
    }));
  }

  /** Edges visible at a cumulative scope level, with last-seen timestamps. */
  listEdgesScoped(
    level: ScopeLevelClause,
  ): Array<{ from: string; to: string; weight: number; lastSeenAt: number }> {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, weight, created_at FROM graph_edges WHERE (${disj.sql})`,
      )
      .all(...disj.params) as {
      from_id: string;
      to_id: string;
      weight: number;
      created_at: number;
    }[];
    return rows.map((r) => ({
      from: r.from_id,
      to: r.to_id,
      weight: r.weight,
      lastSeenAt: r.created_at,
    }));
  }

  // ----- Procedural patterns (scope-aware) ----------------------------------
  // Since v5 patterns carry the same visibility-tier ACL as items/entities/
  // edges: mining stamps each pattern with its owner group's scope, and
  // scoped reads (listPatternsScoped) widen through the same cascade.

  /** Shape returned by both listPatterns and listPatternsScoped. */
  private static PATTERN_FIELDS =
    'id, pattern, description, evidence, confidence, created_at';

  private patternRowsToList(rows: unknown[]): {
    id: string;
    pattern: string;
    description: string;
    evidence: string[];
    confidence: number;
    createdAt: number;
  }[] {
    return (rows as {
      id: string;
      pattern: string;
      description: string;
      evidence: string;
      confidence: number;
      created_at: number;
    }[]).map((r) => ({
      id: r.id,
      pattern: r.pattern,
      description: r.description,
      evidence: JSON.parse(r.evidence),
      confidence: r.confidence,
      createdAt: r.created_at,
    }));
  }

  /**
   * Write (or reinforce) a procedural pattern. `scope` stamps the owner
   * tier columns (default global, mirroring upsertEntity/upsertEdge); the
   * scope is immutable on conflict — a re-mined pattern only refreshes
   * description/evidence/confidence, never re-attributes ownership.
   */
  upsertPattern(
    p: {
      id: string;
      pattern: string;
      description: string;
      evidence: string[];
      confidence: number;
      createdAt: number;
    },
    scope: { visibility: VisibilityTier } & Partial<ScopeIdentity> = { visibility: 'global' },
  ): void {
    this.db
      .prepare(
        `INSERT INTO procedural_patterns (id, pattern, description, evidence, confidence, created_at,
           visibility, user_id, workspace_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           description=excluded.description,
           evidence=excluded.evidence,
           confidence=excluded.confidence`,
      )
      .run(
        p.id,
        p.pattern,
        p.description,
        JSON.stringify(p.evidence),
        p.confidence,
        p.createdAt,
        scope.visibility,
        scope.userId ?? null,
        scope.workspaceId ?? null,
        scope.sessionId ?? null,
      );
  }

  /** All patterns, unscoped (legacy/compat; scoped callers use the variant below). */
  listPatterns(): {
    id: string;
    pattern: string;
    description: string;
    evidence: string[];
    confidence: number;
    createdAt: number;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT ${MemoryStore.PATTERN_FIELDS} FROM procedural_patterns ORDER BY confidence DESC`,
      )
      .all();
    return this.patternRowsToList(rows);
  }

  /** Patterns visible at a cumulative scope level (same ACL as items). */
  listPatternsScoped(level: ScopeLevelClause): {
    id: string;
    pattern: string;
    description: string;
    evidence: string[];
    confidence: number;
    createdAt: number;
  }[] {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(
        `SELECT ${MemoryStore.PATTERN_FIELDS} FROM procedural_patterns
         WHERE (${disj.sql}) ORDER BY confidence DESC`,
      )
      .all(...disj.params);
    return this.patternRowsToList(rows);
  }

  // ----- Maintenance --------------------------------------------------------

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  stats(): {
    items: Record<MemoryLayer, number>;
    events: number;
    entities: number;
    edges: number;
    patterns: number;
    sizeBytes: number;
    spaces: Record<string, number>;
    tombstoned: number;
  } {
    const itemRows = this.db
      .prepare(
        `SELECT layer, COUNT(*) as n FROM memory_items WHERE ${LIVE}${UNEXPIRED} GROUP BY layer`,
      )
      .all(MemoryStore.nowBound()) as { layer: MemoryLayer; n: number }[];
    const items: Record<MemoryLayer, number> = { episodic: 0, semantic: 0, procedural: 0 };
    for (const r of itemRows) items[r.layer] = r.n;
    const events = (
      this.db.prepare('SELECT COUNT(*) as n FROM episodic_events').get() as { n: number }
    ).n;
    const entities = (
      this.db.prepare('SELECT COUNT(*) as n FROM entities').get() as { n: number }
    ).n;
    const edges = (
      this.db.prepare('SELECT COUNT(*) as n FROM graph_edges').get() as { n: number }
    ).n;
    const patterns = (
      this.db.prepare('SELECT COUNT(*) as n FROM procedural_patterns').get() as { n: number }
    ).n;
    const spaceRows = this.db
      .prepare(
        `SELECT embedding_space, COUNT(*) as n FROM memory_items
         WHERE ${LIVE} AND embedding_space IS NOT NULL GROUP BY embedding_space`,
      )
      .all() as { embedding_space: string; n: number }[];
    const spaces: Record<string, number> = {};
    for (const r of spaceRows) spaces[r.embedding_space] = r.n;
    const tombstoned = this.countTombstoned();
    const sizeBytes =
      (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count *
      (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    return { items, events, entities, edges, patterns, sizeBytes, spaces, tombstoned };
  }

  private rowToItem(r: ItemRow): MemoryItem {
    return {
      id: r.id,
      layer: r.layer,
      content: r.content,
      embedding: r.embedding ? this.bufferToEmbedding(r.embedding) : undefined,
      metadata: JSON.parse(r.metadata) as MemoryMetadata,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      importance: r.importance,
      accessCount: r.access_count,
      lastAccessedAt: r.last_accessed_at,
      entityId: r.entity_id ?? undefined,
      visibility: (r.visibility as MemoryItem['visibility']) ?? undefined,
    };
  }
}
