/**
 * Genesis differential tests — adversarial-audit companions for the
 * memory-store core:
 *   1. upsert round-trips (fresh insert vs same-id re-insert),
 *   2. tombstone cross-over with NEW content (never resurrects),
 *   3. the named-parameter parity guard (missing/extra/quoted-literal),
 *   4. evict semantics under the portable subquery DELETE form,
 *   5. per-replica CRDT watermark deltas (listCrdtOpsSince),
 * plus a commit-stamp check for the ingestTx batch wrapper.
 *
 * Deterministic throughout: seeded PRNG, injected timestamps, throwaway
 * SQLite files. Temp cleanup follows the Windows WAL order proven in
 * hardening.test.ts: the store-close t.after hook is registered BEFORE
 * the directory-removal hook, or rmSync hits the open WAL handle (EPERM).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/services/memory-store.ts';
import { scopeLevels } from '../src/utils/scope.ts';
import { assertNamedParamParity } from '../src/utils/invariants.ts';
import { cosine } from '../src/utils/embedding.ts';
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
  const dir = mkdtempSync(join(tmpdir(), 'genesis-store-'));
  const store = new MemoryStore({
    storagePath: join(dir, 'store.db'),
    dimensions: DIMS,
    scope: 'user',
  });
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return store;
}

/** Deterministic PRNG (mulberry32) — same seed, same stream, every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'aurora', 'basalt', 'cascade', 'dynamo', 'ember', 'fjord',
  'granite', 'harbor', 'ionosphere', 'juniper', 'kelvin', 'lumen',
];

/** Deterministic pseudo-random content string. */
function randomContent(rand: () => number): string {
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    parts.push(WORDS[Math.floor(rand() * WORDS.length)] ?? 'word');
  }
  return `genesis ${parts.join(' ')}`;
}

/** Deterministic L2-unit-normalized random vector (embedding contract). */
function randomUnitVector(rand: () => number, dims: number): Float32Array {
  const v = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    v[i] = rand() * 2 - 1;
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] = v[i]! / norm;
  return v;
}

// ───────────────────── C1: upsert differential ─────────────────────

test('store: upsert fresh-insert round-trip keeps content/vector/owner/layer', (t) => {
  const store = freshStore(t);
  const rand = mulberry32(0x5eed_0001);
  const vec = randomUnitVector(rand, DIMS);
  const item = makeItem({
    id: 'gen-fresh',
    content: randomContent(rand),
    embedding: vec,
    layer: 'semantic',
  });
  store.insertItem(item, { userId: 'u-genesis' });

  const back = store.getItem('gen-fresh', { liveOnly: true });
  assert.ok(back, 'freshly inserted item is live-readable');
  assert.equal(back.content, item.content, 'content survives the round-trip');
  assert.equal(back.layer, 'semantic', 'layer survives the round-trip');
  assert.equal(back.userId, 'u-genesis', 'owner backfilled from the row');
  assert.ok(back.embedding, 'embedding present');
  const cos = cosine(vec, back.embedding);
  assert.ok(
    cos > 0.999,
    `dequantized embedding close to original (cosine ${cos.toFixed(6)})`,
  );
});

test('store: same-id re-insert swaps payload but freezes lifecycle columns', (t) => {
  const store = freshStore(t);
  const rand = mulberry32(0x5eed_0002);
  const v1 = randomUnitVector(rand, DIMS);
  const v2 = randomUnitVector(rand, DIMS);
  const t0 = 1_700_000_100_000;
  const t1 = 1_700_000_900_000;

  store.insertItem(
    makeItem({
      id: 'gen-reup', content: 'first body', embedding: v1,
      createdAt: t0, updatedAt: t0, accessCount: 7, lastAccessedAt: t0,
      importance: 0.4,
    }),
    { userId: 'u-genesis' },
  );
  // Second write under the SAME id: new content + new vector, and
  // lifecycle fields set as if the row were brand new — they must NOT
  // overwrite the stored audit columns.
  store.insertItem(
    makeItem({
      id: 'gen-reup', content: 'second body', embedding: v2,
      createdAt: t1, updatedAt: t1, accessCount: 0, lastAccessedAt: 0,
      importance: 0.8,
    }),
    { userId: 'u-genesis' },
  );

  const back = store.getItem('gen-reup', { liveOnly: true });
  assert.ok(back, 're-inserted item stays live');
  assert.equal(back.content, 'second body', 'payload content updated');
  assert.ok(cosine(v2, back.embedding!) > 0.999, 'embedding replaced by the new vector');
  assert.ok(
    cosine(v1, back.embedding!) < 0.999,
    'old vector is really gone (64-dim random units are near-orthogonal)',
  );
  assert.equal(back.createdAt, t0, 'conflict update never rewrites created_at');
  assert.equal(back.accessCount, 7, 'conflict update never rewrites access_count');
  assert.equal(back.lastAccessedAt, t0, 'conflict update never rewrites last_accessed_at');
  assert.equal(back.updatedAt, t1, 'updated_at DOES track the rewrite');
  assert.equal(back.importance, 0.8, 'payload importance DOES update');
});

