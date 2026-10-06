/**
 * Hardening regression tests — one focused test per fix of the current
 * hardening wave. Every case is deterministic (fixed content, injected
 * timestamps, no network) and self-contained: pure-kernel cases need no
 * database; store cases build their own throwaway SQLite file; plugin
 * cases boot a full offline-bm25 palace.
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

import { tokenize, approximateTokenCount } from '../src/utils/tokenizer.ts';
import { detectConflict } from '../src/utils/consensus.ts';
import {
  parseCapsule,
  capsuleItemId,
  CAPSULE_MAGIC,
  CAPSULE_VERSION,
} from '../src/utils/capsule.ts';
import { compactBlock } from '../src/utils/core-memory.ts';
import { FusionBandit } from '../src/utils/bandit.ts';
import {
  applyOps,
  docFingerprint,
  emptyDoc,
  emptyOr,
  orAdd,
  orMembers,
  orMerge,
  orRemove,
  type CrdtOp,
} from '../src/utils/crdt.ts';
import { MemoryStore } from '../src/services/memory-store.ts';
import type { MemoryItem } from '../src/types/index.ts';
import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

// ───────────────────────────── helpers ─────────────────────────────

let fixtureSeq = 0;

/** Deterministic store item fixture (fixed clock, no embedding needed). */
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = 1_700_000_000_000 + fixtureSeq++;
  return {
    id: `hard-${fixtureSeq}`,
    layer: 'semantic',
    content: 'hardening fixture content',
    metadata: { source: 'user' },
    createdAt: now,
    updatedAt: now,
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: now,
    ...overrides,
  };
}

/** Fresh subtest-private store; close registered before the dir rm (WAL). */
function freshStore(t: AfterHooks): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'hard-store-'));
  const store = new MemoryStore({
    storagePath: join(dir, 'store.db'),
    dimensions: 8,
    scope: 'user',
  });
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return store;
}

