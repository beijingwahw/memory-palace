/**
 * CRDT HTTP transport tests — REAL loopback servers (node:http, ephemeral
 * ports): two palaces converge through opposite-direction syncOverHttp
 * rounds, the second round ships only deltas, wrong secrets get 401,
 * close is idempotent, and the widened CrdtPeer sync signature works with
 * a transport adapter. Local-sync regression after the interface
 * extraction lives in crdt-federation.test.ts (unchanged, must stay green).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/services/memory-store.ts';
import { CrdtFederation } from '../src/services/crdt-federation.ts';
import { createCrdtServer, remoteCrdtPeer, syncOverHttp } from '../src/transport/crdt-http.ts';

const SECRET = 'palace-crdt-test-secret';

/** Minimal structural handle for registering cleanup on a (sub)test. */
interface AfterHooks {
  after: (fn: () => void) => void;
}

/** Fresh store+federation pair; the close hook registers inside, the
 *  caller registers the dir rm LAST — node:test runs after hooks in
 *  registration order, and the WAL handles must close before the rm
 *  (the Windows hook-order rule, see INVARIANTS §4). */
function fedPair(t: AfterHooks, dir: string, name: string): { store: MemoryStore; fed: CrdtFederation } {
  const store = new MemoryStore({
    storagePath: join(dir, `${name}.db`),
    dimensions: 4,
    scope: 'user',
  });
  t.after(() => store.close());
  return { store, fed: new CrdtFederation(store, name) };
}

/** Temp dir factory; the returned cleanup must be registered as the FINAL
 *  after hook (after all store closes) via `t.after(cleanup)`. */
function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'crdt-http-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('http transport: opposite-direction rounds converge, then ship only deltas', async (t) => {
  const { dir, cleanup } = tempDir();
  const a = fedPair(t, dir, 'http-a');
  const b = fedPair(t, dir, 'http-b');
  t.after(cleanup);
  const serverA = await createCrdtServer({ crdt: a.fed, secret: SECRET });
  const serverB = await createCrdtServer({ crdt: b.fed, secret: SECRET });
  t.after(() => serverA.close());
  t.after(() => serverB.close());

  for (let i = 0; i < 3; i++) a.fed.recordSet(`ka${i}`, `va${i}`);
  for (let i = 0; i < 3; i++) b.fed.recordSet(`kb${i}`, `vb${i}`);

  // Round 1 — no endpoint watermark exists: each direction ships its FULL log.
  const aToB = await syncOverHttp(a.fed, serverB.url, SECRET);
  assert.equal(aToB.sent, 3, "first push ships A's whole log — no watermark exists yet");
  assert.equal(aToB.received, 3, "first pull receives B's whole log");
  assert.equal(aToB.converged, true, 'A matches the server digest after the round');
  const bToA = await syncOverHttp(b.fed, serverA.url, SECRET);
  assert.equal(bToA.converged, true);
  assert.equal(
    a.fed.fingerprint(),
    b.fed.fingerprint(),
    'both palaces hold the same CRDT state after one round each way',
  );

  // The endpoint watermark persisted in palace_meta — keyed by the
  // endpoint's FULL host+path identity: starts at crdt:http-wm:<host:port>
  // and carries the route path (proxy-prefix-aware, IPv6 brackets come
  // free from WHATWG u.host).
  const wmKey = `crdt:http-wm:127.0.0.1:${serverB.port}/federation/crdt`;
  assert.ok(
    wmKey.startsWith('crdt:http-wm:127.0.0.1:'),
    'watermark key starts with the host:port identity',
  );
  assert.ok(wmKey.includes('/federation/crdt'), 'watermark key includes the route path');
  assert.ok(
    a.store.getMeta(wmKey),
    'A persisted its belief of what the B endpoint holds',
  );

  // Round 2 — 2 new ops per side: the round ships EXACTLY the 2+2 delta.
  for (let i = 0; i < 2; i++) a.fed.recordSet(`ka2-${i}`, `va2-${i}`);
  for (let i = 0; i < 2; i++) b.fed.recordSet(`kb2-${i}`, `vb2-${i}`);
  const aToB2 = await syncOverHttp(a.fed, serverB.url, SECRET);
  assert.equal(aToB2.sent, 2, "second push ships ONLY A's 2 new ops");
  assert.equal(aToB2.received, 2, "second pull receives ONLY B's 2 new ops");
  assert.equal(aToB2.converged, true);
  const bToA2 = await syncOverHttp(b.fed, serverA.url, SECRET);
  assert.equal(bToA2.converged, true, 'reverse direction converges too');
  // B's push re-ships A's 2 ops learned in the previous round (its endpoint
  // belief is one exchange older) — redundant by dedup, never divergent.
  assert.equal(a.fed.fingerprint(), b.fed.fingerprint());
  assert.equal(a.fed.exportOps().length, 10, 'the 10-op union on both sides');
  assert.equal(b.fed.exportOps().length, 10);

  // Round 3 — steady state: no new writes, both directions ship nothing.
  const aToB3 = await syncOverHttp(a.fed, serverB.url, SECRET);
  assert.equal(aToB3.converged, true);
  assert.equal(aToB3.sent, 0, 'steady-state delta is empty');
  assert.equal(aToB3.received, 0);
  const bToA3 = await syncOverHttp(b.fed, serverA.url, SECRET);
  assert.equal(bToA3.converged, true);
  assert.equal(bToA3.sent, 0);
  assert.equal(bToA3.received, 0);

  // Corrupt persisted watermark → parse fallback reads {} → FULL re-send
  // (the loadPeerWatermark defect law, endpoint-flavored).
  a.store.setMeta(wmKey, '{not json');
  const aToB4 = await syncOverHttp(a.fed, serverB.url, SECRET);
  assert.equal(aToB4.converged, true, 'corrupt watermark falls back to full exchange');
  assert.equal(aToB4.sent, 10, 'A re-shipped its ENTIRE 10-op log');
});

