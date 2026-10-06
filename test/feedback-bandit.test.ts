/**
 * Feedback-bandit tests: pure kernel rails/decay/journal + the closed loop
 * (feedback → weight move → persisted → visible via tool → reset).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARMS,
  ARM_DEFAULTS,
  ARM_RAILS,
  FusionBandit,
} from '../src/utils/bandit.ts';

test('kernel: rails clamp, journal records, no runaway', () => {
  const b = new FusionBandit({ lr: 0.5 }); // absurd learning rate on purpose
  for (let i = 0; i < 100; i++) b.update(1.0, 3); // max reward hammering
  for (const arm of ARMS) {
    const v = b.state[arm]!.value;
    assert.ok(
      v >= ARM_RAILS[arm].min - 1e-9 && v <= ARM_RAILS[arm].max + 1e-9,
      `${arm} stayed inside rails (${v})`,
    );
  }
  assert.ok(b.journal.length > 0, 'every move journaled');
  assert.ok(b.journal.length <= 200, 'journal bounded');
});

test('kernel: low engagement nudges DOWN; decay bounds accumulators', () => {
  const b = new FusionBandit({ lr: 0.02 });
  const before = b.state.vectorWeight!.value;
  b.update(0.1, 0); // weak engagement
  assert.ok(b.state.vectorWeight!.value <= before, 'weak signal never raises arms');
  for (let i = 0; i < 50; i++) b.update(0.5, 1);
  const s = b.state.graphBoost!;
  // Steady state of a geometric accumulator: attempts → 1/(1-decay) = 33.3.
  // After ~51 events it must sit near that ceiling, never above it + slack.
  assert.ok(s.attempts <= 1 / (1 - 0.97) + 2, 'attempts bounded by decay steady-state');
});

test('kernel: exploration stays railed; reset restores defaults', () => {
  const b = new FusionBandit();
  for (let i = 0; i < 30; i++) b.update(1.0, 2);
  const w = b.weights(true);
  for (const arm of ARMS) {
    assert.ok(
      w[arm]! >= ARM_RAILS[arm].min - 1e-9 && w[arm]! <= ARM_RAILS[arm].max + 1e-9,
      'explored weight railed',
    );
  }
  b.reset();
  for (const arm of ARMS) {
    assert.equal(b.state[arm]!.value, ARM_DEFAULTS[arm], 'reset restores defaults');
  }
});

// ───────────────────────────── closed loop (integration) ─────────────────────

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
  const dir = mkdtempSync(join(tmpdir(), 'bandit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'memory.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
}

test('closed loop: engagement moves weights, persists, resets via tool', async (t) => {
  const ctx = install(t);
  const palace: any = ctx.services.get('memory-palace');
  const tools = new Map(ctx.tools.map((x) => [x.name, x]));
  const tctx = { sessionId: 's-b', userId: 'u-bandit' };
  const scope = { userId: 'u-bandit' };

  assert.ok(palace.learner, 'learner active by default');
  assert.ok(tools.has('memory_bandit'), 'memory_bandit tool present');

  // Baseline: defaults.
  const before: any = await tools.get('memory_bandit')!.run({ action: 'read' }, tctx);
  const vwBefore = before.arms.find((a: any) => a.arm === 'vectorWeight').value;
  assert.equal(vwBefore, ARM_DEFAULTS.vectorWeight, 'starts at defaults');

  // Strong engagement feedback: 2 of 4 hits engaged → reward 0.5 → up.
  const report = palace.learner.learn({
    engagedItemIds: ['a', 'b'],
    totalHits: 4,
    query: 'kafka pipeline tuning',
    scope,
  });
  assert.equal(report.reward, 0.5);
  assert.ok(report.moved.length > 0, 'weights moved');

  // Persisted + visible through the tool.
  const after: any = await tools.get('memory_bandit')!.run({ action: 'read' }, tctx);
  const vwAfter = after.arms.find((a: any) => a.arm === 'vectorWeight').value;
  assert.ok(vwAfter !== vwBefore, 'weight moved (0.5 is the up/down boundary → any rail-side step)');
  assert.ok(after.recentRewards.length >= 1, 'reward event persisted');
  assert.ok(
    after.arms.every((a: any) => Math.abs(a.drift) <= 25),
    'drift bounded by rails',
  );

  // Learned weights actually flow into retrieval (override accepted).
  const w = palace.learner.weights(scope, false);
  assert.ok(
    w.vectorWeight >= ARM_RAILS.vectorWeight.min && w.vectorWeight <= ARM_RAILS.vectorWeight.max,
    'retrieval gets railed weights',
  );

  // Reset via the tool — the operator's escape hatch.
  const reset: any = await tools.get('memory_bandit')!.run({ action: 'reset' }, tctx);
  assert.ok(reset.reset);
  const reread: any = await tools.get('memory_bandit')!.run({ action: 'read' }, tctx);
  assert.equal(
    reread.arms.find((a: any) => a.arm === 'vectorWeight').value,
    ARM_DEFAULTS.vectorWeight,
    'reset restores defaults end-to-end',
  );

  // Fifteen tools now.
  assert.equal(ctx.tools.length, 15, 'fifteen tools');
  void ARM_RAILS;
});

test('closed loop: explicit derived reward overrides the ratio', async (t) => {
  const ctx = install(t);
  const palace: any = ctx.services.get('memory-palace');
  const scope = { userId: 'u-explicit' };

  // 2 of 10 engaged → the ratio path would compute 0.2 (a DOWN nudge); the
  // explicit 0.6 must win and nudge every arm UP instead.
  const before = palace.learner.weights(scope, false);
  const report = palace.learner.learn({
    engagedItemIds: ['a', 'b'],
    totalHits: 10,
    query: 'self-consistency composite',
    scope,
    reward: 0.6,
  });
  assert.equal(report.reward, 0.6, 'explicit in-domain reward used verbatim');
  assert.equal(report.moved.length, ARMS.length, 'every arm journaled a move');
  const after = palace.learner.weights(scope, false);
  for (const arm of ARMS) {
    assert.ok(
      after[arm]! > before[arm]!,
      `${arm} nudged UP by explicit 0.6 (not the 0.2 ratio)`,
    );
  }

  // Evidence bookkeeping still comes from the engaged ids (clamped to hits).
  const snap: any = palace.learner.snapshot(scope);
  assert.equal(snap.recentRewards.length, 1, 'one reward event persisted');
  assert.equal(snap.recentRewards[0]!.reward, 0.6, 'recentRewards records the explicit value');
  assert.equal(snap.recentRewards[0]!.evidenceCount, 2, 'evidence = len(engagedItemIds)');
});

test('closed loop: non-finite explicit reward is a zero-write guard', async (t) => {
  const ctx = install(t);
  const palace: any = ctx.services.get('memory-palace');
  const scope = { userId: 'u-nan' };

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const report = palace.learner.learn({
      engagedItemIds: ['a', 'b'],
      totalHits: 4,
      query: 'poisoned derived signal',
      scope,
      reward: bad,
    });
    assert.deepEqual(report, { reward: 0, moved: [] }, `${bad}: guard report, no moves`);
  }

  // Nothing was journaled, nothing was persisted, nothing moved.
  const snap: any = palace.learner.snapshot(scope);
  assert.equal(snap.recentRewards.length, 0, 'no reward event written');
  const w = palace.learner.weights(scope, false);
  for (const arm of ARMS) {
    assert.equal(w[arm]!, ARM_DEFAULTS[arm]!, `${arm} untouched by rejected signal`);
  }
});

test('closed loop: out-of-domain explicit rewards clamp into [0,1]', async (t) => {
  const ctx = install(t);
  const palace: any = ctx.services.get('memory-palace');
  const hi = { userId: 'u-clamp-hi' };
  const lo = { userId: 'u-clamp-lo' };

  const rHi = palace.learner.learn({
    engagedItemIds: ['a'],
    totalHits: 3,
    query: 'over unity',
    scope: hi,
    reward: 1.5,
  });
  assert.equal(rHi.reward, 1, '1.5 clamped to 1');
  const rLo = palace.learner.learn({
    engagedItemIds: ['a'],
    totalHits: 3,
    query: 'under floor',
    scope: lo,
    reward: -0.5,
  });
  assert.equal(rLo.reward, 0, '-0.5 clamped to 0');

  // The clamp happens BEFORE the bandit: clamped 1 nudges up, clamped 0
  // nudges down — never a runaway step from the raw magnitude — and the
  // persisted rows carry the clamped values.
  const sHi: any = palace.learner.snapshot(hi);
  const sLo: any = palace.learner.snapshot(lo);
  assert.equal(sHi.recentRewards[0]!.reward, 1, 'persisted reward clamped high');
  assert.equal(sLo.recentRewards[0]!.reward, 0, 'persisted reward clamped low');
  const wHi = palace.learner.weights(hi, false);
  const wLo = palace.learner.weights(lo, false);
  for (const arm of ARMS) {
    assert.ok(wHi[arm]! >= ARM_DEFAULTS[arm]!, `${arm}: clamped 1 never nudges down`);
    assert.ok(wLo[arm]! <= ARM_DEFAULTS[arm]!, `${arm}: clamped 0 never nudges up`);
  }
});
