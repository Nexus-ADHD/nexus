import { describe, it, expect } from 'vitest';
import {
  computeHabitProgress,
  computeHabitStrength,
  computeAnchorAdherence,
  computeLifetimeReps,
  computeRowRollups,
  computeWeeklyReps,
  crossedRepMilestone,
  weeklyProgressLabel,
  topHabitByReps,
} from '../habit-rollup';

// ───────────────────────────────────────────────────────────────────────
// Test helpers — all dates are anchored at noon local to avoid DST and
// timezone-boundary surprises in scheduledDay enumeration.
// ───────────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(now: Date, n: number): Date {
  return new Date(now.getTime() - n * DAY_MS);
}

function logEntry(habitTitle: string, dateKey: string, hour = 9): {
  habitTitle: string;
  dateKey: string;
  timestamp: number;
} {
  // Build a timestamp for `dateKey` at the given local hour.
  const [y, m, d] = dateKey.split('-').map(Number);
  const ts = new Date(y, m - 1, d, hour, 0, 0).getTime();
  return { habitTitle, dateKey, timestamp: ts };
}

const NOW = new Date(2026, 4, 4, 12, 0, 0); // 2026-05-04 noon, a Monday

// ───────────────────────────────────────────────────────────────────────
// computeHabitStrength
// ───────────────────────────────────────────────────────────────────────

