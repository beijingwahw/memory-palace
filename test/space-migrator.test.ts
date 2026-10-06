/**
 * SpaceMigrator acceptance tests — the roadmap criteria, verbatim:
 *
 *   two-space store → migrator runs → single-space retrieval returns
 *   previously invisible items; flashback unchanged.
 *
 * Plus: idempotence, budget batching, degraded-abort, audit trail,
 * sleep-phase integration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';

interface AfterHooks {
  after(fn: () => void): void;
}

function install(t: AfterHooks, opts: Record<string, unknown> = {}) {
  const ctx = createMockContext();
  t.after(() => {
    const store = ctx.services.get('memory-store') as { close(): void } | undefined;
    try {
      store?.close();
    } catch {
      /* already closed */
    }
  });
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'memory.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
}

/** Simulate a provider switch: relabel every item's space to a dead space. */
function strandAllItems(palace: any, deadSpace: string): void {
  // A real provider switch relabels BOTH the column and the metadata tag
  // (they are written together at ingest) — the simulation must too.
  palace.store.db
    .prepare(
      `UPDATE memory_items SET embedding_space = ?,
         metadata = json_set(metadata, '$.embeddingSpace', ?)
       WHERE embedding IS NOT NULL`,
    )
    .run(deadSpace, deadSpace);
}

