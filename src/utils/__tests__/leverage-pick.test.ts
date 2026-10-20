import { describe, it, expect } from 'vitest';
import { computeLeveragePick } from '../leverage';

const DAY_MS = 86400000;
const NOW = new Date(2026, 4, 4, 12, 0, 0); // Mon 2026-05-04

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}
function logEntry(habitTitle: string, dateKey: string, hour = 9) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return { habitTitle, dateKey, timestamp: new Date(y, m - 1, d, hour, 0, 0).getTime() };
}

// Helper: build a daily rule with a given history of perfect logs.
function dailyRule(id: string, title: string, ageDays: number, anchor: string | null = null) {
  return {
    id,
    title,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    timesPerDay: 1,
    createdAt: daysAgo(ageDays).getTime(),
    anchor,
  };
}

function perfectLogs(title: string, fromDaysAgo: number, toDaysAgo: number, hour = 9) {
  const out: ReturnType<typeof logEntry>[] = [];
  for (let i = toDaysAgo; i <= fromDaysAgo; i++) {
    out.push(logEntry(title, dateKeyOf(daysAgo(i)), hour));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────

describe('computeLeveragePick', () => {
  it('returns null when user has zero habits', () => {
    const result = computeLeveragePick({
      recurringRules: [],
      habitLog: [],
      pillars: [],
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('rank 1: at-risk-strong wins when historically strong habit is slipping', () => {
    // Yoga: perfect days 31-60 ago (historical strength = 100), but
    // every scheduled day in last 7 missed → currently at-risk/faded.
    // Filler: a steady habit so the picker has options.
    const yoga = dailyRule('y1', 'Yoga', 90);
    const meditation = dailyRule('m1', 'Meditation', 90);
    const log = [
      ...perfectLogs('Yoga', 60, 7),  // perfect days 7..60 ago
      ...perfectLogs('Meditation', 60, 0), // perfect every day for 60d
    ];
    const result = computeLeveragePick({
      recurringRules: [yoga, meditation],
      habitLog: log,
      pillars: [],
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.rank).toBe('at-risk-strong');
    expect(result?.habitTitle).toBe('Yoga');
    expect(result?.reason).toContain('slipping');
  });

  it('rank 2: anchor-drift fires when no at-risk-strong and a top-3 habit drifts', () => {
    // Reading: anchor set, drifts wildly between 5am and 11pm. Strong
    // strength so it lands in top 3.
    // Walking: anchor set, tight time. Strong.
    // Workout: no anchor. Strong.
    const reading = dailyRule('r1', 'Reading', 90, 'After morning coffee');
    const walking = dailyRule('w1', 'Walking', 90, 'After lunch');
    const workout = dailyRule('o1', 'Workout', 90, null);

    const driftLog: ReturnType<typeof logEntry>[] = [];
    // 14 reading logs scattered hour 5..23.
    const hours = [5, 22, 6, 23, 7, 21, 8, 20, 9, 19, 10, 18, 11, 17];
    for (let i = 0; i < hours.length; i++) {
      driftLog.push(logEntry('Reading', dateKeyOf(daysAgo(i)), hours[i]));
    }
    // Fill rest of reading history with morning logs so strength is high.
    for (let i = hours.length; i < 60; i++) {
      driftLog.push(logEntry('Reading', dateKeyOf(daysAgo(i)), 7));
    }
    // Walking: tight 13:00 every day.
    for (let i = 0; i < 60; i++) {
      driftLog.push(logEntry('Walking', dateKeyOf(daysAgo(i)), 13));
    }
    // Workout: tight 17:00 every day.
    for (let i = 0; i < 60; i++) {
      driftLog.push(logEntry('Workout', dateKeyOf(daysAgo(i)), 17));
    }

    const result = computeLeveragePick({
      recurringRules: [reading, walking, workout],
      habitLog: driftLog,
      pillars: [],
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.rank).toBe('anchor-drift');
    expect(result?.habitTitle).toBe('Reading');
    expect(result?.reason).toContain('After morning coffee');
  });

  it('rank 3: mandate-weak fires when no at-risk-strong / anchor-drift', () => {
    // No anchors set, no at-risk-strong. Two habits both linked to the
    // #1 mandate; the lower-strength one wins.
    // Meditation: 100% (strong, linked).
    // Reading: ~60% (building, linked, weakest of the linked pair).
    // Walking: 100% (not linked).
    const meditation = dailyRule('m1', 'Meditation', 90);
    const reading = dailyRule('r1', 'Reading', 90);
    const walking = dailyRule('w1', 'Walking', 90);

    const log: ReturnType<typeof logEntry>[] = [];
    for (let i = 0; i < 60; i++) {
      log.push(logEntry('Meditation', dateKeyOf(daysAgo(i))));
      log.push(logEntry('Walking', dateKeyOf(daysAgo(i))));
      // Reading: skip every 3rd day → strength roughly 67%.
      if (i % 3 !== 0) log.push(logEntry('Reading', dateKeyOf(daysAgo(i))));
    }

    const result = computeLeveragePick({
      recurringRules: [meditation, reading, walking],
      habitLog: log,
      pillars: [{ id: 'p1', title: 'Vision' }],
      goalHabitMap: {
        meditation: ['p1'],
        reading: ['p1'],
      },
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.rank).toBe('mandate-weak');
    expect(result?.habitTitle).toBe('Reading');
    expect(result?.reason).toContain('Vision');
  });

  it('rank 4: default fires when no other rank matches', () => {
    // No at-risk-strong, no anchor-drift, no mandate links.
    // Two habits, both with streak ≥3, varying strength. Picker takes
    // the lower-strength one.
    const strong = dailyRule('a1', 'Strong', 90);
    const weak = dailyRule('a2', 'Weak', 90);

    const log: ReturnType<typeof logEntry>[] = [];
    // Strong: perfect.
    for (let i = 0; i < 60; i++) log.push(logEntry('Strong', dateKeyOf(daysAgo(i))));
    // Weak: skip every other day → ~50% strength, but no recent-3 lapse:
    // we need streak ≥3 AND not at-risk. Easier to keep last 3 done and
    // alternate on older days.
    for (let i = 0; i < 3; i++) log.push(logEntry('Weak', dateKeyOf(daysAgo(i))));
    for (let i = 4; i < 60; i += 2) log.push(logEntry('Weak', dateKeyOf(daysAgo(i))));

    const result = computeLeveragePick({
      recurringRules: [strong, weak],
      habitLog: log,
      habitStreaks: { strong: 60, weak: 3 },
      pillars: [],
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.rank).toBe('default');
    expect(result?.habitTitle).toBe('Weak');
  });

  it('returns null when no rank matches (no streaks ≥3, no other signals)', () => {
    // Single habit, started state (too young), no streak.
    const baby = dailyRule('b1', 'Baby', 2);
    const log = [
      logEntry('Baby', dateKeyOf(daysAgo(0))),
      logEntry('Baby', dateKeyOf(daysAgo(1))),
    ];
    const result = computeLeveragePick({
      recurringRules: [baby],
      habitLog: log,
      habitStreaks: { baby: 2 },
      pillars: [],
      now: NOW,
    });
    expect(result).toBeNull();
  });
});