describe('computeHabitStrength', () => {
  it('returns started status when scheduled history < 7', () => {
    // Daily habit created 5 days ago — 6 scheduled occurrences (counting
    // both endpoints). Wait: 5 days ago through today inclusive = 6 days.
    // That's < 7, so STARTED gate fires.
    const rule = {
      id: 'r1',
      title: 'Yoga',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: daysAgo(NOW, 5).getTime(),
    };
    const result = computeHabitStrength(rule, [], NOW);
    expect(result.status).toBe('started');
    expect(result.strength).toBeNull();
    expect(result.band).toBeNull();
  });

  it('reports 100 strength on a perfect 30-day daily habit', () => {
    const rule = {
      id: 'r1',
      title: 'Meditation',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: daysAgo(NOW, 60).getTime(),
    };
    const log = [];
    for (let i = 0; i < 60; i++) {
      log.push(logEntry('Meditation', dateKeyOf(daysAgo(NOW, i))));
    }
    const result = computeHabitStrength(rule, log, NOW);
    expect(result.strength).toBe(100);
    expect(result.status).toBe('steady');
    expect(result.band).toBe('strong');
  });

  it('drops strength but stays steady when only yesterday was missed', () => {
    // Daily habit, perfect except yesterday (one lapse, last 3 days
    // status: today=done, yesterday=lapse, 2-days-ago=done).
    // lapsedInLast3 is true, no completions since the lapse from
    // last3's perspective? Let's think: last3 reversed (most recent
    // first) is [today, yesterday, 2d-ago]. firstLapseIdx=1 (yesterday).
    // slice(0,1) is [today], which is completed → recovering.
    // But the habit was logged today, so 'recovering' is correct.
    const rule = {
      id: 'r1',
      title: 'Read',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: daysAgo(NOW, 60).getTime(),
    };
    const log = [];
    for (let i = 0; i < 60; i++) {
      if (i === 1) continue; // skip yesterday
      log.push(logEntry('Read', dateKeyOf(daysAgo(NOW, i))));
    }
    const result = computeHabitStrength(rule, log, NOW);
    expect(result.status).toBe('recovering');
    expect(result.strength).toBeGreaterThanOrEqual(80);
    expect(result.band).toBe('strong');
  });

  it('weights ancient success less than recent failure', () => {
    // Daily habit: perfect for days 14..59 ago, missed every scheduled
    // day in last 14. With half-life 14 the recent zeros dominate but
    // not infinitely — 7 lapsed days only pulls strength to ~55, still
    // well above the faded floor of 40. To exercise the faded branch
    // we extend the lapse window to 14 days, which drops strength to
    // ~28.
    const rule = {
      id: 'r1',
      title: 'Ancient',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: daysAgo(NOW, 60).getTime(),
    };
    const log = [];
    for (let i = 14; i < 60; i++) {
      log.push(logEntry('Ancient', dateKeyOf(daysAgo(NOW, i))));
    }
    const result = computeHabitStrength(rule, log, NOW);
    expect(result.strength).toBeLessThan(40);
    expect(result.status).toBe('faded');
  });

  it('handles M/W/F schedule with perfect adherence', () => {
    // Mon=1, Wed=3, Fri=5. NOW is Monday 2026-05-04. Created 60 days
    // ago → many scheduled days, all completed.
    const rule = {
      id: 'r1',
      title: 'Workout',
      daysOfWeek: [1, 3, 5],
      timesPerDay: 1,
      createdAt: daysAgo(NOW, 60).getTime(),
    };
    const log = [];
    // Walk every day in last 60 and log if it's a M/W/F.
    for (let i = 0; i < 60; i++) {
      const d = daysAgo(NOW, i);
      const dow = d.getDay();
      if (dow === 1 || dow === 3 || dow === 5) {
        log.push(logEntry('Workout', dateKeyOf(d)));
      }
    }
    const result = computeHabitStrength(rule, log, NOW);
    expect(result.strength).toBe(100);
    expect(result.status).toBe('steady');
  });

  it('reports started for a brand-new habit with 3 logs', () => {
    // Daily habit, created 3 days ago → 4 scheduled days (still < 7).
    const rule = {
      id: 'r1',
      title: 'Brand New',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: daysAgo(NOW, 3).getTime(),
    };
    const log = [
      logEntry('Brand New', dateKeyOf(daysAgo(NOW, 0))),
      logEntry('Brand New', dateKeyOf(daysAgo(NOW, 1))),
      logEntry('Brand New', dateKeyOf(daysAgo(NOW, 2))),
    ];
    const result = computeHabitStrength(rule, log, NOW);
    expect(result.status).toBe('started');
    expect(result.strength).toBeNull();
  });

  it('treats partial-day completion as a miss for timesPerDay=2', () => {
    // 2x/day daily habit, last 30 days each have only 1 log → every
    // scheduled day reads as incomplete. Strength should be near 0.
    const rule = {
      id: 'r1',
      title: 'Twice Daily',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 2,
      createdAt: daysAgo(NOW, 60).getTime(),
    };
    const log = [];
    for (let i = 0; i < 60; i++) {
      log.push(logEntry('Twice Daily', dateKeyOf(daysAgo(NOW, i))));
    }
    const result = computeHabitStrength(rule, log, NOW);
    expect(result.strength).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Recovery state machine — one test per state.
// ───────────────────────────────────────────────────────────────────────

describe('computeHabitStrength — recovery states', () => {
  function makeDailyRule() {
    return {
      id: 'r1',
      title: 'Daily',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: daysAgo(NOW, 60).getTime(),
    };
  }

  it('steady when no lapses in last 3 scheduled days', () => {
    const rule = makeDailyRule();
    const log = [];
    for (let i = 0; i < 60; i++) log.push(logEntry('Daily', dateKeyOf(daysAgo(NOW, i))));
    const r = computeHabitStrength(rule, log, NOW);
    expect(r.status).toBe('steady');
  });

  it('at-risk: lapsed today, no later completion', () => {
    // Skip today (i=0). last3 reversed = [today=lapse, yesterday=done,
    // 2d=done]. firstLapseIdx=0; slice(0,0) is empty → no completions
    // since lapse → at-risk.
    const rule = makeDailyRule();
    const log = [];
    for (let i = 1; i < 60; i++) log.push(logEntry('Daily', dateKeyOf(daysAgo(NOW, i))));
    const r = computeHabitStrength(rule, log, NOW);
    expect(r.status).toBe('at-risk');
  });

  it('recovering: lapsed yesterday, logged today', () => {
    // last3 reversed = [today=done, yesterday=lapse, 2d=done].
    // firstLapseIdx=1; slice(0,1)=[today done] → recovering.
    const rule = makeDailyRule();
    const log = [];
    for (let i = 0; i < 60; i++) {
      if (i === 1) continue;
      log.push(logEntry('Daily', dateKeyOf(daysAgo(NOW, i))));
    }
    const r = computeHabitStrength(rule, log, NOW);
    expect(r.status).toBe('recovering');
  });

  it('faded: strength <40 with multi-lapse pattern', () => {
    // Need lapses spanning ~14 days to push strength below the faded
    // floor of 40. Lapse last 14 days, perfect before that.
    const rule = makeDailyRule();
    const log = [];
    for (let i = 14; i < 60; i++) log.push(logEntry('Daily', dateKeyOf(daysAgo(NOW, i))));
    const r = computeHabitStrength(rule, log, NOW);
    expect(r.status).toBe('faded');
    expect(r.strength as number).toBeLessThan(40);
  });

  it('started: too-young habit', () => {
    const rule = {
      ...makeDailyRule(),
      createdAt: daysAgo(NOW, 4).getTime(),
    };
    const r = computeHabitStrength(rule, [], NOW);
    expect(r.status).toBe('started');
  });
});

// ───────────────────────────────────────────────────────────────────────
// computeAnchorAdherence
// ───────────────────────────────────────────────────────────────────────

describe('computeAnchorAdherence', () => {
  const rule = { id: 'r1', title: 'Meditation' };

  it('reports drift: false on tight variance', () => {
    // 7 logs, all within ~30 minutes of 7am.
    const log = [
      logEntry('Meditation', '2026-05-04', 7),
      logEntry('Meditation', '2026-05-03', 7),
      logEntry('Meditation', '2026-05-02', 7),
      logEntry('Meditation', '2026-05-01', 7),
      logEntry('Meditation', '2026-04-30', 7),
      logEntry('Meditation', '2026-04-29', 7),
      logEntry('Meditation', '2026-04-28', 7),
    ];
    const r = computeAnchorAdherence(rule, log);
    expect(r.sampleSize).toBe(7);
    expect(r.drift).toBe(false);
    expect(r.variance).toBeLessThan(2);
  });

  it('reports drift: true on wide variance', () => {
    // 7 logs scattered between 5am and midnight — std dev well above 2h.
    const log = [
      logEntry('Meditation', '2026-05-04', 5),
      logEntry('Meditation', '2026-05-03', 22),
      logEntry('Meditation', '2026-05-02', 7),
      logEntry('Meditation', '2026-05-01', 23),
      logEntry('Meditation', '2026-04-30', 6),
      logEntry('Meditation', '2026-04-29', 21),
      logEntry('Meditation', '2026-04-28', 8),
    ];
    const r = computeAnchorAdherence(rule, log);
    expect(r.sampleSize).toBe(7);
    expect(r.drift).toBe(true);
    expect(r.variance).toBeGreaterThan(2);
  });

  it('reports drift: false when sample size < 5', () => {
    // 4 logs with absurdly wide variance → still false because of the
    // minimum-sample gate.
    const log = [
      logEntry('Meditation', '2026-05-04', 5),
      logEntry('Meditation', '2026-05-03', 22),
      logEntry('Meditation', '2026-05-02', 7),
      logEntry('Meditation', '2026-05-01', 23),
    ];
    const r = computeAnchorAdherence(rule, log);
    expect(r.sampleSize).toBe(4);
    expect(r.drift).toBe(false);
    // Variance is computed but drift is suppressed by sample-size gate.
    expect(r.variance).toBeGreaterThan(2);
  });
});

// ───────────────────────────────────────────────────────────────────────
// DST regression test for the cursor walk in computeHabitProgress
// (originally added on fix/scoring-bugs; preserved here through merge).
//
// Before the fix: the loop advanced via `cursor.setTime(cursor.getTime()
// + DAY_MS)`, which is fragile across DST. On a US machine running in
// US/Pacific, `+86400000` ms shifts time-of-day by an hour after the
// spring-forward boundary, eventually pushing the cursor past endDay
// before processing today. Pre-fix: today silently dropped from the
// scheduled list for any period spanning March 8.
//
// After the fix: cursor advances via `setDate(getDate() + 1)`, which
// preserves local midnight regardless of DST.
// ───────────────────────────────────────────────────────────────────────

describe('computeHabitProgress — DST cursor regression', () => {
  it('includes today on the scheduled list when period spans US spring-forward (March 8 2026)', () => {
    // A user opens Horizons on Monday March 9 2026 to view their
    // weekly review. Period: Mar 2 (prev Mon) through Mar 9 (today),
    // crossing the Mar 8 spring-forward Sunday.
    const periodStart = new Date(2026, 2, 2, 0, 0, 0);   // Mon Mar 2 2026
    const periodEnd = new Date(2026, 2, 9, 23, 59, 59);  // Mon Mar 9 2026
    const todayKey = '2026-03-09';

    // Daily habit, created well before the period.
    const rule = {
      id: 'r1',
      title: 'Meditation',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: new Date(2026, 0, 1).getTime(),
    };

    // Log every scheduled day in the period including today.
    const log = [
      { habitTitle: 'Meditation', dateKey: '2026-03-02' },
      { habitTitle: 'Meditation', dateKey: '2026-03-03' },
      { habitTitle: 'Meditation', dateKey: '2026-03-04' },
      { habitTitle: 'Meditation', dateKey: '2026-03-05' },
      { habitTitle: 'Meditation', dateKey: '2026-03-06' },
      { habitTitle: 'Meditation', dateKey: '2026-03-07' },
      { habitTitle: 'Meditation', dateKey: '2026-03-08' },
      { habitTitle: 'Meditation', dateKey: todayKey },
    ];

    const result = computeHabitProgress(
      rule,
      { start: periodStart, end: periodEnd },
      log,
    );

    // 8 calendar days from Mar 2 through Mar 9 inclusive. Pre-fix this
    // returned 7 because Mar 9 fell off after the cursor hit 01:00 PDT.
    expect(result.expected).toBe(8);
    expect(result.completed).toBe(8);
    expect(result.pct).toBe(100);
    // Streak walks backward from periodEnd, so today must be in the
    // scheduled set or the streak terminates a day early.
    expect(result.streak).toBe(8);
  });

  it('counts the spring-forward Sunday itself as a scheduled day', () => {
    // Sunday-only rule (daysOfWeek: [0]) over a period that contains
    // four Sundays straddling DST: Feb 22, Mar 1, Mar 8 (DST), Mar 15.
    // Logging only Mar 8 lets us confirm it is in the scheduled set:
    // completed === 1 only if Mar 8 was enumerated.
    const periodStart = new Date(2026, 1, 22, 0, 0, 0);   // Sun Feb 22
    const periodEnd = new Date(2026, 2, 15, 23, 59, 59);  // Sun Mar 15
    const rule = {
      id: 'r1',
      title: 'Sunday Reset',
      daysOfWeek: [0],
      timesPerDay: 1,
      createdAt: new Date(2026, 0, 1).getTime(),
    };
    const log = [{ habitTitle: 'Sunday Reset', dateKey: '2026-03-08' }];

    const result = computeHabitProgress(
      rule,
      { start: periodStart, end: periodEnd },
      log,
    );

    expect(result.expected).toBe(4);     // four Sundays in the period
    expect(result.completed).toBe(1);    // only Mar 8 logged
    expect(result.pct).toBe(25);         // 1/4 = 25%
    expect(result.status).toBe('ready');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Lifetime NEW gate — the yoga case.
//
// Previously the NEW gate fired when period-scoped expected < 3, which
// surfaced 'new' for any narrow-window view of an established rule
// (Sunday-only + 4-day window = expected=1). Gate is now lifetime-
// scoped: 'new' only when the rule has < 3 scheduled occurrences from
// createdAt (or epoch for legacy rules without one) through period.end.
// ───────────────────────────────────────────────────────────────────────

describe('computeHabitProgress — lifetime NEW gate', () => {
  it('Sunday-only rule with months of history reads as ready in a 1-Sunday window', () => {
    // The yoga case: Sunday-only rule, created in February, with a
    // dozen Sunday logs. Period covers a single Sunday (May 3 2026 is
    // a Sunday). Period-scoped expected = 1 (would have triggered the
    // old gate). Lifetime scheduled = ~13 Sundays → 'ready'.
    const rule = {
      id: 'r1',
      title: 'Yoga',
      daysOfWeek: [0],
      timesPerDay: 1,
      createdAt: new Date(2026, 1, 1).getTime(), // Feb 1 2026
    };
    // Period: just Sunday May 3 2026.
    const periodStart = new Date(2026, 4, 3, 0, 0, 0);
    const periodEnd = new Date(2026, 4, 3, 23, 59, 59);
    // 13 historical Sunday logs spread across Feb–Apr.
    const log = [
      { habitTitle: 'Yoga', dateKey: '2026-02-01' },
      { habitTitle: 'Yoga', dateKey: '2026-02-08' },
      { habitTitle: 'Yoga', dateKey: '2026-02-15' },
      { habitTitle: 'Yoga', dateKey: '2026-02-22' },
      { habitTitle: 'Yoga', dateKey: '2026-03-01' },
      { habitTitle: 'Yoga', dateKey: '2026-03-08' },
      { habitTitle: 'Yoga', dateKey: '2026-03-15' },
      { habitTitle: 'Yoga', dateKey: '2026-03-22' },
      { habitTitle: 'Yoga', dateKey: '2026-03-29' },
      { habitTitle: 'Yoga', dateKey: '2026-04-05' },
      { habitTitle: 'Yoga', dateKey: '2026-04-12' },
      { habitTitle: 'Yoga', dateKey: '2026-04-19' },
      { habitTitle: 'Yoga', dateKey: '2026-04-26' },
    ];
    const result = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, log);
    expect(result.status).toBe('ready');
    expect(result.expected).toBe(1);
  });

  it('1 lifetime scheduled occurrence reads as new', () => {
    // Daily rule created today (May 4 2026, a Monday). Period: today
    // only. Lifetime occurrences from createdAt through periodEnd =
    // exactly 1. < 3 → 'new'.
    const rule = {
      id: 'r1',
      title: 'Just Started',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: new Date(2026, 4, 4, 0, 0, 0).getTime(),
    };
    const periodStart = new Date(2026, 4, 4, 0, 0, 0);
    const periodEnd = new Date(2026, 4, 4, 23, 59, 59);
    const result = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, []);
    expect(result.status).toBe('new');
    expect(result.pct).toBeNull();
  });

  it('0 lifetime scheduled occurrences reads as new', () => {
    // Wednesday-only rule created on a Monday (May 4 2026). Period:
    // today only. Lifetime walk from Mon to Mon contains zero
    // Wednesdays. Returns 'new' via the empty-scheduledKeys early
    // path.
    const rule = {
      id: 'r1',
      title: 'Wednesday Only',
      daysOfWeek: [3],
      timesPerDay: 1,
      createdAt: new Date(2026, 4, 4, 0, 0, 0).getTime(),
    };
    const periodStart = new Date(2026, 4, 4, 0, 0, 0);
    const periodEnd = new Date(2026, 4, 4, 23, 59, 59);
    const result = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, []);
    expect(result.status).toBe('new');
  });

  it('legacy rule with one completion logged reads as ready', () => {
    // NEX-82: NEW now keys off completion-existence, not lifetime
    // schedule count. A legacy rule (no createdAt) with at least
    // one log entry hits the ready path.
    const rule = {
      id: 'r1',
      title: 'Legacy Daily',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      // No createdAt — undefined.
    };
    const periodStart = new Date(2026, 4, 4, 0, 0, 0);
    const periodEnd = new Date(2026, 4, 4, 23, 59, 59);
    const habitLog = [
      { habitTitle: 'Legacy Daily', dateKey: '2025-12-01' },
    ];
    const result = computeHabitProgress(
      rule,
      { start: periodStart, end: periodEnd },
      habitLog,
    );
    expect(result.status).toBe('ready');
  });

  it('a future-dated log does not flip a brand-new habit to ready (NEX-236)', () => {
    // Brand-new daily habit created today; period = today only. The only log
    // is dated AFTER the period end (a future-dated entry). The lifetime NEW
    // gate must ignore it — the habit still reads 'new', not 'ready'.
    const rule = {
      id: 'r1',
      title: 'Fresh Habit',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: new Date(2026, 4, 4, 0, 0, 0).getTime(),
    };
    const periodStart = new Date(2026, 4, 4, 0, 0, 0);
    const periodEnd = new Date(2026, 4, 4, 23, 59, 59);
    const habitLog = [{ habitTitle: 'Fresh Habit', dateKey: '2026-05-10' }]; // 6 days after periodEnd
    const result = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, habitLog);
    expect(result.status).toBe('new');
    expect(result.pct).toBeNull();
  });

  it('an in-period completion still reads ready (control for the future-log guard)', () => {
    const rule = {
      id: 'r1',
      title: 'Fresh Habit',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1,
      createdAt: new Date(2026, 4, 4, 0, 0, 0).getTime(),
    };
    const periodStart = new Date(2026, 4, 4, 0, 0, 0);
    const periodEnd = new Date(2026, 4, 4, 23, 59, 59);
    const habitLog = [{ habitTitle: 'Fresh Habit', dateKey: '2026-05-04' }]; // logged in-period
    const result = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, habitLog);
    expect(result.status).toBe('ready');
    expect(result.completed).toBe(1);
  });

  it('degenerate window (no scheduled day in range) with prior completions reads ready, not new', () => {
    // The reported bug: a once-weekly Sunday habit reviewed in a window with NO
    // Sunday in it (here Mon May 4 – Sat May 9 2026). scheduledKeys is empty, so
    // the old code returned emptyProgress() → 'new' WITHOUT consulting history —
    // labeling an established habit "NEW". With real prior Sunday completions it
    // must read 'ready' (expected 0, pct null), never 'new'.
    const rule = {
      id: 'r1',
      title: 'Write a weekly love note',
      daysOfWeek: [0], // Sunday only
      timesPerDay: 1,
      createdAt: new Date(2026, 1, 1).getTime(), // Feb 1 2026
    };
    const periodStart = new Date(2026, 4, 4, 0, 0, 0); // Monday
    const periodEnd = new Date(2026, 4, 9, 23, 59, 59); // Saturday (no Sunday in range)
    const habitLog = [
      { habitTitle: 'Write a weekly love note', dateKey: '2026-04-19' },
      { habitTitle: 'Write a weekly love note', dateKey: '2026-04-26' },
    ];
    const result = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, habitLog);
    expect(result.status).toBe('ready');
    expect(result.expected).toBe(0);
    expect(result.pct).toBeNull();
  });

  it('createdAt clamps out the only scheduled Sunday but prior completions keep it ready', () => {
    // Sunday-only rule whose createdAt lands on the Tuesday AFTER the period's
    // only Sunday, so effectiveStart clamps the Sunday out → scheduledKeys empty.
    // A prior Sunday completion (before the clamp) still means "not new".
    const rule = {
      id: 'r1',
      title: 'Sunday Review',
      daysOfWeek: [0],
      timesPerDay: 1,
      createdAt: new Date(2026, 4, 5, 0, 0, 0).getTime(), // Tue May 5 2026
    };
    const periodStart = new Date(2026, 4, 3, 0, 0, 0); // Sun May 3
    const periodEnd = new Date(2026, 4, 9, 23, 59, 59); // Sat May 9
    const habitLog = [{ habitTitle: 'Sunday Review', dateKey: '2026-04-26' }];
    const result = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, habitLog);
    expect(result.status).toBe('ready');
    expect(result.pct).toBeNull();
  });

  it('degenerate window with NO completions still reads new', () => {
    // Same empty-scheduledKeys shape as above but with zero history → still 'new'.
    const rule = {
      id: 'r1',
      title: 'Never Done Weekly',
      daysOfWeek: [0],
      timesPerDay: 1,
      createdAt: new Date(2026, 1, 1).getTime(),
    };
    const periodStart = new Date(2026, 4, 4, 0, 0, 0); // Monday
    const periodEnd = new Date(2026, 4, 9, 23, 59, 59); // Saturday, no Sunday
    const result = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, []);
    expect(result.status).toBe('new');
  });
});

