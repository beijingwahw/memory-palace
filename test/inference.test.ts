/**
 * Inference dimension tests: typed-relation extraction (EN/CN), chain
 * composition with confidence decay and contradiction dampening, and the
 * end-to-end night (typed edges → inferred chains → derived items →
 * retrievable → memory_why traceability).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  composeChains,
  extractTypedRelations,
  chainStatement,
  type ChainEdge,
} from '../src/utils/inference.ts';

test('typed relations: EN dependency / deployment patterns', () => {
  const rels = extractTypedRelations(
    'Aurora depends on Kafka for its event stream. Kafka is deployed on Kubernetes 1.30.',
    ['Aurora', 'Kafka', 'Kubernetes'],
  );
  const deps = rels.find((r) => r.relation === 'depends-on');
  assert.ok(deps, 'depends-on lifted');
  assert.equal(deps!.from, 'Aurora');
  assert.equal(deps!.to, 'Kafka');
  const dep = rels.find((r) => r.relation === 'deployed-on');
  assert.ok(dep, 'deployed-on lifted');
  assert.equal(dep!.to, 'Kubernetes');
});

test('typed relations: CN patterns', () => {
  const rels = extractTypedRelations('告警服务依赖 Kafka。Kafka 部署在 Kubernetes 上。', [
    'Kafka',
    'Kubernetes',
    '告警服务',
  ]);
  assert.ok(rels.some((r) => r.relation === 'depends-on' && r.from === '告警服务'), 'CN depends-on');
  assert.ok(rels.some((r) => r.relation === 'deployed-on' && r.to === 'Kubernetes'), 'CN deployed-on');
});

test('typed relations: distant mentions do not fabricate', () => {
  const rels = extractTypedRelations('Aurora is nice. Much later, Kafka depends on Kubernetes.', [
    'Aurora',
    'Kafka',
    'Kubernetes',
  ]);
  assert.ok(!rels.some((r) => r.from === 'Aurora'), 'no cross-sentence fabrication');
});

test('composeChains: two-hop transitive inference with decayed confidence', () => {
  const edges: ChainEdge[] = [
    { from: 'Aurora', to: 'Kafka', relation: 'depends-on', weight: 1 },
    { from: 'Kafka', to: 'K8s', relation: 'deployed-on', weight: 1 },
  ];
  const chains = composeChains(edges);
  const auroraK8s = chains.find((c) => c.path[0] === 'Aurora' && c.path[2] === 'K8s');
  assert.ok(auroraK8s, 'Aurora→K8s inferred');
  assert.equal(auroraK8s!.path.length, 3, 'two hops');
  assert.ok(
    auroraK8s!.confidence > 0.7 && auroraK8s!.confidence < 0.9,
    `confidence decays once (got ${auroraK8s!.confidence})`,
  );
  assert.match(chainStatement(auroraK8s!), /—depends-on→ .*—deployed-on→/);
});

test('composeChains: cycles avoided, contradictions dampen, weak edges drop', () => {
  const edges: ChainEdge[] = [
    { from: 'A', to: 'B', relation: 'uses', weight: 1 },
    { from: 'B', to: 'A', relation: 'part-of', weight: 1 }, // cycle
    { from: 'B', to: 'C', relation: 'feeds', weight: 0.4 }, // weak
    { from: 'C', to: 'D', relation: 'connects-to', weight: 1 },
  ];
  const plain = composeChains(edges, { minConfidence: 0.2 });
  assert.ok(!plain.some((c) => c.path[0] === c.path[c.path.length - 1]), 'no cyclic chain');
  assert.ok(plain.some((c) => c.path.join('>') === 'A>B>C'), 'weak but above 0.2 kept');

  const contradicted = new Set(['B']);
  const damped = composeChains(edges, { minConfidence: 0.2, contradictedEntities: contradicted });
  const plainABC = plain.find((c) => c.path.join('>') === 'A>B>C')!;
  const dampedABC = damped.find((c) => c.path.join('>') === 'A>B>C')!;
  assert.ok(
    dampedABC.confidence < plainABC.confidence,
    'contradiction touch dampens the chain',
  );
});

// --------------------------------------------------------------- integration

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const dir = mkdtempSync(join(tmpdir(), 'infer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, 'memory.db'),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
    ...opts,
  });
  return ctx;
}

test('reasoning dimension end-to-end: ingest → sleep infers → retrieve → why', async (t) => {
  const ctx = install(t, {
    compression: { enabled: true, triggerCount: 100000, importanceThreshold: 0.35, decayHalfLifeDays: 14 },
  });
  const palace: any = ctx.services.get('memory-palace');
  const tools = new Map(ctx.tools.map((x) => [x.name, x]));
  const tctx = { sessionId: 's-reason', userId: 'u-reason' };

  await t.test('typed edges exist after ingest', async () => {
    await palace.ingestor.ingestUserMemory({
      content:
        'Aurora depends on Kafka for its event backbone. Kafka is deployed on Kubernetes 1.30 clusters.',
      userId: 'u-reason',
      importance: 0.9,
    });
    const edges = palace.store.listEdges();
    const typed = edges.filter((e: any) => e.relation === 'depends-on' || e.relation === 'deployed-on');
    assert.ok(typed.length >= 2, `typed edges lifted (${typed.length})`);
  });

  await t.test('sleep materializes a derived Aurora→Kubernetes fact', async () => {
    const dream = await palace.sleep.sleep(tctx, { forceCompression: false });
    const inferPhase = dream.phases.find((p: any) => p.phase === 'infer');
    assert.ok(inferPhase && inferPhase.ok, 'infer phase ran clean');
    assert.ok((inferPhase.detail.chains ?? 0) >= 1, 'at least one chain composed');

    const res = await palace.retriever.retrieve({
      query: 'where does Aurora ultimately run',
      scope: { userId: 'u-reason' },
    });
    const derived = res.hits.find((h: any) => /Inferred/.test(h.item.content));
    assert.ok(derived, 'derived fact retrievable');
    assert.match(derived!.item.content, /Aurora\s*—depends-on→\s*Kafka\s*—deployed-on→\s*Kubernetes/);
    // v0.20: derived rows stamp metadata.source 'inferred' (the types
    // union already carries it) instead of borrowing 'user'; the tags
    // branding stays.
    assert.equal(derived!.item.metadata.source, 'inferred', 'derived row source is inferred');
    assert.ok(derived!.item.metadata.tags.includes('inferred'), 'branded as inferred');

    // Idempotence: a second night must not duplicate the derived item.
    await palace.sleep.sleep(tctx, { forceCompression: false });
    const all = palace.store
      .listItemsByLayer('semantic', 500)
      .filter((i: any) => String(i.content).startsWith('Inferred'));
    const statements = new Set(all.map((i: any) => i.content));
    assert.equal(statements.size, all.length, 'no duplicated derivations');
  });

  await t.test('fifteen tools registered including memory_why', () => {
    assert.equal(ctx.tools.length, 15, 'fifteen tools');
    assert.ok(tools.has('memory_why'), 'memory_why present');
  });

  await t.test('memory_why traces lineage for an entity', async () => {
    const why = tools.get('memory_why')!;
    const out: any = await why.run({ entity: 'Aurora' }, tctx);
    assert.ok(out.relations.length >= 1, 'relations listed');
    assert.ok(
      out.relations.some((r: any) => r.relation === 'depends-on' && r.counterparty === 'Kafka'),
      'direct dependency traced',
    );
    assert.ok(
      out.relations.some((r: any) => r.inferred && r.counterparty === 'Kubernetes'),
      'inferred reach traced and flagged',
    );
    assert.ok(out.evidence.length >= 1, 'evidence items listed');
  });
});
