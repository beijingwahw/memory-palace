/**
 * CRDT HTTP transport — one-to-one op exchange over a loopback wire.
 *
 * The federation service (services/crdt-federation.ts) implements the
 * minimal CrdtPeer surface; this module moves that surface across a
 * process boundary. One route, one request shape, one response shape —
 * the LINE PROTOCOL IS FROZEN on both ends:
 *
 *   POST /federation/crdt
 *   request  (client → server): {
 *     replica: string,                     // client's replicaId (provenance)
 *     ops: CrdtOp[],                       // client → server incremental delta
 *     clientWantsSince: Record<string, number>,  // what the client already holds
 *   }
 *   response (server → client): {
 *     ops: CrdtOp[],                       // server's ops above clientWantsSince
 *     serverWatermarks: Record<string, number>,  // server's holdings after import
 *     fingerprint: string,                 // server's full-doc convergence digest
 *   }
 *
 * Exchange behavior: the server applies `ops` FIRST (idempotent by op_id,
 * INSERT OR IGNORE), then computes the response purely from the client's
 * STATED holdings — `opsSince(clientWantsSince)`. Push and pull ride the
 * same round trip.
 *
 * Discipline (local implementation, aligned with the retrieval transport):
 *   - AUTH: every request carries `x-palace-signature` — HMAC-SHA256 hex
 *     over the RAW request bytes with the shared secret, compared with
 *     timingSafeEqual (the capsule signature discipline, utils/capsule.ts).
 *     Missing/mismatching signature → 401. Responses are not signed: the
 *     client proves itself, and only holders of the secret run servers.
 *   - BODY: requests are capped at maxBodyBytes (default 4 MB); a declared
 *     or streamed overflow → 413. Client-side, RESPONSE bodies are capped
 *     at 64 MiB (declared Content-Length or streamed count) — a runaway
 *     endpoint must not be able to commit this side to unbounded memory.
 *   - TIMEOUT: the client bounds every exchange (timeoutMs, default 10 s);
 *     the server bounds header arrival (10 s) and total request time
 *     (30 s) so stalled peers cannot pin sockets open.
 *   - INPUT: ops / watermarks arriving over the wire are structurally
 *     validated BEFORE importOps — a malformed op must die at the boundary
 *     (400), never inside the op log.
 *
 * syncOverHttp is ONE direction of a full round (local → remote). Full
 * bidirectional convergence = the caller runs it in both directions
 * (each palace serves createCrdtServer and syncs against the other's
 * URL). The endpoint watermark (what THIS side believes the remote
 * endpoint holds) persists in palace_meta under the endpoint's FULL
 * host+path identity — `crdt:http-wm:<host:port><path>/federation/crdt`,
 * e.g. `crdt:http-wm:127.0.0.1:43110/federation/crdt` (WHATWG `u.host`
 * brackets IPv6 literals by construction; the same host serving two proxy
 * path prefixes addresses two distinct keys) — per ENDPOINT, not per
 * replica, because the op set behind a URL is the
 * endpoint's union, whatever replica ids pass through it. Any defect in
 * the persisted value reads as "everything" (full exchange); dedup makes
 * the re-sent superset merely redundant, never wrong — the same fallback
 * law as the local per-peer watermarks.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { CrdtFederation, CrdtPeer } from '../services/crdt-federation.js';
import type { CrdtOp, Lamport } from '../utils/crdt.js';

// ── Frozen line protocol ─────────────────────────────────────────────────────

/** The single route this transport serves. */
const EXCHANGE_PATH = '/federation/crdt';
/** Shared-secret request authentication header (same name as the retrieval transport). */
const SIGNATURE_HEADER = 'x-palace-signature';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB
const DEFAULT_TIMEOUT_MS = 10_000;
const SERVER_HEADERS_TIMEOUT_MS = 10_000;
const SERVER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Client-side cap on exchange RESPONSE bodies. The trust boundary is the
 * shared secret — only holders of it run servers worth federating with —
 * but a runaway, buggy, or compromised endpoint can still emit (or lie
 * via Content-Length about) an unbounded response, and no legitimate
 * exchange payload comes within orders of magnitude of 64 MiB.
 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** The error every response-cap violation throws (declared or streamed). */
const RESPONSE_CAP_MESSAGE = 'crdt exchange response exceeds 64 MiB cap';

/** Client → server exchange request (line protocol, frozen). */
export interface CrdtExchangeRequest {
  /** The client's own replicaId — informational provenance for the server. */
  replica: string;
  /** The client → server incremental delta. */
  ops: CrdtOp[];
  /** Per-replica watermarks the client already holds; the server sends only ops above them. */
  clientWantsSince: Record<string, number>;
}

