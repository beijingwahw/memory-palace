/**
 * Embedding abstraction with runtime failover.
 *
 *  - DeepSeek Embedding API (https://api.deepseek.com/v1/embeddings)
 *    High quality, requires API key, network round-trip.
 *  - Offline BM25-style sparse vector (deterministic, zero-dependency,
 *    used as fallback when offline / no key / cost-sensitive).
 *
 * Both implementations normalize to L2 unit length so cosine similarity
 * reduces to a dot product.
 *
 * ## Vector spaces (the subtle part)
 *
 * Vectors produced by different providers live in DIFFERENT mathematical
 * spaces: a DeepSeek dense vector and a hashed offline vector may share a
 * dimension count, but their coordinates are incomparable, and cosine
 * similarity across spaces is noise. Every embedding therefore carries a
 * `space` tag (e.g. "deepseek:deepseek-embed", "offline-bm25:1024"), items
 * record which space produced them, and retrieval embeds the query once
 * per space present in the store — never comparing across spaces.
 *
 * ## Runtime failover
 *
 * `ResilientEmbeddingProvider` wraps the remote provider with a circuit
 * breaker: when the API is unreachable the circuit opens and embeddings
 * are served from the offline provider immediately (degraded but correct,
 * and correctly space-tagged). After a cool-down a single probe is allowed
 * through; on success the circuit closes again. Every circuit transition
 * is observable via the constructor's `onStateChange` and the `degraded`
 * getter reports whether the fallback space is currently serving.
 */

import { CircuitBreaker } from './circuit-breaker.js';
import { tokenize } from './tokenizer.js';

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  /** Identity of the vector space this provider emits (see module doc). */
  readonly space: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/** A vector plus the space it was computed in. */
export interface TaggedEmbedding {
  vector: Float32Array;
  space: string;
}

/**
 * Space-aware gateway used by services: ingest tags items with the space
 * that actually served them, and retrieval embeds queries per stored space.
 */
export interface EmbeddingGateway extends EmbeddingProvider {
  /** All spaces this gateway can embed in right now. */
  spaces(): string[];
  /** Embed `text` in `space`; null when that space is unavailable. */
  embedIn(space: string, text: string): Promise<Float32Array | null>;
  /** Best-effort embed now, reporting which space served it. */
  embedTagged(text: string): Promise<TaggedEmbedding>;
  /** Batch best-effort embed; a batch is served entirely by ONE space. */
  embedBatchTagged(texts: string[]): Promise<TaggedEmbedding[]>;
}

export interface DeepSeekEmbedOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * Abort the HTTP call after this many ms (default 15 s). Without a bound
   * a hung API never rejects and the guarding circuit breaker never trips;
   * the timeout rejection feeds the breaker exactly like any other failure.
   */
  timeoutMs?: number;
}

export class DeepSeekEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'deepseek';
  readonly dimensions: number;
  readonly space: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: DeepSeekEmbedOptions) {
    if (!opts.apiKey) throw new Error('DeepSeekEmbeddingProvider: apiKey required');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'deepseek-embed';
    this.baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.dimensions = 1024; // deepseek-embed default; overridden by API response
    this.space = `deepseek:${this.model}`;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await this.call([text]);
    return res[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.call(texts);
  }

  /**
   * POST /v1/embeddings. The fetch is bounded by `timeoutMs` via
   * AbortSignal.timeout so a hung API rejects instead of stalling the
   * caller forever — the timeout rejection reaches the wrapping circuit
   * breaker like any other failure and opens the circuit.
   */
  private async call(input: string[]): Promise<Float32Array[]> {
    const url = `${this.baseUrl}/v1/embeddings`;
    const body = {
      model: this.model,
      input,
      encoding_format: 'float',
    };
    const resp = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`DeepSeek embedding ${resp.status}: ${txt.slice(0, 500)}`);
    }
    const json = (await resp.json()) as {
      data: { embedding: number[]; index: number }[];
      model: string;
    };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => {
        const arr = new Float32Array(d.embedding);
        normalizeInPlace(arr);
        return arr;
      });
  }

  embedIn(space: string, text: string): Promise<Float32Array | null> {
    return space === this.space ? this.embed(text) : Promise.resolve(null);
  }

  spaces(): string[] {
    return [this.space];
  }

  async embedTagged(text: string): Promise<TaggedEmbedding> {
    return { vector: await this.embed(text), space: this.space };
  }

  async embedBatchTagged(texts: string[]): Promise<TaggedEmbedding[]> {
    const vectors = await this.embedBatch(texts);
    return vectors.map((vector) => ({ vector, space: this.space }));
  }
}

/**
 * Offline sparse embedding. Each dimension corresponds to a hashed token.
 * Quality is much lower than a real embedding model but it is:
 *   - zero-dependency
 *   - deterministic
 *   - good enough as a fallback when the API is unreachable
 *
 * The vector dimension defaults to 1024 to keep the on-disk layout
 * compatible with deepseek-embed so the rest of the storage layer
 * never has to special-case dimensions. The space tag still keeps the
 * two apart — same width never means same space.
 */
export class OfflineBM25EmbeddingProvider implements EmbeddingProvider {
  readonly name = 'offline-bm25';
  readonly dimensions: number;
  readonly space: string;

