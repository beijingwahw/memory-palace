/**
 * Genesis integrity tests — self-heal + durability + backup for the store:
 *   1. integrityCheck on a pristine store is all-zero and ok,
 *   2. a deliberately dirtied store (orphan bucket row, dangling entity
 *      ref, dead tree child refs, overdue tombstone) reports every class,
 *      repairs conservatively (valid refs survive, dangling memory is
 *      kept), re-checks clean, and repairs idempotently,
 *   2b. ghost rows (visibility tier set, owner column NULL — invisible
 *      at every level) are counted and fail ok, survive the DEFAULT
 *      repair untouched, tombstone only on the explicit opt-in (soft
 *      delete: the audit read still sees them), and converge idempotently,
 *   3. backupTo produces a compact VACUUM INTO snapshot that mounts as a
 *      store and refuses to overwrite an existing target,
 *   4. two store instances on ONE file see each other's writes (WAL +
 *      user_version across connections) — the foundation that keeps SWR
 *      cache invalidation correct in multi-process setups,
 *   5. listRecentTrajectoriesFor owner anchoring: user filter first,
 *      workspace fallback, neither → [].
 *
 * Some corruption states (raw vec_buckets orphans, backdated tombstones)
 * cannot be produced through the public API by design, so they are seeded
 * through a second better-sqlite3 connection. Temp cleanup follows the
 * Windows WAL order proven in hardening.test.ts: every store-close hook is
 * registered BEFORE the directory-removal hook, or rmSync hits an open
 * WAL handle (EPERM).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { MemoryStore } from '../src/services/memory-store.ts';
import { scopeLevels, widestLevel } from '../src/utils/scope.ts';
import type { MemoryItem } from '../src/types/index.ts';

// ───────────────────────────── helpers ─────────────────────────────

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

const DIMS = 64;

let fixtureSeq = 0;

/** Deterministic store item fixture (fixed clock, caller supplies the rest). */
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = 1_700_000_000_000 + fixtureSeq++;
  return {
    id: `genesis-${fixtureSeq}`,
    layer: 'semantic',
    content: 'genesis fixture content',
    metadata: { source: 'user' },
    createdAt: now,
    updatedAt: now,
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

/** Fresh subtest-private store; close registered before the dir rm (WAL). */
function freshStore(t: AfterHooks): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-integrity-'));
  const store = new MemoryStore({
    storagePath: join(dir, 'store.db'),
    dimensions: DIMS,
    scope: 'user',
  });
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return store;
}

/** Throwaway dir for tests that manage their own store lifetimes + cleanup. */
function freshDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `genesis-integrity-${label}-`));
}

// ───────────────────── 1: pristine store ─────────────────────

test('integrity: pristine store reports all-zero counters and ok=true', (t) => {
  const store = freshStore(t);
  const r = store.integrityCheck();
  assert.equal(r.vecBucketOrphans, 0);
  assert.equal(r.danglingEntityRefs, 0);
  assert.equal(r.danglingTreeChildren, 0);
  assert.equal(r.tombstoneOverdue, 0);
  assert.equal(r.strandedEmbeddings, 0);
  assert.equal(r.ghostRows, 0);
  assert.equal(r.ok, true);
  // One human-readable line per class (ghost rows made it 6; stranded
  // embeddings remains the only advisory one).
  assert.equal(r.details.length, 6);
  for (const line of r.details) assert.ok(line.length > 0);
});

// ───────────────────── 2: dirty store → repair → clean ─────────────────────

