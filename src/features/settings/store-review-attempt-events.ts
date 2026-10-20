import type { StoreReviewAttemptRecord } from './review-prompt-gating';

type StoreReviewAttemptListener = (record: StoreReviewAttemptRecord) => void;

const listeners = new Set<StoreReviewAttemptListener>();
let latestRecord: StoreReviewAttemptRecord | null = null;

/** Keeps mounted follow-up prompts in sync with a review request made this session. */
export function publishStoreReviewAttempt(record: StoreReviewAttemptRecord): void {
  latestRecord = record;
  for (const listener of listeners) listener(record);
}

export function subscribeToStoreReviewAttempts(listener: StoreReviewAttemptListener): () => void {
  listeners.add(listener);
  if (latestRecord) listener(latestRecord);
  return () => listeners.delete(listener);
}
