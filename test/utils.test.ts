/**
 * Focused unit tests for individual services. These run without a database
 * where possible to keep them fast.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkText } from '../src/utils/chunker.ts';
import { tokenize, approximateTokenCount, truncateToTokens } from '../src/utils/tokenizer.ts';
import {
  OfflineBM25EmbeddingProvider,
  ResilientEmbeddingProvider,
  createEmbeddingProvider,
  cosine,
} from '../src/utils/embedding.ts';
import { CircuitBreaker } from '../src/utils/circuit-breaker.ts';
import { classify, extract } from '../src/services/memory-graph.ts';

test('chunkText respects markdown boundaries', () => {
  const md = `# Heading One

First paragraph under heading one. It has multiple sentences. The chunker should keep these together.

## Heading Two

Second section starts here.

\`\`\`ts
const a = 1;
const b = 2;
\`\`\`

After the code block.`;

  const chunks = chunkText(md, { maxTokens: 32, overlapTokens: 8, minTokens: 4 });
  assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
  // Code block should be its own chunk
  assert.ok(
    chunks.some((c) => c.text.includes('const a = 1')),
    'code block preserved',
  );
  // Headings should anchor chunks
  assert.ok(chunks[0].text.includes('Heading One'), 'first chunk under H1');
});

test('chunkText separates the code block from following prose', () => {
  const md = 'Intro paragraph here.\n\n```ts\nconst a = 1;\n```\n\nAfter the code block.';
  const chunks = chunkText(md, { maxTokens: 32, overlapTokens: 8, minTokens: 2 });
  const codeChunk = chunks.find((c) => c.text.includes('const a = 1'));
  assert.ok(codeChunk, 'code chunk exists');
  assert.ok(
    !codeChunk!.text.includes('After the code block'),
    'prose after closing fence is a separate chunk',
  );
  assert.ok(
    chunks.some((c) => c.text.includes('After the code block')),
    'prose chunk exists',
  );
});

test('chunker startChar/endChar stay inside the source and ordered', () => {
  const text =
    'Alice met Bob at the station. They discussed PostgreSQL deployment. ' +
    'Later Bob mentioned Kubernetes and pgvector. The plan was written down. ' +
    'Everyone agreed on the next steps forward for the migration effort.';
  const chunks = chunkText(text, { maxTokens: 10, overlapTokens: 2, minTokens: 1 });
  assert.ok(chunks.length >= 2, 'multiple windows');
  let prevEnd = -1;
  for (const c of chunks) {
    assert.ok(c.startChar >= 0 && c.endChar <= text.length, 'offsets in bounds');
    assert.ok(c.startChar < c.endChar, 'non-empty span');
    // Windows advance monotonically (overlap allowed, but never backwards).
    assert.ok(c.startChar >= Math.max(0, prevEnd - 64), 'monotonic advance');
    assert.ok(c.endChar >= prevEnd, 'end never regresses');
    prevEnd = c.endChar;
  }
});

test('approximateTokenCount is roughly linear with text length', () => {
  const short = approximateTokenCount('hello world');
  const long = approximateTokenCount('hello world '.repeat(50));
  assert.ok(short >= 2 && short <= 4, 'short text token count reasonable');
  assert.ok(long > short * 10, 'long text scales with length');
});

test('truncateToTokens never overshoots', () => {
  const big = ('one two three four five six seven eight nine ten ').repeat(20).trim();
  const cut = truncateToTokens(big, 10);
  assert.ok(approximateTokenCount(cut) <= 12, 'within tolerance');
});

test('OfflineBM25EmbeddingProvider produces normalized vectors', async () => {
  const provider = new OfflineBM25EmbeddingProvider(64);
  const v = await provider.embed('Hello world hello');
  assert.equal(v.length, 64);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  assert.ok(Math.abs(sum - 1) < 1e-5, 'unit-normalized');
});

test('cosine similarity is high for similar, low for different', async () => {
  const provider = new OfflineBM25EmbeddingProvider(128);
  const a = await provider.embed('PostgreSQL pgvector similarity search');
  const b = await provider.embed('Postgres pgvector similarity lookup');
  const c = await provider.embed('Pasta carbonara recipe ingredients');
  assert.ok(cosine(a, b) > cosine(a, c), 'similar text scores higher');
});

test('tokenize drops very short tokens', () => {
  const toks = tokenize('I am a I and a');
  assert.ok(!toks.includes('i'));
  assert.ok(!toks.includes('a'));
});

test('CircuitBreaker opens after threshold and half-opens after cooldown', () => {
  let clock = 1000;
  const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 500, now: () => clock });

  assert.equal(breaker.currentState, 'closed');
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'closed', 'still closed below threshold');
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'open', 'open at threshold');

  assert.equal(breaker.canAttempt(), false, 'no attempts while open');
  clock += 501;
  assert.equal(breaker.currentState, 'half-open', 'half-open after cooldown');
  assert.equal(breaker.canAttempt(), true, 'probe allowed in half-open');

  breaker.recordFailure(); // probe fails → re-open
  assert.equal(breaker.currentState, 'open');
  clock += 501;
  assert.equal(breaker.canAttempt(), true);
  breaker.recordSuccess(); // probe succeeds → closed
  assert.equal(breaker.currentState, 'closed');
});

test('offline provider embedIn is space-scoped', async () => {
  const gateway = createEmbeddingProvider({
    provider: 'offline-bm25',
    model: 'bm25',
    dimensions: 128,
  });
  const space = gateway.spaces()[0];
  assert.ok(space.startsWith('offline-bm25:'), `space tagged, got ${space}`);
  const v = await gateway.embedIn(space, 'hello world');
  assert.ok(v && v.length === 128, 'embeds in own space');
  const none = await gateway.embedIn('deepseek:some-model', 'hello world');
  assert.equal(none, null, 'foreign space returns null');
});

test('extract carries hints and classify maps them', () => {
  const found = extract('Ping @alice about src/app.ts and see https://example.com docs.');
  const names = new Map(found.map((f) => [f.name, f.hint]));
  assert.equal(names.get('alice'), 'handle', '@-mention keeps person hint');
  assert.equal(names.get('src/app.ts'), 'path', 'file path hint');
  assert.equal(names.get('https://example.com'), 'url', 'url hint');

  assert.equal(classify('alice', 'handle'), 'person');
  assert.equal(classify('src/app.ts', 'path'), 'file');
  assert.equal(classify('TODO', 'ident'), 'other', 'acronyms are other');
  assert.equal(classify('Postgres', 'ident'), 'concept');
});

// ---------------------------------------------------------------- v2 modules

import { parseQueryHints } from '../src/utils/query-understanding.ts';
import { clusterByConsensus, detectConflict } from '../src/utils/consensus.ts';
import { labelPropagation } from '../src/utils/communities.ts';
import { buildAdjacency, shortestPath } from '../src/utils/graph-paths.ts';
import { duplicationRatio, gini, median } from '../src/utils/health.ts';

const NOW = 1_700_000_000_000;

test('parseQueryHints extracts temporal windows, phrases and topK', () => {
  const h1 = parseQueryHints('what did we decide last week about "pgvector"?', NOW);
  assert.equal(h1.sinceMs, NOW - 14 * DAY, 'last week window');
  assert.equal(h1.untilMs, NOW - 7 * DAY, 'last week ends a week ago');
  assert.deepEqual(h1.phrases, ['pgvector'], 'quoted phrase captured');

  const h2 = parseQueryHints('最近 3 天 部署了什么', NOW);
  assert.equal(h2.sinceMs, NOW - 3 * DAY, 'Chinese temporal window');
  assert.equal(h2.wantsRecent, true, 'recency idiom flagged');

  const h3 = parseQueryHints('show me the top 20 decisions', NOW);
  assert.equal(h3.topK, 20, 'topK parsed');

  const h4 = parseQueryHints('random question with no signals', NOW);
  assert.equal(h4.sinceMs, undefined, 'no false temporal window');
  assert.deepEqual(h4.phrases, [], 'no false phrases');
});

test('detectConflict flags version drift and negation flips', () => {
  const v16 = { id: 'a', content: 'We run PostgreSQL 16 in production.', score: 1 };
  const v16b = { id: 'b', content: 'Production uses PostgreSQL 16.', score: 1 };
  const v17 = { id: 'c', content: 'We run PostgreSQL 17 in production.', score: 1 };
  const neg = { id: 'd', content: 'We do not run Kafka in production.', score: 1 };
  const pos = { id: 'e', content: 'We run Kafka in production.', score: 1 };

  assert.equal(detectConflict(v16, v16b).conflict, false, 'same version corroborates');
  assert.equal(detectConflict(v16, v17).conflict, true, 'version drift conflicts');
  assert.equal(detectConflict(neg, pos).conflict, true, 'polarity flip conflicts');
});

test('clusterByConsensus grades corroboration', async () => {
  const provider = new OfflineBM25EmbeddingProvider(256);
  const base = 'The gateway service is deployed with blue-green releases.';
  const items = [
    {
      id: '1',
      content: base,
      embedding: await provider.embed(base),
      score: 0.8,
    },
    {
      id: '2',
      content: `${base} Verified twice.`,
      embedding: await provider.embed(`${base} Verified twice.`),
      score: 0.7,
    },
    {
      id: '3',
      content: 'Lunch options near the office include ramen and pho.',
      embedding: await provider.embed('Lunch options near the office include ramen and pho.'),
      score: 0.6,
    },
  ];
  const clusters = clusterByConsensus(items, { similarityThreshold: 0.6 });
  assert.ok(clusters.length >= 2, 'unrelated item separated');
  const gateway = clusters.find((c) => c.representative.id === '1');
  assert.ok(gateway, 'gateway cluster exists');
  assert.ok(gateway!.members.length >= 2, 'corroborating statements merged');
  assert.ok(gateway!.agreement > 0.5, 'agreement graded');
  assert.equal(gateway!.conflict, false, 'no false conflict');
});

test('labelPropagation finds communities deterministically', () => {
  // Two cliques bridged by a single weak edge.
  const nodes = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'];
  const clique = (xs: string[], w = 5) =>
    xs.flatMap((x, i) => xs.slice(i + 1).map((y) => ({ a: x, b: y, weight: w })));
  const edges = [...clique(nodes.slice(0, 3)), ...clique(nodes.slice(3)), { a: 'a3', b: 'b1', weight: 1 }];

  const r1 = labelPropagation(nodes, edges);
  const r2 = labelPropagation(nodes, edges);
  assert.equal(r1.communities.length, 2, 'two communities found');
  assert.deepEqual(
    [...r1.labels.entries()].sort(),
    [...r2.labels.entries()].sort(),
    'deterministic across runs',
  );
  assert.ok(r1.cohesion > 0.8, `cohesive partition (got ${r1.cohesion})`);
  assert.notEqual(r1.labels.get('a1'), r1.labels.get('b1'), 'cliques separated');
});

test('shortestPath routes through co-occurrence chains', () => {
  const edges = [
    { from: 'kafka', to: 'flink' },
    { from: 'flink', to: 'clickhouse' },
    { from: 'clickhouse', to: 'grafana' },
    { from: 'flink', to: 'redis' },
  ];
  const adj = buildAdjacency(edges);
  const path = shortestPath(adj, 'kafka', 'grafana');
  assert.deepEqual(path, ['kafka', 'flink', 'clickhouse', 'grafana'], '3-hop pipeline route');
  assert.deepEqual(shortestPath(adj, 'kafka', 'kafka'), ['kafka'], 'same node handled');
  assert.equal(shortestPath(adj, 'kafka', 'unknown'), null, 'unknown node → null');
  assert.equal(shortestPath(adj, 'kafka', 'redis', 1), null, 'depth cap respected');
});

test('health metrics: gini, median, duplicationRatio', async () => {
  assert.equal(gini([1, 1, 1, 1]), 0, 'perfect equality → 0');
  assert.ok(gini([0, 0, 0, 10]) > 0.7, 'monoculture → high gini');
  assert.equal(median([1, 2, 3, 4]), 2.5, 'median interpolates');
  assert.equal(median([5, 1, 3]), 3, 'median sorts');

  const provider = new OfflineBM25EmbeddingProvider(256);
  const v = await provider.embed('identical content here');
  const w = await provider.embed('identical content here');
  const x = await provider.embed('completely different topic words');
  // 3 pairs: (v,w) clone; (v,x),(w,x) distinct → ratio ≈ 1/3
  const ratio = duplicationRatio([v, w, x], { pairLimit: 100 });
  assert.ok(Math.abs(ratio - 1 / 3) < 0.01, `duplication ratio ≈ 1/3 (got ${ratio.toFixed(3)})`);
});

// ------------------------------------------------------- scope ACL + PageRank

import {
  buildTierCondition,
  resolveWriteTier,
  scopeLevels,
  tierDisjunction,
  widestLevel,
} from '../src/utils/scope.ts';
import { normalizeRanks, pageRank } from '../src/utils/pagerank.ts';

const DAY = 86_400_000;

test('scopeLevels builds cumulative visibility cascades', () => {
  const ids = { userId: 'u1', workspaceId: 'ws1', sessionId: 's1' };

  const userLevels = scopeLevels('user', ids);
  assert.equal(userLevels.length, 2, 'user kind: own tier then +global');
  assert.match(userLevels[0].sql, /visibility = 'user' AND user_id = \?/);
  assert.match(userLevels[0].sql, /^ AND \(/, 'leading AND + paren');
  assert.ok(!userLevels[0].sql.includes("'global'"), 'narrow level excludes global');
  assert.match(userLevels[1].sql, /OR.*'global'/, 'wide level ORs in global');

  const sessionLevels = scopeLevels('session', ids);
  assert.equal(sessionLevels.length, 4, 'session cascade: 4 cumulative levels');
  assert.match(sessionLevels[0].sql, /visibility = 'session' AND session_id = \?/);
  assert.match(sessionLevels[1].sql, /'session'.*'workspace'/s, 'level 2 adds workspace');
  assert.match(sessionLevels[2].sql, /'session'.*'workspace'.*'user'/s, 'level 3 adds user');
  assert.match(sessionLevels[3].sql, /'global'/, 'level 4 adds global');

  // Anonymous caller: global only — never another user's memories.
  const anon = scopeLevels('user', {});
  assert.equal(anon.length, 1, 'anonymous gets one level');
  assert.match(anon[0].sql, /visibility = 'global'/);
  assert.ok(!anon[0].sql.includes("visibility = 'user'"), 'no user tier without identity');

  // Missing session id degrades: no empty level, cascade still coherent.
  const noSession = scopeLevels('session', { userId: 'u1' });
  assert.ok(noSession.length >= 2, 'degraded cascade still widens');
  assert.ok(noSession.every((l) => !l.sql.includes("'session'")), 'session tier dropped');
});

test('resolveWriteTier degrades tiers with missing owner ids', () => {
  assert.equal(resolveWriteTier('session', { userId: 'u1' }), 'user');
  assert.equal(resolveWriteTier('workspace', { userId: 'u1' }), 'user');
  assert.equal(resolveWriteTier('user', {}), 'global');
  assert.equal(resolveWriteTier('session', { sessionId: 's', userId: 'u' }), 'session');
  assert.equal(resolveWriteTier('global', {}), 'global');
});

test('tierDisjunction yields standalone WHERE bodies', () => {
  const d = tierDisjunction(['user', 'global'], { userId: 'u1' });
  assert.ok(d, 'disjunction built');
  assert.ok(!d!.sql.startsWith(' AND'), 'no leading AND');
  assert.match(d!.sql, /'user'.*'global'/s);
  assert.equal(tierDisjunction(['session'], {}), null, 'unusable tier → null');
  assert.equal(buildTierCondition('user', {}), null, 'single unusable tier → null');
});

test('weighted PageRank routes mass through heavy edges', () => {
  // s splits outflow: x gets weight 1, y gets weight 10 → y drains more
  // of s's rank (weight only matters where out-edges COMPETE).
  const nodes = ['s', 'x', 'y'];
  const edges = [
    { from: 's', to: 'x', weight: 1 },
    { from: 's', to: 'y', weight: 10 },
  ];
  const r = pageRank(nodes, edges, { iterations: 30 });
  let mass = 0;
  for (const v of r.values()) mass += v;
  assert.ok(Math.abs(mass - 1) < 0.01, `mass conserved (${mass.toFixed(4)})`);
  assert.ok(r.get('y')! > r.get('x')!, 'heavy out-edge drains more rank');

  const norm = normalizeRanks(r);
  let max = 0;
  for (const v of norm.values()) if (v > max) max = v;
  assert.ok(Math.abs(max - 1) < 1e-9, 'normalized max = 1');
});

test('personalized PageRank concentrates rank near seeds', () => {
  // Two stars bridged: A-center—B-center. Seeding A side should rank
  // A-center above B-center even though the graph is symmetric.
  const nodes = ['a1', 'a2', 'aHub', 'bHub', 'b1', 'b2'];
  const edges: Array<{ from: string; to: string; weight: number }> = [];
  for (const leaf of ['a1', 'a2']) {
    edges.push({ from: leaf, to: 'aHub', weight: 1 }, { from: 'aHub', to: leaf, weight: 1 });
  }
  for (const leaf of ['b1', 'b2']) {
    edges.push({ from: leaf, to: 'bHub', weight: 1 }, { from: 'bHub', to: leaf, weight: 1 });
  }
  edges.push({ from: 'aHub', to: 'bHub', weight: 1 }, { from: 'bHub', to: 'aHub', weight: 1 });

  const classic = pageRank(nodes, edges, { iterations: 40 });
  assert.ok(
    Math.abs(classic.get('aHub')! - classic.get('bHub')!) < 1e-6,
    'symmetric graph → symmetric classic PR',
  );

  const ppr = pageRank(nodes, edges, { iterations: 40, seeds: ['a1'] });
  assert.ok(ppr.get('aHub')! > ppr.get('bHub')!, 'seed side hub outranks far hub');
  assert.ok(ppr.get('a1')! >= ppr.get('b1')!, 'seed outranks distant leaf');
  let mass = 0;
  for (const v of ppr.values()) mass += v;
  assert.ok(Math.abs(mass - 1) < 0.01, 'PPR mass conserved');
});

test('temporal decay fades stale edges', () => {
  const now = Date.now();
  // s splits equal-weight outflow to a fresh and a stale path; decay
  // starves the stale path of s's rank.
  const nodes = ['s', 'fp', 'sp'];
  const edges = [
    { from: 's', to: 'fp', weight: 5, lastSeenAt: now },
    { from: 's', to: 'sp', weight: 5, lastSeenAt: now - 365 * DAY },
  ];
  const r = pageRank(nodes, edges, { iterations: 30, edgeDecayDays: 30, now });
  assert.ok(r.get('fp')! > r.get('sp')!, 'fresh path drains more rank under decay');
  // Decay disabled: equal split
  const r2 = pageRank(nodes, edges, { iterations: 30, edgeDecayDays: 0, now });
  assert.ok(Math.abs(r2.get('fp')! - r2.get('sp')!) < 1e-9, 'no decay → equal split');
});

// ------------------------------------------------ strict-progress + resilience

test('chunker makes strict forward progress when overlapTokens exceeds the window', () => {
  const text = 'a b c d e f. g h i j k. l m n o p. q r s t u.';
  // overlapTokens deliberately larger than every window: without the
  // full-duplicate-overlap cap in tailTokens, the "overlap" handed to the
  // next window is the ENTIRE previous window and consecutive chunks go
  // verbatim-duplicate with zero startChar progress.
  const chunks = chunkText(text, { maxTokens: 4, overlapTokens: 8, minTokens: 1 });
  assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);

  for (const c of chunks) {
    assert.ok(c.startChar >= 0 && c.endChar <= text.length, 'offsets within bounds');
    assert.ok(c.startChar < c.endChar, 'non-empty span');
  }
  for (let i = 0; i + 1 < chunks.length; i++) {
    assert.notEqual(chunks[i].text, chunks[i + 1].text, `pair ${i}: adjacent chunks never identical`);
    assert.ok(
      chunks[i + 1].startChar > chunks[i].startChar,
      `pair ${i}: strict forward progress (${chunks[i].startChar} → ${chunks[i + 1].startChar})`,
    );
  }
});

test('embedBatchTagged serves the whole batch from a single space', async () => {
  const gateway = createEmbeddingProvider({
    provider: 'offline-bm25',
    model: 'bm25',
    dimensions: 128,
  });
  const tagged = await gateway.embedBatchTagged(['one two', 'three four']);

  assert.equal(tagged.length, 2, 'one tagged embedding per input');
  const expectedSpace = gateway.spaces()[0];
  assert.equal(tagged[0].space, tagged[1].space, 'spaces identical across the batch');
  for (const t of tagged) {
    assert.equal(t.space, expectedSpace, 'batch served by exactly one space');
    assert.equal(t.vector.length, 128, 'vector width is the configured 128');
    let sum = 0;
    for (let i = 0; i < t.vector.length; i++) sum += t.vector[i] * t.vector[i];
    assert.ok(Math.abs(sum - 1) < 1e-5, 'L2-normalized within 1e-5');
  }
});

test('CircuitBreaker onTransition fires on all four transition kinds', () => {
  let clock = 0;
  const events: string[] = [];
  const breaker = new CircuitBreaker({
    threshold: 2,
    cooldownMs: 100,
    now: () => clock,
    onTransition: (f, t) => events.push(`${f}>${t}`),
  });

  breaker.recordFailure();
  breaker.recordFailure(); // failures hit threshold → closed>open
  clock += 100;
  assert.equal(breaker.canAttempt(), true, 'probe allowed after cooldown'); // open>half-open
  breaker.recordFailure(); // probe fails → half-open>open
  clock += 100;
  assert.equal(breaker.canAttempt(), true, 'probe allowed after second cooldown'); // open>half-open
  breaker.recordSuccess(); // probe succeeds → half-open>closed

  assert.deepEqual(events, [
    'closed>open',
    'open>half-open',
    'half-open>open',
    'open>half-open',
    'half-open>closed',
  ]);
});

test('a throwing onTransition listener cannot corrupt the breaker', () => {
  let clock = 0;
  const breaker = new CircuitBreaker({
    threshold: 1,
    cooldownMs: 100,
    now: () => clock,
    onTransition: () => {
      throw new Error('listener boom');
    },
  });

  breaker.recordFailure(); // closed>open — the listener throws mid-transition
  assert.equal(breaker.currentState, 'open', 'state advanced despite throwing listener');

  clock += 100;
  assert.equal(breaker.canAttempt(), true, 'half-open probe allowed after cooldown');
  breaker.recordSuccess(); // half-open>closed — listener throws again
  assert.equal(breaker.currentState, 'closed', 'state machine still transitions to closed');
});

test('ResilientEmbeddingProvider degrades to the offline space when the primary fails', async () => {
  const stubPrimary = {
    name: 'stub',
    dimensions: 64,
    space: 'stub:x',
    embed: async () => {
      throw new Error('down');
    },
    embedBatch: async () => {
      throw new Error('down');
    },
    embedIn: async () => null,
    spaces: () => ['stub:x'],
    embedTagged: async () => {
      throw new Error('down');
    },
    embedBatchTagged: async () => {
      throw new Error('down');
    },
  } as any; // minimal EmbeddingGateway stand-in whose every embed path fails

  const resilient = new ResilientEmbeddingProvider(
    stubPrimary,
    new OfflineBM25EmbeddingProvider(64),
    new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 }),
  );

  assert.equal(resilient.degraded, false, 'healthy before any failure');
  const tagged = await resilient.embedTagged('hello world');
  assert.equal(resilient.degraded, true, 'degraded after one failed primary embed');
  assert.ok(
    tagged.space.startsWith('offline-bm25:'),
    `fallback space served the embed, got ${tagged.space}`,
  );
  assert.equal(tagged.vector.length, 64, 'fallback vector width');
});
