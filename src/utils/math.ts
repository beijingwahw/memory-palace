/**
 * Shared numeric utilities — the single home for clamping. Previously
 * clamp01 was defined independently in three modules and clampNum in a
 * fourth; one canonical implementation now serves all callers.
 */

/** Clamp to [0, 1]. */
export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Clamp to [lo, hi]. */
export function clampNum(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
