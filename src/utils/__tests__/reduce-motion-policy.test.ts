/**
 * The Reduce Motion policy, including the branch that shipped uncovered.
 *
 * Greptile found on PR #438 that nothing exercised a REJECTED preference read,
 * while the plan promised the wave would fail toward stillness. It ran the real
 * hook against a rejecting `AccessibilityInfo` and recorded it resolving to
 * `reduceMotion: false` — a failed read reading as permission to animate.
 *
 * The hook itself is unreachable from this suite (vitest here is pure-Node,
 * globs only `src/`, `scripts/` and `tools/`, and the repo has no hook renderer),
 * which is exactly why the meaning was extracted. These tests cover it.
 */
import { describe, expect, it } from 'vitest';

import {
  REDUCE_MOTION_INITIAL,
  ornamentMayAnimate,
  reduceMotionStateFor,
  type ReduceMotionOutcome,
} from '../reduce-motion-policy';

describe('reduceMotionStateFor', () => {
  it('learns the preference from a successful read', () => {
    expect(reduceMotionStateFor({ kind: 'read', enabled: true })).toEqual({
      reduceMotion: true,
      resolved: true,
      confirmed: true,
    });
    expect(reduceMotionStateFor({ kind: 'read', enabled: false })).toEqual({
      reduceMotion: false,
      resolved: true,
      confirmed: true,
    });
  });

  it('learns it from a live event too', () => {
    expect(reduceMotionStateFor({ kind: 'event', enabled: true }).confirmed).toBe(true);
    expect(reduceMotionStateFor({ kind: 'event', enabled: false }).confirmed).toBe(true);
  });

  it('RESOLVES but does not CONFIRM a failed read — the P1 from #438', () => {
    // Both halves are deliberate and they point opposite ways:
    //   resolved  so a one-off AccessibilityInfo failure cannot freeze the app
    //   !confirmed so ornament does not take a failure as permission
    const s = reduceMotionStateFor({ kind: 'failed' });
    expect(s.resolved).toBe(true);
    expect(s.confirmed).toBe(false);
    expect(s.reduceMotion).toBe(false);
  });
});

describe('ornamentMayAnimate', () => {
  it('is false until the preference is CONFIRMED off', () => {
    expect(ornamentMayAnimate(REDUCE_MOTION_INITIAL)).toBe(false);
    expect(ornamentMayAnimate(reduceMotionStateFor({ kind: 'failed' }))).toBe(false);
    expect(ornamentMayAnimate(reduceMotionStateFor({ kind: 'read', enabled: true }))).toBe(
      false,
    );
  });

  it('is true only on a confirmed Reduce Motion OFF', () => {
    expect(ornamentMayAnimate(reduceMotionStateFor({ kind: 'read', enabled: false }))).toBe(
      true,
    );
    expect(ornamentMayAnimate(reduceMotionStateFor({ kind: 'event', enabled: false }))).toBe(
      true,
    );
  });

  it('never animates on an unconfirmed state, whatever else is set', () => {
    // Exhaustive over the flag space rather than the states the hook happens to
    // produce: a future edit that starts emitting `confirmed: false` with
    // `reduceMotion: false` must still be still.
    for (const reduceMotion of [true, false]) {
      for (const resolved of [true, false]) {
        expect(ornamentMayAnimate({ reduceMotion, resolved, confirmed: false })).toBe(false);
      }
    }
  });

  it('functional motion and ornament disagree exactly where they should', () => {
    // The whole reason two flags exist. On a failed read, transitions play and
    // decoration does not.
    const failed = reduceMotionStateFor({ kind: 'failed' });
    expect(failed.resolved).toBe(true); // functional motion: go
    expect(ornamentMayAnimate(failed)).toBe(false); // ornament: stay still
  });

  it('every outcome resolves, so nothing can hang on `resolved`', () => {
    const outcomes: ReduceMotionOutcome[] = [
      { kind: 'read', enabled: true },
      { kind: 'read', enabled: false },
      { kind: 'event', enabled: true },
      { kind: 'event', enabled: false },
      { kind: 'failed' },
    ];
    outcomes.forEach((o) => expect(reduceMotionStateFor(o).resolved).toBe(true));
  });
});
