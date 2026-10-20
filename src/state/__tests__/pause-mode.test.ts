import { describe, it, expect } from 'vitest';
import {
  EMPTY_PAUSE_MODE,
  normalizePauseMode,
  isPausedOn,
  closePauseInterval,
  areNudgesSilenced,
  pausedDayKeysIn,
  activeGapDays,
  repairStreakAnchors,
  prunePauseHistory,
  lastNDayKeys,
  scoresExcludingPaused,
  homeSurfaceMode,
  isPausePromptDue,
  type PauseModeState,
} from '../pause-mode';

const pm = (over: Partial<PauseModeState>): PauseModeState => ({ ...EMPTY_PAUSE_MODE, ...over });

describe('isPausedOn', () => {
  it('is false with no pause', () => {
    expect(isPausedOn('2026-06-10', null)).toBe(false);
    expect(isPausedOn('2026-06-10', EMPTY_PAUSE_MODE)).toBe(false);
  });

  it('true for any day on/after `since` while active', () => {
    const p = pm({ active: true, since: '2026-06-10' });
    expect(isPausedOn('2026-06-09', p)).toBe(false);
    expect(isPausedOn('2026-06-10', p)).toBe(true);
    expect(isPausedOn('2026-06-15', p)).toBe(true);
  });

  it('true within a closed history interval, inclusive', () => {
    const p = pm({ history: [{ since: '2026-06-01', endedOn: '2026-06-05' }] });
    expect(isPausedOn('2026-05-31', p)).toBe(false);
    expect(isPausedOn('2026-06-01', p)).toBe(true);
    expect(isPausedOn('2026-06-05', p)).toBe(true);
    expect(isPausedOn('2026-06-06', p)).toBe(false);
  });
});

describe('areNudgesSilenced', () => {
  it('only when actively paused', () => {
    expect(areNudgesSilenced({ pauseMode: pm({ active: true, since: '2026-06-10' }) })).toBe(true);
    expect(areNudgesSilenced({ pauseMode: pm({ active: false, history: [{ since: '2026-06-01', endedOn: '2026-06-05' }] }) })).toBe(false);
    expect(areNudgesSilenced(null)).toBe(false);
  });
});

describe('pausedDayKeysIn', () => {
  it('lists paused day-keys in the window', () => {
    const p = pm({ active: true, since: '2026-06-10' });
    expect(pausedDayKeysIn('2026-06-08', '2026-06-12', p)).toEqual([
      '2026-06-10', '2026-06-11', '2026-06-12',
    ]);
  });
  it('returns empty for an inverted window', () => {
    expect(pausedDayKeysIn('2026-06-12', '2026-06-08', pm({ active: true, since: '2026-06-10' }))).toEqual([]);
  });
});

describe('activeGapDays (lapse threshold; Law C — internal only)', () => {
  it('subtracts paused days from the raw gap', () => {
    // prevOpen 2026-06-08, today 2026-06-14 → raw gap 6. Paused 06-10..06-14 = 5.
    const p = pm({ active: true, since: '2026-06-10' });
    expect(activeGapDays('2026-06-08', '2026-06-14', p)).toBe(1);
  });
  it('equals the raw gap when nothing is paused', () => {
    expect(activeGapDays('2026-06-08', '2026-06-14', EMPTY_PAUSE_MODE)).toBe(6);
  });
  it('is 0 with no prior open date', () => {
    expect(activeGapDays(null, '2026-06-14', null)).toBe(0);
  });
  it('fully subtracts a >400-day pause (no loop-cap truncation tripping the lapse)', () => {
    // ~2.5y gap, paused almost the entire time. The whole break must subtract,
    // leaving a tiny active gap — not ~498 from a 400-iteration cap.
    const gap = activeGapDays('2024-01-01', '2026-06-18', pm({ active: true, since: '2024-01-02' }));
    expect(gap).toBeLessThanOrEqual(2);
  });
});

