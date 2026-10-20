import { describe, expect, it } from 'vitest';
import { getProposalExecutionKey } from '../command-executor';
import type { ProposedAction } from '../command-types';

// NEX-225: the duplicate-execution guard key must include frequency
// (timesPerDay + interval). Two captures that differ ONLY by frequency must
// produce DISTINCT keys, or the dedup guard drops the second as a duplicate.
describe('getProposalExecutionKey (NEX-225 frequency in dedup key)', () => {
  const base = (over: Partial<ProposedAction>): ProposedAction => ({
    type: 'recurring_add',
    title: 'read my mantras',
    ...over,
  });

  it('distinguishes habits that differ only by timesPerDay', () => {
    // "read my mantras twice a day" vs "...three times a day"
    const twice = getProposalExecutionKey([base({ timesPerDay: 2 })]);
    const thrice = getProposalExecutionKey([base({ timesPerDay: 3 })]);
    expect(twice).not.toBe(thrice);
  });

  it('distinguishes recurring to-dos that differ only by interval', () => {
    // weekly (interval 1 / undefined) vs biweekly (interval 2) of the same title
    const weekly = getProposalExecutionKey([
      base({ type: 'recurring_todo_add', daysOfWeek: [2] }),
    ]);
    const biweekly = getProposalExecutionKey([
      base({ type: 'recurring_todo_add', daysOfWeek: [2], interval: 2 }),
    ]);
    expect(weekly).not.toBe(biweekly);
  });

  it('distinguishes captures that differ only by description/notes', () => {
    // description writes to the created entity, so it is execution-affecting.
    const a = getProposalExecutionKey([base({ description: 'before bed' })]);
    const b = getProposalExecutionKey([base({ description: 'after lunch' })]);
    expect(a).not.toBe(b);
  });

  it('still treats two truly identical proposals as the same key', () => {
    // Guard against over-keying: same frequency + everything else → one key.
    const a = getProposalExecutionKey([base({ timesPerDay: 2 })]);
    const b = getProposalExecutionKey([base({ timesPerDay: 2 })]);
    expect(a).toBe(b);
  });

  it('treats absent frequency (undefined) as null, stable across calls', () => {
    const a = getProposalExecutionKey([base({})]);
    const b = getProposalExecutionKey([base({})]);
    expect(a).toBe(b);
    // and is distinct from an explicit frequency
    expect(a).not.toBe(getProposalExecutionKey([base({ timesPerDay: 2 })]));
  });
});
