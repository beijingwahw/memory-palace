/**
 * Federation router acceptance: 2 palaces with DISJOINT knowledge, one
 * federated query returns merged ranked hits with correct provenance;
 * breaker isolation drops a failing member without stalling the rest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';
import { FederatedRetriever } from '../src/services/federated-retriever.ts';

interface AfterHooks {
  after(fn: () => void): void;
}

function install(t: AfterHooks, dbPath: string) {
  const ctx = createMockContext();
  t.after(() => {
    const store = ctx.services.get('memory-store') as { close(): void } | undefined;
    try {
      store?.close();
    } catch {
      /* closed */
    }
  });
  MemoryPalacePlugin(ctx as never, {
    storagePath: dbPath,
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
  } as never);
  return ctx;
}

test('federation router: cross-palace merged retrieval with provenance', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fed-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL handle still open on Windows — the OS temp cleaner handles it */ } });

  // Palace A: infrastructure knowledge.
  const ctxA = install(t, join(dir, 'a.db'));
  const palaceA: any = ctxA.services.get('memory-palace');
  await palaceA.ingestor.ingestUserMemory({
    content: 'The Aurora mesh routes east-west traffic through Envoy sidecars with mTLS.',
    userId: 'u-fed',
    importance: 0.9,
  });

  // Palace B: completely different domain (observability).
  const ctxB = install(t, join(dir, 'b.db'));
  const palaceB: any = ctxB.services.get('memory-palace');
  await palaceB.ingestor.ingestUserMemory({
    content: 'Grafana dashboards for the observability stack alert on SLO burn rate.',
    userId: 'u-fed',
    importance: 0.85,
  });

  // Federate: both retrievers as members.
  const fed = new FederatedRetriever(
    [
      { name: 'infra', retrieve: (q) => palaceA.retriever.retrieve(q) },
      { name: 'observ', retrieve: (q) => palaceB.retriever.retrieve(q) },
    ],
  );

  const res = await fed.retrieve({
    query: 'mesh traffic routing dashboards',
    topK: 5,
    scope: { userId: 'u-fed' },
  });

  assert.ok(res.hits.length >= 2, `merged hits (got ${res.hits.length})`);
  const palaces = new Set(res.hits.map((h) => h.sourcePalace));
  assert.ok(palaces.has('infra') && palaces.has('observ'), 'both palaces present (' + [...palaces].join(', ') + ')');
  for (const h of res.hits) {
    assert.ok(h.sourcePalace.length > 0, 'provenance on every hit');
    assert.ok(h.score >= 0 && h.score <= 1.2, 'score bounded');
  }
  assert.equal(res.palaces.length, 2, 'both members reported');
  assert.equal(res.degradedMembers.length, 0, 'no degradation');
  assert.ok(res.elapsedMs >= 0);

  // Knowledge separation is preserved: infra content came from 'infra'.
  const envoy = res.hits.find((h) => /Envoy/.test(h.content));
  assert.equal(envoy?.sourcePalace, 'infra', 'Envoy fact from infra palace');
  const grafana = res.hits.find((h) => /Grafana/.test(h.content));
  assert.equal(grafana?.sourcePalace, 'observ', 'Grafana fact from observ palace');
});

test('federation router: failing member isolated by breaker', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fed2-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL handle still open on Windows — the OS temp cleaner handles it */ } });
  const ctxA = install(t, join(dir, 'a.db'));
  const palaceA: any = ctxA.services.get('memory-palace');
  await palaceA.ingestor.ingestUserMemory({
    content: 'Local palace has the critical deployment runbook for Friday.',
    userId: 'u-fed',
    importance: 0.9,
  });

  let failCount = 0;
  const fed = new FederatedRetriever([
    { name: 'local', retrieve: (q) => palaceA.retriever.retrieve(q) },
    {
      name: 'remote-dead',
      retrieve: async () => {
        failCount++;
        throw new Error('connection refused');
      },
    },
  ]);

  const r1 = await fed.retrieve({ query: 'deployment runbook', topK: 3, scope: { userId: 'u-fed' } });
  assert.ok(r1.hits.length > 0, 'local palace still answers');
  assert.deepEqual(r1.degradedMembers, ['remote-dead'], 'dead member reported');
  assert.equal(failCount, 1, 'one probe attempted');

  // Breaker opens after threshold (3) — subsequent queries skip the member.
  await fed.retrieve({ query: 'deployment runbook', scope: { userId: 'u-fed' } });
  await fed.retrieve({ query: 'deployment runbook', scope: { userId: 'u-fed' } });
  await fed.retrieve({ query: 'deployment runbook', scope: { userId: 'u-fed' } });
  assert.ok(failCount <= 3, `breaker opened, no more probes (attempts=${failCount})`);
  const r4 = await fed.retrieve({ query: 'deployment runbook', scope: { userId: 'u-fed' } });
  assert.ok(r4.hits.length > 0, 'local still answering with remote circuit open');
  assert.ok(r4.degradedMembers.includes('remote-dead'));
});

test('fifteen tools registered including memory_fed_search', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fed3-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL handle still open on Windows — the OS temp cleaner handles it */ } });
  const ctx = install(t, join(dir, 'm.db'));
  assert.equal(ctx.tools.length, 15, 'fifteen tools');
  const tools = new Map(ctx.tools.map((x: any) => [x.name, x]));
  assert.ok(tools.has('memory_fed_search'));
  // Fed search via the tool works against the local member.
  const palace: any = ctx.services.get('memory-palace');
  await palace.ingestor.ingestUserMemory({
    content: 'Federated search hits the local member when it is the only one registered.',
    userId: 'u-t',
    importance: 0.8,
  });
  const fed: any = await tools.get('memory_fed_search')!.run(
    { query: 'federated search local member', topK: 3 },
    { sessionId: 's', userId: 'u-t' },
  );
  assert.ok(fed.hits.length > 0, 'tool returns local hits');
  assert.equal(fed.hits[0].sourcePalace, 'local', 'local provenance');
  assert.ok(fed.members.includes('local'), 'member list');
});
