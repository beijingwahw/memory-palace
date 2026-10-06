/**
 * CrdtFederation — multi-master palace sync without a coordinator.
 *
 * Each palace records CRDT ops in its local op log (v11). sync() is
 * anti-entropy with INCREMENTAL exchange: for every peer we persist a
 * per-replica watermark (`crdt:wm:<peerId>` in palace_meta) describing
 * what that peer already holds, and each sync ships only the ops above
 * it (store.listCrdtOpsSince). A missing or corrupt watermark reads as
 * "everything" — the full exchange of the pre-watermark era. INSERT OR
 * IGNORE dedupes by deterministic op_id, so re-sends are free and every
 * peer applies the SAME op set through the pure kernel — the three merge
 * laws guarantee all peers converge to identical state regardless of sync
 * order or repetition. Convergence is still judged on a FULL doc digest
 * (fingerprint replays the entire log — it never depends on how much was
 * exchanged); the delta only saves transport and peer-side apply work.
 *
 * The bridge to palace storage: ingestUserMemory writes also append an
 * item-set op; tombstones append item-del. Materialization (CRDT state →
 * store rows) rides the same ingestTx transactional path. This service
 * exposes the op exchange + convergence fingerprint; the full state-based
 * materializer is the capsule planImport path (content-addressed ids are
 * the CRDT keys — the merge key existed before the CRDT did).
 */

import { randomUUID } from 'node:crypto';
import {
  applyOps,
  docFingerprint,
  emptyDoc,
  lamportTick,
  opCompare,
  type CrdtOp,
  type Lamport,
} from '../utils/crdt.js';
import type { MemoryEventBus } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';

export interface SyncReport {
  replica: string;
  /** Ops shipped TO the peer — the DELTA above its persisted watermark. */
  opsSent: number;
  /** Ops taken FROM the peer — the delta above OUR persisted watermark. */
  opsReceived: number;
  /** Both peers' convergence digests after the exchange. */
  fingerprints: Record<string, string>;
  converged: boolean;
}

/**
 * Minimal peer surface extracted from sync()'s use of its counterpart —
 * the whole one-to-one exchange protocol in five members. sync() accepts
 * ANY CrdtPeer, and the HTTP transport (transport/crdt-http.ts) serves and
 * adapts exactly this surface: identity (replicaId, the watermark key),
 * delta request (opsSince — the ops this peer holds above per-replica
 * watermarks; `{}` deliberately means the FULL log), delta application
 * (importOps — idempotent by op_id), holdings report (watermarks — what
 * this peer currently holds, what a peer persists for us after a
 * converged exchange) and the convergence proof (fingerprint — a full-doc
 * digest that never depends on how much was exchanged).
 */
export interface CrdtPeer {
  readonly replicaId: string;
  /** ops this peer holds with counter > watermarks[replica] (per-replica) */
  opsSince(watermarks: Record<string, number>): CrdtOp[];
  /** idempotent apply; returns accepted count */
  importOps(ops: CrdtOp[]): number;
  /** full-doc convergence digest */
  fingerprint(): string;
  /** this peer's current per-replica max counters (what it now holds) */
  watermarks(): Record<string, number>;
}

/** Raw op-log row shape returned by the store's CRDT readers. */
interface CrdtOpRow {
  replica: string;
  counter: number;
  kind: string;
  key: string;
  value: string | null;
}

/** Map store rows onto kernel ops (lossy kinds recover `''` for shape). */
function rowsToOps(rows: readonly CrdtOpRow[]): CrdtOp[] {
  return rows.map((r) => {
    const ts: Lamport = { counter: r.counter, replica: r.replica };
    if (r.kind === 'item-set') {
      return { kind: 'item-set' as const, key: r.key, value: r.value, ts };
    }
    if (r.kind === 'item-del') return { kind: 'item-del' as const, key: r.key, ts };
    if (r.kind === 'tag-add') {
      return { kind: 'tag-add' as const, key: r.key, value: r.value ?? '', ts };
    }
    if (r.kind === 'tag-del') return { kind: 'tag-del' as const, key: r.key, ts };
    if (r.kind === 'entity-del') return { kind: 'entity-del' as const, key: r.key, value: '' as const, ts };
    return { kind: 'entity-add' as const, key: r.key, value: r.value ?? '', ts };
  });
}

