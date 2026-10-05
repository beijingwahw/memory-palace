/**
 * Unit tests for the dimensional-elevation modules: capsules (transport),
 * reflection (self-tuning), and the MCP protocol handler (ubiquity).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPSULE_MAGIC,
  type MemoryCapsule,
  capsuleItemId,
  canonicalJson,
  parseCapsule,
  planImport,
  signCapsule,
  toCapsuleItem,
  verifyCapsule,
  normalizedContent,
} from '../src/utils/capsule.ts';
import {
  buildBenchmark,
  mrr,
  rankOf,
  recallAtK,
  reflectionGrid,
  objective,
} from '../src/utils/reflection.ts';
import { McpPalaceServer, MCP_PROTOCOL_VERSION } from '../src/mcp-server.ts';
import type { ToolDefinition } from '../src/types/cordis.ts';

const SECRET = 'team-secret-42';

test('canonicalJson is key-order stable and whitespace-free', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }),
    '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
  );
  assert.equal(
    canonicalJson({ a: 1, b: 2 }),
    canonicalJson({ b: 2, a: 1 }),
    'key order does not matter',
  );
});

test('capsule ids are content-addressed and normalization-safe', () => {
  assert.equal(
    capsuleItemId('hello  world\n\tagain'),
    capsuleItemId('hello world again'),
    'whitespace collapse → same id',
  );
  assert.match(capsuleItemId('some fact'), /^cap:[0-9a-f]{8}$/);
  assert.equal(normalizedContent(' a  b '), 'a b');
});

test('capsule sign/verify roundtrip + tamper detection', () => {
  const capsule: Parameters<typeof signCapsule>[0] = {
    magic: CAPSULE_MAGIC,
    version: 1 as const,
    palaceId: 'palace-a',
    exportedAt: 1_700_000_000_000,
    items: [
      {
        id: capsuleItemId('Aurora uses PostgreSQL 16'),
        layer: 'semantic' as const,
        content: 'Aurora uses PostgreSQL 16',
        importance: 0.9,
        createdAt: 1,
        entities: ['Aurora', 'PostgreSQL'],
        tags: [],
        source: 'user' as const,
      },
    ],
    patterns: [],
  };
  const signed = signCapsule(capsule, SECRET);
  assert.ok(signed.signature && verifyCapsule(signed, SECRET), 'signed capsule verifies');
  assert.ok(!verifyCapsule(signed, 'wrong-secret'), 'wrong secret rejected');
  const tampered = { ...signed, items: [{ ...signed.items[0]!, importance: 1 }] };
  assert.ok(!verifyCapsule(tampered, SECRET), 'tampered payload rejected');
  assert.ok(!verifyCapsule({ ...signed, signature: undefined }, SECRET), 'unsigned rejected');
});

test('parseCapsule validates magic, version, and content-addressing', () => {
  const good = signCapsule(
    {
      magic: CAPSULE_MAGIC,
      version: 1 as const,
      palaceId: 'p',
      exportedAt: 1,
      items: [
        {
          id: capsuleItemId('fact one'),
          layer: 'semantic' as const,
          content: 'fact one',
          importance: 0.5,
          createdAt: 1,
          entities: [],
          tags: [],
          source: 'user' as const,
        },
      ],
      patterns: [],
    },
    SECRET,
  );
  assert.equal(parseCapsule(JSON.stringify(good)).palaceId, 'p');
  assert.throws(() => parseCapsule('{"magic":"nope","version":1,"items":[]}'));
  const badId = JSON.stringify({
    ...good,
    items: [{ ...good.items[0]!, id: 'cap:deadbeef' }],
  });
  assert.throws(() => parseCapsule(badId), /id mismatch/);
});

test('planImport buckets duplicates, conflicts, and inserts', () => {
  const mk = (content: string) => ({
    id: capsuleItemId(content),
    layer: 'semantic' as const,
    content,
    importance: 0.8,
    createdAt: 1,
    entities: [],
    tags: [],
    source: 'user' as const,
  });
  const capsule: MemoryCapsule = {
    magic: CAPSULE_MAGIC,
    version: 1 as const,
    palaceId: 'p',
    exportedAt: 1,
    items: [
      mk('Brand new fact about Kafka partitions'), // insert
      mk('Already stored fact'), // duplicate
      mk('Aurora stack runs PostgreSQL 17 in production'), // conflicts with stored 16
    ],
    patterns: [],
  };
  const exists = (c: string) => normalizedContent(c) === 'Already stored fact';
  const similar = (c: string) =>
    /PostgreSQL 17/.test(c)
      ? [{ id: 'existing-1', content: 'Aurora stack runs PostgreSQL 16 in production', similarity: 0.9 }]
      : [];
  const plan = planImport(capsule, exists, similar as never);
  assert.equal(plan.toInsert.length, 1);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.conflictOnly.length, 1);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0]!.reason, /differing values/);
});

test('toCapsuleItem strips owner identity but keeps knowledge', () => {
  const item = {
    id: 'orig',
    layer: 'semantic' as const,
    content: 'Some distilled knowledge',
    metadata: {
      userId: 'u-secret',
      workspaceId: 'ws-secret',
      sessionId: 's-secret',
      entities: ['Kafka'],
      tags: ['t'],
      embeddingSpace: 'offline-bm25:64',
      source: 'user' as const,
    },
    createdAt: 5,
    updatedAt: 5,
    importance: 0.7,
    accessCount: 0,
    lastAccessedAt: 5,
    embedding: new Float32Array(64),
  };
  const cap = toCapsuleItem(item);
  assert.equal(cap.entities[0], 'Kafka');
  assert.equal(cap.id, capsuleItemId(item.content));
  const leaked = JSON.stringify(cap);
  assert.ok(!leaked.includes('u-secret') && !leaked.includes('ws-secret') && !leaked.includes('s-secret'), 'no owner identity crosses the boundary');
});

// ------------------------------------------------------------- reflection

test('benchmark builds pseudo-queries capped and deterministic', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({
    id: `item-${i}`,
    layer: 'semantic' as const,
    content: `Memory number ${i} about topic ${i % 5} with plenty of tokens to qualify here.`,
    metadata: { source: 'user' as const },
    createdAt: 1,
    updatedAt: 1,
    importance: 0.5,
    accessCount: 0,
    lastAccessedAt: 1,
  }));
  const b1 = buildBenchmark(items, { maxEntries: 25 });
  const b2 = buildBenchmark(items, { maxEntries: 25 });
  assert.deepEqual(b1, b2, 'deterministic');
  assert.equal(b1.length, 25, 'capped');
  assert.ok(b1.every((e) => e.query.length >= 24), 'queries are substantive');
  assert.ok(b1.every((e) => e.labelItemId.startsWith('item-')), 'labels bound to items');
});

test('MRR / recall / rankOf / objective math', () => {
  assert.equal(mrr([1, null, 3]), (1 + 0 + 1 / 3) / 3);
  assert.equal(mrr([]), 0);
  assert.equal(recallAtK([1, 2, 6, null], 5), 0.5);
  assert.equal(rankOf(['a', 'b', 'c'], 'c'), 3);
  assert.equal(rankOf(['a'], 'z'), null);
  assert.equal(objective(1, 1), 1);
  assert.ok(objective(0.9, 0.5) > objective(0.5, 0.9), 'MRR weighted 2:1 over recall');
});

test('reflection grid is deduped and includes current params', () => {
  const grid = reflectionGrid({ graphBoost: 0.15, prfAlpha: 0.7, prfBeta: 0.3 });
  const keys = new Set(grid.map((g) => `${g.graphBoost}|${g.prfAlpha}|${g.prfBeta}`));
  assert.equal(keys.size, grid.length, 'no duplicate combos');
  assert.ok(
    grid.some((g) => g.graphBoost === 0.15 && g.prfAlpha === 0.7 && g.prfBeta === 0.3),
    'current config present',
  );
  assert.ok(grid.length <= 36 && grid.length >= 27, 'bounded grid');
});

// ------------------------------------------------------------- MCP handler

function fakeTools(): ToolDefinition[] {
  return [
    {
      name: 'echo_tool',
      description: 'echoes',
      parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      async run(input: { msg: string }, ctx) {
        return { echoed: input.msg, session: ctx.sessionId };
      },
    },
    {
      name: 'boom_tool',
      description: 'always throws',
      parameters: { type: 'object', properties: {} },
      async run() {
        throw new Error('kaboom');
      },
    },
  ];
}

test('MCP handler: initialize, tools/list, tools/call, errors', async () => {
  const server = new McpPalaceServer(fakeTools(), { sessionId: 'mcp-test', userId: 'u1' });

  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal((init.result as { protocolVersion: string }).protocolVersion, MCP_PROTOCOL_VERSION);
  assert.ok((init.result as { capabilities: object }).capabilities);

  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (list.result as { tools: Array<{ name: string; inputSchema: object }> }).tools;
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, 'echo_tool');
  assert.ok(tools[0]!.inputSchema);

  const call = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'echo_tool', arguments: { msg: 'hi' } },
  });
  const payload = (call.result as { content: Array<{ type: string; text: string }> });
  const parsed = JSON.parse(payload.content[0]!.text) as { echoed: string; session: string };
  assert.equal(parsed.echoed, 'hi');
  assert.equal(parsed.session, 'mcp-test');

  const unknownTool = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  });
  assert.equal(unknownTool.error?.code, -32601);

  const badMethod = await server.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  assert.equal(badMethod.error?.code, -32601);

  const boom = await server.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'boom_tool', arguments: {} },
  });
  assert.equal(boom.error?.code, -32603);
  assert.match(boom.error?.message ?? '', /kaboom/);

  const ping = await server.handle({ jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.deepEqual(ping.result, {});
});