// ───────────────── C2: tombstone cross, new-content variant ─────────────────

test('store: tombstoned id stays dead when re-inserted with NEW content', (t) => {
  const store = freshStore(t);
  const id = 'gen-tomb';
  store.insertItem(makeItem({ id, content: 'pre-forget body' }), { userId: 'u-g' });
  assert.equal(store.tombstoneItem(id), true, 'tombstone recorded');

  store.insertItem(makeItem({ id, content: 'post-forget NEW body' }), { userId: 'u-g' });

  assert.equal(
    store.getItem(id, { liveOnly: true }),
    null,
    'the NEW payload must not resurrect the tombstoned id',
  );
  const audit = store.getItem(id);
  assert.ok(audit, 'default (audit) read still reaches the row');
  assert.equal(audit.content, 'post-forget NEW body', 'audit sees the rewritten payload');
  const layer = store.listItemsByLayer('semantic', 100);
  assert.ok(!layer.some((i) => i.id === id), 'layer listing excludes the id');
  assert.ok(
    !layer.some((i) => i.content.includes('post-forget')),
    'the new content is invisible to every live read path',
  );
});

// ───────────────── C3: assertNamedParamParity unit tests ─────────────────

test('invariants: assertNamedParamParity flags missing and extra bind keys', () => {
  assert.throws(
    () => assertNamedParamParity('SELECT * FROM t WHERE a = @a AND b = @b', { a: 1 }),
    (err: unknown) => /missing bind keys:.*\bb\b/.test(String(err)),
    'missing key named in the message',
  );
  assert.throws(
    () => assertNamedParamParity('SELECT * FROM t WHERE a = @a', { a: 1, orphan: 2 }),
    (err: unknown) => /unused bind keys:.*\borphan\b/.test(String(err)),
    'extra key named in the message',
  );
  // Both directions at once — both names appear in one message.
  assert.throws(
    () => assertNamedParamParity('SELECT @x FROM t WHERE a = @a', { stray: 1 }),
    (err: unknown) => String(err).includes('x') && String(err).includes('stray'),
  );
  // Parity holds → silent pass.
  assert.doesNotThrow(() =>
    assertNamedParamParity('SELECT * FROM t WHERE a = @a AND b = @b', { a: 1, b: 2 }),
  );
});

test('invariants: @names inside single-quoted literals are not references', () => {
  // 'user@example.com' and an ''-escaped quote containing @fine — prose,
  // not bind references; @x is the only reference and it is bound.
  assert.doesNotThrow(() =>
    assertNamedParamParity(
      `SELECT 'user@example.com' AS email, 'it''s @fine' AS s FROM t WHERE x = @x`,
      { x: 1 },
    ),
  );
  // A name that ONLY ever appears inside a literal must NOT be counted as
  // a satisfied reference — the real unbound @salary must still throw.
  assert.throws(
    () => assertNamedParamParity(`SELECT 'pay @salary' FROM t WHERE n = @salary`, {}),
    (err: unknown) => /missing bind keys:.*\bsalary\b/.test(String(err)),
  );
});

// ───────────────── C4: evict under the portable subquery form ─────────────────

test('store: evict removes only old low-importance rows (portable subquery DELETE)', (t) => {
  const store = freshStore(t);
  const now = Date.now();
  const threeHours = 3 * 60 * 60 * 1000;
  const mk = (id: string, importance: number): MemoryItem =>
    makeItem({ id, importance, createdAt: now - threeHours, updatedAt: now - threeHours });
  store.insertItem(mk('gen-low-1', 0.1), { userId: 'u-g' });
  store.insertItem(mk('gen-low-2', 0.2), { userId: 'u-g' });
  store.insertItem(mk('gen-low-3', 0.3), { userId: 'u-g' });
  store.insertItem(mk('gen-high-1', 0.9), { userId: 'u-g' });

  const removed = store.evict({ importanceBelow: 0.5, olderThanMs: 60 * 60 * 1000 });
  assert.equal(removed, 3, 'exactly the three old low-importance rows');
  for (const id of ['gen-low-1', 'gen-low-2', 'gen-low-3']) {
    assert.equal(store.getItem(id), null, `${id} hard-deleted (even the audit read)`);
  }
  assert.ok(
    store.getItem('gen-high-1', { liveOnly: true }),
    'old HIGH-importance row survives — same semantics as the pre-rewrite direct DELETE',
  );
});

// ───────────────── C5: per-replica CRDT watermarks ─────────────────

