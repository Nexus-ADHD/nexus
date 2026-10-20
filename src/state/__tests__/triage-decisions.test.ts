import { describe, it, expect } from 'vitest';
import {
  applyTriageDecision,
  endOfWeekISO,
  humanTodayISO,
  type TriageDecision,
} from '../triage-decisions';

const APPLE_ITEM = {
  id: 'inbox-1',
  source: 'apple_reminders' as const,
  externalId: 'EVENTKIT-1',
};

const MANUAL_ITEM = {
  id: 'inbox-1',
  source: 'manual' as const,
};

// Wednesday May 6, 2026 at 10:00 local time. Wednesday is a useful
// fixture: the upcoming Sunday is genuinely four days away, so a bug
// in the daysUntilSunday math would surface as the wrong dueDate.
function wednesday(): Date {
  return new Date(2026, 4, 6, 10, 0, 0, 0); // months are 0-indexed
}

function sunday(): Date {
  return new Date(2026, 4, 10, 14, 0, 0, 0);
}

describe('applyTriageDecision — Today', () => {
  it('returns local patch + remoteUpdate with humane today ISO', () => {
    // Wednesday at 10am sits in the mid-day band, so the heuristic
    // is now+2h rounded up to the next :30 → noon.
    const today = wednesday();
    const patch = applyTriageDecision(APPLE_ITEM, 'today', today);
    expect(patch.local.dueDate).toBe(humanTodayISO(today));
    expect(patch.remoteUpdate?.dueDate).toBe(humanTodayISO(today));
  });

  it('always issues a remote update, even if existing dueDate already matches today (idempotent)', () => {
    // Simulate an item that already had a today-ish dueDate; the
    // helper should still produce a remoteUpdate so external state
    // converges (and the user's tap feels like it did something).
    const today = wednesday();
    const item = {
      ...APPLE_ITEM,
      dueDate: today.toISOString(),
    };
    const patch = applyTriageDecision(item, 'today', today);
    expect(patch.remoteUpdate).toBeDefined();
    expect(patch.remoteUpdate?.dueDate).toBeTruthy();
  });
});

describe('applyTriageDecision — This week', () => {
  it('returns local patch + remoteUpdate with upcoming Sunday ISO', () => {
    const patch = applyTriageDecision(APPLE_ITEM, 'this_week', wednesday());
    expect(patch.local.dueDate).toBe(endOfWeekISO(wednesday()));
    expect(patch.remoteUpdate?.dueDate).toBe(endOfWeekISO(wednesday()));
  });
});

describe('applyTriageDecision — Later', () => {
  it('returns no patch and no remote update (item stays as-is)', () => {
    const patch = applyTriageDecision(APPLE_ITEM, 'later', wednesday());
    expect(patch.local).toEqual({});
    expect(patch.remoteUpdate).toBeUndefined();
  });
});

describe('applyTriageDecision — Skip', () => {
  it('sets triagedSkip locally, no remote update', () => {
    const patch = applyTriageDecision(APPLE_ITEM, 'skip', wednesday());
    expect(patch.local.triagedSkip).toBe(true);
    expect(patch.local.dueDate).toBeUndefined();
    expect(patch.remoteUpdate).toBeUndefined();
  });
});

describe('applyTriageDecision — manual items', () => {
  it('throws when called on a manual-source item (defensive)', () => {
    const decisions: TriageDecision[] = ['today', 'this_week', 'later', 'skip'];
    for (const d of decisions) {
      expect(() => applyTriageDecision(MANUAL_ITEM as any, d, wednesday())).toThrow(
        /apple_reminders/i,
      );
    }
  });
});

describe('humanTodayISO', () => {
  it('before 9 AM → today at 9 AM', () => {
    const now = new Date(2026, 4, 6, 7, 15, 0, 0); // Wed 7:15 AM
    const iso = humanTodayISO(now);
    const d = new Date(iso);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(now.getDate());
  });

  it('mid-day → now + 2h, rounded UP to next :30 (or :00 if past :30)', () => {
    // 14:00 (2pm) → +2h = 16:00 exactly → stays at 16:00.
    const at2pm = new Date(2026, 4, 6, 14, 0, 0, 0);
    const iso2 = humanTodayISO(at2pm);
    const d2 = new Date(iso2);
    expect(d2.getHours()).toBe(16);
    expect(d2.getMinutes()).toBe(0);
    // 14:10 → +2h = 16:10 → rounds up to 16:30.
    const at210 = new Date(2026, 4, 6, 14, 10, 0, 0);
    const iso3 = humanTodayISO(at210);
    const d3 = new Date(iso3);
    expect(d3.getHours()).toBe(16);
    expect(d3.getMinutes()).toBe(30);
    // 14:45 → +2h = 16:45 → rounds up to 17:00.
    const at245 = new Date(2026, 4, 6, 14, 45, 0, 0);
    const iso4 = humanTodayISO(at245);
    const d4 = new Date(iso4);
    expect(d4.getHours()).toBe(17);
    expect(d4.getMinutes()).toBe(0);
  });

  it('after 9 PM → today at 23:59 (preserve "today" semantics when it is genuinely late)', () => {
    const now = new Date(2026, 4, 6, 22, 30, 0, 0); // Wed 10:30 PM
    const iso = humanTodayISO(now);
    const d = new Date(iso);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getDate()).toBe(now.getDate());
  });
});

describe('endOfWeekISO', () => {
  it('Wednesday → upcoming Sunday at 23:59 local', () => {
    const wed = wednesday(); // May 6, 2026
    const iso = endOfWeekISO(wed);
    const d = new Date(iso);
    expect(d.getDay()).toBe(0); // Sunday
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    // Should be 4 calendar-day-boundaries away (Wed→Sun). Compare
    // by floor of (ms diff / 86400000) so the 13h59m time-of-day
    // offset doesn't push the count to 5.
    const diffDays = Math.floor((d.getTime() - wed.getTime()) / 86400000);
    expect(diffDays).toBe(4);
  });

  it('Sunday → SAME day at 23:59 (not next week)', () => {
    const sun = sunday(); // May 10, 2026 at 14:00
    const iso = endOfWeekISO(sun);
    const d = new Date(iso);
    expect(d.getDay()).toBe(0); // still Sunday
    expect(d.getDate()).toBe(sun.getDate()); // same calendar day
    expect(d.getMonth()).toBe(sun.getMonth());
    expect(d.getFullYear()).toBe(sun.getFullYear());
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
  });
});