// ───────────────────────────────────────────────────────────────────────
// NEX-190 De-streak — cumulative progress selectors.
// ───────────────────────────────────────────────────────────────────────

describe('computeLifetimeReps', () => {
  const rule = { title: 'Meditate', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timesPerDay: 1 };
  it('counts every matching log entry (by normalized title), off-schedule included', () => {
    const log = [
      { habitTitle: 'meditate', dateKey: '2026-06-01' },
      { habitTitle: 'Meditate', dateKey: '2026-06-02' },
      { habitTitle: 'MEDITATE', dateKey: '2026-06-02' }, // same day, still a rep
      { habitTitle: 'other', dateKey: '2026-06-03' },
    ];
    expect(computeLifetimeReps(rule, log)).toBe(3);
  });
  it('is 0 for no logs / null inputs (cumulative floor)', () => {
    expect(computeLifetimeReps(rule, [])).toBe(0);
    expect(computeLifetimeReps(rule, null)).toBe(0);
    expect(computeLifetimeReps(null, [])).toBe(0);
  });
});

describe('crossedRepMilestone (fires once at the crossing; a miss can never un-fire)', () => {
  it('returns the threshold only when reps land exactly on 7/30/66/365', () => {
    expect(crossedRepMilestone(7)).toBe(7);
    expect(crossedRepMilestone(66)).toBe(66);
    expect(crossedRepMilestone(365)).toBe(365);
  });
  it('returns null off-threshold, so an existing user already past it never re-fires', () => {
    expect(crossedRepMilestone(6)).toBeNull();
    expect(crossedRepMilestone(8)).toBeNull();
    expect(crossedRepMilestone(31)).toBeNull();
    expect(crossedRepMilestone(0)).toBeNull();
  });
});

