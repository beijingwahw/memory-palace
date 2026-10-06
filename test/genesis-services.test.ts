/**
 * Genesis services acceptance tests — adversarial isolation + guard rails
 * for the v0.19 genesis service wave:
 *
 *   1. Stratifier: two owners stratifying the SAME period build disjoint,
 *      mutually invisible tree_nodes (no cross-tenant digest bleed).
 *   2. Compressor: two owners' near-identical semantic items distill into
 *      per-owner merged items — userId never crosses a cluster.
 *   3. Federation: import dedupe probes BOTH the raw and the normalized
 *      spelling (belt & braces) so legacy irregular-whitespace rows are
 *      still recognized as duplicates.
 *   4. FeedbackLearner: a zero-hit signal learns nothing and journals no
 *      reward event (no 0/0 NaN path); impossible over-engagement clamps.
 *   5. Capsule: parseCapsule rejects embeddings whose b64 carries illegal
 *      characters (Buffer.from 'base64' would silently drop them).
 *
 * Deterministic by construction: offline-bm25 hashed vectors (no network),
 * throwaway SQLite files per test, and case-variant fixtures whose token
 * multisets — hence hashed vectors — are IDENTICAL, so clustering never
 * depends on hash luck.
 *
 * Temp cleanup follows the Windows WAL order proven in integration.test.ts:
 * the store-close t.after hook is registered BEFORE the directory-removal
 * hook (hooks run in registration order → close → rm), or rmSync hits the
 * open WAL handle (EPERM).
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
import {
  CAPSULE_MAGIC,
  CAPSULE_VERSION,
  capsuleItemId,
  parseCapsule,
} from '../src/utils/capsule.ts';
import type { MemoryStore } from '../src/services/memory-store.ts';
import type { MemoryIngestor } from '../src/services/memory-ingestor.ts';
import type { MemoryFederation } from '../src/services/memory-federation.ts';
import type { FeedbackLearner } from '../src/services/feedback-learner.ts';
import type { Stratifier } from '../src/services/stratifier.ts';
import type { MemoryItem } from '../src/types/index.ts';
import { scopeLevels, widestLevel } from '../src/utils/scope.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'genesis-'));
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
    importance: 0.8,
    accessCount: 0,
    lastAccessedAt: now,
  };
  store.insertItem(item, { userId });
}

// ─────────────── 1. Stratifier: per-owner tree isolation ───────────────

test('stratifier: two owners in one period build disjoint, mutually invisible trees', async (t) => {
  const ctx = install(t);
  const store = ctx.services.get('memory-store') as MemoryStore;
  const ingestor = ctx.services.get('memory-ingestor') as MemoryIngestor;
  const stratifier = ctx.services.get('stratifier') as Stratifier;

  // Two users, same wall-clock period, distinct knowledge domains. The
  // domain words are the leak detectors: a cross-tenant digest bleed would
  // carry one user's marker into the other's nodes.
  await ingestor.ingestUserMemory({
    content: 'Alpha user deploys the Helios cluster behind Envoy sidecars for east-west routing.',
    userId: 'u-alpha',
    importance: 0.8,
  });
  await ingestor.ingestUserMemory({
    content: 'Alpha user schedules Helios cluster autoscaling on GPU pressure every night.',
    userId: 'u-alpha',
    importance: 0.8,
  });
  await ingestor.ingestUserMemory({
    content: 'Bravo user reconciles the Aurora ledger through the Kafka pipeline at midnight.',
    userId: 'u-bravo',
    importance: 0.8,
  });
  await ingestor.ingestUserMemory({
    content: 'Bravo user archives Aurora ledger snapshots into cold storage every weekend.',
    userId: 'u-bravo',
    importance: 0.8,
  });

  const reportAlpha = await stratifier.stratify({ userId: 'u-alpha' });
  const reportBravo = await stratifier.stratify({ userId: 'u-bravo' });
  assert.ok(reportAlpha.nodesBuilt >= 1, 'alpha built tree nodes');
  assert.ok(reportBravo.nodesBuilt >= 1, 'bravo built tree nodes');

  const levels = ['session', 'week', 'month', 'era'] as const;
  for (const level of levels) {
    const alphaNodes = store.listTreeNodes(level, 'u-alpha');
    const bravoNodes = store.listTreeNodes(level, 'u-bravo');

    assert.ok(alphaNodes.length >= 1, `${level}: alpha has nodes`);
    assert.ok(bravoNodes.length >= 1, `${level}: bravo has nodes`);

    // Node ids are owner-keyed: intersec must be empty AND each side's
    // listing must contain only its own ids (mutual invisibility).
    const alphaIds = new Set(alphaNodes.map((n) => n.nodeId));
    const bravoIds = new Set(bravoNodes.map((n) => n.nodeId));
    for (const id of bravoIds) {
      assert.ok(!alphaIds.has(id), `${level}: bravo node ${id} leaked into alpha's id set`);
    }
    for (const n of alphaNodes) {
      assert.ok(n.nodeId.endsWith(':u-alpha'), `${level}: alpha listing holds only alpha nodes`);
      assert.doesNotMatch(
        n.content,
        /bravo|aurora ledger/i,
        `${level}: alpha digest carries bravo's domain words`,
      );
    }
    for (const n of bravoNodes) {
      assert.ok(n.nodeId.endsWith(':u-bravo'), `${level}: bravo listing holds only bravo nodes`);
      assert.doesNotMatch(
        n.content,
        /alpha|helios/i,
        `${level}: bravo digest carries alpha's domain words`,
      );
    }
  }
});

// ─────────────── 2. Compressor: distillation keeps owners apart ───────────────

test('compressor: distillation merges each owner separately — userId never crosses clusters', async (t) => {
  const ctx = install(t);
  const store = ctx.services.get('memory-store') as MemoryStore;
  // Same dimensions as the plugin's provider → same space tag; a private
  // instance keeps the fixture self-contained.
  const gw = new OfflineBM25EmbeddingProvider(256);

  // Case/punctuation variants of ONE sentence per owner: tokenize() is
  // case-insensitive and strips non-word chars, so each owner's four texts
  // produce IDENTICAL token multisets → IDENTICAL hashed vectors (cosine
  // exactly 1.0, same anchor bucket) — clustering is guaranteed, not
  // probabilistic. The two owners share most vocabulary, which is exactly
  // the adversarial part: only the owner partition may keep them apart.
  const auroraTexts = [
    'Aurora ingests sensor telemetry from the aurora fleet every night',
    'aurora INGESTS sensor telemetry from the AURORA fleet every night',
    'Aurora ingests sensor telemetry from the aurora fleet every night!',
    'aurora ingests sensor TELEMETRY from the aurora fleet every night',
  ];
  const borealisTexts = [
    'Borealis ingests sensor telemetry from the borealis fleet every night',
    'borealis INGESTS sensor telemetry from the BOREALIS fleet every night',
    'Borealis ingests sensor telemetry from the borealis fleet every night!',
    'borealis ingests sensor TELEMETRY from the borealis fleet every night',
  ];

  const originalIds: string[] = [];
  let seq = 0;
  for (const text of auroraTexts) {
    const id = `distill-aurora-${seq++}`;
    originalIds.push(id);
    await putOwnedItem(store, gw, 'u-aurora', id, text);
  }
  for (const text of borealisTexts) {
    const id = `distill-borealis-${seq++}`;
    originalIds.push(id);
    await putOwnedItem(store, gw, 'u-borealis', id, text);
  }

  const compressor = new MemoryCompressor(store, gw, {
    enabled: true,
    triggerCount: 9999,
    importanceThreshold: 0.05,
    decayHalfLifeDays: 3650,
    clusterSimilarityThreshold: 0.9,
  });
  const report = await compressor.distill();

  assert.equal(report.newSemanticItems, 2, 'exactly one merged item per owner');

  const merged = store
    .listItemsByLayer('semantic', 50)
    .filter((i) => (i.metadata.tags ?? []).includes('distilled'));
  assert.equal(merged.length, 2, 'two distilled rows survive in the store');

  const aurora = merged.find((i) => i.metadata.userId === 'u-aurora');
  const borealis = merged.find((i) => i.metadata.userId === 'u-borealis');
  assert.ok(aurora, 'an aurora-owned merged item exists');
  assert.ok(borealis, 'a borealis-owned merged item exists');

  assert.match(aurora!.content, /aurora/i, 'aurora merge consolidated aurora members');
  assert.doesNotMatch(aurora!.content, /borealis/i, 'aurora merge absorbed no borealis member');
  assert.match(borealis!.content, /borealis/i, 'borealis merge consolidated borealis members');
  assert.doesNotMatch(borealis!.content, /aurora/i, 'borealis merge absorbed no aurora member');

  // The merged vectors carry the space the gateway ACTUALLY served.
  assert.equal(aurora!.metadata.embeddingSpace, gw.space);
  assert.equal(borealis!.metadata.embeddingSpace, gw.space);

  // Originals were consolidated away inside the same transaction — none of
  // the eight member rows may coexist with its merged item. Since v0.20
  // distillation TOMBSTONES members (superseded_by → merged row) instead
  // of hard-deleting them, "gone" means invisible to every LIVE read, not
  // "row absent": getItem's default mode still returns soft-deleted rows
  // for undo/FLASHBACK/audit, so the assertion must use LIVE semantics —
  // liveOnly getItem null AND absent from the scoped live listing.
  const level = widestLevel(scopeLevels('user', { userId: 'u-aurora' }));
  const liveSemanticIds = new Set(
    store.listItemsByLayerScoped('semantic', level, 100).map((i) => i.id),
  );
  for (const id of originalIds) {
    assert.equal(
      store.getItem(id, { liveOnly: true }),
      null,
      `original ${id} tombstoned (invisible to live reads)`,
    );
    assert.ok(!liveSemanticIds.has(id), `original ${id} absent from the scoped LIVE listing`);
  }
});

// ─────────────── 3. Federation: belt & braces dedupe ───────────────

test('federation: import dedupe catches legacy irregular-whitespace rows (raw + normalized probe)', async (t) => {
  const ctx = install(t);
  const store = ctx.services.get('memory-store') as MemoryStore;
  const federation = ctx.services.get('memory-federation') as MemoryFederation;

  // The legacy row: same fact, RAW spelling with double/triple spaces —
  // exactly what a pre-normalization store holds.
  const raw =
    'Aurora  queue   drains  telemetry  nightly  without  manual  intervention';
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const now = Date.now();
  store.insertItem(
    {
      id: 'fed-legacy-1',
      layer: 'semantic',
      content: raw,
      metadata: {
        source: 'user',
        userId: 'u-fed',
        tokenCount: approximateTokenCount(raw),
        visibility: 'user',
      },
      createdAt: now,
      updatedAt: now,
      importance: 0.7,
      accessCount: 0,
      lastAccessedAt: now,
    },
    { userId: 'u-fed' },
  );

  // The capsule carries the SAME fact, whitespace normalized.
  const capsule = {
    magic: CAPSULE_MAGIC,
    version: CAPSULE_VERSION,
    palaceId: 'palace-genesis',
    exportedAt: now,
    items: [
      {
        id: capsuleItemId(normalized),
        layer: 'semantic',
        content: normalized,
        importance: 0.7,
        createdAt: now,
        entities: [],
        tags: [],
        source: 'user',
      },
    ],
    patterns: [],
  };

  const { plan } = await federation.planImportFromJson({
    capsuleJson: JSON.stringify(capsule),
    scope: { userId: 'u-fed' },
  });

  assert.equal(plan.toInsert.length, 0, 'whitespace-only variant is NOT new content');
  assert.equal(plan.duplicates.length, 1, 'raw-spelled legacy row marks it a duplicate');
  assert.equal(plan.duplicates[0]!.id, capsuleItemId(normalized));
});

// ─────────────── 4. FeedbackLearner: zero-division guard + clamp ───────────────

test('feedback-learner: zero-hit learn writes nothing; over-engagement clamps to reward 1', async (t) => {
  const ctx = install(t);
  const store = ctx.services.get('memory-store') as MemoryStore;
  const learner = ctx.services.get('feedback-learner') as FeedbackLearner | null;
  assert.ok(learner, 'feedback-learner service is wired (fusionLearning enabled by default)');
  const scope = { userId: 'u-fb' };

  // Zero-hit: no denominator, no learning, and above all NO reward event.
  const zero = learner!.learn({
    engagedItemIds: [],
    totalHits: 0,
    query: 'nothing was served',
    scope,
  });
  assert.equal(zero.reward, 0, 'zero-hit reward is 0, never NaN');
  assert.equal(zero.moved.length, 0, 'zero-hit moves no arm');
  assert.equal(
    store.recentBanditRewards(scope, 10).length,
    0,
    'zero-hit learn journals no reward event',
  );

  // Physically impossible over-engagement (5 engaged of 3 served) clamps.
  const clamped = learner!.learn({
    engagedItemIds: ['hit-a', 'hit-b', 'hit-c', 'hit-d'],
    totalHits: 3,
    query: 'clamp probe',
    scope,
  });
  assert.equal(clamped.reward, 1, 'over-engagement clamps to reward 1, never above');
  assert.ok(Number.isFinite(clamped.reward), 'reward stays finite');
  assert.equal(
    store.recentBanditRewards(scope, 10).length,
    1,
    'the valid learn journals exactly one reward event',
  );
});

// ─────────────── 5. Capsule: strict base64 charset at the boundary ───────────────

test('capsule: parseCapsule rejects embeddings whose b64 carries illegal characters', () => {
  const content = 'Genesis capsule charset sentinel fact about strict base64.';
  const base = {
    magic: CAPSULE_MAGIC,
    version: CAPSULE_VERSION,
    palaceId: 'palace-genesis',
    exportedAt: 1,
    patterns: [],
  };
  const item = {
    id: capsuleItemId(content),
    layer: 'semantic',
    content,
    importance: 0.5,
    createdAt: 1,
    entities: [],
    tags: [],
    source: 'user',
  };
  const validB64 = Buffer.alloc(16).toString('base64'); // 16 bytes = dim 4 × 4

  // '!' and ' ' are outside the base64 alphabet; Buffer.from(...,'base64')
  // would silently DROP them, so only a charset precheck can catch them.
  const bang = {
    ...base,
    items: [{ ...item, embedding: { space: 'offline-bm25:256', dim: 4, b64: 'AAAA!AAAAAAAAAAAA==' } }],
  };
  assert.throws(() => parseCapsule(JSON.stringify(bang)), /base64/, "'!' in b64 rejected");

  const spaced = {
    ...base,
    items: [
      {
        ...item,
        embedding: {
          space: 'offline-bm25:256',
          dim: 4,
          b64: validB64.slice(0, -3) + ' ' + validB64.slice(-2),
        },
      },
    ],
  };
  assert.throws(() => parseCapsule(JSON.stringify(spaced)), /base64/, "whitespace in b64 rejected");

  // Control: a canonical buffer-produced b64 of the right size still parses.
  const good = {
    ...base,
    items: [{ ...item, embedding: { space: 'offline-bm25:256', dim: 4, b64: validB64 } }],
  };
  assert.equal(parseCapsule(JSON.stringify(good)).items.length, 1, 'canonical b64 still accepted');
});