  constructor(dimensions = 1024) {
    this.dimensions = dimensions;
    this.space = `offline-bm25:${dimensions}`;
  }

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    const toks = tokenize(text);
    if (toks.length === 0) return v;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [tok, count] of tf) {
      const idx = hash32(tok) % this.dimensions;
      // sublinear TF: 1 + log(count)
      v[idx] += 1 + Math.log(count);
    }
    normalizeInPlace(v);
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async embedIn(space: string, text: string): Promise<Float32Array | null> {
    return space === this.space ? this.embed(text) : null;
  }

  spaces(): string[] {
    return [this.space];
  }

  async embedTagged(text: string): Promise<TaggedEmbedding> {
    return { vector: await this.embed(text), space: this.space };
  }

  async embedBatchTagged(texts: string[]): Promise<TaggedEmbedding[]> {
    const vectors = await this.embedBatch(texts);
    return vectors.map((vector) => ({ vector, space: this.space }));
  }
}

/**
 * Failover gateway: primary (remote) guarded by a circuit breaker, with
 * the offline provider as an always-available fallback. Every embed
 * reports the space that served it so callers never mislabel vectors.
 */
export class ResilientEmbeddingProvider implements EmbeddingGateway {
  readonly name: string;
  readonly dimensions: number;
  /**
   * The gateway's `space` is its PRIMARY space (used for legacy backfill
   * and as the default for pre-computed query embeddings). Which space
   * actually served a call is always reported by embedTagged/embedIn.
   */
  readonly space: string;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly primary: EmbeddingProvider & EmbeddingGateway,
    private readonly fallback: OfflineBM25EmbeddingProvider,
    breaker?: CircuitBreaker,
    /**
     * Notified on every circuit transition of the gateway's breaker:
     * closed→open (degraded, offline vectors now serve), open→half-open
     * (probe going out), half-open→open (probe failed), half-open→closed
     * (recovered). Wired into the gateway's own breaker; when a custom
     * breaker is injected, attach its onTransition at its construction.
     */
    onStateChange?: (from: string, to: string) => void,
  ) {
    this.name = `${primary.name}+fallback`;
    this.dimensions = fallback.dimensions; // offline layout drives storage size
    this.space = primary.space;
    this.breaker = breaker ?? new CircuitBreaker({ onTransition: onStateChange });
  }

  /** Space the primary would serve in (used to backfill legacy rows). */
  get primarySpace(): string {
    return this.primary.space;
  }

  get breakerState(): string {
    return this.breaker.currentState;
  }

  /**
   * True while the active serving space is the fallback, defined precisely
   * as `breaker.currentState !== 'closed'`: `open` means every embed falls
   * through to the offline provider, `half-open` means a probe may go out
   * but recovery is not yet confirmed.
   */
  get degraded(): boolean {
    return this.breaker.currentState !== 'closed';
  }

  spaces(): string[] {
    // Report both; embedIn returns null for the primary while the circuit
    // is open, and callers skip that space for this query.
    return [this.primary.space, this.fallback.space];
  }

  async embed(text: string): Promise<Float32Array> {
    return (await this.embedTagged(text)).vector;
  }

  async embedTagged(text: string): Promise<TaggedEmbedding> {
    if (this.breaker.canAttempt()) {
      try {
        const vector = await this.primary.embed(text);
        this.breaker.recordSuccess();
        return { vector, space: this.primary.space };
      } catch {
        this.breaker.recordFailure();
      }
    }
    return this.fallback.embedTagged(text);
  }

  async embedIn(space: string, text: string): Promise<Float32Array | null> {
    if (space === this.fallback.space) return this.fallback.embed(text);
    if (space !== this.primary.space) return null; // unknown/retired space
    if (!this.breaker.canAttempt()) return null;
    try {
      const vector = await this.primary.embed(text);
      this.breaker.recordSuccess();
      return vector;
    } catch {
      this.breaker.recordFailure();
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.breaker.canAttempt()) {
      try {
        const out = await this.primary.embedBatch(texts);
        this.breaker.recordSuccess();
        return out;
      } catch {
        this.breaker.recordFailure();
      }
    }
    return this.fallback.embedBatch(texts);
  }

  /**
   * Batch embed where the WHOLE batch is served by one space: try the
   * primary batch first; on failure the offline provider serves the entire
   * batch — mixed-space batches never happen.
   */
  async embedBatchTagged(texts: string[]): Promise<TaggedEmbedding[]> {
    if (texts.length === 0) return [];
    if (this.breaker.canAttempt()) {
      try {
        const out = await this.primary.embedBatchTagged(texts);
        this.breaker.recordSuccess();
        return out;
      } catch {
        this.breaker.recordFailure();
      }
    }
    return this.fallback.embedBatchTagged(texts);
  }
}

export function normalizeInPlace(v: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  if (sum === 0) return;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Stable 32-bit FNV-1a hash for tokens. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createEmbeddingProvider(cfg: {
  provider: 'deepseek' | 'offline-bm25';
  model: string;
  dimensions: number;
  apiKey?: string;
  baseUrl?: string;
}): EmbeddingGateway {
  if (cfg.provider === 'deepseek' && cfg.apiKey) {
    return new ResilientEmbeddingProvider(
      new DeepSeekEmbeddingProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      }),
      new OfflineBM25EmbeddingProvider(cfg.dimensions),
    );
  }
  // No key (or explicitly offline): the offline provider IS the gateway.
  return new OfflineBM25EmbeddingProvider(cfg.dimensions);
}
