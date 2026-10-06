/**
 * METAMORPHIC RELATION tests for the Memory Palace plugin.
 *
 * These tests deliberately do NOT pin absolute outputs. They verify
 * RELATIONS BETWEEN operations: apply a follow-up operation to a system
 * whose behavior was just observed, then assert how the output must
 * transform. Metamorphic testing catches regressions an oracle-less
 * system cannot pin down — retrieval ranking, cache invalidation and
 * consolidation have no "correct" absolute answer, but their RESPONSE to
 * controlled inputs is a contract.
 *
 *   R1 遗忘消失 (forget vanishes) — after a real forget(id), the deleted
 *      id never reappears for the same scope/query, and no OTHER id
 *      disappears with it. Catches: right-to-be-forgotten regressions,
 *      tombstone filters leaking into LIVE reads, deletes corrupting
 *      sibling rows' visibility.
 *
 *   R2 重复不变 top1 (near-duplicate injection stability) — injecting a
 *      ~0.8-similar copy of the current top1 (below the 0.92 write-time
 *      dedupe merge, verified as a precondition) must keep top1 ∈
 *      {old top1, new item} and keep the original top3 set inside the new
 *      top4 set. Catches: ranking collapse under duplicate injection —
 *      copies evicting established hits, MMR/rerank destabilized by clones.
 *
 *   R3 作用域单调收缩 (scope monotone shrink) — for the same store and
 *      query, the hit-id set of a caller with ALL ids ⊇ the set of the
 *      same caller minus workspaceId ⊇ the anonymous caller's set.
 *      Catches: ACL widening leaks — an identity REDUCTION may never
 *      INCREASE what is visible. The three queries use different scopes →
 *      different query-cache paramsKeys, so they cannot cross-serve.
 *
 *   R4 版本戳写增读不变 (dataVersion: writes bump, reads do not) — a
 *      deterministic 20-op random mix (retrieve / remember / forget /
 *      forget dryRun): every real write strictly increases
 *      store.dataVersion(), every pure read leaves it unchanged
 *      (touchAccess / logQuery are documented non-bumping exceptions —
 *      the retrieve path asserts exactly that). Catches: silent writes on
 *      read paths (cache permanently invalidated) and lost write stamps
 *      (stale caches served after mutations).
 *
 *   R5 as-of 可见集单调 (as-of visible set evolves only by add/remove) —
 *      with writes and one deletion per epoch (t1<t2<t3), the LIVE set
 *      reconstructed by store.scanBySimilarity asOf=t must equal the
 *      previous set + items added since − items deleted since. Catches:
 *      FLASHBACK reconstruction leaking future rows, dropping past ones,
 *      or resurrecting tombstones at the wrong instant.
 *
 *   R6 胶囊幂等导入 (capsule idempotent import) — importing the SAME
 *      capsule twice inserts everything once: second pass inserted=0,
 *      duplicates>0, and the store's live item count increases by exactly
 *      the first pass's inserted. Catches: double-import cloning rows /
 *      dedupe swallowing legitimate fresh entries.
 *
 *   R7 检索强化有界 (bounded testing-effect reinforcement) — the same
 *      query retrieved 10× (same scope; distinct topK per call bypasses
 *      the query-cache paramsKey so every call runs the real pipeline)
 *      reinforces the hit monotonically: importance never decreases,
 *      never exceeds the 0.95 cap, and accessCount grows by exactly +10.
 *      Catches: runaway reinforcement, cap violations, cache hits
 *      swallowing access accounting.
 *
 *   R8 压缩保内容 (distillation preserves content + tombstone flashback) —
 *      a distill pass over a mergeable pair produces a merged item whose
 *      content carries BOTH members' distinguishing keywords (default
 *      concatenation path); both members vanish from LIVE reads but stay
 *      retrievable via asOf=before-merge (tombstone FLASHBACK). Catches:
 *      lossy consolidation, hard-delete destroying flashback lineage.
 *
 * Assembly follows integration.test.ts / chaos.test.ts: every subtest
 * installs the plugin against its OWN throwaway SQLite database, the
 * store-close hook is registered BEFORE the tempdir removal hook (Windows
 * WAL: rmSync cannot remove a directory holding an open WAL handle), and
 * all randomness flows from a fixed-seed mulberry32 PRNG. No Date.now()
 * participates in an assertion except strict ORDERING, enforced by real
 * sleeps between epochs. No .skip, no network — offline-bm25 embeddings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';
import { scopeLevels, widestLevel } from '../src/utils/scope.ts';

// ── Shared harness ───────────────────────────────────────────────────────────

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

/** Deterministic PRNG (same algorithm as chaos.test.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Real (small) sleep so DB-registered timestamps strictly order. */
const sleep = (ms = 8): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Install the plugin against a fresh, subtest-private database.
 *
 * Windows hook order: the store close must be registered BEFORE freshDb's
 * tempdir rm (node:test runs after-hooks first-registered-first-run), or
 * rmSync fights the open better-sqlite3 WAL handle (EPERM).
 */
