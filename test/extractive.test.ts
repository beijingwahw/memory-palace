/**
 * Extractive summarization tests — the shared MMR selection kernel
 * (src/utils/summarize.ts) and the distill no-LLM fallback built on it
 * (src/services/memory-compressor.ts).
 *
 * Kernel (deterministic, zero-LLM):
 *   - 3 groups × 3 sentences (redundant within a group, disjoint topics
 *     across groups): every group keeps at least one line, the selected
 *     token total respects the budget, survivors keep input order, a
 *     near-duplicate pair keeps only its highest-salience member, and a
 *     tiny budget still returns at least one line.
 *   - Coverage outranks the cap: with groups present, each group's best
 *     line is forced in even under a maxTokens of 1 (documented kernel
 *     contract — a group may never be summarized away entirely).
 *
 * Distill integration (offline-bm25, direct store inserts so the
 * ingestor's write-time dedupe never interferes):
 *   - Two near-identical 3-sentence members (keyword A vs keyword B in
 *     the FIRST sentence of each) merge through the DEFAULT no-LLM path:
 *     the merged content keeps both keywords (per-member coverage floor
 *     anchors each member's best sentence), carries the
 *     `[distilled · 2 memories]` prefix, and is significantly smaller
 *     than plain concatenation (< 70% of the members' token sum). Both
 *     members are tombstoned: invisible to LIVE reads, row retained.
 *   - A provided `summarize` callback still takes precedence: the merged
 *     content is EXACTLY the callback output (no prefix, no selection).
 *
 * Assembly follows genesis-services.test.ts: plugin boot against a
 * throwaway SQLite file, store-close hook registered BEFORE the
 * tempdir-removal hook (Windows WAL: rmSync cannot remove a directory
 * holding an open WAL handle). No network, no Date.now() in assertions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';
import { MemoryCompressor } from '../src/services/memory-compressor.ts';
import { OfflineBM25EmbeddingProvider } from '../src/utils/embedding.ts';
import { approximateTokenCount } from '../src/utils/tokenizer.ts';
import { extractiveSelect, type SalientLine } from '../src/utils/summarize.ts';
import type { MemoryStore } from '../src/services/memory-store.ts';
import type { MemoryItem } from '../src/types/index.js';

// ── Harness (genesis-services pattern) ───────────────────────────────────────

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after(fn: () => void): void;
}

/** Full plugin boot against a throwaway offline-bm25 palace (user scope). */
function install(t: AfterHooks) {
  const ctx = createMockContext();
  // Close the store BEFORE removing its directory (registration order).
  t.after(() => {
    const store = ctx.services.get('memory-store') as { close(): void } | undefined;
    try {
      store?.close();
    } catch {
      /* already closed */
    }
  });
  const dir = mkdtempSync(join(tmpdir(), 'extractive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'memory.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    scope: 'user',
  });
  return ctx;
}

/** Insert one fully-owned semantic item under `userId` with a real vector. */
async function putOwnedItem(
  store: MemoryStore,
  gw: OfflineBM25EmbeddingProvider,
  userId: string,
  id: string,
  content: string,
  importance = 0.8,
): Promise<void> {
  const tagged = await gw.embedTagged(content);
  const now = Date.now();
  const item: MemoryItem = {
    id,
    layer: 'semantic',
    content,
    embedding: tagged.vector,
    metadata: {
      source: 'user',
      userId,
      tags: [],
      tokenCount: approximateTokenCount(content),
      embeddingSpace: tagged.space,
      visibility: 'user',
    },
    createdAt: now,
    updatedAt: now,
    importance,
    accessCount: 0,
    lastAccessedAt: now,
  };
  store.insertItem(item, { userId });
}

// ── 1. Kernel: extractiveSelect ──────────────────────────────────────────────

/** 3 groups × 3 sentences: near-duplicate pair + one fresh line per group. */
function kernelFixtures(): SalientLine[] {
  return [
    // group 1 — tea
    { text: 'The tea ceremony uses a cast iron kettle and small clay cups.', salience: 0.9, group: 'g1' },
    { text: 'The tea ceremony uses a cast iron kettle and small clay cups for guests.', salience: 0.6, group: 'g1' },
    { text: 'Green tea leaves are steamed not roasted in this region.', salience: 0.5, group: 'g1' },
    // group 2 — sailing
    { text: 'The sailing crew trimmed the mainsail before the storm arrived.', salience: 0.8, group: 'g2' },
    { text: 'The sailing crew trimmed the mainsail before the storm arrived at dusk.', salience: 0.55, group: 'g2' },
    { text: 'Navigation charts stay folded in the waterproof locker.', salience: 0.45, group: 'g2' },
    // group 3 — baking
    { text: 'Sourdough bread needs a long cold ferment overnight.', salience: 0.7, group: 'g3' },
    { text: 'Sourdough bread needs a long cold ferment overnight in the fridge.', salience: 0.5, group: 'g3' },
    { text: 'The baker scores each loaf with a razor before baking.', salience: 0.4, group: 'g3' },
  ];
}

