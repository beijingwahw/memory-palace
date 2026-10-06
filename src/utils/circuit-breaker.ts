/**
 * CircuitBreaker — classic closed/open/half-open state machine used to
 * guard the remote embedding API.
 *
 *   closed     → failures >= threshold → open
 *   open       → after cooldownMs      → half-open (one probe at a time)
 *   half-open  → probe succeeds → closed / probe fails → open
 *
 * Preferred protocol: ask `beginAttempt()` for permission and report the
 * outcome with `settleAttempt(ok)`. That enforces a TRUE single probe in
 * half-open — while a probe is in flight, concurrent beginAttempt() calls
 * are refused, so exactly one request tests the recovered dependency.
 *
 * `canAttempt()`/`recordSuccess()`/`recordFailure()` remain for callers
 * that don't need single-flight gating (and for tests); they behave as
 * before, except a failure recorded while ALREADY open no longer refreshes
 * `openedAt` (a racing failure used to silently extend the cool-down).
 *
 * The clock is injectable so tests can time-travel without real waits, and
 * every state change is reported through the `onTransition` constructor
 * observer and any `addObserver` listeners so degraded/recovered serving
 * never happens invisibly.
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
   * listener can never corrupt the breaker. Additional observers can be
   * attached later with addObserver().
   */
  onTransition?: (from: BreakerState, to: BreakerState) => void;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly observers: Array<(from: BreakerState, to: BreakerState) => void> = [];
  private failures = 0;
  private openedAt = 0;
  private state: BreakerState = 'closed';
  /**
   * Attempts begun via beginAttempt() but not yet settled. In half-open,
   * beginAttempt() caps this at 1 (the single-probe latch); in closed it
   * may exceed 1 under concurrent guarded calls, each settling its own
   * outcome. It never goes negative — a settle with nothing in flight is
   * ignored (see settleAttempt).
   */
  private inFlight = 0;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? 3);
    this.cooldownMs = Math.max(1, opts.cooldownMs ?? 60_000);
    this.now = opts.now ?? Date.now;
    if (opts.onTransition) this.observers.push(opts.onTransition);
  }

  get currentState(): BreakerState {
    this.maybeHalfOpen();
    return this.state;
  }

  /**
   * Attach another transition observer after construction (same contract
   * as BreakerOptions.onTransition; throws from it are swallowed).
   */
  addObserver(fn: (from: BreakerState, to: BreakerState) => void): void {
    this.observers.push(fn);
  }

  /** True when the guarded call is allowed to be attempted right now. */
  canAttempt(): boolean {
    this.maybeHalfOpen();
    return this.state !== 'open';
  }

  /**
   * Single-flight permission for one guarded attempt: false while open;
   * false in half-open while another probe is still in flight; otherwise
   * the attempt is registered and cleared by the matching settleAttempt.
   *
   * There is no open→half-open race to guard beyond this check: JS runs
   * single-threaded, and maybeHalfOpen() resolves the transition
   * synchronously at the top of this call, so the state test below always
   * sees the post-cooldown truth. A probe begun in half-open that is
   * still awaiting settlement blocks every other beginAttempt in
   * half-open (inFlight > 0) — exactly the one-probe-at-a-time contract.
   */
  beginAttempt(): boolean {
    this.maybeHalfOpen();
    if (this.state === 'open') return false;
    if (this.state === 'half-open' && this.inFlight > 0) return false;
    this.inFlight++;
    return true;
  }

  /**
   * Report the outcome of a beginAttempt()-permitted call. Defensive
   * against protocol violations: a settle with nothing in flight — no
   * preceding beginAttempt, or a SECOND settle after the first already
   * landed — is a silent no-op. The counter never goes negative and the
   * state machine is untouched, so a stray settle can neither open the
   * breaker on a phantom failure nor push a genuine one past the
   * threshold. Every legitimate settle (inFlight ≥ 1) decrements and
   * records its outcome; concurrent closed-state attempts each settle
   * their own.
   */
  settleAttempt(success: boolean): void {
    if (this.inFlight === 0) return;
    this.inFlight--;
    if (success) this.recordSuccess();
    else this.recordFailure();
  }

  recordSuccess(): void {
    this.failures = 0;
    this.transition('closed');
  }

  recordFailure(): void {
    this.failures++;
    // A failed probe from half-open re-opens immediately (fresh cool-down);
    // from closed it opens once the threshold is reached. While already
    // open, a stray/racing failure must NOT refresh openedAt — that would
    // silently extend the cool-down on every late failure report.
    //
    // `openedAt` is stamped BEFORE transition('open') fires the observers:
    // a synchronous observer that reads the breaker (canAttempt /
    // currentState → maybeHalfOpen) would otherwise test the cooldown
    // against a STALE openedAt and flip the just-opened breaker straight
    // to half-open, skipping the cool-down entirely.
    if (this.state === 'half-open') {
      this.openedAt = this.now();
      this.transition('open');
    } else if (this.state === 'closed' && this.failures >= this.threshold) {
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  private maybeHalfOpen(): void {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.transition('half-open');
    }
  }

  /**
   * Swap to `next` and notify the observers. A no-op when the state is
   * unchanged (e.g. recordSuccess while already closed), so observers see
   * only genuine transitions.
   */
  private transition(next: BreakerState): void {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    for (const fn of this.observers) {
      try {
        fn(from, next);
      } catch {
        // Observers are fire-and-forget; their failures are not ours.
      }
    }
  }
}
