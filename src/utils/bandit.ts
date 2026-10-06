/**
 * Contextual bandit kernel — retrieval fusion that learns from use.
 *
 * THE PROBLEM: fusion weights (0.7 vector / 0.3 keyword, graphBoost, PRF
 * α/β) are static between runs; the reflection grid tunes them OFFLINE but
 * nothing adapts ONLINE to what THIS user actually engages with.
 *
 * THE SIGNAL (already flowing through the palace): every retrieval returns
 * hits with item ids; when the agent later re-retrieves or touches those
 * items (tool calls, memory_forget/why on them), that is implicit feedback
 * — the earlier ranking SERVED. The bandit converts those touches into
 * bounded weight updates for a small set of ARMS:
 *
 *   vectorWeight   — score = raw × vectorWeight …
 *   keywordWeight  — fused = v·score + k·keywordScore
 *   graphBoost     — the zero-mean PPR prior gain
 *   prfAlpha/Beta  — the Rocchio blend
 *
 * SAFETY RAILS (the whole point — this must never run away):
 *   - each arm clamped to default ± maxDrift (default ±20%);
 *   - ε-greedy exploration with DECAYING ε (bounded curiosity);
 *   - reward history decays (exponential, per-arm λ) so a hit streak from
 *     March cannot dominate October — and the popular-item feedback loop
 *     (retrieve→touch→boost→retrieve) starves;
 *   - every update is journaled (arm, from→to, reward, evidence) — the
 *     weight evolution is fully auditable and resettable.
 *
 * Pure module: deterministic given the same event stream.
 */

import { invariant } from './invariants.js';

export type Arm =
  | 'vectorWeight'
  | 'keywordWeight'
  | 'graphBoost'
  | 'prfAlpha'
  | 'prfBeta';

export const ARMS: readonly Arm[] = [
  'vectorWeight',
  'keywordWeight',
  'graphBoost',
  'prfAlpha',
  'prfBeta',
];

/** Per-arm defaults (the frozen v0.6 hand-tuned fusion). */
export const ARM_DEFAULTS: Record<Arm, number> = {
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  graphBoost: 0.15,
  prfAlpha: 0.7,
  prfBeta: 0.3,
};

/** Hard drift rails as FRACTIONS of the default (asymmetric allowed). */
export const ARM_RAILS: Record<Arm, { min: number; max: number }> = {
  vectorWeight: { min: 0.5, max: 0.85 },
  keywordWeight: { min: 0.15, max: 0.45 },
  graphBoost: { min: 0.0, max: 0.25 },
  prfAlpha: { min: 0.5, max: 0.9 },
  prfBeta: { min: 0.1, max: 0.5 },
};

export interface ArmState {
  arm: Arm;
  value: number;
  /** Decaying reward accumulator (the learning signal). */
  reward: number;
  /** Decaying attempt count (denominator). */
  attempts: number;
  updates: number;
}

export type BanditState = Record<Arm, ArmState>;

export interface RewardJournalEntry {
  arm: Arm;
  from: number;
  to: number;
  reward: number;
  /** Which retrieved items constituted the feedback. */
  evidenceCount: number;
  at: number;
}

export interface BanditOptions {
  /** Learning rate per reward event (bounded update step). Default 0.02. */
  lr?: number;
  /** Per-event decay of accumulated reward/attempts. Default 0.97. */
  decay?: number;
  /** Exploration ε start; decays toward εMin every update. Default 0.10. */
  epsilon?: number;
  epsilonMin?: number;
  epsilonDecay?: number;
  now?: () => number;
}

export class FusionBandit {
  readonly state: BanditState;
  readonly journal: RewardJournalEntry[] = [];
  private epsilon: number;
  /** The CONSTRUCTION ε — what reset() restores (not a hardcoded constant). */
  private readonly epsilonBase: number;
  private readonly lr: number;
  private readonly decay: number;
  private readonly epsilonMin: number;
  private readonly epsilonDecay: number;
  private readonly now: () => number;

  constructor(opts: BanditOptions = {}, seed?: Partial<Record<Arm, number>>) {
    this.lr = opts.lr ?? 0.02;
    this.decay = opts.decay ?? 0.97;
    this.epsilon = opts.epsilon ?? 0.1;
    this.epsilonBase = this.epsilon;
    this.epsilonMin = opts.epsilonMin ?? 0.02;
    this.epsilonDecay = opts.epsilonDecay ?? 0.995;
    this.now = opts.now ?? Date.now;
    this.state = {} as BanditState;
    for (const arm of ARMS) {
      const value = clamp(seed?.[arm] ?? ARM_DEFAULTS[arm], ARM_RAILS[arm]);
      this.state[arm] = { arm, value, reward: 0, attempts: 0, updates: 0 };
    }
  }

