/**
 * MemoryReflector — the palace grades its own recall.
 *
 * Builds a self-consistency benchmark from stored items (each item's
 * first sentence becomes a pseudo-query whose answer must be the item
 * itself), then sweeps a deterministic parameter grid by instantiating
 * THROWAWAY MemoryRetrievers over the live store/gateway/graph — the real
 * pipeline, real scopes, no simulation shortcuts. The sweep reports MRR /
 * recall@K for the current configuration and the best alternative, so a
 * host can act on evidence instead of folklore when tuning graphBoost or
 * the PRF blend.
 */

import type { EmbeddingGateway } from '../utils/embedding.js';
import {
  buildBenchmark,
  mrr,
  objective,
  rankOf,
  recallAtK,
  reflectionGrid,
  type BenchEntry,
  type ReflectionParams,
} from '../utils/reflection.js';
import type { MemoryEventBus, MemoryItem, MemoryScope } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryGraph } from './memory-graph.js';
import { invariant } from '../utils/invariants.js';
import { MemoryRetriever, type RetrieverConfig } from './memory-retriever.js';

export interface ReflectionSweep {
  params: ReflectionParams;
  mrr: number;
  /** Recall at the sweep's K (opts.topK, default 5) — name matches the knob. */
  recallAtK: number;
  objective: number;
}

export interface ReflectionReport {
  entries: number;
  current: ReflectionSweep;
  best: ReflectionSweep;
  improved: boolean;
  recommendation: string;
}

export class MemoryReflector {
  constructor(
    private store: MemoryStore,
    private gateway: EmbeddingGateway,
    private baseCfg: RetrieverConfig,
    private graph?: MemoryGraph,
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  /**
   * Run the grid sweep. `items` should be the caller's scoped live
   * semantic sample (the caller controls visibility); scope is applied to
   * every probe query so the benchmark measures the caller's real view.
   */
  async reflect(
    items: MemoryItem[],
    scope: MemoryScope,
    opts: { topK?: number; maxEntries?: number } = {},
  ): Promise<ReflectionReport> {
    const topK = opts.topK ?? 5;
    const bench = buildBenchmark(items, { maxEntries: opts.maxEntries ?? 25 });
    const grid = reflectionGrid({
      graphBoost: this.baseCfg.graphBoost,
      prfAlpha: this.baseCfg.prf.alpha,
      prfBeta: this.baseCfg.prf.beta,
    });

    const sweeps: ReflectionSweep[] = [];
    for (const params of grid) {
      const retriever = new MemoryRetriever(
        this.store,
        this.gateway,
        {
          ...this.baseCfg,
          graphBoost: params.graphBoost,
          prf: { ...this.baseCfg.prf, alpha: params.prfAlpha, beta: params.prfBeta },
          // Caches would leak across sweeps AND get invalidated by
          // touchAccess writes; disable both for clean measurement.
          queryCache: false,
          ivf: this.baseCfg.ivf,
          entityHop: this.baseCfg.entityHop,
        },
        this.graph,
        NOOP_BUS,
      );
      const positions = await this.probe(retriever, bench, scope, topK);
      const m = mrr(positions);
      const r = recallAtK(positions, topK);
      sweeps.push({ params, mrr: m, recallAtK: r, objective: objective(m, r) });
    }

    const currentKey = keyOf({
      graphBoost: this.baseCfg.graphBoost,
      prfAlpha: this.baseCfg.prf.alpha,
      prfBeta: this.baseCfg.prf.beta,
    });
    const matched = sweeps.find((s) => keyOf(s.params) === currentKey);
    const lastSweep = sweeps[sweeps.length - 1];
    const current = matched ?? lastSweep;
    // reflectionGrid builds its axes from non-empty arrays, so the sweep
    // list always has entries and the last-slot fallback always exists.
    invariant(current !== undefined, 'reflectionGrid always yields at least one sweep');
    const best = sweeps.reduce((a, b) => (b.objective > a.objective ? b : a));
    const report: ReflectionReport = {
      entries: bench.length,
      current,
      best,
      improved: best.objective > current.objective + 1e-6,
      recommendation:
        `retrieval.graphBoost=${best.params.graphBoost}, retrieval.prf.alpha=${best.params.prfAlpha}, ` +
        `retrieval.prf.beta=${best.params.prfBeta} ` +
        `(objective ${best.objective.toFixed(3)} vs current ${current.objective.toFixed(3)})`,
    };
    this.bus.emit('memory.reflected', {
      entries: bench.length,
      sweeps: sweeps.length,
      improved: report.improved,
    });
    return report;
  }

  private async probe(
    retriever: MemoryRetriever,
    bench: BenchEntry[],
    scope: MemoryScope,
    topK: number,
  ): Promise<Array<number | null>> {
    const positions: Array<number | null> = [];
    for (const entry of bench) {
      // Speculative: benchmark probes must not reinforce items nor
      // pollute the trajectory log — measurement integrity.
      const res = await retriever.retrieve({
        query: entry.query,
        topK,
        scope,
        speculative: true,
      });
      positions.push(rankOf(res.hits.map((h) => h.item.id), entry.labelItemId));
    }
    return positions;
  }
}

function keyOf(p: ReflectionParams): string {
  // unique() (utils/reflection.ts) normalizes grid axes via
  // Number(v.toFixed(3)), so the lookup key must round the same way —
  // a baseCfg carrying >3 decimals (graphBoost 0.1234) would otherwise
  // miss its normalized grid point (0.123) and fall back to the LAST
  // (most aggressive) sweep as "current".
  return `${p.graphBoost.toFixed(3)}|${p.prfAlpha.toFixed(3)}|${p.prfBeta.toFixed(3)}`;
}
