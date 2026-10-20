import type { HabitLogEntry } from '../../state/app-state';

export const STORE_REVIEW_ATTEMPT_KEY = 'nexus_storeReviewAttempt';
export const STORE_REVIEW_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

export type StoreReviewAttemptStatus = 'attempted' | 'unavailable';

export interface StoreReviewAttemptRecord {
  status: StoreReviewAttemptStatus;
  appVersion: string;
  dayKey: string;
  attemptedAt: number;
}
export function hasDemonstratedValue(habitLog: HabitLogEntry[]): boolean {
  const valid = habitLog.filter(
    (entry) => entry && typeof entry.dateKey === 'string' && entry.dateKey.length === 10,
  );
  return valid.length >= 7 && new Set(valid.map((entry) => entry.dateKey)).size >= 3;
}

export function parseStoreReviewAttemptRecord(raw: string | null): StoreReviewAttemptRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      (parsed?.status === 'attempted' || parsed?.status === 'unavailable') &&
      typeof parsed.appVersion === 'string' &&
      typeof parsed.dayKey === 'string' &&
      typeof parsed.attemptedAt === 'number'
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

export function shouldAttemptStoreReview(opts: {
  isIos: boolean;
  isActivated: boolean;
  appVersion: string | null;
  habitLog: HabitLogEntry[];
  previous: StoreReviewAttemptRecord | null;
  nowMs: number;
}): boolean {
  if (!opts.isIos || !opts.isActivated || !opts.appVersion) return false;
  if (!hasDemonstratedValue(opts.habitLog)) return false;
  if (opts.previous?.appVersion === opts.appVersion) return false;
  if (
    opts.previous?.status === 'attempted' &&
    opts.nowMs - opts.previous.attemptedAt < STORE_REVIEW_COOLDOWN_MS
  ) {
    return false;
  }
  return true;
}