test('extractiveSelect kernel: coverage, budget, order, near-duplicate drop', async (t) => {
  const tok = (s: string) => approximateTokenCount(s);

  await t.test('every group covered, budget respected, input order kept, near-dups dropped', () => {
    const lines = kernelFixtures();
    // Budget sized to EXACTLY the intended survivor set: the three group
    // anchors (forced by coverage) + each group's fresh third line. The
    // near-duplicates (heavily MMR-penalized) can never fit.
    const maxTokens =
      tok(lines[0]!.text) + tok(lines[3]!.text) + tok(lines[6]!.text) +
      tok(lines[2]!.text) + tok(lines[5]!.text) + tok(lines[8]!.text);
    const selected = extractiveSelect(lines, { maxTokens });

    // Every group keeps at least one line.
    const groups = new Set(selected.map((l) => l.group));
    assert.ok(groups.has('g1') && groups.has('g2') && groups.has('g3'), 'all groups represented');

    // Selected token total respects the budget.
    const total = selected.reduce((s, l) => s + tok(l.text), 0);
    assert.ok(total <= maxTokens, `selected tokens ${total} <= budget ${maxTokens}`);

    // Survivors keep their ORIGINAL input order (indices strictly ascend).
    const idxOf = (text: string) => lines.findIndex((l) => l.text === text);
    const idxs = selected.map((l) => idxOf(l.text));
    for (let i = 1; i < idxs.length; i++) {
      assert.ok(idxs[i]! > idxs[i - 1]!, `input order preserved at position ${i}`);
    }

    // Near-duplicate pairs: only the highest-salience member survives.
    const texts = selected.map((l) => l.text);
    const dupLowers = [lines[1]!.text, lines[4]!.text, lines[7]!.text];
    for (const dup of dupLowers) {
      assert.ok(!texts.includes(dup), `near-duplicate dropped: ${dup.slice(0, 30)}…`);
    }
    for (const keep of [lines[0]!.text, lines[3]!.text, lines[6]!.text]) {
      assert.ok(texts.includes(keep), `near-duplicate winner kept: ${keep.slice(0, 30)}…`);
    }

    // Deterministic: identical call, identical result.
    assert.deepEqual(extractiveSelect(lines, { maxTokens }), selected);
  });

  await t.test('tight budget collapses to exactly the three group anchors', () => {
    const lines = kernelFixtures();
    const maxTokens = tok(lines[0]!.text) + tok(lines[3]!.text) + tok(lines[6]!.text);
    const selected = extractiveSelect(lines, { maxTokens });
    assert.equal(selected.length, 3, 'exactly the three anchors fit');
    assert.deepEqual(
      selected.map((l) => l.text),
      [lines[0]!.text, lines[3]!.text, lines[6]!.text],
      'anchors in original order',
    );
  });

  await t.test('tiny budget with groups: coverage floor outranks the cap', () => {
    const selected = extractiveSelect(kernelFixtures(), { maxTokens: 1 });
    assert.ok(selected.length >= 1, 'at least one line survives a tiny budget');
    // Documented contract: each group's best line is FORCED in, budget or
    // not — a group may never vanish from the selection.
    assert.deepEqual(
      selected.map((l) => l.group),
      ['g1', 'g2', 'g3'],
      'each group keeps its anchor even at maxTokens=1',
    );
  });

  await t.test('tiny budget without groups: never-empty floor keeps the top line', () => {
    const lines = kernelFixtures().map(({ text, salience }) => ({ text, salience }));
    const selected = extractiveSelect(lines, { maxTokens: 1 });
    assert.equal(selected.length, 1, 'exactly one line');
    assert.equal(selected[0]!.text, lines[0]!.text, 'the highest-salience line wins the floor');
  });

  await t.test('empty input yields empty output', () => {
    assert.deepEqual(extractiveSelect([], { maxTokens: 10 }), []);
  });
});

// ── 2. Distill integration: the no-LLM extractive fallback ──────────────────

