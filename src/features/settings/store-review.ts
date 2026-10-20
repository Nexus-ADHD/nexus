import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { useAppState } from '../../state/app-state';
import { getLocalDateKey } from '../../utils/recurrence';
import { isDevSkipSessionActive } from '../../utils/dev-skip-session';
import {
  parseStoreReviewAttemptRecord,
  shouldAttemptStoreReview,
  STORE_REVIEW_ATTEMPT_KEY,
  type StoreReviewAttemptRecord,
} from './review-prompt-gating';
import { publishStoreReviewAttempt } from './store-review-attempt-events';

let reviewRequestInFlight = false;

export async function readStoreReviewAttempt(): Promise<StoreReviewAttemptRecord | null> {
  try {
    return parseStoreReviewAttemptRecord(await AsyncStorage.getItem(STORE_REVIEW_ATTEMPT_KEY));
  } catch {
    return null;
  }
}

/**
 * Requests Apple's native review sheet after a real Home habit completion.
 * Apple decides whether a dialog is shown, so this records only the request
 * attempt (or confirmed unavailability), never a claimed impression.
 */
export async function maybeRequestStoreReviewAfterHabitCompletion(): Promise<void> {
  if (reviewRequestInFlight) return;
  if (__DEV__ && isDevSkipSessionActive()) return;

  reviewRequestInFlight = true;
  try {
    const state = useAppState.getState();
    const appVersion = Application.nativeApplicationVersion ?? null;
    const nowMs = Date.now();
    const previous = await readStoreReviewAttempt();
    if (!shouldAttemptStoreReview({
      isIos: Platform.OS === 'ios',
      isActivated: state.isActivated,
      appVersion,
      habitLog: state.habitLog ?? [],
      previous,
      nowMs,
    })) return;

    const StoreReview = await import('expo-store-review');
    const available = await StoreReview.isAvailableAsync();
    const record: StoreReviewAttemptRecord = {
      status: available ? 'attempted' : 'unavailable',
      appVersion: appVersion!,
      dayKey: getLocalDateKey(new Date(nowMs)),
      attemptedAt: nowMs,
    };

    // Claim before invoking the system controller so a foreground/background
    // transition cannot race a second request. Apple may still choose not to
    // display a dialog; the record intentionally does not call this "shown".
    await AsyncStorage.setItem(STORE_REVIEW_ATTEMPT_KEY, JSON.stringify(record));
    publishStoreReviewAttempt(record);
    if (available) await StoreReview.requestReview();
  } catch {
    // A review request is never important enough to interrupt habit completion.
  } finally {
    reviewRequestInFlight = false;
  }
}
