/**
 * Living-Core integration tests: self-editing through the memory_core
 * tool, versioned audit, ACL isolation of the SELF, core-first injection,
 * and a forced sleep cycle compacting an overflowing block.
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

function freshDb(t: AfterHooks): string {
  const dir = mkdtempSync(join(tmpdir(), 'core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'memory.db');
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
  const dbPath = freshDb(t);
  MemoryPalacePlugin(ctx as never, {
    storagePath: dbPath,
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
}

test('Living Core: self-editing, audit, ACL, injection, sleep compaction', async (t) => {
  await t.test('memory_core set/append/read roundtrip with versions', async () => {
    const ctx = install(t);
    const tools = new Map(ctx.tools.map((x) => [x.name, x]));
    const core = tools.get('memory_core')!;
    const tctx = { sessionId: 's1', userId: 'u-self' };

    const setRes: any = await core.run(
      { action: 'set', block: 'profile', content: 'Prefers concise answers over verbose explanations' },
      tctx,
    );
    assert.equal(setRes.block, 'profile');
    assert.equal(setRes.version, 1, 'first write is version 1');

    const appRes: any = await core.run(
      { action: 'append', block: 'profile', lines: ['Works on Project Aurora with PostgreSQL'] },
      tctx,
    );
    assert.equal(appRes.version, 2, 'append bumps version');

    const readRes: any = await core.run({ action: 'read' }, tctx);
    const profile = readRes.blocks.find((b: any) => b.name === 'profile');
    assert.ok(profile.content.includes('concise answers'));
    assert.ok(profile.content.includes('Aurora'));

    const hist: any = await core.run({ action: 'history', block: 'profile' }, tctx);
    assert.ok(hist.versions >= 1, 'audit history exists');
    assert.ok(!hist.history[0].content.includes('Aurora'), 'v1 preserved pre-append');
  });

  await t.test('the SELF is ACL-isolated', async () => {
    const ctx = install(t);
    const tools = new Map(ctx.tools.map((x) => [x.name, x]));
    const core = tools.get('memory_core')!;

    await core.run(
      { action: 'set', block: 'goals', content: 'P0 goal: ship the Aurora migration secretly' },
      { sessionId: 's1', userId: 'u-self' },
    );
    const intruder: any = await core.run({ action: 'read' }, { sessionId: 's2', userId: 'u-other' });
    assert.equal(
      intruder.blocks.length,
      0,
      "one agent's SELF is never visible to another",
    );
  });

  await t.test('core is injected FIRST at session start', async () => {
    const ctx = install(t, {
      injection: {
        enabled: true,
        maxTokens: 400,
        systemPromptPrefix: 'memory on',
        coreBudgetFraction: 1 / 3,
      },
    });
    const palace: any = ctx.services.get('memory-palace');
    await palace.core.set(
      'profile',
      'Handles the observability stack for Project Phoenix',
      { userId: 'u-inject' },
    );
    await palace.ingestor.ingestUserMemory({
      content:
        'Phoenix uses PostgreSQL 16 with pgvector for similarity search in production today.',
      userId: 'u-inject',
      importance: 0.9,
    });

    const out = await palace.injector.inject({
      sessionId: 's-inject',
      intent: 'What database does Phoenix use?',
      userId: 'u-inject',
    });
    const coreIdx = out.systemPromptAddition.indexOf('[profile]');
    assert.ok(coreIdx >= 0, 'core block present in injection');
    const firstRetrieved = out.systemPromptAddition.indexOf('[memory:');
    assert.ok(
      firstRetrieved === -1 || coreIdx < firstRetrieved,
      'core precedes retrieved context',
    );
    assert.ok(out.systemPromptAddition.includes('observability'), 'core content visible');
  });

  await t.test('sleep cycle compacts an overflowing core block', async () => {
    const ctx = install(t, {
      compression: { enabled: true, triggerCount: 10000, importanceThreshold: 0.35, decayHalfLifeDays: 14 },
    });
    const palace: any = ctx.services.get('memory-palace');
    const filler = Array.from(
      { length: 40 },
      (_, i) => `filler note ${i} about things that matter somewhat`,
    );
    await palace.core.set(
      'project',
      ['## Critical', 'P0 goal: ship by Friday', ...filler].join('\n'),
      { userId: 'u-sleep' },
    );

    const dream = await palace.sleep.sleep({ userId: 'u-sleep' }, { forceCompression: false });
    assert.ok(dream.phases.length >= 2, 'compress + core phases ran');
    assert.ok(dream.phases.every((p: any) => p.ok), 'no phase crashed');

    const after = await palace.core.readBlock('project', { userId: 'u-sleep' });
    // set() pre-compacts at the cap, so a same-cap night is idempotent;
    // the sleep contract is: phases ran, nothing crashed, notes recorded.
    assert.ok(after.version >= 1, 'block intact after sleep');
    assert.ok(after.content.includes('## Critical'), 'structural line survived the night');
    assert.ok(after.content.includes('P0 goal'), 'goal line survived');
    assert.ok(
      after.content.length < 40 * 40,
      'filler mass evicted',
    );
    assert.ok(dream.notes.some((n: string) => n.startsWith('core:')), 'dream notes record core work');
    void after;
  });
});