describe('repairStreakAnchors', () => {
  const daily = undefined; // daily schedule

  it('repairs a run that was alive and only paused days were missed', () => {
    // Paused the whole gap. Last log 06-09, today 06-14. Anchor = 06-13.
    const p = pm({ active: true, since: '2026-06-10' });
    const patch = repairStreakAnchors(
      [{ key: 'meditate', lastUpdated: '2026-06-09', daysOfWeek: daily, prePauseStatus: 'current' }],
      p,
      '2026-06-14',
    );
    expect(patch.meditate).toBe('2026-06-13');
  });

  it('does NOT resurrect a run that was already expired entering the pause', () => {
    const p = pm({ active: true, since: '2026-06-10' });
    const patch = repairStreakAnchors(
      [{ key: 'meditate', lastUpdated: '2026-06-01', daysOfWeek: daily, prePauseStatus: 'expired' }],
      p,
      '2026-06-14',
    );
    expect(patch.meditate).toBeUndefined();
  });

  it('does NOT move the anchor backward past a log made DURING the pause', () => {
    // Logged 06-13 during the pause; anchor would be 06-13 — equal, so no change.
    const p = pm({ active: true, since: '2026-06-10' });
    const patch = repairStreakAnchors(
      [{ key: 'meditate', lastUpdated: '2026-06-13', daysOfWeek: daily, prePauseStatus: 'current' }],
      p,
      '2026-06-14',
    );
    expect(patch.meditate).toBeUndefined();
  });

  it('does NOT repair when active (non-paused) missed days exceed grace', () => {
    // Gap 06-02..06-13 mostly NOT paused (pause only 06-12..06-14) → many active misses.
    const p = pm({ active: true, since: '2026-06-12' });
    const patch = repairStreakAnchors(
      [{ key: 'meditate', lastUpdated: '2026-06-02', daysOfWeek: daily, prePauseStatus: 'held' }],
      p,
      '2026-06-14',
    );
    expect(patch.meditate).toBeUndefined();
  });

  it('is idempotent (re-running on a repaired anchor is a no-op)', () => {
    const p = pm({ active: true, since: '2026-06-10' });
    const once = repairStreakAnchors(
      [{ key: 'm', lastUpdated: '2026-06-09', prePauseStatus: 'current' }],
      p, '2026-06-14',
    );
    const twice = repairStreakAnchors(
      [{ key: 'm', lastUpdated: once.m, prePauseStatus: 'current' }],
      p, '2026-06-14',
    );
    expect(twice.m).toBeUndefined();
  });
});

describe('normalizePauseMode', () => {
  it('coerces junk to a valid empty state', () => {
    expect(normalizePauseMode(undefined)).toEqual(EMPTY_PAUSE_MODE);
    expect(normalizePauseMode({ active: 'yes', history: 'nope' })).toEqual(EMPTY_PAUSE_MODE);
  });
  it('forces active=false when since is missing (no stuck unclearable pause)', () => {
    expect(normalizePauseMode({ active: true, since: null }).active).toBe(false);
    expect(normalizePauseMode({ active: true }).active).toBe(false);
  });
  it('keeps valid fields and filters malformed history entries', () => {
    const out = normalizePauseMode({
      active: true, since: '2026-06-10', plannedUntil: '2026-06-20',
      history: [{ since: '2026-06-01', endedOn: '2026-06-05' }, { since: 1 }],
    });
    expect(out.active).toBe(true);
    expect(out.since).toBe('2026-06-10');
    expect(out.history).toHaveLength(1);
  });
});

describe('lastNDayKeys', () => {
  it('returns N recent calendar keys, today first', () => {
    expect(lastNDayKeys('2026-06-14', 3)).toEqual(['2026-06-14', '2026-06-13', '2026-06-12']);
  });
});

describe('scoresExcludingPaused (the positional-slice fix)', () => {
  const history = { '2026-06-12': 80, '2026-06-13': 70, '2026-06-14': 60 };
  it('drops paused days from the window so a pause cannot reach back', () => {
    // Paused since 06-13 → only 06-12 counts; 06-13/06-14 excluded even though present.
    expect(scoresExcludingPaused(history, lastNDayKeys('2026-06-14', 3), pm({ active: true, since: '2026-06-13' }))).toEqual([80]);
  });
  it('returns [] for an all-paused window (caller renders Paused, not 0)', () => {
    expect(scoresExcludingPaused(history, lastNDayKeys('2026-06-14', 3), pm({ active: true, since: '2026-06-10' }))).toEqual([]);
  });
  it('ignores missing keys', () => {
    expect(scoresExcludingPaused(history, lastNDayKeys('2026-06-20', 3), EMPTY_PAUSE_MODE)).toEqual([]);
  });
});