const install = (t: AfterHooks, opts: Record<string, unknown> = {}) => {
  const ctx = createMockContext();
  t.after(() => {
    const store = ctx.services.get('memory-store') as { close(): void } | undefined;
    try {
      store?.close();
    } catch {
      /* already closed — nothing to do */
    }
  });
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-meta-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'meta.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
};

/** Tool-name → definition map off a mock context. */
const toolMap = (ctx: ReturnType<typeof createMockContext>) =>
  new Map((ctx.tools as unknown as Array<{ name: string; run: (input: any, tctx: any) => Promise<any> }>).map((x) => [x.name, x]));

/** The palace facade service. */
const palaceOf = (ctx: ReturnType<typeof createMockContext>) =>
  ctx.services.get('memory-palace') as any;

/**
 * LIVE-visible item-id set for a user at an optional past instant, via the
 * store's own similarity scan (minScore 0 + large limit ⇒ the FULL visible
 * set for the layer/space/scope, not a relevance-filtered one).
 */
const scanVisibleIds = async (
  palace: any,
  userId: string,
  asOfMs: number | undefined,
  query: string,
): Promise<Set<string>> => {
  const space = palace.store.listEmbeddingSpaces()[0] as string;
  const vec = await palace.embedder.embedIn(space, query);
  assert.ok(vec, 'offline embedder must produce a query vector');
  const level = widestLevel(scopeLevels('user', { userId }));
  const hits = palace.store.scanBySimilarity({
    layer: 'semantic',
    space,
    queryVector: vec,
    minScore: 0,
    limit: 500,
    ...(asOfMs !== undefined ? { asOfMs } : {}),
    scope: level,
  }) as Array<{ item: { id: string } }>;
  return new Set(hits.map((h) => h.item.id));
};

const idsOfToolHits = (res: any): string[] => res.hits.map((h: any) => h.id as string);

// ── The eight relations ──────────────────────────────────────────────────────