test('SpaceMigrator: fragmentation healed, retrieval restored, flashback intact', async (t) => {
  const ctx = install(t);
  const palace: any = ctx.services.get('memory-palace');
  const tools = new Map(ctx.tools.map((x) => [x.name, x]));
  const tctx = { sessionId: 's-mig', userId: 'u-mig' };
  // Flashback baseline — assigned just before migration (post invisible-probe).
  let baseline: any = null;

  await palace.ingestor.ingestUserMemory({
    content: 'Helios mesh uses Envoy sidecars for all east-west traffic routing.',
    userId: 'u-mig',
    importance: 0.9,
  });

  await t.test('stranded items are invisible to retrieval (the bug)', async () => {
    strandAllItems(palace, 'deepseek:old-model');
    const res = await palace.retriever.retrieve({
      query: 'east-west traffic routing sidecars',
      scope: { userId: 'u-mig' },
    });
    assert.equal(res.hits.length, 0, 'old-space vectors invisible — the silent failure');
  });

  await t.test('migrator.tick() restores single-space retrieval', async () => {
    // Snapshot AFTER the invisible probe (0 hits → no testing-effect
    // touch) but BEFORE the migration: a clean flashback baseline.
    baseline = palace.store.listItemsByLayer('semantic', 10)[0];
    const result = await palace.migrator.tick();
    assert.equal(result.targetSpace, 'offline-bm25:256', 'target is the active primary');
    assert.equal(result.migrated, 1, 'one item rebound');
    assert.equal(result.remaining, 0, 'nothing stranded');
    assert.equal(result.degraded, false, 'healthy gateway');

    const res = await palace.retriever.retrieve({
      query: 'east-west traffic routing sidecars',
      scope: { userId: 'u-mig' },
    });
    assert.ok(
      res.hits.some((h: any) => /Envoy/.test(h.item.content)),
      'previously invisible memory retrievable again',
    );
  });

  await t.test('flashback integrity: timestamps and content untouched', () => {
    const after = palace.store.listItemsByLayer('semantic', 10)[0];
    assert.equal(after.id, baseline.id, 'same item');
    assert.equal(after.createdAt, baseline.createdAt, 'created_at preserved');
    assert.equal(after.content, baseline.content, 'content preserved');
    // Importance is NOT a flashback field, and the sub-test's own successful
    // retrieval reinforces it (+0.01, testing effect). The migration must
    // never WEAKEN it — assert monotone, not frozen.
    assert.ok(
      after.importance >= baseline.importance,
      "importance monotone (got " + after.importance + " vs " + baseline.importance + ")",
    );
    assert.equal(after.metadata.migratedFrom, 'deepseek:old-model', 'audit trail recorded');
    assert.ok(after.metadata.migratedAt > 0, 'migration timestamp recorded');
  });

  await t.test('idempotent: a second tick migrates nothing', async () => {
    const again = await palace.migrator.tick();
    assert.equal(again.migrated, 0, 'nothing left to migrate');
    assert.equal(again.remaining, 0);
  });

  await t.test('memory_migrate tool: dryRun reports, live run heals', async () => {
    strandAllItems(palace, 'deepseek:another-old');
    const migrate = tools.get('memory_migrate')!;
    const dry: any = await migrate.run({ dryRun: true }, tctx);
    assert.equal(dry.stranded, 1, 'dryRun sees the fragmentation');
    assert.equal(dry.targetSpace, 'offline-bm25:256');
    assert.equal(palace.store.stats().spaces['deepseek:another-old'], 1, 'dryRun wrote nothing');

    // Confirmation gate: a LIVE run without confirm:true is rejected with
    // zero writes — the store's whole space census is unchanged after.
    const censusBefore: Record<string, number> = { ...palace.store.stats().spaces };
    const denied: any = await migrate.run({}, tctx);
    assert.ok(
      typeof denied.error === 'string' && denied.error.includes('confirm:true'),
      'live run without confirm returns the gate error',
    );
    assert.deepEqual(
      palace.store.stats().spaces,
      censusBefore,
      'rejected live call wrote nothing (stats unchanged)',
    );

    const live: any = await migrate.run({ confirm: true }, tctx);
    assert.equal(live.migrated, 1, 'live run heals');
    assert.ok(String(live.note).includes('unified'), 'completion note');
  });

  await t.test('budget-bounded: 3 stranded items, budget 2 per tick', async () => {
    for (let i = 0; i < 2; i++) {
      await palace.ingestor.ingestUserMemory({
        content: `Migration budget probe fact ${i}: the palace re-indexes bounded batches only.`,
        userId: 'u-mig',
        importance: 0.7,
      });
    }
    strandAllItems(palace, 'deepseek:capped');
    const t1 = await palace.migrator.tick(2);
    assert.equal(t1.migrated, 2, 'budget respected');
    assert.equal(t1.remaining, 1, 'one left stranded');
    const t2 = await palace.migrator.tick(2);
    assert.equal(t2.migrated, 1, 'second tick finishes');
    assert.equal(t2.remaining, 0);
  });

  await t.test('degraded gateway aborts with zero writes', async () => {
    strandAllItems(palace, 'deepseek:degraded-era');
    // A gateway whose embedTagged serves the FALLBACK space while the
    // primary is the target — mid-tick failover by simulation.
    const fakeGateway = {
      name: 'fake',
      dimensions: 256,
      space: 'offline-bm25:256',
      spaces: () => ['offline-bm25:256'],
      embed: async () => { throw new Error('primary down'); },
      embedBatch: async () => { throw new Error('primary down'); },
      embedIn: async () => null,
      embedTagged: async () => ({ vector: new Float32Array(256), space: 'offline-bm25:256' }),
      embedBatchTagged: async () => { throw new Error('primary down'); },
      degraded: true,
    };
    const { SpaceMigrator } = await import('../src/services/space-migrator.ts');
    const strandedMigrator = new SpaceMigrator(palace.store, fakeGateway as never, {});
    const result = await strandedMigrator.tick();
    assert.equal(result.degraded, true, 'degradation reported');
    assert.equal(result.migrated, 0, 'zero writes on degraded circuit');
    assert.ok(result.remaining >= 1, 'strand count reported for retry');
  });

  await t.test('sleep cycle carries the migrate phase', async () => {
    strandAllItems(palace, 'deepseek:sleep-era');
    const dream = await palace.sleep.sleep(tctx, { forceCompression: false });
    const phase = dream.phases.find((p: any) => p.phase === 'migrate');
    assert.ok(phase && phase.ok, 'migrate phase ran clean');
    assert.equal(phase.detail.migrated, 3, 'all stranded items healed overnight');
    assert.ok(
      dream.notes.some((n: string) => n.startsWith('migrated:')),
      'dream notes record the healing',
    );
  });

  await t.test('fifteen tools registered', () => {
    assert.equal(ctx.tools.length, 15);
    assert.ok(tools.has('memory_migrate'), 'memory_migrate present');
  });
});
