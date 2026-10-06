/**
 * Genesis entry-immunity tests — the protocol adapter's blast walls.
 *
 * Every palace entry point (DSH plugin, MCP stdio bin, CLI) funnels remote
 * input through McpPalaceServer.handle; these tests pin the FIRST lines of
 * defense at the JSON-RPC boundary so a hostile or buggy client can never
 * reach service code with malformed shapes:
 *
 *   - tools/call `arguments` that is an ARRAY (typeof 'object') must be
 *     rejected as -32602, never destructured as a params bag;
 *   - unknown tool → -32602 (bad param), unknown method → -32601 — the
 *     code split is part of the contract;
 *   - business failures (result.error) map to isError: true, success to
 *     false — clients branch on the envelope without parsing content;
 *   - initialize echoes a client version only when spoken here;
 *   - notifications (no id) never produce a response carrying an id.
 *
 * Pure handler tests: fake tools, no database, no stdio.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  McpPalaceServer,
  MCP_PROTOCOL_VERSION,
  type JsonRpcResponse,
} from '../src/mcp-server.ts';
import type { ToolDefinition } from '../src/types/cordis.ts';

function fakeTools(): ToolDefinition[] {
  return [
    {
      name: 'ok_tool',
      description: 'returns a plain result',
      parameters: { type: 'object', properties: {} },
      async run() {
        return { fine: true };
      },
    },
    {
      name: 'error_tool',
      description: 'returns an in-band business failure',
      parameters: { type: 'object', properties: {} },
      async run() {
        return { error: 'boom' };
      },
    },
  ];
}

const server = new McpPalaceServer(fakeTools(), { sessionId: 'genesis' });

/** tools/call envelope of a handled response, parsed back from content[0]. */
function callPayload(resp: JsonRpcResponse): { isError?: boolean } {
  const env = resp.result as { content: Array<{ text: string }>; isError: boolean };
  return { ...JSON.parse(env.content[0]!.text), isError: env.isError };
}

test('tools/call with ARRAY arguments is rejected as -32602', async () => {
  // `typeof [] === 'object'` — the classic hole in a typeof-only guard.
  const resp = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'ok_tool', arguments: [{ sneaky: 'positional' }] },
  });
  assert.equal(resp.error?.code, -32602, 'array arguments must be invalid-params');
  assert.match(resp.error?.message ?? '', /object/i);
  assert.equal(resp.result, undefined, 'no result envelope on param rejection');
});

test('unknown tool is -32602, unknown method is -32601', async () => {
  const unknownTool = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'does_not_exist', arguments: {} },
  });
  // The METHOD exists; the tool NAME is a bad parameter value.
  assert.equal(unknownTool.error?.code, -32602);

  const unknownMethod = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'prompts/get',
  });
  assert.equal(unknownMethod.error?.code, -32601);
  assert.match(unknownMethod.error?.message ?? '', /prompts\/get/);
});

test('in-band result.error maps to isError true; success to false', async () => {
  const boom = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'error_tool', arguments: {} },
  });
  assert.equal(boom.error, undefined, 'business failure stays in-band, not on the envelope');
  const boomPayload = callPayload(boom);
  assert.equal(boomPayload.isError, true);
  assert.equal(boomPayload['error'], 'boom');

  const fine = await server.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'ok_tool', arguments: {} },
  });
  const finePayload = callPayload(fine);
  assert.equal(finePayload.isError, false);
  assert.equal(finePayload['fine'], true);
});

test('initialize echoes a supported client version, falls back on others', async () => {
  const echoed = await server.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION },
  });
  assert.equal(
    (echoed.result as { protocolVersion: string }).protocolVersion,
    MCP_PROTOCOL_VERSION,
    'client-requested version we speak is echoed verbatim',
  );

  const fallback = await server.handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'initialize',
    params: { protocolVersion: '1999-09-09' },
  });
  assert.equal(
    (fallback.result as { protocolVersion: string }).protocolVersion,
    MCP_PROTOCOL_VERSION,
    'unknown version answered with the server version',
  );

  const nonString = await server.handle({
    jsonrpc: '2.0',
    id: 8,
    method: 'initialize',
    params: { protocolVersion: 42 },
  });
  assert.equal(
    (nonString.result as { protocolVersion: string }).protocolVersion,
    MCP_PROTOCOL_VERSION,
    'non-string version answered with the server version',
  );
});

test('notifications (no id) never yield a response carrying an id', async () => {
  // Regression of the existing behavior: an id-less request must not be
  // answered with a meaningful id — the transport (bin/mcp-palace.ts)
  // drops responses for msg.id === undefined, and the server must keep
  // producing only id: null envelopes for id-less input.
  const initd = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initd.id, null, 'notification response id is null, never echoed');
  assert.ok(initd.result !== undefined || initd.error !== undefined, 'still a well-formed envelope');

  const callNotify = await server.handle({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'ok_tool', arguments: {} },
  });
  assert.equal(callNotify.id, null, 'id-less tools/call response id is null');

  const parseNotify = await server.handle({ jsonrpc: '2.0', method: 'unknown/notification' });
  assert.equal(parseNotify.id, null, 'id-less unknown method response id is null');
  assert.equal(parseNotify.error?.code, -32601);
});