export class CrdtFederation implements CrdtPeer {
  clock: Lamport;

  /**
   * Per-replica highest counter present in the local log — the live view
   * of what THIS replica holds. Kept in memory (seeded by the constructor
   * scan, advanced on every append through this instance) so a sync never
   * has to re-scan the whole log just to report its watermark. A stale-low
   * value is always safe (the peer re-sends, op_id dedup absorbs it); the
   * fingerprint check at every sync catches any divergence it could cause.
   */
  private readonly watermark = new Map<string, number>();

  constructor(
    /**
     * Backing store — public readonly for the same reason palace.store is:
     * transports persist endpoint-scoped bookkeeping in palace_meta next to
     * this federation's own watermark rows (the HTTP transport keeps its
     * endpoint watermark under `crdt:http-wm:<host:port>`). Read/write use
     * only changes that transport's own keys, never the op log.
     */
    readonly store: MemoryStore,
    replicaId: string = `replica-${randomUUID()}`,
    private bus: MemoryEventBus = NOOP_BUS,
  ) {
    // CLOCK RECOVERY: op_id is `<replica>:<counter>` and the log insert
    // is INSERT OR IGNORE — a restarted replica that reminted its counter
    // from 0 would collide with its OWN historical op_ids and every "new"
    // update would be silently dropped as a duplicate. Resume
    // from this replica's highest persisted counter (0 when no history).
    // (An omitted replicaId mints a fresh unique id, which is also safe:
    // a private counter space can never collide with past op_ids.)
    // The same scan seeds the in-memory watermark map for free — one full
    // read per process lifetime instead of one per sync.
    let maxCounter = 0;
    for (const op of this.store.listCrdtOps(0)) {
      this.noteOp(op.replica, op.counter);
      if (op.replica === replicaId && op.counter > maxCounter) maxCounter = op.counter;
    }
    this.clock = { counter: maxCounter, replica: replicaId };
  }

  /** Stable identity of this replica — the sync watermark key peers use. */
  get replicaId(): string {
    return this.clock.replica;
  }

  /** Fold one op into the in-memory watermark (monotonic per replica). */
  private noteOp(replica: string, counter: number): void {
    const prev = this.watermark.get(replica) ?? 0;
    if (counter > prev) this.watermark.set(replica, counter);
  }

  /** palace_meta key holding OUR belief of what `peerId` already holds. */
  private static watermarkKey(peerId: string): string {
    return `crdt:wm:${peerId}`;
  }

