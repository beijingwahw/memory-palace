/**
 * SleepCycle — one unified consolidation pass over the palace.
 *
 * Sleep is where a memory system becomes a SELF-maintaining one: in one
 * transactional-ish pass the palace evicts and distills archival memory
 * (compressor, incl. pattern mining + retention), then re-compacts the
 * core blocks against the freshly updated entity salience. The dream
 * report records what changed so hosts (and curious agents) can audit the
 * night's work: `memory.slept` carries it onto the bus.
 *
 * Triggers: session.end, the mid-session maintenance tick, or on demand.
 * Every phase is individually failure-isolated — sleep must never crash
 * the session it serves.
 */

import type { MemoryEventBus, MemoryScopeKind } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryCompressor, CompressionReportWithRetention } from './memory-compressor.js';
import type { CoreMemoryService } from './core-memory.js';
import type { Inferencer } from './inferencer.js';
import type { SpaceMigrator } from './space-migrator.js';
import type { Stratifier } from './stratifier.js';

export interface SleepPhaseResult<T> {
  phase: 'compress' | 'migrate' | 'index' | 'core' | 'infer' | 'stratify';
  ok: boolean;
  detail?: T;
  error?: string;
}

export interface DreamReport {
  sleptAt: number;
  scope: { userId?: string; workspaceId?: string; sessionId?: string };
  phases: Array<SleepPhaseResult<unknown>>;
  /** Human-readable night notes (deterministic). */
  notes: string[];
}

export class SleepCycle {
  constructor(
    private store: MemoryStore,
    private compressor: MemoryCompressor,
    private core: CoreMemoryService,
    private inferencer: Inferencer | null = null,
    private migrator: SpaceMigrator | null = null,
    private stratifier: Stratifier | null = null,
    // Positional placeholder: the resolved scope kind rides here for API
    // symmetry with the other services; this pass itself is store-wide
    // maintenance and never branches on it. Callers always pass it
    // positionally, and its value is never read either way.
    _scopeKind?: MemoryScopeKind,
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  /**
   * Run one full sleep cycle for a caller's scope. Compression only runs
   * when its trigger condition holds; core compaction always runs (it is
   * cheap and is what keeps the self current).
   */
  async sleep(
    scope: { userId?: string; workspaceId?: string; sessionId?: string },
    opts: { forceCompression?: boolean } = {},
  ): Promise<DreamReport> {
    const report: DreamReport = { sleptAt: Date.now(), scope, phases: [], notes: [] };

    // Phase 1 — compress (evict + distill + mine patterns + retention).
    // NOTE: this phase is deliberately GLOBAL (all tenants), like migrate
    // below — it is maintenance, not a scoped read. Tenant safety holds by
    // construction: distillation groups rows per owner partition and never
    // merges across them, and retention judges each row independently by
    // its OWN TTL/tombstone state, so no user's rows can influence
    // another's eviction or distillation decisions.
    try {
      if (opts.forceCompression || this.compressor.shouldRun()) {
        const cr: CompressionReportWithRetention = await this.compressor.runOnce();
        report.phases.push({ phase: 'compress', ok: true, detail: cr });
        report.notes.push(
          `compression: evicted=${cr.evictedItems} distilled=${cr.newSemanticItems}` +
            (cr.patternsMined !== undefined ? ` patterns=${cr.patternsMined}` : ''),
        );
      } else {
        report.phases.push({ phase: 'compress', ok: true, detail: 'skipped (below trigger)' });
      }
    } catch (e) {
      report.phases.push({ phase: 'compress', ok: false, error: String(e) });
    }

    // Phase 2 — space migration: heal provider-switch fragmentation so
    // the palace's past is retrievable in the CURRENT embedding space.
    // Runs before core/infer; bounded budget per night; degrades safely.
    // Like compression above, this is GLOBAL (store-wide) maintenance BY
    // DESIGN: the migrator only rebinds vectors to the target space and
    // never touches content/ownership, so cross-tenant selection here is
    // a physical re-index, not a knowledge operation.
    try {
      if (this.migrator) {
        const mg = await this.migrator.tick();
        report.phases.push({ phase: 'migrate', ok: true, detail: mg });
        if (mg.migrated > 0) {
          report.notes.push(
            `migrated: ${mg.migrated} vectors → ${mg.targetSpace} (${mg.remaining} still stranded)`,
          );
        } else if (mg.remaining > 0) {
          report.notes.push(
            mg.degraded
              ? `migrate: ${mg.remaining} stranded, deferred (embedder degraded)`
              : `migrate: ${mg.remaining} stranded beyond tonight's budget`,
          );
        }
      }
    } catch (e) {
      report.phases.push({ phase: 'migrate', ok: false, error: String(e) });
    }

    // Phase 2b — index hygiene: evict/purge leave harmless orphan bucket
    // rows (scans join back to memory_items); nightly pruning keeps the
    // IVF index lean. The phase result is ALWAYS recorded — pruned=0 is a
    // legitimate outcome ("ran, nothing to prune") and must stay
    // distinguishable from "phase never ran" in dream reports.
    try {
      const pruned = this.store.pruneOrphanBuckets();
      report.phases.push({ phase: 'index', ok: true, detail: { pruned } });
      if (pruned > 0) {
        report.notes.push(`index: pruned ${pruned} orphan bucket rows`);
      }
    } catch (e) {
      report.phases.push({ phase: 'index', ok: false, error: String(e) });
    }

    // Phase 3 — core compaction against current entity salience.
    try {
      const blocks = this.core.compactAll(scope);
      let changed = 0;
      for (const b of blocks) {
        if (b.changed) {
          changed++;
          for (const preview of b.compaction.removedPreviews.slice(0, 2)) {
            report.notes.push(`core/${b.name}: evicted "${preview}"`);
          }
        }
      }
      report.phases.push({ phase: 'core', ok: true, detail: { blocks: blocks.length, changed } });
      report.notes.push(`core: ${changed}/${blocks.length} blocks recompacted`);
    } catch (e) {
      report.phases.push({ phase: 'core', ok: false, error: String(e) });
    }

    // Phase 4 — inference: compose novel chains, materialize derived
    // knowledge. Runs last so it sees the post-compression graph.
    try {
      if (this.inferencer) {
        const inf = await this.inferencer.infer(scope);
        report.phases.push({ phase: 'infer', ok: true, detail: inf });
        if (inf.chains > 0) {
          report.notes.push(
            `inferred: ${inf.chains} chains → ${inf.edgesWritten} edges, ${inf.itemsWritten} derived facts`,
          );
          if (inf.strongest) report.notes.push(`strongest: ${inf.strongest}`);
        }
      }
    } catch (e) {
      report.phases.push({ phase: 'infer', ok: false, error: String(e) });
    }

    // Phase 5 — stratification: fold the stream into week/month/era
    // digest nodes so long-horizon questions hit one node, not a scan.
    try {
      if (this.stratifier) {
        const st = await this.stratifier.stratify(scope);
        report.phases.push({ phase: 'stratify', ok: true, detail: st });
        if (st.nodesBuilt > 0) {
          report.notes.push(
            `stratified: ${st.nodesBuilt} nodes (${Object.entries(st.byLevel).map(([l, n]) => `${l}=${n}`).join(', ')})`,
          );
        }
      }
    } catch (e) {
      report.phases.push({ phase: 'stratify', ok: false, error: String(e) });
    }

    this.bus.emit('memory.slept', report);
    return report;
  }
}
