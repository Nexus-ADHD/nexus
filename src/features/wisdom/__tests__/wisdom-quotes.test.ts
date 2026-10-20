import { describe, expect, it } from 'vitest';
import {
  FALLBACK_QUOTES,
  filterAgainstHistory,
  pickFallbackQuotes,
  shouldReRoll,
  todayWisdomForNotification,
  wisdomForNotificationDate,
  wisdomQuoteForSlot,
} from '../wisdom-quotes';

// Pure no-repeat / fallback behavior for Today's Wisdom. These guard the
// history banlist (quote OR author dedup) and the tag-diverse fallback picker
// that now also renders optimistically while the AI call is in flight.

describe('filterAgainstHistory', () => {
  it('drops a candidate whose quote text matches history (ignoring case/punctuation)', () => {
    const history = [{ quote: 'Discipline equals freedom.', author: 'Someone Else' }];
    const out = filterAgainstHistory(
      [{ quote: 'discipline equals freedom', author: 'Jocko Willink' }],
      history
    );
    expect(out).toHaveLength(0);
  });

  it('drops a candidate by AUTHOR even when the quote differs (aggressive author dedup)', () => {
    const history = [{ quote: 'A totally different line', author: 'Rumi' }];
    const out = filterAgainstHistory([{ quote: 'The wound is where the light enters', author: 'Rumi' }], history);
    expect(out).toHaveLength(0);
  });

  it('keeps candidates not present in history', () => {
    const history = [{ quote: 'Discipline equals freedom.', author: 'Jocko Willink' }];
    const out = filterAgainstHistory([{ quote: 'Creativity is intelligence having fun.', author: 'Albert Einstein' }], history);
    expect(out).toHaveLength(1);
  });
});

describe('pickFallbackQuotes', () => {
  it('returns exactly targetCount quotes from the library', () => {
    const picked = pickFallbackQuotes(3, []);
    expect(picked).toHaveLength(3);
    picked.forEach((q) => {
      expect(typeof q.quote).toBe('string');
      expect(typeof q.author).toBe('string');
    });
  });

  it('prefers tag diversity when enough tags are available', () => {
    const picked = pickFallbackQuotes(3, []);
    const tags = new Set(picked.map((q) => q.tag));
    expect(tags.size).toBe(3);
  });

  it('excludes quotes/authors in the recent history', () => {
    // Ban every Discipline author so none of that tag can be picked.
    const disciplineAuthors = FALLBACK_QUOTES.filter((q) => q.tag === 'Discipline').map((q) => ({
      quote: q.quote,
      author: q.author,
    }));
    const picked = pickFallbackQuotes(5, disciplineAuthors);
    const pickedKeys = new Set(picked.map((q) => `${q.quote}|${q.author}`));
    disciplineAuthors.forEach((d) => {
      expect(pickedKeys.has(`${d.quote}|${d.author}`)).toBe(false);
    });
  });

  it('falls back to the full library when history would exclude everything', () => {
    const banAll = FALLBACK_QUOTES.map((q) => ({ quote: q.quote, author: q.author }));
    const picked = pickFallbackQuotes(3, banAll);
    expect(picked).toHaveLength(3); // last-resort: still returns rather than blank
  });

  it('returns fewer than targetCount only when the library is smaller', () => {
    const picked = pickFallbackQuotes(9999, []);
    expect(picked.length).toBe(FALLBACK_QUOTES.length);
  });
});

describe('shouldReRoll', () => {
  const base = { countAfter: 3, winAfter: '', intentionKey: '', dayAfter: '2026-07-02', todayKey: '2026-07-02' };

  it('does not re-roll when nothing changed', () => {
    expect(shouldReRoll(base)).toBe(false);
  });

  it('re-rolls when the win changed mid-flight', () => {
    expect(shouldReRoll({ ...base, winAfter: 'ship the fix', intentionKey: '' })).toBe(true);
  });

  it('re-rolls when the local day rolled over mid-flight, even with an unchanged empty win', () => {
    expect(shouldReRoll({ ...base, todayKey: '2026-07-01', dayAfter: '2026-07-02' })).toBe(true);
  });

  it('re-rolls when both the day and the win changed', () => {
    expect(shouldReRoll({ ...base, todayKey: '2026-07-01', winAfter: 'new win' })).toBe(true);
  });

  it('never re-rolls when the quote count is off, regardless of staleness', () => {
    expect(shouldReRoll({ ...base, countAfter: 0, todayKey: '2026-07-01', winAfter: 'new win' })).toBe(false);
  });
});

