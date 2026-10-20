import { describe, it, expect } from 'vitest';
// The weekly-summary email template lives in the Deno edge-function tree but is a
// self-contained module (no Deno/RN imports), so its pure functions are unit-testable
// here. NEX-192 / §1.5 Laws B & C: the delivered email must never surface a breakable
// consecutive-day streak count or any absence/shame framing.
import {
  buildWeeklySummaryHtml,
  weeklySummarySubject,
  type WeeklySummaryPayload,
} from '../../../supabase/functions/_shared/weekly-summary-email';

function makePayload(overrides: Partial<WeeklySummaryPayload> = {}): WeeklySummaryPayload {
  return {
    userEmail: 'a@b.com',
    userName: 'Sam',
    weekLabel: 'Jun 9 – Jun 15',
    habitsCompleted: 17,
    habitsMissed: 4,
    completionRate: 81,
    topStreaks: [
      { habit: 'Meditation', days: 18 },
      { habit: 'Reading', days: 5 },
    ],
    longestStreakDays: 18,
    longestStreakHabit: 'Meditation',
    disciplineScoreAvg: 74,
    motivationalTip: 'Lean on the structure.',
    appUrl: 'https://nexus.app',
    ...overrides,
  };
}

describe('weeklySummarySubject (NEX-192)', () => {
  it('does not render a consecutive-day streak count', () => {
    const subject = weeklySummarySubject(makePayload());
    expect(subject).not.toMatch(/\d+\s*-?\s*day streak/i);
    expect(subject.toLowerCase()).not.toContain('streak');
  });

  it('surfaces cumulative reps (forward-looking) instead', () => {
    const subject = weeklySummarySubject(makePayload({ habitsCompleted: 17 }));
    expect(subject).toContain('17 reps');
    expect(subject).toContain('81% completion');
  });
});

describe('buildWeeklySummaryHtml (NEX-192)', () => {
  const html = buildWeeklySummaryHtml(makePayload());

  it('drops the consecutive-day streak surfaces (TOP STREAK / ACTIVE STREAKS)', () => {
    expect(html).not.toContain('TOP STREAK');
    expect(html).not.toContain('ACTIVE STREAKS');
  });

  it('never renders a per-habit day count', () => {
    // The old template emitted "${s.days} days" rows. A miss zeroes nothing earned,
    // so no consecutive-day number is shown.
    expect(html).not.toMatch(/\d+\s*days/i);
    expect(html).not.toContain('18'); // the longest-streak day count must not leak
  });

  it('does not surface a "Missed" execution row (no absence-counting)', () => {
    expect(html).not.toContain('Missed');
  });

  it('still names the habits the user leans on (cumulative framing)', () => {
    expect(html).toContain('Meditation');
    expect(html).toContain('Reading');
    expect(html).toContain('REPS THIS WEEK');
  });

  it('keeps the forward-looking, non-shame voice', () => {
    expect(html.toLowerCase()).not.toContain('broke');
    expect(html.toLowerCase()).not.toContain("don't break");
    expect(html).not.toContain('days ago');
  });
});
