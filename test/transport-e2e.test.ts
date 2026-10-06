/**
 * transport-e2e — two REAL palaces talking over REAL HTTP sockets.
 *
 * The transport unit suites (transport-http / transport-crdt) pin each
 * server factory against raw requests; this file pins the WIRING the way
 * a host would actually deploy it: palace A is a full plugin palace that
 * exposes (1) its retriever through createFederationServer and (2) its
 * CRDT replica through createCrdtServer — the zero-dependency node:http
 * transport with HMAC peer authentication (timingSafeEqual) — while
 * palace B is a full LOCAL palace that joins A over the network via
 * httpFederationMember. Four end-to-end properties:
 *
 *   1. federated retrieval crosses palaces over HTTP (source-tagged hits,
 *      embeddings stripped from the wire payload by default);
 *   2. CRDT anti-entropy converges over HTTP with incremental deltas
 *      (watermark-governed exchange, exactly-2 delta after 2 new ops);
 *   3. a wrong shared secret is a 401 on BOTH transports — the failed
 *      retrieval member lands in degradedMembers instead of the answer,
 *      and CRDT syncOverHttp rejects;
 *   4. private tiers never leave the palace: the default serve face is
 *      the ANONYMOUS cascade (serveScope = {}), which sees only the
 *      global layer — a user-tier row written on A is invisible to B
 *      even when the client tries to smuggle the owner's scope along
 *      (I-ACL-14, the security-default-face proof).
 *
 * Corpus note (case 1/4): the serve face evaluates retrieval against the
 * SERVER's scope, not the writer's. Writes meant to be federated are made
 * with an anonymous identity + explicit visibility 'global' — a write
 * that arrives through a userId-carrying scope collapses to the narrower
 * 'user' tier (resolveWriteTier, the write path) and is then invisible to
 * the anonymous serve face BY DESIGN. The default serving surface is the
 * global layer; that boundary is exactly what case 4 asserts.
 *
 * Determinism: offline-bm25 embeddings, fixed corpus, no clocks in play.
 * Windows hook order: every store/server close is registered on t.after
 * BEFORE the temp-dir rmSync hook (an open WAL handle makes rmSync EPERM).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import MemoryPalacePlugin from '../src/index.ts';
import { createMockContext } from './mock-context.ts';
import { FederatedRetriever } from '../src/services/federated-retriever.ts';
import {
  createCrdtServer,
  createFederationServer,
  httpFederationMember,
  syncOverHttp,
} from '../src/transport/index.ts';

const SECRET = 'e2e-peer-secret';

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void | Promise<void>) => void;
}

/**
 * A full plugin palace on a temp SQLite file. The close hook is registered
 * by the caller-visible setup (before the dir-removal hook) — see the
 * Windows WAL rule in the file header.
 */
function startPalace(t: AfterHooks, dir: string, name: string): any {
  const ctx = createMockContext();
  MemoryPalacePlugin(ctx as never, {
    storagePath: join(dir, `${name}.db`),
    embedding: { provider: 'offline-bm25', model: 'bm25', dimensions: 256 },
  } as never);
  const facade: any = ctx.services.get('memory-palace');
  t.after(() => {
    try {
      facade.store.close();
    } catch {
      /* already closed */
    }
  });
  return facade;
}

/**
 * The task's topology: palace A serves BOTH transports over HTTP, palace B
 * stays local and joins A's federation through an httpFederationMember
 * wired into B's FederatedRetriever. Servers bind ephemeral ports.
 */
async function setupTopology(t: AfterHooks): Promise<{
  A: any;
  B: any;
  fedA: { url: string; port: number; close(): unknown };
  crdtA: { url: string; port: number; close(): unknown };
}> {
  const dir = mkdtempSync(join(tmpdir(), 'transport-e2e-'));
  const A = startPalace(t, dir, 'palace-a');
  const B = startPalace(t, dir, 'palace-b');

  // await Promise.resolve: tolerates both sync and async factory shapes.
  const fedA = await Promise.resolve(
    createFederationServer({
      member: { name: 'palace-a', retrieve: (q: any) => A.retriever.retrieve(q) },
      secret: SECRET,
      serveScope: {}, // anonymous serve face — the global-only cascade
    }),
  );
  const crdtA = await Promise.resolve(createCrdtServer({ crdt: A.crdtFederation, secret: SECRET }));
  t.after(async () => {
    await Promise.resolve(fedA.close());
  });
  t.after(async () => {
    await Promise.resolve(crdtA.close());
  });

  // B joins the federation: the remote member sits next to B's own 'local'.
  B.federationRouter.addMember(httpFederationMember(fedA.url, SECRET, { name: 'palace-a' }));

  assert.ok(fedA.port > 0 && crdtA.port > 0, 'servers bound ephemeral ports');
  assert.ok(fedA.url.startsWith('http'), `federation url shape (${fedA.url})`);

  // The directory removal goes LAST — after the closes registered above.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { A, B, fedA, crdtA };
}

