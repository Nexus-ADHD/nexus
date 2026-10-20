import { describe, expect, it } from 'vitest';
import { weeksSinceEpoch, weeklyFallback, FOCUS_FALLBACKS } from '../gentle-novelty';

// NEX-214: weekly even-cycling rotation of the Focus fallback + §18 copy gate.

// A command-verb set — a fallback must NOT lead with one (no coaching/imperative).
const LEADING_IMPERATIVES =
  /^(build|pick|set|start|choose|make|do|keep|take|focus|finish|plan|write|go|get|add|try|push|commit|cut)\b/i;

describe('weeksSinceEpoch (NEX-214)', () => {
  it('advances by one each week and is deterministic', () => {
    const a = weeksSinceEpoch('2026-06-21'); // a Sunday
    const b = weeksSinceEpoch('2026-06-28'); // next Sunday
    expect(b - a).toBe(1);
    expect(weeksSinceEpoch('2026-06-21')).toBe(a); // stable
  });
  it('returns -1 for an unparseable key', () => {
    expect(weeksSinceEpoch('nope')).toBe(-1);
    expect(weeksSinceEpoch('' as any)).toBe(-1);
  });
  it('returns -1 for an impossible date that Date.UTC would roll over', () => {
    // 2026-13-40 would normalize to 2027-02-09; the round-trip guard rejects it
    // so weeklyFallback hits options[0] instead of a rotated index.
    expect(weeksSinceEpoch('2026-13-40')).toBe(-1);
    expect(weeksSinceEpoch('2026-02-30')).toBe(-1); // Feb 30 -> Mar 2
    expect(weeklyFallback(FOCUS_FALLBACKS, '2026-13-40')).toBe(FOCUS_FALLBACKS[0]);
  });
});

describe('weeklyFallback (NEX-214)', () => {
  it('is stable within a week and deterministic', () => {
    expect(weeklyFallback(FOCUS_FALLBACKS, '2026-06-21')).toBe(
      weeklyFallback(FOCUS_FALLBACKS, '2026-06-21'),
    );
  });
  it('cycles through EVERY option in order over consecutive weeks', () => {
    // 6 consecutive Sundays must hit all 6 distinct lines, in order.
    const sundays = ['2026-06-07', '2026-06-14', '2026-06-21', '2026-06-28', '2026-07-05', '2026-07-12'];
    const picks = sundays.map((s) => weeklyFallback(FOCUS_FALLBACKS, s));
    expect(new Set(picks).size).toBe(FOCUS_FALLBACKS.length); // all distinct
    // and the 7th Sunday wraps back to the 1st pick
    expect(weeklyFallback(FOCUS_FALLBACKS, '2026-07-19')).toBe(picks[0]);
  });
  it('handles empty options and unparseable keys safely', () => {
    expect(weeklyFallback([], '2026-06-21')).toBe('');
    expect(weeklyFallback(FOCUS_FALLBACKS, 'nope')).toBe(FOCUS_FALLBACKS[0]);
  });
});

describe('FOCUS_FALLBACKS — §18 compliance', () => {
  it('is non-empty with no duplicates', () => {
    expect(FOCUS_FALLBACKS.length).toBeGreaterThan(1);
    expect(new Set(FOCUS_FALLBACKS).size).toBe(FOCUS_FALLBACKS.length);
  });
  it('every line is declarative, non-coaching, no em dash, no exclamation', () => {
    for (const line of FOCUS_FALLBACKS) {
      expect(line).not.toContain('—');
      expect(line).not.toContain('!');
      expect(line.toLowerCase()).not.toMatch(/\byou\b|\byour\b/);
      expect(line).not.toMatch(LEADING_IMPERATIVES); // no leading command verb
    }
  });
});
