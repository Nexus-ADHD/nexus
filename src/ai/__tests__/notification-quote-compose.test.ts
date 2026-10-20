import { describe, it, expect } from 'vitest';
import {
  EVENING_CUE_TITLE,
  composeQuoteBody,
  composeWisdomBody,
  dayOfYearIndex,
  quoteForToday,
  resolveNotificationLines,
} from '../notification-quote-compose';
import { emptyPool, removeQuote } from '../notification-quote-pool';
import { QUOTE_SEED } from '../notification-quote-seed';

describe('composeQuoteBody (NEX-277 quote-style body)', () => {
  it('wraps the line in curly quotation marks', () => {
    expect(composeQuoteBody('Begin where you stand.')).toBe('“Begin where you stand.”');
  });

  it('trims the line before wrapping', () => {
    expect(composeQuoteBody('  Begin where you stand.  ')).toBe('“Begin where you stand.”');
  });

  it('falls back to a seed line (never blank) for null/empty input', () => {
    expect(composeQuoteBody(null)).toBe(`“${QUOTE_SEED[0]}”`);
    expect(composeQuoteBody('')).toBe(`“${QUOTE_SEED[0]}”`);
    expect(composeQuoteBody(undefined)).toBe(`“${QUOTE_SEED[0]}”`);
  });
});

describe('EVENING_CUE_TITLE', () => {
  it('keeps a debrief affordance in the evening title (no exclamation/question)', () => {
    expect(EVENING_CUE_TITLE).toMatch(/60 seconds/);
    expect(EVENING_CUE_TITLE).not.toMatch(/[!?]/);
  });
});

describe('dayOfYearIndex', () => {
  it('is stable per local date and advances by one each day', () => {
    const a = dayOfYearIndex(new Date(2026, 5, 24, 9, 0));
    const b = dayOfYearIndex(new Date(2026, 5, 24, 22, 0)); // same day, later hour
    const c = dayOfYearIndex(new Date(2026, 5, 25, 9, 0)); // next day
    expect(a).toBe(b);
    expect(c).toBe(a + 1);
  });
});

describe('quoteForToday', () => {
  it('returns an on-voice seed line, different for morning vs evening same day', () => {
    const now = new Date(2026, 5, 24, 9, 0);
    const m = quoteForToday(emptyPool(), 'morning', now);
    const e = quoteForToday(emptyPool(), 'evening', now);
    expect(typeof m).toBe('string');
    expect(m).not.toBe(e); // morning≠evening invariant
  });

  it('with personalized=false draws only from the curated seed floor', () => {
    const now = new Date(2026, 5, 24, 9, 0);
    const pool = { ...emptyPool(), live: ['Custom AI line one here.', 'Custom AI line two here.'] };
    for (let d = 0; d < 5; d++) {
      const day = new Date(2026, 5, 20 + d, 9, 0);
      expect(QUOTE_SEED).toContain(quoteForToday(pool, 'morning', day, false));
      expect(QUOTE_SEED).toContain(quoteForToday(pool, 'evening', day, false));
    }
    // and the seed line still resolves even after the day's first seed is tombstoned
    const trimmed = removeQuote(emptyPool(), [QUOTE_SEED[0]]);
    expect(quoteForToday(trimmed, 'morning', now, false)).not.toBe(QUOTE_SEED[0]);
  });
});

describe('composeWisdomBody (Today’s-Wisdom attribution)', () => {
  it('wraps the quote and appends the author with a middle dot (§18.1 bans em dashes)', () => {
    expect(composeWisdomBody('Discipline equals freedom.', 'Jocko Willink')).toBe(
      '“Discipline equals freedom.” · Jocko Willink'
    );
  });

  it('omits the separator when the author is empty', () => {
    expect(composeWisdomBody('Discipline equals freedom.', '')).toBe('“Discipline equals freedom.”');
    expect(composeWisdomBody('Discipline equals freedom.')).toBe('“Discipline equals freedom.”');
  });
});

