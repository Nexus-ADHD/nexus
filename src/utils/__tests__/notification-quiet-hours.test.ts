import { describe, it, expect } from 'vitest';
import {
  computeQuietShift,
  shiftOutOfQuietHours,
  resolveQuietWindow,
  DEFAULT_QUIET_START_MINUTE,
  DEFAULT_QUIET_END_MINUTE,
} from '../notification-quiet-hours';

const START = DEFAULT_QUIET_START_MINUTE; // 1320 = 22:00
const END = DEFAULT_QUIET_END_MINUTE;     // 480 = 08:00
const M = (h: number, m = 0) => h * 60 + m;

// ── Pure integer core (TZ-independent) ──────────────────────────────────────
describe('computeQuietShift (wrap window 22:00–08:00)', () => {
  it('daytime fires are not shifted', () => {
    for (const t of [M(8), M(9), M(12), M(17), M(21, 59)]) {
      expect(computeQuietShift(t, START, END).shift).toBe(false);
    }
  });

  it('evening side (>= 22:00) shifts to 08:00 next day', () => {
    expect(computeQuietShift(M(22), START, END)).toEqual({ shift: true, targetMinute: END, dayDelta: 1 });
    expect(computeQuietShift(M(23, 30), START, END)).toEqual({ shift: true, targetMinute: END, dayDelta: 1 });
  });

  it('early-morning side (< 08:00) shifts to 08:00 same day', () => {
    expect(computeQuietShift(M(0), START, END)).toEqual({ shift: true, targetMinute: END, dayDelta: 0 });
    expect(computeQuietShift(M(2, 27), START, END)).toEqual({ shift: true, targetMinute: END, dayDelta: 0 }); // the 2:27am case
    expect(computeQuietShift(M(7, 59), START, END)).toEqual({ shift: true, targetMinute: END, dayDelta: 0 });
  });

  it('boundary is half-open [start, end): 22:00 shifts, 08:00 allowed', () => {
    expect(computeQuietShift(START, START, END).shift).toBe(true);  // exactly 22:00 → shift
    expect(computeQuietShift(END, START, END).shift).toBe(false);   // exactly 08:00 → allowed
  });

  it('same-day window (e.g. 13:00–14:00) shifts only inside it', () => {
    expect(computeQuietShift(M(13, 30), M(13), M(14))).toEqual({ shift: true, targetMinute: M(14), dayDelta: 0 });
    expect(computeQuietShift(M(12, 59), M(13), M(14)).shift).toBe(false);
    expect(computeQuietShift(M(14), M(13), M(14)).shift).toBe(false); // end boundary allowed
  });

  it('degenerate window (start === end) never shifts', () => {
    expect(computeQuietShift(M(3), 600, 600).shift).toBe(false);
  });

  it('out-of-range / NaN inputs are safe', () => {
    expect(computeQuietShift(NaN, START, END).shift).toBe(false);
    expect(computeQuietShift(M(2), START, END).shift).toBe(true); // sanity that core still works
  });
});

// ── Date wrapper (assert relative properties, TZ-robust) ─────────────────────
describe('shiftOutOfQuietHours', () => {
  function localFire(y: number, mo: number, d: number, h: number, mi: number): number {
    return new Date(y, mo, d, h, mi, 0, 0).getTime();
  }
  const quiet = { startMinute: START, endMinute: END };

  it('a 2:27am fire moves to 08:00 the same local day', () => {
    const fire = localFire(2026, 5, 21, 2, 27);
    const out = new Date(shiftOutOfQuietHours(fire, quiet));
    expect(out.getHours()).toBe(8);
    expect(out.getMinutes()).toBe(0);
    expect(out.getDate()).toBe(21); // same local day
    expect(out.getTime()).toBeGreaterThan(fire);
  });

  it('an 23:00 fire moves to 08:00 the NEXT local day', () => {
    const fire = localFire(2026, 5, 21, 23, 0);
    const out = new Date(shiftOutOfQuietHours(fire, quiet));
    expect(out.getHours()).toBe(8);
    expect(out.getDate()).toBe(22); // next local day
  });

  it('a daytime fire is returned unchanged', () => {
    const fire = localFire(2026, 5, 21, 14, 0);
    expect(shiftOutOfQuietHours(fire, quiet)).toBe(fire);
  });

  it('is idempotent — re-shifting an already-shifted time is a no-op', () => {
    const fire = localFire(2026, 5, 21, 3, 0);
    const once = shiftOutOfQuietHours(fire, quiet);
    const twice = shiftOutOfQuietHours(once, quiet);
    expect(twice).toBe(once); // lands at 08:00 (the allowed boundary), no further shift
  });

  it('non-finite fire is returned unchanged', () => {
    expect(shiftOutOfQuietHours(NaN, quiet)).toBeNaN();
  });
});

// ── resolveQuietWindow (default-on-read) ────────────────────────────────────
describe('resolveQuietWindow', () => {
  it('defaults to 22:00–08:00 when settings is null/undefined', () => {
    for (const s of [null, undefined]) {
      expect(resolveQuietWindow(s)).toEqual({ startMinute: START, endMinute: END });
    }
  });

  it('defaults each edge independently when only one key is present', () => {
    expect(resolveQuietWindow({ quietHoursStart: M(23) })).toEqual({ startMinute: M(23), endMinute: END });
    expect(resolveQuietWindow({ quietHoursEnd: M(9) })).toEqual({ startMinute: START, endMinute: M(9) });
  });

  it('passes through both configured edges', () => {
    expect(resolveQuietWindow({ quietHoursStart: M(21), quietHoursEnd: M(7) })).toEqual({
      startMinute: M(21),
      endMinute: M(7),
    });
  });

  it('treats an explicit 0 (00:00) as a real value, not missing', () => {
    // ?? (not ||) — midnight is a legitimate edge and must survive.
    expect(resolveQuietWindow({ quietHoursStart: 0, quietHoursEnd: 0 })).toEqual({ startMinute: 0, endMinute: 0 });
  });

  it('falls back to the default when an edge is null (stale cloud blob)', () => {
    expect(resolveQuietWindow({ quietHoursStart: null, quietHoursEnd: null })).toEqual({
      startMinute: START,
      endMinute: END,
    });
  });
});
