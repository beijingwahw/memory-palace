/**
 * Derived feedback signals: the two historically CONSTANT-1 engagement
 * channels now carry ranking information.
 *
 *  - memory_why grades itself with a DCG-flavored self-consistency probe
 *    (speculative retrieval of the evidence; reward decays with the rank
 *    each evidence item lands at). Flagship A proves the signal is
 *    BIDIRECTIONAL: a self-identifying ranking pays > 0.9, a ranking that
 *    buries its own evidence under distractors pays < 0.7, and the two
 *    rewards are strictly different — the channel is no longer constant.
 *  - memory_capsule_export (query mode) grades the exported ranking as
 *    0.6·mean(finalScore) + 0.4·(1 − mean pairwise cosine). Flagship B
 *    proves two near-clones pay LESS than two mutually distinct hits from
 *    the same store. entity/all exports deliberately keep the constant-1
 *    curation semantics (bulk sweeps are not ranking judgments).
 *  - Zero side effects: the why probe is speculative — no reinforcement,
 *    no trajectory write — asserted via an unmoved dataVersion (learn
 *    itself writes bandit tables, which by construction do not bump the
 *    version) and untouched access counters on the evidence item.
 *  - The forget negative channel (reward 0) is regression-guarded.
 *
 * Every test installs the real plugin against its own throwaway SQLite
 * database with the deterministic offline-bm25 embedder; the Windows WAL
 * close-before-rm hook order from integration.test.ts applies. All
 * inputs are fixed literals, so every reward is fully deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';

/** Minimal structural handle for registering cleanup on a test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

/**
 * Install the plugin against a fresh, test-private database.
 *
 * Hook ORDER is load-bearing on Windows: the better-sqlite3 WAL handle
 * must be closed BEFORE the temp directory is removed, and node:test runs
 * t.after hooks first-registered-first-run — so the close hook registers
 * before the rm hook.
 */
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
  const dir = mkdtempSync(join(tmpdir(), 'signals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'memory.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
}

function toolOf(ctx: ReturnType<typeof createMockContext>, name: string): any {
  const tool = new Map(ctx.tools.map((x) => [x.name, x])).get(name);
  assert.ok(tool, `tool ${name} registered`);
  return tool;
}

function palaceOf(ctx: ReturnType<typeof createMockContext>): any {
  return ctx.services.get('memory-palace');
}

/** Most recent learned reward in a scope (recentRewards is DESC). */
function lastReward(palace: any, scope: { userId: string }): number {
  const rewards: Array<{ reward: number }> = palace.learner.snapshot(scope).recentRewards;
  assert.ok(rewards.length >= 1, 'at least one reward event journaled');
  return rewards[0]!.reward;
}

// ─────────────────────── flagship A: memory_why rank signal ───────────────────────

test('flagship A: why reward grades ranking quality in both directions', async (t) => {
  // ---- STRONG: three mutually distinct topics, one item each. The probe
  // (the evidence item's own text) must rank that item #1 — DCG pays 1.0.
  const strongCtx = install(t);
  const strongPalace = palaceOf(strongCtx);
  const strongTctx = { sessionId: 's-strong', userId: 'u-strong' };
  for (const content of [
    'The Aurora relay tunes kafka brokers with rack awareness across three datacenters',
    'The Borealis greenhouse schedules orchid humidity misting by seasonal tables',
    'The Cassiopeia ledger reconciles invoice drift nightly',
  ]) {
    await strongPalace.ingestor.ingestUserMemory({ content, importance: 0.9, userId: 'u-strong' });
  }
  const whyStrong = await toolOf(strongCtx, 'memory_why').run({ entity: 'Aurora' }, strongTctx);
  assert.ok(!whyStrong.error, `why resolved the entity: ${JSON.stringify(whyStrong.error)}`);
  assert.equal(whyStrong.evidence.length, 1, 'exactly one Aurora evidence item');
  const strongReward = lastReward(strongPalace, { userId: 'u-strong' });
  assert.ok(
    strongReward > 0.9,
    `self-identifying ranking pays > 0.9 (rank 1 DCG = 1.0), got ${strongReward}`,
  );

  // ---- WEAK: the entity's evidence is a distinctive opening followed by
  // a long unrelated tail, so the probe (the opening) barely matches the
  // evidence item's own diluted embedding — while two short distractors
  // that ARE the opening outrank it. The evidence lands at rank ≥ 3 (or is
  // absent entirely): DCG pays ≤ 0.5 either way.
  const weakCtx = install(t);
  const weakPalace = palaceOf(weakCtx);
  const weakTctx = { sessionId: 's-weak', userId: 'u-weak' };
  const opening =
    'obsidian mirror arrays require weekly polish rotations so twilight calibration stays within tolerance margins before condensation etches the silvered surfaces';
  const openingLength = Array.from(opening).length;
  assert.ok(openingLength <= 160, `probe must be the full opening (${openingLength} code points)`);
  await weakPalace.ingestor.ingestUserMemory({
    content:
      opening +
      '. Wren filed this checklist while Wren audited the appendix because Wren preferred ' +
      'verbose archival records about unrelated warehouse logistics, miscellaneous accounting ' +
      'practices, elevator maintenance logs and cafeteria menu planning during the quarterly review',
    importance: 0.9,
    userId: 'u-weak',
  });
  // Distractors carry no capitalized entity names: they must NOT link to
  // Wren (they would become evidence themselves).
  await weakPalace.ingestor.ingestUserMemory({ content: opening, importance: 0.9, userId: 'u-weak' });
  await weakPalace.ingestor.ingestUserMemory({
    content: `${opening} and dew point thresholds`,
    importance: 0.9,
    userId: 'u-weak',
  });
  const whyWeak = await toolOf(weakCtx, 'memory_why').run({ entity: 'Wren' }, weakTctx);
  assert.ok(!whyWeak.error, `why resolved the entity: ${JSON.stringify(whyWeak.error)}`);
  assert.equal(whyWeak.evidence.length, 1, 'exactly one Wren evidence item');
  const weakReward = lastReward(weakPalace, { userId: 'u-weak' });
  assert.ok(
    weakReward < 0.7,
    `ranking that buries its own evidence pays < 0.7 (rank ≥ 2 DCG ≤ 0.63), got ${weakReward}`,
  );

  // Information-content proof: the channel is no longer constant 1.
  assert.notEqual(strongReward, weakReward, 'strong and weak rewards are strictly different');
});

// ─────────────────── flagship A (purity): the probe is read-only ───────────────────

test('why probe is side-effect free: dataVersion and access counters unmoved', async (t) => {
  const ctx = install(t);
  const palace = palaceOf(ctx);
  const tctx = { sessionId: 's-pure', userId: 'u-pure' };
  const id = await palace.ingestor.ingestUserMemory({
    content: 'The Halcyon observatory tracks sodium flare arcs above the caldera rim',
    importance: 0.9,
    userId: 'u-pure',
  });

  // Post-ingest baseline: the version has settled, the item is untouched.
  const versionBefore = palace.store.dataVersion();
  const itemBefore = palace.store.getItem(id);
  assert.ok(itemBefore, 'evidence item readable');
  assert.equal(itemBefore.accessCount, 0, 'ingest leaves accessCount at 0');

  await toolOf(ctx, 'memory_why').run({ entity: 'Halcyon' }, tctx);

  // learn() writes only the bandit tables (which never bump the version),
  // so an UNMOVED dataVersion proves the probe itself performed no store
  // write — no reinforcement, no trajectory log.
  assert.equal(
    palace.store.dataVersion(),
    versionBefore,
    'speculative probe does not bump dataVersion',
  );
  const itemAfter = palace.store.getItem(id);
  assert.ok(itemAfter, 'evidence item still readable');
  assert.equal(itemAfter.accessCount, 0, 'speculative probe does not reinforce (no touchAccess)');
  assert.equal(
    itemAfter.lastAccessedAt,
    itemBefore.lastAccessedAt,
    'speculative probe does not refresh the decay clock',
  );
  // And the signal really did flow: one journaled reward, from the probe.
  assert.equal(
    palace.learner.snapshot({ userId: 'u-pure' }).recentRewards.length,
    1,
    'exactly one why reward event',
  );
});

// ───────────────── flagship B: capsule export score × diversity ─────────────────

test('flagship B: query-mode export pays diversity, near-clones pay less', async (t) => {
  const ctx = install(t);
  const palace = palaceOf(ctx);
  const tctx = { sessionId: 's-cap', userId: 'u-cap' };

  // Near-duplicate pair: one word apart.
  const queryNear = 'harbor cranes unload steel containers at night';
  for (const content of [
    'harbor cranes unload steel containers at night while floodlights sweep the dock',
    'harbor cranes unload steel containers at night while floodlights sweep the pier',
  ]) {
    await palace.ingestor.ingestUserMemory({ content, importance: 0.9, userId: 'u-cap' });
  }
  // Mutually distinct pair: both contain the query vocabulary, but share
  // almost nothing else with each other.
  const queryFar = 'meridian telescope survey aurora calibrations';
  for (const content of [
    'meridian telescope survey aurora calibrations plus alpine rope rescue knots glacier crevasse navigation winter field teams',
    'meridian telescope survey aurora calibrations alongside desert sandstone arch geology canyon flash flood routing summer hikers',
  ]) {
    await palace.ingestor.ingestUserMemory({ content, importance: 0.9, userId: 'u-cap' });
  }

  const exportTool = toolOf(ctx, 'memory_capsule_export');
  const near = await exportTool.run({ query: queryNear, topK: 2 }, tctx);
  assert.equal(near.items, 2, 'near-duplicate pair exported');
  const far = await exportTool.run({ query: queryFar, topK: 2 }, tctx);
  assert.equal(far.items, 2, 'distinct pair exported');

  // recentRewards is ordered by createdAt DESC, which can TIE within one
  // millisecond — look the two events up by their logged query instead.
  const rewards: Array<{ query: string; reward: number }> = palace.learner
    .snapshot({ userId: 'u-cap' })
    .recentRewards;
  const nearReward = rewards.find((r) => r.query === queryNear)?.reward;
  const farReward = rewards.find((r) => r.query === queryFar)?.reward;
  assert.ok(nearReward !== undefined, 'near-duplicate export journaled a reward');
  assert.ok(farReward !== undefined, 'distinct export journaled a reward');

  assert.ok(
    nearReward < farReward,
    `near-clones pay strictly less than distinct hits: ${nearReward} < ${farReward}`,
  );
  assert.ok(farReward > 0.6, `relevant + diverse export lands above 0.6, got ${farReward}`);
});

test('capsule export entity mode keeps the constant-1 curation semantics', async (t) => {
  const ctx = install(t);
  const palace = palaceOf(ctx);
  const tctx = { sessionId: 's-ent', userId: 'u-ent' };
  await palace.ingestor.ingestUserMemory({
    content: 'The Zephyr atlas indexes tidal charts by moon phase for coastal pilots',
    importance: 0.9,
    userId: 'u-ent',
  });

  const out = await toolOf(ctx, 'memory_capsule_export').run({ entity: 'Zephyr' }, tctx);
  assert.equal(out.items, 1, 'entity sweep exported its item');

  // Bulk curation is not a ranking judgment: no derived reward is handed
  // over, so learn() falls back to the engaged/totalHits ratio = 1.
  const rewards: Array<{ query: string; reward: number }> = palace.learner
    .snapshot({ userId: 'u-ent' })
    .recentRewards;
  assert.equal(rewards.length, 1, 'exactly one reward event');
  assert.equal(rewards[0]!.reward, 1, 'entity-mode export still pays the constant 1');
});

// ───────────────────── forget negative channel (regression) ─────────────────────

test('forget query mode still learns reward 0 (negative channel untouched)', async (t) => {
  const ctx = install(t);
  const palace = palaceOf(ctx);
  const tctx = { sessionId: 's-fgt', userId: 'u-fgt' };
  for (const content of [
    'The Meridian vault stores sapphire drill bits under nitrogen blankets',
    'The Meridian vault logs sapphire drill bit audits weekly for the keepers',
  ]) {
    await palace.ingestor.ingestUserMemory({ content, importance: 0.9, userId: 'u-fgt' });
  }

  const out = await toolOf(ctx, 'memory_forget').run(
    { query: 'Meridian vault sapphire drill bits' },
    tctx,
  );
  assert.ok(out.forgotten >= 1, `query forget tombstoned its targets, got ${out.forgotten}`);

  assert.equal(
    lastReward(palace, { userId: 'u-fgt' }),
    0,
    'forgetting the ranking\'s output journals reward 0',
  );
});
