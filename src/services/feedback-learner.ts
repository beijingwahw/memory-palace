/**
 * FeedbackLearner — closes the retrieval loop with bounded online learning.
 *
 * The palace already emits the raw material: every retrieve returns ranked
 * items, and every later tool interaction with those items (re-retrieve,
 * memory_why, memory_forget, capsule export) is an implicit "the ranking
 * served". This service converts those signals into FusionBandit updates,
 * persists them per-scope (v9), and exposes the learned weights to the
 * retriever — always clamped inside the safety rails, always journaled.
 *
 * Anti-feedback-loop by construction:
 *   - reward comes only from EXPLICIT tool engagement with previously
 *     returned item ids (not from mere re-retrieval of the same query,
 *     which the semantic cache would short-circuit anyway); derived
 *     signals may instead hand over an explicit reward, which learn()
 *     clamps into [0,1] before anything moves;
 *   - reward history decays per event (a March streak cannot dominate);
 *   - weights can move at most lr per event and never past the rails;
 *   - reset is one call, and the journal is the audit trail.
 */

import {
  ARMS,
  FusionBandit,
  type Arm,
  type RewardJournalEntry,
} from '../utils/bandit.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryEventBus } from '../types/index.js';
import { NOOP_BUS } from '../types/index.js';

export interface FeedbackSignal {
  /** Item ids the ranking served that the agent then engaged with. */
  engagedItemIds: string[];
  /** Total hits the original retrieval returned (the denominator). */
  totalHits: number;
  query: string;
  scope: { userId?: string; workspaceId?: string };
  /**
   * Explicit reward for a DERIVED signal (e.g. a self-consistency rank or
   * diversity composite computed by the caller). Takes precedence over the
   * engaged/totalHits ratio when present. The caller owns the semantic
   * meaning; this method owns the legal domain: a finite value is clamped
   * into [0,1], a non-finite value (NaN/±Infinity) is rejected outright
   * (no state written). Omit it to fall back to the ratio path.
   */
  reward?: number;
}

export interface LearnReport {
  reward: number;
  moved: Array<{ arm: Arm; from: number; to: number }>;
}

export class FeedbackLearner {
  private bandits = new Map<string, FusionBandit>();

  constructor(
    private store: MemoryStore,
    private bus: MemoryEventBus = NOOP_BUS,
  ) {}

  private banditFor(scope: { userId?: string; workspaceId?: string }): FusionBandit {
    // Namespace the cache key by kind (priority user > workspace > global):
    // a bare id would let a userId and a workspaceId with the SAME string
    // value ("acme") collide into one shared bandit.
    const kind = scope.userId ? 'user' : scope.workspaceId ? 'workspace' : 'global';
    const id = scope.userId ?? scope.workspaceId ?? '_';
    const key = `${kind}:${id}`;
    let b = this.bandits.get(key);
    if (b) return b;
    b = new FusionBandit();
    // Rehydrate persisted arm values. The DB row's arm name is untrusted
    // wire data: a value outside the current Arm set has no state entry,
    // so the row is matched against the declared arm list and unknown
    // arms are skipped.
    for (const row of this.store.loadBandit(scope)) {
      const arm = ARMS.find((a) => a === row.arm);
      if (arm === undefined) continue;
      const s = b.state[arm];
      s.value = row.value;
      s.reward = row.reward;
      s.attempts = row.attempts;
      s.updates = row.updates;
    }
    this.bandits.set(key, b);
    return b;
  }

  /** Current learned weights (with optional exploration). */
  weights(
    scope: { userId?: string; workspaceId?: string },
    explore: boolean,
  ): Record<Arm, number> {
    return this.banditFor(scope).weights(explore);
  }

  /**
   * Ingest one feedback signal. Default reward = engaged/returned (bounded
   * 0..1; > 0.5 nudges arms up, below nudges down). A finite `signal.reward`
   * (derived signal) overrides the ratio after clamping into [0,1]; a
   * non-finite one is rejected with zero state writes. Persists state + the
   * raw event, emits the journal.
   */
  learn(signal: FeedbackSignal): LearnReport {
    // Zero-hit guard: a ranking that returned nothing has no denominator —
    // engaged/0 would be Infinity (or 0/0 = NaN) and poison the bandit's
    // decay accumulators. Nothing was served, so nothing is learned and no
    // reward event is journaled.
    if (signal.totalHits <= 0) {
      return { reward: 0, moved: [] };
    }
    // Non-finite explicit reward guard: same poison, different source. A NaN
    // derived signal would live in the decay accumulators forever, so it is
    // rejected before any state is touched — same zero-write contract as the
    // zero-hit guard above.
    if (signal.reward !== undefined && !Number.isFinite(signal.reward)) {
      return { reward: 0, moved: [] };
    }
    const b = this.banditFor(signal.scope);
    // Clamp the numerator: more engaged ids than served hits is physically
    // impossible (or a misreporting caller) — cap the evidence at the
    // denominator. The engaged count remains the evidence bookkeeping even
    // when an explicit reward overrides the ratio.
    const engaged = Math.min(signal.engagedItemIds.length, signal.totalHits);
    const reward =
      signal.reward === undefined
        ? Math.max(0, Math.min(1, engaged / signal.totalHits))
        : Math.max(0, Math.min(1, signal.reward));
    const entries: RewardJournalEntry[] = b.update(reward, engaged);
    // Persist every arm (cheap; five rows).
    for (const arm of ARMS) {
      const s = b.state[arm];
      this.store.saveBanditArm(signal.scope, arm, s.value, s.reward, s.attempts, s.updates);
    }
    this.store.logBanditReward(signal.scope, signal.query, reward, engaged);
    const report: LearnReport = {
      reward,
      moved: entries.map((e) => ({ arm: e.arm, from: e.from, to: e.to })),
    };
    this.bus.emit('memory.bandit-learned', report);
    return report;
  }

  /** Audit snapshot for tools / inspect. */
  snapshot(scope: { userId?: string; workspaceId?: string }) {
    const b = this.banditFor(scope);
    return {
      arms: b.snapshot(),
      recentRewards: this.store.recentBanditRewards(scope, 10),
      // The bandit's ACTUAL (decayed) exploration ε — previously this
      // misreported vectorWeight, an entirely different quantity.
      epsilon: Number(b.explorationRate.toFixed(4)),
    };
  }

  reset(scope: { userId?: string; workspaceId?: string }, arm?: Arm): void {
    const b = this.banditFor(scope);
    b.reset(arm);
    for (const a of ARMS) {
      const s = b.state[a];
      this.store.saveBanditArm(scope, a, s.value, s.reward, s.attempts, s.updates);
    }
    this.bus.emit('memory.bandit-reset', { arm: arm ?? 'all' });
  }
}