describe('homeSurfaceMode (precedence paused > resume > return > normal)', () => {
  it('paused beats everything', () => {
    expect(homeSurfaceMode({ pauseActive: true, resumingFromPause: true, returningFromLapse: true })).toBe('paused');
  });
  it('resume beats return', () => {
    expect(homeSurfaceMode({ resumingFromPause: true, returningFromLapse: true })).toBe('resume');
  });
  it('return when only lapse', () => {
    expect(homeSurfaceMode({ returningFromLapse: true })).toBe('return');
  });
  it('showPiledUp suppresses ONLY the return surface, never pause/resume', () => {
    expect(homeSurfaceMode({ returningFromLapse: true, showPiledUp: true })).toBe('normal');
    // A return-user who opted into the backlog then started a pause still gets Paused.
    expect(homeSurfaceMode({ pauseActive: true, showPiledUp: true })).toBe('paused');
    expect(homeSurfaceMode({ resumingFromPause: true, showPiledUp: true })).toBe('resume');
    expect(homeSurfaceMode({})).toBe('normal');
  });
});

describe('isPausePromptDue', () => {
  it('true on/after plannedUntil while active', () => {
    expect(isPausePromptDue('2026-06-20', pm({ active: true, since: '2026-06-10', plannedUntil: '2026-06-20' }))).toBe(true);
    expect(isPausePromptDue('2026-06-21', pm({ active: true, since: '2026-06-10', plannedUntil: '2026-06-20' }))).toBe(true);
  });
  it('false before plannedUntil, with no plannedUntil, or when not active', () => {
    expect(isPausePromptDue('2026-06-19', pm({ active: true, since: '2026-06-10', plannedUntil: '2026-06-20' }))).toBe(false);
    expect(isPausePromptDue('2026-06-25', pm({ active: true, since: '2026-06-10' }))).toBe(false);
    expect(isPausePromptDue('2026-06-25', pm({ active: false, plannedUntil: '2026-06-20' }))).toBe(false);
  });
});

describe('prunePauseHistory', () => {
  it('drops intervals older than the retention window but keeps a year of history', () => {
    const kept = { since: '2026-06-01', endedOn: '2026-06-05' };
    // Within a year — must be retained so annual Horizon reviews stay pause-aware.
    const lastYear = { since: '2025-08-01', endedOn: '2025-08-05' };
    // Well over the 400-day window — dropped.
    const ancient = { since: '2024-01-01', endedOn: '2024-01-05' };
    expect(prunePauseHistory([kept, lastYear, ancient], '2026-06-14')).toEqual([kept, lastYear]);
  });
});

describe('closePauseInterval (NEX-279)', () => {
  it('same-day pause→resume covers zero days → null', () => {
    expect(closePauseInterval('2026-06-29', '2026-06-29')).toBeNull();
  });

  it('multi-day pause ends the day BEFORE resume (resume day is active)', () => {
    expect(closePauseInterval('2026-06-27', '2026-06-29')).toEqual({
      since: '2026-06-27',
      endedOn: '2026-06-28',
    });
  });

  it('one-day-then-resume-next-day → single paused day', () => {
    expect(closePauseInterval('2026-06-27', '2026-06-28')).toEqual({
      since: '2026-06-27',
      endedOn: '2026-06-27',
    });
  });

  it('the closed interval marks pre-resume days paused but NOT the resume day', () => {
    const closed = closePauseInterval('2026-06-27', '2026-06-29');
    const p = pm({ active: false, history: [closed!] });
    expect(isPausedOn('2026-06-27', p)).toBe(true);
    expect(isPausedOn('2026-06-28', p)).toBe(true);
    expect(isPausedOn('2026-06-29', p)).toBe(false); // resume day is active again
  });

  it("reporter's exact shape: Sat/Sun paused, Monday (paused→resumed same day) active", () => {
    // Pause #1 Sat→Sun (resumed Monday), then a same-day pause+resume on Monday.
    const closed1 = closePauseInterval('2026-06-27', '2026-06-29'); // -> 6/27..6/28
    const closed2 = closePauseInterval('2026-06-29', '2026-06-29'); // -> null (same day)
    expect(closed2).toBeNull();
    const history = [closed1!];
    const p = pm({ active: false, history });
    // Monday is NOT paused → its 100% would be recorded (the bug being fixed).
    expect(isPausedOn('2026-06-29', p)).toBe(false);
    // And a chart over Wed–Tue: only 6/27 and 6/28 read as paused.
    const days = ['2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30'];
    expect(days.filter((d) => isPausedOn(d, p))).toEqual(['2026-06-27', '2026-06-28']);
    // scoresExcludingPaused keeps Monday's score, drops the paused days.
    const scores = { '2026-06-27': 90, '2026-06-28': 80, '2026-06-29': 100, '2026-06-30': 40 };
    expect(scoresExcludingPaused(scores, days, p)).toEqual([100, 40]);
  });
});
