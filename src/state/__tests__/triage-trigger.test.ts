import { describe, it, expect } from 'vitest';
import { shouldTriggerTriage } from '../triage-decisions';

describe('shouldTriggerTriage', () => {
  it('first connect with new items → triggers', () => {
    expect(
      shouldTriggerTriage({
        triageCompletedAt: null,
        lastSyncedAt: null,
        added: 5,
      }),
    ).toBe(true);
  });

  it('triage already completed → does NOT trigger (even on a fresh sync)', () => {
    expect(
      shouldTriggerTriage({
        triageCompletedAt: 1_700_000_000_000,
        lastSyncedAt: null,
        added: 5,
      }),
    ).toBe(false);
  });

  it('not the first sync (lastSyncedAt set) → does NOT trigger', () => {
    expect(
      shouldTriggerTriage({
        triageCompletedAt: null,
        lastSyncedAt: 1_700_000_000_000,
        added: 5,
      }),
    ).toBe(false);
  });

  it('first sync but nothing was added → does NOT trigger', () => {
    expect(
      shouldTriggerTriage({
        triageCompletedAt: null,
        lastSyncedAt: null,
        added: 0,
      }),
    ).toBe(false);
  });
});
