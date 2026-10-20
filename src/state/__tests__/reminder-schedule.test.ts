import { describe, it, expect } from 'vitest';
import {
  reminderFireAt,
  selectReminderSchedules,
  selectDueReminders,
  isReminderResolved,
  buildReminderDueIso,
  reminderNudgeTimes,
  nudgeCopy,
  REMINDER_DEFAULT_HOUR,
  REMINDER_PENDING_CAP,
  type ReminderItem,
} from '../reminder-schedule';

// Local-time anchors so assertions don't depend on the runner's TZ: build the
// expected ms with the same local-parts constructor the impl uses.
const localMs = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('reminderFireAt', () => {
  it('returns null for missing/blank/garbage dueDate', () => {
    expect(reminderFireAt(undefined)).toBeNull();
    expect(reminderFireAt(null)).toBeNull();
    expect(reminderFireAt('')).toBeNull();
    expect(reminderFireAt('not-a-date')).toBeNull();
  });

  it('date-only fires at 9:00 local that day (not UTC midnight → prior day)', () => {
    expect(reminderFireAt('2026-06-20')).toBe(localMs(2026, 6, 20, REMINDER_DEFAULT_HOUR));
  });

  it('honors a custom default hour for date-only', () => {
    expect(reminderFireAt('2026-06-20', 7)).toBe(localMs(2026, 6, 20, 7));
  });

  it('datetime dueDate fires at that instant', () => {
    expect(reminderFireAt('2026-06-20T22:00:00')).toBe(localMs(2026, 6, 20, 22, 0));
  });
});

describe('isReminderResolved', () => {
  it('only ARCHIVED is resolved; completed alone is not', () => {
    expect(isReminderResolved({ id: 'a', status: 'ARCHIVED' })).toBe(true);
    expect(isReminderResolved({ id: 'a', status: 'NEW' } as ReminderItem)).toBe(false);
    expect(isReminderResolved({ id: 'a' } as ReminderItem)).toBe(false);
  });
});

describe('selectReminderSchedules', () => {
  const now = localMs(2026, 6, 20, 12, 0);
  it('keeps only unresolved, dueDate-bearing, future items', () => {
    const inbox: ReminderItem[] = [
      { id: 'future', title: 'A', dueDate: '2026-06-20T22:00:00' },
      { id: 'past', title: 'B', dueDate: '2026-06-20T08:00:00' }, // past → excluded
      { id: 'none', title: 'C' }, // no dueDate → excluded
      { id: 'archived', title: 'D', dueDate: '2026-06-21T09:00:00', status: 'ARCHIVED' }, // resolved
    ];
    const out = selectReminderSchedules(inbox, now);
    expect(out.map((x) => x.id)).toEqual(['future']);
    expect(out[0].fireAtMs).toBe(localMs(2026, 6, 20, 22, 0));
  });
  it('handles non-array input', () => {
    expect(selectReminderSchedules(null, now)).toEqual([]);
    expect(selectReminderSchedules(undefined, now)).toEqual([]);
  });
});

