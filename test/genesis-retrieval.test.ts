/**
 * Genesis differential tests — guard the retrieval kernel's twin
 * implementations against each other and pin the invariant proofs from
 * the adversarial audit of v0.19.0:
 *
 *   G1 (flagship) ACL differential equivalence: the store's SQL tier
 *      filter (listItemsByLayerScoped) must produce EXACTLY the same id
 *      set as a JS brute-force visibleAtLevel() filter over the same
 *      universe, for every caller identity and every layer. SQL/JS
 *      mirror drift in the visibility ACL surfaces here as a set
 *      difference instead of as a cross-tenant leak.
 *   G2 IVF ladder: (a) probe-key-set proof — the [r, r+1, MAX] delta
 *      ladder's cumulative key union === keysWithin(MAX) === every
 *      bucket key === the exact scan's key set; (b) measured radius-1
 *      recall@10 vs exact ≥ 0.8 on ≥400-item corpora at BOTH 128 and
 *      256 dimensions.
 *   G3 buildRetrievalPrior server-side clamp: an out-of-band
 *      opts.graphBoost (0.9, 5, -3) can never move a multiplier outside
 *      [1−0.5, 1+0.5]; plus PageRank mass conservation (Σrank ≈ 1)
 *      after node-set edge filtering.
 *   G4 query-cache partition completeness: six same-text parameter
 *      variants never hit each other's entries — only a same-variant
 *      replay hits. Also pins stableFusionKey's "no overrides"
 *      spellings (undefined ≡ {} ≡ {arm: undefined}) onto ONE partition.
 *
 * Fully deterministic: fixed content, fixed timestamps, modular
 * arithmetic instead of RNG, offline-bm25 embeddings only. Temp DB
 * cleanup follows the Windows WAL order proven in integration.test.ts:
 * the store-close hook registers BEFORE the directory-removal hook
 * (hooks run in registration order → close → rm), or rmSync hits the
 * open WAL handle (EPERM).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/services/memory-store.ts';
import { MemoryGraph } from '../src/services/memory-graph.ts';
import { MemoryRetriever, type RetrieverConfig } from '../src/services/memory-retriever.ts';
import { OfflineBM25EmbeddingProvider } from '../src/utils/embedding.ts';
import {
  scopeLevels,
  visibleAtLevel,
  widestLevel,
  type ScopeLevelClause,
  type VisibilityTier,
} from '../src/utils/scope.ts';
import {
  IVF_MAX_RADIUS,
  allBucketKeys,
  keysWithin,
  probeKeys,
  probeOrder,
} from '../src/utils/ivf.ts';
import type {
  MemoryItem,
  MemoryLayer,
  MemoryScope,
  RetrievalQuery,
} from '../src/types/index.ts';

// ---------------------------------------------------------------- helpers

interface AfterHooks {
  after: (fn: () => void) => void;
}

/** Fixed clock base — no Date.now() dependence anywhere in the fixtures. */
const BASE_TS = 1_700_000_000_000;

/** Throwaway subtest-private store; close registered before the dir rm. */
function freshStore(t: AfterHooks, dimensions: number): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-'));
  const store = new MemoryStore({
    storagePath: join(dir, 'store.db'),
    dimensions,
    scope: 'user',
  });
  t.after(() => store.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return store;
}

// --------------------------------------------------- G1: ACL differential

