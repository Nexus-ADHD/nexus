import React, { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text } from 'react-native';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { Sheet } from '../../components/ui/Sheet';
import { useAppState } from '../../state/app-state';
import tokens from '../../theme/tokens';
import { getLocalDateKey } from '../../utils/recurrence';
import { haptic } from '../../utils/haptics';
import { shouldShowEmailAsk } from './email-ask-gating';
import { readStoreReviewAttempt } from './store-review';
import type { StoreReviewAttemptRecord } from './review-prompt-gating';
import { subscribeToStoreReviewAttempts } from './store-review-attempt-events';

/** A separate, explicit weekly-email invitation shown after the review moment. */
export default function EmailOptInSheet() {
  const isActivated = useAppState((s) => s.isActivated);
  const analyticsConsent = useAppState((s) => s.analyticsConsent);
  const emailConsent = useAppState((s) => s.weeklyEmailConsent);
  const habitLog = useAppState((s) => s.habitLog);
  const setWeeklyEmail = useAppState((s) => s.setWeeklyEmail);
  const [reviewAttempt, setReviewAttempt] = useState<StoreReviewAttemptRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [todayKey, setTodayKey] = useState(() => getLocalDateKey(new Date()));

  useEffect(() => {
    let cancelled = false;
    let dayTimer: ReturnType<typeof setTimeout> | undefined;

    const applyRecord = (record: StoreReviewAttemptRecord) => {
      if (cancelled) return;
      setReviewAttempt((current) => (
        !current || record.attemptedAt >= current.attemptedAt ? record : current
      ));
      setLoaded(true);
    };

    const refresh = async () => {
      const record = await readStoreReviewAttempt();
      if (cancelled) return;
      if (record) applyRecord(record);
      else setLoaded(true);
      setTodayKey(getLocalDateKey(new Date()));
    };

    const scheduleDayRollover = () => {
      if (dayTimer) clearTimeout(dayTimer);
      const now = new Date();
      const nextDay = new Date(now);
      nextDay.setDate(now.getDate() + 1);
      nextDay.setHours(0, 0, 1, 0);
      dayTimer = setTimeout(() => {
        void refresh();
        scheduleDayRollover();
      }, nextDay.getTime() - now.getTime());
    };

    const unsubscribe = subscribeToStoreReviewAttempts(applyRecord);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refresh();
        scheduleDayRollover();
      }
    });
    void refresh();
    scheduleDayRollover();

    return () => {
      cancelled = true;
      unsubscribe();
      appStateSubscription.remove();
      if (dayTimer) clearTimeout(dayTimer);
    };
  }, []);

  const visible = loaded && shouldShowEmailAsk({
    isActivated,
    analyticsConsent,
    emailConsent,
    habitLog: habitLog ?? [],
    reviewAttempt,
    todayKey,
  });

  const decide = (enabled: boolean) => {
    haptic(enabled ? 'buttonPrimary' : 'buttonSecondary');
    // A call without a day is an explicit consent decision in app-state.
    setWeeklyEmail(enabled);
  };

  return (
    <Sheet
      visible={visible}
      variant="center"
      onDismiss={() => decide(false)}
      dismissOnBackdropPress={false}
      accessibilityLabel="Weekly email invitation"
    >
      <Text style={styles.eyebrow}>WEEKLY EMAIL</Text>
      <Text style={styles.title}>Keep your progress close</Text>
      <Text style={styles.body}>
        Get one calm email with your habits, reps, and wins. This summary comes once a week. Turn it off anytime in Settings.
      </Text>

      <PrimaryPill fullWidth onPress={() => decide(true)} style={styles.primary}>
        Turn on weekly email
      </PrimaryPill>
      <Pressable
        style={styles.secondary}
        onPress={() => decide(false)}
        accessibilityRole="button"
        accessibilityLabel="No weekly email"
      >
        <Text style={styles.secondaryText}>No weekly email</Text>
      </Pressable>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    ...tokens.type.labelTrackedLg,
    color: tokens.color.gold,
    marginBottom: tokens.spacing.sm,
  },
  title: {
    ...tokens.type.poeticMd,
    color: tokens.color.text,
    marginBottom: tokens.spacing.sm,
  },
  body: {
    ...tokens.type.bodyMd,
    color: tokens.color.textMuted,
    lineHeight: 22,
    marginBottom: tokens.spacing.lg,
  },
  primary: { marginBottom: tokens.spacing.xs },
  secondary: { alignItems: 'center', paddingVertical: tokens.spacing.sm },
  secondaryText: { ...tokens.type.bodyMd, color: tokens.color.textMuted },
});
