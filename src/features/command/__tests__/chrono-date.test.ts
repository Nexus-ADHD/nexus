import { describe, expect, it } from 'vitest';
import { resolveChronoDate, isAmbiguousNextWeekday } from '../chrono-date';

// Fixed reference: Saturday 2026-07-25, 12:00 local — deterministic across runs.
const REF = new Date(2026, 6, 25, 12, 0, 0);

describe('resolveChronoDate', () => {
  it('resolves the reported failing sentence to the coming Thursday, flagged ambiguous', () => {
    expect(resolveChronoDate('add flag football to the calendar for next Thursday at 11:30am', REF))
      .toEqual({ dateStr: '2026-07-30', ambiguous: true });
  });

  it('resolves bare "next Thursday" (ambiguous)', () => {
    expect(resolveChronoDate('next Thursday', REF)).toEqual({ dateStr: '2026-07-30', ambiguous: true });
  });

  it('resolves "next Monday" to the upcoming Monday (ambiguous)', () => {
    const r = resolveChronoDate('next Monday', REF);
    expect(r).toEqual({ dateStr: '2026-07-27', ambiguous: true });
    // 2026-07-27 is a Monday and after the reference.
    const d = new Date(2026, 6, 27, 12, 0, 0);
    expect(d.getDay()).toBe(1);
    expect(d.getTime()).toBeGreaterThan(REF.getTime());
  });

  it('resolves "tomorrow" (not ambiguous)', () => {
    expect(resolveChronoDate('tomorrow', REF)).toEqual({ dateStr: '2026-07-26', ambiguous: false });
  });

  it('resolves "in 3 days" (not ambiguous)', () => {
    expect(resolveChronoDate('in 3 days', REF)).toEqual({ dateStr: '2026-07-28', ambiguous: false });
  });

  it('returns null for a time-only phrase (pins no day)', () => {
    expect(resolveChronoDate('at 5pm', REF)).toBeNull();
  });

  it('returns null when there is no date at all', () => {
    expect(resolveChronoDate('just some words', REF)).toBeNull();
  });

  it('returns null (never throws) on empty / nullish input', () => {
    expect(resolveChronoDate('', REF)).toBeNull();
    // Exercise the runtime nullish guard (text ?? '') past the string type.
    expect(resolveChronoDate(undefined as unknown as string, REF)).toBeNull();
  });

  // DST correctness — a wall-clock date on a transition day must keep its local
  // Y-M-D (dateKeyOf reads local components). 9:30am / 1:30am are clear of the
  // 2am boundary, so these hold regardless of the box timezone.
  it('resolves a spring-forward date with no off-by-one', () => {
    expect(resolveChronoDate('March 8 2026 at 9:30am', REF)?.dateStr).toBe('2026-03-08');
  });

  it('resolves a fall-back date with no off-by-one', () => {
    expect(resolveChronoDate('November 1 2026 at 1:30am', REF)?.dateStr).toBe('2026-11-01');
  });
});

describe('isAmbiguousNextWeekday', () => {
  it('is true for "next <weekday>" forms', () => {
    expect(isAmbiguousNextWeekday('next fri')).toBe(true);
    expect(isAmbiguousNextWeekday('remind me next Thursday')).toBe(true);
  });

  it('is false for a bare or "this" weekday', () => {
    expect(isAmbiguousNextWeekday('this friday')).toBe(false);
    expect(isAmbiguousNextWeekday('friday')).toBe(false);
  });
});