// Notification source helpers — the daily nudges carry ONE Today's-Wisdom line
// (from the user's today's win) only when the set was generated for the LOCAL
// day and wisdom is enabled. Yesterday's set must never fire as today's.
describe('todayWisdomForNotification', () => {
  const quotes = [
    { quote: 'Discipline equals freedom.', author: 'Jocko Willink' },
    { quote: 'We suffer more often in imagination than in reality.', author: 'Seneca' },
  ];

  it("returns today's quotes when the date matches and wisdom is enabled", () => {
    expect(
      todayWisdomForNotification(
        { dailyWisdomDate: '2026-07-30', dailyWisdomQuotes: quotes, wisdomQuoteCount: 3 },
        '2026-07-30'
      )
    ).toEqual(quotes);
  });

  it('returns undefined for a stale day (never serve yesterday as today)', () => {
    expect(
      todayWisdomForNotification(
        { dailyWisdomDate: '2026-07-29', dailyWisdomQuotes: quotes, wisdomQuoteCount: 3 },
        '2026-07-30'
      )
    ).toBeUndefined();
  });

  it('returns undefined when wisdom is off (wisdomQuoteCount 0)', () => {
    expect(
      todayWisdomForNotification(
        { dailyWisdomDate: '2026-07-30', dailyWisdomQuotes: quotes, wisdomQuoteCount: 0 },
        '2026-07-30'
      )
    ).toBeUndefined();
  });

  it('returns undefined for an empty or missing array (mid-regeneration window)', () => {
    expect(
      todayWisdomForNotification({ dailyWisdomDate: '2026-07-30', dailyWisdomQuotes: [] }, '2026-07-30')
    ).toBeUndefined();
    expect(todayWisdomForNotification({ dailyWisdomDate: '2026-07-30' }, '2026-07-30')).toBeUndefined();
  });

  it('drops malformed entries and trims quote/author', () => {
    const out = todayWisdomForNotification(
      {
        dailyWisdomDate: '2026-07-30',
        dailyWisdomQuotes: [
          { quote: '  Keep going.  ', author: '  Someone  ' },
          { quote: 42 as any, author: 'Nope' },
          { quote: '   ', author: 'Blank' },
        ],
      },
      '2026-07-30'
    );
    expect(out).toEqual([{ quote: 'Keep going.', author: 'Someone' }]);
  });
});

describe('wisdomQuoteForSlot', () => {
  const three = [
    { quote: 'One.', author: 'A' },
    { quote: 'Two.', author: 'B' },
    { quote: 'Three.', author: 'C' },
  ];

  it('gives morning and evening DISTINCT quotes when at least two exist', () => {
    expect(wisdomQuoteForSlot(three, 0)).toEqual(three[0]);
    expect(wisdomQuoteForSlot(three, 1)).toEqual(three[1]);
  });

  it('shares the single quote across slots when count is 1', () => {
    const one = [{ quote: 'Only.', author: 'A' }];
    expect(wisdomQuoteForSlot(one, 0)).toEqual(one[0]);
    expect(wisdomQuoteForSlot(one, 1)).toEqual(one[0]);
  });

  it('returns undefined for an empty array', () => {
    expect(wisdomQuoteForSlot([], 0)).toBeUndefined();
  });
});

// The morning nudge fires before today's win exists, so it leads with
// YESTERDAY's set — recovered from recentWisdomHistory (30-day rolling,
// appended per generation).
describe('wisdomForNotificationDate', () => {
  const history = [
    { quote: 'Old day line.', author: 'A', dateKey: '2026-07-28' },
    { quote: 'Yesterday v1.', author: 'B', dateKey: '2026-07-29' },
    { quote: 'Yesterday v1b.', author: 'C', dateKey: '2026-07-29' },
    // Same-day regeneration after the win changed — the FINAL set is last.
    { quote: 'Yesterday v2.', author: 'D', dateKey: '2026-07-29' },
    { quote: 'Yesterday v2b.', author: 'E', dateKey: '2026-07-29' },
  ];

  it('recovers a past day’s final set from history (last `count` entries win)', () => {
    const out = wisdomForNotificationDate(
      { recentWisdomHistory: history, wisdomQuoteCount: 2 },
      '2026-07-29',
      '2026-07-30'
    );
    expect(out).toEqual([
      { quote: 'Yesterday v2.', author: 'D' },
      { quote: 'Yesterday v2b.', author: 'E' },
    ]);
  });

  it('returns undefined for a day with no history entries', () => {
    expect(
      wisdomForNotificationDate({ recentWisdomHistory: history, wisdomQuoteCount: 3 }, '2026-07-27', '2026-07-30')
    ).toBeUndefined();
  });

  it('returns undefined when wisdom is off (count 0), even with history present', () => {
    expect(
      wisdomForNotificationDate({ recentWisdomHistory: history, wisdomQuoteCount: 0 }, '2026-07-29', '2026-07-30')
    ).toBeUndefined();
  });

  it('delegates to the live today set when dateKey is today', () => {
    const today = [{ quote: 'Today line.', author: 'T' }];
    const out = wisdomForNotificationDate(
      { dailyWisdomDate: '2026-07-30', dailyWisdomQuotes: today, wisdomQuoteCount: 3, recentWisdomHistory: history },
      '2026-07-30',
      '2026-07-30'
    );
    expect(out).toEqual(today);
  });

  it('drops malformed history entries and trims', () => {
    const out = wisdomForNotificationDate(
      {
        recentWisdomHistory: [
          { quote: '  Keep going.  ', author: '  Someone ', dateKey: '2026-07-29' },
          { quote: 42 as any, author: 'Nope', dateKey: '2026-07-29' },
        ],
        wisdomQuoteCount: 3,
      },
      '2026-07-29',
      '2026-07-30'
    );
    expect(out).toEqual([{ quote: 'Keep going.', author: 'Someone' }]);
  });
});