describe('weeklyProgressLabel (default chip — never a breakable count)', () => {
  it('suppresses the chip for a truly new habit (nothing ever logged)', () => {
    expect(weeklyProgressLabel(0, 7, 0)).toBeUndefined();
  });
  it('shows partial credit "N of T" with a STABLE denominator (intrinsic cadence, not days-elapsed)', () => {
    expect(weeklyProgressLabel(1, 3, 12)).toBe('1 of 3'); // 3×/week → "/3" all week
    expect(weeklyProgressLabel(3, 3, 40)).toBe('3 of 3');
  });
  it('shows open-ended "N× this wk" for a daily-ish cadence (no growing/flipping denominator)', () => {
    expect(weeklyProgressLabel(4, 7, 50)).toBe('4× this wk'); // daily = cadence 7 → never "of 7"
  });
  it('still shows progress this week even when the weekly count is 0 but reps exist (a miss is not a reset)', () => {
    expect(weeklyProgressLabel(0, 7, 88)).toBe('0× this wk');
  });
});

describe('topHabitByReps (NEX-219 widget/watch headline — most lifetime reps, stable order)', () => {
  const log = (title: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ habitTitle: title, dateKey: `2026-06-${String(i + 1).padStart(2, '0')}` }));

  it('picks the rule with the most lifetime reps and returns its RAW title (emoji intact)', () => {
    const rules = [{ id: 'a', title: '🧘 Meditate' }, { id: 'b', title: 'Read' }];
    expect(topHabitByReps(rules, [...log('🧘 Meditate', 5), ...log('Read', 9)])).toEqual({ title: 'Read', reps: 9 });
  });

  it('returns null when no rule has any reps (caller shows an empty state, not "0 reps")', () => {
    expect(topHabitByReps([{ id: 'a', title: 'Walk' }], [])).toBeNull();
  });

  it('ignores rules that have never been logged', () => {
    const rules = [{ id: 'a', title: 'Walk' }, { id: 'b', title: 'Stretch' }];
    expect(topHabitByReps(rules, log('Stretch', 3))).toEqual({ title: 'Stretch', reps: 3 });
  });

  it('breaks rep ties by normalized title asc (not array order)', () => {
    const rules = [{ id: 'z', title: 'Banana' }, { id: 'a', title: 'Apple' }];
    expect(topHabitByReps(rules, [...log('Banana', 4), ...log('Apple', 4)])).toEqual({ title: 'Apple', reps: 4 });
  });

  it('on equal reps AND equal normalized title, breaks by id asc', () => {
    // Both titles normalize to "focus", so computeLifetimeReps reports 4 for each;
    // tie → id 'a' < 'b' wins, returning that rule's raw title.
    const rules = [{ id: 'b', title: 'Focus' }, { id: 'a', title: 'focus' }];
    expect(topHabitByReps(rules, [...log('Focus', 2), ...log('focus', 2)])).toEqual({ title: 'focus', reps: 4 });
  });
});

