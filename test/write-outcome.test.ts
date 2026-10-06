/**
 * writeOutcome contract tests for memory_remember.
 *
 * The remember tool's write-time intelligence is pinned to ONE unified
 * four-state field:
 *
 *   created          — a new row was written; nothing matched.
 *   deduplicated     — a non-contradictory near-duplicate matched; the
 *                      EXISTING id is returned, no new row stored.
 *   superseded       — conflicts found AND supersede=true: outdated rows
 *                      tombstoned, the new row is effective.
 *   conflict-flagged — conflicts found, supersede NOT requested: flagged
 *                      only, every row stays live.
 *
 * Plus the trigger forensics: matchedId / similarity (raw cosine, 4
 * decimals) / conflictReason, and the D-11 advisory that appears ONLY for
 * non-created outcomes while the embedding gateway's primary space is the
 * offline one (sparse hashed vectors inflate similarity for template-like
 * content).
 *
 * The flagship scenario nails NUMERIC DRIFT: two statements that differ
 * only in a value ("version 16" → "version 17") sit at/above the 0.92
 * dedupe gate yet must NEVER silently merge — the numeric-signature
 * conflict pushes the write through the supersession chain so the new
 * fact takes effect and the old one yields. Nothing is silently lost.
 *
 * Assembly follows integration.test.ts / metamorphic.test.ts: every
 * subtest installs the REAL plugin against its own throwaway SQLite
 * database (offline-bm25 embeddings — deterministic, zero network), the
 * store-close hook registers BEFORE the tempdir removal hook (Windows
 * WAL: rmSync cannot remove a directory holding an open WAL handle), and
 * no assertion depends on wall-clock time or randomness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';
import { cosine } from '../src/utils/embedding.ts';

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

test('memory_remember writeOutcome contract', async (t) => {
  /**
   * Install the real plugin against a fresh, subtest-private database.
   *
   * Windows hook order: the store close must be registered BEFORE the
   * tempdir rm (node:test runs after-hooks first-registered-first-run),
   * or rmSync fights the open better-sqlite3 WAL handle (EPERM).
   */
  const install = (hooks: AfterHooks, opts: Record<string, unknown> = {}) => {
    const ctx = createMockContext();
    hooks.after(() => {
      const store = ctx.services.get('memory-store') as { close(): void } | undefined;
      try {
        store?.close();
      } catch {
        /* already closed — nothing to do */
      }
    });
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-write-'));
    hooks.after(() => rmSync(dir, { recursive: true, force: true }));
    MemoryPalacePlugin(ctx as never, {
      storagePath: join(dir, 'write.db'),
      embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
      ...opts,
    });
    return ctx;
  };

  /** Tool-name → definition map off a mock context. */
  const toolMap = (ctx: ReturnType<typeof createMockContext>) =>
    new Map(
      (ctx.tools as unknown as Array<{ name: string; run: (input: any, tctx: any) => Promise<any> }>)
        .map((x) => [x.name, x]),
    );

  /** The palace facade service. */
  const palaceOf = (ctx: ReturnType<typeof createMockContext>) =>
    ctx.services.get('memory-palace') as any;

  // ---------------------------------------------------------------- flagship
  await t.test(
    'FLAGSHIP numeric drift: value-changed update never silently merges; new fact wins, old yields',
    async (t) => {
      const ctx = install(t);
      const palace = palaceOf(ctx);
      const tools = toolMap(ctx);
      const remember = tools.get('memory_remember')!;
      const retrieve = tools.get('memory_retrieve')!;
      const tctx = { sessionId: 'sess-drift', userId: 'u-drift' };

      // The task's mandated core fact, padded with shared context: the
      // bare 9-token sentence scores 6/7 ≈ 0.857 under offline-bm25 (256
      // dims) — BELOW the 0.92 gate, which would make the fall-through
      // trivial (never scanned). The 13-token form scores 12/13 ≈ 0.9231,
      // so the dedupe gate DOES find the pair and the numeric-signature
      // conflict is what pushes the write through — the property under
      // test. Same fact, same wording, only the version digit changes.
      const v16 = 'PostgreSQL cluster runs version 16 in production for the primary analytics workload tier';
      const v17 = 'PostgreSQL cluster runs version 17 in production for the primary analytics workload tier';

      const first = (await remember.run({ content: v16, importance: 0.9 }, tctx)) as any;
      assert.equal(first.writeOutcome, 'created', 'first write is a fresh create');
      assert.equal(first.deduplicated, false, 'legacy field kept: not a dup');
      assert.equal(first.matchedId, undefined, 'created carries no trigger id');

      const second = (await remember.run(
        { content: v17, importance: 0.9, supersede: true },
        tctx,
      )) as any;
      // The contract under test: a numeric-signature conflict must NOT
      // take the silent-merge path, even at/above dedupe similarity.
      assert.notEqual(
        second.writeOutcome,
        'deduplicated',
        'value-changed update must never silently merge into the old row',
      );
      assert.equal(second.writeOutcome, 'superseded', 'supersede=true walks the supersession chain');
      // The triggering pair sat at/above the dedupe gate — the fall-
      // through was the CONFLICT check, not a sub-threshold score.
      assert.ok(
        typeof second.similarity === 'number' && second.similarity >= 0.92,
        `trigger similarity must reach the 0.92 dedupe gate (got ${second.similarity})`,
      );
      assert.equal(second.matchedId, first.id, 'matchedId names the superseded row');
      assert.ok(
        typeof second.conflictReason === 'string' && second.conflictReason.includes('differing values'),
        `conflictReason carries detectConflict's reason (got ${second.conflictReason})`,
      );
      assert.ok(Array.isArray(second.conflicts) && second.conflicts.length > 0, 'conflicts array kept');
      assert.deepEqual(second.superseded, [first.id], 'legacy superseded list kept');
      assert.equal(second.deduplicated, false, 'legacy field kept on the conflict path');
      assert.ok(
        typeof second.advisory === 'string' && second.advisory.includes('sparse offline embeddings'),
        'non-created outcome under the offline gateway carries the D-11 advisory',
      );

      // New fact effective, old fact yields — never silently lost.
      assert.ok(!palace.store.getItem(first.id, { liveOnly: true }), 'v16 row is not LIVE any more');
      assert.ok(palace.store.getItem(second.id, { liveOnly: true }), 'v17 row is LIVE');

      const res = (await retrieve.run(
        { query: 'PostgreSQL cluster version production', topK: 5 },
        tctx,
      )) as any;
      assert.ok(
        res.hits.some((h: any) => h.content.includes('version 17')),
        'the NEW fact is retrievable',
      );
      assert.ok(
        !res.hits.some((h: any) => h.content.includes('version 16')),
        'the superseded fact is gone from retrieval',
      );
    },
  );

  // ------------------------------------------------------------- deduplicated
  await t.test('exact synonym rewrite: deduplicated, same id, advisory present', async (t) => {
    const ctx = install(t);
    const palace = palaceOf(ctx);
    const remember = toolMap(ctx).get('memory_remember')!;
    const tctx = { sessionId: 'sess-dup', userId: 'u-dup' };
    const content = 'Bastion host rotation replaces the frontier ssh keys every thirty days.';

    const first = (await remember.run({ content, importance: 0.9 }, tctx)) as any;
    assert.equal(first.writeOutcome, 'created', 'first write is a fresh create');
    assert.equal('advisory' in first, false, 'created never carries the advisory');

    const dup = (await remember.run({ content, importance: 0.9 }, tctx)) as any;
    assert.equal(dup.writeOutcome, 'deduplicated', 'identical content dedupes');
    assert.equal(dup.deduplicated, true, 'legacy field kept');
    assert.equal(dup.id, first.id, 'the EXISTING id is returned — no clone stored');
    assert.equal(dup.matchedId, first.id, 'matchedId names the row the merge hit');
    assert.ok(
      typeof dup.similarity === 'number' && dup.similarity >= 0.99,
      `identical content scores ~1.0 raw cosine (got ${dup.similarity})`,
    );
    assert.ok(typeof dup.similarTo === 'string' && dup.similarTo.length > 0, 'legacy similarTo kept');
    assert.ok(
      typeof dup.advisory === 'string' && dup.advisory.includes('sparse offline embeddings'),
      'offline gateway: non-created outcome carries the advisory',
    );

    // Exactly one live row for this user — the dup stored nothing.
    const live = palace.store
      .listItemsByLayer('semantic', 500)
      .filter((i: any) => i.metadata.userId === 'u-dup' || i.metadata.sessionId === 'sess-dup');
    assert.equal(live.length, 1, `one live row after the duplicate write (got ${live.length})`);
  });

  // -------------------------------------------------------- conflict-flagged
  await t.test('conflict without supersede: conflict-flagged, both rows stay LIVE', async (t) => {
    const ctx = install(t);
    const palace = palaceOf(ctx);
    const remember = toolMap(ctx).get('memory_remember')!;
    const tctx = { sessionId: 'sess-cf', userId: 'u-cf' };

    // 13 shared tokens + one differing VALUE (digits — numericSignature
    // is digit-based) ⇒ ~0.93 raw cosine, no negation anywhere.
    const a = 'The Nebula cache tier holds 200 replicas per shard region across both coastal zones.';
    const b = 'The Nebula cache tier holds 300 replicas per shard region across both coastal zones.';

    const first = (await remember.run({ content: a, importance: 0.9 }, tctx)) as any;
    assert.equal(first.writeOutcome, 'created');

    const second = (await remember.run({ content: b, importance: 0.9 }, tctx)) as any;
    assert.equal(second.writeOutcome, 'conflict-flagged', 'no supersede ⇒ flagged, not replaced');
    assert.equal(second.deduplicated, false, 'legacy field kept');
    assert.ok(Array.isArray(second.conflicts) && second.conflicts.length > 0, 'conflict reported');
    assert.equal(second.superseded, undefined, 'nothing tombstoned without supersede');
    assert.equal(second.matchedId, first.id, 'matchedId names the conflicting row');
    assert.ok(
      typeof second.similarity === 'number' && second.similarity >= 0.75,
      `similarity reaches the conflict-scan floor (got ${second.similarity})`,
    );
    assert.ok(
      typeof second.conflictReason === 'string' && second.conflictReason.includes('differing values'),
      'conflictReason present',
    );
    assert.ok(
      typeof second.advisory === 'string' && second.advisory.includes('sparse offline embeddings'),
      'offline gateway advisory present for a non-created outcome',
    );

    // Flag-only: BOTH contradictory facts remain live and visible.
    assert.ok(palace.store.getItem(first.id, { liveOnly: true }), 'the 200-replica row stays LIVE');
    assert.ok(palace.store.getItem(second.id, { liveOnly: true }), 'the 300-replica row stays LIVE');
  });

  // ------------------------------------------------------------ threshold knob
  await t.test('writeDedupeThreshold=0.99: the 0.92-tier pair becomes two created rows', async (t) => {
    // One added word ("early"), no digits, no negation ⇒ no conflict and
    // raw cosine ≈ 0.967 — comfortably inside [0.92, 0.99).
    const a = 'The deployment window for the Atlas service opens at six in the morning.';
    const b = 'The deployment window for the Atlas service opens at six in the early morning.';

    // CONTROL — default config (0.92): the pair IS a dedupe-tier match…
    const ctxDefault = install(t);
    const palaceDefault = palaceOf(ctxDefault);
    const rememberDefault = toolMap(ctxDefault).get('memory_remember')!;
    const tctx = { sessionId: 'sess-thr', userId: 'u-thr' };
    const pairCos = cosine(
      await palaceDefault.embedder.embed(a),
      await palaceDefault.embedder.embed(b),
    );
    assert.ok(
      pairCos >= 0.92 && pairCos < 0.99,
      `precondition: pair raw cosine ∈ [0.92, 0.99) — a 0.92-tier dedupe pair (got ${pairCos})`,
    );
    const d1 = (await rememberDefault.run({ content: a, importance: 0.9 }, tctx)) as any;
    assert.equal(d1.writeOutcome, 'created');
    const d2 = (await rememberDefault.run({ content: b, importance: 0.9 }, tctx)) as any;
    assert.equal(d2.writeOutcome, 'deduplicated', 'at the default 0.92 gate the paraphrase merges');
    assert.equal(d2.id, d1.id, 'merged into the existing id');

    // KNOB — writeDedupeThreshold=0.99: the SAME pair no longer matches…
    const ctxHigh = install(t, { retrieval: { writeDedupeThreshold: 0.99 } });
    const palaceHigh = palaceOf(ctxHigh);
    const rememberHigh = toolMap(ctxHigh).get('memory_remember')!;
    const h1 = (await rememberHigh.run({ content: a, importance: 0.9 }, tctx)) as any;
    assert.equal(h1.writeOutcome, 'created');
    const h2 = (await rememberHigh.run({ content: b, importance: 0.9 }, tctx)) as any;
    assert.equal(h2.writeOutcome, 'created', 'raised gate: the ~0.96 pair now stores its own row');
    assert.notEqual(h2.id, h1.id, 'two distinct rows');
    assert.equal(h2.matchedId, undefined, 'no trigger matched at the raised gate');
    assert.equal('advisory' in h2, false, 'created outcome carries no advisory');
    assert.ok(palaceHigh.store.getItem(h1.id, { liveOnly: true }), 'first row live');
    assert.ok(palaceHigh.store.getItem(h2.id, { liveOnly: true }), 'second row live');
  });

  // ----------------------------------------------------------- advisory gating
  await t.test('advisory absent when the gateway primary space is not offline-bm25', async (t) => {
    const ctx = install(t);
    const palace = palaceOf(ctx);
    const remember = toolMap(ctx).get('memory_remember')!;
    const tctx = { sessionId: 'sess-adv', userId: 'u-adv' };
    const content = 'Vega pipeline retention keeps ninety days of raw telemetry spans.';

    const first = (await remember.run({ content, importance: 0.9 }, tctx)) as any;
    assert.equal(first.writeOutcome, 'created');

    // Control: under the real offline gateway the dup carries the advisory.
    const dup = (await remember.run({ content, importance: 0.9 }, tctx)) as any;
    assert.equal(dup.writeOutcome, 'deduplicated');
    assert.ok(dup.advisory?.includes('sparse offline embeddings'), 'control: advisory present');

    // A dense-gateway stub (primary space 'deepseek:…') replaces
    // facade.embedder. The write path's dedupe/conflict scans run through
    // the retriever's own (real, offline) embedder, so detection is
    // unaffected — only the advisory's gateway probe observes the swap.
    // No API is ever contacted.
    palace.embedder = { spaces: () => ['deepseek:deepseek-embed'] };
    const dupDense = (await remember.run({ content, importance: 0.9 }, tctx)) as any;
    assert.equal(dupDense.writeOutcome, 'deduplicated', 'detection unaffected by the swap');
    assert.equal(dupDense.id, first.id, 'still returns the existing id');
    assert.equal('advisory' in dupDense, false, 'dense primary space: no advisory');
  });
});
