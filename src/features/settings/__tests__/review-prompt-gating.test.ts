import { describe, expect, it } from 'vitest';
import {
  hasDemonstratedValue,
  shouldAttemptStoreReview,
  STORE_REVIEW_COOLDOWN_MS,
  type StoreReviewAttemptRecord,
} from '../review-prompt-gating';

const logs = (days: string[]) => days.map((dateKey, index) => ({
  id: String(index), habitTitle: 'meditate', goalIds: [], dateKey, timestamp: index,
}));

describe('store review gating', () => {
  const qualified = logs([
    '2026-09-01', '2026-09-01', '2026-09-02', '2026-09-02',
    '2026-09-03', '2026-09-03', '2026-09-03',
  ]);

  it('requires seven completions across at least three days', () => {
    expect(hasDemonstratedValue(qualified)).toBe(true);
    expect(hasDemonstratedValue(qualified.slice(0, 6))).toBe(false);
    expect(hasDemonstratedValue(logs(Array(7).fill('2026-09-01')))).toBe(false);
  });

  it('allows the first eligible iOS attempt', () => {
    expect(shouldAttemptStoreReview({
      isIos: true, isActivated: true, appVersion: '2.1', habitLog: qualified,
      previous: null, nowMs: 100,
    })).toBe(true);
  });

  it('never retries in the same marketing version', () => {
    const previous: StoreReviewAttemptRecord = {
      status: 'unavailable', appVersion: '2.1', dayKey: '2026-09-03', attemptedAt: 100,
    };
    expect(shouldAttemptStoreReview({
      isIos: true, isActivated: true, appVersion: '2.1', habitLog: qualified,
      previous, nowMs: 200,
    })).toBe(false);
  });

  it('keeps a 90-day cooldown between actual requests across versions', () => {
    const previous: StoreReviewAttemptRecord = {
      status: 'attempted', appVersion: '2.0', dayKey: '2026-09-03', attemptedAt: 100,
    };
    expect(shouldAttemptStoreReview({
      isIos: true, isActivated: true, appVersion: '2.1', habitLog: qualified,
      previous, nowMs: 100 + STORE_REVIEW_COOLDOWN_MS - 1,
    })).toBe(false);
    expect(shouldAttemptStoreReview({
      isIos: true, isActivated: true, appVersion: '2.1', habitLog: qualified,
      previous, nowMs: 100 + STORE_REVIEW_COOLDOWN_MS,
    })).toBe(true);
  });
});
