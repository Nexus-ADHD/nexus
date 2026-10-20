import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBarScrim } from '../../components/ui/StatusBarScrim';
import { ListRow, TRAILING_MAX_SCALE } from '../../components/ui/ListRow';
import { ListSection } from '../../components/ui/ListSection';
import tokens from '../../theme/tokens';
import { AdaptiveScreen } from '../../components/ui/AdaptiveScreen';
import { haptic } from '../../utils/haptics';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { getCalendarProviderConfigStatus, type ExternalCalendarProvider } from '../../services/external-calendars';
import { useCalendarSourcesStore } from '../../state/calendar-sources-store';

const PROVIDERS: Array<{ id: ExternalCalendarProvider; label: string; description: string }> = [
  { id: 'google', label: 'Google Calendar', description: 'Gmail, Workspace, and shared Google calendars.' },
  { id: 'outlook', label: 'Outlook Calendar', description: 'Microsoft 365, Outlook.com, and Exchange calendars.' },
];

export function CalendarSettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accounts, connectProvider, disconnectAccount, syncWindow, lastSyncedAt, syncError } = useCalendarSourcesStore();
  const [busyProvider, setBusyProvider] = useState<ExternalCalendarProvider | null>(null);
  const [syncing, setSyncing] = useState(false);

  const accountsByProvider = useMemo(() => {
    const map: Partial<Record<ExternalCalendarProvider, typeof accounts[number]>> = {};
    accounts.forEach((account) => {
      map[account.provider] = account;
    });
    return map;
  }, [accounts]);

  const connect = async (provider: ExternalCalendarProvider) => {
    setBusyProvider(provider);
    try {
      await connectProvider(provider);
      const start = new Date();
      start.setDate(start.getDate() - 7);
      const end = new Date();
      end.setMonth(end.getMonth() + 3);
      await syncWindow(start, end);
      haptic('voiceSuccess');
    } catch (e: any) {
      haptic('voiceAmbiguous');
      Alert.alert('Calendar connection failed', e?.message || 'Try again from Settings.');
    } finally {
      setBusyProvider(null);
    }
  };

  const disconnect = (accountId: string, label: string) => {
    Alert.alert(`Disconnect ${label}?`, 'Nexus will stop reading this calendar account. Your calendar events stay where they are.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          await disconnectAccount(accountId);
          haptic('buttonSecondary');
        },
      },
    ]);
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const start = new Date();
      start.setDate(start.getDate() - 30);
      const end = new Date();
      end.setFullYear(end.getFullYear() + 1);
      await syncWindow(start, end);
      haptic('voiceSuccess');
    } catch (e: any) {
      haptic('voiceAmbiguous');
      Alert.alert('Calendar sync failed', e?.message || 'Try again in a moment.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Calendars', headerStyle: { backgroundColor: tokens.color.void }, headerTintColor: tokens.color.text }} />
      <AdaptiveScreen>
      <ScrollView style={styles.container} contentContainerStyle={[styles.scroll, { paddingTop: insets.top + tokens.spacing.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ SETTINGS</Text>
        </Pressable>

        <Text style={styles.title}>CALENDARS</Text>
        <Text style={styles.subtitle}>
          Apple Calendar stays automatic. Connect Google or Outlook when those calendars are where your real schedule lives.
        </Text>

        <ListSection style={{ marginBottom: tokens.spacing.sm }}>
          <ListRow
            title="Apple Calendar"
            subtitle="Read through iOS EventKit permissions."
            trailing="custom"
            // Static badge the kit cannot read. accessoryLabel (not
            // accessibilityLabel) so the subtitle is still announced.
            accessoryLabel="native"
            trailingAccessory={<Text style={styles.status} maxFontSizeMultiplier={TRAILING_MAX_SCALE}>NATIVE</Text>}
          />
        </ListSection>

        <ListSection>
          {PROVIDERS.map((provider) => {
            const account = accountsByProvider[provider.id];
            const config = getCalendarProviderConfigStatus(provider.id);
            const busy = busyProvider === provider.id;
            return (
              <ListRow
                key={provider.id}
                title={provider.label}
                subtitle={account ? account.email : provider.description}
                // Its own gold line, not folded into the subtitle: the subtitle
                // caps at 2 lines and both provider descriptions wrap, so a
                // concatenated warning is pushed off the row (D4).
                footnote={!config.isConfigured ? 'OAuth client id not configured.' : undefined}
                trailing="custom"
                // CONNECT / DISCONNECT is a real control the user must reach.
                interactiveAccessory
                trailingAccessory={
                  account ? (
                    <Pressable style={styles.secondaryButton} onPress={() => disconnect(account.id, provider.label)}>
                      <Text style={styles.secondaryButtonText}>DISCONNECT</Text>
                    </Pressable>
                  ) : (
                    <PrimaryPill
                      size="compact"
                      disabled={!config.isConfigured || busy}
                      onPress={() => connect(provider.id)}
                    >
                      {busy ? 'CONNECTING' : 'CONNECT'}
                    </PrimaryPill>
                  )
                }
              />
            );
          })}
        </ListSection>

        <PrimaryPill
          fullWidth
          style={{ marginTop: tokens.spacing.md }}
          disabled={!accounts.length || syncing}
          onPress={syncNow}
        >
          {syncing ? 'SYNCING' : 'SYNC NOW'}
        </PrimaryPill>

        {lastSyncedAt ? <Text style={styles.meta}>Last synced {new Date(lastSyncedAt).toLocaleString()}</Text> : null}
        {syncError ? <Text style={styles.error}>{syncError}</Text> : null}
      </ScrollView>
      </AdaptiveScreen>
      <StatusBarScrim />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: tokens.color.void },
  scroll: { padding: tokens.spacing.lg, paddingBottom: 80 },
  back: { color: tokens.color.gold, fontSize: 11, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.lg },
  title: { color: tokens.color.text, fontSize: 28, fontWeight: '800', marginBottom: tokens.spacing.xs },
  subtitle: { color: tokens.color.textSecondary, fontSize: 14, lineHeight: 22, marginBottom: tokens.spacing.lg },
  status: { color: tokens.color.teal, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  secondaryButton: { borderColor: tokens.color.goldHairline, borderWidth: 1, borderRadius: 999, paddingHorizontal: tokens.spacing.md, paddingVertical: tokens.spacing.xs },
  secondaryButtonText: { color: tokens.color.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  meta: { color: tokens.color.textMuted, fontSize: 12, textAlign: 'center', marginTop: tokens.spacing.md },
  error: { color: tokens.color.stateError, fontSize: 12, textAlign: 'center', marginTop: tokens.spacing.sm },
});