test('integrity: dirty store reports, repairs conservatively, re-checks clean and idempotent', (t) => {
  const dir = freshDir('dirty');
  const path = join(dir, 'store.db');
  const store = new MemoryStore({ storagePath: path, dimensions: DIMS });
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A live item and a valid child node the repair MUST keep, plus a parent
  // node whose child_ids mix valid refs (node + item) with a dead one.
  store.insertItem(makeItem({ id: 'int-live-item', layer: 'semantic' }), { userId: 'u-int' });
  store.upsertTreeNode({
    nodeId: 'int-child-ok',
    level: 'session',
    periodStart: 0,
    periodEnd: 10,
    content: 'valid child',
    tokenCount: 2,
    childIds: [],
  });
  store.upsertTreeNode({
    nodeId: 'int-week',
    level: 'week',
    periodStart: 0,
    periodEnd: 100,
    content: 'parent',
    tokenCount: 3,
    childIds: ['int-child-ok', 'int-live-item', 'int-child-missing'],
  });
  // Dangling entity ref through the PUBLIC api — insertItem trusts the
  // caller's entityId, which is exactly how this drift arises in reality.
  store.insertItem(
    makeItem({ id: 'int-dangler', layer: 'semantic', entityId: 'int-ghost-entity' }),
    { userId: 'u-int' },
  );

  // Corruption states only raw SQL can reach: a bucket row for an item
  // that never existed, and a tombstone backdated past the 7-day grace.
  const raw = new Database(path);
  raw
    .prepare("INSERT INTO vec_buckets (space, bucket_key, item_id) VALUES ('int-space', 'bk', 'int-ghost-item')")
    .run();
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  raw
    .prepare(
      `INSERT INTO memory_items (id, layer, content, metadata, created_at, updated_at, deleted_at, visibility)
       VALUES ('int-stale-tomb', 'episodic', 'gone', '{}', ?, ?, ?, 'global')`,
    )
    .run(eightDaysAgo - 1000, eightDaysAgo - 500, eightDaysAgo);
  raw.close();

  const before = store.integrityCheck();
  assert.ok(before.vecBucketOrphans >= 1, 'orphan bucket row is counted');
  assert.ok(before.danglingEntityRefs >= 1, 'dangling entity ref is counted');
  assert.ok(before.danglingTreeChildren >= 1, 'dead tree child ref is counted');
  assert.ok(before.tombstoneOverdue >= 1, 'overdue tombstone is counted');
  // All dirt above came through the public API / bare SQL with proper
  // owner columns — none of it is ghost rows (that class needs a tier
  // set with a NULL owner, which no public write path produces).
  assert.equal(before.ghostRows, 0);
  assert.equal(before.ok, false);

  const rep = store.repairIntegrity();
  assert.ok(rep.vecBucketOrphansRemoved >= 1);
  assert.ok(rep.danglingEntityRefsCleared >= 1);
  assert.ok(rep.danglingTreeChildrenPruned >= 1);
  assert.ok(rep.tombstonesPurged >= 1);
  assert.equal(rep.ghostRowsTombstoned, 0, 'default repair never touches ghosts');

  // Conservative semantics: valid child refs survive, only the dead one is
  // pruned from child_ids.
  const week = store.listTreeNodes('week', undefined).find((n) => n.nodeId === 'int-week');
  assert.deepEqual(week?.childIds, ['int-child-ok', 'int-live-item']);
  // The dangling ref was NULLED, the memory itself survived.
  const dangler = store.getItem('int-dangler');
  assert.ok(dangler, 'repaired item is still live');
  assert.equal(dangler?.entityId, undefined, 'entity_id cleared, item kept');

  const after = store.integrityCheck();
  assert.equal(after.vecBucketOrphans, 0);
  assert.equal(after.danglingEntityRefs, 0);
  assert.equal(after.danglingTreeChildren, 0);
  assert.equal(after.tombstoneOverdue, 0);
  assert.equal(after.ghostRows, 0);
  assert.equal(after.ok, true);

  // Idempotent: a second repair over a clean store touches nothing.
  const rep2 = store.repairIntegrity();
  assert.equal(rep2.vecBucketOrphansRemoved, 0);
  assert.equal(rep2.danglingEntityRefsCleared, 0);
  assert.equal(rep2.danglingTreeChildrenPruned, 0);
  assert.equal(rep2.tombstonesPurged, 0);
  assert.equal(rep2.ghostRowsTombstoned, 0);
});

// ───────────────────── 2b: ghost rows (tier set, owner NULL) ─────────────────────

