/**
 * EXHAUSTIVE DECISION-TABLE PROOF of the four-tier visibility ACL
 * (src/utils/scope.ts + MemoryStore's scoped read paths).
 *
 * This is a PROOF, not a sampling property test: the complete ACL state
 * space is enumerated cell by cell and every cell is checked against THREE
 * independent authorities that must agree exactly:
 *
 *   a) SQL truth   — the real SQLite queries (listItemsByLayerScoped with
 *                    the design-mandated LIMIT 100, plus getItemInScope,
 *                    findItemIdsByContentScoped and scanBySimilarity's
 *                    scope fragment as extra scoped read paths);
 *   b) JS mirror   — visibleAtLevel() over the rowToItem-materialized row
 *                    (the differential test, promoted to full coverage);
 *   c) prophecy    — a hand-coded truth table written from the DOCUMENTED
 *                    semantics only (scope.ts's header comment): effective
 *                    home = narrowest id-backed tier at-or-below the kind
 *                    (falling back to the kind itself), tier rows need
 *                    EXACT owner-id equality, global and NULL-legacy rows
 *                    are visible to everyone. The prophecy shares no code
 *                    with scope.ts.
 *
 * Coverage space (all of it — no sampling):
 *   row tier        ∈ { session, workspace, user, global, NULL-legacy }  (5)
 *   row owner ids   ∈ {userId, workspaceId, sessionId} each present/absent (2^3 = 8)
 *   caller identity ∈ {userId, workspaceId, sessionId} each present/absent (2^3 = 8)
 *   scope kind      ∈ { session, workspace, user }                        (3)
 *   → 5 × 8 × 8 × 3 = 960 logical cells, each evaluated on ALL THREE
 *     memory layers (episodic / semantic / procedural — the ACL is
 *     layer-independent, and this file PROVES that by running the whole
 *     grid per layer): 2 880 cell evaluations, 14 400 path assertions.
 *   Plus: resolveWriteTier's full 4 × 8 = 32-cell matrix against a frozen
 *   hand-computed table, a fail-closed structural pass for anonymous
 *   callers, and a foreign-owner-id pass pinning EXACT equality (the 960
 *   grid uses one fixed id value per dimension, where "equal" reduces to
 *   "present on both sides"; the foreign pass covers "present but
 *   different value" separately).
 *
 * Physical rows: cells are deduplicated to the 120 unique (layer, tier,
 * owner-combo) states — 40 rows per layer, content encoding that state.
 * One row PER CELL (960 per layer) would make the all-ids caller's
 * widest-level query match up to 672 rows > LIMIT 100, turning membership
 * into an order/pagination artifact and the proof unsound; deduplicated,
 * any single query matches at most 28 of a layer's 40 rows < 100, so the
 * literal listItemsByLayerScoped(layer, widest, 100) membership check is
 * exact and order-independent. NULL-legacy rows (pre-v4-ACL rows, where
 * the ALTER left visibility NULL and every read path folds them into the
 * global branch) are inserted through the public insertItem and then
 * flipped to visibility IS NULL via a second better-sqlite3 connection —
 * the public write API cannot produce NULL, by design.
 *
 * Determinism: no randomness anywhere — fixed owner ids, fixed epoch
 * timestamps, fixed embeddings, one shared database built once per
 * subtest (the Windows WAL close-before-rm hook discipline is copied
 * from integration.test.ts).
 *
 * << MAINTENANCE MANDATE >> When a tier is added, an owner column
 * changes, or ANY semantics of scope.ts changes, this truth table MUST
 * be updated in the same change — an ACL edit without a matching edit
 * here is exactly the class of silent regression this file exists to
 * make impossible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { MemoryStore } from '../src/services/memory-store.ts';
import {
  resolveWriteTier,
  scopeLevels,
  widestLevel,
  visibleAtLevel,
} from '../src/utils/scope.ts';
import type { ScopeIdentity } from '../src/utils/scope.ts';
import type {
  MemoryItem,
  MemoryLayer,
  MemoryScopeKind,
  VisibilityTier,
} from '../src/types/index.ts';

// ---------------------------------------------------------------------------
// Fixture vocabulary — fully deterministic.
// ---------------------------------------------------------------------------

/** Fixed owner-id VALUES: in the single-value space, "equal" ⇔ "present on
 * both row and caller"; value inequality gets its own subtest below. */
const UID = 'u-alice';
const WID = 'ws-one';
const SID = 'sess-x';

