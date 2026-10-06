/**
 * SCOPED STATISTICS (D-01) — the per-caller census as a first-class
 * citizen, the admin tier census, the facade's dual contract, and
 * memory_inspect's count isolation.
 *
 * Methodology copied from exhaustive-acl.test.ts: a DUAL-IMPLEMENTATION
 * DIFFERENTIAL. The SQL-aggregated scoped census (statsScoped — tier
 * disjunction pushed into aggregate COUNTs) must agree exactly with a
 * brute-force JS mirror that reads the RAW rows through a second
 * better-sqlite3 connection and filters them with visibleAtLevel (the
 * JS side of the tier ACL) plus the documented LIVE + UNEXPIRED
 * caliber. Two implementations sharing no query code must produce the
 * same numbers for every caller identity in the matrix.
 *
 * Coverage:
 *   - ~30 memory rows over tier × owner × layer, including a foreign
 *     tenant, a foreign workspace, a NULL-legacy row, a tombstone, a
 *     supersession, and an expired row (the LIVE/UNEXPIRED caliber has
 *     to show up in the differential, not just in comments);
 *   - entities / edges / patterns under the same tier spread;
 *   - episodic events attributed per session (the events table
 *     predates the tier ACL and carries session_id only);
 *   - a 4-identity caller matrix (two users, one workspace, one
 *     session) × their natural scope kinds;
 *   - stats().byTier: exact per-tier census on a hand-built 5-row
 *     distribution (one row per tier + one legacy-NULL via raw SQL),
 *     Σ byTier === Σ items (STRUCTURAL — same population), and
 *     expired/tombstoned rows excluded from both;
 *   - the facade dual contract: stats(scope) returns the scoped census
 *     only (no byTier — a caller must not read tenant distribution),
 *     stats() without a scope keeps the global admin shape unchanged;
 *   - memory_inspect ISOLATION (the flagship): u1's counts reflect
 *     exactly u1's visible set — never u2's private rows or tombstones
 *     — and an anonymous caller sees the global tier only.
 *
 * Determinism: no randomness — fixed owner ids, fixed epoch timestamps,
 * fixed embeddings, one shared database per subtest, Windows WAL
 * close-before-rm hook order (copied from exhaustive-acl.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';
import { MemoryStore } from '../src/services/memory-store.ts';
import { scopeLevels, widestLevel, visibleAtLevel } from '../src/utils/scope.ts';
import type { ScopeIdentity, ScopeLevelClause } from '../src/utils/scope.ts';
import type {
  Entity,
  EpisodicEvent,
  MemoryLayer,
  MemoryScopeKind,
} from '../src/types/index.ts';

// ---------------------------------------------------------------------------
// Fixture vocabulary — fully deterministic (exhaustive-acl conventions).
// ---------------------------------------------------------------------------

const UID_A = 'u-alice';
const UID_B = 'u-bob';
const WID_1 = 'ws-one';
const WID_2 = 'ws-two';
const SID_X = 'sess-x';
const SID_OTHER = 'sess-other';

const SPACE = 'stats-scoped-space';
const T0 = 1_700_000_000_000; // fixed epoch — no Date.now() in fixtures
const DAY = 86_400_000;

/** Tier spread every scoppable table is fixture-built over. */
const TIERS = ['session', 'workspace', 'user', 'global', 'null-legacy'] as const;
type TierState = (typeof TIERS)[number];

/** Owner id set per tier (the tenant mix the differential must separate). */
const OWNER_FOR: Record<TierState, ScopeIdentity> = {
  session: { sessionId: SID_X },
  workspace: { workspaceId: WID_1 },
  user: { userId: UID_A },
  global: {},
  'null-legacy': { userId: UID_A },
};

const LAYERS: readonly MemoryLayer[] = ['semantic', 'episodic', 'procedural'];

/** The 4-identity caller matrix (spot check per the exhaustive method). */
const CALLERS: ReadonlyArray<{ name: string; kind: MemoryScopeKind; ids: ScopeIdentity }> = [
  { name: 'alice/user', kind: 'user', ids: { userId: UID_A } },
  { name: 'bob/user', kind: 'user', ids: { userId: UID_B } },
  { name: 'wsOne/workspace', kind: 'workspace', ids: { workspaceId: WID_1 } },
  { name: 'sessX/session', kind: 'session', ids: { sessionId: SID_X } },
];