describe('resolveNotificationLines (wisdom leads, pool backs up)', () => {
  const now = new Date(2026, 5, 24, 9, 0);
  // Per-slot sets, as dated by the caller: morning = yesterday's win, evening = today's.
  const yesterday = [
    { quote: 'Discipline equals freedom.', author: 'Jocko Willink' },
    { quote: 'First we form habits, then they form us.', author: 'Jim Rohn' },
  ];
  const today = [{ quote: 'We suffer more often in imagination than in reality.', author: 'Seneca' }];

  it('returns null slots and an untouched pool when includeQuotes is off', () => {
    const out = resolveNotificationLines({
      includeQuotes: false,
      wisdomBySlot: { morning: yesterday, evening: today },
      pool: emptyPool(),
      now,
    });
    expect(out.morning.text).toBeNull();
    expect(out.evening.text).toBeNull();
    expect(out.poolQuotesUsed).toEqual([]);
  });

  it('each slot leads with its OWN wisdom set (morning: yesterday’s win, evening: today’s)', () => {
    const out = resolveNotificationLines({
      includeQuotes: true,
      wisdomBySlot: { morning: yesterday, evening: today },
      pool: emptyPool(),
      now,
    });
    expect(out.morning).toEqual({ text: yesterday[0].quote, author: yesterday[0].author });
    expect(out.evening).toEqual({ text: today[0].quote, author: today[0].author });
    // Wisdom covered BOTH slots → no pool line consumed → onQuotesSelected must be skipped.
    expect(out.poolQuotesUsed).toEqual([]);
  });

  it('a filter-rejected wisdom line falls back to the pool for that slot only', () => {
    const evening = [
      { quote: 'We suffer more often in imagination than in reality.', author: 'Seneca' }, // slot takes index 1 below
      { quote: 'Lead from the back — and let others believe they are in front.', author: 'Nelson Mandela' }, // em dash → banned
    ];
    const out = resolveNotificationLines({
      includeQuotes: true,
      wisdomBySlot: { morning: yesterday, evening },
      pool: emptyPool(),
      now,
    });
    expect(out.morning.author).toBe('Jocko Willink'); // wisdom
    expect(out.evening.author).toBeUndefined(); // pool fallback
    expect(out.evening.text).not.toBe(evening[1].quote);
    expect(QUOTE_SEED).toContain(out.evening.text); // emptyPool ⇒ seed floor
    expect(out.poolQuotesUsed).toEqual([out.evening.text]); // exactly the one pool line
  });

  it.each([
    'What would make today a win?', // `?` anywhere → banned
    `${'x'.repeat(100)}.`, // 101 chars → over MAX_QUOTE_LEN
  ])('rejects an unsafe wisdom line: %s', (unsafe) => {
    const out = resolveNotificationLines({
      includeQuotes: true,
      wisdomBySlot: { morning: [{ quote: unsafe, author: 'A' }] },
      pool: emptyPool(),
      now,
    });
    expect(out.morning.author).toBeUndefined();
    expect(out.morning.text).not.toBe(unsafe);
  });

  it('no wisdom at all (lapsed user, no win set) ⇒ both slots draw from the pool rotation', () => {
    const out = resolveNotificationLines({ includeQuotes: true, pool: emptyPool(), now });
    expect(out.morning.author).toBeUndefined();
    expect(out.evening.author).toBeUndefined();
    expect(QUOTE_SEED).toContain(out.morning.text);
    expect(QUOTE_SEED).toContain(out.evening.text);
    expect(out.poolQuotesUsed).toHaveLength(2);
  });

  it('a single-quote set shares that quote across its slots (nothing else to pick)', () => {
    const one = [{ quote: 'Discipline equals freedom.', author: 'Jocko Willink' }];
    const out = resolveNotificationLines({
      includeQuotes: true,
      wisdomBySlot: { morning: one, evening: one },
      pool: emptyPool(),
      now,
    });
    expect(out.morning.text).toBe(one[0].quote);
    expect(out.evening.text).toBe(one[0].quote);
    expect(out.poolQuotesUsed).toEqual([]);
  });
});
