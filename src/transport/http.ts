/**
 * Federation HTTP transport — zero-dependency wire for the retrieve()
 * contract.
 *
 * A federation member is any object satisfying PalaceMember (see
 * services/federated-retriever.ts); until now every member lived
 * in-process. This module lifts the SAME contract onto node:http so a
 * palace in another process — or on another machine — can join a
 * federation with no new runtime dependencies: node:http for the wire,
 * node:crypto for HMAC-SHA256 request signing.
 *
 * Security model (safe defaults throughout):
 *
 *   - REQUEST AUTHENTICATION: every POST body must carry
 *     `x-palace-signature: hex(HMAC-SHA256(secret, body))`. The server
 *     recomputes the MAC over the RAW bytes it received and compares
 *     with timingSafeEqual after an equal-length precheck (length is
 *     never a useful oracle: the expected MAC is always 32 bytes).
 *     Missing or mismatched signature → 401.
 *   - SERVER-SIDE SCOPE SOVEREIGNTY: the incoming query's `scope` is
 *     stripped at the boundary; the member always executes against the
 *     SERVER's `serveScope` (default {} — anonymous, which the
 *     visibility cascade restricts to global-tier items only). A remote
 *     caller can never widen the ACL by smuggling a scope. The client
 *     helper strips scope before sending and the server strips it again
 *     before dispatch (belt and braces).
 *   - EMBEDDINGS OFF BY DEFAULT: response vectors double the payload and
 *     leak embedding geometry; the federation's cross-palace MMR already
 *     degrades to a token-Jaccard similarity when vectors are absent,
 *     so `includeEmbeddings: true` is an explicit opt-in.
 *   - SIZE + TIME GUARDS: bodies over maxBodyBytes (default 4 MiB) are
 *     rejected 413 — via BOTH the declared Content-Length and the
 *     actually-read byte count, so a lying header cannot smuggle an
 *     unbounded stream past the cap. A body that never completes within
 *     REQUEST_BODY_TIMEOUT_MS gets 408 and the socket destroyed
 *     (slow-loris containment).
 *   - ERROR CONTAINMENT: member failures map to 500 {error} carrying
 *     the message only (never a stack); transport-level errors (server
 *     'error'/'clientError', late response-write failures) are silently
 *     counted and never crash the process.
 *
 * Pure node: internals only — no third-party modules.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type {
  MemoryItem,
  MemoryScope,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
} from '../types/index.js';
import type { PalaceMember } from '../services/federated-retriever.js';

/** The single route this server answers. */
const FEDERATION_SEARCH_PATH = '/federation/search';

/** Signature header — hex HMAC-SHA256 over the raw request body. */
const SIGNATURE_HEADER = 'x-palace-signature';

/** Default request-body cap (4 MiB), checked against declared AND read bytes. */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A request body that has not completed within this window gets 408. */
const REQUEST_BODY_TIMEOUT_MS = 10_000;

/** Default member-side probe timeout (FederatedRetriever races its own). */
const DEFAULT_MEMBER_TIMEOUT_MS = 5_000;

// ----- Options & handles -------------------------------------------------------

export interface FederationServerOptions {
  /** The local retrieval face exposed over the wire (PalaceMember shape). */
  member: PalaceMember;
  /** Shared HMAC secret; only holders may query this server. */
  secret: string;
  /**
   * Scope every incoming query executes under (default {} — anonymous,
   * so the visibility cascade serves global-tier items ONLY; the safe
   * default surface). Incoming scopes are stripped and can never
   * override this.
   */
  serveScope?: MemoryScope;
  /** Request-body cap in bytes (default 4 MiB). */
  maxBodyBytes?: number;
  /** Bind host (default 127.0.0.1 — loopback unless deliberately widened). */
  host?: string;
  /** Bind port (default 0 = ephemeral). */
  port?: number;
}

export interface FederationServer {
  /** Base URL for the member-side client, e.g. `http://127.0.0.1:45321`. */
  url: string;
  /** Concrete bound port (meaningful with the default ephemeral bind). */
  port: number;
  /** Stops the server; safe to call repeatedly. */
  close(): Promise<void>;
  /**
   * The silent transport-noise counter, made observable: client errors /
   * socket errors (malformed frames, resets, server 'error' events, late
   * writes to dead sockets) are counted and never logged — poll this
   * while the server runs (any time before close()) to observe them.
   */
  transportErrors(): number;
}