/** Bitmask convention for the 8 owner/caller combos: 1=userId, 2=workspaceId, 4=sessionId. */
const hasUser = (c: number): boolean => (c & 1) !== 0;
const hasWs = (c: number): boolean => (c & 2) !== 0;
const hasSess = (c: number): boolean => (c & 4) !== 0;

const idsFor = (c: number): ScopeIdentity => ({
  userId: hasUser(c) ? UID : undefined,
  workspaceId: hasWs(c) ? WID : undefined,
  sessionId: hasSess(c) ? SID : undefined,
});

const LAYERS: readonly MemoryLayer[] = ['semantic', 'episodic', 'procedural'];
const KINDS: readonly MemoryScopeKind[] = ['session', 'workspace', 'user'];

/** 'null-legacy' models a pre-ACL row whose visibility column IS NULL. */
const TIER_STATES = ['session', 'workspace', 'user', 'global', 'null-legacy'] as const;
type TierState = (typeof TIER_STATES)[number];

const SPACE = 'acl-proof-space';
const T0 = 1_700_000_000_000; // fixed epoch — no Date.now() in fixtures
const PROBE = new Float32Array([1, 0, 0, 0]);

// ---------------------------------------------------------------------------
// Hand-coded truth-table prophecy — written ONLY from scope.ts's documented
// semantics; deliberately shares no code or constants with the module.
// ---------------------------------------------------------------------------

const SPEC_ORDER = ['session', 'workspace', 'user', 'global'] as const;

/** Doc: "the narrowest tier in [session … kind] whose owner id is present
 * (falling back to the configured kind itself when none is)". */
function specEffectiveHome(kind: MemoryScopeKind, caller: number): 'session' | 'workspace' | 'user' {
  if (hasSess(caller)) return 'session';
  if (kind !== 'session' && hasWs(caller)) return 'workspace';
  if (kind === 'user' && hasUser(caller)) return 'user';
  return kind;
}

/**
 * The prophecy: is the row visible at the WIDEST cumulative level for
 * (kind, caller)? Rows: NULL-legacy reads as global; tier rows need the
 * tier present in the home→global cascade AND exact owner-id equality.
 */
function specExpectedVisible(
  tier: TierState,
  row: number,
  caller: number,
  kind: MemoryScopeKind,
): boolean {
  const home = specEffectiveHome(kind, caller);
  const widest = SPEC_ORDER.slice(SPEC_ORDER.indexOf(home));
  if (tier === 'global' || tier === 'null-legacy') {
    return widest.includes('global'); // always true — cascade ends at global
  }
  if (tier === 'session') {
    return widest.includes('session') && hasSess(caller) && hasSess(row);
  }
  if (tier === 'workspace') {
    return widest.includes('workspace') && hasWs(caller) && hasWs(row);
  }
  return widest.includes('user') && hasUser(caller) && hasUser(row);
}

// ---------------------------------------------------------------------------
// Store fixture (Windows WAL cleanup discipline copied from
// integration.test.ts: the close hook registers BEFORE the rm hook, because
// hooks run in registration order and rmSync cannot remove a directory that
// still holds an open WAL handle).
// ---------------------------------------------------------------------------

interface AfterHooks {
  after: (fn: () => void) => void;
}

