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
import { anchorKey } from '../utils/anchors.js';
import { quantizeToInt8, dequantizeToFloat32, int8Cosine } from '../utils/quantize.js';
import { invariant, assertNamedParamParity } from '../utils/invariants.js';
import {
  buildTierCondition,
  tierDisjunction,
  visibleAtLevel,
  type ScopeIdentity,
  type ScopeLevelClause,
  type VisibilityTier,
} from '../utils/scope.js';
import { NOOP_BUS, type MemoryEventBus, type MemoryScopeKind } from '../types/index.js';
import type { CoreBlock } from './core-memory.js';
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
  /** Vector storage precision. Default 'int8' (4× denser, bounded error). */
  quantization?: 'int8' | 'float32';
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
  /** IVF: restrict the scan to these bucket keys (undefined = exact). */
  buckets?: string[];
}


/** Bucket key for a stored vector (shared anchor planes). */
function anchorKeyOf(v: Float32Array): string {
  return anchorKey(v);
}

/** Filter fragment excluding tombstoned / superseded rows. */
const LIVE = 'deleted_at IS NULL AND superseded_by IS NULL';

/**
 * Ghost-row predicate: a LIVE row whose visibility tier names an owner
 * column that is NULL. Such a row matches no tier's ACL disjunction, so it
 * is invisible at EVERY level — data that exists but can never be read.
 * Only reachable through legacy/foreign writes; every public write path
 * stamps the owner column matching the tier. Shared verbatim by
 * integrityCheck (count) and repairIntegrity (opt-in tombstone) so
 * check → repair → check converges, per the same discipline as LIVE.
 */
const GHOST_ROWS = `(${LIVE} AND (
       (visibility = 'session' AND session_id IS NULL)
    OR (visibility = 'workspace' AND workspace_id IS NULL)
    OR (visibility = 'user' AND user_id IS NULL)
  ))`;

/**
 * Sentinel for "safeJson could not parse this cell" — a Symbol can never
 * collide with any legitimate JSON value, so callers can branch on it
 * without a bare try/catch of their own.
 */
const TREE_PARSE_FAILED: unique symbol = Symbol('tree-parse-failed');

/**
 * TTL read-time filter fragment: a row is visible only when it carries
 * no expiry or its expiry is strictly in the future. The leading
 * json_valid(metadata) short-circuit keeps a malformed metadata cell from
 * throwing out of json_extract — corrupt JSON reads as "no expiry" (the
 * same degraded-but-alive semantics rowToItem's safeJson applies) instead
 * of failing the entire query. Carries exactly ONE bound parameter
 * (current unix ms) — every query embedding this fragment must bind
 * Date.now() (via MemoryStore.nowBound()) in the parameter position where
 * the fragment appears in the SQL text.
 */
const UNEXPIRED = " AND (NOT json_valid(metadata) OR json_extract(metadata, '$.expiresAt') IS NULL OR json_extract(metadata, '$.expiresAt') > ?)";

export interface ScanHit {
  item: MemoryItem;
  rawScore: number;
}

/**
 * Structural self-check counters (integrityCheck). vecBucketOrphans,
 * danglingEntityRefs, danglingTreeChildren and tombstoneOverdue are what a
 * default repairIntegrity pass safely heals; ghostRows is data-loss-grade
 * and heals only through the explicit opt-in; strandedEmbeddings is
 * advisory only — re-embedding is the SpaceMigrator's job — so it never
 * gates `ok`.
 */
export interface IntegrityReport {
  /** vec_buckets rows whose item_id has no LIVE memory_items row. */
  vecBucketOrphans: number;
  /** LIVE items whose entity_id points at no entities row. */
  danglingEntityRefs: number;
  /** tree_nodes child_ids references matching neither a node nor an item. */
  danglingTreeChildren: number;
  /** Tombstones older than the 7-day grace window, not yet purged (GC lag). */
  tombstoneOverdue: number;
  /** LIVE items with vectors outside the active embedding space (migration debt). */
  strandedEmbeddings: number;
  /**
   * LIVE items whose visibility tier's owner column is NULL ('session'
   * without session_id, 'workspace' without workspace_id, 'user' without
   * user_id) — invisible at every level forever. Data-loss grade, so it
   * fails `ok` even though its repair is opt-in (see repairIntegrity).
   */
  ghostRows: number;
  /** True iff every non-advisory class is clean, ghostRows included. */
  ok: boolean;
  /** One human-readable summary line per class (count included). */
  details: string[];
}

/** What one conservative repairIntegrity pass changed; a clean run is all zeros. */
export interface RepairReport {
  vecBucketOrphansRemoved: number;
  danglingEntityRefsCleared: number;
  danglingTreeChildrenPruned: number;
  tombstonesPurged: number;
  /** Ghost rows tombstoned by the explicit opts.ghostRows pass (0 by default). */
  ghostRowsTombstoned: number;
}

/**
 * Scoped census returned by MemoryStore.statsScoped — the per-caller
 * twin of stats()'s counters (see that method for the per-field caliber;
 * every number is restricted to rows visible at the caller's cumulative
 * level through the same tierDisjunction ACL every scoped read uses).
 */
export interface ScopedStats {
  items: Record<MemoryLayer, number>;
  entities: number;
  edges: number;
  patterns: number;
  /** Soft-deleted (not yet purged) rows inside the caller's visible tiers. */
  tombstones: number;
  /** Episodic events attributed to the caller's own session (the events
   *  table predates the visibility-tier ACL and carries session_id only). */
  events: number;
  /** Embedding-space occupancy among the caller's visible live items. */
  spaces: Record<string, number>;
}

/**
 * Admin-plane tier census (stats().byTier): live items grouped by the
 * visibility column. legacyNull counts rows whose visibility IS NULL
 * (pre-ACL legacy rows, which every read path folds into the global
 * branch); keeping it separate from `global` makes that migration debt
 * visible to operators running multi-tenant deployments.
 */
export interface TierCensus {
  session: number;
  workspace: number;
  user: number;
  global: number;
  legacyNull: number;
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

/**
 * JSON.parse with a fallback for corrupt cells. A single damaged TEXT cell
 * (partial write, external editor, bit rot) must never take down a whole
 * read path — every JSON column decode in the store routes through this.
 */
function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }}

export class MemoryStore {
  private db: Database.Database;
  private activeSpace: string | undefined;
  private bus: MemoryEventBus;
  private sqlFnAvailable: boolean;

  private quantized: boolean;

