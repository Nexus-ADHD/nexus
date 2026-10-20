import { describe, it, expect } from 'vitest';
import {
  trimWidgetPayload,
  localDateKey,
  INBOX_CAP,
  hasRenderableWidgetContent,
  pickWidgetQuote,
  WIDGET_QUOTE_MAX_CHARS,
} from '../widget-payload-trim';
import type { RawWidgetData } from '../widget-bridge';

const NOW = new Date(2026, 5, 22, 9, 0, 0); // 2026-06-22 local, 9am
const TODAY = '2026-06-22';
const YESTERDAY = '2026-06-21';
const TOMORROW = '2026-06-23';

function base(over: Partial<RawWidgetData> = {}): RawWidgetData {
  return {
    recurringRules: [],
    habitLog: [],
    pinnedHabits: [],
    recurringToDos: [],
    dailyTasks: {},
    inbox: [],
    events: [],
    habitStreaks: {},
    softMode: false,
    totalXP: 0,
    level: 1,
    morningIntention: null,
    morningIntentionDate: null,
    dailyQuote: null,
    dailyWisdomDate: '',
    lastUpdated: 0,
    ...over,
  };
}

describe('localDateKey', () => {
  it('formats local YYYY-MM-DD', () => {
    expect(localDateKey(NOW)).toBe(TODAY);
    expect(localDateKey(new Date(2026, 0, 3))).toBe('2026-01-03'); // zero-padding
  });
});

describe('trimWidgetPayload — habitLog', () => {
  it('keeps only today\'s entries, dropping all history', () => {
    const data = base({
      habitLog: [
        { date: YESTERDAY, habitTitle: 'Meditation' },
        { date: TODAY, habitTitle: 'Meditation' },
        { date: TODAY, habitTitle: 'Exercise' },
        { date: '2025-01-01', habitTitle: 'Meditation' },
      ],
    });
    const out = trimWidgetPayload(data, NOW);
    expect(out.habitLog).toEqual([
      { date: TODAY, habitTitle: 'Meditation' },
      { date: TODAY, habitTitle: 'Exercise' },
    ]);
  });
});

describe('trimWidgetPayload — dailyTasks', () => {
  it('keeps only today + tomorrow, dropping past AND far-future backlog', () => {
    const data = base({
      dailyTasks: {
        [YESTERDAY]: [{ title: 'old', completed: false }],
        [TODAY]: [{ title: 'now', completed: false }],
        [TOMORROW]: [{ title: 'soon', completed: false }],
        '2026-12-25': [{ title: 'far-future planned', completed: false }],
        '2025-06-01': [{ title: 'ancient', completed: true }],
      },
    });
    const out = trimWidgetPayload(data, NOW);
    expect(Object.keys(out.dailyTasks).sort()).toEqual([TODAY, TOMORROW]);
  });

  it('at 23:59 keeps tomorrow\'s key so the midnight rollover entry still resolves', () => {
    const lateNight = new Date(2026, 5, 22, 23, 59, 0); // 2026-06-22 23:59 local
    const data = base({
      dailyTasks: {
        [YESTERDAY]: [{ title: 'old', completed: false }],
        [TODAY]: [{ title: 'now', completed: false }],
        [TOMORROW]: [{ title: 'rollover', completed: false }],
      },
      habitLog: [
        { date: TODAY, habitTitle: 'A' },
        { date: TOMORROW, habitTitle: 'B' }, // not yet "today" — dropped
      ],
    });
    const out = trimWidgetPayload(data, lateNight);
    expect(Object.keys(out.dailyTasks).sort()).toEqual([TODAY, TOMORROW]);
    expect(out.habitLog).toEqual([{ date: TODAY, habitTitle: 'A' }]);
  });
});