test('metamorphic relations: operation-to-operation contracts', async (t) => {
  await t.test('R1 forget vanishes: deleted id never returns, no collateral loss', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const tools = toolMap(ctx);
    const tctx = { userId: 'u-r1' };
    const remember = tools.get('memory_remember')!;
    const retrieve = tools.get('memory_retrieve')!;
    const forget = tools.get('memory_forget')!;

    // Preconditions: five distinguishable items on one topic, all live.
    const contents = [
      'Orca cluster sizing: each orca node handles two thousand concurrent sessions at peak evening load.',
      'Orca cluster upgrades require draining orca connections before swapping the coordinator version.',
      'Orca cluster monitoring tracks orca queue depth and drop rate per region in real time.',
      'Orca cluster backups snapshot the orca state store every six hours to cold storage.',
      'Orca cluster failover moves orca leadership to the standby region within thirty seconds.',
    ];
    const ids: string[] = [];
    for (const content of contents) {
      const r = (await remember.run({ content, importance: 0.9 }, tctx)) as { id: string };
      assert.equal(r.id && true, true, 'remember returns an id');
      ids.push(r.id);
    }
    const victim = ids[2]!; // the monitoring item

    // Baseline observation A: same scope, same query, full window.
    const query = 'orca cluster operations';
    const before = (await retrieve.run({ query, topK: 10, minScore: 0.05 }, tctx)) as any;
    const beforeIds = idsOfToolHits(before);
    assert.equal(new Set(beforeIds).size, 5, `all five items hit (got ${beforeIds.length})`);
    assert.deepEqual(new Set(beforeIds), new Set(ids), 'hit ids are exactly the written ids');

    // Baseline observation B: the victim is retrievable by ITS marker, so its
    // later absence is meaningful (not a scoring artifact).
    const victimQuery = 'orca queue depth drop rate monitoring region';
    const victimBefore = (await retrieve.run({ query: victimQuery, topK: 5, minScore: 0.05 }, tctx)) as any;
    assert.equal(idsOfToolHits(victimBefore)[0], victim, 'victim is top1 for its marker query');

    // Follow-up operation: real (non-dryRun) forget by id.
    const del = (await forget.run({ id: victim }, tctx)) as any;
    assert.equal(del.forgotten, 1, 'forget reports exactly one deletion');

    // Relation: deleted id NEVER appears; every other id survives.
    const after = (await retrieve.run({ query, topK: 10, minScore: 0.05 }, tctx)) as any;
    const afterIds = idsOfToolHits(after);
    assert.ok(
      !afterIds.includes(victim),
      `deleted id ${victim} must never appear in hits after forget`,
    );
    const expectedSurvivors = new Set(ids.filter((id) => id !== victim));
    assert.deepEqual(
      new Set(afterIds),
      expectedSurvivors,
      'survivor hit set is exactly the old set minus the deleted id (reordering allowed, membership not)',
    );

    // "Never" also holds for the victim's own marker query.
    const victimAfter = (await retrieve.run({ query: victimQuery, topK: 5, minScore: 0.05 }, tctx)) as any;
    assert.ok(
      !idsOfToolHits(victimAfter).includes(victim),
      'deleted id stays invisible under its strongest-matching query too',
    );
  });

  await t.test('R2 near-duplicate injection: top3 ⊆ new top4, top1 stays {X, new}', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const tools = toolMap(ctx);
    const tctx = { userId: 'u-r2' };
    const remember = tools.get('memory_remember')!;
    const retrieve = tools.get('memory_retrieve')!;
    const palace = palaceOf(ctx);

    const originals = [
      'Zephyr canary deploy checklist: run database migrations, bump the service version, then ramp canary traffic to ten percent before full rollout.',
      'Zephyr canary rollback runbook: restore the previous image tag and replay the reversed migrations in strict order.',
      'Zephyr canary monitoring: dashboards track error rate and p99 latency throughout the canary window.',
      'Zephyr canary config: traffic ramp percentages live in the zephyr flags service with owner sign-off.',
      'Zephyr canary incident notes: the march incident paused a ramp after the alert burn rate doubled.',
    ];
    for (const content of originals) {
      await remember.run({ content, importance: 0.9 }, tctx);
    }

    // Observation A: top3 under the workload query, X = top1.
    const query = 'zephyr canary deploy checklist rollout';
    const first = (await retrieve.run({ query, topK: 3, minScore: 0.05 }, tctx)) as any;
    const firstIds = idsOfToolHits(first);
    assert.equal(firstIds.length, 3, `topK=3 returns three hits (got ${firstIds.length})`);
    const X = firstIds[0]!;

    // Follow-up operation: remember a HIGH-similarity but NOT identical copy
    // of X (~0.8 cosine — below the 0.92 write-time dedupe merge).
    const nearDup =
      'Zephyr canary deploy checklist reminder: run database migrations first, then ramp canary traffic to ten percent; the version bump step stays optional this cycle.';
    const dupRes = (await remember.run({ content: nearDup, importance: 0.9 }, tctx)) as any;
    // Precondition: the write-time dedupe did NOT merge it — both rows live.
    assert.equal(
      dupRes.deduplicated,
      false,
      'near-duplicate must bypass the 0.92 dedupe merge (precondition)',
    );
    const newX = palace.store.getItem(X, { liveOnly: true });
    const dupRow = palace.store.getItem(dupRes.id as string, { liveOnly: true });
    assert.ok(newX, 'original top1 still live after the copy write (precondition)');
    assert.ok(dupRow, 'the injected copy is live (precondition)');
    assert.notEqual(X, dupRes.id, 'copy got its own row');

    // Relation: top1 ∈ {X, new} and original top3 ⊆ new top4.
    const second = (await retrieve.run({ query, topK: 4, minScore: 0.05 }, tctx)) as any;
    const secondIds = idsOfToolHits(second);
    assert.equal(secondIds.length, 4, `topK=4 returns four hits (got ${secondIds.length})`);
    assert.ok(
      secondIds[0] === X || secondIds[0] === dupRes.id,
      `new top1 must be X or the injected copy, got ${secondIds[0]}`,
    );
    const top3 = new Set(firstIds);
    const missing = firstIds.filter((id) => !secondIds.includes(id));
    assert.deepEqual(
      missing,
      [],
      `original top3 set must survive inside the new top4 (missing: ${missing.join(',')}), ` +
        `before=[${firstIds.join(',')}] after=[${secondIds.join(',')}]`,
    );
    assert.ok(top3.size === 3, 'sanity: top3 had three distinct members');
  });

  await t.test('R3 scope monotone shrink: full-ids ⊇ minus-workspace ⊇ anonymous', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const tools = toolMap(ctx);
    const remember = tools.get('memory_remember')!;
    const retrieve = tools.get('memory_retrieve')!;
    const palace = palaceOf(ctx);

    // One item per tier, all sharing the marker 'trident'.
    const gRes = (await remember.run(
      { content: 'Trident constellation note: the shared trident star chart is published for every crew member.' },
      {},
    )) as any;
    const uRes = (await remember.run(
      { content: 'Trident constellation note: personal trident observation logs belong to the owning astronomer.' },
      { userId: 'u-r3' },
    )) as any;
    const wRes = (await remember.run(
      { content: 'Trident constellation note: workspace trident scheduling rotates across the observatory team rota.' },
      { userId: 'u-r3', workspaceId: 'ws-r3' },
    )) as any;
    const sRes = (await remember.run(
      { content: "Trident constellation note: session trident scratchpad holds tonight's alignment calibrations." },
      { userId: 'u-r3', workspaceId: 'ws-r3', sessionId: 'sess-r3' },
    )) as any;

    // Precondition: each write landed on the intended visibility tier
    // (privacy-first resolution: anonymous→global, userId→user,
    // +workspaceId→workspace, +sessionId→session).
    const tierOf = (id: string) => palace.store.getItem(id)?.visibility;
    assert.equal(tierOf(gRes.id), 'global', 'anonymous write lands global');
    assert.equal(tierOf(uRes.id), 'user', 'userId write lands user tier');
    assert.equal(tierOf(wRes.id), 'workspace', 'workspace write lands workspace tier');
    assert.equal(tierOf(sRes.id), 'session', 'session write lands session tier');

    // Three callers of SHRINKING identity, same query/topK. Distinct scopes
    // ⇒ distinct query-cache paramsKeys ⇒ no cross-serving.
    const query = 'trident constellation note';
    const runQ = async (tctx: Record<string, string>) =>
      idsOfToolHits(await retrieve.run({ query, topK: 10, minScore: 0.05 }, tctx as any));

    const asFull = await runQ({ userId: 'u-r3', workspaceId: 'ws-r3', sessionId: 'sess-r3' });
    const asNoWs = await runQ({ userId: 'u-r3', sessionId: 'sess-r3' });
    const asAnon = await runQ({});

    // Precondition: the construction is meaningful — each caller sees its
    // own tier's item, and visibility strictly shrinks.
    assert.equal(asFull.length, 4, `full-identity caller sees all four (got ${asFull.length})`);
    assert.equal(asNoWs.length, 3, `minus-workspace caller sees three (got ${asNoWs.length})`);
    assert.equal(asAnon.length, 1, `anonymous caller sees one (got ${asAnon.length})`);
    assert.ok(asAnon.includes(gRes.id), 'anonymous sees the global item');

    // Relation: hit-id sets shrink monotonically with identity.
    const setFull = new Set(asFull);
    const setNoWs = new Set(asNoWs);
    const setAnon = new Set(asAnon);
    for (const id of setNoWs) {
      assert.ok(setFull.has(id), `minus-workspace hit ${id} must be visible to the full-identity caller`);
    }
    for (const id of setAnon) {
      assert.ok(setNoWs.has(id), `anonymous hit ${id} must be visible to the minus-workspace caller`);
    }
    // The workspace item is exactly what B lost — identity removal may only
    // remove that identity's own rows, never someone else's.
    assert.ok(!setNoWs.has(wRes.id), 'workspace-tier item dropped with the workspace identity');
    assert.ok(setFull.has(wRes.id), '...but the full-identity caller still sees it');
  });

  await t.test('R4 dataVersion: writes strictly bump, pure reads never do', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const tools = toolMap(ctx);
    const tctx = { userId: 'u-r4', sessionId: 'sess-r4' };
    const retrieve = tools.get('memory_retrieve')!;
    const remember = tools.get('memory_remember')!;
    const forget = tools.get('memory_forget')!;
    const store = palaceOf(ctx).store;

    const rand = mulberry32(424242);
    const QPOOL = [
      'quartz relay telemetry shards',
      'sector shard routing health',
      'relay collector backlog',
      'quartz sector capacity notes',
    ];
    const KPOOL = [3, 5, 8, 10];
    // 20 GENUINELY distinct subjects — near-identical templated facts would
    // hit the 0.92 write-time dedupe (correct behavior, wrong for a test
    // that needs every remember to be a real write).
    const SUBJECTS = [
      'quartz relay routes telemetry shard batches',
      'amber gateway buffers outbound sensor frames',
      'basalt index compacts its column families nightly',
      'cobalt queue drains dead letters twice daily',
      'opal cache evicts cold keys on every sweep',
      'granite scheduler pins hot jobs to warm nodes',
      'slate ledger appends sealed batch manifests',
      'pearl proxy terminates mutual tls handshakes',
      'onyx indexer rebuilds inverted term maps',
      'ivory broker rebalances partitions across racks',
      'coral sampler stratifies traces by latency',
      'jade gatekeeper rotates short lived tokens',
      'sand archive snapshots the audit event log',
      'copper detector flags anomalous ingest rates',
      'nickel shuffler stripes large object uploads',
      'tin collector scrapes regional health metrics',
      'zinc planner rewrites wide fan out joins',
      'argon auditor reconciles checksum mismatches',
      'krypton limiter sheds burst traffic gracefully',
      'helium locator pins region metadata replicas',
    ];
    const pickFrom = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

    let reads = 0;
    let writes = 0;
    const counts: Record<string, number> = { retrieve: 0, remember: 0, forget: 0, forgetDry: 0 };
    const liveIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      const roll = rand();
      const before = store.dataVersion();
      let isWrite: boolean;
      let opLabel = '';

      if (roll < 0.4) {
        // Pure read: model retrieve (touchAccess/logQuery documented as
        // non-bumping — asserted below).
        opLabel = 'retrieve';
        counts.retrieve++;
        reads++;
        isWrite = false;
        await retrieve.run({ query: pickFrom(QPOOL), topK: pickFrom(KPOOL) }, tctx);
      } else if (roll < 0.75 || liveIds.length === 0) {
        // Write: fresh unique content (never dedupe-merged — asserted).
        opLabel = 'remember';
        counts.remember++;
        writes++;
        isWrite = true;
        const res = (await remember.run(
          {
            content: `R4 fact ${i}: the ${SUBJECTS[i]} in sector ${i}, observed during rollout window ${i}.`,
            importance: 0.8,
          },
          tctx,
        )) as any;
        assert.equal(res.deduplicated, false, 'unique content must be a real write');
        liveIds.push(res.id);
      } else if (roll < 0.9) {
        // Write: real forget of a still-live id.
        opLabel = 'forget';
        counts.forget++;
        writes++;
        isWrite = true;
        const id = liveIds.shift()!;
        const res = (await forget.run({ id }, tctx)) as any;
        assert.equal(res.forgotten, 1, 'forget of a live id must delete it');
      } else {
        // Pure read: forget dryRun preview.
        opLabel = 'forget-dryRun';
        counts.forgetDry++;
        reads++;
        isWrite = false;
        const res = (await forget.run({ id: liveIds[0]!, dryRun: true }, tctx)) as any;
        assert.equal(res.dryRun, true, 'dryRun preview flag echoed');
      }

      const after = store.dataVersion();
      if (isWrite) {
        assert.ok(
          after > before,
          `op #${i} (${opLabel}) write must strictly bump dataVersion (${before} → ${after})`,
        );
      } else {
        assert.equal(
          after,
          before,
          `op #${i} (${opLabel}) pure read must NOT bump dataVersion (${before} → ${after}) — ` +
            'touchAccess/logQuery are documented non-bumping exceptions',
        );
      }
    }

    // Precondition: the deterministic mix actually mixed both classes.
    assert.ok(reads >= 5, `trajectory must contain >=5 reads (got ${reads})`);
    assert.ok(writes >= 5, `trajectory must contain >=5 writes (got ${writes})`);
    t.diagnostic(`R4 mix: ${JSON.stringify(counts)} (reads=${reads} writes=${writes})`);
  });

  await t.test('R5 as-of visible set evolves only by additions and deletions', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = palaceOf(ctx);
    const userId = 'u-r5';

    const ingest = (marker: string) =>
      palace.ingestor.ingestUserMemory({
        content: `R5CHRON ${marker}: the atlas beacon logs its startup sequence ${marker} every night.`,
        userId,
        importance: 0.8,
      }) as Promise<string>;

    // Epoch 1: A, B, C exist.
    const A = await ingest('alpha');
    const B = await ingest('beta');
    const C = await ingest('gamma');
    await sleep();
    const t1 = Date.now();

    // Epoch 2: D added, B deleted (both strictly after t1).
    await sleep();
    const D = await ingest('delta');
    await sleep();
    assert.equal(palace.store.tombstoneItem(B), true, 'B tombstoned in epoch 2');
    await sleep();
    const t2 = Date.now();

    // Epoch 3: E added, D deleted (both strictly after t2).
    await sleep();
    const E = await ingest('epsilon');
    await sleep();
    assert.equal(palace.store.tombstoneItem(D), true, 'D tombstoned in epoch 3');
    await sleep();
    const t3 = Date.now();

    assert.ok(t1 < t2 && t2 < t3, 'epoch timestamps strictly increase');

    const scanQuery = 'r5chron atlas beacon startup sequence chronicle';
    const v1 = await scanVisibleIds(palace, userId, t1, scanQuery);
    const v2 = await scanVisibleIds(palace, userId, t2, scanQuery);
    const v3 = await scanVisibleIds(palace, userId, t3, scanQuery);
    const liveNow = await scanVisibleIds(palace, userId, undefined, scanQuery);

    // Observation A: the as-of baseline is the three epoch-1 items.
    assert.deepEqual(
      new Set([...v1]),
      new Set([A, B, C]),
      'asOf=t1 sees exactly the epoch-1 items',
    );

    // Relation: V(t2) = V(t1) ∪ {added in (t1,t2]} − {deleted in (t1,t2]}.
    const expectedV2 = new Set([...v1].filter((id) => id !== B));
    expectedV2.add(D);
    assert.deepEqual(
      v2,
      expectedV2,
      'asOf=t2 = t1 set + epoch-2 additions (D) − epoch-2 deletion (B)',
    );

    // Relation: V(t3) = V(t2) ∪ {added in (t2,t3]} − {deleted in (t2,t3]}.
    const expectedV3 = new Set([...v2].filter((id) => id !== D));
    expectedV3.add(E);
    assert.deepEqual(
      v3,
      expectedV3,
      'asOf=t3 = t2 set + epoch-3 additions (E) − epoch-3 deletion (D)',
    );

    // And the no-asOf present equals the latest epoch (t3) view: LIVE now
    // is exactly the furthest flashback.
    assert.deepEqual(
      liveNow,
      v3,
      'current LIVE set equals the newest as-of reconstruction',
    );
  });

  await t.test('R6 capsule idempotent import: second import inserts nothing', async (t) => {
    const ctxA = install(t, { scope: 'user' });
    const ctxB = install(t, { scope: 'user' });
    const toolsA = toolMap(ctxA);
    const toolsB = toolMap(ctxB);
    const palaceB = palaceOf(ctxB);

    for (const content of [
      'Helios mesh constellation: the helios mesh routes east-west traffic through envoy sidecars.',
      'Helios mesh constellation: helios canary gates rollouts on slo burn rate checks.',
      'Helios mesh constellation: helios mtls certificates rotate every thirty days automatically.',
    ]) {
      await toolsA.get('memory_remember')!.run({ content, importance: 0.9 }, { userId: 'u-a' });
    }

    const exported = (await toolsA.get('memory_capsule_export')!.run(
      { query: 'helios mesh', topK: 10, secret: 'meta-secret' },
      { userId: 'u-a' },
    )) as any;
    assert.equal(exported.items, 3, `capsule carries all three items (got ${exported.items})`);

    const countBefore = palaceB.store.listItemsByLayer('semantic', 500).length;
    assert.equal(countBefore, 0, 'palace B starts empty');

    const first = (await toolsB.get('memory_capsule_import')!.run(
      { capsule: exported.capsuleJson, secret: 'meta-secret' },
      { sessionId: 's-b', userId: 'u-b' },
    )) as any;
    assert.ok(first.inserted >= 1, 'first import inserts');
    assert.equal(first.duplicates, 0, 'fresh palace has no duplicates');

    const countAfterFirst = palaceB.store.listItemsByLayer('semantic', 500).length;
    assert.equal(
      countAfterFirst - countBefore,
      first.inserted,
      'live item count grows by exactly the first import\'s inserted',
    );

    // Follow-up operation: import the SAME capsule again.
    const second = (await toolsB.get('memory_capsule_import')!.run(
      { capsule: exported.capsuleJson, secret: 'meta-secret' },
      { sessionId: 's-b', userId: 'u-b' },
    )) as any;
    assert.equal(second.inserted, 0, 'second import inserts nothing');
    assert.ok(second.duplicates > 0, `second import reports duplicates (got ${second.duplicates})`);

    const countAfterSecond = palaceB.store.listItemsByLayer('semantic', 500).length;
    assert.equal(
      countAfterSecond,
      countAfterFirst,
      'total live entries unchanged by the repeat import',
    );
  });

  await t.test('R7 bounded reinforcement: 10 retrieves → importance monotone ≤0.95, access +10', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const tools = toolMap(ctx);
    const palace = palaceOf(ctx);
    const tctx = { userId: 'u-r7' };

    for (const content of [
      'Falcon telemetry pipeline: the falcon collector batches spans into the falcon gateway every five seconds.',
      'Falcon telemetry pipeline: falcon gateway buffers protect against collector restarts during backfill.',
      'Falcon telemetry pipeline: span sampling keeps falcon ingest costs bounded at high traffic.',
      'Falcon telemetry pipeline: the falcon dashboard renders latency heatmaps from stored spans.',
    ]) {
      await tools.get('memory_remember')!.run({ content, importance: 0.9 }, tctx);
    }

    const query = 'falcon telemetry pipeline span batching';
    const probe = await palace.retriever.retrieve({
      query, topK: 10, minScore: 0.05, scope: { userId: 'u-r7' },
    });
    assert.ok(probe.hits.length >= 4, `probe sees all items (got ${probe.hits.length})`);
    const X = probe.hits[0]!.item.id;

    const row = () => palace.store.getItem(X, { liveOnly: true }) as
      { accessCount: number; importance: number };
    const base = row();
    let prevImportance = base.importance;

    // Ten repeat retrieves: same query, same scope, DISTINCT topK each call
    // (11..20 — none collides with the probe's topK=10 paramsKey) so every
    // call executes the real pipeline instead of a cache serve.
    for (let i = 0; i < 10; i++) {
      const res = await palace.retriever.retrieve({
        query, topK: 11 + i, minScore: 0.05, scope: { userId: 'u-r7' },
      });
      assert.ok(
        res.hits.some((h: any) => h.item.id === X),
        `call ${i + 1}: the reinforced item stays in the hit set`,
      );
      const r = row();
      assert.ok(
        r.importance >= prevImportance - 1e-9,
        `call ${i + 1}: importance monotone non-decreasing (${prevImportance} → ${r.importance})`,
      );
      assert.ok(
        r.importance <= 0.95 + 1e-9,
        `call ${i + 1}: importance respects the 0.95 cap (got ${r.importance})`,
      );
      assert.equal(
        r.accessCount,
        base.accessCount + i + 1,
        `call ${i + 1}: accessCount grows by exactly one per real retrieval`,
      );
      prevImportance = r.importance;
    }

    const final = row();
    assert.equal(final.accessCount, base.accessCount + 10, 'exactly +10 accesses over 10 retrieves');
    assert.ok(
      Math.abs(final.importance - Math.min(0.95, base.importance + 0.1)) < 1e-9,
      `final importance = min(0.95, base+0.10) (got ${final.importance}, base ${base.importance})`,
    );
  });

  await t.test('R8 distillation preserves content and keeps tombstone flashback', async (t) => {
    const ctx = install(t, { scope: 'user' });
    const palace = palaceOf(ctx);
    const userId = 'u-r8';

    const ingest = (content: string) =>
      palace.ingestor.ingestUserMemory({ content, userId, importance: 0.6 }) as Promise<string>;

    // A mergeable pair: one token differs (nightly/weekly) → cosine far
    // above the 0.78 cluster threshold, far below exact duplication.
    const m1 = await ingest(
      'Meridian cache warming pushes hot keys into the regional edge nodes on a nightly schedule.',
    );
    const m2 = await ingest(
      'Meridian cache warming pushes hot keys into the regional edge nodes on a weekly schedule.',
    );

    // Precondition via side-effect-free store scan: both members live.
    const beforeScan = await scanVisibleIds(palace, userId, undefined, 'meridian cache warming edge nodes');
    assert.ok(beforeScan.has(m1) && beforeScan.has(m2), 'both members live before distill');

    const beforeDistill = Date.now();
    await sleep();

    // Follow-up operation: one distill pass (default merge path = plain
    // concatenation with the "\n---\n" separator, no LLM).
    const report = (await palace.compressor.distill({ trigger: 'manual' })) as any;
    assert.equal(report.newSemanticItems, 1, `exactly one merged item produced (got ${report.newSemanticItems})`);

    // Relation part 1: the merged item carries BOTH members' keywords.
    const liveItems = palace.store.listItemsByLayer('semantic', 100) as Array<{
      id: string; content: string; metadata: { tags?: string[] };
    }>;
    assert.equal(liveItems.length, 1, 'the pair collapsed into a single live item');
    const merged = liveItems[0]!;
    assert.ok(merged.content.includes('nightly'), 'merged content keeps member-1 keyword "nightly"');
    assert.ok(merged.content.includes('weekly'), 'merged content keeps member-2 keyword "weekly"');
    assert.ok(
      (merged.metadata.tags ?? []).includes('distilled'),
      'merged item is tagged distilled',
    );

    // Relation part 2: members are invisible LIVE (tombstoned) but the
    // ROW survives for undo/audit.
    assert.equal(palace.store.getItem(m1, { liveOnly: true }), null, 'member 1 not LIVE');
    assert.equal(palace.store.getItem(m2, { liveOnly: true }), null, 'member 2 not LIVE');
    assert.ok(palace.store.getItem(m1), 'member 1 row retained (tombstone, not hard delete)');
    assert.ok(palace.store.getItem(m2), 'member 2 row retained (tombstone, not hard delete)');

    // Relation part 3: FLASHBACK before the merge still sees BOTH members;
    // the current view sees the merge only.
    const flashback = await palace.retriever.retrieve({
      query: 'meridian cache warming edge nodes',
      topK: 10,
      minScore: 0.05,
      asOfMs: beforeDistill,
      scope: { userId: 'u-r8' },
    });
    const fbIds = new Set(flashback.hits.map((h: any) => h.item.id as string));
    assert.ok(fbIds.has(m1), 'flashback before merge sees member 1');
    assert.ok(fbIds.has(m2), 'flashback before merge sees member 2');
    assert.ok(!fbIds.has(merged.id), 'flashback does not leak the not-yet-created merged item');

    const current = await palace.retriever.retrieve({
      query: 'meridian cache warming edge nodes',
      topK: 10,
      minScore: 0.05,
      scope: { userId: 'u-r8' },
    });
    const curIds = new Set(current.hits.map((h: any) => h.item.id as string));
    assert.ok(curIds.has(merged.id), 'current view sees the merged item');
    assert.ok(!curIds.has(m1) && !curIds.has(m2), 'current view hides both tombstoned members');
  });
});