/** Server → client exchange response (line protocol, frozen). */
export interface CrdtExchangeResponse {
  /** Server ops above the client's stated holdings (the pull half). */
  ops: CrdtOp[];
  /** The server's per-replica max counters AFTER importing `ops`. */
  serverWatermarks: Record<string, number>;
  /** The server's full-doc convergence digest AFTER importing `ops`. */
  fingerprint: string;
}

/** Error carrying the HTTP status the server must answer with. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Server ───────────────────────────────────────────────────────────────────

export interface CrdtServerOptions {
  /** The peer whose log this endpoint serves (usually the local CrdtFederation). */
  crdt: CrdtPeer;
  /** Shared secret for request signatures; wrong-secret callers get 401. */
  secret: string;
  /** Request body cap. Default 4 MB. */
  maxBodyBytes?: number;
  /** Bind host. Default 127.0.0.1 (loopback — this is palace-to-palace, not public). */
  host?: string;
  /** Bind port; 0 = ephemeral. Default 0. */
  port?: number;
}

export interface CrdtServer {
  /** Base URL of the endpoint (`http://127.0.0.1:<port>`); POST to `<url>/federation/crdt`. */
  url: string;
  /** The bound port (useful when 0/ephemeral was requested). */
  port: number;
  /** Stop listening and force pooled sockets down. Idempotent. */
  close(): Promise<void>;
}

/**
 * Serve a CrdtPeer over HTTP: `POST <url>/federation/crdt` performs one
 * authenticated push+pull exchange round (see the line protocol above).
 * Local-only implementation: node:http, no framework, no logging.
 */
export function createCrdtServer(opts: CrdtServerOptions): Promise<CrdtServer> {
  const { crdt, secret } = opts;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const host = opts.host ?? DEFAULT_HOST;

  const server = createServer((req, res) => {
    handleExchange(req, res, crdt, secret, maxBodyBytes);
  });
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return new Promise<CrdtServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      let closed = false;
      const close = (): Promise<void> => {
        if (closed) return Promise.resolve(); // idempotent by construction
        closed = true;
        return new Promise((resolveClose) => {
          // Stop accepting, then force keep-alive sockets down — otherwise
          // a pooled idle client would hold the close callback open forever.
          server.close(() => {
            resolveClose();
          });
          server.closeAllConnections();
        });
      };
      resolve({ url: `http://${host}:${address.port}`, port: address.port, close });
    });
  });
}