  constructor(opts: StoreOptions, bus: MemoryEventBus = NOOP_BUS) {
    this.activeSpace = opts.activeSpace;
    this.bus = bus;
    this.quantized = (opts.quantization ?? 'int8') === 'int8';
    const path = opts.storagePath;
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    // synchronous stays NORMAL (not FULL): under WAL a crash never
    // corrupts the store — at worst a power cut loses the last committed
    // transaction, the durability/speed trade-off this store has always
    // made. The two pragmas below harden the multi-process story WITHOUT
    // changing that contract:
    this.db.pragma('synchronous = NORMAL');
    // busy_timeout: more than one process can legitimately share this file
    // (plugin host + CLI, a second window, tests). Without a wait SQLite
    // fails a colliding write IMMEDIATELY with SQLITE_BUSY; 5s absorbs
    // normal short WAL write locks instead of surfacing them as errors.
    this.db.pragma('busy_timeout = 5000');
    // wal_autocheckpoint: the WAL only shrinks at checkpoints, and a
    // stream of readers can starve them; capping at 1000 pages (~4MB at
    // default page size) keeps the log bounded without paying a
    // checkpoint on every commit.
    this.db.pragma('wal_autocheckpoint = 1000');
    // No `foreign_keys` pragma: the schema deliberately declares no FOREIGN
    // KEY constraints — edge/bucket/tree references are soft references
    // (bare ids) watched by the integrityCheck self-audit (I-DI-06), so
    // enabling FK enforcement here would be a misleading no-op.
    this.sqlFnAvailable = this.registerCosineFunction();
    this.migrate();
    // Quantization stamp: embedding blobs are encoded per mode, so opening
    // an int8-written database in float32 (or vice versa) would silently
    // misinterpret every stored vector. A missing stamp (fresh database,
    // or a pre-0.21 one whose historical mode is unknowable) is stamped
    // with the CURRENT mode on first open — the guard protects future
    // mode switches, not history.
    const mode = opts.quantization ?? 'int8';
    const stamped = this.getMeta('quantization');
    if (stamped === undefined) {
      this.setMeta('quantization', mode);
    } else if (stamped !== mode) {
      // Close BEFORE throwing: the caller never receives this instance,
      // so nobody could release the WAL handle we are still holding.
      this.db.close();
      throw new Error(
        `[store] quantization mode mismatch: database was written in '${stamped}' mode ` +
        `but opened with '${mode}' — embedding blobs are encoded per mode and would be ` +
        `silently misinterpreted; reopen with the previous retrieval.quantization`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  // ----- Data versioning (cache invalidation stamp) -------------------------
  // PRAGMA user_version doubles as a monotonic data-mutation counter: ANY
  // write (items, tombstones, entities, edges, retention) bumps it. The
  // semantic query cache and the PageRank SWR caches compare it to detect
  // staleness — immune to the count-collision failures of size-based keys.
  //
  // 32-BIT WRAP AND THE EPOCH NAMESPACE. user_version is a signed 32-bit
  // database-header field: pushed past 2147483647 the counter cannot keep
  // growing (on this toolchain the overflowing write lands as 0), and a
  // counter reset to 0 lets OLD small-version cache entries compare fresh
  // again — a false-freshness window that used to be waved off as a
  // "theoretical edge" of a 32-bit stamp. It is closed STRUCTURALLY, by
  // epoch namespace transfer rather than any reset trick: when the counter
  // reaches the ceiling, bumpDataVersionNow writes user_version = 0 AND
  // persistently increments an epoch (palace_meta key 'dataVersionEpoch');
  // every cache compares the COMPOSITE stamp `<epoch>:<version>` from
  // dataVersionStamp(). A wrap therefore moves every comparison into a
  // brand-new namespace in which all pre-wrap entries mismatch by
  // construction — false freshness after a wrap is not merely improbable,
  // it is unrepresentable. The two naive fixes were rejected: clearing the
  // in-memory caches at wrap time cannot reach OTHER processes' caches
  // (plugin host + CLI share this file), and clamping the counter at
  // INT32_MAX freezes the stamp — a frozen stamp silently stops
  // invalidating. Under epoch transfer no cache clearing is EVER needed:
  // old entries carry the old epoch in their stamp and can only mismatch.

  /**
   * Raw 32-bit user_version counter. Kept for stats/tests/diagnostics —
   * cache identity must use dataVersionStamp(): this raw value ALIASES
   * across wraps (version V of epoch E and version V of epoch E+1 are
   * different data states but compare equal here).
   */
  dataVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  /**
   * Cache stamp for BOTH PageRank rank caches (global + PPR). Returns the
   * composite `<epoch>:<version>` identity — the same source of truth the
   * semantic query cache compares — so every version-keyed cache in the
   * process moves into the new namespace together at a wrap.
   */
  graphVersion(): string {
    return this.dataVersionStamp();
  }

  /**
   * Composite cache-invalidation stamp, `<epoch>:<version>`.
   *
   * Wrap detection, single process: our own bumpDataVersionNow performs
   * the wrap (and the epoch write), so the very next stamp read here
   * already carries the new epoch.
   *
   * Wrap detection, MULTIPLE processes (plugin host + CLI sharing this
   * file, a second window, tests): a foreign wrap also resets the counter
   * to 0, and WAL mode makes the other process's committed header write
   * visible to us — so a read BELOW lastSeenVersion is the unique,
   * process-agnostic signal that a wrap happened since our last read. On
   * that signal we re-read the epoch from palace_meta before composing
   * the stamp (one indexed point lookup, paid once per wrap).
   *
   * Multi-process directionality (why a STALE epoch is safe): epochs only
   * ever increment, so this process's cached epoch can only LAG the
   * persisted one, never exceed it. Every entry our caches hold was
   * stamped with an epoch this process observed in the past, i.e. ≤ our
   * current view; refreshing the view upward therefore only ever makes
   * future stamps INCOMPARABLE to existing entries (a miss), never equal
   * to one — and a miss is the safe direction: it costs a recompute, it
   * can never serve stale data. The residual theoretical window would
   * require this process to perform literally ZERO stamp reads while
   * every other user of the file executes an entire 2^31-write wrap cycle
   * AND the counter climbs back past our lastSeenVersion — i.e. this
   * process was doing no retrieval work at all while its cache stayed
   * warm-but-unprobed across ~2^31 write transactions, outside any
   * operational envelope this store targets. Single-process wraps (the
   * common case) are fully closed: the wrapping bump itself updated the
   * epoch in the same transaction.
   */
  dataVersionStamp(): string {
    const v = this.dataVersion();
    if (v < this.lastSeenVersion) {
      // Counter moved DOWN since our last read ⇒ a wrap happened —
      // either ours (versionEpoch already current; the forced re-read is
      // a harmless no-op) or a foreign one (versionEpoch is stale low).
      // Null the cache and re-read palace_meta before composing.
      this.versionEpoch = null;
    }
    this.lastSeenVersion = v;
    return `${this.loadVersionEpoch()}:${v}`;
  }

  /**
   * Persistent epoch half of the composite stamp. Lazily read once from
   * palace_meta ('dataVersionEpoch'); null = "not loaded yet". This is
   * deliberately NOT a schema migration: the v12 palace_meta table
   * already exists on every database this store opens, and a missing row
   * simply means epoch 0 (all pre-wrap history). A corrupt row degrades
   * to 0 as well — the lag-safe direction argued in dataVersionStamp.
   */
  private versionEpoch: number | null = null;

  /**
   * Last user_version THIS process observed through dataVersionStamp().
   * In-memory only. The counter is monotonic EXCEPT at wraps (where it
   * drops to 0), so a read below lastSeenVersion is an unambiguous
   * wrap signal — including wraps performed by other processes.
   */
  private lastSeenVersion = -1;

  /** Load-and-cache the persistent epoch (missing/corrupt meta → 0). */
  private loadVersionEpoch(): number {
    if (this.versionEpoch === null) {
      const raw = this.getMeta('dataVersionEpoch');
      const n = raw === undefined ? 0 : Number(raw);
      this.versionEpoch = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
    }
    return this.versionEpoch;
  }

  /**
   * Bump the data version — deferred inside an ingest batch: mid-batch we
   * only mark the transaction dirty and let ingestTx stamp ONCE at commit,
   * so a batch of N writes costs one increment instead of N.
   */
  private bumpDataVersion(): void {
    if (this.inTxDepth > 0) {
      this._txDirty = true;
      return;
    }
    this.bumpDataVersionNow();
  }

  /**
   * Immediate, unconditional version write (used by the batch wrapper).
   *
   * At the 32-bit ceiling the write becomes the EPOCH WRAP: counter to 0,
   * persistent epoch +1 (see the section header for why no cache clearing
   * accompanies it — the epoch namespace transfer alone retires every
   * old-stamp entry). setMeta deliberately does NOT bump the version
   * (palace_meta is not cache-relevant data), so there is no recursion:
   * the wrap is exactly two writes. Inside an ingestTx both join the
   * already-open transaction — the wrap is atomic with the batch's data,
   * committing or rolling back as one. On the standalone path an explicit
   * transaction keeps the two writes from being torn by a crash between
   * them: user_version=0 without the epoch increment would reopen
   * precisely the false-fresh window the epoch scheme exists to close.
   */
  private bumpDataVersionNow(): void {
    const v = this.dataVersion();
    if (v < 2147483647) {
      this.db.pragma(`user_version = ${v + 1}`);
      return;
    }
    const wrap = (): void => {
      this.db.pragma('user_version = 0');
      this.versionEpoch = this.loadVersionEpoch() + 1;
      this.setMeta('dataVersionEpoch', String(this.versionEpoch));
    };
    if (this.inTxDepth > 0) {
      wrap(); // joins the open ingestTx — one atomic commit
    } else {
      this.db.transaction(wrap)(); // standalone — still one atomic commit
    }
  }

  private bumpGraphVersion(): void {
    this.bumpDataVersion();
  }

  private inTxDepth = 0;

  /** True when the current ingest batch performed at least one write. */
  private _txDirty = false;

  /**
   * Mark the enclosing ingest batch as dirty — for writes that never bump
   * the version standalone (e.g. event inserts) but must still force the
   * batch's commit-time stamp. No-op outside a batch.
   */
  private markTxDirty(): void {
    if (this.inTxDepth > 0) this._txDirty = true;
  }

  /**
   * Run a batch of writes as ONE transaction: atomic commit, single WAL
   * flush, and a guaranteed graph-version stamp for the whole batch.
   * Nested calls join the outermost transaction (better-sqlite3 turns
   * them into savepoints). Pure reads inside are fine too — and thanks to
   * the _txDirty flag, read-only batches no longer trigger the commit-time
   * stamp, so they stop needlessly invalidating the semantic query cache
   * and the PageRank SWR caches.
   */
  ingestTx<T>(fn: () => T): T {
    if (this.inTxDepth > 0) return fn(); // join outer batch
    this.inTxDepth = 1;
    const versionBefore = this.graphVersion();
    try {
      const out = this.db.transaction(() => {
        const r = fn();
        // Stamp INSIDE the transaction so data and version commit
        // atomically — and only when the batch actually wrote something.
        if (this._txDirty && this.graphVersion() === versionBefore) {
          this.bumpDataVersionNow();
        }
        return r;
      })();
      return out;
    } finally {
      // Genesis self-check BEFORE the reset: once the wrapped batch is
      // done — committed OR rolled back — the depth counter must be back
      // at this batch's base level (net nesting of zero). A future write
      // path that touched the counter without unwinding would otherwise
      // corrupt every later batch's commit-time stamping silently.
      invariant(
        this.inTxDepth === 1,
        `ingestTx: transaction depth must unwind to zero after commit (got ${this.inTxDepth}, expected the batch base 1)`,
      );
      this.inTxDepth = 0;
      this._txDirty = false;
    }
  }

  /** Register mp_cosine as a deterministic SQL scalar function. */
  private registerCosineFunction(): boolean {
    const quantized = this.quantized;
    const fn = (a: unknown, b: unknown): number => {
      if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return 0;
      if (a.byteLength === 0 || b.byteLength === 0) return 0;
      let r: number;
      if (quantized) {
        // Integer hot path: both blobs are int8 payloads.
        const ia = new Int8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
        const ib = new Int8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        r = int8Cosine(ia, ib);
      } else {
        r = cosine(bufferToF32(a), bufferToF32(b));
      }
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
    // Each table checks every column independently (mirroring the
    // memory_items style above): the old "first column only" gate let a
    // process that died mid-ALTER leave a half-migrated table that the
    // next boot refused to heal — the remaining columns were skipped
    // because 'visibility' already existed.
    const entCols = new Set(
      (this.db.prepare('PRAGMA table_info(entities)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!entCols.has('visibility')) {
      this.db.exec('ALTER TABLE entities ADD COLUMN visibility TEXT');
    }
    if (!entCols.has('user_id')) {
      this.db.exec('ALTER TABLE entities ADD COLUMN user_id TEXT');
    }
    if (!entCols.has('workspace_id')) {
      this.db.exec('ALTER TABLE entities ADD COLUMN workspace_id TEXT');
    }
    if (!entCols.has('session_id')) {
      this.db.exec('ALTER TABLE entities ADD COLUMN session_id TEXT');
    }
    const edgeCols = new Set(
      (this.db.prepare('PRAGMA table_info(graph_edges)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!edgeCols.has('visibility')) {
      this.db.exec('ALTER TABLE graph_edges ADD COLUMN visibility TEXT');
    }
    if (!edgeCols.has('user_id')) {
      this.db.exec('ALTER TABLE graph_edges ADD COLUMN user_id TEXT');
    }
    if (!edgeCols.has('workspace_id')) {
      this.db.exec('ALTER TABLE graph_edges ADD COLUMN workspace_id TEXT');
    }
    if (!edgeCols.has('session_id')) {
      this.db.exec('ALTER TABLE graph_edges ADD COLUMN session_id TEXT');
    }
    // --- v5 migration: visibility-tier ACL on procedural_patterns ---------
    // Patterns carried no owner columns, so every pattern was visible to
    // every caller. They now mirror the items/entities/edges tier columns;
    // pre-v5 rows backfill as global (they were typically single-user).
    // Per-column checks for the same crash-resume reason as v4 above.
    const patCols = new Set(
      (this.db.prepare('PRAGMA table_info(procedural_patterns)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!patCols.has('visibility')) {
      this.db.exec('ALTER TABLE procedural_patterns ADD COLUMN visibility TEXT');
    }
    if (!patCols.has('user_id')) {
      this.db.exec('ALTER TABLE procedural_patterns ADD COLUMN user_id TEXT');
    }
    if (!patCols.has('workspace_id')) {
      this.db.exec('ALTER TABLE procedural_patterns ADD COLUMN workspace_id TEXT');
    }
    if (!patCols.has('session_id')) {
      this.db.exec('ALTER TABLE procedural_patterns ADD COLUMN session_id TEXT');
    }
    // --- v6 migration: the core SELF (blocks + version audit history) -------
    // Core blocks are the palace's persistent working memory (profile /
    // project / goals). They are REWRITTEN, not appended; every rewrite
    // is versioned into core_history so no version of the self is lost.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_blocks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        token_cap INTEGER NOT NULL DEFAULT 220,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        visibility TEXT,
        user_id TEXT,
        workspace_id TEXT,
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_core_scope ON core_blocks(visibility, user_id);
      CREATE TABLE IF NOT EXISTS core_history (
        block_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (block_id, version)
      );
    `);

    // --- v7 migration: query trajectory log (intent prediction input) ------
    // Every non-speculative retrieve appends one row; the intent predictor
    // trains Markov sequences over these. Bounded by pruning in logQuery.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id TEXT,
        workspace_id TEXT,
        query TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qlog_user_time ON query_log(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_qlog_session ON query_log(session_id);
    `);

    // --- v8 migration: IVF vector-bucket index --------------------------------
    // Rows are bucketed by the shared anchor planes (utils/ivf.ts); the
    // index is a pure accelerator — retrieval escalates probe radius until
    // the candidate pool is satisfied, and ALL keys == the exact scan.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_buckets (
        space TEXT NOT NULL,
        bucket_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (space, bucket_key, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_vecbuckets_probe
        ON vec_buckets(space, bucket_key);
    `);

    // --- v9 migration: bandit state + reward events (feedback learning) ------
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bandit_state (
        scope_key TEXT PRIMARY KEY,
        arm TEXT NOT NULL,
        value REAL NOT NULL,
        reward REAL NOT NULL DEFAULT 0,
        attempts REAL NOT NULL DEFAULT 0,
        updates INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bandit_rewards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        query TEXT NOT NULL,
        reward REAL NOT NULL,
        evidence_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bandit_rewards_scope
        ON bandit_rewards(scope_key, created_at);
    `);

    // --- v10 migration: stratification tree (hippocampus → neocortex) --------
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tree_nodes (
        node_id TEXT PRIMARY KEY,
        level TEXT NOT NULL CHECK (level IN ('session','week','month','era')),
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        child_ids TEXT NOT NULL DEFAULT '[]',
        item_id TEXT,
        user_id TEXT,
        workspace_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tree_level_period
        ON tree_nodes(level, period_start);
      CREATE INDEX IF NOT EXISTS idx_tree_user ON tree_nodes(user_id);
    `);

    // --- v11 migration: CRDT op log (multi-master federation) -----------------
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crdt_ops (
        op_id TEXT PRIMARY KEY,
        replica TEXT NOT NULL,
        counter INTEGER NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_crdt_ops_replica ON crdt_ops(replica, counter);
    `);

    // --- v12 migration: palace_meta + per-arm bandit PK -----------------------
    // Schema changes here stay STRUCTURAL and idempotent like every step
    // above: PRAGMA user_version doubles as an unbounded data-mutation
    // counter (cache invalidation stamp), so it cannot double as a schema
    // version gate — each step must be safe to re-run on every boot.
    // palace_meta: tiny KV store for values that must survive restarts
    // but are NOT cache-relevant data (e.g. the generated palaceId).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS palace_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // bandit_state's PK was scope_key alone, so one scope could only ever
    // keep ONE arm row — each saveBanditArm clobbered the sibling arms.
    // Rebuild with PK (scope_key, arm); legacy rows (one per scope, each
    // already carrying its arm) are copied verbatim. Idempotent: after the
    // rebuild, table_info reports arm as part of the PK and the guard
    // never fires again.
    const banditCols = this.db.prepare('PRAGMA table_info(bandit_state)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const armInPk = banditCols.find((c) => c.name === 'arm')?.pk ?? 0;
    // Rebuild is fully re-runnable: the table_info pk guard skips it once
    // the new PK is in place, and the leading DROP clears any v12 leftover
    // from a process that died mid-migration (a stale bandit_state_v12
    // would otherwise make the CREATE fail on the next boot while the pk
    // guard still sees the unmigrated table).
    if (armInPk === 0) {
      this.db.exec(`
        DROP TABLE IF EXISTS bandit_state_v12;
        CREATE TABLE bandit_state_v12 (
          scope_key TEXT NOT NULL,
          arm TEXT NOT NULL,
          value REAL NOT NULL,
          reward REAL NOT NULL DEFAULT 0,
          attempts REAL NOT NULL DEFAULT 0,
          updates INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope_key, arm)
        );
        INSERT INTO bandit_state_v12 (scope_key, arm, value, reward, attempts, updates, updated_at)
          SELECT scope_key, arm, value, reward, attempts, updates, updated_at
          FROM bandit_state;
        DROP TABLE bandit_state;
        ALTER TABLE bandit_state_v12 RENAME TO bandit_state;
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
    if (this.quantized) {
      return Buffer.from(quantizeToInt8(v).buffer, 0, v.length);
    }
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  private bufferToEmbedding(b: Buffer): Float32Array {
    // The store's quantization mode is authoritative — int8 blobs are
    // b.length bytes = b.length dims; float32 blobs are b.length/4 dims.
    if (this.quantized) {
      const q = new Int8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      return dequantizeToFloat32(q);
    }
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
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- sanctioned legacy INPUT alias: the deprecation note itself specifies this insert-time read to derive the tier before the copy is stripped below.
      item.metadata.visibility ??
      (ctx.userId
        ? 'user'
        : ctx.workspaceId
          ? 'workspace'
          : ctx.sessionId ?? item.metadata.sessionId
            ? 'session'
            : 'global');
    // Single source of truth: the visibility COLUMN (plus rowToItem's
    // item-level backfill from it) owns the tier. metadata.visibility is
    // a legacy INPUT alias only — it steered the derivation above, and is
    // stripped from the persisted JSON below so no reader can ever treat
    // the metadata copy as authoritative. The strip happens on a spread
    // COPY, never on the caller's object.
    const persistedMetadata: MemoryMetadata = { ...item.metadata };
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the strip IS the migration: dropping the legacy alias copy from the persisted JSON is mandated by the single-source-of-truth rule above.
    delete persistedMetadata.visibility;
    this.bus.emit('memory.before-store', { id: item.id, layer: item.layer, scope: ctx });
    // INSERT ... ON CONFLICT(id) DO UPDATE instead of INSERT OR REPLACE:
    // REPLACE rewrites the WHOLE row, which would blank deleted_at /
    // superseded_by and RESURRECT a tombstoned item — re-ingesting the
    // same id could thus silently bypass right-to-be-forgotten. The
    // conflict update therefore deliberately NEVER touches deleted_at /
    // superseded_by / created_at / access_count / last_accessed_at —
    // lifecycle and audit columns stay owned by their dedicated paths.
    const stmt = this.db.prepare(`
      INSERT INTO memory_items
        (id, layer, content, embedding, metadata, created_at, updated_at,
         importance, access_count, last_accessed_at, entity_id, workspace_id,
         user_id, session_id, embedding_space, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        layer = excluded.layer,
        content = excluded.content,
        embedding = excluded.embedding,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at,
        importance = excluded.importance,
        entity_id = excluded.entity_id,
        session_id = excluded.session_id,
        embedding_space = excluded.embedding_space,
        workspace_id = excluded.workspace_id,
        user_id = excluded.user_id,
        visibility = excluded.visibility
    `);
    stmt.run(
      item.id,
      item.layer,
      item.content,
      item.embedding ? this.embeddingToBuffer(item.embedding) : null,
      JSON.stringify(persistedMetadata),
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
      // Source + content let downstream bridges (e.g. the CRDT item-set
      // hook in the plugin entry) filter without re-reading the row.
      source: item.metadata.source,
      content: item.content,
    });
    // IVF: bucket every vectorized row (fixed planes — deterministic).
    // Wipe the item's old bucket rows FIRST: a re-ingest may carry a new
    // embedding (different anchor key) or none at all, and leftover keys
    // would bloat the index with dead pointers.
    this.db.prepare('DELETE FROM vec_buckets WHERE item_id = ?').run(item.id);
    if (item.embedding && space) {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO vec_buckets (space, bucket_key, item_id) VALUES (?, ?, ?)',
        )
        .run(space, anchorKeyOf(item.embedding), item.id);
    }
    this.bumpDataVersion();
  }

  upsertItem(
    item: MemoryItem,
    ctx: { workspaceId?: string; userId?: string; sessionId?: string },
  ): void {
    this.insertItem(item, ctx);
  }

  /**
   * Fetch one item by id. `liveOnly` appends the LIVE (non-tombstoned,
   * non-superseded) filter; the DEFAULT is deliberately false so undo /
   * audit / purge paths can still read soft-deleted rows — callers that
   * must only ever see live memory opt in explicitly.
   */
  getItem(id: string, opts?: { liveOnly?: boolean }): MemoryItem | null {
    const live = opts?.liveOnly ? ` AND ${LIVE}` : '';
    const row = this.db
      .prepare(`SELECT * FROM memory_items WHERE id = ?${live}${UNEXPIRED}`)
      .get(id, MemoryStore.nowBound()) as ItemRow | undefined;
    return row ? this.rowToItem(row) : null;
  }

  deleteItem(id: string): void {
    this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM vec_buckets WHERE item_id = ?').run(id);
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

  /**
   * Undo a tombstone. Returns false when nothing to restore.
   *
   * Only deleted_at is cleared: superseded_by is deliberately KEPT —
   * un-superseding here would leave an item and its successor both live
   * (two active versions of the same memory). Fully reviving a superseded
   * row requires dealing with its successor first; that is a caller
   * decision, not a silent side effect of undo.
   */
  restoreItem(id: string): boolean {
    const res = this.db
      .prepare('UPDATE memory_items SET deleted_at = NULL WHERE id = ?')
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
   * Exact-content membership probe (capsule import dedupe). Rare-path full
   * scan is acceptable — imports are infrequent and bounded by capsule size.
   *
   * The hard-coded LIMIT 2 is exists-probe semantics, not a list cap: the
   * question is "is this exact content already stored" (membership), so at
   * most two ids are materialized — one answers existence, a second flags
   * multiplicity. Do NOT use this to enumerate matches; it silently
   * truncates.
   */
  findItemIdsByContent(content: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM memory_items WHERE content = ? LIMIT 2')
      .all(content) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Exact-content membership restricted to a cumulative scope level — the
   * capsule-import dedupe path. The unscoped variant above matches rows
   * from ANY tenant (same text, different owner) and would silently
   * swallow a legitimate import as a "duplicate"; the tier ACL keeps the
   * comparison inside the importer's own boundary. LIVE + UNEXPIRED, the
   * same visibility caliber as every read path: a tombstoned row's or an
   * expired-but-not-yet-swept row's content must not swallow a legitimate
   * re-import — the memory was forgotten on purpose (or is already
   * invisible to retrieval).
   */
  findItemIdsByContentScoped(level: ScopeLevelClause, content: string, limit = 5): string[] {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(
        `SELECT id FROM memory_items WHERE ${LIVE}${UNEXPIRED} AND content = ? AND (${disj.sql}) LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), content, ...disj.params, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Substring-content membership for derived statements: the Inferencer
   * stores confidence-branded text ("Inferred (78%): …") but must dedupe
   * against a confidence-free key, so exact equality can never hit. LIKE
   * wildcards in the needle are escaped; % on both sides keeps it a
   * containment match. Rare-path scan, bounded by LIMIT.
   *
   * LIVE + UNEXPIRED (tombstones are forgotten memories, and an expired
   * row pending its TTL sweep is invisible to retrieval — neither may
   * suppress fresh derivations), and when a `level` is given the tier ACL
   * restricts the match to the caller's cascade: without it a tombstoned
   * (or foreign-tenant) row containing the needle suppressed derivation
   * for EVERY caller.
   *
   * The optional level may be passed as EITHER the second or the third
   * argument (with the numeric limit in the other slot) — both positional
   * conventions exist among callers, so the parameters are normalized at
   * runtime instead of forcing one spelling.
   */
  findItemIdsByContentContaining(
    needle: string,
    levelOrLimit?: ScopeLevelClause | number,
    limitOrLevel?: ScopeLevelClause | number,
  ): string[] {
    if (!needle) return [];
    let level: ScopeLevelClause | undefined;
    let limit = 5;
    if (typeof levelOrLimit === 'number') limit = levelOrLimit;
    else if (levelOrLimit) level = levelOrLimit;
    if (typeof limitOrLevel === 'number') limit = limitOrLevel;
    else if (limitOrLevel) level = limitOrLevel;
    const escaped = needle.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const disj = level ? tierDisjunction(level.tiers, level.ids) : null;
    if (level && !disj) return [];
    const acl = disj ? ` AND (${disj.sql})` : '';
    const rows = this.db
      .prepare(
        `SELECT id FROM memory_items WHERE ${LIVE}${UNEXPIRED} AND content LIKE ? ESCAPE '\\'${acl} LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), `%${escaped}%`, ...(disj ? disj.params : []), limit) as {
        id: string;
      }[];
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
      invariant(widest !== undefined, 'levels is non-empty, so its widest element exists');
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
    const n = this.db
      .prepare('DELETE FROM episodic_events WHERE ts <= ?')
      .run(Date.now() - olderThanMs).changes;
    // Retention deletes change what summarization will see again — same
    // cache-stamp discipline as every other write path.
    if (n > 0) this.bumpDataVersion();
    return n;
  }

  /**
   * Enforce metadata.expiresAt TTLs: tombstone (recoverably) every live
   * item whose expiry has passed. Uses SQLite JSON1 for a single set-based
   * sweep — no row materialization in JS.
   */
  sweepExpiredItems(): number {
    // json_valid guard: malformed metadata never throws here — it reads as
    // "no expiry" from every read path, so the sweeper skips it too (the
    // row stays live; repairing corrupt cells is not the sweeper's job).
    const n = this.db
      .prepare(
        `UPDATE memory_items SET deleted_at = ?
         WHERE deleted_at IS NULL AND superseded_by IS NULL
           AND json_valid(metadata)
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
   * Scoped cascade delete for an entity (GDPR-style right-to-be-forgotten
   * unit) — the tenant-safe replacement for the deprecated full variant.
   *
   * Only what the caller's cumulative `level` may see is touched:
   *   - linked items: tombstoned via itemsForEntityScoped (batch-drained),
   *   - edges: hard-deleted only when the edge row itself is visible at
   *     the level,
   *   - the entity row: hard-deleted only when its tier is NOT 'global'
   *     AND it is visible at the level. Global entities are shared
   *     knowledge-base rows — a stranger deleting the shared graph for
   *     everyone is not a right-to-be-forgotten, it is vandalism. A
   *     non-global entity outside the caller's cascade (another tenant's
   *     private entity) is likewise preserved.
   *
   * The version stamp only moves when something actually changed.
   */
  deleteEntityCascadeScoped(
    level: ScopeLevelClause,
    entityId: string,
  ): { itemsTombstoned: number; edgesDeleted: number; entityDeleted: boolean } {
    const disj = tierDisjunction(level.tiers, level.ids);
    let tombstoned = 0;
    if (disj) {
      // Drain in batches: itemsForEntityScoped caps a single fetch, so an
      // entity with more visible linked items needs repeated
      // fetch→tombstone rounds until the visible LIVE set is empty. The
      // 50-round ceiling is a paranoia guard against a non-draining loop.
      for (let round = 0; round < 50; round++) {
        const batch = this.itemsForEntityScoped(level, entityId, 5000);
        if (batch.length === 0) break;
        for (const it of batch) {
          if (this.tombstoneItem(it.id)) tombstoned++;
        }
      }
    }
    let edges = 0;
    if (disj) {
      edges = this.db
        .prepare(
          `DELETE FROM graph_edges
           WHERE (from_id = ? OR to_id = ?) AND (${disj.sql})`,
        )
        .run(entityId, entityId, ...disj.params).changes;
    }
    let entityDeleted = false;
    const ent = this.db
      .prepare('SELECT visibility, user_id, workspace_id, session_id FROM entities WHERE id = ?')
      .get(entityId) as
      | { visibility: string | null; user_id: string | null; workspace_id: string | null; session_id: string | null }
      | undefined;
    if (ent) {
      const tier = (ent.visibility ?? 'global') as VisibilityTier;
      // Global entities stay (shared); foreign private entities stay
      // (invisible); own non-global entities go.
      if (tier !== 'global' && visibleAtLevel(
        {
          visibility: tier,
          // visibleAtLevel's row shape takes `string | null` directly —
          // the null-coalescing `?? undefined` widening is unnecessary.
          userId: ent.user_id,
          workspaceId: ent.workspace_id,
          sessionId: ent.session_id,
        },
        level,
      )) {
        entityDeleted =
          this.db.prepare('DELETE FROM entities WHERE id = ?').run(entityId).changes > 0;
      }
    }
    if (tombstoned > 0 || edges > 0 || entityDeleted) this.bumpGraphVersion();
    return { itemsTombstoned: tombstoned, edgesDeleted: edges, entityDeleted };
  }

  /**
   * @deprecated UNSCOPED full cascade delete — ignores the visibility-tier
   * ACL: it tombstones every tenant's items linked to the entity,
   * hard-deletes every tenant's edges, and removes GLOBAL (shared)
   * entities on any caller's behalf. Kept only for administrative /
   * single-tenant maintenance paths; every request-facing caller must use
   * deleteEntityCascadeScoped(level, entityId) with the caller's cascade.
   */
  deleteEntityCascade(entityId: string): { items: number; edges: number } {
    // Drain in batches: itemsForEntity caps a single fetch (5000 here), so
    // an entity with more linked items needs repeated fetch→tombstone
    // rounds until the LIVE set is empty — otherwise rows beyond the cap
    // would survive a right-to-be-forgotten request. The 50-round ceiling
    // (~250k items) is a paranoia guard against a non-draining loop.
    let tombstoned = 0;
    for (let round = 0; round < 50; round++) {
      const batch = this.itemsForEntity(entityId, 5000);
      if (batch.length === 0) break;
      for (const it of batch) {
        if (this.tombstoneItem(it.id)) tombstoned++;
      }
    }
    const edges = this.db
      .prepare('DELETE FROM graph_edges WHERE from_id = ? OR to_id = ?')
      .run(entityId, entityId).changes;
    const entities = this.db.prepare('DELETE FROM entities WHERE id = ?').run(entityId).changes;
    // Same contract as the Scoped variant: bump only when something was
    // actually removed — a no-op delete on a missing id must not pose as a
    // graph mutation and needlessly invalidate version caches.
    if (tombstoned > 0 || edges > 0 || entities > 0) this.bumpGraphVersion();
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

  /**
   * LIVE, unexpired items whose vectors sit in a space OTHER than the
   * target (embedding not null) — the stranded set SpaceMigrator heals.
   * Importance-first so a bounded budget re-indexes the most valuable
   * memories first.
   */
  listItemsInOtherSpaces(targetSpace: string, limit = 100): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${LIVE}${UNEXPIRED}
           AND embedding IS NOT NULL
           AND embedding_space IS NOT NULL AND embedding_space != ?
         ORDER BY importance DESC, created_at DESC LIMIT ?`,
      )
      .all(MemoryStore.nowBound(), targetSpace, limit) as ItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * PHYSICAL re-index: rebind one item's vector to a new embedding
   * space. Content, timestamps, tombstone/supersession and visibility
   * columns are untouched — flashback integrity is preserved exactly.
   * Returns false when the id does not exist.
   */
  migrateItemToSpace(
    id: string,
    embedding: Float32Array,
    space: string,
    metadata: MemoryMetadata,
  ): boolean {
    const res = this.db
      .prepare(
        'UPDATE memory_items SET embedding = ?, embedding_space = ?, metadata = ? WHERE id = ?',
      )
      .run(this.embeddingToBuffer(embedding), space, JSON.stringify(metadata), id);
    if (res.changes > 0) {
      // Space changed → re-bucket under the new space's partition.
      this.db.prepare('DELETE FROM vec_buckets WHERE item_id = ?').run(id);
      this.db
        .prepare('INSERT OR REPLACE INTO vec_buckets (space, bucket_key, item_id) VALUES (?, ?, ?)')
        .run(space, anchorKeyOf(embedding), id);
      this.bumpDataVersion();
    }
    return res.changes > 0;
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
    // Named-parameter binding throughout. These statements used to be a
    // hand-aligned positional argument list, where inserting or removing
    // ONE fragment silently shifted every later bind — a misalignment
    // class with no compile-time or runtime symptom. With @names each
    // fragment declares its own binds and textual order stops mattering.
    // Every placeholder in the final SQL is named: fragments emitted by
    // tierDisjunction (anonymous "?") are rewritten to generated @sN
    // names below, because a statement mixing anonymous and named
    // parameters cannot be bound by object.
    const bind: Record<string, unknown> = { layer: opts.layer, space: opts.space };
    // Legacy NULL-space rows join the active space's scan.
    const spacePredicate =
      opts.space === this.activeSpace
        ? '(embedding_space = @space OR embedding_space IS NULL)'
        : 'embedding_space = @space';
    const time: string[] = [];
    if (opts.sinceMs !== undefined) {
      time.push('created_at >= @since');
      bind.since = opts.sinceMs;
    }
    if (opts.untilMs !== undefined) {
      time.push('created_at <= @until');
      bind.until = opts.untilMs;
    }
    const timeClause = time.length ? ` AND ${time.join(' AND ')}` : '';

    // FLASHBACK (asOfMs): reconstruct the store as of a past instant —
    // items existed then iff created_at <= T, and neither tombstoned nor
    // superseded before T (both record the transition in deleted_at).
    // Expiry is evaluated against T as well, so beliefs whose TTL had not
    // yet elapsed at T remain visible.
    const asOf = opts.asOfMs;
    const liveSql =
      asOf !== undefined ? '(deleted_at IS NULL OR deleted_at > @asof)' : LIVE;
    const unexpiredSql =
      asOf !== undefined
        ? " AND (NOT json_valid(metadata) OR json_extract(metadata, '$.expiresAt') IS NULL OR json_extract(metadata, '$.expiresAt') > @asof)"
        : " AND (NOT json_valid(metadata) OR json_extract(metadata, '$.expiresAt') IS NULL OR json_extract(metadata, '$.expiresAt') > @now)";
    const createdLeSql = asOf !== undefined ? ' AND created_at <= @asof' : '';
    if (asOf !== undefined) bind.asof = asOf;
    else bind.now = MemoryStore.nowBound();

    // Scope fragment: rewrite its anonymous "?" placeholders (in order —
    // every "?" in the tier SQL is a bind placeholder; the module never
    // inlines values) to generated @sN names bound from scope.params.
    const scopeChunks = scope.sql.split('?');
    let scopeSql = '';
    for (let i = 0; i < scopeChunks.length - 1; i++) {
      scopeSql += `${scopeChunks[i] ?? ''}@s${i}`;
      bind[`s${i}`] = scope.params[i] ?? null;
    }
    scopeSql += scopeChunks[scopeChunks.length - 1] ?? '';

    // IVF restriction: join through the bucket table when probe keys given.
    // The IN-list stays on generated per-key placeholders — all values come
    // from the store's own allBucketKeys set, so there is no injection
    // surface; the subquery shares the single @space bind.
    const bucketGuard =
      opts.buckets && opts.buckets.length > 0
        ? ' AND id IN (SELECT item_id FROM vec_buckets WHERE space = @space AND bucket_key IN (' +
            opts.buckets.map((_, i) => `@b${i}`).join(',') + '))'
        : '';
    if (opts.buckets && opts.buckets.length > 0) {
      for (let i = 0; i < opts.buckets.length; i++) {
        bind[`b${i}`] = opts.buckets[i];
      }
    }

    if (this.sqlFnAvailable) {
      const sql = `
        SELECT *, mp_cosine(embedding, @vec) AS score
        FROM memory_items
        WHERE ${liveSql}${unexpiredSql}${createdLeSql} AND layer = @layer AND embedding IS NOT NULL
          AND ${spacePredicate}${timeClause}${scopeSql}${bucketGuard}
        ORDER BY score DESC
        LIMIT @limit
      `;
      const bound = { ...bind, vec: qbuf, limit: opts.limit };
      // Genesis guard: fragments above add/remove named parameters as
      // branches toggle — a one-sided edit now fails LOUDLY on first
      // execution (with the offending key names) instead of silently
      // mis-binding the whole statement.
      assertNamedParamParity(sql, bound);
      const rows = this.db.prepare(sql).all(bound) as Array<
        ItemRow & { score: number }
      >;
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
      WHERE ${liveSql}${unexpiredSql}${createdLeSql} AND layer = @layer AND embedding IS NOT NULL
        AND ${spacePredicate}${timeClause}${scopeSql}${bucketGuard}
      LIMIT @limit
    `;
    const bound = { ...bind, limit: Math.max(opts.limit, 50_000) };
    // Same genesis guard as the pushdown branch — this fallback still
    // prepares a named-parameter SQL statement (only the scoring moved
    // to JS), so it gets the identical parity self-check.
    assertNamedParamParity(sql, bound);
    const rows = this.db
      .prepare(sql)
      .iterate(bound) as IterableIterator<ItemRow>;
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
   *
   * Deliberately does NOT bump the data version: access stats are
   * per-item bookkeeping, not retrieval-relevant content, and retrieval
   * happens on EVERY query — bumping here would keep the semantic query
   * cache and the PageRank SWR caches permanently invalidated (a cache
   * that misses on every access is no cache). A slightly stale
   * access_count in a cached view costs nothing.
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
    // Portable subquery form: `DELETE ... WHERE ... ORDER BY ... LIMIT`
    // is only accepted when SQLite is compiled with
    // SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which is NOT guaranteed across
    // builds/platforms. Deleting by `id IN (SELECT ...)` with the SAME
    // predicate, order and limit is valid everywhere and semantically
    // equivalent: the uncorrelated subquery is evaluated first on the same
    // connection, so it selects exactly the rows the direct form would
    // have deleted.
    const result = this.db
      .prepare(
        `DELETE FROM memory_items WHERE id IN (
           SELECT id FROM memory_items WHERE ${where.join(' AND ')}
           ORDER BY created_at ASC LIMIT ?
         )`,
      )
      .run(...params, limit);
    if (result.changes > 0) this.bumpDataVersion();
    return result.changes;
  }

  // ----- Episodic events ---------------------------------------------------

  insertEvent(ev: EpisodicEvent): void {
    // Events never bump the version standalone (they are not retrieval
    // state), but inside an ingest batch they must still mark the batch
    // dirty so the wrapper's commit-time stamp covers them.
    this.markTxDirty();
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
      payload: safeJson<EpisodicEvent['payload']>(r.payload, null),
      ts: r.ts,
      // exactOptionalPropertyTypes: an unset lineage pointer omits the key.
      ...(r.summarized_as !== null ? { summarizedAs: r.summarized_as } : {}),
    }));
  }

  markEventSummarized(eventId: string, semanticItemId: string): void {
    // Same treatment as insertEvent: dirty-the-batch only, no standalone
    // bump (see markTxDirty).
    this.markTxDirty();
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
      aliases: safeJson<Entity['aliases']>(row.aliases, []),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      mentionCount: row.mention_count,
    };
  }

  /**
   * @deprecated Legacy unscoped read — ignores the visibility-tier ACL and
   * can return another tenant's entity; new code must use findEntityInScope
   * (widening) or findEntityAtTier (exact ingest dedupe).
   */
  getEntity(id: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
      | EntityRow
      | undefined;
    return row ? this.entityRowToEntity(row) : null;
  }

  /**
   * @deprecated Legacy unscoped read — no tier ACL, matches entities from
   * any tenant; use findEntityAtTier (ingest dedupe) or findEntityInScope
   * (scoped retrieval) instead.
   */
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

  /**
   * Insert an edge whose weight only ever RISES: on conflict the stored
   * weight is refreshed to MAX(old, new) — SQLite's two-argument MAX is
   * the scalar max, i.e. "a strictly stronger claim wins, else keep".
   * Unlike upsertEdge (additive weights), repeated nightly inference
   * cannot inflate an edge into dominance — the Inferencer uses this for
   * its inf:reaches edges. ACL columns and the created_at refresh mirror
   * upsertEdge exactly (note: created_at actually means lastSeenAt, see
   * listEdgesScoped).
   */
  upsertEdgeIfStronger(
    fromId: string,
    toId: string,
    relation: string,
    weight: number,
    ctx: { visibility: VisibilityTier } & Partial<ScopeIdentity> = { visibility: 'global' },
  ): void {
    this.db
      .prepare(
        `INSERT INTO graph_edges (from_id, to_id, relation, weight, created_at,
           visibility, user_id, workspace_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
           weight = MAX(graph_edges.weight, excluded.weight),
           created_at = excluded.created_at`,
      )
      .run(
        fromId,
        toId,
        relation,
        weight,
        Date.now(),
        ctx.visibility,
        ctx.userId ?? null,
        ctx.workspaceId ?? null,
        ctx.sessionId ?? null,
      );
    this.bumpGraphVersion();
  }

  /** @deprecated Legacy unscoped read — no tier ACL; use listEdgesScoped. */
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

  /**
   * Edges visible at a cumulative scope level, with last-seen timestamps.
   *
   * NOTE: graph_edges.created_at is REFRESHED on every upsert conflict
   * (upsertEdge / upsertEdgeIfStronger both SET created_at =
   * excluded.created_at), so it does NOT record first observation — its
   * actual semantics are lastSeenAt, which is exactly how the mapping
   * below exposes it.
   */
  listEdgesScoped(
    level: ScopeLevelClause,
  ): Array<{ from: string; to: string; relation: string; weight: number; lastSeenAt: number }> {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, relation, weight, created_at FROM graph_edges WHERE (${disj.sql})`,
      )
      .all(...disj.params) as {
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
      evidence: safeJson<string[]>(r.evidence, []),
      confidence: r.confidence,
      createdAt: r.created_at,
    }));
  }

  /**
   * Write (or reinforce) a procedural pattern. `scope` stamps the owner
   * tier columns (default global, mirroring upsertEntity/upsertEdge); the
   * scope is immutable on conflict — a re-mined pattern only refreshes
   * description/evidence/confidence, never re-attributes ownership.
   *
   * No-op fast path: when pattern text, description and confidence are
   * all unchanged the row is not written and the data version is NOT
   * bumped — mining passes re-emit the same patterns every cycle, and
   * each unconditional write used to invalidate the semantic query cache
   * and the PageRank SWR caches on every pass over a quiescent library.
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
    const existing = this.db
      .prepare('SELECT pattern, description, confidence FROM procedural_patterns WHERE id = ?')
      .get(p.id) as { pattern: string; description: string; confidence: number } | undefined;
    if (
      existing &&
      existing.pattern === p.pattern &&
      existing.description === p.description &&
      existing.confidence === p.confidence
    ) {
      return; // re-mined, byte-identical — nothing to write, nothing to invalidate
    }
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
    // Pattern writes change what procedural injection can surface — same
    // cache-stamp discipline as every other write path.
    this.bumpDataVersion();
  }

  /**
   * @deprecated Legacy unscoped read — no tier ACL; use listPatternsScoped.
   * (All patterns, unscoped, kept for legacy/compat callers only.)
   */
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

  // ----- Core SELF blocks (persistent working memory) ------------------------

  /** Core blocks visible at a cumulative scope level. */
  listCoreBlocks(level: ScopeLevelClause): CoreBlock[] {
    return this.listCoreBlocksWhere<CoreBlock>(level, 'core_blocks', (row) => ({
      id: row.id as string,
      name: row.name as CoreBlock['name'],
      content: row.content as string,
      tokenCap: row.token_cap as number,
      version: row.version as number,
      updatedAt: row.updated_at as number,
    }));
  }

  /**
   * Upsert a core block + push the previous version into the audit
   * history (bounded to the last 20 versions per block).
   */
  upsertCoreBlock(
    block: {
      id: string;
      name: CoreBlock['name'];
      content: string;
      tokenCap: number;
      version: number;
      updatedAt: number;
    },
    scope: { visibility: VisibilityTier } & Partial<ScopeIdentity>,
  ): CoreBlock {
    const previous = this.db
      .prepare('SELECT version, content FROM core_blocks WHERE id = ?')
      .get(block.id) as { version: number; content: string } | undefined;
    if (previous) {
      // The first audit of a (block_id, version) is immutable: DO NOTHING
      // on replay, so a version rollback re-crossing an already-recorded
      // version number can never silently rewrite the audit history.
      this.db
        .prepare(
          'INSERT INTO core_history (block_id, version, content, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(block_id, version) DO NOTHING',
        )
        .run(block.id, previous.version, previous.content, block.updatedAt);
      // Bound the audit trail to the newest 20 versions — but only prune
      // once there ARE more than 20 (a fresh trail must not delete itself).
      const trailCount = (
        this.db
          .prepare('SELECT COUNT(*) as n FROM core_history WHERE block_id = ?')
          .get(block.id) as { n: number }
      ).n;
      if (trailCount > 20) {
        this.db
          .prepare(
            `DELETE FROM core_history WHERE block_id = ? AND version <= (
               SELECT MIN(version) FROM (
                 SELECT version FROM core_history WHERE block_id = ?
                 ORDER BY version DESC LIMIT 20
               )
             )`,
          )
          .run(block.id, block.id);
      }
    }
    this.db
      .prepare(
        `INSERT INTO core_blocks (id, name, content, token_cap, version, updated_at,
           visibility, user_id, workspace_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content=excluded.content,
           token_cap=excluded.token_cap,
           version=excluded.version,
           updated_at=excluded.updated_at`,
      )
      .run(
        block.id,
        block.name,
        block.content,
        block.tokenCap,
        block.version,
        block.updatedAt,
        scope.visibility,
        scope.userId ?? null,
        scope.workspaceId ?? null,
        scope.sessionId ?? null,
      );
    this.bumpDataVersion();
    return { ...block };
  }

  /** Versioned audit trail of one block (newest first). */
  listCoreHistory(blockId: string, limit = 10): Array<{
    blockId: string;
    version: number;
    content: string;
    updatedAt: number;
  }> {
    const rows = this.db
      .prepare(
        'SELECT block_id, version, content, updated_at FROM core_history WHERE block_id = ? ORDER BY version DESC LIMIT ?',
      )
      .all(blockId, limit) as Array<{
      block_id: string;
      version: number;
      content: string;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      blockId: r.block_id,
      version: r.version,
      content: r.content,
      updatedAt: r.updated_at,
    }));
  }

  /** Shared scoped SELECT for core-block-shaped tables. */
  private listCoreBlocksWhere<T>(
    level: ScopeLevelClause,
    table: 'core_blocks',
    map: (row: Record<string, unknown>) => T,
  ): T[] {
    const disj = tierDisjunction(level.tiers, level.ids);
    if (!disj) return [];
    const rows = this.db
      .prepare(`SELECT * FROM ${table} WHERE (${disj.sql}) ORDER BY name ASC`)
      .all(...disj.params) as Array<Record<string, unknown>>;
    return rows.map(map);
  }

  // ----- Query trajectory log (intent prediction) -----------------------------

  /** Hard cap on retained trajectory rows (pruned opportunistically). */
  static readonly QLOG_CAP = 5000;

  /**
   * Append one query to the trajectory log (called on every real —
   * non-speculative — retrieve). Sessions without an id are skipped:
   * anonymous queries would collapse into one giant fake session.
   * Prune-to-cap rides a deterministic 1/64 sampling guard.
   */
  logQuery(entry: {
    sessionId: string;
    userId?: string;
    workspaceId?: string;
    query: string;
  }): void {
    if (!entry.sessionId || !entry.query.trim()) return;
    const r = this.db
      .prepare(
        `INSERT INTO query_log (session_id, user_id, workspace_id, query, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.sessionId, entry.userId ?? null, entry.workspaceId ?? null, entry.query, Date.now());
    const rowId = Number(r.lastInsertRowid);
    if (r.changes > 0 && rowId % 64 === 0) {
      this.db
        .prepare(
          `DELETE FROM query_log WHERE id <= (SELECT MAX(id) FROM query_log) - ?`,
        )
        .run(MemoryStore.QLOG_CAP);
    }
  }

  /**
   * Shared backing for both trajectory reads: fetch the MOST RECENT rows
   * in SQL (DESC, with an id tiebreak — logQuery rows routinely share the
   * same millisecond, and without it same-ms order is unspecified), then
   * flip the row list in JS back to chronological order — the caller
   * (intent predictor) trains over TIME-ORDERED sequences. The old ASC+
   * LIMIT shape took the OLDEST 2000 rows and never saw recent sessions.
   */
  private recentTrajectories(
    ownerColumn: 'user_id' | 'workspace_id',
    ownerValue: string,
    maxSessions: number,
  ): string[][] {
    const rows = (
      this.db
        .prepare(
          `SELECT session_id, query FROM query_log WHERE ${ownerColumn} = ?
             ORDER BY created_at DESC, id DESC LIMIT 2000`,
        )
        .all(ownerValue) as Array<{ session_id: string; query: string }>
    ).reverse();
    const bySession = new Map<string, string[]>();
    for (const r of rows) {
      const arr = bySession.get(r.session_id) ?? [];
      arr.push(r.query);
      bySession.set(r.session_id, arr);
    }
    const sessions = [...bySession.values()].filter((q) => q.length >= 2);
    return sessions.slice(Math.max(0, sessions.length - maxSessions));
  }

  /**
   * Recent per-user query trajectories: sessions (>= 2 queries) as ordered
   * query-text arrays, oldest session first, capped to maxSessions.
   */
  listRecentTrajectories(userId: string | undefined, maxSessions = 50): string[][] {
    return userId ? this.recentTrajectories('user_id', userId, maxSessions) : [];
  }

  /**
   * Owner-anchored trajectory read with a workspace fallback: prefer the
   * user filter; without a userId fall back to workspaceId; with neither
   * there is no anchor and the answer is []. Output shape matches
   * listRecentTrajectories exactly (chronological sessions) — this is the
   * intent predictor's workspace-level fallback contract.
   */
  listRecentTrajectoriesFor(
    owner: { userId?: string; workspaceId?: string },
    limit = 50,
  ): string[][] {
    if (owner.userId) return this.recentTrajectories('user_id', owner.userId, limit);
    if (owner.workspaceId) {
      return this.recentTrajectories('workspace_id', owner.workspaceId, limit);
    }
    return [];
  }

  // ----- IVF vector-bucket index ----------------------------------------------

  /** LIVE, unexpired item count in one embedding space (IVF gate + stats). */
  countItemsInSpace(space: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) as n FROM memory_items
            WHERE ${LIVE}${UNEXPIRED} AND embedding IS NOT NULL AND embedding_space = ?`,
        )
        .get(MemoryStore.nowBound(), space) as { n: number }
    ).n;
  }

  /** Bucket histogram for a space (observability / rebalance signals). */
  vecBucketHistogram(space: string): Array<{ bucket: string; n: number }> {
    const rows = this.db
      .prepare(
        'SELECT bucket_key, COUNT(*) as n FROM vec_buckets WHERE space = ? GROUP BY bucket_key',
      )
      .all(space) as Array<{ bucket_key: string; n: number }>;
    return rows.map((r) => ({ bucket: r.bucket_key, n: r.n }));
  }

  /**
   * Remove bucket rows whose items no longer exist (evict/purge leave
   * harmless orphans because scans join back to memory_items — this keeps
   * the index lean). Returns rows pruned.
   */
  pruneOrphanBuckets(): number {
    // Deliberately no version bump/dirty mark: vec_buckets is a pure
    // accelerator whose rows can never change scan RESULTS (every probe
    // joins back to memory_items, and escalation ends at all-buckets =
    // the exact scan), so removing orphaned keys cannot leave a
    // version-keyed cache stale.
    const res = this.db
      .prepare(
        'DELETE FROM vec_buckets WHERE item_id NOT IN (SELECT id FROM memory_items)',
      )
      .run();
    return res.changes;
  }

  /** Rebuild the whole index for a space (bulk import recovery path). */
  rebuildVecIndex(space: string): number {
    return this.ingestTx(() => {
      // The raw DELETE/INSERTs below don't route through the bumping
      // helpers, so the batch must be marked dirty explicitly — the
      // index changed, and the version stamp must reflect that.
      this.markTxDirty();
      this.db.prepare('DELETE FROM vec_buckets WHERE space = ?').run(space);
      const rows = this.db
        .prepare(
          'SELECT id, embedding FROM memory_items WHERE embedding IS NOT NULL AND embedding_space = ?',
        )
        .all(space) as Array<{ id: string; embedding: Buffer }>;
      const ins = this.db.prepare(
        'INSERT OR REPLACE INTO vec_buckets (space, bucket_key, item_id) VALUES (?, ?, ?)',
      );
      for (const r of rows) {
        ins.run(space, anchorKeyOf(this.bufferToEmbedding(r.embedding)), r.id);
      }
      return rows.length;
    });
  }

  // ----- Bandit feedback-learning state ---------------------------------------

  private static scopeKey(scope: { userId?: string; workspaceId?: string }): string {
    // Kind-namespaced to match FeedbackLearner's in-memory bandit keys
    // (user:/workspace:/global:): a bare id let a userId and a workspaceId
    // with the SAME string share one bandit_state row, so the two
    // in-memory bandits each rehydrated and then overwrote the other's
    // persisted arms. Pre-namespacing rows become orphans — arms fall
    // back to defaults, reward log rows are merely not read back —
    // harmless, no migration warranted.
    if (scope.userId) return `user:${scope.userId}`;
    if (scope.workspaceId) return `workspace:${scope.workspaceId}`;
    return 'global:_';
  }

  /** All arm rows persisted for one scope (PK is (scope_key, arm) since v12). */
  loadBandit(scope: { userId?: string; workspaceId?: string }): Array<{
    arm: string; value: number; reward: number; attempts: number; updates: number;
  }> {
    const key = MemoryStore.scopeKey(scope);
    const rows = this.db
      .prepare('SELECT arm, value, reward, attempts, updates FROM bandit_state WHERE scope_key = ?')
      .all(key) as Array<{ arm: string; value: number; reward: number; attempts: number; updates: number }>;
    return rows;
  }

  saveBanditArm(
    scope: { userId?: string; workspaceId?: string },
    arm: string,
    value: number,
    reward: number,
    attempts: number,
    updates: number,
  ): void {
    // Deliberately does NOT bump the data version: learned fusion weights
    // travel with each retrieve call as fusionOverrides, which are already
    // part of the semantic query cache's identity (paramsKey), so a weight
    // change self-invalidates without a version bump — and bumping here
    // would flush every cached query on every feedback event.
    // Upsert keyed by (scope_key, arm) — one row PER ARM per scope; the
    // pre-v12 scope_key-only PK made every save clobber the scope's
    // sibling arms.
    this.db
      .prepare(
        `INSERT INTO bandit_state (scope_key, arm, value, reward, attempts, updates, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_key, arm) DO UPDATE SET
           value=excluded.value, reward=excluded.reward,
           attempts=excluded.attempts, updates=excluded.updates, updated_at=excluded.updated_at`,
      )
      .run(MemoryStore.scopeKey(scope), arm, value, reward, attempts, updates, Date.now());
  }

  /** Hard cap on retained reward rows (pruned opportunistically, 1/64). */
  static readonly BANDIT_REWARD_CAP = 5000;

  /**
   * Append one reward event. Rewards are diagnostic/training telemetry
   * that accumulate on EVERY retrieve-with-feedback, so the table rides
   * the same deterministic 1/64 sample-guard prune-to-cap as logQuery:
   * once a sampled insert lands, everything beyond the newest
   * BANDIT_REWARD_CAP rows goes — the table stays bounded without paying
   * a COUNT or a DELETE on every write.
   */
  logBanditReward(
    scope: { userId?: string; workspaceId?: string },
    query: string,
    reward: number,
    evidenceCount: number,
  ): void {
    const r = this.db
      .prepare(
        'INSERT INTO bandit_rewards (scope_key, query, reward, evidence_count, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(MemoryStore.scopeKey(scope), query.slice(0, 200), reward, evidenceCount, Date.now());
    const rowId = Number(r.lastInsertRowid);
    if (r.changes > 0 && rowId % 64 === 0) {
      this.db
        .prepare(`DELETE FROM bandit_rewards WHERE id <= (SELECT MAX(id) FROM bandit_rewards) - ?`)
        .run(MemoryStore.BANDIT_REWARD_CAP);
    }
  }

  recentBanditRewards(
    scope: { userId?: string; workspaceId?: string },
    limit = 10,
  ): Array<{ query: string; reward: number; evidenceCount: number; createdAt: number }> {
    const rows = this.db
      .prepare(
        'SELECT query, reward, evidence_count, created_at FROM bandit_rewards WHERE scope_key = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(MemoryStore.scopeKey(scope), limit) as Array<{
      query: string;
      reward: number;
      evidence_count: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      query: r.query,
      reward: r.reward,
      evidenceCount: r.evidence_count,
      createdAt: r.created_at,
    }));
  }

  // ----- Stratification tree ---------------------------------------------------

  upsertTreeNode(node: {
    nodeId: string;
    level: 'session' | 'week' | 'month' | 'era';
    periodStart: number;
    periodEnd: number;
    content: string;
    tokenCount: number;
    childIds: string[];
    itemId?: string;
    userId?: string;
    workspaceId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tree_nodes (node_id, level, period_start, period_end, content,
           token_count, child_ids, item_id, user_id, workspace_id, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           content=excluded.content,
           token_count=excluded.token_count,
           child_ids=excluded.child_ids,
           item_id=excluded.item_id,
           version=tree_nodes.version + 1,
           updated_at=excluded.updated_at`,
      )
      .run(
        node.nodeId, node.level, node.periodStart, node.periodEnd, node.content,
        node.tokenCount, JSON.stringify(node.childIds), node.itemId ?? null,
        node.userId ?? null, node.workspaceId ?? null, Date.now(),
      );
    this.bumpDataVersion();
  }

  listTreeNodes(
    level: 'session' | 'week' | 'month' | 'era',
    userId: string | undefined,
    sinceMs?: number,
    untilMs?: number,
  ): Array<{
    nodeId: string; level: string; periodStart: number; periodEnd: number;
    content: string; tokenCount: number; childIds: string[]; itemId: string | null;
    version: number;
  }> {
    const where: string[] = ['level = ?'];
    const params: unknown[] = [level];
    if (userId) { where.push('user_id = ?'); params.push(userId); }
    if (sinceMs !== undefined) { where.push('period_end >= ?'); params.push(sinceMs); }
    if (untilMs !== undefined) { where.push('period_start <= ?'); params.push(untilMs); }
    const rows = this.db
      .prepare(`SELECT * FROM tree_nodes WHERE ${where.join(' AND ')} ORDER BY period_start ASC`)
      .all(...params) as Array<{
      node_id: string; level: string; period_start: number; period_end: number;
      content: string; token_count: number; child_ids: string; item_id: string | null;
      version: number;
    }>;
    return rows.map((r) => ({
      nodeId: r.node_id, level: r.level, periodStart: r.period_start,
      periodEnd: r.period_end, content: r.content, tokenCount: r.token_count,
      childIds: safeJson<string[]>(r.child_ids, []), itemId: r.item_id, version: r.version,
    }));
  }

  // ----- CRDT op log (federation) ----------------------------------------------

  appendCrdtOp(op: {
    replica: string; counter: number; kind: string; key: string; value?: string;
  }): string {
    // op_id = replica:counter ONLY. (replica, counter) is already unique,
    // and folding kind/key into the id let a REPLAY of the same slot with
    // a DIFFERENT value be silently swallowed by OR IGNORE — two distinct
    // ops claiming the same identity. The minimal id keeps replay
    // idempotency exact: a re-delivered slot is ignored, while a divergent
    // value for an already-known slot surfaces as a real conflict instead
    // of vanishing.
    const opId = `${op.replica}:${op.counter}`;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO crdt_ops (op_id, replica, counter, kind, key, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(opId, op.replica, op.counter, op.kind, op.key, op.value ?? null, Date.now());
    return opId;
  }

  listCrdtOps(sinceCounter: number = 0): Array<{
    replica: string; counter: number; kind: string; key: string; value: string | null;
  }> {
    const rows = this.db
      .prepare('SELECT replica, counter, kind, key, value FROM crdt_ops WHERE counter > ? ORDER BY counter ASC, replica ASC')
      .all(sinceCounter) as Array<{
      replica: string; counter: number; kind: string; key: string; value: string | null;
    }>;
    return rows;
  }

  /**
   * Delta read keyed by PER-REPLICA watermarks — the semantically correct
   * federation sync. `listCrdtOps(sinceCounter)` compares one GLOBAL
   * counter against every replica's independent stream, so after any
   * partial sync it either re-sends or drops ops wholesale depending on
   * which replica numbered highest. This variant returns each replica's
   * ops strictly above THAT replica's watermark; replicas absent from
   * `watermarks` default to 0 (their full stream), so an empty object
   * means "sync everything". Ordering matches listCrdtOps.
   */
  listCrdtOpsSince(watermarks: Record<string, number>): Array<{
    replica: string; counter: number; kind: string; key: string; value: string | null;
  }> {
    const replicas = Object.keys(watermarks);
    if (replicas.length === 0) return this.listCrdtOps(0);
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const r of replicas) {
      clauses.push('(replica = ? AND counter > ?)');
      params.push(r, watermarks[r] ?? 0);
    }
    // Replicas WITHOUT a watermark default to watermark 0 — their full
    // stream must flow. With a dynamic replica set, "everyone else from
    // zero" can only be expressed in SQL as an explicit NOT IN branch.
    const ph = replicas.map(() => '?').join(', ');
    clauses.push(`(replica NOT IN (${ph}))`);
    params.push(...replicas);
    const rows = this.db
      .prepare(
        `SELECT replica, counter, kind, key, value FROM crdt_ops
         WHERE ${clauses.join(' OR ')}
         ORDER BY counter ASC, replica ASC`,
      )
      .all(...params) as Array<{
      replica: string; counter: number; kind: string; key: string; value: string | null;
    }>;
    return rows;
  }

  crdtOpCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM crdt_ops').get() as { n: number }).n;
  }

  // ----- Palace metadata (survives restarts) -----------------------------------

  /**
   * Read a persistent metadata value (e.g. the generated palaceId).
   * palace_meta holds operational metadata, NOT cache-relevant data — its
   * writes deliberately do NOT bump the data version, because a metadata
   * flip must not invalidate the semantic query cache / PageRank SWR
   * caches.
   */
  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM palace_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** Write a persistent metadata value (see getMeta for the no-bump rationale). */
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO palace_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ----- Maintenance --------------------------------------------------------

  /** Tombstone grace window: younger tombstones are "pending GC", not overdue. */
  static readonly TOMBSTONE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * Read-only structural self-check. Single connection, aggregate-only —
   * every probe is a COUNT over NOT EXISTS / json_each, so no result set
   * larger than one number ever reaches JS and the check stays second-
   * scale on stores of any size. See IntegrityReport for the classes.
   */
  integrityCheck(): IntegrityReport {
    const count = (sql: string, ...params: unknown[]): number =>
      (this.db.prepare(sql).get(...params) as { n: number }).n;

    // Bucket rows pointing at items that no longer exist OR are no longer
    // LIVE — deliberately the SAME definition repairIntegrity heals, so
    // check → repair → check converges to ok:true instead of leaving a
    // counted-but-uncleanable residue (an existence-only count here would
    // keep flagging tombstoned items the repair refuses to touch).
    const vecBucketOrphans = count(`
      SELECT COUNT(*) AS n FROM vec_buckets vb
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_items mi
        WHERE mi.id = vb.item_id AND mi.deleted_at IS NULL AND mi.superseded_by IS NULL
      )`);

    const danglingEntityRefs = count(`
      SELECT COUNT(*) AS n FROM memory_items mi
      WHERE mi.deleted_at IS NULL AND mi.superseded_by IS NULL
        AND mi.entity_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = mi.entity_id)`);

    // Counts REFERENCES, not nodes: one parent with two dead children
    // reports 2 (the repair prunes refs, so refs are the natural unit).
    // json_each expands child_ids inline; both target tables are probed
    // because children may point at nodes OR items. A malformed child_ids
    // cell counts as 1 — the CASE guard keeps json_each (which throws on
    // invalid JSON) behind json_valid, and the repair resets such rows to
    // '[]', so check → repair → check converges for corrupt cells too.
    const danglingTreeChildren = count(`
      SELECT COUNT(*) AS n FROM tree_nodes t
      WHERE CASE WHEN json_valid(t.child_ids) THEN
          EXISTS (SELECT 1 FROM json_each(t.child_ids) je
                  WHERE NOT EXISTS (SELECT 1 FROM tree_nodes c WHERE c.node_id = je.value)
                    AND NOT EXISTS (SELECT 1 FROM memory_items i WHERE i.id = je.value))
        ELSE 1 END`);

    const tombstoneOverdue = count(
      `SELECT COUNT(*) AS n FROM memory_items
       WHERE deleted_at IS NOT NULL AND deleted_at <= ?`,
      Date.now() - MemoryStore.TOMBSTONE_GRACE_MS,
    );

    // Mirrors listItemsInOtherSpaces' stranded set (vectors in a space
    // other than the active one) so the number matches what the migrator
    // would actually heal. Without a configured active space there is no
    // yardstick — reported as 0 rather than guessed.
    const strandedEmbeddings = this.activeSpace
      ? count(
          `SELECT COUNT(*) AS n FROM memory_items
           WHERE deleted_at IS NULL AND superseded_by IS NULL
             AND embedding IS NOT NULL
             AND embedding_space IS NOT NULL AND embedding_space != ?`,
          this.activeSpace,
        )
      : 0;

    // Ghost rows (tier set, owner column NULL) are invisible at every
    // level — a data-loss-grade residue of legacy writes the public API can
    // no longer produce. Counted via the SAME GHOST_ROWS predicate the
    // opt-in repair tombstones with, so convergence holds here too. Unlike
    // strandedEmbeddings this FAILS ok: the row is unreadable now, not
    // merely waiting for a migration.
    const ghostRows = count(`
      SELECT COUNT(*) AS n FROM memory_items WHERE ${GHOST_ROWS}`);

    const ok =
      vecBucketOrphans === 0 &&
      danglingEntityRefs === 0 &&
      danglingTreeChildren === 0 &&
      tombstoneOverdue === 0 &&
      ghostRows === 0;

    const details = [
      `vec_buckets: ${vecBucketOrphans} orphan row(s) pointing at missing or non-LIVE items (repair reclaims them)`,
      `entity refs: ${danglingEntityRefs} LIVE item(s) reference a nonexistent entity (repair nulls the ref, keeps the item)`,
      `tree children: ${danglingTreeChildren} child reference(s) in tree_nodes match no node and no item (repair rewrites child_ids)`,
      `tombstones: ${tombstoneOverdue} row(s) deleted >7d ago and still unpurged (GC lag; repair purges them)`,
      `ghost rows: ${ghostRows} LIVE row(s) whose visibility tier names a NULL owner column (legacy invisible-forever rows; resolution requires ownership decision, see repairIntegrity opt-in)`,
      `stranded embeddings: ${strandedEmbeddings} LIVE item(s) with vectors outside ${
        this.activeSpace ? `the active space "${this.activeSpace}"` : 'an active space (none configured — not evaluated)'
      }; SpaceMigrator heals these, repair never touches them`,
    ];

    return {
      vecBucketOrphans,
      danglingEntityRefs,
      danglingTreeChildren,
      tombstoneOverdue,
      strandedEmbeddings,
      ghostRows,
      ok,
      details,
    };
  }

  /**
   * Conservative self-heal for the four repairable classes — everything
   * it does is idempotent and never deletes LIVE memory:
   *   1. vec_buckets rows whose item is gone or no longer LIVE (the index
   *      is a pure accelerator — dropping dead keys is free, and a later
   *      re-ingest re-buckets the item from scratch),
   *   2. LIVE items with a dangling entity_id — the REFERENCE is nulled,
   *      the memory itself survives,
   *   3. tree_nodes child_ids entries matching no node and no item — the
   *      array is rewritten without them, valid refs stay,
   *   4. tombstones past the grace window — the standard purge the GC
   *      would eventually run.
   * strandedEmbeddings is deliberately NOT touched: re-embedding needs
   * the gateway, which is SpaceMigrator's job (see integrityCheck).
   *
   * Ghost rows (tier set, owner column NULL) are the one OPT-IN class:
   * they are invisible at every level, but declaring them deleted is an
   * ownership decision, so the default pass leaves them untouched. With
   * opts.ghostRows === 'tombstone' they are soft-deleted (deleted_at=now,
   * row survives for audit/undo until the standard purge — a forever-
   * unreadable row is worse than an honest tombstone, and this direction
   * matches the right-to-be-forgotten sweep). The ghost step runs FIRST
   * so the orphan sweep below reclaims their bucket rows in the same pass.
   * All steps ride ONE ingestTx so they commit atomically and stamp the
   * data version once; a clean store returns all zeros (safe to re-run).
   */
  repairIntegrity(opts?: { ghostRows?: 'tombstone' }): RepairReport {
    return this.ingestTx(() => {
      // Opt-in ghost tombstone: same GHOST_ROWS predicate the check counts
      // with, deleted_at stamped now (fresh — the grace purge below keeps
      // the row; this is a soft delete, not a purge).
      const ghostRowsTombstoned =
        opts?.ghostRows === 'tombstone'
          ? this.db
              .prepare(`UPDATE memory_items SET deleted_at = ? WHERE ${GHOST_ROWS}`)
              .run(Date.now()).changes
          : 0;

      // Orphan scan uses the LIVE-based definition from integrityCheck,
      // not pruneOrphanBuckets' existence-only one: tombstoned items'
      // bucket keys are dead weight too (scans can never reach them).
      const vecBucketOrphansRemoved = this.db
        .prepare(
          `DELETE FROM vec_buckets WHERE item_id NOT IN (
             SELECT id FROM memory_items WHERE ${LIVE}
           )`,
        )
        .run().changes;

      const danglingEntityRefsCleared = this.db
        .prepare(
          `UPDATE memory_items SET entity_id = NULL
           WHERE ${LIVE} AND entity_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = memory_items.entity_id)`,
        )
        .run().changes;

      // Only nodes that actually carry a dead ref are fetched (the SQL
      // pre-filters with the same CASE-guarded probe as the check), and
      // only rows whose array really changes are rewritten — healthy
      // nodes keep their version counter untouched. Malformed child_ids
      // cells ride the same query (json_valid short-circuits the
      // json_each call) and are reset to '[]' below.
      const nodeExists = this.db.prepare('SELECT 1 FROM tree_nodes WHERE node_id = ?');
      const itemExists = this.db.prepare('SELECT 1 FROM memory_items WHERE id = ?');
      const rewrite = this.db.prepare('UPDATE tree_nodes SET child_ids = ? WHERE node_id = ?');
      let danglingTreeChildrenPruned = 0;
      const affected = this.db
        .prepare(
          `SELECT node_id, child_ids FROM tree_nodes t WHERE CASE WHEN json_valid(t.child_ids) THEN
             EXISTS (
               SELECT 1 FROM json_each(t.child_ids) je
               WHERE NOT EXISTS (SELECT 1 FROM tree_nodes c WHERE c.node_id = je.value)
                 AND NOT EXISTS (SELECT 1 FROM memory_items i WHERE i.id = je.value)
             )
           ELSE 1 END`,
        )
        .all() as Array<{ node_id: string; child_ids: string }>;
      for (const row of affected) {
        // Malformed JSON: the references are unreadable, so the row counts
        // as one dangling child and is reset to the empty array. The
        // sentinel tells parse failure apart from any legitimate JSON
        // value (audit check 8 keeps JSON.parse confined to safeJson).
        const ids = safeJson<unknown>(row.child_ids, TREE_PARSE_FAILED);
        if (ids === TREE_PARSE_FAILED) {
          rewrite.run('[]', row.node_id);
          danglingTreeChildrenPruned += 1;
          continue;
        }
        // Parseable but non-array payloads are left alone: guessing a
        // repair for a valid JSON value is not this conservative pass's job.
        if (!Array.isArray(ids)) continue;
        const kept = ids.filter(
          (c) => itemExists.get(c) !== undefined || nodeExists.get(c) !== undefined,
        );
        danglingTreeChildrenPruned += ids.length - kept.length;
        if (kept.length !== ids.length) {
          rewrite.run(JSON.stringify(kept), row.node_id);
        }
      }

      // Overdue tombstones go through the standard purge (same grace
      // window the check flags them at) rather than a private DELETE, so
      // tenant scoping and the version stamp stay in one place.
      const tombstonesPurged = this.purgeDeleted(MemoryStore.TOMBSTONE_GRACE_MS);

      // The raw writes above bypass the bumping helpers, so the batch is
      // stamped explicitly — but ONLY when something actually changed: a
      // no-op repair must not invalidate the caches (that keeps a
      // scheduled repair's second run free).
      const touched =
        ghostRowsTombstoned +
        vecBucketOrphansRemoved +
        danglingEntityRefsCleared +
        danglingTreeChildrenPruned +
        tombstonesPurged;
      if (touched > 0) this.markTxDirty();

      return {
        vecBucketOrphansRemoved,
        danglingEntityRefsCleared,
        danglingTreeChildrenPruned,
        tombstonesPurged,
        ghostRowsTombstoned,
      };
    });
  }

  /**
   * Write a compact, mountable snapshot via VACUUM INTO (SQLite >= 3.27).
   *
   * The snapshot reflects the CURRENT connection's committed state —
   * pages still only in the WAL are folded in, so the backup is NOT stale
   * relative to un-checkpointed writes (it is a logical copy, not a file
   * copy of the main database). VACUUM INTO refuses to touch an existing
   * target (SQLite semantics — it never overwrites), so callers rotate
   * filenames; we pre-check for a clearer error than the raw one. Must
   * run OUTSIDE a transaction: VACUUM cannot participate in one.
   */
  backupTo(path: string): void {
    if (existsSync(path)) {
      throw new Error(
        `backupTo: target already exists (${path}) — VACUUM INTO never overwrites; write to a fresh path`,
      );
    }
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(path);
  }

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
    byTier: TierCensus;
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
    // ADMIN TIER TELEMETRY (byTier): same population as `items` above —
    // LIVE + UNEXPIRED — grouped by the visibility column. Because the
    // population is identical, Σ byTier === Σ items holds STRUCTURALLY
    // (pinned by test/stats-scoped.test.ts); a byTier that drifted from
    // items would be two disagreeing censuses of one store. NULL
    // visibility (pre-ACL legacy rows) is bucketed as legacyNull, kept
    // apart from stamped-'global' so operators can see the debt.
    const tierRows = this.db
      .prepare(
        `SELECT visibility, COUNT(*) as n FROM memory_items
         WHERE ${LIVE}${UNEXPIRED} GROUP BY visibility`,
      )
      .all(MemoryStore.nowBound()) as Array<{ visibility: string | null; n: number }>;
    const byTier: TierCensus = { session: 0, workspace: 0, user: 0, global: 0, legacyNull: 0 };
    for (const r of tierRows) {
      if (r.visibility === null) byTier.legacyNull = r.n;
      else if (
        r.visibility === 'session' ||
        r.visibility === 'workspace' ||
        r.visibility === 'user' ||
        r.visibility === 'global'
      ) {
        byTier[r.visibility] = r.n;
      }
    }
    const spaces = this.spaceOccupancy();
    const tombstoned = this.countTombstoned();
    const sizeBytes = this.dbSizeBytes();
    return { items, events, entities, edges, patterns, sizeBytes, spaces, tombstoned, byTier };
  }

  /**
   * Scoped twin of stats() — first-class per-caller counts. Every number
   * is an aggregate COUNT restricted to rows visible at `level` through
   * the same tierDisjunction ACL every scoped read path uses:
   *
   *   - items: LIVE + UNEXPIRED per layer — byte-for-byte the caliber of
   *     stats().items (read-time TTL enforcement included), narrowed to
   *     the caller's tier cascade;
   *   - entities / edges / patterns: plain COUNT + ACL — those tables
   *     carry no tombstone or TTL columns, which is exactly how stats()
   *     counts them raw; only the owner boundary is added;
   *   - tombstones: deleted_at IS NOT NULL within the VISIBLE tiers (the
   *     scoped mirror of countTombstoned) — soft-deleted rows this caller
   *     could still restore or purge, never another tenant's;
   *   - events: episodic_events predates the tier ACL and carries
   *     session_id only, so "scoped" there means attributed to the
   *     caller's own session (exact equality; 0 when the caller has no
   *     session id);
   *   - spaces: embedding-space occupancy among the caller's visible
   *     LIVE + UNEXPIRED items — the scoped source of the observability
   *     fragmentation signal.
   *
   * Everything is SQL-aggregated: no rows are materialized in JS, so a
   * tenant of any size pays the same handful of COUNTs. An empty cascade
   * (tierDisjunction null — a caller with no usable level) yields all
   * zeros rather than throwing: counting nothing is the honest answer
   * for an identity that can see nothing.
   */
  statsScoped(level: ScopeLevelClause): ScopedStats {
    const disj = tierDisjunction(level.tiers, level.ids);
    const items: Record<MemoryLayer, number> = { episodic: 0, semantic: 0, procedural: 0 };
    const spaces: Record<string, number> = {};
    let entities = 0;
    let edges = 0;
    let patterns = 0;
    let tombstones = 0;
    let events = 0;
    if (disj) {
      const itemRows = this.db
        .prepare(
          `SELECT layer, COUNT(*) as n FROM memory_items
           WHERE ${LIVE}${UNEXPIRED} AND (${disj.sql}) GROUP BY layer`,
        )
        .all(MemoryStore.nowBound(), ...disj.params) as Array<{ layer: MemoryLayer; n: number }>;
      for (const r of itemRows) items[r.layer] = r.n;
      const spaceRows = this.db
        .prepare(
          `SELECT embedding_space, COUNT(*) as n FROM memory_items
           WHERE ${LIVE}${UNEXPIRED} AND embedding_space IS NOT NULL AND (${disj.sql})
           GROUP BY embedding_space`,
        )
        .all(MemoryStore.nowBound(), ...disj.params) as Array<{ embedding_space: string; n: number }>;
      for (const r of spaceRows) spaces[r.embedding_space] = r.n;
      const countWhere = (table: string): number =>
        (
          this.db
            .prepare(`SELECT COUNT(*) as n FROM ${table} WHERE (${disj.sql})`)
            .get(...disj.params) as { n: number }
        ).n;
      entities = countWhere('entities');
      edges = countWhere('graph_edges');
      patterns = countWhere('procedural_patterns');
      tombstones = (
        this.db
          .prepare(
            `SELECT COUNT(*) as n FROM memory_items
             WHERE deleted_at IS NOT NULL AND (${disj.sql})`,
          )
          .get(...disj.params) as { n: number }
      ).n;
    }
    if (level.ids.sessionId) {
      events = (
        this.db
          .prepare('SELECT COUNT(*) as n FROM episodic_events WHERE session_id = ?')
          .get(level.ids.sessionId) as { n: number }
      ).n;
    }
    return { items, entities, edges, patterns, tombstones, events, spaces };
  }

  /**
   * Whole-store embedding-space occupancy (LIVE + UNEXPIRED), keyed by
   * space — the maintenance census behind the memory_migrate tool's
   * fragmentation report. Deliberately NOT tenant-scoped: space
   * migration is a physical whole-store operation (SpaceMigrator.tick
   * re-embeds every stranded row regardless of owner), so its preview
   * must describe the same whole-store population the live run touches.
   * The tool layer reaches global numbers only through this NAMED
   * maintenance surface — never through the generic stats() (audit
   * check 11); stats() reuses it internally as the single implementation
   * of the spaces census.
   */
  spaceOccupancy(): Record<string, number> {
    // Same population as stats().items: LIVE + UNEXPIRED. The old
    // LIVE-only variant counted expired-but-unswept rows here while
    // items excluded them — the two numbers disagreed by exactly the
    // pending-sweep set.
    const rows = this.db
      .prepare(
        `SELECT embedding_space, COUNT(*) as n FROM memory_items
         WHERE ${LIVE}${UNEXPIRED} AND embedding_space IS NOT NULL GROUP BY embedding_space`,
      )
      .all(MemoryStore.nowBound()) as Array<{ embedding_space: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.embedding_space] = r.n;
    return out;
  }

  /**
   * Physical database size in bytes (page_count × page_size). Storage
   * telemetry, deliberately tenant-agnostic — the file is the file; no
   * per-tenant split of physical pages exists. Exposed as its own named
   * surface so scoped consumers can report storage size without routing
   * through the whole-store stats census (audit check 11).
   */
  dbSizeBytes(): number {
    return (
      (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count *
      (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
    );
  }

  private rowToItem(r: ItemRow): MemoryItem {
    // safeJson: one corrupt metadata cell degrades to {} instead of
    // throwing every read of the table; the embedding_space COLUMN stays
    // authoritative — backfilling it into metadata.embeddingSpace keeps
    // round-tripped items (e.g. compression re-writes) tagged with their
    // real vector space even when the stored JSON lost the tag, which is
    // the root cause of cross-space merges in compressed partitions.
    const metadata = safeJson<Partial<MemoryMetadata>>(r.metadata, {}) as MemoryMetadata;
    // Backfill the column value into the metadata copy. When even the
    // column is NULL the tag is removed rather than set to undefined —
    // exactOptionalPropertyTypes forbids the explicit-undefined binding,
    // and every read of the property is identical either way.
    // eslint-disable-next-line eqeqeq -- safeJson can hand us a JSON null here even though the declared type is `string | undefined`; the backfill must fire on null AND undefined exactly like the historical `??=` did.
    if (metadata.embeddingSpace == null) {
      if (r.embedding_space !== null) metadata.embeddingSpace = r.embedding_space;
      else delete metadata.embeddingSpace;
    }
    return {
      id: r.id,
      layer: r.layer,
      content: r.content,
      // exactOptionalPropertyTypes: NULL columns omit their keys instead
      // of binding explicit undefined — every consumer reads with ??.
      ...(r.embedding !== null ? { embedding: this.bufferToEmbedding(r.embedding) } : {}),
      metadata,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      importance: r.importance,
      accessCount: r.access_count,
      lastAccessedAt: r.last_accessed_at,
      ...(r.entity_id !== null ? { entityId: r.entity_id } : {}),
      ...(r.visibility !== null ? { visibility: r.visibility as VisibilityTier } : {}),
      // Owner backfill from the DB row — lets JS-side callers re-check the
      // tier ACL without a second query (see visibleAtLevel in
      // utils/scope.ts). Not part of the capsule projection.
      ...(r.user_id !== null ? { userId: r.user_id } : {}),
      ...(r.workspace_id !== null ? { workspaceId: r.workspace_id } : {}),
      ...(r.session_id !== null ? { sessionId: r.session_id } : {}),
    };
  }
}
