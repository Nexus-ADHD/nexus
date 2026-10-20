import type { AnalyticsConsent, HabitLogEntry, WeeklyEmailConsent } from '../../state/app-state';
import { hasDemonstratedValue, type StoreReviewAttemptRecord } from './review-prompt-gating';

export function shouldShowEmailAsk(opts: {
  isActivated: boolean;
  analyticsConsent: AnalyticsConsent;
  emailConsent: WeeklyEmailConsent;
  habitLog: HabitLogEntry[];
  reviewAttempt: StoreReviewAttemptRecord | null;
  todayKey: string;
}): boolean {
  if (!opts.isActivated || opts.analyticsConsent === 'unset') return false;
  if (opts.emailConsent !== 'unset') return false;
  if (!hasDemonstratedValue(opts.habitLog)) return false;
  if (!opts.reviewAttempt) return false;
  return opts.todayKey > opts.reviewAttempt.dayKey;
}
