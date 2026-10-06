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
 * approximation. lookup() additionally runs an exact full scan of the
 * paramsKey's entries after the anchor neighborhood misses (see lookup):
 * cache-hit sufficiency therefore does NOT depend on the LSH bucket
 * geometry — the buckets are a fast path, not a correctness assumption.
 *
 * Correctness under writes: every entry stamps the store's COMPOSITE
 * version stamp (MemoryStore.dataVersionStamp() → the string
 * `<epoch>:<version>`); any memory write invalidates the whole cache
 * (coarse but sound — writes are far rarer than reads in a memory
 * palace). The stamp is a string compared with strict !==: the epoch
 * half namespaces the 32-bit user_version counter, so when the counter
 * wraps at INT32_MAX every pre-wrap entry mismatches by construction —
 * false freshness after a wrap is unrepresentable, not merely
 * improbable. LRU-bounded.
 */

import { cosine } from './embedding.js';
import { anchorKey, neighborKeys } from './anchors.js';

export interface CacheEntry<T> {
  vector: Float32Array;
  value: T;
  /** Composite cache stamp `<epoch>:<version>` (see file header). */
  version: string;
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
   *
   * D-10: near-duplicates whose anchor key flips ≥2 sign bits fall outside
   * the Hamming-1 neighborhood, so the bucket fast path alone would miss
   * them. After the neighborhood misses, a FULL fallback scan covers every
   * remaining entry of this paramsKey with the same exact cosine ≥
   * threshold check. From this point on, cache-hit sufficiency does not
   * depend on the LSH bucket geometry at all — the buckets stay as a cheap
   * fast path, and capacity is bounded (default 32 entries), which makes
   * the full scan a negligible-cost correctness net.
   */
  lookup(queryVector: Float32Array, paramsKey: string, version: string): T | undefined {
    const byBucket = this.entries.get(paramsKey);
    if (!byBucket) return undefined;
    const key = anchorKey(queryVector);
    // Neighborhood first (fast path), then every other bucket of this
    // paramsKey (fallback). Buckets are visited at most once, so an entry
    // is never cosine-checked twice per lookup.
    const neighborhood = new Set(neighborKeys(key));
    const buckets: string[] = [...neighborhood];
    for (const bucket of byBucket.keys()) {
      if (!neighborhood.has(bucket)) buckets.push(bucket);
    }
    for (const bucket of buckets) {
      const list = byBucket.get(bucket);
      if (!list) continue;
      const hit = this.scanList(list, queryVector, version);
      if (list.length === 0) byBucket.delete(bucket);
      if (hit) {
        // LRU refresh, entry level: scanList already moved it to the end
        // of its bucket list. LRU refresh, params level: re-insert the
        // paramsKey so Map insertion order tracks recency, not first-seen
        // order.
        this.entries.delete(paramsKey);
        this.entries.set(paramsKey, byBucket);
        return hit.value;
      }
    }
    if (byBucket.size === 0) this.entries.delete(paramsKey);
    return undefined;
  }

  /**
   * Exact per-entry probe of one bucket list, newest-first. Lazily drops
   * stale-stamp entries (strict !== on the composite `<epoch>:<version>`
   * string — a mismatch includes, by design, every entry from a
   * pre-wrap epoch); on a cosine ≥ threshold match, refreshes the
   * entry's LRU position within its list and returns it.
   */
  private scanList(
    list: CacheEntry<T>[],
    queryVector: Float32Array,
    version: string,
  ): CacheEntry<T> | null {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e === undefined) continue;
      if (e.version !== version) {
        // stale under the current data version — drop lazily
        list.splice(i, 1);
        this.size--;
        continue;
      }
      if (cosine(queryVector, e.vector) >= this.threshold) {
        // LRU refresh, entry level: move to the end of the bucket list
        list.splice(i, 1);
        list.push(e);
        return e;
      }
    }
    return null;
  }

  /**
   * Store a result for a query vector under its parameters.
   *
     * Near-duplicate replacement: agents re-ask the same question, and
     * every re-ask stores a result — appending blindly would pile copies
     * of one query into the buckets, burning capacity on duplicates and
     * evicting DISTINCT entries in their favor. When the new vector is a
     * cosine near-duplicate (≥ threshold) of an existing entry anywhere in
     * the anchor neighborhood (lookup() additionally searches the rest of
     * the paramsKey via its fallback scan — a superset here would only
     * change WHICH copy survives, never correctness), the most similar old
     * entry is REPLACED instead (size unchanged; the bucket that held it
     * is deleted if it empties, so no empty-bucket leak).
   */
  store(queryVector: Float32Array, paramsKey: string, version: string, value: T): void {
    let byBucket = this.entries.get(paramsKey);
    if (byBucket) {
      // LRU refresh: a store under a known paramsKey counts as use.
      this.entries.delete(paramsKey);
      this.entries.set(paramsKey, byBucket);
    } else {
      byBucket = new Map();
      this.entries.set(paramsKey, byBucket);
    }
    const key = anchorKey(queryVector);

    let dupBucket: string | null = null;
    let dupList: CacheEntry<T>[] | null = null;
    let dupIdx = -1;
    let bestSim = this.threshold;
    for (const bucket of neighborKeys(key)) {
      const list = byBucket.get(bucket);
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (entry === undefined) continue;
        const sim = cosine(queryVector, entry.vector);
        if (sim > bestSim) {
          bestSim = sim;
          dupBucket = bucket;
          dupList = list;
          dupIdx = i;
        }
      }
    }
    if (dupList && dupBucket !== null) {
      dupList.splice(dupIdx, 1);
      if (dupList.length === 0) byBucket.delete(dupBucket);
    } else {
      this.size++;
    }

    const list = byBucket.get(key) ?? [];
    byBucket.set(key, list);
    // Defensive copy: callers routinely reuse their embedding buffer, and a
    // by-reference store would let a later mutation silently poison every
    // cosine re-check this entry ever serves. Pairs with the lookup side's
    // discipline of never handing stored vectors back out; at the default
    // capacity of 32 entries × dims the copied footprint is acceptable.
    list.push({ vector: queryVector.slice(), value, version, storedAt: Date.now() });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.size > this.capacity) {
      // Least recently used paramsKey first (Map order = recency order,
      // maintained by the delete+set refreshes in lookup/store).
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      const byBucket = this.entries.get(oldestKey);
      // oldestKey came from this map, so the get cannot miss.
      if (byBucket === undefined) return;
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
    }
  }
}