test('http transport: wrong secret is rejected with 401', async (t) => {
  const { dir, cleanup } = tempDir();
  const a = fedPair(t, dir, 'auth-a');
  t.after(cleanup);
  const server = await createCrdtServer({ crdt: a.fed, secret: SECRET });
  t.after(() => server.close());
  a.fed.recordSet('k', 'v');

  await assert.rejects(syncOverHttp(a.fed, server.url, 'not-the-secret'), /401/);
});

test('http transport: oversized bodies are refused with 413', async (t) => {
  const { dir, cleanup } = tempDir();
  const a = fedPair(t, dir, 'cap-a');
  const b = fedPair(t, dir, 'cap-b');
  t.after(cleanup);
  const server = await createCrdtServer({ crdt: b.fed, secret: SECRET, maxBodyBytes: 64 });
  t.after(() => server.close());
  for (let i = 0; i < 3; i++) a.fed.recordSet(`k${i}`, 'v'.repeat(40));

  await assert.rejects(syncOverHttp(a.fed, server.url, SECRET), /413/);
});

test('http transport: server close is idempotent', async (t) => {
  const { dir, cleanup } = tempDir();
  const a = fedPair(t, dir, 'close-a');
  t.after(cleanup);
  const server = await createCrdtServer({ crdt: a.fed, secret: SECRET });
  a.fed.recordSet('k', 'v');
  await syncOverHttp(a.fed, server.url, SECRET); // open (and pool) a socket

  await server.close();
  await server.close(); // second close resolves instead of throwing
  // The endpoint is really gone: a further exchange fails to connect.
  await assert.rejects(syncOverHttp(a.fed, server.url, SECRET));
});

test('remoteCrdtPeer: adapter delegates to local and fits the widened sync signature', async (t) => {
  const { dir, cleanup } = tempDir();
  const x = fedPair(t, dir, 'ad-x');
  const y = fedPair(t, dir, 'ad-y');
  t.after(cleanup);
  x.fed.recordSet('kx1', 'vx1');
  x.fed.recordSet('kx2', 'vx2');
  y.fed.recordSet('ky1', 'vy1');
  y.fed.recordSet('ky2', 'vy2');
  const serverY = await createCrdtServer({ crdt: y.fed, secret: SECRET });
  t.after(() => serverY.close());

  // Wrong secret rejects at construction (handshake round → 401).
  await assert.rejects(remoteCrdtPeer(serverY.url, 'wrong-secret', { local: y.fed }), /401/);

  const adapter = await remoteCrdtPeer(serverY.url, SECRET, { local: y.fed });
  assert.equal(adapter.replicaId, y.fed.replicaId, 'identity delegates to local');
  assert.deepEqual(adapter.opsSince({}), y.fed.exportOps(), 'delta export delegates to local');

  // sync()'s parameter is the CrdtPeer INTERFACE — the adapter is accepted
  // without being a CrdtFederation, and the exchange still converges.
  const report = x.fed.sync(adapter);
  assert.equal(report.converged, true);
  assert.equal(x.fed.fingerprint(), y.fed.fingerprint());
  assert.equal(x.fed.exportOps().length, 4, 'the 4-op union on both sides');
});
