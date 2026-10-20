/**
 * Apple Reminders settings screen — Phase 1.
 *
 * Surfaces:
 *   - Connection status pill (CONNECTED / NOT CONNECTED).
 *   - Primary CTA (Connect or Disconnect).
 *   - Per-list toggle switches once permission granted.
 *   - Optional "Create Nexus list" action when no list named "Nexus"
 *     exists yet.
 *   - Footer: "Last synced: never" placeholder for Phase 2.
 *
 * No actual reminder fetching happens here; that lands in Phase 2.
 */
// @ts-nocheck
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Alert,
  Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBarScrim } from '@/src/components/ui/StatusBarScrim';
import { ListRow } from '@/src/components/ui/ListRow';
import { Toggle } from '@/src/components/ui/Toggle';
import { ListSection } from '@/src/components/ui/ListSection';
import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { useRemindersStore } from '../../src/state/reminders-store';
import tokens from '@/src/theme/tokens';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';

const BG = tokens.color.void;
const SURFACE = tokens.color.surface;
// FIXME(nex-56): neutral border, no token — design review (CLAUDE.md §6.2 wants gold hairline)
const BORDER = tokens.color.goldHairline;
const GOLD = tokens.color.gold;
const TEXT = tokens.color.text;
// FIXME(nex-56): off-scale gray; consider textMuted or design review
const MUTED = tokens.color.textMuted;
// FIXME(nex-56): connection-state palette — green ok / red not-connected, no tokens — design review (CLAUDE.md uses teal for success and stateError #C6523A for warm-muted red)
const GREEN = tokens.color.teal;
const RED = tokens.color.stateError;
// FIXME(nex-56): JSX-attribute hex hazard — Switch thumb inactive, off-scale gray