describe('trimWidgetPayload — inbox', () => {
  it('keeps pending only, mirroring Swift (!completed && status != ARCHIVED)', () => {
    const data = base({
      inbox: [
        { title: 'pending', completed: false },
        { title: 'done', completed: true },
        { title: 'archived', completed: false, status: 'ARCHIVED' },
        { title: 'active-status', completed: false, status: 'INBOX' },
      ],
    });
    const out = trimWidgetPayload(data, NOW);
    expect(out.inbox.map((i) => i.title)).toEqual(['pending', 'active-status']);
  });

  it('caps to INBOX_CAP, preserving the first-N array order Swift relies on', () => {
    const inbox = Array.from({ length: 50 }, (_, n) => ({ title: `t${n}`, completed: false }));
    const out = trimWidgetPayload(base({ inbox }), NOW);
    expect(out.inbox).toHaveLength(INBOX_CAP);
    expect(out.inbox[0].title).toBe('t0');
    expect(out.inbox[INBOX_CAP - 1].title).toBe(`t${INBOX_CAP - 1}`);
  });

  it('drops triagedSkip items (the app hides them from the active inbox)', () => {
    const data = base({
      inbox: [
        { title: 'skip', completed: false, triagedSkip: true },
        { title: 'pending', completed: false },
      ],
    });
    expect(trimWidgetPayload(data, NOW).inbox.map((i) => i.title)).toEqual(['pending']);
  });

  it('leading skipped items do not crowd out real pending work past the cap', () => {
    // T-Rex repro: 4 skipped items ahead of 12 real pending → the 4 skips must
    // not consume cap slots and hide real pending items.
    const inbox = [
      ...Array.from({ length: 4 }, (_, n) => ({ title: `skip${n}`, completed: false, triagedSkip: true })),
      ...Array.from({ length: 12 }, (_, n) => ({ title: `pending${n}`, completed: false })),
    ];
    const out = trimWidgetPayload(base({ inbox }), NOW);
    expect(out.inbox).toHaveLength(INBOX_CAP);
    expect(out.inbox.every((i) => i.title.startsWith('pending'))).toBe(true);
    expect(out.inbox[0].title).toBe('pending0');
  });
});

describe('trimWidgetPayload — untouched fields', () => {
  it('leaves recurringRules (and pre-computed reps) and events unchanged', () => {
    const recurringRules = [
      { id: 'a', title: 'Meditation', timesPerDay: 1, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], archived: false, reps: 412, excludedFromScore: false },
    ];
    const events = [
      { title: 'Standup', startISO: '2026-06-22T15:00:00.000Z' },
      { title: 'Dinner', startISO: '2026-06-25T01:00:00.000Z' },
    ];
    const data = base({
      recurringRules,
      events,
      // a long historical log — reps must NOT collapse to today's count
      habitLog: Array.from({ length: 500 }, () => ({ date: '2025-03-01', habitTitle: 'Meditation' })),
    });
    const out = trimWidgetPayload(data, NOW);
    expect(out.recurringRules).toEqual(recurringRules);
    expect(out.recurringRules[0].reps).toBe(412);
    expect(out.events).toEqual(events);
    expect(out.habitLog).toEqual([]); // all 500 were historical
  });

  it('keeps recurringToDos.exceptions for today/tomorrow and drops the rest (NEX-306)', () => {
    // `exceptions` is APPEND-ONLY in the app (addRecurringToDoException never
    // prunes), so a long-term user accumulates one dateKey per skip forever.
    // Swift only asks `contains(todayKey)` and the timeline reaches tomorrow,
    // so anything else is pure payload bloat — the exact class this module
    // exists to prevent.
    const oldKeys = Array.from({ length: 300 }, (_, n) => `2025-01-${String((n % 28) + 1).padStart(2, '0')}`);
    const recurringToDos: RawWidgetData['recurringToDos'] = [
      {
        id: 'r1',
        title: 'Prep for the office',
        daysOfWeek: [1, 2, 3, 4, 5],
        interval: 1,
        intervalAnchorDate: TODAY,
        archived: false,
        exceptions: [...oldKeys, TODAY, TOMORROW],
      },
    ];
    const out = trimWidgetPayload(base({ recurringToDos }), NOW);
    expect(out.recurringToDos[0].exceptions).toEqual([TODAY, TOMORROW]);
    // Every other field on the rule survives untouched.
    expect(out.recurringToDos[0].title).toBe('Prep for the office');
    expect(out.recurringToDos[0].daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(out.recurringToDos[0].archived).toBe(false);
  });

  it('leaves a rule with no exceptions untouched (NEX-306)', () => {
    const recurringToDos: RawWidgetData['recurringToDos'] = [
      {
        id: 'r1',
        title: 'Water the plants',
        daysOfWeek: [0],
        interval: 2,
        intervalAnchorDate: TODAY,
        archived: false,
        exceptions: [],
      },
    ];
    const out = trimWidgetPayload(base({ recurringToDos }), NOW);
    expect(out.recurringToDos).toEqual(recurringToDos);
  });
});