test('integrity: ghost rows fail ok, survive default repair, tombstone only on opt-in, idempotent', (t) => {
  const dir = freshDir('ghost');
  const path = join(dir, 'store.db');
  const store = new MemoryStore({ storagePath: path, dimensions: DIMS, scope: 'user' });
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // One legitimate row via the public API — the ghost class must not
  // swallow properly owned writes.
  store.insertItem(makeItem({ id: 'ghost-live-item', layer: 'semantic' }), { userId: 'u-ghost' });

  // Ghost rows are unreachable through the public API (every write path
  // stamps the owner column its tier names), so like the raw corruption
  // states above they are seeded through a second bare connection: one
  // per tier/owner mismatch.
  const raw = new Database(path);
  const seedGhost = raw.prepare(
    `INSERT INTO memory_items (id, layer, content, metadata, created_at, updated_at, visibility)
     VALUES (?, 'episodic', 'ghost', '{}', ?, ?, ?)`,
  );
  const now = Date.now();
  seedGhost.run('ghost-s', now, now, 'session'); // session_id stays NULL
  seedGhost.run('ghost-w', now, now, 'workspace'); // workspace_id stays NULL
  seedGhost.run('ghost-u', now, now, 'user'); // user_id stays NULL
  raw.close();

  // (a) all three tiers' ghosts are counted, and data-loss grade means
  // ok:false even though every other class here is clean.
  const before = store.integrityCheck();
  assert.equal(before.ghostRows, 3);
  assert.equal(before.ok, false);
  assert.ok(
    before.details.some((d) =>
      d.includes('legacy invisible-forever rows; resolution requires ownership decision, see repairIntegrity opt-in'),
    ),
    'details carry the human-readable ghost summary',
  );

  // (b) the DEFAULT repair is conservative: resolving a ghost is an
  // ownership decision, so the pass leaves them exactly as they were.
  const repDefault = store.repairIntegrity();
  assert.equal(repDefault.ghostRowsTombstoned, 0);
  const mid = store.integrityCheck();
  assert.equal(mid.ghostRows, 3);
  assert.equal(mid.ok, false);
  assert.ok(store.getItem('ghost-s', { liveOnly: true }), 'default repair left the ghost row live');

  // (c) the opt-in tombstones them — SOFT delete: the audit (default)
  // read still returns the rows, the live read excludes them, the
  // counter converges to zero and ok recovers.
  const repOpt = store.repairIntegrity({ ghostRows: 'tombstone' });
  assert.equal(repOpt.ghostRowsTombstoned, 3);
  const after = store.integrityCheck();
  assert.equal(after.ghostRows, 0);
  assert.equal(after.ok, true);
  for (const id of ['ghost-s', 'ghost-w', 'ghost-u']) {
    assert.ok(store.getItem(id), `${id}: tombstoned row survives the audit read (soft, not hard)`);
    assert.equal(store.getItem(id, { liveOnly: true }), null, `${id}: live read excludes it`);
  }

  // (d) idempotent: a second opt-in pass over a converged store is all
  // zeros (fresh ghost tombstones sit inside the 7-day grace window, so
  // the purge step keeps them too).
  const rep2 = store.repairIntegrity({ ghostRows: 'tombstone' });
  assert.equal(rep2.ghostRowsTombstoned, 0);
  assert.equal(rep2.vecBucketOrphansRemoved, 0);
  assert.equal(rep2.danglingEntityRefsCleared, 0);
  assert.equal(rep2.danglingTreeChildrenPruned, 0);
  assert.equal(rep2.tombstonesPurged, 0);
  assert.equal(store.integrityCheck().ok, true);
});

// ───────────────────── 3: backup snapshot ─────────────────────

