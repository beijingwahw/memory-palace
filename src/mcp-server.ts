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

/** Protocol versions this server can speak. `initialize` echoes the
 *  client-requested version only when it appears here; anything else
 *  (older, newer, or non-string) falls back to MCP_PROTOCOL_VERSION. */
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([MCP_PROTOCOL_VERSION]);

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

export const ERR_PARSE = -32700;
const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
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
        case 'initialize': {
          // Protocol negotiation: honor a client version we actually speak,
          // otherwise answer with our own (the client decides whether to
          // downgrade or disconnect).
          const requested = msg.params?.['protocolVersion'];
          const protocolVersion =
            typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
              ? requested
              : MCP_PROTOCOL_VERSION;
          return ok(msg.id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: this.serverInfo,
          });
        }
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
            // The METHOD exists — an unknown tool name is a bad PARAMETER,
            // so this is invalid-params (-32602), not method-not-found.
            return err(msg.id, ERR_INVALID_PARAMS, `unknown tool: ${String(name)}`);
          }
          // JSON-RPC params must be an OBJECT — `typeof [] === 'object'`
          // would otherwise let a positional array through and every tool
          // would destructure undefined fields.
          if (typeof args !== 'object' || Array.isArray(args)) {
            return err(msg.id, ERR_INVALID_PARAMS, 'arguments must be an object');
          }
          const result = await tool.run(args, this.toolCtx);
          // Business failures travel in-band (a non-empty `error` field on
          // the result) rather than as exceptions — mirror that on the MCP
          // envelope so clients can branch on isError without parsing
          // content. Successful results keep isError: false.
          const errorField =
            typeof result === 'object' && result !== null
              ? (result as { error?: unknown }).error
              : undefined;
          const isError =
            errorField !== undefined && errorField !== null && errorField !== '';
          return ok(msg.id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError,
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
