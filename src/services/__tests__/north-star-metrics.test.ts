import { describe, expect, it } from 'vitest';
import {
  APP_OPENED_KEYS,
  CAPTURED_ITEM_FIRST_REACHED_KEYS,
  ITEM_CAPTURED_KEYS,
  LAPSE_THRESHOLD_DAYS,
  RETURN_WINDOW_DAYS,
  type AccessMethod,
  type CaptureRecord,
  type FirstReachRecord,
  type LedgerRowLike,
  ageBucket,
  attributeReach,
  classifyOpen,
  computeHuntFirstReachRate,
  computeLapseEpisodes,
  computeReturnAfterLapseRate,
  computeUnreachedCaptureRate,
  dayKeyDiff,
  extractCaptures,
  itemTypeForSurface,
} from '../north-star-metrics';

// NEX-188 — pure computation contract for the two north-star metrics.

describe('dayKeyDiff (calendar days, DST-stable)', () => {
  it('counts whole calendar days forward and backward', () => {
    expect(dayKeyDiff('2026-06-01', '2026-06-04')).toBe(3);
    expect(dayKeyDiff('2026-06-04', '2026-06-01')).toBe(-3);
    expect(dayKeyDiff('2026-06-01', '2026-06-01')).toBe(0);
  });

  it('is stable across a US spring-forward DST boundary (2026-03-08)', () => {
    // If this used raw ms across the 23-hour DST day it could read 2 or 4.
    expect(dayKeyDiff('2026-03-07', '2026-03-10')).toBe(3);
  });

  it('counts across a month/year boundary', () => {
    expect(dayKeyDiff('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('ageBucket (NEX-215 — capture→reach latency)', () => {
  const C = 1_000_000; // arbitrary capture instant (ms)
  it('buckets at each boundary', () => {
    expect(ageBucket(C, C)).toBe('under_1m');
    expect(ageBucket(C, C + 59_999)).toBe('under_1m');
    expect(ageBucket(C, C + 60_000)).toBe('under_1h');
    expect(ageBucket(C, C + 3_599_999)).toBe('under_1h');
    expect(ageBucket(C, C + 3_600_000)).toBe('under_1d');
    expect(ageBucket(C, C + 86_399_999)).toBe('under_1d');
    expect(ageBucket(C, C + 86_400_000)).toBe('over_1d');
  });
  it('clamps a reach earlier than the capture (clock skew) to under_1m', () => {
    expect(ageBucket(C, C - 5_000)).toBe('under_1m');
  });
});

describe('classifyOpen (current-open raw fact)', () => {
  it('returns null for the first-ever open (no previous active day)', () => {
    expect(classifyOpen(null, '2026-06-10')).toEqual({ daysSinceLastActiveDay: null });
    expect(classifyOpen(undefined, '2026-06-10')).toEqual({ daysSinceLastActiveDay: null });
  });

  it('returns the calendar-day gap since the last active day', () => {
    expect(classifyOpen('2026-06-06', '2026-06-10')).toEqual({ daysSinceLastActiveDay: 4 });
  });

  it('clamps a same-day reopen to 0 and never goes negative', () => {
    expect(classifyOpen('2026-06-10', '2026-06-10')).toEqual({ daysSinceLastActiveDay: 0 });
  });
});

describe('computeLapseEpisodes', () => {
  it('does not count a 2-day gap (below threshold)', () => {
    // 06-01 → 06-03 gap 2; history ends 06-03 within threshold of today → no tail.
    expect(computeLapseEpisodes(['2026-06-01', '2026-06-03'], { todayDayKey: '2026-06-03' })).toEqual([]);
  });

  it('treats a gap of exactly LAPSE_THRESHOLD_DAYS as NOT a lapse', () => {
    // gap of 3 (06-01 → 06-04) means only 06-02,06-03 inactive — not yet a lapse.
    expect(computeLapseEpisodes(['2026-06-01', '2026-06-04'], { todayDayKey: '2026-06-04' })).toEqual([]);
    expect(LAPSE_THRESHOLD_DAYS).toBe(3);
  });

  it('counts a gap at threshold+1 as a returned lapse (immature here)', () => {
    // 06-01 → 06-05 gap 4 (> 3); only 4 days elapsed so the window is immature.
    const eps = computeLapseEpisodes(['2026-06-01', '2026-06-05'], { todayDayKey: '2026-06-05' });
    expect(eps).toEqual([
      { startDayKey: '2026-06-01', matured: false, returned: true, returnLatencyDays: 4 },
    ]);
  });

  it('does NOT produce a tail episode when the user was active within the threshold of today', () => {
    expect(computeLapseEpisodes(['2026-06-01'], { todayDayKey: '2026-06-03' })).toEqual([]);
  });

  it('marks an open tail gap past 30 days as a matured, non-returned lapse (churn)', () => {
    const eps = computeLapseEpisodes(['2026-06-01'], { todayDayKey: '2026-12-31' });
    expect(eps).toEqual([{ startDayKey: '2026-06-01', matured: true, returned: false }]);
  });

  it('does NOT mature on day D+30 itself (a return is still possible that day)', () => {
    // dayKeyDiff(06-01, 07-01) === 30 === RETURN_WINDOW_DAYS → window still open.
    expect(computeLapseEpisodes(['2026-06-01'], { todayDayKey: '2026-07-01' })).toEqual([
      { startDayKey: '2026-06-01', matured: false, returned: false },
    ]);
    // One day later the window has closed → matured.
    expect(computeLapseEpisodes(['2026-06-01'], { todayDayKey: '2026-07-02' })).toEqual([
      { startDayKey: '2026-06-01', matured: true, returned: false },
    ]);
  });

  it('excludes an immature open tail (lapsed but window not elapsed)', () => {
    const eps = computeLapseEpisodes(['2026-06-01'], { todayDayKey: '2026-06-11' });
    expect(eps).toEqual([{ startDayKey: '2026-06-01', matured: false, returned: false }]);
    expect(RETURN_WINDOW_DAYS).toBe(30);
  });

  it('does not count a return that arrives beyond the 30-day window', () => {
    // 06-01 → 07-15 gap 44 (> 30): a lapse, but the return is too late to count.
    const eps = computeLapseEpisodes(['2026-06-01', '2026-07-15'], { todayDayKey: '2026-07-16' });
    expect(eps).toEqual([{ startDayKey: '2026-06-01', matured: true, returned: false }]);
  });

  it('finds multiple lapse episodes incl. the trailing open gap', () => {
    // 01-01→01-10 (gap 9, returned); 01-10→02-15 (gap 36, too late); 02-15 tail (open, churn).
    const eps = computeLapseEpisodes(
      ['2026-01-01', '2026-01-10', '2026-02-15'],
      { todayDayKey: '2026-12-31' },
    );
    expect(eps.map((e) => e.startDayKey)).toEqual(['2026-01-01', '2026-01-10', '2026-02-15']);
    expect(eps.map((e) => e.returned)).toEqual([true, false, false]);
  });

  it('ignores activity dated after the snapshot day (point-in-time correct)', () => {
    // As of 06-10, the 06-20 activity is in the future. The 06-01 tail is an open,
    // still-immature lapse — NOT a settled return.
    expect(computeLapseEpisodes(['2026-06-01', '2026-06-20'], { todayDayKey: '2026-06-10' })).toEqual([
      { startDayKey: '2026-06-01', matured: false, returned: false },
    ]);
  });

  it('normalizes unsorted input with duplicates', () => {
    const eps = computeLapseEpisodes(
      ['2026-06-05', '2026-06-01', '2026-06-05'],
      { todayDayKey: '2026-06-05' },
    );
    expect(eps).toEqual([
      { startDayKey: '2026-06-01', matured: false, returned: true, returnLatencyDays: 4 },
    ]);
  });
});

describe('computeReturnAfterLapseRate', () => {
  const today = '2026-12-31';

  it('is null when no episodes have settled yet', () => {
    expect(computeReturnAfterLapseRate(['2026-06-01'], '2026-06-11')).toEqual({
      rate: null,
      returned: 0,
      total: 0,
    });
  });

  it('does not count future activity as a settled return in a historical run', () => {
    // As of 06-10, 06-20 has not happened — the lapse window is still open, not a return.
    expect(computeReturnAfterLapseRate(['2026-06-01', '2026-06-20'], '2026-06-10')).toEqual({
      rate: null,
      returned: 0,
      total: 0,
    });
  });

  it('counts an already-returned episode immediately, even before its window matures', () => {
    // 06-01 → 06-11 gap 10 (returned) but only 12 days elapsed → immature window.
    // The return is settled, so it must count now and not lag the rate.
    expect(computeReturnAfterLapseRate(['2026-06-01', '2026-06-11'], '2026-06-13')).toEqual({
      rate: 1,
      returned: 1,
      total: 1,
    });
  });

  it('computes returned / total over matured episodes (incl. trailing churn)', () => {
    // A (01-01 → 01-10, gap 9): returned. B (01-10 → never, open >30d): not returned.
    const res = computeReturnAfterLapseRate(['2026-01-01', '2026-01-10'], today);
    expect(res).toEqual({ rate: 0.5, returned: 1, total: 2 });
  });

  it('counts a fully-returned history as rate 1 (returns settle immediately)', () => {
    // 06-01→06-10 (gap 9, returned) and 06-10→07-05 (gap 25, returned) both settle on
    // their returns; the 07-05 tail is within threshold of today so it is not a lapse.
    const res = computeReturnAfterLapseRate(
      ['2026-06-01', '2026-06-10', '2026-07-05'],
      '2026-07-06',
    );
    expect(res).toEqual({ rate: 1, returned: 2, total: 2 });
  });
});

describe('attributeReach', () => {
  it('classifies manual_nav and search as hunts', () => {
    expect(attributeReach('manual_nav')).toBe('hunt');
    expect(attributeReach('search')).toBe('hunt');
  });

  it('classifies surfaced affordances as surfaced', () => {
    const surfaced: AccessMethod[] = ['confirmation_jump', 'home_echo', 'home_today', 'deep_link'];
    for (const m of surfaced) expect(attributeReach(m)).toBe('surfaced');
  });
});

describe('computeHuntFirstReachRate', () => {
  const captures: CaptureRecord[] = [
    { captureId: 'a', dayKey: '2026-06-01' },
    { captureId: 'b', dayKey: '2026-06-01' },
    { captureId: 'c', dayKey: '2026-06-01' },
  ];

  it('is null when nothing has been reached', () => {
    expect(computeHuntFirstReachRate(captures, [])).toEqual({ rate: null, hunts: 0, reached: 0 });
  });

  it('counts only the FIRST reach per capture (earliest dayKey wins)', () => {
    const reaches: FirstReachRecord[] = [
      // 'a' first reached via manual_nav (hunt), later via jump — only the hunt counts.
      { captureId: 'a', accessMethod: 'confirmation_jump', dayKey: '2026-06-03', seq: 3 },
      { captureId: 'a', accessMethod: 'manual_nav', dayKey: '2026-06-01', seq: 1 },
      // 'b' reached via the echo chip (surfaced).
      { captureId: 'b', accessMethod: 'home_echo', dayKey: '2026-06-01', seq: 1 },
      // 'c' never reached. An orphan reach with no capture is ignored.
      { captureId: 'zz', accessMethod: 'manual_nav', dayKey: '2026-06-01', seq: 1 },
    ];
    expect(computeHuntFirstReachRate(captures, reaches)).toEqual({
      rate: 0.5,
      hunts: 1,
      reached: 2,
    });
  });

  it('is order-independent for same-day reaches (seq breaks the tie)', () => {
    // Same capture, same day: morning surfaced jump (seq 1) then afternoon search (seq 2).
    // The surfaced reach is first regardless of input order, so it is NOT a hunt.
    const morningFirst: FirstReachRecord[] = [
      { captureId: 'a', accessMethod: 'confirmation_jump', dayKey: '2026-06-01', seq: 1 },
      { captureId: 'a', accessMethod: 'search', dayKey: '2026-06-01', seq: 2 },
    ];
    const reversed = [...morningFirst].reverse();
    const expected = { rate: 0, hunts: 0, reached: 1 };
    expect(computeHuntFirstReachRate([captures[0]], morningFirst)).toEqual(expected);
    expect(computeHuntFirstReachRate([captures[0]], reversed)).toEqual(expected);
  });
});

describe('computeUnreachedCaptureRate', () => {
  const captures: CaptureRecord[] = [
    { captureId: 'a', dayKey: '2026-06-01' }, // old, reached
    { captureId: 'b', dayKey: '2026-06-01' }, // old, unreached
    { captureId: 'c', dayKey: '2026-06-10' }, // too fresh to count
  ];
  const reaches: FirstReachRecord[] = [
    { captureId: 'a', accessMethod: 'home_echo', dayKey: '2026-06-01', seq: 1 },
  ];

  it('counts unreached only among captures past the grace window', () => {
    const res = computeUnreachedCaptureRate(captures, reaches, {
      todayDayKey: '2026-06-09',
      graceDays: 2,
    });
    // 'a' and 'b' are past grace (8 days old); 'c' is fresh. b is unreached.
    expect(res).toEqual({ rate: 0.5, unreached: 1, total: 2 });
  });

  it('does not count a reach dated after the snapshot day (point-in-time correct)', () => {
    // As of 06-09, capture 'a' (06-01, past grace) has no reach yet — its only reach
    // is dated 06-20, in the snapshot's future. It must read as unreached.
    const futureReach: FirstReachRecord[] = [
      { captureId: 'a', accessMethod: 'home_echo', dayKey: '2026-06-20', seq: 1 },
    ];
    const res = computeUnreachedCaptureRate([captures[0]], futureReach, {
      todayDayKey: '2026-06-09',
      graceDays: 2,
    });
    expect(res).toEqual({ rate: 1, unreached: 1, total: 1 });
  });

  it('is null when no captures are past grace yet', () => {
    expect(
      computeUnreachedCaptureRate(captures, reaches, { todayDayKey: '2026-06-10', graceDays: 30 }),
    ).toEqual({ rate: null, unreached: 0, total: 0 });
  });
});

describe('PII-free prop-key contract (locks the shape for the emitter ticket)', () => {
  it('item_captured carries exactly its documented keys', () => {
    expect([...ITEM_CAPTURED_KEYS]).toEqual([
      'capture_id',
      'item_type',
      'capture_surface',
      'capture_origin', // NEX-200: Home vs Command capture-initiation dimension
      'local_day_key',
    ]);
  });

  it('captured_item_first_reached carries exactly its documented keys', () => {
    expect([...CAPTURED_ITEM_FIRST_REACHED_KEYS]).toEqual([
      'capture_id',
      'item_type',
      'age_bucket',
      'surface',
      'access_method',
    ]);
  });

  it('app_opened carries exactly its documented keys', () => {
    expect([...APP_OPENED_KEYS]).toEqual(['local_day_key', 'days_since_last_active_day']);
  });
});

describe('itemTypeForSurface (NEX-222)', () => {
  it('maps each surface to a closed item-type enum (home_today is the habit surface)', () => {
    expect(itemTypeForSurface('inbox')).toBe('one_off');
    expect(itemTypeForSurface('orbit')).toBe('recurring');
    expect(itemTypeForSurface('home_today')).toBe('habit');
    expect(itemTypeForSurface('align')).toBe('mandate');
    expect(itemTypeForSurface('calendar')).toBe('calendar');
  });
});

describe('extractCaptures (NEX-222)', () => {
  it('extracts non-failed rows that created an entity on a known surface', () => {
    const ledger: LedgerRowLike[] = [
      { status: 'success', entityId: 'a', surface: 'inbox' },
      { status: 'partial', entityId: 'b', surface: 'home_today' }, // local entity exists → counts
    ];
    expect(extractCaptures(ledger)).toEqual([
      { captureId: 'a', itemType: 'one_off', surface: 'inbox' },
      { captureId: 'b', itemType: 'habit', surface: 'home_today' },
    ]);
  });

  it('excludes failed rows, rows without an entityId, and rows without a surface', () => {
    const ledger: LedgerRowLike[] = [
      { status: 'failed', entityId: 'x', surface: 'inbox' }, // failed
      { status: 'success', surface: 'calendar' }, // raw calendar event, no entityId
      { status: 'success', entityId: 'y' }, // no surface
    ];
    expect(extractCaptures(ledger)).toEqual([]);
  });
});