  /**
   * Load the persisted per-replica watermark for a peer. Any defect —
   * missing key, non-JSON text, wrong shape, non-integer counter — maps
   * to `{}`, which listCrdtOpsSince reads as "sync everything": a
   * watermark we failed to persist (or persisted corruptly) must never
   * cause ops to be skipped. Crash recovery therefore degrades to a full
   * exchange, which dedup makes merely redundant, never wrong.
   */
  private loadPeerWatermark(peerId: string): Record<string, number> {
    const raw = this.store.getMeta(CrdtFederation.watermarkKey(peerId));
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

  /** Persist the peer's watermark (called only after a converged sync). */
  private persistPeerWatermark(peerId: string, wm: Record<string, number>): void {
    this.store.setMeta(CrdtFederation.watermarkKey(peerId), JSON.stringify(wm));
  }

  /** Plain-object copy of what this replica currently holds. */
  private watermarkSnapshot(): Record<string, number> {
    return Object.fromEntries(this.watermark);
  }

  /** Record a local write as a CRDT op (called by the ingest bridge). */
  recordSet(key: string, value: string): void {
    this.clock = lamportTick(this.clock);
    this.store.appendCrdtOp({
      replica: this.clock.replica,
      counter: this.clock.counter,
      kind: 'item-set',
      key,
      value,
    });
    this.noteOp(this.clock.replica, this.clock.counter);
  }

  recordDelete(key: string): void {
    this.clock = lamportTick(this.clock);
    this.store.appendCrdtOp({
      replica: this.clock.replica,
      counter: this.clock.counter,
      kind: 'item-del',
      key,
    });
    this.noteOp(this.clock.replica, this.clock.counter);
  }

  recordTagAdd(key: string, value: string): void {
    this.clock = lamportTick(this.clock);
    this.store.appendCrdtOp({
      replica: this.clock.replica,
      counter: this.clock.counter,
      kind: 'tag-add',
      key,
      value,
    });
    this.noteOp(this.clock.replica, this.clock.counter);
  }

  recordEntityAdd(key: string, value: string): void {
    this.clock = lamportTick(this.clock);
    this.store.appendCrdtOp({
      replica: this.clock.replica,
      counter: this.clock.counter,
      kind: 'entity-add',
      key,
      value,
    });
    this.noteOp(this.clock.replica, this.clock.counter);
  }

  /** Symmetric counterpart of recordEntityAdd: writes an entity-del
   *  tombstone op (value always the empty string — see the CrdtOp type). */
  recordEntityDelete(name: string): void {
    this.clock = lamportTick(this.clock);
    this.store.appendCrdtOp({
      replica: this.clock.replica,
      counter: this.clock.counter,
      kind: 'entity-del',
      key: name,
      value: '',
    });
    this.noteOp(this.clock.replica, this.clock.counter);
  }

  /** All ops this replica knows (for exchange). */
  exportOps(): CrdtOp[] {
    return rowsToOps(this.store.listCrdtOps(0));
  }

  /** CrdtPeer surface: the delta a caller lacks above per-replica
   *  watermarks (thin wrapper over the internal delta export; `{}` — no
   *  watermark — deliberately means the FULL log). */
  opsSince(watermarks: Record<string, number>): CrdtOp[] {
    return this.exportOpsSince(watermarks);
  }

  /** CrdtPeer surface: per-replica max counters this replica currently
   *  holds — the live watermark view a peer persists for us after a
   *  converged exchange (thin wrapper over the internal snapshot). */
  watermarks(): Record<string, number> {
    return this.watermarkSnapshot();
  }

  /** Ops above the per-replica watermarks — the delta a peer lacks.
   *  `{}` (no watermark) deliberately means the FULL log. */
  private exportOpsSince(watermarks: Record<string, number>): CrdtOp[] {
    return rowsToOps(this.store.listCrdtOpsSince(watermarks));
  }

  /** Ingest a peer's ops into the local log (idempotent by op_id). */
  importOps(ops: readonly CrdtOp[]): number {
    let received = 0;
    for (const op of [...ops].sort(opCompare)) {
      this.store.appendCrdtOp({
        replica: op.ts.replica,
        counter: op.ts.counter,
        kind: op.kind,
        key: op.key,
        // exactOptionalPropertyTypes: the value-less kinds OMIT the key
        // instead of binding an explicit undefined — appendCrdtOp maps both
        // spellings to the same SQL NULL.
        ...(op.kind === 'item-set' || op.kind === 'tag-add' || op.kind === 'entity-add' || op.kind === 'entity-del'
          ? { value: String(op.value) }
          : {}),
      });
      this.noteOp(op.ts.replica, op.ts.counter);
      received++;
    }
    return received;
  }

  /** Convergence digest of this replica's CRDT state. */
  fingerprint(): string {
    const doc = applyOps(emptyDoc(), this.exportOps());
    return docFingerprint(doc);
  }

  /**
   * Anti-entropy with a peer: exchange the op DELTAS both ways (governed
   * by per-peer persisted watermarks), then verify convergence by
   * fingerprint. Idempotent and order-independent.
   *
   * The parameter is the minimal CrdtPeer surface — widened from the
   * concrete class so a peer can also be a transport adapter. When the
   * peer IS a CrdtFederation (the historical local-sync case) every step
   * below is expression-for-expression the pre-interface path, including
   * the PEER-side watermark load/persist and Lamport clock advance, so
   * local two-instance sync is observably unchanged. Any other CrdtPeer
   * runs the same exchange purely through the interface: the delta
   * cutoffs become each side's CURRENT holdings (watermarks()) instead of
   * a persisted belief (adapters keep no cross-peer state to load), and
   * only THIS side persists a watermark — dedup makes the potentially
   * fatter delta merely redundant, never wrong.
   */
  sync(peer: CrdtPeer): SyncReport {
    // FEDERATION FAST PATH: direct field access when the peer is another
    // federation instance; interface-only equivalents otherwise.
    const fedPeer = peer instanceof CrdtFederation ? peer : undefined;

    // INCREMENTAL EXCHANGE: each side reads the watermark it persisted for
    // the peer ("what I believe the peer already holds") and ships only the
    // ops above it. Watermarks are persisted AFTER a converged exchange, so
    // a crash at worst leaves them stale-low — the next sync re-sends a
    // superset and op_id dedup absorbs the overlap.
    const mineDelta = this.exportOpsSince(this.loadPeerWatermark(peer.replicaId));
    const theirDelta = fedPeer
      ? fedPeer.exportOpsSince(fedPeer.loadPeerWatermark(this.replicaId))
      : peer.opsSince(this.watermarkSnapshot());
    let opsSent = peer.importOps(mineDelta);
    let opsReceived = this.importOps(theirDelta);

    // Advance clocks past the highest exchanged counter (Lamport receive).
    // Reducer, NOT Math.max(...spread): the spread form materializes every
    // op as an argument — at ~125k ops the call stack overflows and sync()
    // crashes permanently (every retry hits the same wall). A reduce is
    // O(n) time, O(1) stack. Deltas suffice: every op either already sits
    // in the local log (covered by constructor recovery / past exchanges)
    // or arrived in this exchange's delta. (A non-federation peer's clock
    // is not ours to move — the adapter's local federation advances its
    // own clock when IT performs the symmetric exchange.)
    const maxOf = (ops: readonly CrdtOp[], seed: number): number =>
      ops.reduce((m, o) => (o.ts.counter > m ? o.ts.counter : m), seed);
    let ceiling = maxOf(mineDelta, maxOf(theirDelta, 0));
    this.clock = { counter: ceiling + 1, replica: this.clock.replica };
    if (fedPeer) fedPeer.clock = { counter: ceiling + 1, replica: fedPeer.clock.replica };

    // Convergence is judged on the FULL doc digest — fingerprint() replays
    // the entire local log, so this check never depends on exchange size.
    let fingerprints: Record<string, string> = {
      [this.replicaId]: this.fingerprint(),
      [peer.replicaId]: peer.fingerprint(),
    };
    let converged = new Set(Object.values(fingerprints)).size === 1;

    // DEFENSIVE FALLBACK: divergence after a delta exchange is impossible
    // under the CRDT laws (the delta is a faithful prefix view of a
    // convergent log), but a watermark that OVERSTATES the peer's holdings
    // (e.g. ops lost to a power-fail rollback after the watermark was
    // persisted) would skip those ops on every future sync. One full
    // re-exchange both ways heals any hole — op_id dedup keeps it cheap —
    // and the digest is re-verified afterwards. (`opsSince({})` is the
    // interface spelling of the federation's `exportOps()`.)
    if (!converged) {
      const mineFull = this.exportOps();
      const theirFull = fedPeer ? fedPeer.exportOps() : peer.opsSince({});
      opsSent += peer.importOps(mineFull);
      opsReceived += this.importOps(theirFull);
      ceiling = maxOf(mineFull, maxOf(theirFull, ceiling));
      this.clock = { counter: ceiling + 1, replica: this.clock.replica };
      if (fedPeer) fedPeer.clock = { counter: ceiling + 1, replica: fedPeer.clock.replica };
      fingerprints = {
        [this.replicaId]: this.fingerprint(),
        [peer.replicaId]: peer.fingerprint(),
      };
      converged = new Set(Object.values(fingerprints)).size === 1;
    }

    // Persist the NEW watermarks only once converged: at that moment both
    // logs hold the same op set, so each side's snapshot truthfully
    // describes the peer's holdings. Persisting on a diverged exchange
    // could pin the very hole that caused it.
    if (converged) {
      this.persistPeerWatermark(peer.replicaId, peer.watermarks());
      if (fedPeer) fedPeer.persistPeerWatermark(this.replicaId, this.watermarkSnapshot());
    }

    this.bus.emit('memory.crdt-synced', {
      peer: peer.replicaId,
      opsSent,
      opsReceived,
      converged,
    });
    return { replica: this.replicaId, opsSent, opsReceived, fingerprints, converged };
  }
}