// ─────────────────────────────────────────────────────────────────────
// Case 1 — federated retrieval crosses palaces over real HTTP
// ─────────────────────────────────────────────────────────────────────

test('e2e 1: federated retrieval reaches palace A over HTTP, source-tagged, embeddings stripped', async (t) => {
  const { A, B, fedA } = await setupTopology(t);

  // Aurora infrastructure knowledge on A — written ANONYMOUSLY with an
  // explicit global visibility so the rows land in the one tier the
  // anonymous serve face can read (see the corpus note in the header).
  for (const content of [
    'Aurora deploys its frontdoor gateway behind the edge mesh with a ten-minute canary rollout.',
    'Aurora infrastructure runs PostgreSQL primary-replica pairs with automatic failover.',
    'The Aurora deploy pipeline signs every artifact with a content-addressed digest before promotion.',
  ]) {
    await A.ingestor.ingestUserMemory({ content, visibility: 'global', importance: 0.8 });
  }

  // B's federated retrieve fans out to [local(B), palace-a(A-over-HTTP)].
  const res = await B.federationRouter.retrieve({
    query: 'aurora deploy gateway canary rollout',
    topK: 4,
  });
  const fromA = res.hits.filter((h: any) => h.sourcePalace === 'palace-a');
  assert.ok(fromA.length > 0, `federation reached palace A over HTTP (${JSON.stringify(res.palaces)})`);
  assert.ok(
    fromA.some((h: any) => h.content.includes('frontdoor gateway')),
    'the gateway item is among the hits',
  );
  assert.ok(
    res.palaces.some((p: any) => p.name === 'palace-a' && p.hits > 0),
    'debug panel counts palace-a hits',
  );

  // Embedding stripping: the LOCAL retriever materializes Float32Array
  // embeddings on every hit — the wire payload must NOT carry them.
  const local = await A.retriever.retrieve({ query: 'aurora deploy gateway canary', topK: 4 });
  assert.ok(local.hits.length > 0, 'positive control: local retrieval hits');
  assert.ok(
    local.hits[0]!.item.embedding instanceof Float32Array,
    'positive control: local hits DO carry embeddings',
  );
  const remote = httpFederationMember(fedA.url, SECRET, { name: 'palace-a' });
  const raw = await remote.retrieve({ query: 'aurora deploy gateway canary', topK: 4 });
  assert.ok(raw.hits.length > 0, 'member retrieve hit');
  for (const h of raw.hits) {
    assert.equal(h.item.embedding, undefined, 'embeddings are stripped from the wire payload');
  }
});

// ─────────────────────────────────────────────────────────────────────
// Case 2 — CRDT convergence over HTTP, incremental delta
// ─────────────────────────────────────────────────────────────────────