test('backup: VACUUM INTO snapshot exists, is mountable, and never overwrites', (t) => {
  const dir = freshDir('backup');
  const store = new MemoryStore({ storagePath: join(dir, 'store.db'), dimensions: DIMS });
  // The snapshot is mounted mid-test; its close must run before the rm
  // (Windows WAL ordering, see header), so later instances are collected
  // here instead of registering their own — later — hooks.
  const mounted: MemoryStore[] = [];
  t.after(() => store.close());
  t.after(() => {
    for (const m of mounted) m.close();
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 3; i++) {
    store.insertItem(makeItem({ id: `bk-${i}`, layer: 'semantic' }), { userId: 'u-bk' });
  }

  const target = join(dir, 'snapshot.db');
  store.backupTo(target);
  assert.ok(existsSync(target), 'snapshot file exists');
  assert.ok(statSync(target).size > 0, 'snapshot is non-empty');

  // Mountability: a fresh store over the snapshot reads the same items —
  // VACUUM INTO folds committed WAL pages into the logical copy, so the
  // backup is not stale relative to un-checkpointed writes.
  mounted.push(new MemoryStore({ storagePath: target, dimensions: DIMS }));
  const restored = mounted[0]!;
  assert.equal(restored.listItemsByLayer('semantic').length, 3);

  // VACUUM INTO semantics: an existing target is refused, not clobbered.
  assert.throws(() => store.backupTo(target));
});

// ───────────────────── 4: two instances, one file ─────────────────────

test('multi-instance: WAL + user_version make writes visible across connections', (t) => {
  const dir = freshDir('multi');
  const path = join(dir, 'store.db');
  const a = new MemoryStore({ storagePath: path, dimensions: DIMS, scope: 'user' });
  const b = new MemoryStore({ storagePath: path, dimensions: DIMS, scope: 'user' });
  t.after(() => a.close());
  t.after(() => b.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const v0 = b.dataVersion();
  a.insertItem(makeItem({ id: 'mp-item', layer: 'semantic' }), { userId: 'u-mp' });

  // user_version lives in the db header: A's bump commits through the WAL
  // and B — a separate connection, as a separate process would be — must
  // observe it immediately. This is the root proof that SWR caches keyed
  // on dataVersion() invalidate correctly across processes.
  assert.ok(b.dataVersion() > v0, 'cross-instance dataVersion strictly grows');

  const level = widestLevel(scopeLevels('user', { userId: 'u-mp' }));
  const seen = b.listItemsByLayerScoped('semantic', level).map((i) => i.id);
  assert.ok(seen.includes('mp-item'), 'cross-instance scoped read sees the row');

  // busy_timeout is per-connection and real lock contention cannot be
  // produced deterministically in a test, so its wait-path is not asserted
  // here — the constructor pragma applying it IS the contract.
});

// ───────────────────── 5: owner-anchored trajectories ─────────────────────

test('trajectories: listRecentTrajectoriesFor anchors user-first, workspace fallback, neither → []', (t) => {
  const store = freshStore(t);
  // u1: one session of 3 chronological queries; u2: one of 2; w1 (no
  // user): one of 2. Trajectories count only sessions with >= 2 queries.
  for (const q of ['q-one', 'q-two', 'q-three']) {
    store.logQuery({ sessionId: 's-u1', userId: 'u1', query: q });
  }
  for (const q of ['q-other', 'q-more']) {
    store.logQuery({ sessionId: 's-u2', userId: 'u2', query: q });
  }
  for (const q of ['w-one', 'w-two']) {
    store.logQuery({ sessionId: 's-w1', workspaceId: 'w1', query: q });
  }

  const u1 = store.listRecentTrajectoriesFor({ userId: 'u1' });
  assert.equal(u1.length, 1);
  assert.deepEqual(u1[0], ['q-one', 'q-two', 'q-three'], 'time-ascending within session');

  const w1 = store.listRecentTrajectoriesFor({ workspaceId: 'w1' });
  assert.equal(w1.length, 1);
  assert.deepEqual(w1[0], ['w-one', 'w-two']);

  // userId wins when both anchors are present.
  assert.equal(store.listRecentTrajectoriesFor({ userId: 'u1', workspaceId: 'w1' }).length, 1);

  // No anchor at all → no trajectories.
  assert.deepEqual(store.listRecentTrajectoriesFor({}), []);
});