/** Full plugin boot against a throwaway offline-bm25 palace. */
function install(t: AfterHooks, opts: Record<string, unknown> = {}) {
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
  const dir = mkdtempSync(join(tmpdir(), 'hard-palace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'memory.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
}

// ───────────────────── B1: tokenizer CJK bigrams ─────────────────────

test('tokenizer: CJK overlapping bigrams, isolated chars, EN unchanged', () => {
  assert.deepEqual(
    tokenize('依赖数据库'),
    ['依赖', '赖数', '数据', '据库'],
    '5-char CJK run → 4 overlapping bigrams',
  );
  assert.deepEqual(tokenize('好'), ['好'], 'isolated CJK char kept alone');

  // 5 CJK chars ≈ 5 tokens under the per-character budget, never 1.
  assert.ok(
    approximateTokenCount('依赖数据库') >= 5,
    `CJK token budget counts per character (got ${approximateTokenCount('依赖数据库')})`,
  );

  // English behavior is untouched: lowercase words, length ≥ 2.
  assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
});

// ───────────────── B2: consensus contracted negation ─────────────────

test('consensus: contracted English negation ("doesn\'t") flips polarity', () => {
  const negated = {
    id: 'a',
    content: "The aurora payment service doesn't use Kafka at all for its order pipeline.",
    score: 1,
  };
  const affirmative = {
    id: 'b',
    content: 'The aurora payment service uses Kafka heavily for its order pipeline.',
    score: 1,
  };
  // Shared subject (≥ 3 common tokens) + opposite negation polarity.
  const det = detectConflict(negated, affirmative);
  assert.equal(det.conflict, true, "apostrophe contraction must not hide the negation");
  assert.match(det.reason ?? '', /negat/i, 'conflict names the polarity flip');

  // Control: two affirmatives over the same subject stay corroborating.
  const other = {
    id: 'c',
    content: 'The aurora payment service uses Kafka for its order pipeline.',
    score: 1,
  };
  assert.equal(
    detectConflict(affirmative, other).conflict,
    false,
    'same-polarity pair does not conflict',
  );
});

// ───────────────── B3: capsule parseCapsule hardening ─────────────────

/** Valid capsule JSON skeleton with deterministic content-addressed ids. */
function capsuleJson(items: unknown[], patterns?: unknown): string {
  const base: Record<string, unknown> = {
    magic: CAPSULE_MAGIC,
    version: CAPSULE_VERSION,
    palaceId: 'hard-palace',
    exportedAt: 1_700_000_000_000,
    items,
  };
  if (patterns !== undefined) base.patterns = patterns;
  return JSON.stringify(base);
}

test('capsule: parseCapsule survives a missing patterns field', () => {
  const content = 'hardening capsule fact about kafka pipelines';
  const json = capsuleJson([
    {
      id: capsuleItemId(content),
      layer: 'semantic',
      content,
      importance: 0.5,
      createdAt: 1,
      entities: [],
      tags: [],
      source: 'user',
    },
  ]);
  const parsed = parseCapsule(json);
  assert.deepEqual(parsed.patterns, [], 'absent patterns normalized to []');
  assert.equal(parsed.items.length, 1, 'item parsed');
});

test('capsule: non-array patterns field is rejected at the boundary', () => {
  const content = 'second hardening capsule fact about flink jobs';
  const json = capsuleJson(
    [
      {
        id: capsuleItemId(content),
        layer: 'semantic',
        content,
        importance: 0.5,
        createdAt: 1,
        entities: [],
        tags: [],
        source: 'user',
      },
    ],
    'nope',
  );
  assert.throws(() => parseCapsule(json), /patterns must be an array/);
});

test('capsule: embedding buffer length must match dim × 4', () => {
  const content = 'third hardening capsule fact about postgres tuning';
  const json = capsuleJson([
    {
      id: capsuleItemId(content),
      layer: 'semantic',
      content,
      importance: 0.5,
      createdAt: 1,
      entities: [],
      tags: [],
      source: 'user',
      embedding: {
        space: 'offline-bm25:256',
        dim: 4, // claims 4 floats = 16 bytes…
        b64: Buffer.alloc(8).toString('base64'), // …but ships 8 bytes
      },
    },
  ]);
  assert.throws(() => parseCapsule(json), /expected 16 bytes/);
});

// ───────────────── B4: tombstone survives same-id re-insert ─────────────────

test('store: re-inserting a tombstoned id never resurrects it', (t) => {
  const store = freshStore(t);
  const id = 'resurrect-probe';
  store.insertItem(makeItem({ id, content: 'original body' }), { userId: 'u-audit' });
  assert.equal(store.tombstoneItem(id), true, 'tombstone recorded');

  // Same-id re-insert takes the ON CONFLICT update path; it must rewrite
  // the payload WITHOUT clearing deleted_at (right-to-be-forgotten cannot
  // be bypassed by re-ingesting the id).
  store.insertItem(makeItem({ id, content: 'rewritten body' }), { userId: 'u-audit' });

  const audited = store.getItem(id);
  assert.ok(audited, 'default (audit) read still reaches the row');
  assert.equal(audited!.content, 'rewritten body', 'payload did update');
  assert.equal(
    store.getItem(id, { liveOnly: true }),
    null,
    'live-only read sees nothing after re-insert',
  );
  assert.ok(
    !store.listItemsByLayer('semantic', 100).some((i) => i.id === id),
    'layer listing excludes the tombstoned id',
  );
});

// ───────────────── B5: listRecentTrajectories recency ─────────────────

test('store: listRecentTrajectories returns the MOST RECENT sessions, oldest first', (t) => {
  const store = freshStore(t);
  const insert = (store as any).db.prepare(
    `INSERT INTO query_log (session_id, user_id, workspace_id, query, created_at)
     VALUES (?, ?, NULL, ?, ?)`,
  );
  // Five sessions × two queries with strictly increasing timestamps.
  const base = 1_700_000_000_000;
  for (let s = 1; s <= 5; s++) {
    insert.run(`s${s}`, 'u-traj', `q${s}-first`, base + s * 10_000);
    insert.run(`s${s}`, 'u-traj', `q${s}-second`, base + s * 10_000 + 1);
  }
  // Another user's later traffic must never leak into the window.
  insert.run('other-session', 'u-other', 'other-query', base + 99_000);

  const trips = store.listRecentTrajectories('u-traj', 3);
  assert.equal(trips.length, 3, 'only the requested number of trajectories');
  assert.deepEqual(
    trips.map((q) => q[0]),
    ['q3-first', 'q4-first', 'q5-first'],
    'the MOST RECENT 3 of 5 sessions, in ascending time order',
  );
  assert.deepEqual(trips[2]!, ['q5-first', 'q5-second'], 'queries ascend within a session');
});

// ─────────────── B6: compactBlock eviction vs preview cap ───────────────

test('compactBlock: eviction is never interrupted by the preview cap', () => {
  // 12 mutually-distinct low-value lines (pairwise Jaccard ≪ dedupe 0.6)
  // + 2 keyword lines (goal/decision score boosts).
  const WORDS = [
    'amber', 'violet', 'copper', 'silver', 'indigo', 'bronze',
    'marble', 'sandy', 'rugged', 'gentle', 'hazy', 'narrow',
    'quiet', 'rapid', 'sturdy', 'velvet', 'wooden', 'plastic',
    'candid', 'lucid', 'formal', 'jolly', 'keenly', 'lively',
    'mellow', 'nimble', 'ornate', 'plush', 'quaint', 'regal',
    'serene', 'tender', 'unique', 'vivid', 'wary', 'zesty',
  ];
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) {
    lines.push(`filler entry${i} ${WORDS[3 * i]!} ${WORDS[3 * i + 1]!} ${WORDS[3 * i + 2]!}`);
  }
  lines.push('GOAL: ship the reflect milestone');
  lines.push('DECISION: freeze the schema contract');
  const content = lines.join('\n');

  const result = compactBlock(content, { maxTokens: 24 });
  // The eviction loop must keep evicting until the budget holds even after
  // removedPreviews reaches its cap of 8 (only the PREVIEWS are capped).
  assert.ok(
    approximateTokenCount(result.content) <= 30,
    `result fits the cap (+tolerance): got ${approximateTokenCount(result.content)} tokens`,
  );
  assert.ok(result.content.includes('GOAL:'), 'keyword line 1 survives');
  assert.ok(result.content.includes('DECISION:'), 'keyword line 2 survives');
  assert.ok(result.removedPreviews.length <= 8, 'previews stay bounded at 8');
  assert.ok(result.kept < lines.length, 'low-value lines were actually evicted');
});

// ───────────────── B7: bandit explorationRate / reset ─────────────────

test('bandit: explorationRate reports the constructed epsilon; reset keeps it', () => {
  const b = new FusionBandit({ epsilon: 0.2 });
  assert.equal(b.explorationRate, 0.2, 'getter returns the constructed epsilon');

  for (let i = 0; i < 5; i++) b.update(0.9, 2);
  assert.ok(b.explorationRate <= 0.2, 'epsilon only decays between updates');
  assert.ok(b.explorationRate > 0.1, 'still exploring after a few rounds');

  b.reset();
  assert.equal(b.explorationRate, 0.2, 'reset restores the CONSTRUCTED epsilon');
  assert.notEqual(b.explorationRate, 0.1, 'never the old hard-coded 0.1 default');
  // Internal agreement: the private clock field was rewound to 0.2 too.
  assert.equal((b as any).epsilon, 0.2, 'internal epsilon agrees with the getter');
});

// ───────────────── B8: CRDT OR-Set keys containing '@' ─────────────────

test('crdt OR-Set: tombstones key on the full name when the key contains @', () => {
  const ts1 = { counter: 1, replica: 'r1' };
  const ts2 = { counter: 2, replica: 'r1' };

  const st = emptyOr<string>();
  orAdd(st, 'user@corp', 'member-a', ts1);
  orAdd(st, 'teammate', 'member-b', ts1);
  orRemove(st, 'user@corp', ts2);

  const members = orMembers(st);
  assert.ok(!members.has('user@corp'), 'the @-bearing key is removed');
  // The real tombstone bug: a prefix-truncating decode would leave the
  // element alive under the WRONG key ('user'), so check both spellings
  // AND the element's value.
  assert.ok(!members.has('user'), 'no truncated-key survivor');
  assert.ok(
    ![...members.values()].includes('member-a'),
    'the removed element is gone entirely',
  );
  assert.equal(members.get('teammate'), 'member-b', 'keys without @ are untouched');

  // The merge path converges the same way: a replica holding only the
  // remove must kill the @-bearing key, not a truncated prefix key.
  const remover = emptyOr<string>();
  orRemove(remover, 'user@corp', ts2);
  orMerge(st, remover);
  const merged = orMembers(st);
  assert.ok(!merged.has('user@corp') && !merged.has('user'), 'merge keeps the tombstone on the right key');
  assert.ok(![...merged.values()].includes('member-a'), 'no merge resurrection');
  assert.equal(merged.get('teammate'), 'member-b', 'unrelated key survives the merge');
});

// ───────────────── B9: CRDT fingerprint convergence/sensitivity ─────────────────

test('crdt docFingerprint: order-convergent but value-sensitive', () => {
  const ops: CrdtOp[] = [
    { kind: 'item-set', key: 'k1', value: { text: 'alpha' }, ts: { counter: 1, replica: 'a' } },
    { kind: 'tag-add', key: 't1', value: 'blue', ts: { counter: 2, replica: 'a' } },
    { kind: 'entity-add', key: 'e1', value: 'kafka', ts: { counter: 3, replica: 'a' } },
  ];
  const forward = applyOps(emptyDoc(), ops);
  const shuffled = applyOps(emptyDoc(), [ops[2]!, ops[0]!, ops[1]!]);
  assert.equal(
    docFingerprint(forward),
    docFingerprint(shuffled),
    'same op set in different arrival order converges',
  );

  const divergent = applyOps(
    emptyDoc(),
    ops.map((op) => (op.kind === 'item-set' ? { ...op, value: { text: 'beta' } } : op)),
  );
  assert.notEqual(
    docFingerprint(forward),
    docFingerprint(divergent),
    'same key holding a different value must fingerprint differently',
  );
});

// ─────────────── B10: retrieval cache partitions by filters ───────────────

test('retrieval: query cache isolates entries by filters', async (t) => {
  const ctx = install(t);
  const palace: any = ctx.services.get('memory-palace');

  await palace.ingestor.ingestUserMemory({
    content: 'FilterProbe keeps its API keys in the vault service backend.',
    userId: 'u-fil',
    importance: 0.9,
  });
  await palace.ingestor.ingestUserMemory({
    content: 'FilterProbe keeps its API keys in the vault legacy archive.',
    userId: 'u-fil',
    importance: 0.9,
  });
  // Relabel the second item's metadata.source so both share a topic but
  // differ in a filterable field (same pattern as the backdate SQL in
  // integration.test.ts).
  (palace.store as any).db
    .prepare(
      `UPDATE memory_items
         SET metadata = json_set(metadata, '$.source', 'system')
       WHERE content LIKE '%legacy archive%'`,
    )
    .run();

  const q = 'Where does FilterProbe keep its API keys?';
  const ask = (filters: Record<string, unknown>) =>
    palace.retriever.retrieve({ query: q, topK: 5, filters, scope: { userId: 'u-fil' } });

  const r1 = await ask({ source: 'user' });
  assert.ok(!r1.debug?.cacheHit, 'first filtered query is a cache miss');
  assert.ok(
    r1.hits.every((h: any) => h.item.metadata.source === 'user'),
    'filter {source:"user"} returns only user-source items',
  );

  const r2 = await ask({ source: 'user' });
  assert.ok(r2.debug?.cacheHit, 'identical filters served from the cache');

  const r3 = await ask({ source: 'system' });
  assert.ok(!r3.debug?.cacheHit, 'different filters bypass the cached entry');
  assert.ok(r3.hits.length > 0, 'system-filter query still retrieves');
  assert.ok(
    r3.hits.every((h: any) => h.item.metadata.source === 'system'),
    'filter {source:"system"} returns only system-source items',
  );
  assert.ok(
    r3.hits.some((h: any) => /legacy archive/.test(h.item.content)),
    'the system-source item is the one returned',
  );
});

// ───────────────── B11: reflector sweep reports recallAtK ─────────────────

test('reflector: sweeps carry a numeric recallAtK field', async (t) => {
  const ctx = install(t);
  const palace: any = ctx.services.get('memory-palace');

  const topics = ['kafka', 'flink', 'postgres', 'redis'];
  for (let i = 0; i < 4; i++) {
    await palace.ingestor.ingestUserMemory({
      content: `ReflectFact ${i}: the ${topics[i]} pipeline covers stage ${i} of the reflect benchmark.`,
      userId: 'u-rk',
      importance: 0.8,
    });
  }

  const items = palace.store.listItemsByLayer('semantic', 50);
  assert.ok(items.length >= 3, 'small semantic library ingested');

  const report = await palace.reflector.reflect(items, { userId: 'u-rk' }, { maxEntries: 4 });
  assert.ok(report.entries >= 1, 'benchmark built from the stored items');
  for (const [label, sweep] of [
    ['current', report.current],
    ['best', report.best],
  ] as const) {
    assert.equal(
      typeof sweep.recallAtK,
      'number',
      `${label} sweep reports recallAtK (renamed from recallAt5)`,
    );
    assert.ok(Number.isFinite(sweep.recallAtK), `${label} recallAtK is finite`);
    assert.equal(typeof sweep.mrr, 'number', `${label} sweep reports mrr`);
  }
});

// ───────────── B12: reflector current point with >3-decimal config ─────────────

test('reflector: current sweep is located even when config carries >3 decimals', async (t) => {
  // unique() normalizes grid axes via Number(v.toFixed(3)), so a raw
  // graphBoost of 0.1234 must still locate its normalized grid point
  // (0.123); pre-fix it missed every key and silently fell back to the
  // LAST sweep — the most aggressive point (graphBoost 0.25).
  const ctx = install(t, { retrieval: { graphBoost: 0.1234 } });
  const palace: any = ctx.services.get('memory-palace');

  const topics = ['kafka', 'flink', 'postgres'];
  for (let i = 0; i < 3; i++) {
    await palace.ingestor.ingestUserMemory({
      content: `ReflectFact ${i}: the ${topics[i]} pipeline covers stage ${i} of the reflect benchmark.`,
      userId: 'u-b12',
      importance: 0.8,
    });
  }

  const items = palace.store.listItemsByLayer('semantic', 50);
  assert.ok(items.length >= 2, 'small semantic library ingested');

  const report = await palace.reflector.reflect(items, { userId: 'u-b12' }, { maxEntries: 2 });
  assert.equal(
    report.current.params.graphBoost,
    0.123,
    'current sits on the normalized grid point (0.1234 → 0.123), not the fallback max point 0.25',
  );
  assert.ok(Number.isFinite(report.current.objective), 'current objective is finite');
  assert.equal(typeof report.current.mrr, 'number', 'current sweep reports mrr');
  assert.equal(typeof report.best.mrr, 'number', 'best sweep reports mrr');
});
