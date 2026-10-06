/**
 * memory_migrate ADMIN-WHITELIST GATE acceptance tests.
 *
 * The gate replaces the pre-0.20 widest-tier scope check, which was
 * tautological (the scope cascade ALWAYS ends at global, so it never
 * denied anyone). The real gate is identity-based and tri-state:
 *
 *   scope.adminUserIds absent  → unconfigured: single-user trust model
 *                                (any caller + confirm:true may go live).
 *   scope.adminUserIds present → live runs additionally require the
 *                                caller's tctx.userId to be listed;
 *                                undefined userId → REJECT (fail-closed).
 *
 * dryRun stays open to everyone in both modes (pure read). The two gates
 * (membership + confirm) stack independently for live runs.
 *
 * Also covers install-time validation: present-but-empty or
 * empty-string-element whitelists throw at install (config errors, not
 * silently-accepted bricked configs).
 *
 * Deterministic: real plugin install, throwaway SQLite store, offline-bm25
 * embeddings (no network), no clocks in the assertions.
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

/** Real plugin install on a throwaway store; opts merge over the base
 *  (pass `scope` to exercise the admin whitelist). */
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
  const dir = mkdtempSync(join(tmpdir(), 'mig-admin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'memory.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
}

/** Simulate a provider switch: relabel every item's space to a dead space
 *  (column + metadata tag together, exactly like a real switch writes). */
function strandAllItems(palace: any, deadSpace: string): void {
  palace.store.db
    .prepare(
      `UPDATE memory_items SET embedding_space = ?,
         metadata = json_set(metadata, '$.embeddingSpace', ?)
       WHERE embedding IS NOT NULL`,
    )
    .run(deadSpace, deadSpace);
}

function migrateTool(ctx: ReturnType<typeof install>) {
  const tools = new Map(ctx.tools.map((x) => [x.name, x]));
  const migrate = tools.get('memory_migrate')!;
  assert.ok(migrate, 'memory_migrate registered');
  return migrate;
}

async function seedOneMemory(palace: any, userId: string): Promise<void> {
  await palace.ingestor.ingestUserMemory({
    content: 'Aurora relay fleet uses pulse-comet uplinks for lagrange telemetry.',
    userId,
    importance: 0.9,
  });
}

test('memory_migrate admin gate: unconfigured whitelist (status-quo regression)', async (t) => {
  const ctx = install(t); // no scope passed → DEFAULT_CONFIG.scope, key absent
  const palace: any = ctx.services.get('memory-palace');
  const migrate = migrateTool(ctx);

  // Tri-state sanity: the key is ABSENT (not present-undefined) — that
  // presence signal is what the gate keys on.
  assert.ok(!('adminUserIds' in palace.config.scope), 'DEFAULT_CONFIG omits adminUserIds');

  await seedOneMemory(palace, 'u1');
  strandAllItems(palace, 'deepseek:legacy-a');

  await t.test('u1 + confirm:true executes the live migration', async () => {
    const live: any = await migrate.run(
      { confirm: true },
      { sessionId: 's-u1', userId: 'u1' },
    );
    assert.equal(live.migrated, 1, 'live run healed the stranded item');
    assert.equal(live.remaining, 0);
    assert.ok(!live.error, 'no gate error for an unconfigured whitelist');
  });

  await t.test('dryRun is runnable by anyone (even anonymous)', async () => {
    strandAllItems(palace, 'deepseek:legacy-b');
    const dry: any = await migrate.run(
      { dryRun: true },
      { sessionId: 's-anon' }, // no userId at all
    );
    assert.equal(dry.stranded, 1, 'dryRun sees the fragmentation');
    assert.equal(dry.targetSpace, 'offline-bm25:256');
    assert.ok(!dry.error, 'dryRun never hits the membership gate');
  });
});

test('memory_migrate admin gate: configured whitelist restricts live calls', async (t) => {
  const ctx = install(t, {
    scope: { kind: 'user', adminUserIds: ['admin-1'] },
  });
  const palace: any = ctx.services.get('memory-palace');
  const migrate = migrateTool(ctx);

  await seedOneMemory(palace, 'u1');
  strandAllItems(palace, 'deepseek:legacy-c');

  await t.test('admin-1 + confirm: live run executes', async () => {
    const live: any = await migrate.run(
      { confirm: true },
      { sessionId: 's-admin', userId: 'admin-1' },
    );
    assert.equal(live.migrated, 1, 'listed admin may go live');
    assert.ok(!live.error);
  });

  await t.test('u1 + confirm: admin error, store byte-identical', async () => {
    strandAllItems(palace, 'deepseek:legacy-d');
    // Pre-census via the (open-to-everyone) dryRun + the raw space stats.
    const dry: any = await migrate.run(
      { dryRun: true },
      { sessionId: 's-u1', userId: 'u1' },
    );
    assert.equal(dry.stranded, 1, 'non-admin dryRun still reports');
    const censusBefore: Record<string, number> = { ...palace.store.stats().spaces };
    const denied: any = await migrate.run(
      { confirm: true },
      { sessionId: 's-u1', userId: 'u1' },
    );
    assert.equal(
      denied.error,
      'memory_migrate is restricted to configured admins (scope.adminUserIds)',
      'exact admin gate error',
    );
    assert.deepEqual(
      palace.store.stats().spaces,
      censusBefore,
      'denied live call wrote nothing (stats unchanged)',
    );
    assert.equal(palace.store.stats().spaces['deepseek:legacy-d'], 1, 'item still stranded');
  });

  await t.test('anonymous + confirm: rejected fail-closed', async () => {
    const denied: any = await migrate.run(
      { confirm: true },
      { sessionId: 's-anon' }, // no userId — cannot satisfy membership
    );
    assert.equal(
      denied.error,
      'memory_migrate is restricted to configured admins (scope.adminUserIds)',
      'undefined userId is not silently waved through',
    );
  });

  await t.test('admin-1 WITHOUT confirm: confirm error (gates are independent)', async () => {
    const censusBefore: Record<string, number> = { ...palace.store.stats().spaces };
    const denied: any = await migrate.run(
      {},
      { sessionId: 's-admin', userId: 'admin-1' },
    );
    assert.ok(
      typeof denied.error === 'string' && denied.error.includes('confirm:true'),
      'membership passes but the confirm gate still denies',
    );
    assert.deepEqual(
      palace.store.stats().spaces,
      censusBefore,
      'denied live call wrote nothing',
    );
  });
});

test('memory_migrate admin gate: install-time whitelist validation', async (t) => {
  await t.test('empty array is a config error (fail-loud)', () => {
    assert.throws(
      () =>
        install(t, {
          scope: { kind: 'user', adminUserIds: [] },
        }),
      /invalid scope\.adminUserIds/,
      'configured-but-nobody-allowed throws at install',
    );
  });

  await t.test('empty-string element is a config error (fail-loud)', () => {
    assert.throws(
      () =>
        install(t, {
          scope: { kind: 'user', adminUserIds: [''] },
        }),
      /invalid scope\.adminUserIds/,
      'phantom empty id can never match a caller — reject at install',
    );
  });

  await t.test("legal ['a','b'] installs cleanly", () => {
    const ctx = install(t, {
      scope: { kind: 'user', adminUserIds: ['a', 'b'] },
    });
    const palace: any = ctx.services.get('memory-palace');
    assert.deepEqual(palace.config.scope.adminUserIds, ['a', 'b'], 'whitelist rides into config');
  });
});