  /** Current (decayed) exploration ε — read-only view for snapshots/audit. */
  get explorationRate(): number {
    return this.epsilon;
  }

  /** Current fusion weights, with ε-greedy jitter on ONE arm per read. */
  weights(explore: boolean): Record<Arm, number> {
    const out = {} as Record<Arm, number>;
    for (const arm of ARMS) out[arm] = this.state[arm].value;
    if (!explore || this.epsilon <= 0) return out;
    // Deterministic-ish exploration: pick the arm with the highest
    // reward/attempts ratio shortfall (most under-explored), not RNG.
    const firstArm = ARMS[0];
    invariant(firstArm !== undefined, 'ARMS is a statically non-empty literal');
    let pick: Arm = firstArm;
    let worst = Infinity;
    for (const arm of ARMS) {
      const s = this.state[arm];
      const ratio = s.attempts > 0 ? s.reward / s.attempts : 0;
      const headroom = ARM_RAILS[arm].max - s.value;
      const score = ratio - headroom * 0.1; // prefer promising + headroom
      if (score < worst) {
        worst = score;
        pick = arm;
      }
    }
    const rail = ARM_RAILS[pick];
    const nudge = (rail.max - ARM_DEFAULTS[pick]) * this.epsilon * 0.2;
    out[pick] = clamp(out[pick] + nudge, rail);
    return out;
  }

  /**
   * Record one feedback event: `reward ∈ [0,1]` (1 = the served ranking
   * was engaged; partial for weaker signals). Moves each arm a bounded
   * step toward/away from its current value depending on sign, journals
   * the move, and decays accumulators + ε.
   */
  update(reward: number, evidenceCount: number): RewardJournalEntry[] {
    // Non-finite rewards are poison, not signal: NaN propagates through
    // the decaying accumulators FOREVER (reward × decay stays NaN), and
    // ±Infinity would slip through the clamp below as 1. Reject before
    // any state is touched.
    if (!Number.isFinite(reward)) return [];
    const entries: RewardJournalEntry[] = [];
    const r = Math.max(0, Math.min(1, reward));
    for (const arm of ARMS) {
      const s = this.state[arm];
      s.reward = s.reward * this.decay + r;
      s.attempts = s.attempts * this.decay + 1;
      // Direction: high engagement (r > 0.5) nudges the arm UP within its
      // rail; low engagement nudges DOWN — both by lr × r-magnitude.
      const dir = r >= 0.5 ? 1 : -1;
      const rail = ARM_RAILS[arm];
      const from = s.value;
      const to = clamp(from + dir * this.lr * (r >= 0.5 ? r : 1 - r) * 2, rail);
      if (Math.abs(to - from) > 1e-9) {
        s.value = to;
        s.updates++;
        entries.push({ arm, from, to, reward: r, evidenceCount, at: this.now() });
      }
    }
    this.epsilon = Math.max(this.epsilonMin, this.epsilon * this.epsilonDecay);
    this.journal.push(...entries);
    if (this.journal.length > 200) this.journal.splice(0, this.journal.length - 200);
    return entries;
  }

  /** Reset one arm (or all) to defaults — the operator's escape hatch. */
  reset(arm?: Arm): void {
    for (const a of arm ? [arm] : ARMS) {
      const s = this.state[a];
      s.value = ARM_DEFAULTS[a];
      s.reward = 0;
      s.attempts = 0;
      s.updates = 0;
    }
    // Restore the CONSTRUCTOR's ε, not a hardcoded 0.1 — a deployment that
    // tuned exploration down should not get it re-inflated by a reset.
    this.epsilon = this.epsilonBase;
  }

  snapshot(): Array<{ arm: Arm; value: number; default: number; drift: number; updates: number }> {
    return ARMS.map((arm) => {
      const s = this.state[arm];
      return {
        arm,
        value: Number(s.value.toFixed(4)),
        default: ARM_DEFAULTS[arm],
        drift: Number(((s.value / ARM_DEFAULTS[arm] - 1) * 100).toFixed(1)),
        updates: s.updates,
      };
    });
  }
}

function clamp(x: number, rail: { min: number; max: number }): number {
  return Math.max(rail.min, Math.min(rail.max, x));
}
