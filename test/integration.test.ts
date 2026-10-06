/**
 * End-to-end test of the Memory Palace plugin.
 *
 * Boots the plugin with a mock Cordis context, simulates a session with
 * user / assistant / tool events, asserts that:
 *  - messages become episodic events + semantic items
 *  - retrieval returns relevant hits
 *  - context injection produces a non-empty block within budget
 *  - graph extracts entities; PageRank mass is conserved
 *  - compression removes low-importance items
 *  - scope filtering isolates users' memories
 *  - the fifteen model tools register and run
 *  - lifecycle events flow through the bus to the kernel
 *
 * Every subtest installs the plugin against its OWN throwaway database
 * (freshDb) whose directory is removed when the subtest ends, and every
 * install registers a hook closing the better-sqlite3 store so no WAL
 * handle leaks across subtests. Each subtest therefore ingests exactly
 * the data its own assertions need — no cross-subtest accumulation, and
 * the file is order-independent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

test('Memory Palace end-to-end', async (t) => {
  /** A brand-new temporary database path, cleaned up after the subtest. */
  const freshDb = (t: AfterHooks): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, 'memory.db');
  };

  /**
   * Install the plugin against a fresh, subtest-private database.
   *
   * node:test runs t.after hooks first-registered-first-run, and rmSync
   * cannot remove a directory that still holds an open better-sqlite3
   * WAL handle on Windows — so the store-close hook MUST be registered
   * before freshDb() registers the directory removal (close → rm).
   */
  const install = (t: AfterHooks, opts: Record<string, unknown> = {}) => {
    // Hook ORDER is the whole game on Windows: the store close must be
    // registered BEFORE freshDb's tmpdir rm (hooks run in registration
    // order), or rmSync hits the open WAL handle (EPERM). ctx is created
    // up front so the close hook can capture it directly.
    const ctx = createMockContext();
    t.after(() => {
      const store = ctx.services.get('memory-store') as { close(): void } | undefined;
      try {
        store?.close();
      } catch {
        // store already closed — nothing to do
      }
    });
    const dbPath = freshDb(t);
    MemoryPalacePlugin(ctx as never, {
      storagePath: dbPath,
      embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
      ...opts,
    });
    return ctx;
  };

  await t.test('plugin installs and registers all services', (t) => {
    const ctx = install(t, { scope: 'user' });

    const expected = [
      'memory-store',
      'memory-ingestor',
      'memory-retriever',
      'memory-compressor',
      'memory-graph',
      'context-injector',
      'memory-palace',
    ];
    for (const name of expected) {
      assert.ok(ctx.services.has(name), `service ${name} should be registered`);
    }
  });

  await t.test('ingestMessage stores episodic + semantic items', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;

    const result = await palace.ingestor.ingestMessage({
      role: 'user',
      content:
        'Remember that the API uses PostgreSQL 16 with pgvector. The repository is at github.com/acme/api and the deployment runs on Kubernetes 1.30.',
      sessionId: 'sess-1',
      userId: 'u-1',
    });

    assert.ok(result.eventId, 'eventId returned');
    assert.ok(result.semanticIds.length > 0, 'at least one semantic item created');

    const stats = palace.store.stats();
    // The episodic footprint of an ingested message is the episodic_event
    // row (memory items are semantic-layer), so the episodic count to
    // assert is stats.events — items.episodic stays 0 by design.
    assert.ok(stats.events >= 1, 'episodic event stored');
    assert.ok(stats.items.semantic >= 1, 'semantic items stored');
    // Every item must be space-tagged for multi-space retrieval.
    assert.ok(Object.keys(stats.spaces).length >= 1, 'embedding spaces reported');
  });

  await t.test('retrieve returns relevant hits', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;

    // New-semantics note (post-audit round): message→semantic candidacy is
    // now token-gated (chunker minTokens=16 — the old 82-char sentence
    // counted ~15 tokens and produced NO semantic item), and writes resolve
    // privacy-first to the narrowest owned tier (a message carrying a
    // sessionId lands at session tier). Content lengthened past the gate
    // and the retrieval carries the same session — intent unchanged.
    await palace.ingestor.ingestMessage({
      role: 'user',
      content:
        'Project Phoenix uses PostgreSQL 16 with pgvector for similarity search in production, and the API lives at github.com/acme/phoenix with full documentation in the team wiki.',
      sessionId: 'sess-2',
      userId: 'u-1',
    });
    await palace.ingestor.ingestMessage({
      role: 'assistant',
      content:
        'Understood. I will use Postgres 16 with pgvector for the vector store and reference the github.com/acme/phoenix repo for context, and I will keep the deployment notes updated in the wiki.',
      sessionId: 'sess-2',
      userId: 'u-1',
    });

    const result = await palace.retriever.retrieve({
      query: 'How do we deploy Phoenix?',
      topK: 5,
      scope: { userId: 'u-1', sessionId: 'sess-2' },
    });
    assert.ok(result.hits.length > 0, 'retrieval produced hits');
    assert.ok(result.totalTokens > 0, 'token budget counted');
    assert.ok(
      result.hits.some((h: any) => /Postgres|pgvector/i.test(h.item.content)),
      'retrieval surfaces Postgres/pgvector facts',
    );
  });

  await t.test('graph extracts entities and PageRank mass is conserved', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;

    await palace.ingestor.ingestMessage({
      role: 'user',
      content:
        'Check src/services/memory-store.ts and update @alice about #postgres on https://example.com/docs.',
      sessionId: 'sess-3',
      userId: 'u-1',
    });

    const stats = palace.graph.stats();
    assert.ok(stats.entities > 0, 'graph has entities');
    assert.ok(
      stats.topEntities.some((e: any) => e.name.includes('memory-store')),
      'file path extracted',
    );

    const ranks = palace.graph.getRanks();
    assert.ok(ranks.size > 0, 'ranks computed');
    let mass = 0;
    for (const v of ranks.values()) mass += v;
    assert.ok(Math.abs(mass - 1) < 0.05, `PageRank mass ≈ 1, got ${mass}`);
  });

  await t.test('user mentions are typed as persons via extraction hints', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;
    await palace.ingestor.ingestMessage({
      role: 'user',
      content: 'Please sync with @bob and @carol about the migration plan tomorrow.',
      sessionId: 'sess-hint',
      userId: 'u-1',
    });
    const bob = palace.store.findEntityByName('bob');
    assert.ok(bob, 'handle stored without @ prefix');
    assert.equal(bob.type, 'person', 'handle classified as person via hint');
  });

  await t.test('scope filtering isolates users', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = ctx.services.get('memory-palace') as any;

    await palace.ingestor.ingestUserMemory({
      content: 'The Aurora project uses Redis for caching sessions.',
      userId: 'u-a',
      importance: 0.9,
    });
    await palace.ingestor.ingestUserMemory({
      content: 'The Borealis project uses Neo4j for graph storage.',
      userId: 'u-b',
      importance: 0.9,
    });

    const asA = await palace.retriever.retrieve({
      query: 'Borealis Neo4j graph storage',
      scope: { userId: 'u-a' },
    });
    for (const h of asA.hits) {
      assert.ok(
        !/Borealis|Neo4j/.test(h.item.content),
        `u-a must not see u-b memories, saw: ${h.item.content.slice(0, 60)}`,
      );
    }

    const asB = await palace.retriever.retrieve({
      query: 'Borealis Neo4j graph storage',
      scope: { userId: 'u-b' },
    });
    assert.ok(
      asB.hits.some((h: any) => /Borealis|Neo4j/.test(h.item.content)),
      'u-b sees their own memories',
    );
  });

  await t.test('context injector builds prompt block under budget', async (t) => {
    const ctx = install(t, {
      injection: { enabled: true, maxTokens: 200, systemPromptPrefix: 'memory on', scope: 'user' } as any,
    });
    const palace = ctx.services.get('memory-palace') as any;

    await palace.ingestor.ingestUserMemory({
      content: 'The user prefers TypeScript over JavaScript.',
      importance: 0.9,
      tags: ['preference'],
      userId: 'u-1',
    });
    await palace.ingestor.ingestUserMemory({
      content: 'Always use PostgreSQL 16 with pgvector for new projects.',
      importance: 0.95,
      tags: ['stack'],
      userId: 'u-1',
    });

    const out = await palace.injector.inject({
      sessionId: 'sess-4',
      intent: 'What stack should I use for a new project?',
      userId: 'u-1',
    });
    assert.ok(out.systemPromptAddition.includes('PostgreSQL'), 'system prompt mentions stack');
    assert.ok(out.retrievedItemIds.length > 0, 'items retrieved');
    assert.ok(out.budgetUsed > 0, 'budget consumed');
    assert.ok(out.budgetUsed <= 200 + 50, 'within budget with prefix headroom');
  });

  await t.test('compressor evicts low-importance old items', async (t) => {
    const ctx = install(t, {
      compression: {
        enabled: true,
        triggerCount: 100,
        importanceThreshold: 0.5,
        decayHalfLifeDays: 7,
      } as any,
    });
    const palace = ctx.services.get('memory-palace') as any;

    // Add one very important and one unimportant item
    await palace.ingestor.ingestUserMemory({
      content: 'Critical: production database URL is secret://prod-db',
      importance: 0.99,
      userId: 'u-2',
    });
    await palace.ingestor.ingestUserMemory({
      content: 'minor: tried a recipe last week',
      importance: 0.1,
      userId: 'u-2',
    });

    // Manually backdate the unimportant item
    const allItems = palace.store.listItemsByLayer('semantic', 100);
    const minor = allItems.find((i: any) => i.content.startsWith('minor:'));
    assert.ok(minor, 'minor item exists');
    const store = palace.store;
    (store as any).db
      .prepare('UPDATE memory_items SET created_at = ? WHERE id = ?')
      .run(Date.now() - 30 * 86_400_000, minor.id);

    const beforeStats = store.stats();
    const removed = palace.compressor.evict({ limit: 50 });
    const afterStats = store.stats();

    assert.ok(removed >= 1, `evicted at least 1 item, got ${removed}`);
    assert.ok(
      afterStats.items.semantic < beforeStats.items.semantic,
      'item count decreased',
    );
  });

  await t.test('model tools register and run end-to-end', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;

    assert.equal(ctx.tools.length, 15, 'fifteen tools registered');
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    for (const name of [
      'memory_retrieve',
      'memory_remember',
      'memory_forget',
      'memory_inspect',
      'memory_graph',
    ]) {
      assert.ok(byName.has(name), `tool ${name} present`);
    }

    const tctx = { sessionId: 'sess-tools', userId: 'u-tools' };
    const remember = byName.get('memory_remember');
    const { id } = (await remember.run(
      { content: 'ToolTest stores credentials in environment variables.', importance: 0.9 },
      tctx,
    )) as { id: string };
    assert.ok(id, 'memory_remember returns id');

    const retrieve = byName.get('memory_retrieve');
    const res = (await retrieve.run({ query: 'Where does ToolTest keep credentials?' }, tctx)) as any;
    assert.ok(res.hits.length > 0, 'memory_retrieve finds the stored fact');
    assert.ok(
      res.hits.some((h: any) => /ToolTest/.test(h.content)),
      'hit content echoes the remembered fact',
    );
    assert.ok(
      res.hits.every((h: any) => typeof h.explain === 'object'),
      'every hit carries a score decomposition',
    );

    const graph = byName.get('memory_graph');
    const g = (await graph.run({ mode: 'expand', entity: 'ToolTest' }, tctx)) as any;
    assert.ok(g.subgraph.includes('ToolTest'), 'memory_graph expands the entity');

    const inspect = byName.get('memory_inspect');
    const insp = (await inspect.run({}, tctx)) as any;
    assert.ok(insp.stats && insp.stats.items, 'memory_inspect returns stats');
    assert.ok(typeof insp.health.rankGini === 'number', 'health panel present');
    assert.ok(Array.isArray(insp.recommendations), 'recommendations present');

    const forget = byName.get('memory_forget');
    const dry = (await forget.run({ id, dryRun: true }, tctx)) as any;
    assert.equal(dry.dryRun, true, 'dryRun previews without deleting');
    assert.ok(palace.store.getItem(id), 'item still present after dryRun');

    const del = (await forget.run({ id }, tctx)) as any;
    assert.equal(del.forgotten, 1, 'memory_forget tombstones by id');
    assert.ok(!palace.store.listItemsByLayer('semantic', 500).some((i: any) => i.id === id), 'tombstoned item hidden from reads');

    const restored = (await forget.run({ id, restore: true }, tctx)) as any;
    assert.equal(restored.restored, true, 'restore undoes the tombstone');
    assert.ok(palace.store.getItem(id), 'restored item readable again');
  });

  await t.test('memory_remember dedupes and supersedes conflicts', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const remember = byName.get('memory_remember');
    const tctx = { sessionId: 'sess-dedupe', userId: 'u-dedupe' };

    const first = (await remember.run(
      { content: 'The Colossus project runs PostgreSQL 16 in production.', importance: 0.9 },
      tctx,
    )) as any;
    assert.equal(first.deduplicated, false, 'first store is fresh');

    const dup = (await remember.run(
      { content: 'The Colossus project runs PostgreSQL 16 in production.', importance: 0.9 },
      tctx,
    )) as any;
    assert.equal(dup.deduplicated, true, 'exact duplicate detected');
    assert.equal(dup.id, first.id, 'duplicate returns the existing id');

    const updated = (await remember.run(
      { content: 'The Colossus project runs PostgreSQL 17 in production.', importance: 0.9, supersede: true },
      tctx,
    )) as any;
    assert.ok(Array.isArray(updated.conflicts) && updated.conflicts.length > 0,
      'version change flagged as conflict');
    assert.ok(updated.superseded && updated.superseded.includes(first.id),
      'outdated memory superseded');

    const live = palace.store.listItemsByLayer('semantic', 500).filter(
      (i: any) => i.metadata.userId === 'u-dedupe',
    );
    assert.ok(
      !live.some((i: any) => i.content.includes('PostgreSQL 16')),
      'superseded v16 memory hidden from reads',
    );
    assert.ok(live.some((i: any) => i.content.includes('PostgreSQL 17')), 'v17 memory live');
  });

  await t.test('retrieve understands temporal queries and synthesizes consensus', async (t) => {
    const ctx = install(t);
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const retrieve = byName.get('memory_retrieve');
    const remember = byName.get('memory_remember');
    const tctx = { sessionId: 'sess-synth', userId: 'u-synth' };

    await remember.run(
      { content: 'Deploy checklist: run migrations before rolling out the API.', importance: 0.9 },
      tctx,
    );
    await remember.run(
      { content: 'Deploy note: migrations must run before API rollout, always.', importance: 0.85 },
      tctx,
    );

    const res = (await retrieve.run(
      { query: 'what did we say recently about deployments? top 5', mode: 'synthesis' },
      tctx,
    )) as any;
    assert.ok(res.queryUnderstanding.wantsRecent, 'temporal idiom detected');
    assert.equal(res.queryUnderstanding.sinceMs !== undefined, true, 'since window resolved');
    assert.ok(Array.isArray(res.clusters) && res.clusters.length > 0, 'synthesis clusters built');
    const top = res.clusters[0];
    assert.ok(top.agreement > 0 && top.size >= 1, 'cluster graded');
    assert.equal(top.conflict, false, 'corroborating statements are not conflicts');
  });

  await t.test('graph path and communities modes work', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const graph = byName.get('memory_graph');
    const tctx = { sessionId: 'sess-graph', userId: 'u-graph' };

    // One message's entities form a co-occurrence CLIQUE (every pair gets
    // an edge), so a multi-hop CHAIN must come from separate pairwise
    // messages: Kafka→Flink, Flink→ClickHouse, ClickHouse→Grafana.
    for (const content of [
      'Kafka feeds the Flink stream processors directly.',
      'Flink writes its results into ClickHouse clusters.',
      'ClickHouse feeds the Grafana dashboards.',
    ]) {
      await palace.ingestor.ingestUserMemory({
        content,
        userId: 'u-graph',
        importance: 0.8,
      });
    }

    const path = (await graph.run(
      { mode: 'path', entity: 'Kafka', target: 'Grafana' },
      tctx,
    )) as any;
    assert.ok(Array.isArray(path.path) && path.path.length >= 3,
      `path found through the pipeline (got ${JSON.stringify(path.path)})`);
    assert.equal(path.path[0], 'Kafka', 'path starts at source');
    assert.equal(path.path[path.path.length - 1], 'Grafana', 'path ends at target');

    const comms = (await graph.run({ mode: 'communities', limit: 5 }, tctx)) as any;
    assert.ok(comms.communities.length >= 1, 'communities detected');
    assert.ok(typeof comms.cohesion === 'number', 'cohesion reported');
  });

  await t.test('forget by entity cascades with dryRun preview', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const forget = byName.get('memory_forget');
    const tctx = { sessionId: 'sess-fe', userId: 'u-fe' };

    await palace.ingestor.ingestUserMemory({
      content: 'DruidDB is deprecated; all DruidDB usage migrates to DuckDB.',
      userId: 'u-fe',
      importance: 0.8,
    });
    // entity linked at ingest time
    assert.ok(palace.store.findEntityByName('DruidDB'), 'entity exists');

    const dry = (await forget.run({ entity: 'DruidDB', dryRun: true }, tctx)) as any;
    assert.equal(dry.dryRun, true, 'entity dryRun');
    assert.ok(palace.store.findEntityByName('DruidDB'), 'entity survives dryRun');

    const done = (await forget.run({ entity: 'DruidDB' }, tctx)) as any;
    assert.equal(done.mode, 'entity', 'entity mode');
    assert.ok(done.forgotten >= 1, `linked items tombstoned (got ${done.forgotten})`);
    assert.ok(!palace.store.findEntityByName('DruidDB'), 'entity removed from graph');

    const visible = await palace.retriever.retrieve({
      query: 'DruidDB deprecated migration',
      scope: { userId: 'u-fe' },
    });
    assert.ok(
      !visible.hits.some((h: any) => /DruidDB/.test(h.item.content)),
      'forgotten entity memories no longer retrieved',
    );
  });

  await t.test('knowledge graph is isolated per user (visibility ACL)', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = ctx.services.get('memory-palace') as any;
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const graph = byName.get('memory_graph');

    await palace.ingestor.ingestUserMemory({
      content: 'AlphaUser tracks NebulaCache for their caching layer.',
      userId: 'u-alpha',
      importance: 0.9,
    });
    await palace.ingestor.ingestUserMemory({
      content: 'BetaUser tracks QuasarQueue for their job pipeline.',
      userId: 'u-beta',
      importance: 0.9,
    });

    // Alpha's communities must not mention Beta's entities.
    const asAlpha = (await graph.run(
      { mode: 'communities', limit: 10 },
      { sessionId: 's', userId: 'u-alpha' },
    )) as any;
    const alphaNames = JSON.stringify(asAlpha.communities);
    assert.ok(alphaNames.includes('NebulaCache'), 'own entity visible');
    assert.ok(!alphaNames.includes('QuasarQueue'), "other user's entity hidden");

    // Subgraph expansion is scoped too.
    const sub = (await graph.run(
      { mode: 'expand', entity: 'QuasarQueue' },
      { sessionId: 's', userId: 'u-alpha' },
    )) as any;
    assert.ok(!sub.subgraph, "other user's entity not expandable");

    // Scoped PageRank reflects only the caller's graph.
    const levelAlpha = palace.graph.levelFor('user', { userId: 'u-alpha' });
    const ranksAlpha = palace.graph.getRanks(levelAlpha);
    const alphaIds = new Set(
      palace.store.listEntitiesScoped(levelAlpha, 100).map((e: any) => e.id),
    );
    for (const id of ranksAlpha.keys()) {
      assert.ok(alphaIds.has(id), 'ranked entities all belong to the scoped graph');
    }
  });

  await t.test('visibility tiers: global memories are shared, user memories are not', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = ctx.services.get('memory-palace') as any;
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const remember = byName.get('memory_remember');

    // New-semantics note (post-audit round): write tiers resolve
    // privacy-first — an identified caller's explicit `visibility: 'global'`
    // collapses to their narrowest owned tier, so a genuinely shared row is
    // minted from an ANONYMOUS context. The user-tier write keeps its
    // owner. Test intent (shared vs private tier) unchanged.
    await remember.run(
      { content: 'Team holiday calendar lives at calendar.example.com.', visibility: 'global' },
      {},
    );
    await remember.run(
      { content: 'SecretProject codename is FalconHeavy.',
       visibility: 'user' },
      { userId: 'u-one' },
    );

    const asOther = await palace.retriever.retrieve({
      query: 'holiday calendar team',
      scope: { userId: 'u-two' },
    });
    assert.ok(
      asOther.hits.some((h: any) => /calendar\.example\.com/.test(h.item.content)),
      'global memory visible to another user',
    );
    assert.ok(
      !asOther.hits.some((h: any) => /FalconHeavy/.test(h.item.content)),
      'user memory hidden from another user',
    );

    const anonymous = await palace.retriever.retrieve({ query: 'holiday calendar team' });
    assert.ok(
      anonymous.hits.some((h: any) => /calendar\.example\.com/.test(h.item.content)),
      'anonymous sees global tier',
    );
    assert.ok(
      !anonymous.hits.some((h: any) => /FalconHeavy/.test(h.item.content)),
      'anonymous never sees user tier',
    );
  });

  await t.test('personalized PageRank boosts graph-proximate memories', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = ctx.services.get('memory-palace') as any;
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const retrieve = byName.get('memory_retrieve');
    const tctx = { sessionId: 's-ppr', userId: 'u-ppr' };

    // Kafka—Flink—ClickHouse chain plus an unrelated Grafana memory.
    for (const content of [
      'Kafka pipeline throughput tuning notes for the ingest side.',
      'Flink pipeline throughput tuning notes for the stream side.',
      'Grafana pipeline throughput tuning notes for the dashboards.',
    ]) {
      await palace.ingestor.ingestUserMemory({
        content,
        userId: 'u-ppr',
        importance: 0.8,
      });
    }
    // Chain the entities: Kafka→Flink→ClickHouse (Grafana stays isolated).
    await palace.ingestor.ingestUserMemory({
      content: 'Kafka feeds Flink and Flink writes into ClickHouse clusters.',
      userId: 'u-ppr',
      importance: 0.8,
    });

    const res = (await retrieve.run(
      { query: 'Kafka pipeline throughput tuning', topK: 10 },
      tctx,
    )) as any;
    assert.ok(res.hits.length >= 3, `hits returned (${res.hits.length})`);

    const multOf = (needle: string) =>
      res.hits.find((h: any) => h.content.includes(needle))?.explain?.graph ?? 0;
    const kafkaMult = multOf('Kafka');
    const flinkMult = multOf('Flink');
    const grafanaMult = multOf('Grafana');
    assert.ok(kafkaMult > grafanaMult, `seed entity outranks isolated (k=${kafkaMult} g=${grafanaMult})`);
    assert.ok(flinkMult > grafanaMult, `graph-proximate outranks isolated (f=${flinkMult} g=${grafanaMult})`);

    const entity = res.hits.find((h: any) => h.content.includes('Kafka'))?.explain?.graphEntity;
    assert.ok(entity && entity.entityName === 'Kafka', 'explain names the ranking entity');
    assert.ok(entity.proximityRank !== undefined && entity.proximityRank > 0, 'PPR proximity reported');
  });

  await t.test('as-of flashback reconstructs superseded beliefs', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const remember = byName.get('memory_remember');
    const retrieve = byName.get('memory_retrieve');
    const tctx = { sessionId: 's-flash', userId: 'u-flash' };

    await remember.run(
      { content: 'The Aurora stack runs PostgreSQL 16 in production.', importance: 0.9 },
      tctx,
    );
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await remember.run(
      { content: 'The Aurora stack runs PostgreSQL 17 in production.', importance: 0.9, supersede: true },
      tctx,
    );

    const past = (await retrieve.run(
      { query: 'Aurora stack PostgreSQL production', topK: 5, asOf: before },
      tctx,
    )) as any;
    assert.ok(
      past.hits.some((h: any) => /PostgreSQL 16/.test(h.content)),
      'flashback before the supersede sees v16',
    );
    assert.ok(
      !past.hits.some((h: any) => /PostgreSQL 17/.test(h.content)),
      'flashback hides the not-yet-created v17',
    );

    const nowView = (await retrieve.run(
      { query: 'Aurora stack PostgreSQL production', topK: 5, minScore: 0.05 },
      tctx,
    )) as any;
    assert.ok(
      nowView.hits.some((h: any) => /PostgreSQL 17/.test(h.content)),
      'current view sees v17',
    );
    assert.ok(
      !nowView.hits.some((h: any) => /PostgreSQL 16/.test(h.content)),
      'current view hides superseded v16',
    );
  });

  await t.test('entity-hop recall surfaces same-topic different-wording memories', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = ctx.services.get('memory-palace') as any;
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const retrieve = byName.get('memory_retrieve');
    const tctx = { sessionId: 's-hop', userId: 'u-hop' };

    await palace.ingestor.ingestUserMemory({
      content: 'Kafka throughput tuning requires partition rebalancing first.',
      userId: 'u-hop',
      importance: 0.9,
    });
    await palace.ingestor.ingestUserMemory({
      content: 'Kafka consumer lag runbook: restart the offset watcher daemon.',
      userId: 'u-hop',
      importance: 0.9,
    });

    // High minScore keeps the runbook out of the vector pool (it shares
    // only the token "kafka" with the query); the hop pass must recall it.
    const res = (await retrieve.run(
      { query: 'Kafka throughput tuning partition', topK: 5, minScore: 0.4 },
      tctx,
    )) as any;
    const runbook = res.hits.find((h: any) => /runbook/.test(h.content));
    assert.ok(runbook, 'hop expansion recalled the differently-worded runbook');
    assert.equal(runbook.via, 'entity-hop', 'hit labeled as entity-hop');
    assert.ok(res.pipeline && res.pipeline.entityHop >= 1, 'pipeline debug reports the hop');
    const tuning = res.hits.find((h: any) => /throughput tuning/.test(h.content));
    assert.equal(tuning?.via, 'vector', 'vector hit labeled as vector');
  });

  await t.test('semantic query cache serves near-duplicate questions', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;
    const byName = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    const retrieve = byName.get('memory_retrieve');
    const tctx = { sessionId: 's-cache', userId: 'u-cache' };

    await palace.ingestor.ingestUserMemory({
      content: 'CacheTest stores feature flags in the flagservice backend.',
      userId: 'u-cache',
      importance: 0.9,
    });

    const q1 = 'Where does CacheTest keep feature flags?';
    const r1 = (await retrieve.run({ query: q1, topK: 5 }, tctx)) as any;
    assert.ok(r1.hits.length > 0, 'first query returns hits');
    assert.ok(!r1.pipeline?.cacheHit, 'first query is a cache miss');

    const r2 = (await retrieve.run({ query: q1, topK: 5 }, tctx)) as any;
    assert.ok(r2.pipeline?.cacheHit, 'identical query served from cache');
    assert.equal(r2.hits.length, r1.hits.length, 'same result shape');

    const r3 = (await retrieve.run({ query: q1, topK: 10 }, tctx)) as any;
    assert.ok(!r3.pipeline?.cacheHit, 'different params bypass the cache');
  });


  await t.test('capsule export/import roundtrip between two palaces', async (t) => {
    const ctxA = install(t, { scope: 'user' });
    const ctxB = install(t, { scope: 'user' });
    const palaceA = ctxA.services.get('memory-palace') as any;
    const palaceB = ctxB.services.get('memory-palace') as any;
    const toolsA = new Map(ctxA.tools.map((tool: any) => [tool.name, tool]));
    const toolsB = new Map(ctxB.tools.map((tool: any) => [tool.name, tool]));

    await palaceA.ingestor.ingestUserMemory({
      content: 'The Helios mesh uses Envoy sidecars for traffic routing.',
      userId: 'u-a',
      importance: 0.9,
    });
    await palaceA.ingestor.ingestUserMemory({
      content: 'Helios canary releases are gated on SLO burn rate checks.',
      userId: 'u-a',
      importance: 0.85,
    });

    const exported = (await toolsA.get('memory_capsule_export')!.run(
      { query: 'Helios', topK: 5, secret: 'team-secret' },
      { sessionId: 's', userId: 'u-a' },
    )) as any;
    assert.ok(exported.items >= 1, 'exported at least one item');
    assert.ok(exported.signed, 'capsule signed');
    assert.ok(!exported.capsuleJson.includes('u-a'), 'owner identity stripped');

    const imported = (await toolsB.get('memory_capsule_import')!.run(
      { capsule: exported.capsuleJson, secret: 'team-secret' },
      { sessionId: 's', userId: 'u-b' },
    )) as any;
    assert.ok(imported.inserted >= 1, 'items imported into palace B');
    assert.equal(imported.duplicates, 0, 'fresh palace has no duplicates');

    const again = (await toolsB.get('memory_capsule_import')!.run(
      { capsule: exported.capsuleJson, secret: 'team-secret' },
      { sessionId: 's', userId: 'u-b' },
    )) as any;
    assert.equal(again.inserted, 0, 'second import dedupes');
    assert.ok(again.duplicates >= 1, 'duplicates reported');

    const found = await palaceB.retriever.retrieve({
      query: 'Helios mesh Envoy traffic routing',
      // New-semantics note (post-audit round): capsule imports resolve
      // their tier privacy-first through the IMPORTER's scope — importing
      // from a session-bearing tool context lands the items at that
      // session tier, so the follow-up read carries the same session.
      scope: { userId: 'u-b', sessionId: 's' },
    });
    assert.ok(
      found.hits.some((h: any) => /Envoy/.test(h.item.content)),
      'imported knowledge is retrievable in palace B',
    );
  });

  await t.test('reflection reports a measurable benchmark', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;
    const tools = new Map(ctx.tools.map((tool: any) => [tool.name, tool]));
    for (let i = 0; i < 8; i++) {
      await palace.ingestor.ingestUserMemory({
        content: 'BenchFact ' + i + ' covers distributed tracing with OpenTelemetry collectors in region ' + (i % 3) + '.',
        userId: 'u-r',
        importance: 0.8,
      });
    }
    const report = (await tools.get('memory_reflect')!.run(
      { maxEntries: 8 },
      { sessionId: 's', userId: 'u-r' },
    )) as any;
    assert.ok(report.entries >= 5, 'benchmark built from stored items');
    assert.ok(typeof report.current.mrr === 'number' && typeof report.best.mrr === 'number', 'sweeps measured');
    assert.ok(typeof report.recommendation === 'string' && report.recommendation.length > 0, 'recommendation present');
  });

  await t.test('lifecycle events flow through the bus to the kernel', async (t) => {
    const ctx = install(t);
    const palace = ctx.services.get('memory-palace') as any;

    await palace.ingestor.ingestUserMemory({
      content: 'Eventflow checks that store events reach the Cordis kernel.',
      userId: 'u-ev',
    });
    const namesAfterIngest = new Set(ctx.emittedEvents.map((e) => e.name));
    assert.ok(namesAfterIngest.has('memory.before-store'), 'before-store emitted');
    assert.ok(namesAfterIngest.has('memory.after-store'), 'after-store emitted');

    await palace.retriever.retrieve({ query: 'eventflow', scope: { userId: 'u-ev' } });
    // Snapshot AFTER retrieve — the earlier set predates the events.
    const names = new Set(ctx.emittedEvents.map((e) => e.name));
    assert.ok(names.has('memory.before-retrieve'), 'before-retrieve emitted');
    assert.ok(names.has('memory.after-retrieve'), 'after-retrieve emitted');
  });

  await t.test('facade.remember writes with explicit identity', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = ctx.services.get('memory-palace') as any;

    // The facade used to offer no identity on writes at all (everything
    // went down the anonymous write-policy path); the scoped opt is the
    // write-side mirror of facade.retrieve's scope shape.
    const id = await palace.remember(
      'FacadeUser rotates the staging credentials every Friday afternoon.',
      { userId: 'u-facade' },
    );
    assert.ok(id, 'facade.remember returns the stored item id');

    const row = palace.store.getItem(id);
    assert.ok(row, 'stored row readable through the facade store');
    assert.equal(row.visibility, 'user', 'visibility tier resolves to user');
    assert.equal(row.userId, 'u-facade', 'owner column carries the explicit identity');
  });

  await t.test('stratify runs with graph-wired hot entities', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = ctx.services.get('memory-palace') as any;

    // One entity (Aurora) mentioned many times so the graph accumulates
    // rank mass — the wiring under test consults those ranks during
    // stratification. The SAME session id rides into stratify so the
    // widest cumulative level covers the (session-tier) semantic item the
    // message produced. Deliberately weak assertion: the point is that
    // the newly wired hot-entity path does not crash and nodes still
    // build, not that the +0.15 salience boost moves any specific line.
    await palace.ingestor.ingestMessage({
      role: 'user',
      content:
        'Aurora update: the Aurora cluster now replicates to the Aurora standby in eu-west. ' +
        'The Aurora cutover follows the Aurora health checks, and the Aurora rollback plan ' +
        'was signed off by the Aurora owners this morning.',
      sessionId: 'sess-strat',
      userId: 'u-strat',
    });

    const report = await palace.stratifier.stratify({
      userId: 'u-strat',
      sessionId: 'sess-strat',
    });
    assert.ok(report.nodesBuilt >= 1, 'stratify builds nodes through the wired graph path');
  });
});