describe('selectDueReminders', () => {
  const now = localMs(2026, 6, 20, 12, 0);
  it('pins unresolved due/overdue items, total-ordered by (fireAt, id)', () => {
    const inbox: ReminderItem[] = [
      { id: 'b', title: 'noon', dueDate: '2026-06-20T09:00:00' },
      { id: 'a', title: 'same-time', dueDate: '2026-06-20T09:00:00' }, // tie → id order: a before b
      { id: 'future', title: 'later', dueDate: '2026-06-20T22:00:00' }, // not due yet
      { id: 'done', title: 'archived', dueDate: '2026-06-20T08:00:00', status: 'ARCHIVED' },
    ];
    const out = selectDueReminders(inbox, now);
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('excludes ids already surfaced elsewhere', () => {
    const inbox: ReminderItem[] = [
      { id: 'echo', title: 'just captured', dueDate: '2026-06-20T08:00:00' },
      { id: 'keep', title: 'other', dueDate: '2026-06-20T08:00:00' },
    ];
    const out = selectDueReminders(inbox, now, new Set(['echo']));
    expect(out.map((x) => x.id)).toEqual(['keep']);
  });
  it('excludes triaged-skip items even when due (stay absent from active Home surfaces)', () => {
    const inbox: ReminderItem[] = [
      { id: 'skipped', title: 'skipped but due', dueDate: '2026-06-20T08:00:00', triagedSkip: true },
      { id: 'keep', title: 'other', dueDate: '2026-06-20T08:00:00' },
    ];
    expect(selectDueReminders(inbox, now).map((x) => x.id)).toEqual(['keep']);
  });
  it('date-only item is due once 9:00 local passes', () => {
    const inbox: ReminderItem[] = [{ id: 'd', title: 'date-only', dueDate: '2026-06-20' }];
    expect(selectDueReminders(inbox, localMs(2026, 6, 20, 8, 0)).map((x) => x.id)).toEqual([]); // before 9
    expect(selectDueReminders(inbox, localMs(2026, 6, 20, 10, 0)).map((x) => x.id)).toEqual(['d']); // after 9
  });
});

describe('buildReminderDueIso (producer side of the N-1 contract)', () => {
  it('combines a valid HH:mm time into a datetime ISO', () => {
    expect(buildReminderDueIso('2026-06-20', '22:00')).toBe('2026-06-20T22:00:00');
  });
  it('falls back to date-only for missing / malformed time', () => {
    expect(buildReminderDueIso('2026-06-20')).toBe('2026-06-20');
    expect(buildReminderDueIso('2026-06-20', null)).toBe('2026-06-20');
    expect(buildReminderDueIso('2026-06-20', '')).toBe('2026-06-20');
    expect(buildReminderDueIso('2026-06-20', '10pm')).toBe('2026-06-20'); // not HH:mm
  });
  it('rejects out-of-range clocks → date-only (never builds an unparseable T99:99)', () => {
    expect(buildReminderDueIso('2026-06-20', '99:99')).toBe('2026-06-20');
    expect(buildReminderDueIso('2026-06-20', '24:00')).toBe('2026-06-20'); // hour > 23
    expect(buildReminderDueIso('2026-06-20', '12:60')).toBe('2026-06-20'); // minute > 59
    // boundaries still valid
    expect(buildReminderDueIso('2026-06-20', '00:00')).toBe('2026-06-20T00:00:00');
    expect(buildReminderDueIso('2026-06-20', '23:59')).toBe('2026-06-20T23:59:00');
    // and the degraded date-only is still consumable (pins at 9am), not null
    expect(reminderFireAt(buildReminderDueIso('2026-06-20', '99:99'))).toBe(
      localMs(2026, 6, 20, REMINDER_DEFAULT_HOUR),
    );
  });
});

// Producer↔consumer contract: a dueDate the capture executor builds via
// buildReminderDueIso must be consumed by reminderFireAt exactly as intended.
// This is the regression guard for NEX-198 PR C — if either side's date shape
// drifts, this fails.
describe('capture → reminder contract (buildReminderDueIso → reminderFireAt)', () => {
  it('dated capture WITH a clock time fires at that instant', () => {
    const due = buildReminderDueIso('2026-06-20', '22:00');
    expect(reminderFireAt(due)).toBe(localMs(2026, 6, 20, 22, 0));
  });
  it('dated capture WITHOUT a time fires at 9:00 local (date-only)', () => {
    const due = buildReminderDueIso('2026-06-20', undefined);
    expect(reminderFireAt(due)).toBe(localMs(2026, 6, 20, REMINDER_DEFAULT_HOUR));
  });
  it('an inbox item carrying a built dueDate pins once its moment passes', () => {
    const due = buildReminderDueIso('2026-06-20', '22:00');
    const inbox: ReminderItem[] = [{ id: 'r', title: 'call mom', dueDate: due }];
    expect(selectDueReminders(inbox, localMs(2026, 6, 20, 21, 0)).map((x) => x.id)).toEqual([]); // before
    expect(selectDueReminders(inbox, localMs(2026, 6, 20, 23, 0)).map((x) => x.id)).toEqual(['r']); // after
  });
});

describe('reminderNudgeTimes (NEX-259 cadence)', () => {
  const TWO_H = 2 * 3_600_000;
  it('future due → 3 slots at due/+2h/+4h', () => {
    const base = localMs(2026, 6, 20, 14, 0);
    const out = reminderNudgeTimes(base, localMs(2026, 6, 20, 10, 0));
    expect(out).toEqual([
      { ms: base, slot: 0 },
      { ms: base + TWO_H, slot: 1 },
      { ms: base + 2 * TWO_H, slot: 2 },
    ]);
  });
  it('toggle-on at the due minute → only the future +2h/+4h slots (absolute index kept)', () => {
    const base = localMs(2026, 6, 20, 14, 0);
    const out = reminderNudgeTimes(base, localMs(2026, 6, 20, 14, 0)); // now == due
    expect(out).toEqual([
      { ms: base + TWO_H, slot: 1 },
      { ms: base + 2 * TWO_H, slot: 2 },
    ]);
  });
  it('all of today’s slots past → tomorrow 9:00 (slot 0)', () => {
    const base = localMs(2026, 6, 20, 14, 0);
    const out = reminderNudgeTimes(base, localMs(2026, 6, 20, 20, 0)); // evening, 2/4/6pm past
    expect(out).toEqual([{ ms: localMs(2026, 6, 21, REMINDER_DEFAULT_HOUR), slot: 0 }]);
  });
  it('overdue from a PRIOR day → today 9:00 pattern, future slots only', () => {
    const base = localMs(2026, 6, 19, 14, 0); // yesterday
    const out = reminderNudgeTimes(base, localMs(2026, 6, 20, 10, 0)); // today 10am
    // anchor = today 9am; 9am past, 11am & 1pm future
    expect(out).toEqual([
      { ms: localMs(2026, 6, 20, 11, 0), slot: 1 },
      { ms: localMs(2026, 6, 20, 13, 0), slot: 2 },
    ]);
  });
});

describe('nudgeCopy', () => {
  it('varies by absolute slot, slot 0 matches the N-1 alert, clamps past the array', () => {
    expect(nudgeCopy(0)).toBe('A gentle reminder.');
    expect(nudgeCopy(1)).not.toBe(nudgeCopy(0));
    expect(nudgeCopy(2)).not.toBe(nudgeCopy(1));
    expect(nudgeCopy(9)).toBe(nudgeCopy(2)); // clamp
    // §18/§19: no exclamation/em dash/emoji
    for (const s of [0, 1, 2]) expect(nudgeCopy(s)).not.toMatch(/[!—\u{1F300}-\u{1FAFF}]/u);
  });
});

describe('selectReminderSchedules — keep-nudging families + global cap', () => {
  const now = localMs(2026, 6, 20, 10, 0);
  it('a keepNudging item emits its family (slots) instead of a single entry', () => {
    const inbox: ReminderItem[] = [
      { id: 'k', title: 'meds', dueDate: '2026-06-20T14:00:00', keepNudging: true },
    ];
    const out = selectReminderSchedules(inbox, now);
    expect(out.map((e) => e.slot)).toEqual([0, 1, 2]);
    expect(out.every((e) => e.id === 'k')).toBe(true);
  });
  it('a plain item still emits exactly one future entry (slot 0)', () => {
    const inbox: ReminderItem[] = [{ id: 'p', title: 'call', dueDate: '2026-06-20T14:00:00' }];
    const out = selectReminderSchedules(inbox, now);
    expect(out).toHaveLength(1);
    expect(out[0].slot).toBe(0);
  });
  it('global cap: many keepNudging items never exceed REMINDER_PENDING_CAP, soonest kept', () => {
    const inbox: ReminderItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `k${i}`,
      title: `t${i}`,
      dueDate: '2026-06-20T14:00:00',
      keepNudging: true,
    }));
    const out = selectReminderSchedules(inbox, now); // 30*3 = 90 candidates
    expect(out.length).toBe(REMINDER_PENDING_CAP);
    const times = out.map((e) => e.fireAtMs);
    expect(times).toEqual([...times].sort((a, b) => a - b)); // soonest-first
  });
  it('resolved / toggle-off collapses the family', () => {
    const resolved: ReminderItem[] = [
      { id: 'k', title: 'x', dueDate: '2026-06-20T14:00:00', keepNudging: true, status: 'ARCHIVED' },
    ];
    expect(selectReminderSchedules(resolved, now)).toEqual([]);
    const off: ReminderItem[] = [{ id: 'k', title: 'x', dueDate: '2026-06-20T14:00:00' }];
    expect(selectReminderSchedules(off, now)).toHaveLength(1); // back to single
  });
  it('two keepNudging items keep distinct ids (family isolation)', () => {
    const inbox: ReminderItem[] = [
      { id: 'a', title: 'A', dueDate: '2026-06-20T14:00:00', keepNudging: true },
      { id: 'b', title: 'B', dueDate: '2026-06-20T15:00:00', keepNudging: true },
    ];
    const ids = new Set(selectReminderSchedules(inbox, now).map((e) => e.id));
    expect(ids).toEqual(new Set(['a', 'b']));
  });
});