test('distill no-LLM fallback: extractive digest keeps both members, tombstones originals', async (t) => {
  const ctx = install(t);
  const store = ctx.services.get('memory-store') as MemoryStore;
  const gw = new OfflineBM25EmbeddingProvider(256);

  // Two near-identical 3-sentence members. The distinguishing keywords
  // ('zenith' vs 'nadir') sit in the FIRST sentence of each member — the
  // sentence the per-member coverage floor anchors into the digest.
  const s1 =
    'The Orinoco data pipeline compacts telemetry streams into segmented archives at the zenith processing stage every night, replicating each compacted segment across three regional brokers before the analytics clusters request replay during their peak evening ingestion windows and weekend backfill runs that the scheduler queues.';
  const s2 =
    'Operators tune the compaction thresholds by watching broker lag curves and disk pressure gauges, because oversized segments slow down replay while undersized segments flood the metadata index with too many small objects during weekend maintenance windows that rarely stay quiet.';
  const s3 =
    'The replay path serves downstream feature stores and audit jobs alike, so every compaction decision is journaled with the operator identifier, the segment size histogram, and the broker rotation state for later forensic inspection by the on-call engineers.';
  const memberA = `${s1} ${s2} ${s3}`;
  // Member B = member A with a handful of distinguishing word swaps
  // (zenith→nadir, weekend→weekday, inspection→review): cosine far above
  // the 0.78 cluster threshold, far below identity.
  const memberB = `${s1.replace('zenith', 'nadir')} ${s2.replace('weekend', 'weekday')} ${s3.replace('inspection', 'review')}`;

  const idA = 'extractive-member-a';
  const idB = 'extractive-member-b';
  await putOwnedItem(store, gw, 'u-extractive', idA, memberA);
  await putOwnedItem(store, gw, 'u-extractive', idB, memberB);

  const compressor = new MemoryCompressor(store, gw, {
    enabled: true,
    triggerCount: 9999,
    importanceThreshold: 0.05,
    decayHalfLifeDays: 3650,
    clusterSimilarityThreshold: 0.78,
  });

  // DEFAULT path: no summarize callback → classical extractive fallback.
  const report = await compressor.distill();
  assert.equal(report.newSemanticItems, 1, 'exactly one merged item produced');

  const liveItems = store
    .listItemsByLayer('semantic', 50)
    .filter((i) => (i.metadata.tags ?? []).includes('distilled'));
  assert.equal(liveItems.length, 1, 'a single distilled item survives');
  const merged = liveItems[0]!;

  // Both members' distinguishing keywords survive the merge — the
  // coverage floor anchors each member's first (keyword-carrying)
  // sentence, so neither can be MMR'd away.
  assert.ok(merged.content.includes('zenith'), 'merged content keeps member-A keyword "zenith"');
  assert.ok(merged.content.includes('nadir'), 'merged content keeps member-B keyword "nadir"');

  // Cluster-size prefix marker: one line, leads the digest.
  assert.ok(
    merged.content.startsWith('[distilled · 2 memories] '),
    `digest leads with the cluster-size prefix (got: ${merged.content.slice(0, 30)}…)`,
  );

  // Significantly smaller than the historical concatenation: the digest
  // stays under 70% of the members' combined token count.
  const memberTokens = approximateTokenCount(memberA) + approximateTokenCount(memberB);
  const mergedTokens = approximateTokenCount(merged.content);
  assert.ok(
    mergedTokens < 0.7 * memberTokens,
    `digest tokens ${mergedTokens} < 70% of member sum ${memberTokens}`,
  );

  // Both members are tombstoned: invisible to LIVE reads, row retained.
  assert.equal(store.getItem(idA, { liveOnly: true }), null, 'member A not LIVE');
  assert.equal(store.getItem(idB, { liveOnly: true }), null, 'member B not LIVE');
  assert.ok(store.getItem(idA), 'member A row retained (tombstone, not hard delete)');
  assert.ok(store.getItem(idB), 'member B row retained (tombstone, not hard delete)');
});

test('distill: a summarize callback still takes precedence over the extractive fallback', async (t) => {
  const ctx = install(t);
  const store = ctx.services.get('memory-store') as MemoryStore;
  const gw = new OfflineBM25EmbeddingProvider(256);

  await putOwnedItem(
    store,
    gw,
    'u-callback',
    'cb-1',
    'Cobalt syncs the cobalt constellation telemetry every midnight sharp.',
  );
  await putOwnedItem(
    store,
    gw,
    'u-callback',
    'cb-2',
    'Cobalt syncs the cobalt constellation telemetry every noon sharp.',
  );

  const compressor = new MemoryCompressor(store, gw, {
    enabled: true,
    triggerCount: 9999,
    importanceThreshold: 0.05,
    decayHalfLifeDays: 3650,
    clusterSimilarityThreshold: 0.78,
  });

  const report = await compressor.distill({
    summarize: async (texts) => `llm-digest(${texts.length})`,
  });
  assert.equal(report.newSemanticItems, 1, 'one merged item via the callback path');

  const merged = store
    .listItemsByLayer('semantic', 50)
    .find((i) => (i.metadata.tags ?? []).includes('distilled'));
  assert.ok(merged, 'a distilled item exists');
  // The callback output is used VERBATIM — no extractive prefix, no
  // sentence selection, no truncation.
  assert.equal(merged!.content, 'llm-digest(2)', 'callback output used exactly');
});
