import { describe, it, expect } from 'vitest';
import {
  computeTrialNudgeCandidates,
  resolveTrialNudgeSchedule,
  trialNudgeContent,
  DAY0_OFFSET_MS,
  DAY1_OFFSET_MS,
  TRIAL_NUDGE_MIN_GAP_MS,
  type TrialNudgeInfo,
  type TrialNudge,
} from '../trial-nudge-types';
import type { QuietWindow } from '@/src/utils/notification-quiet-hours';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z (a non-quiet-hour instant)
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function info(over: Partial<TrialNudgeInfo>): TrialNudgeInfo {
  return {
    periodType: 'TRIAL',
    originalPurchaseMs: NOW,
    expirationMs: NOW + 7 * DAY,
    familyShared: false,
    ...over,
  };
}

// A window that never shifts anything (start === end is the documented
// degenerate no-op per notification-quiet-hours.ts).
const NO_SHIFT_WINDOW: QuietWindow = { startMinute: 0, endMinute: 0 };

describe('computeTrialNudgeCandidates', () => {
  it('null info → []', () => {
    expect(computeTrialNudgeCandidates(null, NOW)).toEqual([]);
  });

  it('periodType casing is normalized — TRIAL / Trial / trial all schedule', () => {
    for (const periodType of ['TRIAL', 'Trial', 'trial']) {
      const r = computeTrialNudgeCandidates(info({ periodType }), NOW);
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('non-trial period types → []', () => {
    for (const periodType of ['INTRO', 'NORMAL', 'PREPAID']) {
      expect(computeTrialNudgeCandidates(info({ periodType }), NOW)).toEqual([]);
    }
  });

  it('family-shared entitlement → [] (this device did not start the trial)', () => {
    expect(computeTrialNudgeCandidates(info({ familyShared: true }), NOW)).toEqual([]);
  });

  it('expired trial (expirationMs <= nowMs) → [] (defensive staleness guard)', () => {
    expect(computeTrialNudgeCandidates(info({ expirationMs: NOW - HOUR }), NOW)).toEqual([]);
    expect(computeTrialNudgeCandidates(info({ expirationMs: NOW }), NOW)).toEqual([]);
  });

  it('null / non-finite expirationMs or originalPurchaseMs → []', () => {
    expect(computeTrialNudgeCandidates(info({ expirationMs: null }), NOW)).toEqual([]);
    expect(computeTrialNudgeCandidates(info({ expirationMs: NaN }), NOW)).toEqual([]);
    expect(computeTrialNudgeCandidates(info({ originalPurchaseMs: null }), NOW)).toEqual([]);
    expect(computeTrialNudgeCandidates(info({ originalPurchaseMs: NaN }), NOW)).toEqual([]);
  });

  it('trial just started (small realistic gap) → both Day-0 and Day-1 candidates', () => {
    const startMs = NOW - 5_000;
    const r = computeTrialNudgeCandidates(info({ originalPurchaseMs: startMs }), NOW);
    expect(r).toEqual([
      { day: 0, fireAtMs: startMs + DAY0_OFFSET_MS },
      { day: 1, fireAtMs: startMs + DAY1_OFFSET_MS },
    ]);
  });

  it('trial too short to reach Day-1 (expiration between Day-0 and Day-1) → only Day-0', () => {
    const startMs = NOW;
    const exp = startMs + DAY0_OFFSET_MS + HOUR; // just after Day-0, well before Day-1
    const r = computeTrialNudgeCandidates(info({ originalPurchaseMs: startMs, expirationMs: exp }), NOW);
    expect(r).toEqual([{ day: 0, fireAtMs: startMs + DAY0_OFFSET_MS }]);
  });

  it('trial too short to reach even Day-0 (expiration before Day-0) → []', () => {
    const startMs = NOW;
    const exp = startMs + DAY0_OFFSET_MS - HOUR;
    expect(computeTrialNudgeCandidates(info({ originalPurchaseMs: startMs, expirationMs: exp }), NOW)).toEqual([]);
  });

  it('Day-1 always fires strictly after Day-0 (invariant, holds by construction)', () => {
    const r = computeTrialNudgeCandidates(info({ originalPurchaseMs: NOW }), NOW);
    const day0 = r.find((c) => c.day === 0)!;
    const day1 = r.find((c) => c.day === 1)!;
    expect(day1.fireAtMs).toBeGreaterThan(day0.fireAtMs);
  });
});

describe('resolveTrialNudgeSchedule', () => {
  it('no quiet window → candidates pass through unshifted, filtered to future', () => {
    // day0 already past, day1 still future — a realistic in-order pair (unlike
    // the ordering-clamp test below, this doesn't trigger the Day-0/Day-1
    // re-assertion since day1 > day0 already).
    const candidates: TrialNudge[] = [
      { day: 0, fireAtMs: NOW - HOUR },
      { day: 1, fireAtMs: NOW + HOUR },
    ];
    const r = resolveTrialNudgeSchedule(candidates, NOW, null, NOW + 30 * DAY);
    expect(r).toEqual([{ day: 1, fireAtMs: NOW + HOUR }]);
  });

  it('a raw-past candidate that shifts forward into the future is NOT dropped (the bug this design fixes)', () => {
    // 23:00 local quiet start, 08:00 local quiet end — a raw fire time inside
    // the window shifts forward to the next 08:00, which can land AFTER nowMs
    // even though the RAW time was <= nowMs.
    const quiet: QuietWindow = { startMinute: 23 * 60, endMinute: 8 * 60 };
    const rawDay0 = new Date(2026, 5, 1, 23, 30, 0).getTime(); // 23:30 local, inside quiet window
    const laterNowMs = rawDay0 + 10 * 60 * 1000; // "now" is 10 min after the raw time — raw looks past-due
    const candidates: TrialNudge[] = [{ day: 0, fireAtMs: rawDay0 }];

    const r = resolveTrialNudgeSchedule(candidates, laterNowMs, quiet, laterNowMs + 30 * DAY);

    expect(r).toHaveLength(1);
    expect(r[0].fireAtMs).toBeGreaterThan(laterNowMs); // shifted time is still genuinely future
  });

  it('a shift that would push Day-1 at/before Day-0 clamps Day-1 forward by the minimum gap', () => {
    const day0Shifted = NOW + HOUR;
    const candidates: TrialNudge[] = [
      { day: 0, fireAtMs: day0Shifted },
      { day: 1, fireAtMs: day0Shifted - HOUR }, // would land before Day-0 post-shift
    ];
    const r = resolveTrialNudgeSchedule(candidates, NOW, NO_SHIFT_WINDOW, NOW + 30 * DAY);
    const day0 = r.find((c) => c.day === 0)!;
    const day1 = r.find((c) => c.day === 1)!;
    expect(day1.fireAtMs).toBe(day0.fireAtMs + TRIAL_NUDGE_MIN_GAP_MS);
  });

  it('a candidate whose final time lands at/after expirationMs is dropped', () => {
    const expirationMs = NOW + 2 * HOUR;
    const candidates: TrialNudge[] = [
      { day: 0, fireAtMs: NOW + HOUR }, // before expiration
      { day: 1, fireAtMs: NOW + 3 * HOUR }, // after expiration
    ];
    const r = resolveTrialNudgeSchedule(candidates, NOW, NO_SHIFT_WINDOW, expirationMs);
    expect(r).toEqual([{ day: 0, fireAtMs: NOW + HOUR }]);
  });

  it('a candidate whose shifted time is still <= nowMs (late reconcile) is dropped', () => {
    const candidates: TrialNudge[] = [
      { day: 0, fireAtMs: NOW - DAY }, // long past, both raw and shifted
    ];
    const r = resolveTrialNudgeSchedule(candidates, NOW, NO_SHIFT_WINDOW, NOW + 30 * DAY);
    expect(r).toEqual([]);
  });

  it('empty candidates → []', () => {
    expect(resolveTrialNudgeSchedule([], NOW, NO_SHIFT_WINDOW, NOW + 30 * DAY)).toEqual([]);
  });
});

describe('trialNudgeContent', () => {
  it('copy is §18-clean (no em dash, no exclamation) for both days', () => {
    for (const day of [0, 1] as const) {
      const { title, body } = trialNudgeContent(day);
      expect(title).not.toMatch(/[—!]/);
      expect(body).not.toMatch(/[—!]/);
    }
  });

  it('Day-0 and Day-1 copy differ', () => {
    expect(trialNudgeContent(0).title).not.toBe(trialNudgeContent(1).title);
  });

  it('never mentions charging or billing (value-forward, not a billing reminder)', () => {
    for (const day of [0, 1] as const) {
      const { title, body } = trialNudgeContent(day);
      expect(`${title} ${body}`.toLowerCase()).not.toMatch(/charg|bill|renew/);
    }
  });
});
