/**
 * MCP (Model Context Protocol) server core — the palace as a universal
 * memory server.
 *
 * DSH plugins speak the Cordis tool contract; every other 2026-era client
 * (Claude Desktop, IDE agents, custom orchestrators) speaks MCP. This
 * module is the protocol adapter: a PURE JSON-RPC 2.0 request/response
 * handler (no stdio, no sockets) that exposes the palace's tools through
 * `initialize` / `tools/list` / `tools/call`. Transport binding lives in
 * bin/mcp-palace.ts (newline-delimited JSON over stdio), so the handler
 * itself is unit-testable end to end.
 */

import type { ToolContext, ToolDefinition } from './types/cordis.js';
import { VERSION } from './types/index.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ERR_PARSE = -32700;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

export class McpPalaceServer {
  readonly serverInfo = { name: 'dsh-memory-palace', version: VERSION };

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly toolCtx: ToolContext,
  ) {}

  /** Handle one JSON-RPC message; always answers (never throws). */
  async handle(msg: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      switch (msg.method) {
        case 'initialize':
          return ok(msg.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: this.serverInfo,
          });
        case 'notifications/initialized':
        case 'initialized':
          // notification — no response body needed, but a null result is
          // harmless for clients that expect one
          return { jsonrpc: '2.0', id: msg.id ?? null, result: null };
        case 'tools/list':
          return ok(msg.id, {
            tools: this.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            })),
          });
        case 'tools/call': {
          const name = msg.params?.['name'];
          const args = (msg.params?.['arguments'] ?? {}) as Record<string, unknown>;
          const tool = this.tools.find((t) => t.name === name);
          if (!tool) {
            return err(msg.id, ERR_METHOD_NOT_FOUND, `unknown tool: ${String(name)}`);
          }
          if (typeof args !== 'object' || args === null) {
            return err(msg.id, ERR_INVALID_PARAMS, 'arguments must be an object');
          }
          const result = await tool.run(args, this.toolCtx);
          return ok(msg.id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        }
        case 'ping':
          return ok(msg.id, {});
        default:
          return err(msg.id, ERR_METHOD_NOT_FOUND, `method not found: ${msg.method}`);
      }
    } catch (e) {
      return err(msg.id, ERR_INTERNAL, String(e instanceof Error ? e.message : e));
    }
  }

  toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }
}

function ok(id: number | string | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(
  id: number | string | null | undefined,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
