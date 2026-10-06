/**
 * FederatedRetriever — one retrieve() contract, N palaces behind it.
 *
 * An agent may hold a personal palace, a team palace, and a project
 * palace; until now every query hit exactly one store. This service fans
 * the SAME query out to every registered member (any object satisfying
 * the retrieve contract — local MemoryRetrievers today, MCP-remote
 * palaces tomorrow), applies per-member circuit breakers with timeouts
 * (a slow remote must not stall the federation), merges the pools with
 * the cross-palace MMR kernel, and returns hits that each carry their
 * source palace in `explain`.
 *
 * Per-palace sovereignty is preserved end-to-end: each member evaluates
 * scope/ACL against ITS OWN store; the federation never bypasses a
 * member's visibility rules — it only merges what each member chose to
 * return.
 */

import type { RetrievalQuery, RetrievalResult } from '../types/index.js';
import type { MemoryEventBus } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import {
  aggregateDebug,
  federatedMmr,
  mergePools,
  type SourcedHit,
} from '../utils/fed-merge.js';
import { invariant } from '../utils/invariants.js';

/** The minimal contract every federation member satisfies. */
export interface PalaceMember {
  name: string;
  retrieve(q: RetrievalQuery): Promise<RetrievalResult>;
}

export interface FederatedRetrievalResult {
  hits: Array<{
    itemId: string;
    layer: string;
    content: string;
    score: number;
    sourcePalace: string;
  }>;
  totalTokens: number;
  elapsedMs: number;
  palaces: Array<{ name: string; hits: number; elapsedMs: number; circuitOpen: boolean }>;
  degradedMembers: string[];
}

export interface FederatedRetrieverOptions {
  /**
   * Per-member probe timeout in ms (default 8000). A member that exceeds
   * it counts as a failure for this round — breaker + degraded listing —
   * so one slow remote can never stall the whole federation.
   */
  timeoutMs?: number;
}

export class FederatedRetriever {
  private breakers = new Map<string, CircuitBreaker>();
  private readonly timeoutMs: number;

  constructor(
    private members: PalaceMember[],
    private bus: MemoryEventBus = NOOP_BUS,
    opts: FederatedRetrieverOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
    for (const m of members) {
      this.breakers.set(
        m.name,
        new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 }),
      );
    }
  }

  /** Duplicate names would corrupt breaker/debug bookkeeping — reject. */
  addMember(m: PalaceMember): void {
    if (this.members.some((x) => x.name === m.name)) {
      throw new Error(`federation member "${m.name}" already registered`);
    }
    this.members.push(m);
    this.breakers.set(m.name, new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 }));
  }

  /**
   * Reject a member call that exceeds timeoutMs. When the timeout wins the
   * race the in-flight call may still reject later; that late rejection is
   * marked handled here so it can never surface as an unhandled rejection
   * after the round has moved on.
   */
  private raceTimeout(call: Promise<RetrievalResult>, name: string): Promise<RetrievalResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`member "${name}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    call.catch(() => {}); // the loser's late failure is already accounted for
    return Promise.race([call, timeout]).finally(() => {
      clearTimeout(timer);
    });
  }

  /**
   * Fan-out + merge. Parallel probes; every member's failure is isolated
   * (breaker opens, that palace drops from this round, others answer).
   */
  async retrieve(q: RetrievalQuery): Promise<FederatedRetrievalResult> {
    const t0 = Date.now();
    const topK = q.topK ?? 8;
    const results = new Map<string, RetrievalResult>();
    const degraded: string[] = [];

    await Promise.all(
      this.members.map(async (m) => {
        const breaker = this.breakers.get(m.name);
        invariant(breaker !== undefined, 'constructor and addMember register a breaker for every member');
        if (!breaker.canAttempt()) {
          degraded.push(m.name);
          return;
        }
        try {
          // Per-member timeout: a slow remote is a failure for this round
          // (recordFailure + degraded), never a stall for the federation.
          const res = await this.raceTimeout(
            m.retrieve({ ...q, topK: Math.max(topK, 4) }),
            m.name,
          );
          breaker.recordSuccess();
          results.set(m.name, res);
        } catch {
          breaker.recordFailure();
          degraded.push(m.name);
        }
      }),
    );

    const pool = mergePools(results);
    const selected = federatedMmr(pool, {
      mmrLambda: q.mmrLambda ?? 0.5,
      topK,
    });

    const totalTokens = selected.reduce(
      (s, h) => s + (h.hit.item.metadata.tokenCount ?? 0),
      0,
    );
    // Debug completeness: members isolated this round (timeout / error /
    // open breaker) get zero-hit placeholder entries — a caller inspecting
    // `palaces` sees WHO was dropped, not just an abruptly shorter list.
    const { palaces } = aggregateDebug(
      results,
      degraded.map((name) => ({ palace: name, circuitOpen: true })),
    );

    const out: FederatedRetrievalResult = {
      hits: selected.map((sh: SourcedHit) => ({
        itemId: sh.hit.item.id,
        layer: sh.hit.item.layer,
        content: sh.hit.item.content.slice(0, 300),
        score: Number(sh.hit.finalScore.toFixed(3)),
        sourcePalace: sh.palace,
      })),
      totalTokens,
      elapsedMs: Date.now() - t0,
      palaces: palaces.map((p) => ({
        name: p.name,
        hits: p.hits,
        elapsedMs: p.elapsedMs,
        // Placeholders (degraded) carry their isolation flag; answered
        // members report their live breaker state.
        circuitOpen: p.circuitOpen ?? this.breakers.get(p.name)?.currentState === 'open',
      })),
      degradedMembers: degraded,
    };
    this.bus.emit('memory.federated-retrieved', {
      query: q.query,
      palaces: results.size,
      hits: out.hits.length,
      degraded,
    });
    return out;
  }

  memberNames(): string[] {
    return this.members.map((m) => m.name);
  }
}