test('store: listCrdtOpsSince honors per-replica watermarks', (t) => {
  const store = freshStore(t);
  for (let c = 1; c <= 4; c++) {
    store.appendCrdtOp({ replica: 'r1', counter: c, kind: 'set', key: `k${c}`, value: `v${c}` });
  }
  for (let c = 1; c <= 3; c++) {
    store.appendCrdtOp({ replica: 'r2', counter: c, kind: 'set', key: `k${c}`, value: `w${c}` });
  }

  // Watermark only for r1: r1 streams strictly-after 2, r2 gets its FULL
  // stream (absent replicas default to watermark 0) — the single global
  // counter of listCrdtOps could not express this delta.
  const delta = store.listCrdtOpsSince({ r1: 2 });
  assert.equal(delta.length, 5, 'r1 {3,4} + r2 {1,2,3}');
  assert.deepEqual(
    delta.filter((op) => op.replica === 'r1').map((op) => op.counter).sort((a, b) => a - b),
    [3, 4],
    'r1 delta starts strictly above its watermark',
  );
  assert.deepEqual(
    delta.filter((op) => op.replica === 'r2').map((op) => op.counter).sort((a, b) => a - b),
    [1, 2, 3],
    'unwatermarked replica streams in full',
  );
  assert.equal(store.listCrdtOpsSince({}).length, 7, 'empty watermarks = sync everything');
  assert.equal(store.listCrdtOpsSince({ r1: 99 }).length, 3, 'saturated watermark mutes only that replica');
  // The legacy global-counter API is untouched by the new method.
  assert.equal(store.listCrdtOps(2).length, 3, 'listCrdtOps still compares one global counter');
});

// ───────────────── companion: ingestTx commit-time stamping ─────────────────

test('store: ingestTx stamps once per writing batch, never for read-only batches', (t) => {
  const store = freshStore(t);
  const before = store.dataVersion();

  store.ingestTx(() => {
    for (let i = 0; i < 5; i++) {
      store.insertItem(makeItem({ id: `gen-batch-${i}` }), { userId: 'u-g' });
    }
  });
  assert.equal(store.dataVersion(), before + 1, 'N writes in one batch cost ONE stamp');

  store.ingestTx(() => store.getItem('gen-batch-0'));
  assert.equal(
    store.dataVersion(),
    before + 1,
    'a read-only batch leaves the version untouched (no needless cache invalidation)',
  );

  store.insertItem(makeItem({ id: 'gen-solo' }), { userId: 'u-g' });
  assert.equal(store.dataVersion(), before + 2, 'standalone writes still bump immediately');
});

// ───────────── companion: quantization-mode reopen guard ─────────────

test('quantization guard: reopening with a different mode fails loud', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-store-'));
  const dbPath = join(dir, 'store.db');
  const stores: MemoryStore[] = [];
  // Close-all BEFORE the dir rm (open WAL handle; same order discipline
  // as freshStore — on Windows rmSync hits EPERM otherwise).
  t.after(() => { for (const s of stores) s.close(); });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Build in the default int8 mode and write one row to anchor the stamp.
  const first = new MemoryStore({ storagePath: dbPath, dimensions: DIMS, scope: 'user' });
  first.insertItem(makeItem({ id: 'gen-quant', content: 'quantized body' }), { userId: 'u-g' });
  first.close();

  // Same path, different mode: the constructor must throw BEFORE any
  // stored vector is silently misread — and must not leak the handle.
  assert.throws(
    () =>
      new MemoryStore({
        storagePath: dbPath, dimensions: DIMS, scope: 'user', quantization: 'float32',
      }),
    /quantization mode mismatch/,
    'mode flip surfaces as an error, not as corrupted similarities',
  );

  // Same mode as the stamp: reopens cleanly and the row survived.
  const second = new MemoryStore({ storagePath: dbPath, dimensions: DIMS, scope: 'user' });
  stores.push(second);
  assert.equal(second.getItem('gen-quant', { liveOnly: true })?.content, 'quantized body');

  // A database CREATED in float32 reopens normally under float32 — the
  // guard gates mode CHANGES, not non-default modes.
  const f32Dir = mkdtempSync(join(tmpdir(), 'genesis-store-f32-'));
  const f32Path = join(f32Dir, 'store.db');
  const f32Stores: MemoryStore[] = [];
  t.after(() => { for (const s of f32Stores) s.close(); });
  t.after(() => rmSync(f32Dir, { recursive: true, force: true }));
  const created = new MemoryStore({
    storagePath: f32Path, dimensions: DIMS, scope: 'user', quantization: 'float32',
  });
  created.insertItem(makeItem({ id: 'gen-f32' }), { userId: 'u-g' });
  created.close();
  const reopened = new MemoryStore({
    storagePath: f32Path, dimensions: DIMS, scope: 'user', quantization: 'float32',
  });
  f32Stores.push(reopened);
  assert.ok(reopened.getItem('gen-f32', { liveOnly: true }), 'float32-built database reopens under float32');
});

