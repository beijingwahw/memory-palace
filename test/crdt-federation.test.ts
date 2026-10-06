/**
 * CRDT federation tests: kernel merge laws + the 3-palace convergence
 * property (seeded random concurrent ops, sync in multiple orders —
 * strong eventual consistency).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOps,
  docFingerprint,
  emptyDoc,
  lwwApply,
  lamportCompare,
  emptyOr,
  orMembers,
  orAdd,
  orMerge,
  orRemove,
  type CrdtOp,
  type Lamport,
} from '../src/utils/crdt.ts';

const ts = (counter: number, replica: string): Lamport => ({ counter, replica });

test('LWW: total order, deterministic tie-break, tombstones', () => {
  const m = emptyDoc().items;
  lwwApply(m, { key: 'a', value: 'v1', ts: ts(1, 'r1') });
  lwwApply(m, { key: 'a', value: 'v2', ts: ts(1, 'r2') }); // same counter, r2 > r1
  assert.equal([...m.values()][0]!.value, 'v2', 'replica tie-break');
  lwwApply(m, { key: 'a', value: null, ts: ts(2, 'r1') }); // tombstone wins
  assert.equal([...m.values()][0]!.value, null);
  lwwApply(m, { key: 'a', value: 'v3', ts: ts(1, 'r9') }); // stale — ignored
  assert.equal([...m.values()][0]!.value, null, 'stale write loses to tombstone');
  ok: {
    assert.ok(lamportCompare(ts(1, 'a'), ts(2, 'b')) < 0);
    break ok;
  }
});

test('merge laws: commutative + associative + idempotent (property)', () => {
  const r = rng(42);
  for (let iter = 0; iter < 100; iter++) {
    const opsA = randomOps(r, 'A', 6);
    const opsB = randomOps(r, 'B', 6);
    const opsC = randomOps(r, 'C', 6);
    const d1 = applyOps(applyOps(applyOps(emptyDoc(), opsA), opsB), opsC);
    const d2 = applyOps(applyOps(applyOps(emptyDoc(), opsC), opsB), opsA);
    assert.equal(docFingerprint(d1), docFingerprint(d2), 'commutative');
    const d3 = applyOps(emptyDoc(), opsA);
    applyOps(d3, opsA); // idempotent
    assert.equal(
      docFingerprint(applyOps(emptyDoc(), opsA)),
      docFingerprint(d3),
      'idempotent',
    );
    const dLeft = applyOps(applyOps(emptyDoc(), opsA), [...opsB, ...opsC]);
    const dRight = applyOps(applyOps(applyOps(emptyDoc(), opsA), opsB), opsC);
    assert.equal(docFingerprint(dLeft), docFingerprint(dRight), 'associative');
  }
});

test('OR-Set: add wins over concurrent remove', () => {
  const s1 = emptyOr<string>();
  orAdd(s1, 'kafka', 'topic', ts(1, 'r1'));
  // r2 observed the add (ts 1), removed at ts 2 — kills the ts-1 tag
  const s2 = emptyOr<string>();
  orAdd(s2, 'kafka', 'topic', ts(1, 'r1'));
  orRemove(s2, 'kafka', ts(2, 'r2'));
  const merged = orMerge(s1, s2);
  assert.equal(orMembers(merged).has('kafka'), false, 'observed remove wins');
  // r1 concurrently RE-ADDED at ts 3 (> remove ts 2) — survives
  orAdd(s1, 'kafka', 'topic', ts(3, 'r1'));
  const m2 = orMerge(s1, s2);
  assert.ok(orMembers(m2).has('kafka'), 'later concurrent add survives remove');
});

// ── deterministic PRNG (mulberry32) ──
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOps(r: () => number, replica: string, n: number): CrdtOp[] {
  const out: CrdtOp[] = [];
  for (let i = 0; i < n; i++) {
    const key = 'k' + Math.floor(r() * 6);
    const counter = 1 + Math.floor(r() * 100);
    const t = ts(counter, replica);
    const roll = r();
    if (roll < 0.4) out.push({ kind: 'item-set', key, value: `v${counter}`, ts: t });
    else if (roll < 0.55) out.push({ kind: 'item-del', key, ts: t });
    else if (roll < 0.8) out.push({ kind: 'tag-add', key, value: 'tag', ts: t });
    else if (roll < 0.9) out.push({ kind: 'tag-del', key, ts: t });
    else out.push({ kind: 'entity-add', key, value: 'ent', ts: t });
  }
  return out.sort((a, b) => lamportCompare(a.ts, b.ts));
}

// ───────────────────────────── 3-palace convergence ─────────────────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';
import { CrdtFederation } from '../src/services/crdt-federation.ts';
import { MemoryStore } from '../src/services/memory-store.ts';

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

/** Fresh subtest-private store pair; close registered BEFORE the dir rm
 *  (WAL handles — the Windows hook-order rule, see INVARIANTS §4). */
