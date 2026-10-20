import { describe, it, expect } from 'vitest';
import { repBadgeUnlocks, isComebackReturn, tripleThreatCount, foldPendingBadges } from '../badges';

describe('repBadgeUnlocks (cumulative, all-eligible, idempotent)', () => {
  it('returns nothing below the first threshold', () => {
    expect(repBadgeUnlocks(6)).toEqual([]);
  });
  it('returns ALL thresholds <= reps (self-heals a locked-but-earned badge)', () => {
    expect(repBadgeUnlocks(7)).toEqual(['first_week']);
    expect(repBadgeUnlocks(30)).toEqual(['first_week', 'iron_will']);
    expect(repBadgeUnlocks(150)).toEqual(['first_week', 'iron_will', 'centurion']);
  });
});

describe('isComebackReturn (back after a real, scheduled gap — never the first log)', () => {
  it('is false with no prior log (a brand-new habit can never be a comeback)', () => {
    expect(isComebackReturn({ prevLogDateKey: null, todayKey: '2026-06-17', daysOfWeek: [0,1,2,3,4,5,6] })).toBe(false);
  });
  it('daily: false when the previous log was yesterday (no missed day)', () => {
    expect(isComebackReturn({ prevLogDateKey: '2026-06-16', todayKey: '2026-06-17', daysOfWeek: [] })).toBe(false);
  });
  it('daily: true when a scheduled day was missed in between', () => {
    expect(isComebackReturn({ prevLogDateKey: '2026-06-14', todayKey: '2026-06-17', daysOfWeek: [] })).toBe(true);
  });
  it('M/W/F: false for the normal Wed→Fri cadence (no scheduled day skipped)', () => {
    // 2026-06-17 is a Wednesday; 2026-06-19 is the following Friday.
    expect(isComebackReturn({ prevLogDateKey: '2026-06-17', todayKey: '2026-06-19', daysOfWeek: [1, 3, 5] })).toBe(false);
  });
  it('M/W/F: true when a scheduled occurrence was skipped (Wed → next Mon, Fri missed)', () => {
    // Wed 2026-06-17 → Mon 2026-06-22; Friday the 19th (scheduled) was skipped.
    expect(isComebackReturn({ prevLogDateKey: '2026-06-17', todayKey: '2026-06-22', daysOfWeek: [1, 3, 5] })).toBe(true);
  });
  it('weekly (Mon only): false across one normal week gap (no extra Monday skipped)', () => {
    // Mon 2026-06-15 → Mon 2026-06-22; no Monday strictly in between.
    expect(isComebackReturn({ prevLogDateKey: '2026-06-15', todayKey: '2026-06-22', daysOfWeek: [1] })).toBe(false);
  });
  it('weekly (Mon only): true when a whole scheduled Monday was skipped', () => {
    // Mon 2026-06-08 → Mon 2026-06-22; Monday the 15th was skipped.
    expect(isComebackReturn({ prevLogDateKey: '2026-06-08', todayKey: '2026-06-22', daysOfWeek: [1] })).toBe(true);
  });
});

describe('tripleThreatCount (distinct live habits with progress this week)', () => {
  const live = ['Meditate', 'Read', 'Stretch', 'Walk'];
  it('counts distinct live habits with ≥1 log in the week window', () => {
    const log = [
      { habitTitle: 'meditate', dateKey: '2026-06-15' },
      { habitTitle: 'Meditate', dateKey: '2026-06-16' }, // same habit, still one
      { habitTitle: 'read', dateKey: '2026-06-16' },
      { habitTitle: 'stretch', dateKey: '2026-06-17' },
    ];
    expect(tripleThreatCount(log, live, '2026-06-14', '2026-06-20')).toBe(3);
  });
  it('excludes logs outside the week and non-live titles', () => {
    const log = [
      { habitTitle: 'meditate', dateKey: '2026-06-10' }, // before week
      { habitTitle: 'read', dateKey: '2026-06-16' },
      { habitTitle: 'ghost', dateKey: '2026-06-16' },    // not a live rule
    ];
    expect(tripleThreatCount(log, live, '2026-06-14', '2026-06-20')).toBe(1);
  });
});

describe('foldPendingBadges (never clobber an in-flight celebration)', () => {
  const b = (id: string) => ({ id });
  const empty = { pendingBadgeUnlock: null as { id: string } | null, pendingBadgeUnlockQueue: [] as { id: string }[] };

  it('nothing newly unlocked → preserves the current head + queue untouched', () => {
    const current = { pendingBadgeUnlock: b('first_week'), pendingBadgeUnlockQueue: [b('iron_will')] };
    expect(foldPendingBadges(current, [])).toBe(current); // same reference, untouched
  });

  it('nothing showing → first new badge becomes the head, rest queue', () => {
    expect(foldPendingBadges(empty, [b('first_week'), b('iron_will'), b('centurion')])).toEqual({
      pendingBadgeUnlock: b('first_week'),
      pendingBadgeUnlockQueue: [b('iron_will'), b('centurion')],
    });
  });

  it('a toast already showing → appends new badges to the queue, head unchanged', () => {
    const current = { pendingBadgeUnlock: b('first_week'), pendingBadgeUnlockQueue: [b('iron_will')] };
    expect(foldPendingBadges(current, [b('centurion')])).toEqual({
      pendingBadgeUnlock: b('first_week'),
      pendingBadgeUnlockQueue: [b('iron_will'), b('centurion')],
    });
  });

  it('a second log with no new unlocks does not wipe the pending toast (the overwrite bug)', () => {
    const current = { pendingBadgeUnlock: b('iron_will'), pendingBadgeUnlockQueue: [b('centurion')] };
    expect(foldPendingBadges(current, [])).toEqual(current);
  });
});