test('G1 (flagship): SQL tier filter === JS visibleAtLevel brute force for every identity', (t) => {
  const store = freshStore(t, 8);

  const TIERS: VisibilityTier[] = ['session', 'workspace', 'user', 'global'];
  const LAYERS: MemoryLayer[] = ['semantic', 'procedural', 'episodic'];
  // Owner sets: the primary caller's ids, and a foreign tenant's ids.
  const OWNERS = [
    { userId: 'alice', workspaceId: 'ws-acme', sessionId: 's-alice-1' },
    { userId: 'bob', workspaceId: 'ws-borealis', sessionId: 's-bob-9' },
  ] as const;

  let seq = 0;
  const put = (
    id: string,
    tier: VisibilityTier,
    layer: MemoryLayer,
    ctx: { userId?: string; workspaceId?: string; sessionId?: string },
  ): void => {
    const now = BASE_TS + seq++;
    store.insertItem(
      {
        id,
        layer,
        content: `acl fixture ${id}`,
        metadata: { source: 'user', visibility: tier, ...ctx },
        createdAt: now,
        updatedAt: now,
        importance: 0.5,
        accessCount: 0,
        lastAccessedAt: now,
      },
      ctx,
    );
  };

  // ~40 tier × owner × layer combinations via a deterministic modular
  // walk: every tier meets every owner set and all three layers.
  for (let i = 0; i < 40; i++) {
    const tier = TIERS[i % 4]!;
    const owner = OWNERS[Math.floor(i / 4) % 2]!;
    const layer = LAYERS[i % 3]!;
    put(`acl-${i}`, tier, layer, { ...owner });
  }
  // Adversarial degenerates: a tier whose owner column is NULL is visible
  // to NOBODY — both implementations must agree it stays hidden.
  put('acl-unbacked-session', 'session', 'semantic', {});
  put('acl-unbacked-user', 'user', 'semantic', { workspaceId: 'ws-acme' });
  // Legacy pre-ACL rows (visibility IS NULL) read as global on BOTH
  // sides — including the one carrying an owner column: NULL/global rows
  // ignore owner columns in the SQL clause AND in visibleAtLevel.
  const raw = (store as unknown as {
    db: { prepare(sql: string): { run(...params: unknown[]): unknown } };
  }).db;
  for (const [id, ownerId] of [
    ['acl-legacy-plain', null],
    ['acl-legacy-owned', 'alice'],
  ] as const) {
    raw.prepare(
      `INSERT INTO memory_items
         (id, layer, content, metadata, created_at, updated_at, importance,
          access_count, last_accessed_at, user_id)
       VALUES (?, 'semantic', ?, '{}', ?, ?, 0.5, 0, 0, ?)`,
    ).run(id, `legacy ${id}`, BASE_TS, BASE_TS, ownerId);
  }

  // Universe through the store's own read path (rowToItem backfills the
  // owner columns the JS mirror re-checks).
  const universe: MemoryItem[] = [];
  for (const layer of LAYERS) universe.push(...store.listItemsByLayer(layer, 5000));
  assert.equal(universe.length, 44, 'universe = 40 combos + 2 degenerates + 2 legacy rows');

  // The JS brute-force mirror: row-backed owner fields first, metadata
  // fallback second (the exact shape the retriever's entity-hop path
  // re-checks with).
  const jsVisible = (it: MemoryItem, level: ScopeLevelClause): boolean =>
    visibleAtLevel(
      {
        visibility: it.visibility ?? it.metadata.visibility ?? null,
        userId: it.userId ?? it.metadata.userId ?? null,
        workspaceId: it.workspaceId ?? it.metadata.workspaceId ?? null,
        sessionId: it.sessionId ?? it.metadata.sessionId ?? null,
      },
      level,
    );

  const IDENTITIES: MemoryScope[] = [
    { userId: 'alice', workspaceId: 'ws-acme', sessionId: 's-alice-1' },
    { userId: 'alice', workspaceId: 'ws-acme' },
    { userId: 'bob', workspaceId: 'ws-borealis', sessionId: 's-bob-9' },
    { userId: 'bob', workspaceId: 'ws-acme' },
    { workspaceId: 'ws-acme', sessionId: 's-alice-1' },
    { userId: 'carol' },
    {},
  ];

  const perIdentityTotals: number[] = [];
  for (const identity of IDENTITIES) {
    const widest = widestLevel(scopeLevels('session', identity));
    let total = 0;
    for (const layer of LAYERS) {
      const sqlIds = store
        .listItemsByLayerScoped(layer, widest, 500)
        .map((it) => it.id)
        .sort();
      const jsIds = universe
        .filter((it) => it.layer === layer && jsVisible(it, widest))
        .map((it) => it.id)
        .sort();
      assert.deepEqual(
        sqlIds,
        jsIds,
        `SQL/JS mirror drift for identity ${JSON.stringify(identity)} layer ${layer}`,
      );
      total += sqlIds.length;
    }
    perIdentityTotals.push(total);
  }

  // Non-vacuity anchors: identities must see DIFFERENT universes, and
  // the anonymous caller sees exactly the global tier + legacy rows
  // (10 global-tier combos + 2 legacy NULL-visibility rows).
  assert.ok(
    new Set(perIdentityTotals).size > 1,
    `identities disagree (got ${perIdentityTotals.join(',')}) — differential is non-vacuous`,
  );
  assert.equal(
    perIdentityTotals[perIdentityTotals.length - 1],
    12,
    'anonymous caller: global tier + legacy rows only',
  );
});

