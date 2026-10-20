/**
 * Active notification lines (NEX-277).
 *
 * AI-generated, filter-safe lines AUTO-SCHEDULE — there is no human approval gate.
 * This screen is a transparency / removal surface: it lists the personalized lines
 * currently in rotation (`live` ∪ `pending`) and lets the owner remove one. Removal
 * tombstones the line so the next generation cycle can't bring it back. Seed/floor
 * lines aren't listed here (they're the always-safe fallback). The route id stays
 * `pending-quotes` for compatibility. Spec: docs/plans/notification-quotes.md.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppState } from '@/src/state/app-state';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';

const BG = tokens.color.void;
const SURFACE = tokens.color.surface;
const BORDER = tokens.color.goldHairline;
const GOLD = tokens.color.gold;
const RED = tokens.color.stateError;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;

export default function ActiveQuotesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // live ∪ pending are both schedulable post-NEX-277; show every AI line in rotation,
  // canon-deduped so a line present in both arrays isn't listed twice. Select the two
  // STABLE store slices separately and derive the deduped list with useMemo — a
  // selector that builds a fresh array inline (Array.from/new Set/spread) returns a
  // new reference every snapshot, which under zustand v5's useSyncExternalStore loops
  // "Maximum update depth exceeded".
  const live = useAppState((s) => s.quotesPool.live);
  const pending = useAppState((s) => s.quotesPool.pending);
  const lines = React.useMemo(
    () => Array.from(new Set([...live, ...pending])),
    [live, pending],
  );
  const removeNotificationQuote = useAppState((s) => s.removeNotificationQuote);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{ title: 'Notification Lines', headerStyle: { backgroundColor: BG }, headerTintColor: TEXT }}
      />
      <AdaptiveScreen>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + tokens.spacing.md }]}
        showsVerticalScrollIndicator={false}
      >
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.backText}>‹ BACK</Text>
        </Pressable>
        <Text style={styles.title}>NOTIFICATION LINES</Text>
        <Text style={styles.subtitle}>
          These personalized lines are in rotation on your morning and evening reminders. Remove any
          that do not sound right. The curated set always remains as a fallback.
        </Text>

        {lines.length === 0 ? (
          <View style={[styles.card, { marginTop: tokens.spacing.md }]}>
            <Text style={styles.rowLabel}>No personalized lines yet.</Text>
            <Text style={styles.rowMeta}>Lines appear here as they are generated from your mandates.</Text>
          </View>
        ) : (
          lines.map((quote) => (
            <View key={quote} style={[styles.card, { marginTop: tokens.spacing.sm }]}>
              <Text style={styles.quote}>{`“${quote}”`}</Text>
              <View style={styles.actions}>
                <Pressable
                  hitSlop={8}
                  style={[styles.btn, styles.removeBtn]}
                  onPress={() => { haptic('buttonSecondary'); removeNotificationQuote(quote); }}
                >
                  <Text style={[styles.btnText, { color: RED }]}>REMOVE</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </ScrollView>
      </AdaptiveScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  scroll: { paddingHorizontal: tokens.spacing.lg, paddingBottom: 80 },
  back: { paddingVertical: tokens.spacing.xs, marginBottom: tokens.spacing.xs },
  backText: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  title: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 4, marginBottom: tokens.spacing.sm },
  subtitle: { color: MUTED, fontSize: 13, lineHeight: 19, marginBottom: 18 },
  card: {
    backgroundColor: SURFACE,
    borderColor: BORDER,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: tokens.spacing.md,
  },
  quote: { color: TEXT, fontSize: 16, lineHeight: 22 },
  rowLabel: { color: TEXT, fontSize: 15, fontWeight: '700' },
  rowMeta: { color: MUTED, fontSize: 13, marginTop: 4 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: tokens.spacing.sm, marginTop: tokens.spacing.md },
  btn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 9999, borderWidth: 1 },
  removeBtn: { borderColor: RED },
  btnText: { fontSize: 11, fontWeight: '900', letterSpacing: 2 },
});