export interface HttpFederationMemberOptions {
  /** Member display name (default: the URL's host:port). */
  name?: string;
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
  /**
   * Opt in to receiving hit embeddings. The wire strips vectors by
   * default; setting true asks the serving palace to include them (it
   * must allow it), and revived hit vectors land as Float32Arrays for
   * cross-palace MMR / dedup.
   */
  includeEmbeddings?: boolean;
}

// ----- Server ------------------------------------------------------------------

interface ServerContext {
  member: PalaceMember;
  secret: string;
  serveScope: MemoryScope;
  maxBodyBytes: number;
}

/**
 * Query fields that never cross the wire: `scope` (server-face
 * sovereignty), `queryEmbedding`/`queryEmbeddingSpace` (a Float32Array
 * has no JSON form and a vector is meaningless cross-process anyway)
 * and `speculative` (warmth probing is a server-side decision).
 */
const STRIPPED_QUERY_KEYS: ReadonlySet<string> = new Set([
  'scope',
  'queryEmbedding',
  'queryEmbeddingSpace',
  'speculative',
]);

export async function createFederationServer(
  opts: FederationServerOptions,
): Promise<FederationServer> {
  const ctx: ServerContext = {
    member: opts.member,
    secret: opts.secret,
    serveScope: opts.serveScope ?? {},
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };
  const host = opts.host ?? '127.0.0.1';
  const listenPort = opts.port ?? 0;

  // Silent health counter: transport noise (client resets, late writes
  // to dead sockets, malformed frames) is counted, never logged, never
  // allowed to crash the process.
  const counters = { transportErrors: 0 };

  const server: Server = createServer((req, res) => {
    // A response stream outlives its request handler when the member is
    // slow and the client hung up first — late write failures land here.
    res.on('error', () => {
      counters.transportErrors++;
    });
    void handleRequest(req, res, ctx).catch(() => {
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: 'internal error' });
      }
    });
  });
  server.on('error', () => {
    counters.transportErrors++;
  });
  server.on('clientError', (_err: Error, socket: Socket) => {
    counters.transportErrors++;
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onListenError);
    server.listen(listenPort, host, () => {
      server.off('error', onListenError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('federation server bound to a non-inet address (unix socket path?)');
  }
  const port = address.port;

  let closed = false;
  return {
    url: `http://${displayHost(host)}:${port}`,
    port,
    close: (): Promise<void> => {
      if (closed) return Promise.resolve();
      closed = true;
      return closeServer(server);
    },
    transportErrors: (): number => counters.transportErrors,
  };
}

/**
 * A wildcard bind is never connectable as a literal URL host; point the
 * advertised URL at loopback (0.0.0.0 and the default dual-stack `::`
 * both accept 127.0.0.1 connections).
 */
function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // fetch/undici holds keep-alive sockets open for seconds after the
    // last response; server.close() alone would wait them out. Forcing
    // the remaining sockets makes close() deterministic (Node >= 18.2).
    server.closeIdleConnections();
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const path = requestPath(req);
  if (path !== FEDERATION_SEARCH_PATH) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // Body-read deadline: the timer covers the WHOLE read (headers
  // arrived but the stream never completes — slow-loris), and is
  // cleared the moment the body settles in either direction.
  let bodyTimedOut = false;
  // Indirected read: the timer callback flips the flag from another
  // closure, which the straight-line type of the binding can never see —
  // a direct `if (bodyTimedOut)` after the await would stay narrowed to
  // the initializer and read as always-false.
  const timedOut = (): boolean => bodyTimedOut;
  const deadline = setTimeout(() => {
    bodyTimedOut = true;
    sendJson(res, 408, { error: 'request body timeout' });
    // One tick for the flushed 408 to leave, then hard-close the socket.
    setImmediate(() => {
      req.destroy();
    });
  }, REQUEST_BODY_TIMEOUT_MS);

  const body = await readBody(req, ctx.maxBodyBytes);
  clearTimeout(deadline);
  if (timedOut()) return; // 408 already sent, socket destroyed

  if (body === 'too-large') {
    sendJson(res, 413, { error: 'payload too large' });
    // Drain the rejected remainder so the connection can still end
    // cleanly instead of dying mid-upload (the client sees the 413).
    req.resume();
    return;
  }
  if (body === 'aborted') return; // peer vanished mid-body — nothing to answer

  if (!signatureMatches(firstHeader(req.headers[SIGNATURE_HEADER]), body, ctx.secret)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const wire = parseWireRequest(body.toString('utf8'));
  if (wire === null) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  try {
    const result = await ctx.member.retrieve({ ...wire.query, scope: ctx.serveScope });
    sendRawJson(res, 200, serializeResult(result, wire.includeEmbeddings));
  } catch (err) {
    // Message only — a stack trace would leak filesystem layout and
    // internals to a (possibly foreign) federation peer.
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
  }
}

// ----- Wire codec ---------------------------------------------------------------

interface WireRequest {
  query: RetrievalQuery;
  includeEmbeddings: boolean;
}

/**
 * Parse and validate a request envelope `{ query, includeEmbeddings? }`.
 * Only JSON-native query fields survive; scope and its non-serializable
 * siblings are dropped (see STRIPPED_QUERY_KEYS) so the server pins the
 * scope itself. Returns null for anything malformed (→ 400).
 */
function parseWireRequest(bodyText: string): WireRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const envelope = parsed as { query?: unknown; includeEmbeddings?: unknown };
  const wireQuery = envelope.query;
  if (wireQuery === null || typeof wireQuery !== 'object' || Array.isArray(wireQuery)) {
    return null;
  }
  const q = wireQuery as Record<string, unknown>;
  if (typeof q['query'] !== 'string' || q['query'].length === 0) return null;
  if (envelope.includeEmbeddings !== undefined && typeof envelope.includeEmbeddings !== 'boolean') {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(q)) {
    if (STRIPPED_QUERY_KEYS.has(key)) continue;
    out[key] = q[key];
  }
  return {
    query: out as unknown as RetrievalQuery,
    includeEmbeddings: envelope.includeEmbeddings === true,
  };
}

/** Strip the fields that must not cross the wire (client side of the contract). */
function toWireQuery(q: RetrievalQuery): RetrievalQuery {
  const wire: Record<string, unknown> = {};
  for (const key of Object.keys(q)) {
    if (STRIPPED_QUERY_KEYS.has(key)) continue;
    wire[key] = q[key as keyof RetrievalQuery];
  }
  return wire as unknown as RetrievalQuery;
}

/**
 * Serialize a RetrievalResult for the wire. A Float32Array has no JSON
 * form, so a kept embedding is written as a plain number[] (revived by
 * the member client); a stripped one is omitted entirely rather than
 * left as an undefined field.
 */
function serializeResult(result: RetrievalResult, includeEmbeddings: boolean): string {
  return JSON.stringify({
    ...result,
    hits: result.hits.map((h) => ({ ...h, item: serializeItem(h.item, includeEmbeddings) })),
  });
}

function serializeItem(item: MemoryItem, includeEmbeddings: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(item)) {
    if (key === 'embedding') continue;
    out[key] = item[key as keyof MemoryItem];
  }
  if (includeEmbeddings && item.embedding) {
    out['embedding'] = Array.from(item.embedding);
  }
  return out;
}