// ----------------------------------------------------- G2: IVF ladder

test('G2: ladder key-union === all bucket keys; radius-1 recall@10 ≥ 0.8 at dims 128 and 256', async (t) => {
  // Pure-kernel preconditions the ladder proof leans on.
  const ALL = allBucketKeys();
  assert.equal(ALL.length, 16, '2^4 buckets');
  assert.equal(keysWithin(IVF_MAX_RADIUS), ALL.length, 'radius MAX covers every key');
  assert.deepEqual([...ALL].sort(), ALL, 'allBucketKeys is the sorted full key set');

  for (const dimensions of [128, 256]) {
    await t.test(`dimensions ${dimensions}`, async (t2) => {
      const store = freshStore(t2, dimensions);
      const prov = new OfflineBM25EmbeddingProvider(dimensions);
      const space = prov.space;

      // ≥400-item corpus. Each topic carries a SATELLITE vocabulary used
      // by all of its docs and a tripled topic token (sublinear TF still
      // amplifies it), so a topic's doc vectors share one dominant
      // direction — one anchor bucket — while cross-topic cosine stays
      // low. Radius-1 (self + Hamming-1 fanout = 5/16 buckets) then
      // covers the query's whole topic cluster at ANY width; the only
      // recall loss is quantization/tie noise at the top-10 boundary.
      const TOPICS = [
        ['kafka', 'broker', 'offset', 'compaction', 'partition'],
        ['flink', 'watermark', 'backpressure', 'checkpoint', 'slot'],
        ['postgres', 'vacuum', 'index', 'bloat', 'wal'],
        ['kubernetes', 'pod', 'cordon', 'helm', 'manifest'],
        ['envoy', 'listener', 'route', 'cluster', 'mesh'],
        ['grafana', 'dashboard', 'panel', 'alert', 'datasource'],
        ['redis', 'eviction', 'replica', 'keyspace', 'latency'],
        ['clickhouse', 'merge', 'column', 'engine', 'part'],
      ] as const;
      const CORPUS = 420;
      for (let i = 0; i < CORPUS; i++) {
        const [topic, s0, s1, s2, s3] = TOPICS[i % TOPICS.length]!;
        const content =
          `Fact ${i}: ${topic} ${topic} ${topic} ${s0} ${s1} ${s2} ${s3}` +
          ` shard ${Math.floor(i / 8)}`;
        const now = BASE_TS + i;
        store.insertItem(
          {
            id: `ivf-${dimensions}-${i}`,
            layer: 'semantic',
            content,
            embedding: await prov.embed(content),
            metadata: { source: 'user', embeddingSpace: space },
            createdAt: now,
            updatedAt: now,
            importance: 0.5 + ((i % 5) / 10),
            accessCount: 0,
            lastAccessedAt: now,
          },
          {},
        );
      }
      assert.equal(store.countItemsInSpace(space), CORPUS);
      assert.equal(
        store.vecBucketHistogram(space).reduce((s, b) => s + b.n, 0),
        CORPUS,
        'every vector bucketed',
      );
      assert.ok(
        store.vecBucketHistogram(space).length >= 2,
        'corpus spreads across buckets',
      );

      const QUERIES = [
        'kafka broker offset compaction partition',
        'flink watermark backpressure checkpoint slot',
        'postgres vacuum index bloat wal',
        'grafana dashboard panel alert datasource',
      ];
      const recalls: number[] = [];
      for (const q of QUERIES) {
        const qv = await prov.embed(q);

        // (a) Ladder key-union proof — replicate scanWithIvf's EXACT
        // algorithm (clamped non-decreasing radii, seenRadii dedup,
        // delta-key filter, and NO early break, i.e. a starved pool):
        // the cumulative probed-key union must equal every bucket key,
        // which IS the exact scan's key set. Pool starvation therefore
        // always terminates in the exhaustive fallback.
        const order = probeOrder(qv);
        const radii = [1, 2, IVF_MAX_RADIUS].map((r) =>
          Math.max(0, Math.min(IVF_MAX_RADIUS, r)),
        );
        const seenRadii = new Set<number>();
        const probedSet = new Set<string>();
        const probedList: string[] = [];
        for (const r of radii) {
          if (seenRadii.has(r)) continue;
          seenRadii.add(r);
          const newKeys = order
            .slice(0, keysWithin(r))
            .filter((k) => !probedSet.has(k));
          for (const k of newKeys) {
            probedSet.add(k);
            probedList.push(k);
          }
        }
        assert.deepEqual(
          [...probedList].sort(),
          ALL,
          'starved ladder probes every bucket key (delta union = exact)',
        );
        assert.equal(probedSet.size, keysWithin(IVF_MAX_RADIUS));

        // (b) radius-1 top-10 vs exact top-10.
        const exact = store
          .scanBySimilarity({
            layer: 'semantic', space, queryVector: qv, minScore: 0, limit: 10,
          })
          .map((h) => h.item.id);
        const probedHits = store
          .scanBySimilarity({
            layer: 'semantic', space, queryVector: qv, minScore: 0, limit: 10,
            buckets: probeKeys(qv, 1),
          })
          .map((h) => h.item.id);
        assert.equal(exact.length, 10, 'corpus saturates exact top-10');
        const hit = probedHits.filter((id) => exact.includes(id)).length;
        recalls.push(hit / exact.length);
      }
      const avg = recalls.reduce((s, r) => s + r, 0) / recalls.length;
      assert.ok(
        avg >= 0.8,
        `dims ${dimensions}: radius-1 recall@10 avg ${avg.toFixed(3)}` +
          ` (${recalls.map((r) => r.toFixed(2)).join(', ')}) must be ≥ 0.8`,
      );
    });
  }
});

