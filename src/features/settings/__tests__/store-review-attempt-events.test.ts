import { describe, expect, it, vi } from 'vitest';
import {
  publishStoreReviewAttempt,
  subscribeToStoreReviewAttempts,
} from '../store-review-attempt-events';

describe('store review attempt events', () => {
  it('updates mounted listeners, replays the latest attempt, and cleans up', () => {
    const record = {
      status: 'attempted' as const,
      appVersion: '2.1',
      dayKey: '2026-09-10',
      attemptedAt: 100,
    };
    const mountedListener = vi.fn();
    const unsubscribe = subscribeToStoreReviewAttempts(mountedListener);

    publishStoreReviewAttempt(record);
    expect(mountedListener).toHaveBeenCalledWith(record);

    const lateListener = vi.fn();
    const unsubscribeLate = subscribeToStoreReviewAttempts(lateListener);
    expect(lateListener).toHaveBeenCalledWith(record);

    unsubscribe();
    unsubscribeLate();
    publishStoreReviewAttempt({ ...record, attemptedAt: 200 });
    expect(mountedListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledTimes(1);
  });
});
