/**
 * What a Reduce Motion read MEANS, as pure functions.
 *
 * Extracted from `hooks/use-reduce-motion.ts` for one reason: the branch that
 * matters most cannot be reached from a test otherwise. `vitest` here is
 * pure-Node and only globs `src/**`, `scripts/**` and `tools/**`, and the repo
 * has no hook-rendering library, so a hook that owns its own decision logic has
 * an untestable failure path. Greptile found exactly that on PR #438: the plan
 * promised Reduce Motion would fail toward stillness, and nothing exercised a
 * REJECTED preference read.
 *
 * So the hook keeps the subscriptions and the token guard, and the meaning
 * lives here where it can be covered.
 */

export type ReduceMotionState = {
  /** The OS preference, as last known. */
  reduceMotion: boolean;
  /** Has the initial async read finished, successfully or not? */
  resolved: boolean;
  /** Was the preference actually LEARNED? False after a failed read. */
  confirmed: boolean;
};

/**
 * What happened. A successful read and a live `reduceMotionChanged` event both
 * teach us the preference; a rejection teaches us nothing.
 */
export type ReduceMotionOutcome =
  | { kind: 'read'; enabled: boolean }
  | { kind: 'event'; enabled: boolean }
  | { kind: 'failed' };

/** Nothing known yet: the first render, before the async read returns. */
export const REDUCE_MOTION_INITIAL: ReduceMotionState = {
  reduceMotion: false,
  resolved: false,
  confirmed: false,
};

/**
 * Fold an outcome into state.
 *
 * The asymmetry in the `failed` branch is the whole point and is deliberate on
 * BOTH sides:
 *
 *   `resolved: true`  — a one-off `AccessibilityInfo` failure must not strand
 *                       the app frozen. Motion the user is waiting on plays.
 *   `confirmed: false` — but we did not learn anything, so ornament stays off.
 *
 * One flag cannot express that, which is why there are two. Gate functional
 * motion on `resolved`; gate decoration on `ornamentMayAnimate`.
 */
export function reduceMotionStateFor(outcome: ReduceMotionOutcome): ReduceMotionState {
  switch (outcome.kind) {
    case 'read':
    case 'event':
      return { reduceMotion: outcome.enabled, resolved: true, confirmed: true };
    case 'failed':
      return { reduceMotion: false, resolved: true, confirmed: false };
  }
}

/**
 * May a purely decorative loop run?
 *
 * Only on a confirmed "Reduce Motion is off". Unknown is treated as on, so
 * every unconfirmed window — first render, an in-flight read, a rejected read —
 * is still. §1.5 UF-01: a decorative visual must fail toward its absence.
 */
export function ornamentMayAnimate(state: ReduceMotionState): boolean {
  return state.confirmed && !state.reduceMotion;
}