function handleExchange(
  req: IncomingMessage,
  res: ServerResponse,
  crdt: CrdtPeer,
  secret: string,
  maxBodyBytes: number,
): void {
  // A write onto a dead socket must never crash the process.
  res.on('error', () => undefined);
  const pathname = safePathname(req.url);
  if (pathname !== EXCHANGE_PATH) {
    sendJson(res, 404, { error: `no such route: ${pathname}` });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: `${EXCHANGE_PATH} accepts POST only` });
    return;
  }
  // The handler itself stays synchronous; the body promise carries the
  // response, and every failure path maps to a status (void: the response
  // is the point, nothing downstream awaits the handler).
  void readBody(req, maxBodyBytes).then(
    (body) => {
      try {
        requireSignature(secret, body, req.headers[SIGNATURE_HEADER]);
        const request = parseExchangeRequest(body);
        // Apply first (idempotent by op_id), respond second — the response
        // delta and digest reflect the post-import state, so the caller's
        // converged check compares against what the endpoint NOW holds.
        crdt.importOps(request.ops);
        const response: CrdtExchangeResponse = {
          ops: crdt.opsSince(request.clientWantsSince),
          serverWatermarks: crdt.watermarks(),
          fingerprint: crdt.fingerprint(),
        };
        sendJson(res, 200, response);
      } catch (e) {
        // HttpError carries the protocol status (401/400/413); anything
        // else escaped the peer — a server-side fault, never the caller's.
        sendJson(res, e instanceof HttpError ? e.status : 500, { error: messageOf(e) });
      }
    },
    (e: unknown) => {
      // Body-level failure (oversize / stream error): answer with the
      // mapped status, then KILL the socket one tick later. Draining with
      // resume() alone would let an endless stream behind a lying small
      // Content-Length pin the socket open until requestTimeout even
      // after the 413 went out — the 408 containment pattern from the
      // retrieval transport: one tick for the flushed response to leave,
      // then hard-close.
      sendJson(res, e instanceof HttpError ? e.status : 400, { error: messageOf(e) });
      setImmediate(() => {
        req.destroy();
      });
    },
  );
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://palace.invalid').pathname;
  } catch {
    return '/';
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  res.end(body);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = contentLengthOf(req);
    if (declared !== undefined && declared > maxBytes) {
      reject(
        new HttpError(413, `request body of ${declared} bytes exceeds the ${maxBytes}-byte limit`),
      );
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, `request body exceeds the ${maxBytes}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!failed) {
        failed = true;
        reject(e);
      }
    });
  });
}

function contentLengthOf(req: IncomingMessage): number | undefined {
  const header: string | string[] | undefined = req.headers['content-length'];
  const raw = typeof header === 'string' ? header : header?.[0];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** HMAC-SHA256 over the raw request bytes, constant-time compare (401 on any defect). */
function requireSignature(
  secret: string,
  body: Buffer,
  header: string | string[] | undefined,
): void {
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== 'string' || provided.length === 0) {
    throw new HttpError(401, `missing ${SIGNATURE_HEADER} header`);
  }
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, 'signature mismatch');
  }
}

// ── Wire-shape validation (untrusted boundary) ───────────────────────────────

const OP_KINDS = new Set<string>([
  'item-set',
  'item-del',
  'tag-add',
  'tag-del',
  'entity-add',
  'entity-del',
]);

function parseJson(text: string, malformed: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, malformed);
  }
}

function parseExchangeRequest(body: Buffer): CrdtExchangeRequest {
  const parsed = parseJson(body.toString('utf8'), 'request body is not valid JSON');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be an object');
  }
  const rec = parsed as Record<string, unknown>;
  const replica = rec['replica'];
  if (typeof replica !== 'string' || replica.length === 0) {
    throw new HttpError(400, 'replica must be a non-empty string');
  }
  const rawOps = rec['ops'];
  if (!Array.isArray(rawOps)) {
    throw new HttpError(400, 'ops must be an array');
  }
  const ops = rawOps.map((op) => validateOp(op));
  const wants = rec['clientWantsSince'];
  if (wants === null || typeof wants !== 'object' || Array.isArray(wants)) {
    throw new HttpError(400, 'clientWantsSince must be an object');
  }
  const clientWantsSince = validateWatermarks(wants as Record<string, unknown>, 'clientWantsSince');
  return { replica, ops, clientWantsSince };
}

function validateWatermarks(
  raw: Record<string, unknown>,
  field: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [replica, counter] of Object.entries(raw)) {
    if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0) {
      throw new HttpError(400, `${field}[${JSON.stringify(replica)}] must be a non-negative integer`);
    }
    out[replica] = counter;
  }
  return out;
}

/**
 * Structural op validation — the wire is untrusted even behind the HMAC
 * (a defect must surface as 400, never as a corrupted op log). The rules
 * are exactly the shapes rowsToOps round-trips: string keys, integer
 * Lamport counters, string values (item-set additionally carries null —
 * the store row's NULL). Anything else JSON can express (objects as
 * values, float counters) would be silently lossy downstream, so it dies
 * here.
 */
function validateOp(raw: unknown): CrdtOp {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'ops entries must be objects');
  }
  const o = raw as Record<string, unknown>;
  const kind = o['kind'];
  if (typeof kind !== 'string' || !OP_KINDS.has(kind)) {
    throw new HttpError(400, `unknown op kind ${JSON.stringify(kind)}`);
  }
  const key = o['key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new HttpError(400, 'op key must be a non-empty string');
  }
  const tsRaw = o['ts'];
  if (tsRaw === null || typeof tsRaw !== 'object' || Array.isArray(tsRaw)) {
    throw new HttpError(400, 'op ts must be an object');
  }
  const tsRec = tsRaw as Record<string, unknown>;
  const counter = tsRec['counter'];
  const replica = tsRec['replica'];
  if (typeof replica !== 'string' || replica.length === 0) {
    throw new HttpError(400, 'op ts.replica must be a non-empty string');
  }
  if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0) {
    throw new HttpError(400, 'op ts.counter must be a non-negative integer');
  }
  const ts: Lamport = { counter, replica };
  const value = o['value'];
  switch (kind as CrdtOp['kind']) {
    case 'item-set': {
      if (value !== null && typeof value !== 'string') {
        throw new HttpError(400, 'item-set value must be a string or null');
      }
      return { kind: 'item-set', key, value, ts };
    }
    case 'item-del':
      return { kind: 'item-del', key, ts };
    case 'tag-add': {
      if (typeof value !== 'string') {
        throw new HttpError(400, 'tag-add value must be a string');
      }
      return { kind: 'tag-add', key, value, ts };
    }
    case 'tag-del':
      return { kind: 'tag-del', key, ts };
    case 'entity-add': {
      if (typeof value !== 'string') {
        throw new HttpError(400, 'entity-add value must be a string');
      }
      return { kind: 'entity-add', key, value, ts };
    }
    case 'entity-del': {
      // The tombstone is the (key, ts) pair; the kernel pins the carried
      // value to '' regardless — accept a string if sent, normalize.
      if (value !== undefined && typeof value !== 'string') {
        throw new HttpError(400, 'entity-del value must be a string');
      }
      return { kind: 'entity-del', key, value: '', ts };
    }
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

/** Base URL → the exchange endpoint (`<base>/federation/crdt`). */
function endpointOf(baseUrl: string): string {
  const u = new URL(baseUrl);
  const prefix = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${prefix}${EXCHANGE_PATH}`;
}

/**
 * palace_meta key for THIS side's belief of what the endpoint holds — the
 * endpoint's FULL WHATWG identity: `u.host` (already lowercased by the URL
 * parser, IPv6 literals kept in brackets, explicit port kept in place)
 * plus the path prefix and the route, mirroring endpointOf. This keeps
 * two endpoints on the same host:port behind DIFFERENT proxy prefixes on
 * two belief entries instead of one shared (and therefore wrong) one, and
 * IPv6 hosts on well-formed keys. Keys minted by the pre-path format
 * (hostname:port only) simply read as absent from now on — one full
 * exchange follows, whose op dedup absorbs the superset: the safe
 * fallback direction, never a missed op.
 */
function httpWatermarkKey(baseUrl: string): string {
  const u = new URL(baseUrl);
  const prefix = u.pathname.replace(/\/+$/, '');
  return `crdt:http-wm:${u.host}${prefix}${EXCHANGE_PATH}`;
}

async function exchange(
  endpoint: string,
  secret: string,
  request: CrdtExchangeRequest,
  timeoutMs: number,
): Promise<CrdtExchangeResponse> {
  const body = Buffer.from(JSON.stringify(request), 'utf8');
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
      body: new Uint8Array(body),
      signal: controller.signal,
    });
    const text = await readResponseText(res);
    if (!res.ok) {
      throw new Error(`crdt http exchange failed: HTTP ${res.status} (${statusDetail(text)})`);
    }
    return parseExchangeResponse(text);
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`crdt http exchange to ${endpoint} timed out after ${timeoutMs} ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the exchange response body under the 64 MiB cap. The trust
 * boundary is the shared secret (only holders run servers we talk to),
 * but memory commitment to a remote endpoint must still be bounded: a
 * declared Content-Length over the cap rejects BEFORE any read; an
 * undeclared body is counted chunk-by-chunk as it streams in, so a lying
 * header cannot smuggle an endless stream past the cap. exchange()'s
 * AbortController keeps covering this whole read — a slow-drip oversized
 * body still lands in the timeout path, and an abort mid-read rejects
 * the pending reader.read().
 */
async function readResponseText(res: Response): Promise<string> {
  const declaredRaw = res.headers.get('content-length');
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(RESPONSE_CAP_MESSAGE);
    }
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    // The DOM/undici stream generic lands as `any` under this tsconfig —
    // pin it back to the byte chunks fetch actually delivers.
    const chunk = result.value as Uint8Array;
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      // Tell the peer to stop sending instead of pinning the socket on a
      // body nobody will finish reading.
      void reader.cancel().catch(() => undefined);
      throw new Error(RESPONSE_CAP_MESSAGE);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Short human-readable detail from an error response body (ours: {error}). */
function statusDetail(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const msg = (parsed as Record<string, unknown>)['error'];
      if (typeof msg === 'string' && msg.length > 0) return msg;
    }
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return text.slice(0, 120);
}

function parseExchangeResponse(text: string): CrdtExchangeResponse {
  const parsed = parseJson(text, 'crdt exchange response is not valid JSON');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('malformed crdt exchange response: not an object');
  }
  const rec = parsed as Record<string, unknown>;
  const rawOps = rec['ops'];
  if (!Array.isArray(rawOps)) {
    throw new Error('malformed crdt exchange response: ops must be an array');
  }
  let ops: CrdtOp[];
  try {
    ops = rawOps.map((op) => validateOp(op));
  } catch (e) {
    throw new Error(`malformed crdt exchange response: ${messageOf(e)}`);
  }
  const wants = rec['serverWatermarks'];
  if (wants === null || typeof wants !== 'object' || Array.isArray(wants)) {
    throw new Error('malformed crdt exchange response: serverWatermarks must be an object');
  }
  let serverWatermarks: Record<string, number>;
  try {
    serverWatermarks = validateWatermarks(wants as Record<string, unknown>, 'serverWatermarks');
  } catch (e) {
    throw new Error(`malformed crdt exchange response: ${messageOf(e)}`);
  }
  const fingerprint = rec['fingerprint'];
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new Error('malformed crdt exchange response: fingerprint must be a string');
  }
  return { ops, serverWatermarks, fingerprint };
}

export interface RemoteCrdtPeerOptions {
  /** Exchange timeout. Default 10 s. */
  timeoutMs?: number;
  /** The local peer every CrdtPeer member resolves against. */
  local: CrdtPeer;
}

/**
 * A CrdtPeer VIEW of a remote endpoint that resolves every member against
 * the LOCAL federation (replicaId, opsSince, importOps, watermarks and
 * fingerprint all delegate to `local`). The wire work is syncOverHttp's;
 * this handle exists so call sites that type against the CrdtPeer
 * interface — including CrdtFederation.sync's non-federation branch —
 * accept the remote pairing.
 *
 * Construction performs ONE empty handshake round (push nothing, ask for
 * the delta above what we hold) purely to prove reachability and the
 * shared secret — a wrong secret rejects with 401, a dead endpoint with
 * a network error. The response is validated and DISCARDED: constructing
 * a handle must not mutate the local log or its watermark bookkeeping.
 */
export async function remoteCrdtPeer(
  url: string,
  secret: string,
  opts: RemoteCrdtPeerOptions,
): Promise<CrdtPeer> {
  await exchange(
    endpointOf(url),
    secret,
    { replica: opts.local.replicaId, ops: [], clientWantsSince: opts.local.watermarks() },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const local = opts.local;
  return {
    replicaId: local.replicaId,
    opsSince: (watermarks) => local.opsSince(watermarks),
    importOps: (ops) => local.importOps(ops),
    watermarks: () => local.watermarks(),
    fingerprint: () => local.fingerprint(),
  };
}

export interface SyncOverHttpOptions {
  /** Exchange timeout. Default 10 s. */
  timeoutMs?: number;
}

export interface HttpSyncReport {
  /** local.fingerprint() === the response digest after the round. */
  converged: boolean;
  /** Ops shipped to the endpoint — the delta above the persisted endpoint watermark. */
  sent: number;
  /** Ops applied from the endpoint's response (count as returned by importOps). */
  received: number;
}

/**
 * One full round, THIS side → the remote endpoint:
 *
 *   1. push  local.opsSince(persisted endpoint watermark)     ({} = full log)
 *   2. pull  the endpoint's ops above local.watermarks()
 *   3. apply local.importOps(response.ops)
 *   4. persist response.serverWatermarks under the endpoint watermark key
 *      (full host+path identity — see httpWatermarkKey)
 *   5. converged = local.fingerprint() === response.fingerprint
 *
 * Unlike the local federation sync, the endpoint watermark persists
 * UNCONDITIONALLY: it records the server's ACTUAL holdings at response
 * time, and a stale-low belief only re-sends (dedup absorbs it). A
 * reverse-direction round may re-ship ops this side learned out-of-band —
 * the endpoint's belief is one exchange older than its log — which is
 * redundant, never divergent.
 */
export async function syncOverHttp(
  local: CrdtFederation,
  url: string,
  secret: string,
  opts?: SyncOverHttpOptions,
): Promise<HttpSyncReport> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = httpWatermarkKey(url);
  // Persisted belief of what the endpoint holds. Any defect — missing key,
  // non-JSON text, wrong shape, non-integer counter — reads as {} = the
  // FULL log (the loadPeerWatermark fallback law).
  const lastWm = parsePersistedWatermarks(local.store.getMeta(key));
  const ops = local.opsSince(lastWm);
  const response = await exchange(
    endpointOf(url),
    secret,
    { replica: local.replicaId, ops, clientWantsSince: local.watermarks() },
    timeoutMs,
  );
  const received = local.importOps(response.ops);
  local.store.setMeta(key, JSON.stringify(response.serverWatermarks));
  return {
    converged: local.fingerprint() === response.fingerprint,
    sent: ops.length,
    received,
  };
}

/** loadPeerWatermark's defect discipline, endpoint-flavored. */
function parsePersistedWatermarks(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [replica, counter] of Object.entries(parsed)) {
      if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0) return {};
      out[replica] = counter;
    }
    return out;
  } catch {
    return {};
  }
}
