/**
 * Semantic query cache — near-duplicate questions skip the scoring
 * pipeline entirely.
 *
 * Agents re-ask: the same user probes memory with slight rephrasings
 * ("how do we deploy phoenix" vs "how was phoenix deployed again?").
 * Re-running the full scan+PRF+MMR pipeline for each is waste. This cache
 * keys entries by the SAME deterministic anchor-plane buckets the
 * compressor uses (utils/anchors.ts), then guards every bucket hit with an
 * exact cosine re-check against the stored query vector — the anchor
 * buckets only localize the search; the similarity THRESHOLD decides the
 * hit, so a cache hit is always a genuine near-duplicate, never an
 * approximation.
 *
 * Correctness under writes: every entry stamps the store's data version;
 * any memory write invalidates the whole cache (coarse but sound — writes
 * are far rarer than reads in a memory palace). LRU-bounded.
 */

import { cosine } from './embedding.js';
import { anchorKey, neighborKeys } from './anchors.js';

export interface CacheEntry<T> {
  vector: Float32Array;
  value: T;
  version: number;
  storedAt: number;
}

export interface SemanticQueryCacheOptions {
  /** Max entries (LRU). Default 32. */
  capacity?: number;
  /** Cosine required to treat a query as a repeat. Default 0.985. */
  threshold?: number;
}

export class SemanticQueryCache<T> {
  private readonly capacity: number;
  private readonly threshold: number;
  /** paramsKey → anchor bucket → entries. Map insertion order = LRU age. */
  private readonly entries = new Map<string, Map<string, CacheEntry<T>[]>>();
  private size = 0;

  constructor(opts: SemanticQueryCacheOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 32);
    this.threshold = Math.min(1, Math.max(0.5, opts.threshold ?? 0.985));
  }

  get count(): number {
    return this.size;
  }

  /**
   * Look up a previous result for a near-identical query vector under the
   * same parameters. Anchor buckets localize; cosine re-check decides.
   */
  lookup(queryVector: Float32Array, paramsKey: string, version: number): T | undefined {
    const byBucket = this.entries.get(paramsKey);
    if (!byBucket) return undefined;
    const key = anchorKey(queryVector);
    for (const bucket of neighborKeys(key)) {
      const list = byBucket.get(bucket);
      if (!list) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (e.version !== version) {
          // stale under the current data version — drop lazily
          list.splice(i, 1);
          this.size--;
          continue;
        }
        if (cosine(queryVector, e.vector) >= this.threshold) {
          // LRU refresh: move to the end of the map's insertion order
          list.splice(i, 1);
          list.push(e);
          return e.value;
        }
      }
    }
    return undefined;
  }

  /** Store a result for a query vector under its parameters. */
  store(queryVector: Float32Array, paramsKey: string, version: number, value: T): void {
    let byBucket = this.entries.get(paramsKey);
    if (!byBucket) {
      byBucket = new Map();
      this.entries.set(paramsKey, byBucket);
    }
    const key = anchorKey(queryVector);
    const list = byBucket.get(key) ?? [];
    byBucket.set(key, list);
    list.push({ vector: queryVector, value, version, storedAt: Date.now() });
    this.size++;
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.size > this.capacity) {
      // Oldest paramsKey first (Map preserves insertion order).
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      const byBucket = this.entries.get(oldestKey)!;
      let removed = false;
      for (const [bucket, list] of byBucket) {
        if (list.length > 0) {
          list.shift(); // oldest entry in the oldest bucket
          this.size--;
          removed = true;
          if (list.length === 0) byBucket.delete(bucket);
          break;
        }
      }
      if (!removed || byBucket.size === 0) this.entries.delete(oldestKey);
      if (!removed && this.entries.delete(oldestKey)) {
        // defensive: params bucket empty
      }
    }
  }
}