// ------------------------------------- G3: prior clamp + mass conservation

test('G3: buildRetrievalPrior clamps out-of-band graphBoost server-side; Σrank stays 1', (t) => {
  const store = freshStore(t, 8);
  const graph = new MemoryGraph(store, {
    enabled: true,
    maxEntities: 50,
    pagerankDamping: 0.85,
    pagerankIterations: 12,
    pagerankEdgeDecayDays: 30,
    personalizationWeight: 0.5,
  });

  // A small web: global-tier entities plus one user-tier pair — scoped
  // reads for an anonymous caller then see a FILTERED node set (the
  // user-tier entities and their edges drop out), exercising the
  // filter-edges-to-node-set path whose mass conservation is asserted
  // below.
  graph.ingestEntities(
    'Kafka pipelines feed the Flink jobs while Flink writes to Postgres',
    { visibility: 'global' },
  );
  graph.ingestEntities(
    'Redis caches the Postgres reads and Grafana watches Redis closely',
    { visibility: 'global' },
  );
  graph.ingestEntities(
    'Kafka Postgres Redis Grafana Flink co-occur once more for good measure',
    { visibility: 'global' },
  );
  graph.ingestEntities(
    'Alices private notes mention Postgres too',
    { visibility: 'user', userId: 'alice' },
  );

  const ids = store.listEntities(100).map((e) => e.id);
  assert.ok(ids.length >= 5, `entity web ingested (got ${ids.length})`);
  const seeds = [ids[0]!, ids[1]!];

  // Mass conservation on the unscoped graph AND on scopes whose node/edge
  // sets are filtered (anonymous → user-tier nodes + their edges dropped).
  // Edge filtering removes mass SOURCES, never mass: the kernel
  // renormalizes Σrank to 1 every iteration.
  const anonymousLevel = widestLevel(scopeLevels('session', {}));
  const aliceLevel = widestLevel(scopeLevels('session', { userId: 'alice' }));
  const levels: Array<[string, ScopeLevelClause | null]> = [
    ['unscoped', null],
    ['anonymous-scoped', anonymousLevel],
    ['alice-scoped', aliceLevel],
  ];
  for (const [label, level] of levels) {
    const ranks = graph.getRanks(level);
    assert.ok(ranks.size > 0, `nodes present (${label})`);
    let sum = 0;
    for (const v of ranks.values()) sum += v;
    assert.ok(Math.abs(sum - 1) < 1e-6, `Σrank = ${sum} ≈ 1 (${label})`);
  }
  assert.ok(
    graph.getRanks(anonymousLevel).size < graph.getRanks(null).size,
    'anonymous node set strictly smaller (edge filter really applied)',
  );

  // The clamp itself: opts.graphBoost is OUTSIDE the [0, 0.5] rail — every
  // multiplier must stay inside [1−0.5, 1+0.5]. The clamp lives in the
  // SERVICE (buildRetrievalPrior), not only in callers.
  const combos: string[][] = [[], [ids[0]!], [ids[1]!, ids[2]!], ids.slice(0, 4)];
  let sawAboveOne = false;
  for (const boost of [0.9, 5, -3]) {
    const prior = graph.buildRetrievalPrior(
      { seeds, level: null, graphBoost: 0.15, personalizationWeight: 0.5 },
      { graphBoost: boost },
    );
    for (const combo of combos) {
      const { mult } = prior(combo);
      assert.ok(
        mult >= 1 - 0.5 - 1e-9 && mult <= 1 + 0.5 + 1e-9,
        `opts.graphBoost ${boost}: mult ${mult} escaped [0.5, 1.5]`,
      );
      if (mult > 1 + 1e-9) sawAboveOne = true;
    }
  }
  assert.ok(sawAboveOne, 'clamped boost still bites (some mult > 1 — non-vacuous)');

  // params-level rail (no opts at all) is clamped server-side too.
  const priorParams = graph.buildRetrievalPrior({
    seeds,
    level: null,
    graphBoost: 0.9,
    personalizationWeight: 0.5,
  });
  for (const combo of combos) {
    const { mult } = priorParams(combo);
    assert.ok(mult <= 1 + 0.5 + 1e-9, `params.graphBoost 0.9: mult ${mult} > 1.5`);
  }

  // Out-of-band NEGATIVE boost clamps to G = 0 → identity prior.
  const identity = graph.buildRetrievalPrior(
    { seeds, level: null, graphBoost: 0.15, personalizationWeight: 0.5 },
    { graphBoost: -3 },
  );
  for (const combo of combos) {
    assert.equal(identity(combo).mult, 1, 'boost ≤ 0 after clamping → identity multiplier');
  }
});

