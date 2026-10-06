/**
 * SpaceMigrator — heals embedding-space fragmentation.
 *
 * THE SILENT FAILURE this service eliminates: vectors never cross spaces
 * (correct), so a provider switch — DeepSeek → offline failover ≥ a
 * breaker cooldown, or a model upgrade — leaves every item embedded in the
 * OLD space permanently invisible to retrieval. The palace quietly loses
 * its past while looking healthy.
 *
 * Migration is a PHYSICAL re-index, not a knowledge operation:
 *   - only the vector and its space tag move; content, timestamps,
 *     tombstone/supersession state and the visibility-tier owner columns
 *     are untouched — flashback integrity is preserved exactly;
 *   - `metadata.migratedFrom` records the audit trail;
 *   - selection and writes are store-wide (every user's rows migrate),
 *     mirroring compression's global maintenance semantics.
 *
 * Two-phase per tick (the palace-wide ingest invariant): Phase 1 embeds
 * the batch over the network with NO transaction held; Phase 2 rebinds
 * all vectors in ONE ingestTx. Budget-bounded (itemsPerTick) and
 * breaker-aware: if the gateway is degraded — or an embed came back from
 * the fallback while the primary is the target — the tick aborts with
 * zero writes rather than "migrating" into the wrong space.
 */

import type { EmbeddingGateway } from '../utils/embedding.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryEventBus, MemoryItem } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';

export interface MigrationTickResult {
  /** Space vectors are being unified into (the gateway's primary). */
  targetSpace: string;
  /** Items rebound this tick. */
  migrated: number;
  /** Items still stranded in non-target spaces (post-tick). */
  remaining: number;
  /** True when the tick aborted because the embedder is degraded. */
  degraded: boolean;
  /** Per-space counts BEFORE the tick (audit). */
  spacesBefore: Record<string, number>;
  /** Per-space counts AFTER the tick (audit). */
  spacesAfter: Record<string, number>;
}

export interface SpaceMigratorOptions {
  /** Max items re-embedded per tick. Default 100. */
  itemsPerTick?: number;
}

export class SpaceMigrator {
  private readonly itemsPerTick: number;

  constructor(
    private store: MemoryStore,
    private gateway: EmbeddingGateway,
    opts: SpaceMigratorOptions = {},
    private bus: MemoryEventBus = NOOP_BUS,
  ) {
    this.itemsPerTick = Math.max(1, Math.min(512, opts.itemsPerTick ?? 100));
  }

  /** The space all vectors are being unified into. */
  targetSpace(): string {
    return this.gateway.spaces()[0] ?? 'unknown';
  }

  private isDegraded(): boolean {
    return (
      'degraded' in this.gateway &&
      (this.gateway as { degraded?: boolean }).degraded === true
    );
  }

  /**
   * One bounded migration tick. Returns the audit record; never throws on
   * degraded embedders (that is a legitimate, reported state).
   */
  async tick(budgetOverride?: number): Promise<MigrationTickResult> {
    const budget = Math.max(
      1,
      Math.min(512, budgetOverride ?? this.itemsPerTick),
    );
    const target = this.targetSpace();
    const spacesBefore = this.currentSpaceCounts();

    const stranded = Object.keys(spacesBefore).filter(
      (s) => s !== target,
    );
    const totalStranded = stranded.reduce((s, k) => s + (spacesBefore[k] ?? 0), 0);
    if (totalStranded === 0) {
      return {
        targetSpace: target,
        migrated: 0,
        remaining: 0,
        degraded: this.isDegraded(),
        spacesBefore,
        spacesAfter: spacesBefore,
      };
    }
    if (this.isDegraded()) {
      // Refuse to migrate on a degraded circuit: embedTagged would silently
      // serve fallback vectors and we would "migrate" into the wrong space.
      return {
        targetSpace: target,
        migrated: 0,
        remaining: totalStranded,
        degraded: true,
        spacesBefore,
        spacesAfter: spacesBefore,
      };
    }

    const batch = this.store.listItemsInOtherSpaces(target, budget);

    // Phase 1 — embed the batch OUTSIDE any transaction (network).
    const reembedded: Array<{ item: MemoryItem; vector: Float32Array; space: string }> = [];
    let midTickFailover = false;
    for (const item of batch) {
      const tagged = await this.gateway.embedTagged(item.content);
      if (tagged.space !== target) {
        // Mid-tick failover: the primary tripped while we were embedding.
        // Commit what already carries target-space vectors (if anything),
        // then stop — never write vectors into the fallback space.
        midTickFailover = true;
        break;
      }
      reembedded.push({ item, vector: tagged.vector, space: tagged.space });
    }

    // Phase 2 — rebind in ONE transaction; timestamps/visibility untouched.
    let migrated = 0;
    if (reembedded.length > 0) {
      migrated = this.store.ingestTx(() => {
        let n = 0;
        for (const r of reembedded) {
          const from = r.item.metadata.embeddingSpace ?? 'unknown';
          const ok = this.store.migrateItemToSpace(
            r.item.id,
            r.vector,
            r.space,
            {
              ...r.item.metadata,
              embeddingSpace: r.space,
              migratedFrom: from,
              migratedAt: Date.now(),
            },
          );
          if (ok) n++;
        }
        return n;
      });
    }

    const spacesAfter = this.currentSpaceCounts();
    const remaining = Object.keys(spacesAfter)
      .filter((s) => s !== target)
      .reduce((s, k) => s + (spacesAfter[k] ?? 0), 0);
    // A mid-tick space switch means the embedder state CHANGED under us:
    // report degraded so sleep can distinguish "deferred, embedder
    // unhealthy — retry soon" from "budget exhausted, back off".
    const degraded = midTickFailover || this.isDegraded();

    this.bus.emit('memory.space-migrated', {
      targetSpace: target,
      migrated,
      remaining,
      degraded,
    });

    return { targetSpace: target, migrated, remaining, degraded, spacesBefore, spacesAfter };
  }

  private currentSpaceCounts(): Record<string, number> {
    return this.store.stats().spaces;
  }
}