const makeStore = (t: AfterHooks): { store: MemoryStore; dbPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-acl-'));
  const dbPath = join(dir, 'memory.db');
  let store: MemoryStore | null = new MemoryStore({
    storagePath: dbPath,
    dimensions: 4,
    scope: 'user',
    activeSpace: SPACE,
    quantization: 'float32',
  });
  // Registered FIRST so it runs BEFORE the directory removal (close → rm).
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

interface GridRow {
  id: string;
  content: string;
  layer: MemoryLayer;
  tier: TierState;
  combo: number;
  /** Materialized through the store's own rowToItem (owner backfill + all). */
  item: MemoryItem;
}

/** Insert one row whose tier and owner columns are set INDEPENDENTLY. */
function insertTiered(
  store: MemoryStore,
  layer: MemoryLayer,
  tier: TierState,
  id: string,
  content: string,
  ctx: ScopeIdentity,
): void {
  store.insertItem(
    {
      id,
      layer,
      content,
      embedding: new Float32Array([1, 0, 0, 0]),
      metadata: {
        source: 'system',
        // Explicit stamp for real tiers (owner columns must NOT re-derive
        // it: a 'global' row owned by a user stays global); null-legacy
        // rows carry whatever stamp, flipped to NULL right after.
        ...(tier === 'null-legacy' ? {} : { visibility: tier }),
      },
      createdAt: T0,
      updatedAt: T0,
      importance: 0.5,
      accessCount: 0,
      lastAccessedAt: 0,
    },
    ctx,
  );
}

/** Flip the null-legacy rows to visibility IS NULL via a second connection
 * (the public API cannot write NULL — the legacy state predates it). */
function flipLegacyToNull(dbPath: string, ids: string[]): void {
  const raw = new Database(dbPath);
  try {
    raw
      .prepare(`UPDATE memory_items SET visibility = NULL WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
  } finally {
    raw.close();
  }
}

/** Build the full 120-row grid (5 tiers × 8 owner combos × 3 layers). */
function buildGrid(store: MemoryStore, dbPath: string): GridRow[] {
  const rows: GridRow[] = [];
  const legacyIds: string[] = [];
  for (const layer of LAYERS) {
    for (let ti = 0; ti < TIER_STATES.length; ti++) {
      const tier = TIER_STATES[ti]!;
      for (let rc = 0; rc < 8; rc++) {
        const id = `acl-${layer.slice(0, 4)}-${ti}-${rc}`;
        const content = `acl-proof|${layer}|${tier}|r${rc}`;
        insertTiered(store, layer, tier, id, content, idsFor(rc));
        if (tier === 'null-legacy') legacyIds.push(id);
      }
    }
  }
  flipLegacyToNull(dbPath, legacyIds);

  // Fixture integrity — the proof is only as good as the rows it stands on:
  // verify the tier column AND the owner backfill for every single row.
  const raw = new Database(dbPath);
  try {
    const groups = raw
      .prepare("SELECT IFNULL(visibility, '(null)') AS v, COUNT(*) AS n FROM memory_items GROUP BY v")
      .all() as Array<{ v: string; n: number }>;
    assert.deepEqual(
      groups.map((g) => `${g.v}:${g.n}`).sort(),
      ['(null):24', 'global:24', 'session:24', 'user:24', 'workspace:24'],
      'tier column distribution: 24 rows per tier state per grid',
    );
  } finally {
    raw.close();
  }
  for (const layer of LAYERS) {
    for (let ti = 0; ti < TIER_STATES.length; ti++) {
      const tier = TIER_STATES[ti]!;
      for (let rc = 0; rc < 8; rc++) {
        const id = `acl-${layer.slice(0, 4)}-${ti}-${rc}`;
        const item = store.getItem(id);
        assert.ok(item, `fixture row materialized: ${id}`);
        assert.equal(
          item.visibility,
          tier === 'null-legacy' ? undefined : tier,
          `visibility column backfill for ${id}`,
        );
        assert.equal(item.userId, hasUser(rc) ? UID : undefined, `user_id column for ${id}`);
        assert.equal(item.workspaceId, hasWs(rc) ? WID : undefined, `workspace_id column for ${id}`);
        assert.equal(item.sessionId, hasSess(rc) ? SID : undefined, `session_id column for ${id}`);
        rows.push({
          id,
          content: `acl-proof|${layer}|${tier}|r${rc}`,
          layer,
          tier,
          combo: rc,
          item,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The proof.
// ---------------------------------------------------------------------------

test('four-tier visibility ACL — exhaustive decision-table proof', async (t) => {
  await t.test('960-cell truth table × 3 layers — SQL ⇔ JS mirror ⇔ prophecy', () => {
    const { store, dbPath } = makeStore(t);
    const rows = buildGrid(store, dbPath);
    const byKey = new Map(rows.map((r) => [`${r.layer}|${r.tier}|${r.combo}`, r] as const));
    assert.equal(rows.length, 120, '120 unique physical states');

    let cellEvals = 0;
    let pathChecks = 0;
    let visibleCells = 0;
    const t0 = Date.now();

    for (const layer of LAYERS) {
      for (let ti = 0; ti < TIER_STATES.length; ti++) {
        const tier = TIER_STATES[ti]!;
        for (let rc = 0; rc < 8; rc++) {
          const row = byKey.get(`${layer}|${tier}|${rc}`)!;
          for (let cc = 0; cc < 8; cc++) {
            const caller = idsFor(cc);
            for (let ki = 0; ki < KINDS.length; ki++) {
              const kind = KINDS[ki]!;
              // Documented cell numbering: 0..959 per layer.
              const cell = ((ti * 8 + rc) * 8 + cc) * 3 + ki;
              const where = `cell#${cell} [layer=${layer} tier=${tier} row=r${rc} caller=c${cc} kind=${kind}]`;
              const levels = scopeLevels(kind, caller);
              const widest = widestLevel(levels);
              const expected = specExpectedVisible(tier, rc, cc, kind);

              // (a) SQL truth — four independent scoped read paths.
              const listed = store.listItemsByLayerScoped(layer, widest, 100);
              assert.equal(
                listed.some((i) => i.id === row.id),
                expected,
                `SQL listItemsByLayerScoped ${where}`,
              );
              assert.equal(
                store.getItemInScope(row.id, levels) !== null,
                expected,
                `SQL getItemInScope (progressive levels) ${where}`,
              );
              assert.equal(
                store.findItemIdsByContentScoped(widest, row.content, 5).includes(row.id),
                expected,
                `SQL findItemIdsByContentScoped ${where}`,
              );
              assert.equal(
                store
                  .scanBySimilarity({
                    layer,
                    space: SPACE,
                    queryVector: PROBE,
                    minScore: -1, // accept everything in scope — ACL only
                    limit: 100,
                    scope: widest,
                  })
                  .some((h) => h.item.id === row.id),
                expected,
                `SQL scanBySimilarity scope fragment ${where}`,
              );

              // (b) JS mirror over the materialized row — zero divergence
              // with the SQL paths across the whole space.
              assert.equal(
                visibleAtLevel(row.item, widest),
                expected,
                `JS visibleAtLevel ${where}`,
              );

              cellEvals++;
              pathChecks += 5;
              if (expected) visibleCells++;
            }
          }
        }
      }
    }

    const ms = Date.now() - t0;
    // Coverage fingerprint: 960 cells per layer × 3, and the exact
    // visible/invisible split the prophecy implies (2/5 always-visible
    // tiers + 3 × 1/5 × 1/4 exact-owner tier matches = 0.55 per layer).
    assert.equal(cellEvals, 2880, 'evaluated every cell on every layer');
    assert.equal(pathChecks, 14400, 'five path assertions per cell');
    assert.equal(visibleCells, 1584, 'visible-cell fingerprint (528 per layer)');
    assert.equal(cellEvals - visibleCells, 1296, 'invisible-cell fingerprint (432 per layer)');
    assert.ok(ms < 5000, `whole-grid duration must stay under 5s (took ${ms}ms)`);
    console.log(
      `[exhaustive-acl] cells=${cellEvals} pathChecks=${pathChecks} ` +
        `visible=${visibleCells} invisible=${cellEvals - visibleCells} in ${ms}ms — ` +
        `SQL, JS mirror and prophecy agree on every cell`,
    );
  });

  await t.test('resolveWriteTier — full 4 × 8 = 32 matrix vs frozen table', () => {
    // Hand-frozen expectations (requested order: session, workspace, user,
    // global; key = sessionId/workspaceId/userId presence) derived from the
    // documented two-phase privacy-first rule. Note what the table shows:
    // for any valid request the outcome is the NARROWEST id-backed tier
    // (or global when no id is present at all) — phase 1 collapses
    // downward, and phase 2 only runs when nothing at-or-below the request
    // is owned, widening toward the next owned tier exactly as documented.
    const FROZEN: Record<string, string> = {
      '000': 'global global global global', // no ids at all → global, always
      '100': 'session session session session', // sessionId only
      '010': 'workspace workspace workspace workspace', // workspaceId only
      '001': 'user user user user', // userId only
      '110': 'session session session session', // session + workspace
      '101': 'session session session session', // session + user
      '011': 'workspace workspace workspace workspace', // workspace + user
      '111': 'session session session session', // all three
    };
    const REQUESTED: readonly VisibilityTier[] = ['session', 'workspace', 'user', 'global'];
    for (const [key, line] of Object.entries(FROZEN)) {
      const ids: ScopeIdentity = {
        sessionId: key[0] === '1' ? SID : undefined,
        workspaceId: key[1] === '1' ? WID : undefined,
        userId: key[2] === '1' ? UID : undefined,
      };
      const expected = line.split(' ');
      REQUESTED.forEach((req, i) => {
        const got = resolveWriteTier(req, ids);
        assert.equal(got, expected[i], `resolveWriteTier('${req}', ids=${key})`);
        // Documented invariant: a row never carries a tier its owner
        // columns can't back — the result is global or id-backed.
        const backing =
          got === 'session'
            ? ids.sessionId
            : got === 'workspace'
              ? ids.workspaceId
              : got === 'user'
                ? ids.userId
                : 'global';
        assert.ok(
          got === 'global' || backing !== undefined,
          `resolved tier '${got}' is id-backed for ids=${key}`,
        );
      });
    }
    // Outside the typed space, but the documented contract says invalid →
    // global; pinned so the fail-safe cannot regress silently.
    assert.equal(resolveWriteTier('bogus' as VisibilityTier, idsFor(7)), 'global');
  });

  await t.test('fail-closed — anonymous callers see global/NULL only', () => {
    const { store, dbPath } = makeStore(t);
    const rows = buildGrid(store, dbPath);
    const anon: ScopeIdentity = {};

    // Structural: an anonymous cascade collapses to exactly ONE level and
    // its SQL references ONLY the global/NULL disjunct — so a NULL-legacy
    // row, which this single level does return below, is reachable ONLY
    // through the global branch.
    const GLOBAL_ONLY_SQL = " AND ((visibility = 'global' OR visibility IS NULL))";
    for (const kind of KINDS) {
      const levels = scopeLevels(kind, anon);
      assert.equal(levels.length, 1, `anonymous ${kind} cascade has exactly one level`);
      assert.equal(levels[0]!.sql, GLOBAL_ONLY_SQL, `anonymous ${kind} level is global-only`);
      assert.equal(levels[0]!.params.length, 0, `anonymous ${kind} level binds no owner id`);
    }
    // The empty-cascade guard fails loud instead of returning undefined.
    assert.throws(() => widestLevel([]), /\[scope\] empty cascade/);

    for (const layer of LAYERS) {
      const levels = scopeLevels('user', anon);
      const widest = widestLevel(levels);
      const listed = store.listItemsByLayerScoped(layer, widest, 100);
      const layerRows = rows.filter((r) => r.layer === layer);
      // 8 global + 8 NULL-legacy rows per layer, nothing else.
      assert.equal(listed.length, 16, `anonymous sees exactly 16 of ${layer}'s 40 rows`);
      for (const item of listed) {
        const row = layerRows.find((r) => r.id === item.id)!;
        assert.ok(
          row.tier === 'global' || row.tier === 'null-legacy',
          `anonymous-visible row ${item.id} must be global/NULL-legacy`,
        );
      }
      for (const row of layerRows) {
        const expected = row.tier === 'global' || row.tier === 'null-legacy';
        assert.equal(
          store.getItemInScope(row.id, levels) !== null,
          expected,
          `anonymous getItemInScope ${row.id} (${row.tier})`,
        );
      }
    }
  });

  await t.test('owner ids must match EXACTLY — foreign values are invisible', () => {
    const { store, dbPath } = makeStore(t);
    // Foreign-owned rows on the semantic layer, one per tier state.
    const foreign = { userId: 'u-bob', workspaceId: 'ws-foreign', sessionId: 'sess-bob' };
    const ids = new Map<TierState, string>();
    for (const tier of TIER_STATES) {
      const id = `for-${tier}`;
      insertTiered(store, 'semantic', tier, id, `foreign|${tier}`, foreign);
      ids.set(tier, id);
    }
    flipLegacyToNull(dbPath, [ids.get('null-legacy')!]);

    // Alice carries ALL THREE ids — but none equal Bob's values.
    const aliceWidest = widestLevel(scopeLevels('user', idsFor(7)));
    const aliceList = store.listItemsByLayerScoped('semantic', aliceWidest, 100);
    for (const tier of ['session', 'workspace', 'user'] as const) {
      assert.equal(
        aliceList.some((i) => i.id === ids.get(tier)),
        false,
        `foreign-owned ${tier} row must be invisible to a same-shaped caller`,
      );
      assert.equal(
        store.getItemInScope(ids.get(tier)!, scopeLevels('user', idsFor(7))),
        null,
        `foreign-owned ${tier} row invisible via getItemInScope`,
      );
    }
    for (const tier of ['global', 'null-legacy'] as const) {
      assert.ok(
        aliceList.some((i) => i.id === ids.get(tier)),
        `foreign-owned ${tier} row is public — everyone sees it`,
      );
    }

    // Sanity: those tier rows are not dead data — Bob sees his own.
    const bob: ScopeIdentity = { userId: 'u-bob', workspaceId: 'ws-foreign', sessionId: 'sess-bob' };
    const bobList = store.listItemsByLayerScoped('semantic', widestLevel(scopeLevels('user', bob)), 100);
    for (const tier of ['session', 'workspace', 'user'] as const) {
      assert.ok(
        bobList.some((i) => i.id === ids.get(tier)),
        `the foreign owner still sees their own ${tier} row`,
      );
    }
  });
});