/**
 * Revive a server payload back into a typed RetrievalResult: embedding
 * arrays become Float32Arrays again (so downstream cosine/MMR math sees
 * real vectors, not plain arrays). Malformed shapes throw — the member
 * client surfaces them and FederatedRetriever's breaker treats the
 * member as failed for the round. That includes embeddings that are not
 * strictly numeric arrays: a non-numeric entry used to be filtered out,
 * silently SHORTENING the vector (misaligned dimensions downstream), and
 * a truthy non-array used to be silently dropped to undefined.
 */
function reviveResult(payload: unknown): RetrievalResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('federation response is not an object');
  }
  const base = payload as RetrievalResult & { hits?: unknown };
  if (!Array.isArray(base.hits)) {
    throw new Error('federation response has no hits array');
  }
  return { ...base, hits: base.hits.map((h) => reviveHit(h)) };
}

function reviveHit(h: unknown): RetrievalHit {
  if (h === null || typeof h !== 'object' || Array.isArray(h)) {
    throw new Error('federation hit is malformed');
  }
  const hit = h as RetrievalHit & { item?: unknown };
  // Local unknown view of the untrusted item — the typed property above
  // cannot express null, but the wire can send it.
  const rawItem: unknown = hit.item;
  if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new Error('federation hit has no item object');
  }
  // The revived item is built and embedded into as a plain record; the
  // MemoryItem cast lands only at the return boundary.
  const source = rawItem as Record<string, unknown>;
  const item: Record<string, unknown> = { ...source };
  const rawEmbedding = source['embedding'];
  if (rawEmbedding === undefined || rawEmbedding === null) {
    // Absent (or JSON null) is the legal default: stripped by the server
    // or never carried. Stays undefined.
    item['embedding'] = undefined;
  } else if (Array.isArray(rawEmbedding)) {
    // A non-numeric entry would otherwise land as a silently SHORTER
    // vector — cosine/MMR math on misaligned dimensions. Fail the hit
    // (and thus the member for the round) instead.
    if ((rawEmbedding as unknown[]).some((v) => typeof v !== 'number')) {
      throw new Error('malformed federation hit: embedding carries non-numeric entries');
    }
    item['embedding'] = new Float32Array(rawEmbedding as number[]);
  } else {
    // Truthy non-array shapes (objects, strings, numbers) are malformed,
    // not silently droppable.
    throw new Error('malformed federation hit: embedding is not an array');
  }
  return { ...hit, item: item as unknown as MemoryItem };
}

