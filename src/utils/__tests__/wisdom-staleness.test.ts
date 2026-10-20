// Tests for the Today's Wisdom staleness predicate. Pure module (no RN /
// store imports), so it runs under the pure-Node vitest config.
import { describe, it, expect } from 'vitest';
import { wisdomIsStale } from '../wisdom-staleness';

const TODAY = '2026-06-25';
const q = (n: number) => Array.from({ length: n }, (_, i) => ({ quote: `q${i}`, author: 'a' }));

describe('wisdomIsStale', () => {
  it('not stale when day, count, and win all match', () => {
    expect(
      wisdomIsStale({
        expectedCount: 3,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: 'ship the app',
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: 'ship the app',
      }),
    ).toBe(false);
  });

  it('stale on a new day even if win matches', () => {
    expect(
      wisdomIsStale({
        expectedCount: 3,
        dailyWisdomDate: '2026-06-24',
        dailyWisdomIntention: 'x',
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: 'x',
      }),
    ).toBe(true);
  });

  it('stale when the win changed (same day)', () => {
    expect(
      wisdomIsStale({
        expectedCount: 3,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: 'old win',
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: 'new win',
      }),
    ).toBe(true);
  });

  it('stale when count mismatches', () => {
    expect(
      wisdomIsStale({
        expectedCount: 5,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: 'x',
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: 'x',
      }),
    ).toBe(true);
  });

  it('stale when a quote is missing/blank', () => {
    expect(
      wisdomIsStale({
        expectedCount: 2,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: 'x',
        quotes: [{ quote: 'a', author: 'a' }, { quote: '', author: 'b' }],
        todayKey: TODAY,
        currentIntention: 'x',
      }),
    ).toBe(true);
  });

  it('disabled (count 0): not stale when there are no leftover quotes, ignores win change', () => {
    expect(
      wisdomIsStale({
        expectedCount: 0,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: 'old',
        quotes: [],
        todayKey: TODAY,
        currentIntention: 'totally different',
      }),
    ).toBe(false);
  });

  it('disabled (count 0): stale only when leftover quotes must be cleared', () => {
    expect(
      wisdomIsStale({
        expectedCount: 0,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: '',
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: '',
      }),
    ).toBe(true);
  });

  it('legacy null marker + no current win → not stale (no upgrade churn)', () => {
    expect(
      wisdomIsStale({
        expectedCount: 3,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: null,
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: '',
      }),
    ).toBe(false);
  });

  it('legacy null marker + a current win → stale (re-roll once to personalize)', () => {
    expect(
      wisdomIsStale({
        expectedCount: 3,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: null,
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: 'ship it',
      }),
    ).toBe(true);
  });

  it('whitespace-only difference in the win → not stale (trim-normalized)', () => {
    expect(
      wisdomIsStale({
        expectedCount: 3,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: 'focus today',
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: '  focus today  ',
      }),
    ).toBe(false);
  });

  it('whitespace on the STORED side too → not stale (both sides trimmed)', () => {
    expect(
      wisdomIsStale({
        expectedCount: 3,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: '  focus today  ',
        quotes: q(3),
        todayKey: TODAY,
        currentIntention: 'focus today',
      }),
    ).toBe(false);
  });

  it('non-array quotes → stale', () => {
    expect(
      wisdomIsStale({
        expectedCount: 3,
        dailyWisdomDate: TODAY,
        dailyWisdomIntention: 'x',
        quotes: undefined,
        todayKey: TODAY,
        currentIntention: 'x',
      }),
    ).toBe(true);
  });
});
