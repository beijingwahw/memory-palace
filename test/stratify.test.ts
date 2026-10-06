/**
 * Stratification tests: pure kernel buckets/roll-up + the 6-month-palace
 * acceptance — era queries answered from bounded digest nodes, tree nodes
 * retrievable, idempotent re-stratification.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEVEL_SPEC,
  bucketStart,
  buildTree,
  stratifyLevel,
} from '../src/utils/stratify.ts';

const DAY = 86_400_000;

test('kernel: bucket alignment + bounded digests', () => {
  const ts = 1_700_000_000_000;
  assert.equal(bucketStart(ts, 'week') % LEVEL_SPEC.week.periodMs, 0, 'week aligned');
  assert.equal(bucketStart(ts, 'era') % LEVEL_SPEC.era.periodMs, 0, 'era aligned');

  const inputs = Array.from({ length: 40 }, (_, i) => ({
    id: `i${i}`,
    content: `Fact ${i}: the system handles shard ${i} with kafka pipeline tuning`,
    createdAt: ts + i * DAY,
    importance: 0.5,
  }));
  const weeks = stratifyLevel(inputs, 'week');
  assert.ok(weeks.length >= 5, `40 days → ≥5 week buckets (got ${weeks.length})`);
  for (const w of weeks) {
    assert.ok(w.tokenCount <= LEVEL_SPEC.week.tokenCap, 'week digest bounded');
    assert.ok(w.content.startsWith('[week]'));
    assert.ok(w.childIds.length > 0);
  }
});

test('kernel: full roll-up compresses session→era', () => {
  const inputs = Array.from({ length: 180 }, (_, i) => ({
    id: `f${i}`,
    content: `Memory ${i}: deployment of component ${i % 7} with rollout gates`,
    createdAt: 1_700_000_000_000 + i * DAY,
    importance: 0.5,
  }));
  const tree = buildTree(inputs);
  assert.ok(tree.get('session')!.length > tree.get('week')!.length);
  assert.ok(tree.get('week')!.length > tree.get('month')!.length);
  assert.ok(tree.get('month')!.length >= tree.get('era')!.length);
  assert.ok(tree.get('era')!.length >= 1, 'at least one era node');
  const totalEraTokens = tree.get('era')!.reduce((s, n) => s + n.tokenCount, 0);
  assert.ok(
    totalEraTokens <= tree.get('era')!.length * LEVEL_SPEC.era.tokenCap,
    'era digests constant-size',
  );
});

// ─────────────── extractive selection (the upgrade under test) ───────────────

test('kernel: extractive selection keeps high-salience lines, squeezes filler', () => {
  const ts = 1_700_000_000_000;
  const inputs = Array.from({ length: 6 }, (_, i) => ({
    id: `fill${i}`,
    content: `Filler ${i}: routine status chatter about the office plants, the coffee machine, hallway posters and the parking lot schedule ${i}`,
    createdAt: ts + i * 60_000,
    importance: 0.3,
  }));
  // Two high-salience items: importance 0.9 + keyword-ladder hits
  // (decision / blocked / risk) — must survive a tight budget.
  inputs.push({
    id: 'key0',
    content: 'Decision: migrate billing to postgres for durability',
    createdAt: ts + 20 * 60_000,
    importance: 0.9,
  });
  inputs.push({
    id: 'key1',
    content: 'Blocked: risk of data loss in the kafka rollout stage 3',
    createdAt: ts + 40 * 60_000,
    importance: 0.9,
  });

  const nodes = stratifyLevel(inputs, 'session');
  assert.equal(nodes.length, 1, 'one session bucket');
  const digest = nodes[0]!.content;
  assert.ok(digest.startsWith('[session]'));
  assert.ok(/migrate billing to postgres/.test(digest), 'decision line survives');
  assert.ok(/kafka rollout stage 3/.test(digest), 'blocked/risk line survives');
  assert.ok(nodes[0]!.tokenCount <= LEVEL_SPEC.session.tokenCap, 'digest bounded');
  // ~146 candidate tokens against a 112-token body budget: the watery
  // lines must be squeezed out, not stacked.
  const fillerKept = (digest.match(/Filler \d/g) ?? []).length;
  assert.ok(fillerKept < 6, `filler squeezed out (kept ${fillerKept}/6)`);
});

test('kernel: cross-item near-duplicate lines collapse to one', () => {
  const ts = 1_700_000_000_000;
  const inputs = [
    {
      id: 'a',
      content: 'Q3 decision: adopt postgres for the billing store in region east',
      createdAt: ts,
      importance: 0.8,
    },
    {
      id: 'b',
      content: 'Q3 decision: adopt postgres for billing store in region east',
      createdAt: ts + 60_000,
      importance: 0.8,
    },
    {
      id: 'c',
      content: 'Unrelated note about the envoy proxy upgrade path',
      createdAt: ts + 120_000,
      importance: 0.8,
    },
  ];
  const nodes = stratifyLevel(inputs, 'session');
  assert.equal(nodes.length, 1, 'one session bucket');
  const dupLines = nodes[0]!.content.split('\n').filter((l) => /adopt postgres/.test(l));
  assert.equal(dupLines.length, 1, 'near-duplicate pair collapses to one line');
  assert.ok(/envoy proxy upgrade/.test(nodes[0]!.content), 'distinct line kept');
});

test('kernel: extraction ranks by importance alone (keyword-free, budget-tight)', () => {
  // Keyword-free, mutually distinct lines: neither the keyword ladder nor
  // Jaccard dedupe nor lineScore eviction can explain who survives — the
  // salience ranking itself must. Eight lines ≈ 142 tokens against a
  // 112-token body budget: the least salient lines are squeezed.
  const ts = 1_700_000_000_000;
  const fillers = [
    'Weekly notes from the courtyard garden committee about the seasonal watering rotation schedule for the terrace planters and beds',
    'Lunch menu feedback roundup collected from the third floor kitchen committee this month mentions several sandwich requests',
    'Parking garage lighting renovation update circulated by facilities planning staff covers the ramp and lower levels',
    'Onboarding buddy assignment roster notes assembled for the newest hires cohort include mentors from every team',
    'Library seating expansion proposal comments gathered from the space committee favor the sunny corner alcoves',
    'Printer supplies inventory restock checklist maintained by office operations now tracks toner and paper stock',
  ].map((content, i) => ({
    id: `w${i}`,
    content,
    createdAt: ts + i * 60_000,
    importance: 0.3,
  }));
  const highs = [
    {
      id: 'h0',
      content: 'Vendor contract renewal for the observability platform expires this quarter',
      createdAt: ts + 30 * 60_000,
      importance: 0.9,
    },
    {
      id: 'h1',
      content: 'Customer escalation about invoice duplicates needs a billing fix shipped',
      createdAt: ts + 45 * 60_000,
      importance: 0.9,
    },
  ];
  const sigs = ['courtyard', 'kitchen', 'garage', 'buddy', 'seating', 'printer'];
  const countSigs = (digest: string) =>
    sigs.filter((s) => digest.toLowerCase().includes(s)).length;

  // Run A — highs are important: both survive; the two least salient
  // fillers (oldest, and the budget's last picks) are squeezed by
  // extraction alone. ~142 candidate tokens vs a 112-token body budget.
  const runA = stratifyLevel([...fillers, ...highs], 'session');
  assert.equal(runA.length, 1);
  const digestA = runA[0]!.content;
  assert.ok(/observability platform/.test(digestA), 'high-importance line 0 survives');
  assert.ok(/invoice duplicates/.test(digestA), 'high-importance line 1 survives');
  assert.ok(!digestA.toLowerCase().includes('courtyard'), 'least salient filler squeezed by extraction');
  assert.ok(!digestA.toLowerCase().includes('kitchen'), 'next least salient filler squeezed too');
  assert.equal(countSigs(digestA), 4, 'the other four fillers fit');
  assert.ok(runA[0]!.tokenCount <= LEVEL_SPEC.session.tokenCap, 'digest bounded');

  // Run B — same lines, same budget, importance FLIPPED onto the fillers:
  // now a demoted high line is the one squeezed, and fillers dominate.
  const flipped = [
    ...fillers.map((f) => ({ ...f, importance: 0.9 })),
    ...highs.map((h) => ({ ...h, importance: 0.3 })),
  ];
  const runB = stratifyLevel(flipped, 'session');
  const digestB = runB[0]!.content;
  const highsKept =
    Number(/observability platform/.test(digestB)) + Number(/invoice duplicates/.test(digestB));
  assert.equal(highsKept, 1, 'importance flip demotes exactly one high line to squeezed');
  assert.ok(countSigs(digestB) >= 4, 'fillers now dominate the digest');
});

// ───────────────────────────── integration ─────────────────────────────

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';

test('acceptance: 6-month palace — era queries from bounded tree nodes', async (t) => {
  const ctx = createMockContext();
  t.after(() => {
    const store = ctx.services.get('memory-store') as { close(): void } | undefined;
    try {
      store?.close();
    } catch {
      /* already closed */
    }
  });
  const dir = mkdtempSync(join(tmpdir(), 'era-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'palace.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    compression: { enabled: true, triggerCount: 100000, importanceThreshold: 0.35, decayHalfLifeDays: 14 },
  } as never);
  const palace: any = ctx.services.get('memory-palace');
  const tools = new Map(ctx.tools.map((x) => [x.name, x]));
  const tctx = { sessionId: 's-era', userId: 'u-era' };

  // Six months of distinct memories with explicit timestamps.
  const base = Date.now() - 180 * DAY;
  for (let i = 0; i < 60; i++) {
    const id = await palace.ingestor.ingestUserMemory({
      content: `Era fact ${i}: the ${['kafka', 'flink', 'postgres', 'envoy'][i % 4]} migration reached stage ${i % 5} in region ${i % 3}.`,
      userId: 'u-era',
      importance: 0.7,
    });
    // Backdate immediately by the returned id (spreads across 6 months).
    palace.store.db
      .prepare('UPDATE memory_items SET created_at = ? WHERE id = ?')
      .run(base + i * 3 * DAY, id);
  }

  // Sleep → stratify phase builds the tree.
  const dream = await palace.sleep.sleep(tctx, { forceCompression: false });
  const phase = dream.phases.find((p: any) => p.phase === 'stratify');
  assert.ok(phase && phase.ok, 'stratify phase ran clean');
  assert.ok(phase.detail.nodesBuilt > 0, 'nodes built');

  // memory_era tool: bounded era digests.
  const era: any = await tools.get('memory_era')!.run({ level: 'era' }, tctx);
  assert.ok(era.nodes.length >= 1, 'at least one era node');
  for (const n of era.nodes) {
    assert.ok(n.tokenCount <= LEVEL_SPEC.era.tokenCap, 'era digest bounded');
  }
  // Roadmap bar: era query answered from ≤3 nodes.
  assert.ok(era.nodes.length <= 3, `≤3 era nodes for 6 months (got ${era.nodes.length})`);
  assert.ok(
    era.nodes.some((n: any) => /migration|stage|region/.test(n.digest)),
    'era digest carries the period substance',
  );

  // Tree nodes are retrievable semantic items (era queries via retrieval).
  const res = await palace.retriever.retrieve({
    query: 'era digest of the migration months',
    scope: { userId: 'u-era' },
    topK: 50,
  });
  const stratifiedExist = palace.store
    .listItemsByLayer('semantic', 1000)
    .some((i: any) => i.metadata.tags?.includes('stratified') && i.embedding);
  assert.ok(stratifiedExist, 'stratified nodes stored as embedded items');
  assert.ok(
    res.hits.some((h: any) => h.item.metadata.tags?.includes('stratified')),
    'stratified node retrievable (topK 50: pool 97 → MMR → rerank keeps them)',
  );

  // Idempotent: second night bumps versions, does not duplicate items.
  const itemsBefore = palace.store.listItemsByLayer('semantic', 1000)
    .filter((i: any) => i.metadata.tags?.includes('stratified')).length;
  await palace.sleep.sleep(tctx, { forceCompression: false });
  const itemsAfter = palace.store.listItemsByLayer('semantic', 1000)
    .filter((i: any) => i.metadata.tags?.includes('stratified')).length;
  assert.equal(itemsAfter, itemsBefore, 'no duplicated stratified items');

  // Fifteen tools.
  assert.equal(ctx.tools.length, 15, 'fifteen tools');
});