describe('trimWidgetPayload — idempotence + size', () => {
  it('is idempotent', () => {
    const data = base({
      habitLog: [
        { date: TODAY, habitTitle: 'A' },
        { date: YESTERDAY, habitTitle: 'A' },
      ],
      dailyTasks: { [YESTERDAY]: [{ title: 'x', completed: false }], [TODAY]: [{ title: 'y', completed: false }] },
      inbox: Array.from({ length: 30 }, (_, n) => ({ title: `t${n}`, completed: false })),
    });
    const once = trimWidgetPayload(data, NOW);
    const twice = trimWidgetPayload(once, NOW);
    expect(twice).toEqual(once);
  });

  it('collapses a months-deep payload by orders of magnitude', () => {
    const habitLog = Array.from({ length: 10_000 }, (_, n) => ({
      date: n < 20 ? TODAY : `2025-${String((n % 12) + 1).padStart(2, '0')}-15`,
      habitTitle: 'Meditation',
    }));
    const inbox = Array.from({ length: 800 }, (_, n) => ({ title: `item ${n}`, completed: false }));
    const dailyTasks: RawWidgetData['dailyTasks'] = {};
    for (let n = 0; n < 400; n++) {
      dailyTasks[`2024-${String((n % 12) + 1).padStart(2, '0')}-10`] = [{ title: `old ${n}`, completed: true }];
    }
    const data = base({ habitLog, inbox, dailyTasks });

    const inSize = JSON.stringify(data).length;
    const out = trimWidgetPayload(data, NOW);
    const outSize = JSON.stringify(out).length;

    expect(out.habitLog).toHaveLength(20);
    expect(out.inbox).toHaveLength(INBOX_CAP);
    expect(Object.keys(out.dailyTasks)).toHaveLength(0); // all keys were 2024 (past)
    expect(outSize).toBeLessThan(inSize / 50);
  });
});

describe('hasRenderableWidgetContent (NEX-306)', () => {
  it('is TRUE for a user with to-dos but NO habits (the bug T-Rex reproduced)', () => {
    // syncWidgetAfterMutation used to gate on active recurringRules only, so
    // moving a one-off produced zero native writes for this cohort and the
    // widget stayed stale forever.
    expect(
      hasRenderableWidgetContent({
        recurringRules: [],
        recurringToDos: [{ id: 'r1', title: 'Prep for the office', archived: false }],
        dailyTasks: {},
        inbox: [],
      }),
    ).toBe(true);

    expect(
      hasRenderableWidgetContent({
        recurringRules: [],
        recurringToDos: [],
        dailyTasks: { [TODAY]: [{ title: 'Moved task', completed: false }] },
        inbox: [],
      }),
    ).toBe(true);

    expect(
      hasRenderableWidgetContent({
        recurringRules: [],
        recurringToDos: [],
        dailyTasks: {},
        inbox: [{ title: 'Captured thought', completed: false }],
      }),
    ).toBe(true);
  });

  it('is TRUE for the original case (an active habit)', () => {
    expect(
      hasRenderableWidgetContent({
        recurringRules: [{ id: 'h1', title: 'Meditation', archived: false }],
      }),
    ).toBe(true);
  });

  it('is FALSE for an un-hydrated/empty store, preserving the cold-launch guard', () => {
    // This is why the guard is widened rather than deleted: writing an empty
    // payload over a good widget snapshot during a cold launch is the failure
    // the original check was protecting against.
    expect(hasRenderableWidgetContent({})).toBe(false);
    expect(hasRenderableWidgetContent(null)).toBe(false);
    expect(hasRenderableWidgetContent(undefined)).toBe(false);
    expect(
      hasRenderableWidgetContent({
        recurringRules: [],
        recurringToDos: [],
        dailyTasks: {},
        inbox: [],
      }),
    ).toBe(false);
  });

  it('ignores archived rules and empty per-day task lists', () => {
    expect(
      hasRenderableWidgetContent({
        recurringRules: [{ id: 'h1', archived: true }],
        recurringToDos: [{ id: 'r1', archived: true }],
        dailyTasks: { [TODAY]: [] },
        inbox: [],
      }),
    ).toBe(false);
  });

  it('tolerates malformed shapes without throwing', () => {
    expect(hasRenderableWidgetContent({ recurringRules: 'nope' as any })).toBe(false);
    expect(hasRenderableWidgetContent({ dailyTasks: [] as any })).toBe(false);
    expect(hasRenderableWidgetContent({ recurringToDos: [null, undefined] as any })).toBe(false);
  });
});

describe('hasRenderableWidgetContent — composed events (NEX-306 round 2)', () => {
  it('is TRUE for a calendar-only user (no habits, to-dos, tasks or inbox)', () => {
    // Greptile T-Rex found this against the first version of the guard: the
    // widget renders events, but the predicate only looked at store fields, so
    // a user whose only content is calendar events still got no write.
    const empty = { recurringRules: [], recurringToDos: [], dailyTasks: {}, inbox: [] };
    expect(hasRenderableWidgetContent(empty)).toBe(false);
    expect(
      hasRenderableWidgetContent(empty, [{ title: 'Standup', startISO: '2026-06-22T15:00:00.000Z' }]),
    ).toBe(true);
  });

  it('an empty or malformed event list does not flip the guard on', () => {
    const empty = { recurringRules: [], recurringToDos: [], dailyTasks: {}, inbox: [] };
    expect(hasRenderableWidgetContent(empty, [])).toBe(false);
    expect(hasRenderableWidgetContent(empty, undefined)).toBe(false);
    expect(hasRenderableWidgetContent(empty, 'nope' as any)).toBe(false);
    // still false for an un-hydrated store with no events — cold-launch guard holds
    expect(hasRenderableWidgetContent(null, [])).toBe(false);
  });
});

