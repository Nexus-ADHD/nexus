import { describe, expect, it } from 'vitest';
import { selectRuleIdsToDelete } from '../rule-delete-selection';

const EXISTING = ['a', 'b', 'c'];

describe('selectRuleIdsToDelete', () => {
  // THE BUG. Deleting one block used to remove every rule matching by
  // normalized title and ±5 minutes — a check that defaults to "close enough"
  // when either clock is unparseable. Two distinct routines sharing a title
  // were both destroyed.
  it('deletes ONLY the acted-on rule, never its look-alikes', () => {
    const r = selectRuleIdsToDelete({
      explicitId: 'a',
      existingIds: EXISTING,
      matchedIds: ['a', 'b', 'c'], // b and c merely look like it
    });
    expect(r).toEqual({ ids: ['a'], outcome: 'explicit' });
  });

  it('falls back to a title/time match only when it is unique', () => {
    expect(selectRuleIdsToDelete({ explicitId: null, existingIds: EXISTING, matchedIds: ['b'] }))
      .toEqual({ ids: ['b'], outcome: 'unique-match' });
  });

  // Refusing is recoverable; deleting someone's other routine is not.
  it('deletes NOTHING when the fallback is ambiguous', () => {
    const r = selectRuleIdsToDelete({
      explicitId: null,
      existingIds: EXISTING,
      matchedIds: ['a', 'b'],
    });
    expect(r).toEqual({ ids: [], outcome: 'ambiguous' });
  });

  it('deletes nothing when nothing matches', () => {
    expect(selectRuleIdsToDelete({ explicitId: null, existingIds: EXISTING, matchedIds: [] }))
      .toEqual({ ids: [], outcome: 'none' });
  });

  // I originally asserted the OPPOSITE here — that a stale explicit id should
  // fall through and re-resolve by title/time. That was wrong, and encoding it
  // as a test made a bug look intentional. If the row says "delete rule X" and
  // X is gone, re-resolving deletes a DIFFERENT live routine that merely
  // resembles it. A stale row deletes nothing.
  it('refuses when the explicit id no longer exists — never re-resolves', () => {
    expect(selectRuleIdsToDelete({ explicitId: 'gone', existingIds: EXISTING, matchedIds: ['c'] }))
      .toEqual({ ids: [], outcome: 'stale' });
    expect(selectRuleIdsToDelete({ explicitId: 'gone', existingIds: EXISTING, matchedIds: ['a', 'b'] }))
      .toEqual({ ids: [], outcome: 'stale' });
    // even when the fuzzy match would have resolved to something plausible
    expect(selectRuleIdsToDelete({ explicitId: 'gone', existingIds: EXISTING, matchedIds: ['a'] }).ids)
      .toEqual([]);
  });

  it('an explicit id is authoritative: it either deletes itself or nothing', () => {
    for (const matchedIds of [[], ['a'], ['b', 'c'], ['a', 'b', 'c']]) {
      expect(selectRuleIdsToDelete({ explicitId: 'a', existingIds: EXISTING, matchedIds }).ids)
        .toEqual(['a']);
      expect(selectRuleIdsToDelete({ explicitId: 'gone', existingIds: EXISTING, matchedIds }).ids)
        .toEqual([]);
    }
  });

  it('ignores matched ids that are not real rules', () => {
    expect(selectRuleIdsToDelete({ explicitId: null, existingIds: EXISTING, matchedIds: ['ghost', 'b'] }))
      .toEqual({ ids: ['b'], outcome: 'unique-match' });
  });

  it('dedupes a repeated match rather than reading it as ambiguity', () => {
    expect(selectRuleIdsToDelete({ explicitId: null, existingIds: EXISTING, matchedIds: ['b', 'b'] }))
      .toEqual({ ids: ['b'], outcome: 'unique-match' });
  });

  // The invariant, stated independently of the branches above.
  it('NEVER selects more than one rule, for any input', () => {
    const ids = ['a', 'b', 'c', 'gone', null];
    for (const explicitId of ids)
      for (const m of [[], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['ghost']]) {
        const r = selectRuleIdsToDelete({ explicitId, existingIds: EXISTING, matchedIds: m });
        expect(r.ids.length).toBeLessThanOrEqual(1);
      }
  });
});
