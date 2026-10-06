/**
 * Federation HTTP transport acceptance: real loopback server on an
 * ephemeral port — HMAC request signing (missing/wrong/valid), the
 * retrieval round trip with default embedding stripping and the
 * includeEmbeddings opt-in, server-face scope sovereignty, the 4 MiB
 * body cap, routing (404/405), member-side timeout, error containment
 * (500 without a stack), FederatedRetriever integration over the wire,
 * and idempotent close.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  createFederationServer,
  httpFederationMember,
  searchEndpoint,
} from '../src/transport/http.ts';
import { FederatedRetriever } from '../src/services/federated-retriever.ts';
import type {
  MemoryItem,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
} from '../src/types/index.ts';

const SECRET = 'transport-test-secret';

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
}

function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(body, 'utf8'),
  });
}

/** Fixed hit with a float32-exact embedding (0.25/0.5/0.75 survive the round trip). */
function fixedHit(id: string, content: string, withEmbedding: boolean): RetrievalHit {
  const item: MemoryItem = {
    id,
    layer: 'semantic',
    content,
    embedding: withEmbedding ? new Float32Array([0.25, 0.5, 0.75]) : undefined,
    metadata: {
      source: 'tool',
      tokenCount: 9,
      ...(withEmbedding ? { embeddingSpace: 'test-space' } : {}),
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    importance: 0.8,
    accessCount: 0,
    lastAccessedAt: 0,
  };
  return {
    item,
    rawScore: 0.9,
    score: 0.85,
    mmrRank: 1,
    finalScore: 0.85,
    scopeLevel: 0,
    via: 'vector',
  };
}

function stubMember(
  hits: RetrievalHit[],
  opts: { delayMs?: number; error?: Error } = {},
): { member: { name: string; retrieve(q: RetrievalQuery): Promise<RetrievalResult> }; captured: RetrievalQuery[] } {
  const captured: RetrievalQuery[] = [];
  return {
    captured,
    member: {
      name: 'stub',
      async retrieve(q: RetrievalQuery): Promise<RetrievalResult> {
        captured.push(q);
        if (opts.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        }
        if (opts.error) throw opts.error;
        return {
          hits,
          totalTokens: 9,
          elapsedMs: 1,
          debug: { vectorRecall: hits.length, rerankBoosted: 0, scopeLevel: 1 },
        };
      },
    },
  };
}

test('transport: signature gate — missing and wrong signatures are 401, valid is 200', async (t) => {
  const { member } = stubMember([]);
  const server = await createFederationServer({ member, secret: SECRET });
  t.after(() => server.close());

  assert.ok(server.url.startsWith('http://127.0.0.1:'), `loopback url (${server.url})`);
  assert.ok(server.port > 0, 'concrete ephemeral port');

  const body = JSON.stringify({ query: { query: 'mesh routing', topK: 3 } });

  const noSig = await post(`${server.url}/federation/search`, body);
  assert.equal(noSig.status, 401, 'no signature → 401');
  assert.equal((await noSig.json() as { error?: string }).error, 'unauthorized');

  const badSig = await post(`${server.url}/federation/search`, body, {
    'x-palace-signature': sign('wrong-secret', body),
  });
  assert.equal(badSig.status, 401, 'wrong secret → 401');

  const okSig = await post(`${server.url}/federation/search`, body, {
    'x-palace-signature': sign(SECRET, body),
  });
  assert.equal(okSig.status, 200, 'valid signature → 200');
  // Every response carries an explicit JSON content-length.
  assert.ok(Number(okSig.headers.get('content-length')) > 0, 'content-length set');
});

test('transport: round trip — embeddings stripped by default, kept on opt-in', async (t) => {
  const hit = fixedHit('it-1', 'Aurora mesh routes east-west traffic through Envoy sidecars.', true);
  const { member } = stubMember([hit]);
  const server = await createFederationServer({ member, secret: SECRET });
  t.after(() => server.close());

  const body = JSON.stringify({ query: { query: 'mesh routing', topK: 3 } });
  const stripped = await post(`${server.url}/federation/search`, body, {
    'x-palace-signature': sign(SECRET, body),
  });
  assert.equal(stripped.status, 200);
  const p1 = await stripped.json() as { hits: Array<{ item: Record<string, unknown> }>; totalTokens: number };
  assert.equal(p1.hits.length, 1);
  assert.equal(p1.hits[0]!.item['embedding'], undefined, 'embedding stripped by default');
  assert.match(String(p1.hits[0]!.item['content']), /Envoy/);
  assert.equal(p1.totalTokens, 9);

  const withEmb = JSON.stringify({
    query: { query: 'mesh routing', topK: 3 },
    includeEmbeddings: true,
  });
  const kept = await post(`${server.url}/federation/search`, withEmb, {
    'x-palace-signature': sign(SECRET, withEmb),
  });
  assert.equal(kept.status, 200);
  const p2 = await kept.json() as { hits: Array<{ item: Record<string, unknown> }> };
  assert.deepEqual(p2.hits[0]!.item['embedding'], [0.25, 0.5, 0.75], 'opt-in keeps the vector');
});

test('transport: server-face scope sovereignty — incoming scopes never reach the member', async (t) => {
  const serveScope = { userId: 'server-side-user' };
  const { member, captured } = stubMember([fixedHit('it-2', 'scoped content', false)]);
  const server = await createFederationServer({ member, secret: SECRET, serveScope });
  t.after(() => server.close());

  // 1. A raw wire query that smuggles a hostile scope is overridden.
  const smuggled = JSON.stringify({
    query: { query: 'mesh', topK: 2, scope: { userId: 'attacker', sessionId: 'sneak' } },
  });
  const r1 = await post(`${server.url}/federation/search`, smuggled, {
    'x-palace-signature': sign(SECRET, smuggled),
  });
  assert.equal(r1.status, 200);

  // 2. The typed member client (which strips scope before sending).
  const remote = httpFederationMember(server.url, SECRET);
  await remote.retrieve({ query: 'mesh', scope: { userId: 'caller' } });

  assert.equal(captured.length, 2);
  for (const q of captured) {
    assert.deepEqual(q.scope, serveScope, 'member always executes under serveScope');
  }
  // Non-scope knobs survive the boundary.
  assert.equal(captured[0]!.topK, 2);
  assert.equal(captured[0]!.query, 'mesh');
});

test('transport: body over 4 MiB is rejected 413', async (t) => {
  const { member } = stubMember([]);
  const server = await createFederationServer({ member, secret: SECRET });
  t.after(() => server.close());

  const big = JSON.stringify({ query: { query: 'x'.repeat(4 * 1024 * 1024 + 64) } });
  const res = await post(`${server.url}/federation/search`, big, {
    'x-palace-signature': sign(SECRET, big),
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json() as { error?: string }).error, 'payload too large');
});

test('transport: routing — unknown path 404, wrong method 405', async (t) => {
  const { member } = stubMember([]);
  const server = await createFederationServer({ member, secret: SECRET });
  t.after(() => server.close());

  const unknown = await fetch(`${server.url}/no/such/route`);
  assert.equal(unknown.status, 404);

  const wrongMethod = await fetch(`${server.url}/federation/search`); // GET
  assert.equal(wrongMethod.status, 405);
});

test('transport: member client timeout — hanging server, 300ms budget', async (t) => {
  const { member } = stubMember([], { delayMs: 2000 });
  const server = await createFederationServer({ member, secret: SECRET });
  t.after(() => server.close());

  const remote = httpFederationMember(server.url, SECRET, { timeoutMs: 300 });
  await assert.rejects(
    () => remote.retrieve({ query: 'hang' }),
    (err: unknown) =>
      err instanceof Error && /timeout|abort/i.test(err.message),
    'client-side timeout surfaces as a rejection',
  );
});

test('transport: member failure maps to 500 with message but no stack', async (t) => {
  const { member } = stubMember([], { error: new Error('retriever exploded') });
  const server = await createFederationServer({ member, secret: SECRET });
  t.after(() => server.close());

  const body = JSON.stringify({ query: { query: 'boom' } });
  const res = await post(`${server.url}/federation/search`, body, {
    'x-palace-signature': sign(SECRET, body),
  });
  assert.equal(res.status, 500);
  const payload = await res.json() as { error?: string };
  assert.match(payload.error ?? '', /retriever exploded/);
  assert.ok(!String(payload.error).includes('    at '), 'no stack frames leaked');

  // Through the typed member the 500 becomes a thrown Error with status + digest.
  const remote = httpFederationMember(server.url, SECRET);
  await assert.rejects(
    () => remote.retrieve({ query: 'boom' }),
    (err: unknown) =>
      err instanceof Error && /HTTP 500/.test(err.message) && /retriever exploded/.test(err.message),
  );
});

test('transport: FederatedRetriever integration — remote member over HTTP', async (t) => {
  const remoteHit = fixedHit('r-1', 'Grafana dashboards for the observability stack alert on SLO burn rate.', false);
  const { member } = stubMember([remoteHit]);
  const server = await createFederationServer({
    member,
    secret: SECRET,
    serveScope: { userId: 'u-fed' },
  });
  t.after(() => server.close());

  const local = stubMember([fixedHit('l-1', 'Local palace keeps the deployment runbook.', false)]).member;
  const fed = new FederatedRetriever([
    { name: 'local', retrieve: (q) => local.retrieve(q) },
    httpFederationMember(server.url, SECRET, { name: 'remote-observ' }),
  ]);

  const res = await fed.retrieve({ query: 'grafana slo burn rate runbook', topK: 4 });
  assert.ok(res.hits.length >= 2, `merged hits (got ${res.hits.length})`);
  const grafana = res.hits.find((h) => /Grafana/.test(h.content));
  assert.equal(grafana?.sourcePalace, 'remote-observ', 'remote content carries its palace name');
  const runbook = res.hits.find((h) => /runbook/.test(h.content));
  assert.equal(runbook?.sourcePalace, 'local', 'local content keeps its palace name');
  assert.deepEqual(res.degradedMembers, [], 'no member degraded');
});

test('transport: member client includeEmbeddings — vectors revived as Float32Array, stripped by default', async (t) => {
  const hit = fixedHit('it-emb', 'Vector-bearing content for cross-palace MMR.', true);
  const { member } = stubMember([hit]);
  const server = await createFederationServer({ member, secret: SECRET });
  t.after(() => server.close());

  const withVectors = httpFederationMember(server.url, SECRET, { includeEmbeddings: true });
  const kept = await withVectors.retrieve({ query: 'vectors' });
  const emb = kept.hits[0]!.item.embedding;
  assert.ok(emb instanceof Float32Array, 'revived embedding is a Float32Array');
  assert.deepEqual(Array.from(emb), [0.25, 0.5, 0.75], 'vector survives the round trip');

  const byDefault = httpFederationMember(server.url, SECRET);
  const plain = await byDefault.retrieve({ query: 'vectors' });
  assert.equal(plain.hits[0]!.item.embedding, undefined, 'default member options strip the vector');
});

test('transport: searchEndpoint keeps the base path prefix (reverse-proxy deployments)', () => {
  assert.equal(
    searchEndpoint('http://host:1/base/path/'),
    'http://host:1/base/path/federation/search',
    'trailing slash on the prefix',
  );
  assert.equal(
    searchEndpoint('http://host:1/base/path'),
    'http://host:1/base/path/federation/search',
    'no trailing slash on the prefix',
  );
  assert.equal(
    searchEndpoint('http://host:1/base/path/?leftover=1#frag'),
    'http://host:1/base/path/federation/search',
    'query and hash are dropped',
  );
  assert.equal(
    searchEndpoint('http://host:1'),
    'http://host:1/federation/search',
    'bare origin collapses onto the route',
  );
});

test('transport: close is idempotent', async () => {
  const { member } = stubMember([]);
  const server = await createFederationServer({ member, secret: SECRET });
  const { port } = server;
  // The silent transport-noise counter is observable on the handle: a
  // transportErrors() function readable any time before close().
  assert.equal(typeof server.transportErrors, 'function', 'handle exposes transportErrors()');
  assert.ok(server.transportErrors() >= 0, 'counter is a non-negative number');
  await server.close();
  await server.close(); // second call resolves immediately
  // The ephemeral port is released: a fresh bind on the same port succeeds.
  const again = await createFederationServer({ member, secret: SECRET, port });
  await again.close();
});