// ---------------------------------------------------------------------------
// Store fixture (Windows WAL cleanup discipline copied from
// exhaustive-acl.test.ts: the close hook registers BEFORE the rm hook,
// because hooks run in registration order and rmSync cannot remove a
// directory that still holds an open WAL handle).
// ---------------------------------------------------------------------------

interface AfterHooks {
  after: (fn: () => void) => void;
}

const makeStore = (t: AfterHooks): { store: MemoryStore; dbPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-stats-'));
  const dbPath = join(dir, 'memory.db');
  let store: MemoryStore | null = new MemoryStore({
    storagePath: dbPath,
    dimensions: 4,
    scope: 'user',
    activeSpace: SPACE,
    quantization: 'float32',
  });
  t.after(() => {
    try {
      store?.close();
    } catch {
      // already closed — nothing to do
    }
    store = null;
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { store, dbPath };
};

/** Insert one tiered memory row (metadata stamp for real tiers — the
 *  owner columns must NOT re-derive it; NULL-legacy flips after). */
function insertTieredItem(
  store: MemoryStore,
  id: string,
  layer: MemoryLayer,
  tier: TierState,
  opts: { expired?: boolean } = {},
): void {
  store.insertItem(
    {
      id,
      layer,
      content: `scoped-stats|${layer}|${tier}|${id}`,
      embedding: new Float32Array([1, 0, 0, 0]),
      metadata: {
        source: 'system',
        ...(tier === 'null-legacy' ? {} : { visibility: tier }),
        ...(opts.expired ? { expiresAt: T0 - DAY } : {}),
      },
      createdAt: T0,
      updatedAt: T0,
      importance: 0.5,
      accessCount: 0,
      lastAccessedAt: 0,
    },
    OWNER_FOR[tier],
  );
}

/** Flip rows to visibility IS NULL via a second connection (the public
 *  API cannot write NULL — the legacy state predates it). */
function flipLegacyToNull(dbPath: string, table: string, column: 'id', ids: string[]): void {
  const raw = new Database(dbPath);
  try {
    raw
      .prepare(`UPDATE ${table} SET visibility = NULL WHERE ${column} IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// Brute-force mirror: raw rows via a second connection + visibleAtLevel.
// This is the JS half of the differential — it shares no query code with
// statsScoped.
// ---------------------------------------------------------------------------

interface RawItemRow {
  id: string;
  layer: string;
  visibility: string | null;
  user_id: string | null;
  workspace_id: string | null;
  session_id: string | null;
  deleted_at: number | null;
  superseded_by: string | null;
  metadata: string;
  embedding_space: string | null;
}

interface RawTierRow {
  id: string;
  visibility: string | null;
  user_id: string | null;
  workspace_id: string | null;
  session_id: string | null;
}

const readRaw = <T>(dbPath: string, sql: string): T[] => {
  const raw = new Database(dbPath);
  try {
    return raw.prepare(sql).all() as T[];
  } finally {
    raw.close();
  }
};

/** The LIVE + UNEXPIRED caliber, evaluated row-by-row in JS (mirror of
 *  the SQL fragments the store aggregates over). */
function rowIsLiveAndUnexpired(r: RawItemRow, now: number): boolean {
  if (r.deleted_at !== null || r.superseded_by !== null) return false;
  let meta: { expiresAt?: number } = {};
  try {
    meta = JSON.parse(r.metadata) as { expiresAt?: number };
  } catch {
    meta = {}; // corrupt cell reads as "no expiry" — same degraded semantics
  }
  return meta.expiresAt === undefined || meta.expiresAt > now;
}

const tierRowVisible = (r: RawTierRow, level: ScopeLevelClause): boolean =>
  visibleAtLevel(
    {
      visibility: r.visibility ?? undefined,
      userId: r.user_id ?? undefined,
      workspaceId: r.workspace_id ?? undefined,
      sessionId: r.session_id ?? undefined,
    },
    level,
  );

/** Count events attributed to one session (raw second connection). */
function countEvents(dbPath: string, sessionId: string): number {
  const raw = new Database(dbPath);
  try {
    return (
      raw
        .prepare('SELECT COUNT(*) AS n FROM episodic_events WHERE session_id = ?')
        .get(sessionId) as { n: number }
    ).n;
  } finally {
    raw.close();
  }
}

/** Brute-force ScopedStats from raw rows — the differential's oracle. */
function bruteScoped(dbPath: string, level: ScopeLevelClause): {
  items: Record<string, number>;
  entities: number;
  edges: number;
  patterns: number;
  tombstones: number;
  events: number;
  spaces: Record<string, number>;
} {
  const now = Date.now(); // fixtures are epoch-fixed; only TTL comparison needs now
  const items: Record<string, number> = { episodic: 0, semantic: 0, procedural: 0 };
  const spaces: Record<string, number> = {};
  let tombstones = 0;
  for (const r of readRaw<RawItemRow>(dbPath, 'SELECT * FROM memory_items')) {
    const vis = { visibility: r.visibility ?? undefined, userId: r.user_id ?? undefined, workspaceId: r.workspace_id ?? undefined, sessionId: r.session_id ?? undefined };
    if (r.deleted_at !== null && visibleAtLevel(vis, level)) tombstones++;
    if (!rowIsLiveAndUnexpired(r, now)) continue;
    if (!visibleAtLevel(vis, level)) continue;
    if (r.layer in items) items[r.layer] = (items[r.layer] ?? 0) + 1;
    if (r.embedding_space !== null) {
      spaces[r.embedding_space] = (spaces[r.embedding_space] ?? 0) + 1;
    }
  }
  const countTierTable = (table: string): number =>
    readRaw<RawTierRow>(dbPath, `SELECT * FROM ${table}`).filter((r) => tierRowVisible(r, level)).length;
  return {
    items,
    entities: countTierTable('entities'),
    edges: countTierTable('graph_edges'),
    patterns: countTierTable('procedural_patterns'),
    tombstones,
    events: level.ids.sessionId ? countEvents(dbPath, level.ids.sessionId) : 0,
    spaces,
  };
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

test('scoped statistics (D-01)', async (t) => {
  await t.test('differential flagship: statsScoped(widest) === brute-force JS mirror, 4-identity matrix', () => {
    const { store, dbPath } = makeStore(t);

    // --- fixture: 30 memory rows over tier × owner × layer -------------------
    const legacyItemIds: string[] = [];
    /** A tiered row with an OVERRIDDEN owner (foreign tenant fixture). */
    const insertForeign = (id: string, layer: MemoryLayer, tier: 'user' | 'workspace', owner: ScopeIdentity): void => {
      store.insertItem(
        {
          id,
          layer,
          content: `scoped-stats|${layer}|${tier}|${id}`,
          embedding: new Float32Array([0, 1, 0, 0]),
          metadata: { source: 'system', visibility: tier },
          createdAt: T0,
          updatedAt: T0,
          importance: 0.5,
          accessCount: 0,
          lastAccessedAt: 0,
        },
        owner,
      );
    };
    for (const layer of LAYERS) {
      const lk = layer.slice(0, 4);
      // The canonical tier spread — 6 rows per layer.
      for (const tier of TIERS) {
        const id = `it-${lk}-${tier}`;
        insertTieredItem(store, id, layer, tier);
        if (tier === 'null-legacy') legacyItemIds.push(id);
      }
      // Plus per-layer state that exercises the CALIBER, not just the ACL:
      // a second (foreign) user tenant, a foreign workspace, a tombstone,
      // a supersession, and an expired row — 4 more rows per layer.
      insertForeign(`it-${lk}-user-bob`, layer, 'user', { userId: UID_B });
      insertForeign(`it-${lk}-ws-two`, layer, 'workspace', { workspaceId: WID_2 });
      insertTieredItem(store, `it-${lk}-dead`, layer, 'user');
      store.tombstoneItem(`it-${lk}-dead`);
      insertTieredItem(store, `it-${lk}-superseded`, layer, 'global');
      store.tombstoneItem(`it-${lk}-superseded`, `it-${lk}-successor`);
      insertTieredItem(store, `it-${lk}-expired`, layer, 'user', { expired: true });
    }
    flipLegacyToNull(dbPath, 'memory_items', 'id', legacyItemIds);

    // --- fixture: entities / edges / patterns over the same spread ----------
    const legacyEntityIds: string[] = [];
    const legacyEdgeIds: string[] = [];
    const legacyPatternIds: string[] = [];
    for (const tier of TIERS) {
      const owner = OWNER_FOR[tier];
      const eid = `ent-${tier}`;
      store.upsertEntity(
        {
          id: eid,
          name: `Entity ${tier}`,
          type: 'concept',
          aliases: [],
          firstSeenAt: T0,
          lastSeenAt: T0,
          mentionCount: 1,
        },
        { visibility: tier === 'null-legacy' ? 'global' : tier, ...owner },
      );
      if (tier === 'null-legacy') legacyEntityIds.push(eid);
      store.upsertEdgeIfStronger(
        eid,
        'ent-global',
        'co-occurs',
        1,
        { visibility: tier === 'null-legacy' ? 'global' : tier, ...owner },
      );
      store.upsertPattern(
        {
          id: `pat-${tier}`,
          pattern: `pattern-${tier}`,
          description: 'd',
          evidence: [],
          confidence: 0.5,
          createdAt: T0,
        },
        { visibility: tier === 'null-legacy' ? 'global' : tier, ...owner },
      );
      // graph_edges has no single id column — key the legacy flip by owner.
      if (tier === 'null-legacy') {
        legacyEdgeIds.push(eid);
        legacyPatternIds.push(`pat-${tier}`);
      }
    }
    // NULL-legacy edges: graph_edges has no id column; flip via owner match.
    {
      const raw = new Database(dbPath);
      try {
        raw.prepare('UPDATE graph_edges SET visibility = NULL WHERE from_id = ?').run(legacyEdgeIds[0]!);
        raw.prepare('UPDATE procedural_patterns SET visibility = NULL WHERE id = ?').run(legacyPatternIds[0]!);
      } finally {
        raw.close();
      }
    }

    // --- fixture: events (session-attributed) -------------------------------
    const mkEvent = (id: string, sessionId: string): EpisodicEvent => ({
      id,
      sessionId,
      type: 'message',
      payload: {},
      ts: T0,
    });
    store.insertEvent(mkEvent('ev-1', SID_X));
    store.insertEvent(mkEvent('ev-2', SID_X));
    store.insertEvent(mkEvent('ev-3', SID_OTHER));

    // --- the differential: SQL aggregate ⇔ brute-force JS mirror ------------
    for (const caller of CALLERS) {
      const widest = widestLevel(scopeLevels(caller.kind, caller.ids));
      const sql = store.statsScoped(widest);
      const brute = bruteScoped(dbPath, widest);
      const where = `caller=${caller.name} kind=${caller.kind}`;
      assert.deepEqual(sql.items, brute.items, `items per layer — ${where}`);
      assert.equal(sql.entities, brute.entities, `entities — ${where}`);
      assert.equal(sql.edges, brute.edges, `edges — ${where}`);
      assert.equal(sql.patterns, brute.patterns, `patterns — ${where}`);
      assert.equal(sql.tombstones, brute.tombstones, `tombstones — ${where}`);
      assert.equal(sql.events, brute.events, `events — ${where}`);
      assert.deepEqual(sql.spaces, brute.spaces, `space occupancy — ${where}`);
    }

    // Discriminating-power guards: a differential over a fixture where
    // every caller sees everything proves nothing. The tenants here have
    // EQUAL live per-layer counts (alice: user+global+legacy; bob:
    // user+global+legacy) — identical item shapes — so separation must
    // be demonstrated through the tombstone census (alice's private
    // tombstones + the shared supersession vs bob's supersession only)
    // and through the scoped-vs-global total gap.
    const alice = store.statsScoped(widestLevel(scopeLevels('user', { userId: UID_A })));
    const bob = store.statsScoped(widestLevel(scopeLevels('user', { userId: UID_B })));
    const total = (s: { items: Record<string, number> }): number =>
      s.items.semantic + s.items.episodic + s.items.procedural;
    const globalStats = store.stats();
    const globalTotal = total({ items: globalStats.items });
    assert.ok(
      total(alice) < globalTotal,
      `scoped census is strictly smaller than the global pool (alice=${total(alice)} < global=${globalTotal})`,
    );
    assert.ok(
      alice.tombstones > bob.tombstones,
      `tombstone census separates tenants (alice=${alice.tombstones} > bob=${bob.tombstones})`,
    );
    assert.ok(alice.tombstones > 0, 'fixture has tombstones visible to alice');
    assert.equal(
      store.statsScoped(widestLevel(scopeLevels('user', {}))).events,
      0,
      'anonymous caller (no session id) attributes zero events',
    );
  });

  await t.test('byTier: exact tier census; Σ byTier === Σ items; expired/tombstoned excluded', () => {
    const { store, dbPath } = makeStore(t);

    // 5-row distribution: one live row per tier + one legacy-NULL.
    insertTieredItem(store, 'bt-session', 'episodic', 'session');
    insertTieredItem(store, 'bt-workspace', 'semantic', 'workspace');
    insertTieredItem(store, 'bt-user', 'semantic', 'user');
    insertTieredItem(store, 'bt-global', 'procedural', 'global');
    insertTieredItem(store, 'bt-legacy', 'semantic', 'null-legacy');
    flipLegacyToNull(dbPath, 'memory_items', 'id', ['bt-legacy']);
    // Caliber guards: expired and tombstoned rows are in NEITHER census.
    insertTieredItem(store, 'bt-expired', 'semantic', 'user', { expired: true });
    insertTieredItem(store, 'bt-dead', 'semantic', 'global');
    store.tombstoneItem('bt-dead');

    const stats = store.stats();
    assert.deepEqual(
      stats.byTier,
      { session: 1, workspace: 1, user: 1, global: 1, legacyNull: 1 },
      'exact per-tier census of the 5-row distribution',
    );
    const tierSum =
      stats.byTier.session + stats.byTier.workspace + stats.byTier.user +
      stats.byTier.global + stats.byTier.legacyNull;
    const itemsSum = stats.items.episodic + stats.items.semantic + stats.items.procedural;
    assert.equal(tierSum, 5, 'tier census counts exactly the live distribution');
    assert.equal(itemsSum, 5, 'items census excludes expired + tombstoned rows');
    assert.equal(tierSum, itemsSum, 'Σ byTier === Σ items (same LIVE + UNEXPIRED population)');
    assert.equal(stats.tombstoned, 1, 'tombstoned counter still global-caliber');
  });

  await t.test('facade dual contract: scoped form scoped-only, no-arg form global-unchanged', async (t) => {
    const ctx = createMockContext();
    t.after(() => {
      const store = ctx.services.get('memory-store') as { close(): void } | undefined;
      try {
        store?.close();
      } catch {
        // already closed
      }
    });
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-facade-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    MemoryPalacePlugin(ctx as never, {
      storagePath: join(dir, 'facade.db'),
      embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
      scope: 'user',
    });
    const palace = ctx.services.get('memory-palace') as {
      store: MemoryStore;
      stats: (scope?: { userId?: string; workspaceId?: string; sessionId?: string }) => unknown;
    };
    const store = palace.store;

    // u1: 3 live rows; u2: 1 live + 1 tombstoned; 1 global; 1 expired u1 row.
    const mk = (id: string, layer: MemoryLayer, expired = false) => ({
      id,
      layer,
      content: `facade|${id}`,
      metadata: { source: 'system', ...(expired ? { expiresAt: T0 - DAY } : {}) },
      createdAt: T0,
      updatedAt: T0,
      importance: 0.5,
      accessCount: 0,
      lastAccessedAt: 0,
    });
    store.insertItem(mk('f-u1-a', 'semantic'), { userId: 'u1' });
    store.insertItem(mk('f-u1-b', 'semantic'), { userId: 'u1' });
    store.insertItem(mk('f-u1-c', 'procedural'), { userId: 'u1' });
    store.insertItem(mk('f-u2-a', 'semantic'), { userId: 'u2' });
    store.insertItem(mk('f-u2-dead', 'semantic'), { userId: 'u2' });
    store.tombstoneItem('f-u2-dead');
    store.insertItem(mk('f-global', 'episodic'), {});
    store.insertItem(mk('f-u1-exp', 'semantic', true), { userId: 'u1' });

    // Brute force for u1's cascade (LIVE+UNEXPIRED unscoped read + JS mirror).
    const u1Widest = widestLevel(scopeLevels('user', { userId: 'u1', sessionId: 's1' }));
    const bruteItems: Record<string, number> = { episodic: 0, semantic: 0, procedural: 0 };
    for (const layer of LAYERS) {
      for (const it of store.listItemsByLayer(layer, 1000)) {
        if (visibleAtLevel(it, u1Widest)) bruteItems[layer] = (bruteItems[layer] ?? 0) + 1;
      }
    }

    // Scoped form: shape + exact differential + no admin fields mixed in.
    const scopedResult = palace.stats({ userId: 'u1', sessionId: 's1' }) as {
      scoped: Record<string, unknown> & { items: Record<string, number> };
    };
    assert.ok(scopedResult && typeof scopedResult === 'object' && 'scoped' in scopedResult,
      'scoped form is wrapped as { scoped }');
    assert.deepEqual(scopedResult.scoped.items, bruteItems,
      'facade scoped items === brute-force visibleAtLevel census');
    assert.ok(!('byTier' in scopedResult.scoped),
      'scoped form must NOT carry byTier (tenant distribution is admin-plane)');
    assert.ok(!('sizeBytes' in scopedResult.scoped),
      'scoped form carries counts only, not physical store telemetry');

    // No-arg form: the global admin-plane contract, unchanged.
    const globalResult = palace.stats() as Record<string, unknown> & {
      items: Record<string, number>;
      byTier: Record<string, number>;
    };
    assert.ok(!('scoped' in globalResult), 'no-arg form is the raw global census');
    assert.equal(
      globalResult.items.semantic + globalResult.items.episodic + globalResult.items.procedural,
      5,
      'global census counts every tenant (3×u1 + 1×u2 + 1 global; expired/tombstoned excluded)',
    );
    assert.deepEqual(globalResult.byTier, { session: 0, workspace: 0, user: 4, global: 1, legacyNull: 0 },
      'global byTier tenant distribution');
    // Regression pin: the no-arg facade value equals the store-level census.
    const storeLevel = store.stats();
    assert.deepEqual(globalResult, storeLevel, 'facade no-arg stats === store global stats (contract unchanged)');
  });

  await t.test('inspect isolation: counts reflect only the caller\'s visible set; anonymous sees global only', async (t) => {
    const ctx = createMockContext();
    t.after(() => {
      const store = ctx.services.get('memory-store') as { close(): void } | undefined;
      try {
        store?.close();
      } catch {
        // already closed
      }
    });
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-inspect-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    MemoryPalacePlugin(ctx as never, {
      storagePath: join(dir, 'inspect.db'),
      embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
      scope: 'user',
    });
    const palace = ctx.services.get('memory-palace') as { store: MemoryStore };
    const store = palace.store;
    const inspect = ctx.tools.find((td) => td.name === 'memory_inspect');
    assert.ok(inspect, 'memory_inspect registered');

    const mk = (id: string, layer: MemoryLayer) => ({
      id,
      layer,
      content: `inspect|${id}`,
      metadata: { source: 'system' },
      createdAt: T0,
      updatedAt: T0,
      importance: 0.5,
      accessCount: 0,
      lastAccessedAt: 0,
    });
    // u1: 3 rows; u2: 2 rows (1 later tombstoned BY u2); 1 global row.
    store.insertItem(mk('i-u1-a', 'semantic'), { userId: 'u1', sessionId: 's1' });
    store.insertItem(mk('i-u1-b', 'semantic'), { userId: 'u1', sessionId: 's1' });
    store.insertItem(mk('i-u1-c', 'episodic'), { userId: 'u1', sessionId: 's1' });
    store.insertItem(mk('i-u2-a', 'semantic'), { userId: 'u2', sessionId: 's2' });
    store.insertItem(mk('i-u2-b', 'procedural'), { userId: 'u2', sessionId: 's2' });
    store.insertItem(mk('i-global', 'semantic'), {});
    // Scoped graph rows: one private entity per tenant + one global.
    const ent = (id: string, name: string): Entity => ({
      id,
      name,
      type: 'concept',
      aliases: [],
      firstSeenAt: T0,
      lastSeenAt: T0,
      mentionCount: 1,
    });
    store.upsertEntity(ent('ie-u1', 'IsolationU1'), { visibility: 'user', userId: 'u1' });
    store.upsertEntity(ent('ie-u2', 'IsolationU2'), { visibility: 'user', userId: 'u2' });
    store.upsertEntity(ent('ie-g', 'IsolationShared'), { visibility: 'global' });
    // u2 tombstones one of their own — invisible to u1's counters.
    store.tombstoneItem('i-u2-b');

    const u1Tctx = { sessionId: 's1', userId: 'u1' };
    const res = (await inspect.run({}, u1Tctx)) as {
      stats: {
        items: Record<string, number>;
        entities: number;
        tombstoned: number;
        sizeBytes: number;
      };
      health: { tombstoned: number; spaceCount: number };
    };

    // FLAGSHIP: u1's counts are EXACTLY u1's visible set — the brute-force
    // differential, not just an inequality. u2's private rows, u2's
    // tombstone, and u2's private entity are all absent.
    const u1Widest = widestLevel(scopeLevels('user', { userId: 'u1', sessionId: 's1' }));
    const bruteItems: Record<string, number> = { episodic: 0, semantic: 0, procedural: 0 };
    for (const layer of LAYERS) {
      for (const it of store.listItemsByLayer(layer, 1000)) {
        if (visibleAtLevel(it, u1Widest)) bruteItems[layer] = (bruteItems[layer] ?? 0) + 1;
      }
    }
    assert.deepEqual(res.stats.items, bruteItems, 'inspect items === brute-force u1-visible census');
    assert.equal(
      res.stats.items.semantic + res.stats.items.episodic + res.stats.items.procedural,
      4,
      'u1 sees own 3 rows + 1 global — never u2\'s 2',
    );
    assert.equal(res.stats.entities, 2, 'u1 sees own entity + the shared one, not u2\'s');
    assert.equal(res.stats.tombstoned, 0, 'u2\'s tombstone is invisible in u1\'s counter');
    assert.equal(res.health.tombstoned, 0, 'health panel mirrors the scoped tombstone count');
    assert.equal(res.stats.sizeBytes > 0, true, 'physical size telemetry still reported');

    // u1 tombstones one of their own: the scoped counter moves for u1 only.
    store.tombstoneItem('i-u1-c');
    const res2 = (await inspect.run({}, u1Tctx)) as {
      stats: { items: Record<string, number>; tombstoned: number };
      health: { tombstoned: number };
    };
    assert.equal(res2.stats.items.episodic, 0, 'u1\'s tombstoned episodic row leaves the census');
    assert.equal(res2.stats.tombstoned, 1, 'u1\'s scoped tombstone counter = 1');
    assert.equal(res2.health.tombstoned, 1, 'health panel tracks the scoped tombstones');
    assert.equal(store.stats().tombstoned, 2, 'store-level (admin) tombstone count stays global');

    // ANONYMOUS inspect: the global tier only — no tenant rows, no tenant
    // tombstones, no private entities.
    const anon = (await inspect.run({}, { sessionId: 's-anon' })) as {
      stats: { items: Record<string, number>; entities: number; tombstoned: number };
    };
    assert.deepEqual(
      anon.stats.items,
      { episodic: 0, semantic: 1, procedural: 0 },
      'anonymous caller counts the global row only',
    );
    assert.equal(anon.stats.entities, 1, 'anonymous caller sees the shared entity only');
    assert.equal(anon.stats.tombstoned, 0, 'tenant tombstones invisible to the anonymous counter');
  });
});
