/**
 * CircuitBreaker — classic closed/open/half-open state machine used to
 * guard the remote embedding API.
 *
 *   closed     → failures >= threshold → open
 *   open       → after cooldownMs      → half-open (lets one probe through)
 *   half-open  → probe succeeds → closed / probe fails → open
 *
 * The clock is injectable so tests can time-travel without real waits, and
 * every state change is reported through the optional `onTransition`
 * observer so degraded/recovered serving never happens invisibly.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures before the circuit opens. */
  threshold?: number;
  /** How long the circuit stays open before allowing a probe. */
  cooldownMs?: number;
  /** Monotonic clock in ms (injectable for tests). */
  now?: () => number;
  /**
   * Notified on every state change: closed→open, open→half-open,
   * half-open→open, half-open→closed (same-state records fire nothing).
   * Fire-and-forget — a throw from the observer is swallowed so a broken
   * listener can never corrupt the breaker.
   */
  onTransition?: (from: BreakerState, to: BreakerState) => void;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onTransition?: (from: BreakerState, to: BreakerState) => void;
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';

  constructor(opts: BreakerOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? 3);
    this.cooldownMs = Math.max(1, opts.cooldownMs ?? 60_000);
    this.now = opts.now ?? Date.now;
    this.onTransition = opts.onTransition;
  }

  get currentState(): BreakerState {
    this.maybeHalfOpen();
    return this.state;
  }

  /** True when the guarded call is allowed to be attempted right now. */
  canAttempt(): boolean {
    this.maybeHalfOpen();
    return this.state !== 'open';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.transition('closed');
  }

  recordFailure(): void {
    this.failures++;
    // A failed probe from half-open re-opens immediately; from closed it
    // opens once the threshold is reached.
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.transition('open');
      this.openedAt = this.now();
    }
  }

  private maybeHalfOpen(): void {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.transition('half-open');
    }
  }

  /**
   * Swap to `next` and notify the observer. A no-op when the state is
   * unchanged (e.g. recordSuccess while already closed), so observers see
   * only genuine transitions.
   */
  private transition(next: BreakerState): void {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    if (this.onTransition) {
      try {
        this.onTransition(from, next);
      } catch {
        // Observers are fire-and-forget; their failures are not ours.
      }
    }
  }
}
