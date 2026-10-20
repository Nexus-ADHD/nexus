import { describe, it, expect } from 'vitest';
import {
  addMinutesToHHMM,
  wideBlockEndTime,
  isNativeTimeBlock,
  selectJustPassedBlock,
  nextFreeStart,
  localMinutesOf,
  TIME_BLOCK_DEFAULT_DURATION_MINUTES,
} from '../time-blocks';

const hm = (h: number, m = 0) => h * 60 + m;

const block = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  eventType: 'time_block',
  source: 'manual',
  endDate: '2026-06-19T10:00:00.000Z',
  ...over,
});

describe('addMinutesToHHMM', () => {
  it('adds the wide 90-min default within the day', () => {
    expect(addMinutesToHHMM('09:00', TIME_BLOCK_DEFAULT_DURATION_MINUTES)).toBe('10:30');
  });

  it('wraps past midnight', () => {
    expect(addMinutesToHHMM('23:30', 90)).toBe('01:00');
    expect(addMinutesToHHMM('23:59', 1)).toBe('00:00');
  });

  it('handles exact-hour and non-aligned starts', () => {
    expect(addMinutesToHHMM('13:15', 90)).toBe('14:45');
    expect(addMinutesToHHMM('00:00', 90)).toBe('01:30');
  });

  it('wraps negative offsets', () => {
    expect(addMinutesToHHMM('00:30', -90)).toBe('23:00');
  });

  it('falls back to 0 components on malformed input', () => {
    expect(addMinutesToHHMM('', 90)).toBe('01:30');
    expect(addMinutesToHHMM('nope', 90)).toBe('01:30');
  });

  it('keeps the default at 90', () => {
    expect(TIME_BLOCK_DEFAULT_DURATION_MINUTES).toBe(90);
  });
});

describe('wideBlockEndTime', () => {
  it('returns start + 90 within the day', () => {
    expect(wideBlockEndTime('09:00')).toBe('10:30');
    expect(wideBlockEndTime('13:15')).toBe('14:45');
  });

  it('clamps to 23:59 when start + 90 would wrap past midnight', () => {
    expect(wideBlockEndTime('23:30')).toBe('23:59'); // would be 01:00
    expect(wideBlockEndTime('22:30')).toBe('23:59'); // would be 00:00
    expect(wideBlockEndTime('23:00')).toBe('23:59'); // would be 00:30
  });

  it('does not clamp the exact-fit boundary', () => {
    expect(wideBlockEndTime('22:29')).toBe('23:59'); // 22:29 + 90 = 23:59, no wrap
  });
});

describe('isNativeTimeBlock', () => {
  it('accepts a manual time_block', () => {
    expect(isNativeTimeBlock(block())).toBe(true);
  });
  it('rejects appointments, routines, apple events, and all-day blocks', () => {
    expect(isNativeTimeBlock(block({ eventType: 'appointment' }))).toBe(false);
    expect(isNativeTimeBlock(block({ source: 'routine' }))).toBe(false);
    expect(isNativeTimeBlock(block({ source: 'calendar' }))).toBe(false);
    expect(isNativeTimeBlock(block({ allDay: true }))).toBe(false);
    expect(isNativeTimeBlock(null)).toBe(false);
    expect(isNativeTimeBlock(undefined)).toBe(false);
  });
});

describe('selectJustPassedBlock', () => {
  const NOON = Date.parse('2026-06-19T12:00:00.000Z');

  it('returns null when nothing has passed', () => {
    expect(selectJustPassedBlock([], NOON)).toBeNull();
    expect(selectJustPassedBlock([block({ endDate: '2026-06-19T14:00:00.000Z' })], NOON)).toBeNull();
  });

  it('returns the single passed block', () => {
    const b = block({ id: 'a', endDate: '2026-06-19T10:00:00.000Z' });
    expect(selectJustPassedBlock([b], NOON)?.id).toBe('a');
  });

  it('picks the most-recently-ended of several passed blocks', () => {
    const early = block({ id: 'early', endDate: '2026-06-19T08:00:00.000Z' });
    const late = block({ id: 'late', endDate: '2026-06-19T11:30:00.000Z' });
    const future = block({ id: 'future', endDate: '2026-06-19T15:00:00.000Z' });
    expect(selectJustPassedBlock([early, late, future], NOON)?.id).toBe('late');
  });

  it('ignores non-native, all-day, and undated events', () => {
    const appt = block({ id: 'appt', eventType: 'appointment', endDate: '2026-06-19T11:00:00.000Z' });
    const allDay = block({ id: 'allDay', allDay: true, endDate: '2026-06-19T11:00:00.000Z' });
    const undated = block({ id: 'undated', endDate: undefined });
    expect(selectJustPassedBlock([appt, allDay, undated], NOON)).toBeNull();
  });

  it('treats end exactly at now as passed', () => {
    const b = block({ id: 'edge', endDate: '2026-06-19T12:00:00.000Z' });
    expect(selectJustPassedBlock([b], NOON)?.id).toBe('edge');
  });
});

describe('nextFreeStart', () => {
  it('returns the rounded earliest time when the day is empty', () => {
    expect(nextFreeStart([], 90, hm(13, 7))).toBe(hm(13, 15)); // ceil to next 15
    expect(nextFreeStart([], 90, hm(13, 0))).toBe(hm(13, 0));
  });

  it('jumps past an overlapping blocker to its (rounded) end', () => {
    // want 90min from 13:00, but 13:00–14:20 is taken → next is 14:30 (ceil15)
    expect(nextFreeStart([{ startMin: hm(13), endMin: hm(14, 20) }], 90, hm(13, 0))).toBe(hm(14, 30));
  });

  it('fits into a gap before the next blocker', () => {
    // 30min from 13:00, blocker 14:00–15:00 → 13:00 fits (ends 13:30 < 14:00)
    expect(nextFreeStart([{ startMin: hm(14), endMin: hm(15) }], 30, hm(13, 0))).toBe(hm(13, 0));
  });

  it('walks past several stacked blockers', () => {
    const blockers = [
      { startMin: hm(13), endMin: hm(14) },
      { startMin: hm(14), endMin: hm(15) },
      { startMin: hm(15), endMin: hm(16) },
    ];
    expect(nextFreeStart(blockers, 60, hm(13, 0))).toBe(hm(16, 0));
  });

  it('returns null when no room remains before day-end', () => {
    // 23:00 earliest, 90min needed, day-end 23:59 → 23:00+90=00:30 > 23:59
    expect(nextFreeStart([], 90, hm(23, 0))).toBeNull();
  });

  it('returns null for a blocker wall that pushes past day-end', () => {
    expect(nextFreeStart([{ startMin: hm(13), endMin: hm(23, 30) }], 60, hm(13, 0))).toBeNull();
  });

  it('ignores degenerate/zero-width blockers and bad duration', () => {
    expect(nextFreeStart([{ startMin: hm(13), endMin: hm(13) }], 30, hm(13, 0))).toBe(hm(13, 0));
    expect(nextFreeStart([], 0, hm(13, 0))).toBeNull();
    expect(nextFreeStart([], -5, hm(13, 0))).toBeNull();
  });
});

describe('localMinutesOf', () => {
  it('returns local hour*60+min for a valid date', () => {
    const d = new Date(2026, 5, 19, 9, 30);
    expect(localMinutesOf(d.toISOString())).toBe(hm(9, 30));
  });
  it('returns NaN for empty/invalid input', () => {
    expect(Number.isNaN(localMinutesOf(undefined))).toBe(true);
    expect(Number.isNaN(localMinutesOf('not-a-date'))).toBe(true);
  });
});
