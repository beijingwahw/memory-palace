/**
 * IntentPredictor — the palace knows where the conversation is going.
 *
 * Learns per-user query sequences (query_log → Markov kernel) and, at
 * session start, SPECULATIVELY WARMS the two hot paths a follow-up query
 * will need:
 *
 *   - the personalized-PageRank cache (seeds = the predicted query's
 *     linked entities — pure local graph compute), and
 *   - the semantic query cache (retriever.prefetch: full pipeline, zero
 *     side effects — nothing reinforced, nothing logged, no events).
 *
 * Bounded: top-k predictions (default 3), best-effort (prediction failure
 * never breaks session start), zero API cost for PPR warmth. Emits
 * memory.prefetched for observability.
 *
 * Trajectories are read scope-aware (userId first, workspaceId fallback)
 * so workspace-scoped palaces predict too — see the 0.20.0 changelog.
 */

import {
  predictNext,
  trainIntentMarkov,
  type Prediction,
} from '../utils/intent-trajectory.js';
import { scopeLevels, widestLevel } from '../utils/scope.js';
import type { MemoryEventBus, MemoryScope, MemoryScopeKind } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryGraph } from './memory-graph.js';
import { extract } from './memory-graph.js';
import type { MemoryRetriever } from './memory-retriever.js';

export interface PrefetchReport {
  intent: string;
  predictions: Array<{ query: string; score: number; via: Prediction['via'] }>;
  /** Predictions actually warmed (cache + PPR). */
  warmed: number;
  /** Sessions the model was trained on. */
  trainedOn: number;
}

export class IntentPredictor {
  constructor(
    private store: MemoryStore,
    private retriever: MemoryRetriever,
    private graph: MemoryGraph,
    private scopeKind: MemoryScopeKind = 'user',
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  /** Predict follow-ups for an intent from this caller's trajectory history. */
  predict(intent: string, scope: MemoryScope, k = 3): Prediction[] {
    if (!intent.trim()) return [];
    // Scope-aware trajectory read: userId first, workspaceId fallback.
    // Before 0.20 this fed scope.userId into a user-only lookup, so a
    // workspace-scoped palace (sessions carry no userId) silently got an
    // EMPTY trajectory set — no predictions, no error, no way to notice.
    const trajectories = this.store.listRecentTrajectoriesFor(
      {
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
      },
      50,
    );
    if (trajectories.length === 0) return [];
    const model = trainIntentMarkov(trajectories);
    return predictNext(model, intent, k);
  }

  /** Warm-shape options passed through to retriever.prefetch: the warm
   *  entries must be stored under the SAME explain/fusionOverrides the
   *  production retrieval tool will ask with, or the query-cache keys
   *  never intersect. */
  async prefetch(
    intent: string,
    scope: MemoryScope,
    warm?: { explain?: boolean; fusionOverrides?: Record<string, number> },
    k = 3,
  ): Promise<PrefetchReport> {
    // Read the trajectory history ONCE and share it: the Markov training
    // below and the trainedOn metric consume the SAME data — no second
    // query, no second training pass.
    // Scope-aware read (userId → workspaceId fallback): a workspace palace
    // carries no userId, and the pre-0.20 user-only lookup starved the
    // predictor there — an empty model meant no warm-up AND no error.
    const trajectories = this.store.listRecentTrajectoriesFor(
      {
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
      },
      50,
    );
    const trainedOn = trajectories.filter((s) => s.length >= 2).length;
    const predictions =
      intent.trim() && trajectories.length > 0
        ? predictNext(trainIntentMarkov(trajectories), intent, k)
        : [];
    const report: PrefetchReport = {
      intent,
      predictions: predictions.map((p) => ({ query: p.query, score: p.score, via: p.via })),
      warmed: 0,
      trainedOn,
    };
    if (predictions.length === 0) return report;

    const levels = scopeLevels(this.scopeKind, scope);
    const level = widestLevel(levels);
    for (const p of predictions) {
      try {
        // 1) PPR warmth: seeds = predicted query's linked entities.
        const seeds: string[] = [];
        for (const { name } of extract(p.query)) {
          const ent = this.store.findEntityInScope(name, levels);
          if (ent) seeds.push(ent.id);
        }
        if (seeds.length > 0) this.graph.getPersonalizedRanks(seeds, level);
        // 2) Semantic-cache warmth: full pipeline, zero side effects.
        //    `warm` mirrors the production tool shape (explain defaults
        //    to true inside retriever.prefetch; fusion overrides pass
        //    through) so the stored entry lands in the cache partition
        //    the real follow-up query will read.
        await this.retriever.prefetch(p.query, scope, warm);
        report.warmed++;
      } catch {
        // Speculative warmth is best-effort by contract.
      }
    }
    this.bus.emit('memory.prefetched', {
      intent,
      predictions: report.predictions,
      warmed: report.warmed,
    });
    return report;
  }
}