test('e2e 2: CRDT anti-entropy converges over HTTP; second round ships only the 2-op delta', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'transport-e2e-crdt-'));
  const A = startPalace(t, dir, 'crdt-a');
  const B = startPalace(t, dir, 'crdt-b');
  // Both palaces serve their replica — "one sync each way" needs a server
  // on each side (each call is a full bidirectional anti-entropy round).
  const crdtA = await Promise.resolve(createCrdtServer({ crdt: A.crdtFederation, secret: SECRET }));
  const crdtB = await Promise.resolve(createCrdtServer({ crdt: B.crdtFederation, secret: SECRET }));
  t.after(async () => {
    await Promise.resolve(crdtA.close());
  });
  t.after(async () => {
    await Promise.resolve(crdtB.close());
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 3 ops per side — deliberate, distinct keys (no ingest used, so the op
  // counts are exact).
  for (let i = 0; i < 3; i++) A.crdtFederation.recordSet(`infra-a-${i}`, `value-a-${i}`);
  for (let i = 0; i < 3; i++) B.crdtFederation.recordSet(`infra-b-${i}`, `value-b-${i}`);

  // One round each direction. First round = full logs (3 ops per side).
  const r1 = await syncOverHttp(B.crdtFederation, crdtA.url, SECRET);
  assert.equal(r1.converged, true, 'B↔A exchange converges');
  assert.equal(r1.sent, 3, 'first round ships B\'s whole log (no endpoint watermark yet)');
  assert.equal(r1.received, 3, 'first round pulls A\'s whole log');
  const r2 = await syncOverHttp(A.crdtFederation, crdtB.url, SECRET);
  assert.equal(r2.converged, true, 'A↔B exchange converges');
  assert.equal(
    A.crdtFederation.fingerprint(),
    B.crdtFederation.fingerprint(),
    'both replicas hold the identical converged digest',
  );

  // B writes exactly 2 more ops; the next exchange must ship ONLY those.
  B.crdtFederation.recordSet('infra-b-late-0', 'late-0');
  B.crdtFederation.recordSet('infra-b-late-1', 'late-1');
  const r3 = await syncOverHttp(B.crdtFederation, crdtA.url, SECRET);
  assert.equal(r3.converged, true, 'incremental exchange converges');
  assert.equal(r3.sent, 2, `delta exchange ships exactly the 2 new ops (got ${r3.sent})`);
  assert.equal(
    A.crdtFederation.fingerprint(),
    B.crdtFederation.fingerprint(),
    'still converged after the incremental round',
  );
  // The late write actually crossed the network.
  assert.ok(
    A.crdtFederation.exportOps().some((op: any) => op.key === 'infra-b-late-1'),
    'the late op reached A',
  );
});

// ─────────────────────────────────────────────────────────────────────
// Case 3 — authentication boundary: wrong secret is 401 on both transports
// ─────────────────────────────────────────────────────────────────────

test('e2e 3: wrong shared secret → 401 on retrieval and CRDT sync; federation degrades the member', async (t) => {
  const { A, B, fedA, crdtA } = await setupTopology(t);
  await A.ingestor.ingestUserMemory({
    content: 'Aurora deploys its frontdoor gateway behind the edge mesh.',
    visibility: 'global',
    importance: 0.8,
  });

  // Raw member: the rejection itself must name 401.
  const impostor = httpFederationMember(fedA.url, 'not-the-secret', { name: 'impostor' });
  await assert.rejects(
    () => impostor.retrieve({ query: 'aurora gateway', topK: 2 }),
    /401/,
    'retrieval member rejects with a 401-flavored error',
  );

  // Through the FederatedRetriever: the member is isolated into
  // degradedMembers — the round answers, the impostor contributes nothing.
  const fed = new FederatedRetriever([impostor]);
  const res = await fed.retrieve({ query: 'aurora gateway', topK: 2 });
  assert.deepEqual(res.degradedMembers, ['impostor'], 'the failed member is accounted as degraded');
  assert.equal(res.hits.length, 0, 'no hits flow from an unauthenticated member');

  // CRDT: the same wrong secret must reject the sync outright.
  await assert.rejects(
    () => syncOverHttp(B.crdtFederation, crdtA.url, 'not-the-secret'),
    /401/,
    'CRDT sync rejects with a 401-flavored error',
  );
});

// ─────────────────────────────────────────────────────────────────────
// Case 4 — A's private layer never leaks over the transport
// ─────────────────────────────────────────────────────────────────────

test('e2e 4: user-tier rows on A are invisible to the anonymous serve face (I-ACL-14)', async (t) => {
  const { A, B, fedA } = await setupTopology(t);

  // One public row and one PRIVATE row (alice's user tier) on A.
  await A.ingestor.ingestUserMemory({
    content: 'Aurora deploys its frontdoor gateway behind the edge mesh with a ten-minute canary rollout.',
    visibility: 'global',
    importance: 0.8,
  });
  await A.ingestor.ingestUserMemory({
    content: 'ZEPHYR-PRIVATE rotate the internal Aurora tokens every seven days.',
    userId: 'alice',
    visibility: 'user',
    importance: 0.9,
  });

  // Positive control: the row exists and alice sees it LOCALLY — a zero
  // on the wire is the serve face, not a missing item.
  const own = await A.retriever.retrieve({
    query: 'zephyr private rotate internal tokens',
    topK: 4,
    scope: { userId: 'alice' },
  });
  assert.ok(
    own.hits.some((h: any) => h.item.content.includes('ZEPHYR-PRIVATE')),
    'positive control: alice sees her own user-tier row locally',
  );

  // B's federated search: the anonymous serve face (serveScope = {} →
  // global-only cascade) must return NOTHING of the private content.
  const res = await B.federationRouter.retrieve({
    query: 'zephyr private rotate internal tokens',
    topK: 8,
  });
  assert.equal(
    res.hits.filter((h: any) => h.content.includes('ZEPHYR-PRIVATE')).length,
    0,
    'the user-tier row never crosses the transport',
  );

  // Smuggling probe: even a client-SUPPLIED owner scope cannot widen the
  // serve face — the server evaluates against ITS scope, never the wire's.
  const smuggle = httpFederationMember(fedA.url, SECRET, { name: 'palace-a' });
  const spoofed = await smuggle.retrieve({
    query: 'zephyr private rotate internal tokens',
    topK: 8,
    scope: { userId: 'alice' },
  });
  assert.equal(
    spoofed.hits.filter((h: any) => h.item.content.includes('ZEPHYR-PRIVATE')).length,
    0,
    'a client-supplied scope cannot widen the anonymous serve face',
  );
});