function storePair(
  t: AfterHooks,
  names: readonly string[],
): Array<{ store: MemoryStore; fed: CrdtFederation }> {
  const dir = mkdtempSync(join(tmpdir(), 'crdt-wm-'));
  const out = names.map((name) => {
    const store = new MemoryStore({
      storagePath: join(dir, `${name}.db`),
      dimensions: 4,
      scope: 'user',
    });
    t.after(() => store.close());
    return { store, fed: new CrdtFederation(store, name) };
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return out;
}

/** Parse a persisted watermark meta value (test-side mirror of the runtime shape). */
function readWm(store: MemoryStore, peerId: string): Record<string, number> {
  const raw = store.getMeta(`crdt:wm:${peerId}`);
  assert.ok(raw, `watermark meta for ${peerId} must be persisted`);
  return JSON.parse(raw!) as Record<string, number>;
}

test('acceptance: 3 palaces, seeded concurrent ops, converge across sync orders', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crdt-'));
  const federations: CrdtFederation[] = [];
  const palaces: any[] = [];

  for (let i = 0; i < 3; i++) {
    const ctx = createMockContext();
    t.after(() => {
      const store = ctx.services.get('memory-store') as { close(): void } | undefined;
      try {
        store?.close();
      } catch {
        /* closed */
      }
    });
    MemoryPalacePlugin(ctx as never, {
      storagePath: join(dir, `p${i}.db`),
      embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    } as never);
    const palace: any = ctx.services.get('memory-palace');
    palaces.push(palace);
    federations.push(new CrdtFederation(palace.store, `palace-${i}`));
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Seeded divergent writes: each palace writes distinct keys + conflicting
  // writes to shared keys (the hard case).
  const r = rng(2026);
  for (let round = 0; round < 30; round++) {
    const fi = Math.floor(r() * 3);
    const f = federations[fi]!;
    const key = 'item-' + Math.floor(r() * 12);
    if (r() < 0.75) f.recordSet(key, `val-r${round}-p${fi}`);
    else f.recordDelete(key);
    if (r() < 0.3) f.recordTagAdd('tag-' + Math.floor(r() * 5), 't');
  }

  // Sync order A: pairwise chain (0↔1, 1↔2, 0↔2)
  federations[0]!.sync(federations[1]!);
  federations[1]!.sync(federations[2]!);
  federations[0]!.sync(federations[2]!);

  const fpA = federations.map((f) => f.fingerprint());
  assert.equal(new Set(fpA).size, 1, 'all three converge (chain order)');
  const totalOps = federations[0]!.exportOps().length;
  assert.ok(totalOps > 30, `ops exchanged (${totalOps})`);

  // Late write + sync in the REVERSE order → still converges (the real SEC test).
  federations[2]!.recordSet('item-late', 'from-p2');
  federations[2]!.sync(federations[1]!);
  federations[1]!.sync(federations[0]!);

  const fpB = federations.map((f) => f.fingerprint());
  assert.equal(new Set(fpB).size, 1, 'late write converges (reverse order)');

  // Repeated sync is idempotent (no state change).
  const before = federations[0]!.fingerprint();
  federations[0]!.sync(federations[1]!);
  assert.equal(federations[0]!.fingerprint(), before, 're-sync idempotent');

  // The converged digest contains the late write (no lost updates).
  assert.ok(
    federations[0]!.exportOps().some((op) => op.kind === 'item-set' && op.key === 'item-late'),
    'late write present in converged state',
  );
});

// ───────────────────── incremental watermark exchange ─────────────────────

test('incremental sync: watermarks persist, second exchange ships only the delta', async (t) => {
  const [{ store: storeA, fed: a }, { store: storeB, fed: b }] = storePair(t, ['wm-a', 'wm-b']);

  // Round 1 — no watermark yet: the exchange is the FULL logs (3 ops each).
  for (let i = 0; i < 3; i++) a.recordSet(`ka${i}`, `va${i}`);
  for (let i = 0; i < 3; i++) b.recordSet(`kb${i}`, `vb${i}`);
  const r1 = a.sync(b);
  assert.equal(r1.converged, true, 'first (full) exchange converges');
  assert.equal(r1.opsSent, 3, 'first sync ships A\'s whole log — no watermark exists yet');
  assert.equal(r1.opsReceived, 3, 'first sync receives B\'s whole log');

  // Both sides persisted a per-replica watermark for the peer (crdt:wm:<peerId>).
  assert.deepEqual(readWm(storeA, 'wm-b'), { 'wm-a': 3, 'wm-b': 3 }, 'A believes B holds the 6-op union');
  assert.deepEqual(readWm(storeB, 'wm-a'), { 'wm-a': 3, 'wm-b': 3 }, 'B believes A holds the 6-op union');

  // Round 2 — two NEW ops per side: the exchange must be the DELTA only.
  for (let i = 0; i < 2; i++) a.recordSet(`ka2-${i}`, `va2-${i}`);
  for (let i = 0; i < 2; i++) b.recordSet(`kb2-${i}`, `vb2-${i}`);
  const r2 = a.sync(b);
  assert.equal(r2.converged, true, 'incremental exchange converges');
  assert.equal(r2.opsSent, 2, 'second sync ships ONLY A\'s 2 new ops');
  assert.equal(r2.opsReceived, 2, 'second sync receives ONLY B\'s 2 new ops');
  assert.equal(a.fingerprint(), b.fingerprint(), 'full-replay digests agree after delta exchange');

  // The persisted watermarks advanced to the new per-replica ceilings.
  assert.deepEqual(readWm(storeA, 'wm-b'), { 'wm-a': 6, 'wm-b': 6 }, 'watermark advanced past round 2');
  assert.deepEqual(readWm(storeB, 'wm-a'), { 'wm-a': 6, 'wm-b': 6 });

  // Round 3 — steady state: no new writes, the delta is empty (idempotent).
  const before = a.fingerprint();
  const r3 = a.sync(b);
  assert.equal(r3.converged, true);
  assert.equal(r3.opsSent, 0, 'steady-state delta is empty');
  assert.equal(r3.opsReceived, 0);
  assert.equal(a.fingerprint(), before, 'no-op sync changes nothing');
});

test('watermark fallback: corrupt JSON and inflated watermarks self-heal', async (t) => {
  const [{ store: storeA, fed: a }, { fed: b }] = storePair(t, ['wm-fa', 'wm-fb']);

  for (let i = 0; i < 3; i++) a.recordSet(`ka${i}`, `va${i}`);
  for (let i = 0; i < 3; i++) b.recordSet(`kb${i}`, `vb${i}`);
  assert.equal(a.sync(b).converged, true, 'seed sync converges');

  // Corrupt watermark (parse failure) → the loader yields {} → FULL re-send.
  for (let i = 0; i < 2; i++) a.recordSet(`ka2-${i}`, `va2-${i}`);
  for (let i = 0; i < 2; i++) b.recordSet(`kb2-${i}`, `vb2-${i}`);
  storeA.setMeta('crdt:wm:wm-fb', '{not json');
  const rCorrupt = a.sync(b);
  assert.equal(rCorrupt.converged, true, 'corrupt watermark falls back to full exchange and converges');
  assert.equal(rCorrupt.opsSent, 8, 'A re-shipped its ENTIRE 8-op log (watermark unreadable)');
  assert.equal(rCorrupt.opsReceived, 2, 'B (healthy watermark) still sent only its 2-op delta');
  assert.equal(a.exportOps().length, 10);
  assert.equal(b.exportOps().length, 10);

  // Inflated watermark (claims the peer holds ops it does NOT — the crash-
  // consistency hole): the delta skips real ops, fingerprints disagree, and
  // the defensive full re-exchange must heal the divergence and REPAIR the
  // persisted watermark.
  for (let i = 0; i < 2; i++) a.recordSet(`ka3-${i}`, `va3-${i}`);
  for (let i = 0; i < 2; i++) b.recordSet(`kb3-${i}`, `vb3-${i}`);
  storeA.setMeta('crdt:wm:wm-fb', JSON.stringify({ 'wm-fa': 999, 'wm-fb': 999 }));
  const rInflated = a.sync(b);
  assert.equal(rInflated.converged, true, 'inflated watermark healed by full re-exchange');
  assert.equal(a.exportOps().length, 14, 'both sides hold the 14-op union');
  assert.equal(b.exportOps().length, 14);
  assert.deepEqual(
    readWm(storeA, 'wm-fb'),
    { 'wm-fa': 9, 'wm-fb': 9 },
    'watermark repaired to the true per-replica ceilings',
  );

  // After healing, the next exchange is a clean empty delta.
  const rAfter = a.sync(b);
  assert.equal(rAfter.converged, true);
  assert.equal(rAfter.opsSent, 0, 'healed watermark → empty delta');
  assert.equal(rAfter.opsReceived, 0);
});
