import { describe, expect, it } from 'vitest';
import { QUOTE_SEED } from '../../../ai/notification-quote-seed';
import { OPENER_INSTRUCTION, isOpenerCandidateSafe, prepareOpener, seedOpenerFor, shouldAskModelForOpener } from '../coach-opener';
import { checkReplyTone } from '../coach-turn';

describe('prepareOpener (S3.1)', () => {
  const day = '2026-09-02';

  it('returns nothing under Pause Mode, even with a candidate', () => {
    expect(prepareOpener({ dayKey: day, pausedNow: true, personalized: true, candidate: 'Day is open.' })).toBeNull();
    expect(shouldAskModelForOpener({ pausedNow: true, personalized: true })).toBe(false);
  });

  it('uses a seed line when personalized is off, and never asks the model', () => {
    const out = prepareOpener({ dayKey: day, pausedNow: false, personalized: false, candidate: 'An AI line that is fine.' });
    expect(out?.text).toBe(seedOpenerFor(day));
    expect(QUOTE_SEED).toContain(out?.text);
    expect(shouldAskModelForOpener({ pausedNow: false, personalized: false })).toBe(false);
  });

  it('falls back to the seed when the candidate fails the filter or the tone check', () => {
    for (const bad of ['You need to get moving today!', 'Three days without yoga. Today, return.', '', '   ', 'x']) {
      const out = prepareOpener({ dayKey: day, pausedNow: false, personalized: true, candidate: bad });
      expect(out?.text, bad).toBe(seedOpenerFor(day));
    }
    expect(prepareOpener({ dayKey: day, pausedNow: false, personalized: true, candidate: null })?.text).toBe(seedOpenerFor(day));
  });

  it('keeps a safe candidate, trimmed, keyed to the day', () => {
    const out = prepareOpener({ dayKey: day, pausedNow: false, personalized: true, candidate: '  Two habits due before noon. The intention is already set.  ' });
    expect(out).toEqual({ text: 'Two habits due before noon. The intention is already set.', dayKey: day });
    expect(isOpenerCandidateSafe('Two habits due before noon.')).toBe(true);
  });

  it('the seed line is stable per day and different across days', () => {
    expect(seedOpenerFor(day)).toBe(seedOpenerFor(day));
    const lines = new Set(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'].map(seedOpenerFor));
    expect(lines.size).toBeGreaterThan(1);
  });

  it('every seed line passes the coach tone check', () => {
    for (const line of QUOTE_SEED) expect(checkReplyTone(line).ok, line).toBe(true);
  });

  it('the opener instruction obeys §18', () => {
    expect(OPENER_INSTRUCTION).not.toMatch(/[!—]/);
  });
});
