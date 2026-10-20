import { describe, it, expect } from 'vitest';
import { selectLeadTimeRollup } from '../selectors/lead-time';
import { LeadTimeAction } from '../lead-time-types';

const TODAY = '2026-06-14';

const make = (over: Partial<LeadTimeAction>): LeadTimeAction => ({
  id: 'id', title: 't', eventTitle: 'e', eventDate: '2026-08-01', eventId: null,
  actByDate: '2026-07-01', leadDays: 7, completed: false, createdAt: 0, source: 'manual',
  ...over,
});

describe('selectLeadTimeRollup', () => {
  it('empty / undefined → no surfacing', () => {
    const r = selectLeadTimeRollup(undefined, TODAY);
    expect(r.open).toEqual([]);
    expect(r.hasSurfacing).toBe(false);
    expect(r.counts).toEqual({ waiting: 0, due: 0, overdue: 0 });
  });

  it('excludes done items from open and surfacing', () => {
    const r = selectLeadTimeRollup(
      [make({ id: 'done', completed: true, actByDate: '2026-06-13' })],
      TODAY,
    );
    expect(r.open).toEqual([]);
    expect(r.hasSurfacing).toBe(false);
  });

  it('open is sorted by act-by date ascending', () => {
    const r = selectLeadTimeRollup(
      [
        make({ id: 'far', actByDate: '2026-08-01' }),
        make({ id: 'soon', actByDate: '2026-06-20' }),
        make({ id: 'mid', actByDate: '2026-07-10' }),
      ],
      TODAY,
    );
    expect(r.open.map((a) => a.id)).toEqual(['soon', 'mid', 'far']);
  });

  it('buckets counts and surfaces only due+overdue, overdue first', () => {
    const r = selectLeadTimeRollup(
      [
        make({ id: 'waiting', actByDate: '2026-07-01' }),   // far → waiting
        make({ id: 'due', actByDate: '2026-06-18' }),       // within 7 → due
        make({ id: 'overdue', actByDate: '2026-06-10' }),   // past → overdue
      ],
      TODAY,
    );
    expect(r.counts).toEqual({ waiting: 1, due: 1, overdue: 1 });
    expect(r.hasSurfacing).toBe(true);
    expect(r.surfacing.map((a) => a.id)).toEqual(['overdue', 'due']);
    // each surfacing row carries its derived status
    expect(r.surfacing[0].status).toBe('overdue');
  });
});