export default function AppleRemindersSettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    permissionStatus,
    syncedListIds,
    availableLists,
    lastSyncedAt,
    isConnected,
    connectIntegration,
    disconnectIntegration,
    toggleListSync,
    refreshLists,
    createNexusList,
  } = useRemindersStore() as any;

  const [working, setWorking] = useState(false);
  const connected = isConnected();
  const hasNexusList = (availableLists || []).some((l: any) => l.isNexus);

  // Refresh the iOS-side view of permissions + lists when the screen
  // mounts. Catches the case where the user flipped permission in
  // iOS Settings while Nexus was backgrounded.
  useEffect(() => {
    refreshLists().catch(() => {});
  }, [refreshLists]);

  const handleConnect = useCallback(async () => {
    setWorking(true);
    try {
      const status = await connectIntegration();
      if (status === 'granted') {
        haptic('voiceSuccess');
      } else if (status === 'denied') {
        Alert.alert(
          'Reminders access denied',
          'Open iOS Settings → Privacy & Security → Reminders → Nexus to grant access, then return.',
        );
      }
    } finally {
      setWorking(false);
    }
  }, [connectIntegration]);

  const handleDisconnect = useCallback(() => {
    Alert.alert(
      'Disconnect Apple Reminders?',
      'Your selected lists will be cleared. Reminders themselves stay in iOS — Nexus just stops looking at them. You can reconnect anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            disconnectIntegration();
            haptic('dragDrop');
          },
        },
      ],
    );
  }, [disconnectIntegration]);

  const handleCreateNexusList = useCallback(async () => {
    setWorking(true);
    try {
      await createNexusList();
      haptic('voiceSuccess');
    } catch (e: any) {
      // RemindersNoICloudSourceError carries a user-actionable message
      // ("enable iCloud Reminders in iOS Settings"). Anything else
      // gets the generic fallback. The error name check is robust
      // across module-boundary serialization where instanceof breaks.
      const isNoICloud = e?.name === 'RemindersNoICloudSourceError';
      Alert.alert(
        isNoICloud ? 'iCloud reminders required' : 'Could not create list',
        e?.message || 'Try again, or create a list named "Nexus" manually in the Reminders app.',
      );
    } finally {
      setWorking(false);
    }
  }, [createNexusList]);

  const lastSyncedLabel =
    typeof lastSyncedAt === 'number'
      ? new Date(lastSyncedAt).toLocaleString()
      : 'never';

  const isUnsupported = Platform.OS !== 'ios';

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Apple Reminders', headerStyle: { backgroundColor: BG }, headerTintColor: TEXT }} />
      <AdaptiveScreen>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + tokens.spacing.md }]} showsVerticalScrollIndicator={false}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.backText}>‹  BACK</Text>
        </Pressable>

        <Text style={styles.title}>APPLE REMINDERS</Text>
        <Text style={styles.subtitle}>
          Apple Reminders is where things were written down. Nexus reads them. iOS keeps them.
        </Text>

        {/* Connection status pill */}
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusPill,
              // FIXME(nex-56): connection-state bg tints (green-dark / red-dark), no tokens — design review (see palette block at top)
              { backgroundColor: connected ? 'rgba(95,224,234,0.15)' : 'rgba(229,91,69,0.15)', borderColor: connected ? GREEN : RED },
            ]}
          >
            <View
              style={[styles.statusDot, { backgroundColor: connected ? GREEN : RED }]}
            />
            <Text
              style={[styles.statusText, { color: connected ? GREEN : RED }]}
            >
              {connected ? 'CONNECTED' : 'NOT CONNECTED'}
            </Text>
          </View>
        </View>

        {isUnsupported && (
          <View style={[styles.card, { borderColor: RED, marginTop: tokens.spacing.md }]}>
            <Text style={[styles.warningTitle, { color: RED }]}>iOS only</Text>
            <Text style={styles.helperText}>
              Apple Reminders integration is iOS-only. This screen has no effect on Android.
            </Text>
          </View>
        )}

        {/* Primary CTA */}
        <View style={{ marginTop: tokens.spacing.lg }}>
          {!connected ? (
            <PrimaryPill
              fullWidth
              loading={working}
              disabled={working || isUnsupported}
              onPress={handleConnect}
            >
              CONNECT APPLE REMINDERS
            </PrimaryPill>
          ) : (
            <Pressable style={styles.secondaryBtn} onPress={handleDisconnect}>
              <Text style={styles.secondaryBtnText}>DISCONNECT</Text>
            </Pressable>
          )}
        </View>

        {/* Lists section */}
        {permissionStatus === 'granted' && (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>YOUR LISTS</Text>
              <Text style={styles.helperText}>
                Toggle which reminder lists Nexus should read from. Anything off-limits stays off-limits.
              </Text>
              <ListSection style={{ marginTop: tokens.spacing.sm }}>
                {availableLists.length === 0 ? (
                  <ListRow title="No reminder lists found" trailing="none" />
                ) : (
                  availableLists.map((list: any) => {
                    const enabled = syncedListIds.includes(list.id);
                    return (
                      <ListRow
                        key={list.id}
                        title={list.title}
                        subtitle={`${list.source}${list.isNexus ? ' · NEXUS' : ''}`}
                        trailing="toggle"
                        trailingAccessory={
                          <Toggle
                            value={enabled}
                            onValueChange={() => toggleListSync(list.id)}
                            accessibilityLabel={list.title}
                          />
                        }
                      />
                    );
                  })
                )}
              </ListSection>
            </View>

            {!hasNexusList && (
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>NEW LIST</Text>
                <Pressable
                  style={[styles.outlineBtn, working && styles.primaryBtnDisabled]}
                  onPress={handleCreateNexusList}
                  disabled={working}
                >
                  <Text style={styles.outlineBtnText}>+ CREATE A NEXUS LIST</Text>
                </Pressable>
                <Text style={[styles.helperText, { marginTop: tokens.spacing.xs }]}>
                  Adds a list named "Nexus" to your Reminders app and turns sync on for it.
                </Text>
              </View>
            )}
          </>
        )}

        {/* Sync footer */}
        <View style={styles.section}>
          <Text style={styles.footerLabel}>Last synced: {lastSyncedLabel}</Text>
        </View>
      </ScrollView>
      </AdaptiveScreen>
      <StatusBarScrim />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  // Top padding applied inline via useSafeAreaInsets() at render time.
  // FIXME(nex-56): off-scale 80pt bottom padding, design review
  scroll: { paddingHorizontal: tokens.spacing.lg, paddingBottom: 80 },
  back: { paddingVertical: tokens.spacing.xs, marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 11pt fontSize, design review
  backText: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  // FIXME(nex-56): off-scale 12pt fontSize, design review
  title: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 4, marginBottom: tokens.spacing.sm, textAlign: 'left' },
  // FIXME(nex-56): off-scale 13pt fontSize, design review
  // FIXME(nex-56): off-scale 18pt margin, design review
  subtitle: { color: MUTED, fontSize: 13, lineHeight: 19, marginBottom: 18 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale 6pt paddingVertical, design review
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: tokens.spacing.sm,
    borderWidth: 1,
    borderRadius: 999,
    gap: tokens.spacing.xs,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  // FIXME(nex-56): off-scale 9pt fontSize, design review
  statusText: { fontSize: 9, fontWeight: '900', letterSpacing: 2 },

  primaryBtnDisabled: { opacity: 0.5 },

  secondaryBtn: {
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 14,
    paddingVertical: tokens.spacing.md,
    alignItems: 'center',
  },
  // FIXME(nex-56): off-scale 12pt fontSize, design review
  secondaryBtnText: { color: TEXT, fontSize: 12, fontWeight: '900', letterSpacing: 2 },

  outlineBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: GOLD,
    borderRadius: 14,
    // FIXME(nex-56): off-scale 14pt paddingVertical, design review
    paddingVertical: 14,
    alignItems: 'center',
  },
  // FIXME(nex-56): off-scale 11pt fontSize, design review
  outlineBtnText: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2 },

  // FIXME(nex-56): off-scale 28pt margin, design review (nearest xl 32pt)
  section: { marginTop: 28 },
  // FIXME(nex-56): off-scale 9pt fontSize, design review
  sectionLabel: { color: MUTED, fontSize: 9, fontWeight: '800', letterSpacing: 2, marginBottom: tokens.spacing.xs, marginLeft: tokens.spacing.xxs },
  card: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.luminousEdge, overflow: 'hidden' },
  // FIXME(nex-56): off-scale 15pt fontSize, design review
  warningTitle: { color: TEXT, fontSize: 15 },
  // FIXME(nex-56): off-scale 12pt fontSize, design review
  helperText: { color: MUTED, fontSize: 12, lineHeight: 17, marginLeft: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale 11pt fontSize, design review
  footerLabel: { color: MUTED, fontSize: 11, fontFamily: tokens.font.plexMonoRegular, textAlign: 'center', marginTop: tokens.spacing.xs },
});