describe('computeHabitProgress — NEX-207 pause exclusion', () => {
  it('drops paused days from expected so they never read as missed', () => {
    const periodStart = new Date(2026, 2, 2, 0, 0, 0);   // Mon Mar 2 2026
    const periodEnd = new Date(2026, 2, 9, 23, 59, 59);  // Mon Mar 9 2026 (8 days)
    const rule = {
      id: 'r1', title: 'Meditation', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timesPerDay: 1, createdAt: new Date(2026, 0, 1).getTime(),
    };
    // Nothing logged. Without pause: expected 8, missed 8.
    const noPause = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, []);
    expect(noPause.expected).toBe(8);

    // Paused since Mar 5 → Mar 5..9 (5 days) excluded → only Mar 2,3,4 expected.
    const pauseMode = { active: true, since: '2026-03-05', plannedUntil: null, history: [] };
    const paused = computeHabitProgress(rule, { start: periodStart, end: periodEnd }, [], pauseMode as any);
    expect(paused.expected).toBe(3);
    expect(paused.completed).toBe(0);
  });
});

describe('computeWeeklyReps — NEX §1.5 Law B: paused-day reps still count', () => {
  // Prod repro: today Tue 2026-06-30, week starts Sun 2026-06-28.
  // Pause history covers Sat 06-27..Sun 06-28 and Mon 06-29 — so both Sun and Mon
  // are paused days, yet the user completed the habit on both.
  const periodStart = new Date(2026, 5, 28, 0, 0, 0);   // Sun Jun 28 2026
  const periodEnd = new Date(2026, 5, 30, 12, 0, 0);    // Tue Jun 30 2026 (today, noon)
  const pauseMode = {
    active: false,
    since: null,
    plannedUntil: null,
    history: [
      { since: '2026-06-27', endedOn: '2026-06-28' },
      { since: '2026-06-29', endedOn: '2026-06-29' },
    ],
  };
  const dailyRule = {
    id: 'r1', title: 'clean eating', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    timesPerDay: 2, createdAt: new Date(2026, 0, 1).getTime(),
  };

  it('counts completions logged on paused days toward the weekly chip (the fix)', () => {
    // ×2 on Sun 06-28 (paused) and ×2 on Mon 06-29 (paused); nothing logged today.
    const habitLog = [
      logEntry('clean eating', '2026-06-28', 9), logEntry('clean eating', '2026-06-28', 21),
      logEntry('clean eating', '2026-06-29', 9), logEntry('clean eating', '2026-06-29', 21),
    ];
    // computeWeeklyReps ignores pause → all 4 earned reps count (2 + 2 + 0 today).
    expect(computeWeeklyReps(dailyRule, { start: periodStart, end: periodEnd }, habitLog)).toBe(4);
    // The bug being fixed: computeHabitProgress drops the two paused days from
    // `completed`, collapsing the chip numerator to today-only (0).
    const wk = computeHabitProgress(dailyRule, { start: periodStart, end: periodEnd }, habitLog, pauseMode as any);
    expect(wk.completed).toBe(0);
  });

  it('accumulates across multiple paused scheduled days, capped per day at timesPerDay', () => {
    // 3 logs on the paused Mon 06-29 with timesPerDay 2 → counts 2, not 3 (no
    // double-count); plus 1 on the paused Sun 06-28 → 3 total.
    const habitLog = [
      logEntry('clean eating', '2026-06-28', 9),
      logEntry('clean eating', '2026-06-29', 8),
      logEntry('clean eating', '2026-06-29', 13),
      logEntry('clean eating', '2026-06-29', 20),
    ];
    expect(computeWeeklyReps(dailyRule, { start: periodStart, end: periodEnd }, habitLog)).toBe(3);
  });

  it('numerator never exceeds the cadencePerWeek denominator, even fully logged incl. paused days', () => {
    // Every scheduled day in-window (Sun/Mon/Tue) logged twice, incl. the paused ones.
    const keys = ['2026-06-28', '2026-06-29', '2026-06-30'];
    const habitLog = keys.flatMap((k) => [logEntry('clean eating', k, 8), logEntry('clean eating', k, 20)]);
    const reps = computeWeeklyReps(dailyRule, { start: periodStart, end: periodEnd }, habitLog);
    const cadencePerWeek = dailyRule.daysOfWeek.length * dailyRule.timesPerDay; // 14
    expect(reps).toBeLessThanOrEqual(cadencePerWeek);
    expect(reps).toBe(6); // 3 in-window scheduled days × 2/day
  });

  it('keeps the "N of T" chip numerator ≤ denominator for a few-times-a-week cadence', () => {
    // Sun/Mon/Tue habit, 1×/day → cadence 3 (the "N of T" label path). Full window
    // logging incl. the two paused days still yields N ≤ T.
    const threeDay = { ...dailyRule, daysOfWeek: [0, 1, 2], timesPerDay: 1 };
    const habitLog = ['2026-06-28', '2026-06-29', '2026-06-30'].map((k) => logEntry('clean eating', k));
    const reps = computeWeeklyReps(threeDay, { start: periodStart, end: periodEnd }, habitLog);
    const cadencePerWeek = threeDay.daysOfWeek.length * threeDay.timesPerDay; // 3
    expect(reps).toBeLessThanOrEqual(cadencePerWeek);
    expect(weeklyProgressLabel(reps, cadencePerWeek, 10)).toBe('3 of 3');
  });

  it('clamps to createdAt — reps logged before the habit existed are not counted', () => {
    const createdMon = { ...dailyRule, createdAt: new Date(2026, 5, 29, 0, 0, 0).getTime() }; // created Mon 06-29
    const habitLog = [
      logEntry('clean eating', '2026-06-28', 9), // before createdAt → not in scheduled window
      logEntry('clean eating', '2026-06-29', 9),
    ];
    expect(computeWeeklyReps(createdMon, { start: periodStart, end: periodEnd }, habitLog)).toBe(1);
  });

  it('returns 0 for an empty schedule and ignores off-schedule logs', () => {
    const noDays = { ...dailyRule, daysOfWeek: [] };
    expect(
      computeWeeklyReps(noDays, { start: periodStart, end: periodEnd }, [logEntry('clean eating', '2026-06-29')]),
    ).toBe(0);

    // Mon/Wed/Fri rule: a Sunday (06-28) log is off-schedule → ignored; Monday counts.
    const mwf = { ...dailyRule, daysOfWeek: [1, 3, 5], timesPerDay: 1 };
    expect(
      computeWeeklyReps(mwf, { start: periodStart, end: periodEnd }, [
        logEntry('clean eating', '2026-06-28'), // Sunday — not scheduled
        logEntry('clean eating', '2026-06-29'), // Monday — scheduled
      ]),
    ).toBe(1);
  });

  it('regression: computeHabitProgress still EXCLUDES paused days from the % denominator', () => {
    // Same repro window — paused Sun 06-28 and Mon 06-29 are neither expected nor
    // missed; only the active Tue 06-30 contributes to the percentage surfaces.
    const wk = computeHabitProgress(dailyRule, { start: periodStart, end: periodEnd }, [], pauseMode as any);
    expect(wk.expected).toBe(2); // only Tue 06-30 scheduled & active, × timesPerDay 2
    expect(wk.completed).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// computeRowRollups — single-pass fold of computeWeeklyReps +
// computeLifetimeReps (Home habit-row chip rollup). Must be identical to
// calling the two per-rule selectors independently.
// ───────────────────────────────────────────────────────────────────────

describe('computeRowRollups (single-pass fold — identical to per-rule selectors)', () => {
  const periodStart = new Date(2026, 5, 28, 0, 0, 0);   // Sun Jun 28 2026
  const periodEnd = new Date(2026, 5, 30, 12, 0, 0);    // Tue Jun 30 2026 (today, noon)
  const period = { start: periodStart, end: periodEnd };

  const daily2x = {
    id: 'r1', title: 'clean eating', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    timesPerDay: 2, createdAt: new Date(2026, 0, 1).getTime(),
  };
  const mwf = {
    id: 'r2', title: 'Run', daysOfWeek: [1, 3, 5],
    timesPerDay: 1, createdAt: new Date(2026, 0, 1).getTime(),
  };
  // Same normalized title as mwf — both rules must tally the same logs,
  // exactly as two independent selector calls would.
  const mwfTwin = { id: 'r3', title: 'run', daysOfWeek: [1, 3, 5], timesPerDay: 1 };
  const noDays = { id: 'r4', title: 'Unscheduled', daysOfWeek: [], timesPerDay: 1 };
  const createdToday = {
    id: 'r5', title: 'New Habit', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    timesPerDay: 1, createdAt: new Date(2026, 5, 30, 9, 0, 0).getTime(),
  };

  const habitLog = [
    logEntry('clean eating', '2026-06-28', 9), logEntry('clean eating', '2026-06-28', 21),
    logEntry('clean eating', '2026-06-29', 9), logEntry('clean eating', '2026-06-29', 13),
    logEntry('clean eating', '2026-06-29', 20), // 3rd same-day log — capped at timesPerDay
    logEntry('clean eating', '2026-05-01', 9),  // out-of-window — lifetime only
    logEntry('Run', '2026-06-29', 7),           // Mon — scheduled for mwf + twin
    logEntry('Run', '2026-06-30', 7),           // Tue — off-schedule — lifetime only
    logEntry('Run 🏃', '2026-06-29', 8),         // emoji-sensitive key — matches NO rule
    logEntry('New Habit', '2026-06-28', 9),     // before createdAt — lifetime only
    logEntry('New Habit', '2026-06-30', 10),    // on/after createdAt — both tallies
    { habitTitle: 'clean eating', timestamp: 1 }, // no dateKey — lifetime only
  ];

  it('matches computeWeeklyReps + computeLifetimeReps per rule, including edge rules', () => {
    const rules = [daily2x, mwf, mwfTwin, noDays, createdToday, null, undefined];
    const rollups = computeRowRollups(rules, period, habitLog);
    expect(rollups.length).toBe(rules.length);
    rules.forEach((rule, i) => {
      expect(rollups[i].weeklyReps).toBe(computeWeeklyReps(rule, period, habitLog));
      expect(rollups[i].lifetimeReps).toBe(computeLifetimeReps(rule, habitLog));
    });
  });

  it('handles empty / null inputs like the per-rule selectors', () => {
    expect(computeRowRollups([], period, habitLog)).toEqual([]);
    expect(computeRowRollups(null, period, habitLog)).toEqual([]);
    expect(computeRowRollups([daily2x], period, null)).toEqual([{ weeklyReps: 0, lifetimeReps: 0 }]);
    expect(computeRowRollups([daily2x], period, undefined)).toEqual([{ weeklyReps: 0, lifetimeReps: 0 }]);
  });

  it('produces the same chip labels as the unfolded per-rule pipeline', () => {
    const rules = [daily2x, mwf, mwfTwin, noDays, createdToday];
    const rollups = computeRowRollups(rules, period, habitLog);
    rules.forEach((rule, i) => {
      const cadencePerWeek = rule.daysOfWeek.length * (rule.timesPerDay || 1);
      const folded = weeklyProgressLabel(rollups[i].weeklyReps, cadencePerWeek, rollups[i].lifetimeReps);
      const unfolded = weeklyProgressLabel(
        computeWeeklyReps(rule, period, habitLog),
        cadencePerWeek,
        computeLifetimeReps(rule, habitLog),
      );
      expect(folded).toBe(unfolded);
    });
  });
});