describe('trimWidgetPayload — daily-score fields', () => {
  it('passes intention + quote fields through untouched (pre-bounded upstream)', () => {
    const data = base({
      morningIntention: 'Ship the widget update',
      morningIntentionDate: TODAY,
      dailyQuote: { quote: 'What stands in the way becomes the way.', author: 'Marcus Aurelius' },
      dailyWisdomDate: TODAY,
    });
    const out = trimWidgetPayload(data, NOW);
    expect(out.morningIntention).toBe('Ship the widget update');
    expect(out.morningIntentionDate).toBe(TODAY);
    expect(out.dailyQuote).toEqual({
      quote: 'What stands in the way becomes the way.',
      author: 'Marcus Aurelius',
    });
    expect(out.dailyWisdomDate).toBe(TODAY);
  });
});

describe('pickWidgetQuote', () => {
  it('returns null when Today\'s Wisdom is disabled (wisdomQuoteCount === 0)', () => {
    expect(
      pickWidgetQuote([{ quote: 'Short.', author: 'A' }], 0),
    ).toBeNull();
  });

  it('picks the SHORTEST well-formed quote of the day', () => {
    const out = pickWidgetQuote(
      [
        { quote: 'A much longer quote that goes on and on about discipline.', author: 'Long' },
        { quote: 'Begin.', author: 'Short' },
        { quote: 'A medium length quote here.', author: 'Mid' },
      ],
      3,
    );
    expect(out).toEqual({ quote: 'Begin.', author: 'Short' });
  });

  it('strips tag and drops malformed entries (never breaks the native decode)', () => {
    const out = pickWidgetQuote(
      [
        { quote: 'Valid one.', author: 'A', tag: 'Discipline' },
        { quote: 42 },
        null,
        'not an object',
        { author: 'no quote' },
      ],
      3,
    );
    expect(out).toEqual({ quote: 'Valid one.', author: 'A' });
    expect(out).not.toHaveProperty('tag');
  });

  it('returns null for empty/malformed-only lists', () => {
    expect(pickWidgetQuote([], 3)).toBeNull();
    expect(pickWidgetQuote('nope', 3)).toBeNull();
    expect(pickWidgetQuote([{ quote: '   ' }, { quote: 1 }], 3)).toBeNull();
  });

  it('bounds pathological quotes and tolerates a missing author', () => {
    const huge = pickWidgetQuote([{ quote: 'x'.repeat(WIDGET_QUOTE_MAX_CHARS + 1), author: 'A' }], 3);
    expect(huge).toBeNull(); // over the cap → dropped, never shipped mangled
    const noAuthor = pickWidgetQuote([{ quote: 'Anonymous wisdom.' }], 3);
    expect(noAuthor).toEqual({ quote: 'Anonymous wisdom.', author: null });
  });
});

describe('hasRenderableWidgetContent — intention + wisdom (widget daily-score)', () => {
  const empty = { recurringRules: [], recurringToDos: [], dailyTasks: {}, inbox: [] };

  it('is TRUE for an intention-only user (their 33 intention points must render)', () => {
    expect(
      hasRenderableWidgetContent(
        { ...empty, morningIntention: 'Be present', morningIntentionDate: TODAY },
        [],
        NOW,
      ),
    ).toBe(true);
  });

  it('is TRUE when today\'s wisdom quotes exist (quote of the day renders)', () => {
    expect(
      hasRenderableWidgetContent(
        { ...empty, dailyWisdomQuotes: [{ quote: 'Begin.', author: 'A' }], dailyWisdomDate: TODAY },
        [],
        NOW,
      ),
    ).toBe(true);
  });

  it('is FALSE for a STALE intention or stale quotes (cold-launch guard holds)', () => {
    expect(
      hasRenderableWidgetContent(
        { ...empty, morningIntention: 'Old win', morningIntentionDate: YESTERDAY },
        [],
        NOW,
      ),
    ).toBe(false);
    expect(
      hasRenderableWidgetContent(
        { ...empty, dailyWisdomQuotes: [{ quote: 'Old.', author: 'A' }], dailyWisdomDate: YESTERDAY },
        [],
        NOW,
      ),
    ).toBe(false);
    // Un-hydrated store shape: intention null, date null, quotes empty, date ''.
    expect(
      hasRenderableWidgetContent(
        { ...empty, morningIntention: null, morningIntentionDate: null, dailyWisdomQuotes: [], dailyWisdomDate: '' },
        [],
        NOW,
      ),
    ).toBe(false);
  });
});
