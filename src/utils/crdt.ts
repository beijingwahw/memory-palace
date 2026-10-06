/**
 * CRDT kernel — conflict-free replicated memory palaces.
 *
 * THE CONTRACT: N palaces accept writes independently (multi-master), go
 * offline, reconnect in ANY order; after exchanging op logs they converge
 * to byte-identical state — strong eventual consistency — with no
 * coordinator. The three merge laws hold for every entity type:
 *
 *   commutative:  merge(a, b) === merge(b, a)
 *   associative:  merge(a, merge(b, c)) === merge(merge(a, b), c)
 *   idempotent:   merge(a, a) === a
 *
 * ENTITY MODELS:
 *   - LWW-Map   (items, core blocks): last-writer-wins per KEY, ordered
 *     by (lamport, replicaId) — total order, deterministic tie-break.
 *   - OR-Set    (tags, entities): add-wins with per-element birth tags;
 *     remove only kills observed tags (concurrent add survives).
 *   - LWW value (importance, visibility): scalar register.
 *
 * Timestamps are Lamport: (counter, replicaId) — monotonic per replica,
 * comparable across replicas without wall-clock trust.
 */

import { invariant } from './invariants.js';

// ── Lamport clock ────────────────────────────────────────────────────────────

export interface Lamport {
  counter: number;
  replica: string;
}

export function lamportTick(c: Lamport): Lamport {
  return { counter: c.counter + 1, replica: c.replica };
}

export function lamportReceive(local: Lamport, remote: Lamport): Lamport {
  return { counter: Math.max(local.counter, remote.counter) + 1, replica: local.replica };
}

/** Total order: counter, then replica id — deterministic across replicas. */
export function lamportCompare(a: Lamport, b: Lamport): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0;
}

// ── LWW-Map (items / core blocks) ───────────────────────────────────────────

export interface LwwEntry<V> {
  key: string;
  value: V | null; // null = tombstone (remove wins over stale adds)
  ts: Lamport;
}

export type LwwMap<V> = Map<string, LwwEntry<V>>;

/** Apply one entry; LWW by (lamport, replica). Idempotent by ts equality. */
export function lwwApply<V>(m: LwwMap<V>, e: LwwEntry<V>): LwwMap<V> {
  const prev = m.get(e.key);
  if (!prev || lamportCompare(e.ts, prev.ts) > 0) {
    m.set(e.key, e);
  }
  return m;
}

/** Merge = apply every entry from both sides. All three laws hold. */
export function lwwMerge<V>(a: LwwMap<V>, b: LwwMap<V>): LwwMap<V> {
  for (const e of b.values()) lwwApply(a, e);
  return a;
}

/** Live values (tombstones filtered) — the materialized view. */
export function lwwLive<V>(m: LwwMap<V>): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, e] of m) if (e.value !== null) out.set(k, e.value);
  return out;
}

// ── OR-Set (tags / entities) ────────────────────────────────────────────────

export type OrSet<T> = Map<string, { tag: Lamport; value: T }>;
/** Per-key remove tombstones (LWW) — the OR in OR-Set. */
export type OrTombstones = Map<string, Lamport>;

/**
 * Element tag: `<key>@<counter>:<replica>`. Keys may legally contain '@'
 * (e.g. an entity name like `ops@corp`), so DECODING must cut at the LAST
 * '@' — `split('@')[0]` truncates such keys, misattributes tombstones to
 * the wrong element, and quietly breaks convergence.
 */
function orTag(key: string, tag: Lamport): string {
  return `${key}@${tag.counter}:${tag.replica}`;
}

/** Inverse of orTag — see the note above on why it is lastIndexOf. */
function orTagKey(tagged: string): string {
  const at = tagged.lastIndexOf('@');
  return at === -1 ? tagged : tagged.slice(0, at);
}

export interface OrState<T> {
  elements: OrSet<T>;
  tombstones: OrTombstones;
}

export function emptyOr<T>(): OrState<T> {
  return { elements: new Map(), tombstones: new Map() };
}

/**
 * Add is tagged; it survives any remove whose timestamp is NOT strictly
 * later (concurrent adds win — the add-wins guarantee).
 */
export function orAdd<T>(st: OrState<T>, key: string, value: T, ts: Lamport): OrState<T> {
  const rm = st.tombstones.get(key);
  if (rm && lamportCompare(rm, ts) > 0) return st; // remove already won
  st.elements.set(orTag(key, ts), { tag: ts, value });
  return st;
}

/** Remove records a per-key tombstone at NOW; kills earlier tags only. */
export function orRemove<T>(st: OrState<T>, key: string, ts: Lamport): OrState<T> {
  const prev = st.tombstones.get(key);
  if (!prev || lamportCompare(ts, prev) > 0) st.tombstones.set(key, ts);
  // Kill already-present elements this remove dominates (older tags).
  for (const [tagged, e] of [...st.elements]) {
    if (orTagKey(tagged) !== key) continue;
    // The branch above wrote (or kept) this key's tombstone, so the get
    // cannot miss — merge laws depend on it, hence asserted not assumed.
    const rm = st.tombstones.get(key);
    invariant(rm !== undefined, 'orRemove records its tombstone above');
    if (lamportCompare(rm, e.tag) > 0) st.elements.delete(tagged);
  }
  return st;
}