// ----- Auth, body reading, response plumbing ------------------------------------

/**
 * Constant-time signature comparison: recompute the HMAC over the raw
 * received bytes, hex-decode the header, compare lengths first
 * (timingSafeEqual throws on mismatched lengths, and the expected
 * length is public — always 32 bytes — so the check leaks nothing).
 */
function signatureMatches(
  received: string | undefined,
  body: Buffer,
  secret: string,
): boolean {
  if (received === undefined || received.length === 0) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  // No try/catch here, deliberately: Node's hex decoding never throws —
  // characters outside the alphabet are silently dropped (truncating the
  // decode). A so-truncated product has the WRONG length and dies on the
  // precheck below; only a 64-char clean hex string can decode to the
  // 32 bytes that reach the constant-time compare.
  const actual = Buffer.from(received, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function contentLengthOf(req: IncomingMessage): number | undefined {
  const first = firstHeader(req.headers['content-length']);
  if (first === undefined) return undefined;
  const n = Number(first);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

type BodyRead = Buffer | 'too-large' | 'aborted';

/**
 * Read the full request body under the byte cap. The declared
 * Content-Length is checked up front (reject without reading) AND the
 * actually-received bytes are counted (a lying header cannot stream an
 * unbounded body past the cap). Never rejects — a dead peer settles as
 * 'aborted'.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    const declared = contentLengthOf(req);
    if (declared !== undefined && declared > maxBytes) {
      resolve('too-large');
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (value: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        finish('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish(Buffer.concat(chunks));
    });
    req.on('error', () => {
      finish('aborted');
    });
    req.on('close', () => {
      finish('aborted');
    });
  });
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return req.url ?? '/';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendRawJson(res, status, JSON.stringify(body));
}

function sendRawJson(res: ServerResponse, status: number, jsonText: string): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = Buffer.from(jsonText, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.byteLength),
  });
  res.end(payload);
}

// ----- Member client ------------------------------------------------------------

/**
 * Shared signed-POST helper: serializes the envelope once, signs the
 * exact bytes it transmits, and bounds the round trip with
 * AbortSignal.timeout. (Private to this file — the CRDT transport keeps
 * its own client by design.)
 */
async function signedFetch(
  url: string,
  secret: string,
  bodyObj: unknown,
  timeoutMs: number,
): Promise<Response> {
  const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signature,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function memberNameFromUrl(url: string): string {
  try {
    return new URL(url).host; // host:port (ephemeral ports always included)
  } catch {
    return url;
  }
}

/**
 * Normalize a base (or already-routed) URL onto the single search route.
 * The base's path prefix is kept (not clobbered) so a member deployed
 * behind a reverse-proxy path prefix stays reachable — aligned with
 * crdt-http's endpointOf, which must work under the same deployments.
 * Exported for direct testing.
 */
export function searchEndpoint(url: string): string {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/+$/, '') + FEDERATION_SEARCH_PATH;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * A PalaceMember backed by an HTTP federation server: the mirror of
 * createFederationServer on the calling side. Scope is stripped from
 * the outgoing wire query (the serving palace owns its ACL); timeouts
 * and non-2xx answers throw, so FederatedRetriever's per-member
 * circuit breakers and round timeouts keep working unchanged on top.
 */
export function httpFederationMember(
  url: string,
  secret: string,
  opts: HttpFederationMemberOptions = {},
): PalaceMember {
  const name = opts.name ?? memberNameFromUrl(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MEMBER_TIMEOUT_MS;
  const endpoint = searchEndpoint(url);
  return {
    name,
    retrieve: async (q: RetrievalQuery): Promise<RetrievalResult> => {
      const res = await signedFetch(
        endpoint,
        secret,
        {
          query: toWireQuery(q),
          ...(opts.includeEmbeddings === true ? { includeEmbeddings: true } : {}),
        },
        timeoutMs,
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `federation member "${name}" answered HTTP ${res.status}` +
            (detail.length > 0 ? `: ${detail.slice(0, 200)}` : ''),
        );
      }
      const payload: unknown = await res.json();
      return reviveResult(payload);
    },
  };
}