// ------------------------------------------ G4: query-cache partitions

test('G4: cache partitions — six same-text variants never cross-hit; stableFusionKey unifies empty spellings', async (t) => {
  const store = freshStore(t, 128);
  const prov = new OfflineBM25EmbeddingProvider(128);
  const cfg: RetrieverConfig = {
    topK: 5,
    mmrLambda: 0.7,
    minScore: 0,
    rerank: true,
    graphBoost: 0.15,
    graphPersonalization: 0.5,
    decayHalfLifeDays: 365,
    scope: 'user',
    prf: { enabled: true, alpha: 0.7, beta: 0.3, depth: 3 },
    entityHop: false,
    queryCache: true,
    ivf: { enabled: true, radius: 1, minItems: 1 },
  };
  const retriever = new MemoryRetriever(store, prov, cfg);
  const scope: MemoryScope = { userId: 'alice', sessionId: 's-cache' };

  // Items carry SCALAR filterable metadata (toolName on even seq, source
  // alternating) so the filter variants below partition on real fields.
  const CONTENTS = [
    'kafka pipeline shard rollout tuning gates',
    'kafka consumer group rebalancing after failover',
    'flink checkpointing pipeline shard tuning',
    'postgres pipeline rollout gates and shard tuning',
    'sourdough bread starter feeding schedule recipe',
    'sourdough crust hydration baking recipe notes',
  ];
  let seq = 0;
  for (const content of CONTENTS) {
    seq++;
    const now = BASE_TS + seq;
    store.insertItem(
      {
        id: `cache-${seq}`,
        layer: 'semantic',
        content,
        embedding: await prov.embed(content),
        metadata: {
          source: seq % 2 === 0 ? 'tool' : 'user',
          embeddingSpace: prov.space,
          ...(seq % 2 === 0 ? { toolName: 'git' } : {}),
        },
        createdAt: now,
        updatedAt: now,
        importance: 0.5,
        accessCount: 0,
        lastAccessedAt: now,
      },
      scope,
    );
  }

  // Scalar metadata filters only: RetrievalQuery.filters is typed
  // Partial<MemoryMetadata>, whose fields are scalars (the runtime
  // passesFilters ALSO accepts an array as a membership test, but the
  // declared contract here is the scalar one).
  const QUERY = 'kafka pipeline shard rollout tuning';
  const variants: Partial<RetrievalQuery>[] = [
    {},                                            // 0: baseline
    { filters: { toolName: 'git' } },              // 1: filters A
    { filters: { source: 'tool' } },               // 2: filters B
    { fusionOverrides: { vectorWeight: 0.75 } },   // 3: fusion A
    { fusionOverrides: { graphBoost: 0.2 } },      // 4: fusion B
    { filters: { toolName: 'git' }, fusionOverrides: { graphBoost: 0.2 } }, // 5: cross
  ];

  // First pass, in order: each variant runs after earlier variants have
  // stored their entries — a cacheHit here would be a CROSS-variant hit
  // (paramsKey collision on identical query text).
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!;
    const r = await retriever.retrieve({ query: QUERY, scope, ...v });
    assert.notEqual(r.debug?.cacheHit, true, `variant ${i} first call must not cross-hit`);
  }
  // Second pass: only the SAME variant's replay may hit.
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!;
    const r = await retriever.retrieve({ query: QUERY, scope, ...v });
    assert.equal(r.debug?.cacheHit, true, `variant ${i} replay must hit its own partition`);
  }

  // stableFusionKey completeness: "no overrides" has three spellings —
  // undefined, {}, and an all-undefined map. One effective config, ONE
  // cache partition: each later spelling must HIT the first one's entry.
  const QUERY2 = 'sourdough bread starter feeding schedule';
  const r1 = await retriever.retrieve({ query: QUERY2, scope });
  assert.notEqual(r1.debug?.cacheHit, true, 'fresh query text starts cold');
  const r2 = await retriever.retrieve({ query: QUERY2, scope, fusionOverrides: {} });
  assert.equal(r2.debug?.cacheHit, true, '{} ≡ undefined (one partition)');
  const r3 = await retriever.retrieve({
    query: QUERY2,
    scope,
    fusionOverrides: { prfAlpha: undefined },
  });
  assert.equal(r3.debug?.cacheHit, true, '{prfAlpha: undefined} ≡ undefined (one partition)');
});