/** Merge: union elements + LWW tombstones, then filter killed elements. */
export function orMerge<T>(a: OrState<T>, b: OrState<T>): OrState<T> {
  for (const [k, v] of b.elements) if (!a.elements.has(k)) a.elements.set(k, v);
  for (const [k, ts] of b.tombstones) {
    const prev = a.tombstones.get(k);
    if (!prev || lamportCompare(ts, prev) > 0) a.tombstones.set(k, ts);
  }
  // Drop elements killed by the merged tombstone set.
  for (const [tagged, e] of [...a.elements]) {
    const key = orTagKey(tagged);
    const rm = a.tombstones.get(key);
    if (rm && lamportCompare(rm, e.tag) > 0) a.elements.delete(tagged);
  }
  return a;
}

/** Current members (latest surviving tag per key). */
export function orMembers<T>(st: OrState<T>): Map<string, T> {
  const byKey = new Map<string, { ts: Lamport; value: T }>();
  for (const [tagged, { tag, value }] of st.elements) {
    const key = orTagKey(tagged);
    const prev = byKey.get(key);
    if (!prev || lamportCompare(tag, prev.ts) > 0) byKey.set(key, { ts: tag, value });
  }
  const out = new Map<string, T>();
  for (const [k, v] of byKey) out.set(k, v.value);
  return out;
}

// ── Op log (the sync transport unit) ────────────────────────────────────────

export type CrdtOp =
  | { kind: 'item-set'; key: string; value: unknown; ts: Lamport }
  | { kind: 'item-del'; key: string; ts: Lamport }
  | { kind: 'tag-add'; key: string; value: string; ts: Lamport }
  | { kind: 'tag-del'; key: string; ts: Lamport }
  | { kind: 'entity-add'; key: string; value: string; ts: Lamport }
  /** Entity deletion: value is ALWAYS the empty string (carried only for
   *  uniform row shape — the tombstone is the (key, ts) pair, item-del
   *  style). applyOps records it in the OR-Set's per-key LWW tombstones. */
  | { kind: 'entity-del'; key: string; value: ''; ts: Lamport };

/** Deterministic op ordering for log exchange (ts then kind then key). */
export function opCompare(a: CrdtOp, b: CrdtOp): number {
  const c = lamportCompare(a.ts, b.ts);
  if (c !== 0) return c;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Apply a batch of ops to a fresh CRDT doc state. Deterministic: applying
 * the same op SET in any order yields the same state (each entity is an
 * independent CRDT; ops on the same entity resolve by LWW/OR semantics).
 */
export interface CrdtDocState {
  items: LwwMap<unknown>;
  tags: OrState<string>;
  entities: OrState<string>;
}

export function emptyDoc(): CrdtDocState {
  return { items: new Map(), tags: emptyOr(), entities: emptyOr() };
}

export function applyOps(doc: CrdtDocState, ops: readonly CrdtOp[]): CrdtDocState {
  // Normalize to the canonical total order first — the same op SET yields
  // the same state regardless of the order it was received in (the
  // commutativity law, made structural).
  const ordered = [...ops].sort(opCompare);
  for (const op of ordered) {
    switch (op.kind) {
      case 'item-set':
        lwwApply(doc.items, { key: op.key, value: op.value, ts: op.ts });
        break;
      case 'item-del':
        lwwApply(doc.items, { key: op.key, value: null, ts: op.ts });
        break;
      case 'tag-add':
        orAdd(doc.tags, op.key, op.value, op.ts);
        break;
      case 'tag-del':
        orRemove(doc.tags, op.key, op.ts);
        break;
      case 'entity-add':
        orAdd(doc.entities, op.key, op.value, op.ts);
        break;
      case 'entity-del':
        // LWW tombstone, same shape of treatment as item-del: the delete
        // records its (key, ts) in the OR-Set's per-key LWW tombstone map
        // and kills only the tags it dominates (concurrent re-add wins).
        orRemove(doc.entities, op.key, op.ts);
        break;
    }
  }
  return doc;
}

/** Merge two doc states (for state-based sync when op logs are trimmed). */
export function mergeDocs(a: CrdtDocState, b: CrdtDocState): CrdtDocState {
  lwwMerge(a.items, b.items);
  orMerge(a.tags, b.tags);
  orMerge(a.entities, b.entities);
  return a;
}

/**
 * Comparable state digest for convergence assertions. Canonical key:value
 * PAIRS for every entity (items via the live LWW view, tags/entities via
 * surviving OR-Set members), each pair encoded as JSON so no separator
 * can collide. STATE equality, not key-set equality: replicas holding
 * different values under the same keys must NOT fingerprint equal — a
 * key-only digest would bless value divergence as convergence.
 */
export function docFingerprint(doc: CrdtDocState): string {
  const pair = (k: string, v: unknown) => JSON.stringify([k, v]);
  const items = [...lwwLive(doc.items).entries()].map(([k, v]) => pair(k, v)).sort();
  const tags = [...orMembers(doc.tags).entries()].map(([k, v]) => pair(k, v)).sort();
  const entities = [...orMembers(doc.entities).entries()].map(([k, v]) => pair(k, v)).sort();
  return JSON.stringify({ items, tags, entities });
}