// ───────────── companion: bandit scope keys are kind-namespaced ─────────────

test('bandit scope keys are kind-namespaced', (t) => {
  const store = freshStore(t);
  // Same bare id "acme" under two different kinds: with the old bare-id
  // scope_key both saves landed on one row and each load saw only the
  // LAST write.
  store.saveBanditArm({ userId: 'acme' }, 'graphBoost', 0.9, 1.5, 3, 2);
  store.saveBanditArm({ workspaceId: 'acme' }, 'graphBoost', 0.1, 0.5, 7, 4);

  const userArms = store.loadBandit({ userId: 'acme' });
  const wsArms = store.loadBandit({ workspaceId: 'acme' });
  assert.equal(userArms.length, 1, 'user-kind scope sees exactly its own arm row');
  assert.equal(wsArms.length, 1, 'workspace-kind scope sees exactly its own arm row');
  assert.equal(userArms[0]?.value, 0.9, 'user arm value not clobbered');
  assert.equal(userArms[0]?.reward, 1.5, 'user arm reward not clobbered');
  assert.equal(userArms[0]?.attempts, 3, 'user arm attempts not clobbered');
  assert.equal(userArms[0]?.updates, 2, 'user arm updates not clobbered');
  assert.equal(wsArms[0]?.value, 0.1, 'workspace arm value intact');
  assert.equal(wsArms[0]?.reward, 0.5, 'workspace arm reward intact');
  assert.equal(wsArms[0]?.attempts, 7, 'workspace arm attempts intact');
  assert.equal(wsArms[0]?.updates, 4, 'workspace arm updates intact');
  assert.deepEqual(store.loadBandit({}), [], 'kindless (global) scope reads neither');
});

// ───────────── companion: expired rows vs content-dedupe probes ─────────────

test('expired rows do not suppress content-dedupe probes', (t) => {
  const store = freshStore(t);
  const level = scopeLevels('user', { userId: 'u-g' })[0];
  assert.ok(level, 'user cascade has a narrowest level');
  // One row whose TTL is already past but which the sweep has not yet
  // tombstoned: retrieval cannot see it, so dedupe must not either.
  store.insertItem(
    makeItem({
      id: 'gen-expired',
      content: 'already-forgotten exact body',
      metadata: { source: 'user', expiresAt: Date.now() - 1000 },
    }),
    { userId: 'u-g' },
  );
  assert.deepEqual(
    store.findItemIdsByContentScoped(level, 'already-forgotten exact body'),
    [],
    'expired row reads as absent to the exact-content probe',
  );
  assert.deepEqual(
    store.findItemIdsByContentContaining('already-forgotten exact body', level),
    [],
    'expired row reads as absent to the containment probe',
  );
  // Control: a sibling row with NO expiry IS found by the same probes —
  // the empty arrays above prove the TTL caliber, not a broken insert
  // (getItem itself filters expired rows even on its audit read).
  store.insertItem(
    makeItem({ id: 'gen-live-twin', content: 'still-live exact body' }),
    { userId: 'u-g' },
  );
  assert.deepEqual(
    store.findItemIdsByContentScoped(level, 'still-live exact body'),
    ['gen-live-twin'],
    'unexpired row still reads as a duplicate',
  );
  assert.deepEqual(
    store.findItemIdsByContentContaining('still-live exact body', level),
    ['gen-live-twin'],
    'unexpired row still matches the containment probe',
  );
});

// ───────────── companion: core_history audit rows are immutable ─────────────

test('core_history: a replayed (block, version) never rewrites the first audit', (t) => {
  const store = freshStore(t);
  const upsert = (version: number, content: string): void => {
    store.upsertCoreBlock(
      { id: 'gen-core', name: 'profile', content, tokenCap: 220, version, updatedAt: version * 1_000 },
      { visibility: 'user', userId: 'u-g' },
    );
  };

  // v1(A) → v2(B) archives (1, A). A version ROLLBACK v1(C) then a
  // re-advance v2(D) re-crosses version 1 and archives (1, C) under the
  // same audit key — that replay must be ignored, not overwrite (1, A).
  upsert(1, 'A');
  upsert(2, 'B');
  upsert(1, 'C');
  upsert(2, 'D');

  const trail = store.listCoreHistory('gen-core', 50);
  const v1 = trail.find((h) => h.version === 1);
  assert.ok(v1, 'version-1 audit row exists');
  assert.equal(
    v1.content,
    'A',
    'the FIRST audit of a (block, version) survives the replay — history is append-only',
  );
  assert.equal(
    trail.filter((h) => h.version === 1).length,
    1,
    'the replayed key stays a single row (no overwrite, no duplicate)',
  );
});
