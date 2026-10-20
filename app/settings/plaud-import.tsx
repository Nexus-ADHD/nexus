import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Redirect, Stack, useRouter } from 'expo-router';
import React from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { StatusBarScrim } from '@/src/components/ui/StatusBarScrim';
import { AdaptiveScreen } from '@/src/components/ui/AdaptiveScreen';
import {
  buildPlaudInboxApproval,
  taskProposalsForBulkApproval,
  withDerivedApproval,
} from '@/src/features/plaud-import/approval';
import { REVIEWED_PLAUD_TRANSCRIPT_FIXTURE } from '@/src/features/plaud-import/fixture';
import { importLivePlaudRecording } from '@/src/features/plaud-import/import-live';
import {
  connectPlaud,
  disconnectPlaud,
  hasPlaudConnection,
} from '@/src/features/plaud-import/plaud-auth';
import { listPlaudRecordings } from '@/src/features/plaud-import/plaud-client';
import type { PlaudRecording } from '@/src/features/plaud-import/plaud-mcp';
import { PLAUD_IMPORT_AVAILABLE } from '@/src/features/plaud-import/runtime-access';
import {
  importPlaudTranscript,
  loadPlaudImportEnvelope,
} from '@/src/features/plaud-import/store';
import type {
  PlaudImportProposal,
  PlaudImportSession,
} from '@/src/features/plaud-import/types';
import { supabase } from '@/src/services/supabase';
import { useAppState } from '@/src/state/app-state';
import { ambientGlowSoft } from '@/src/theme/glow';
import tokens, { spacing } from '@/src/theme/tokens';
import { haptic } from '@/src/utils/haptics';
import { syncWidgetAfterMutation } from '@/src/widgets/widget-bridge';

const BG = tokens.color.void;
const SURFACE = tokens.color.surface;
const BORDER = tokens.color.luminousEdge;
const GOLD = tokens.color.gold;
const TEAL = tokens.color.teal;
const TEXT = tokens.color.text;
const MUTED = tokens.color.textMuted;
const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;
const NO_PROPOSALS: PlaudImportProposal[] = [];

type ScreenMode = 'connect' | 'recordings' | 'review';

type Confirmation = {
  proposalId: string;
  inboxTaskId: string;
  title: string;
};

function sectionForKind(kind: PlaudImportProposal['kind']): string {
  if (kind === 'product_idea') return 'PRODUCT IDEA';
  if (kind === 'observation') return 'CONTEXT ONLY';
  return 'PROPOSED TASK';
}

function iconForKind(kind: PlaudImportProposal['kind']): keyof typeof Ionicons.glyphMap {
  if (kind === 'product_idea') return 'bulb-outline';
  if (kind === 'observation') return 'information-circle-outline';
  return 'checkbox-outline';
}

function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function ProposalCard({
  proposal,
  busy,
  onApprove,
}: {
  proposal: PlaudImportProposal;
  busy: boolean;
  onApprove: (proposal: PlaudImportProposal) => void;
}) {
  const approved = proposal.kind === 'task' && proposal.status === 'approved';
  const statusLabel = approved
    ? 'IN INBOX'
    : proposal.kind === 'product_idea'
      ? 'CAPTURED'
      : proposal.kind === 'observation'
        ? 'NOT A TASK'
        : null;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.kindRow}>
          <Ionicons
            name={iconForKind(proposal.kind)}
            size={16}
            color={proposal.kind === 'task' ? TEAL : GOLD}
          />
          <Text style={styles.kindLabel}>{sectionForKind(proposal.kind)}</Text>
        </View>
        {statusLabel && <Text style={styles.approvedLabel}>{statusLabel}</Text>}
      </View>
      <Text style={styles.cardTitle}>{proposal.title}</Text>
      {proposal.detail ? <Text style={styles.cardDetail}>{proposal.detail}</Text> : null}
      {proposal.kind === 'task' && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={approved ? `${proposal.title}, in Inbox` : `Approve ${proposal.title}`}
          disabled={approved || busy}
          onPress={() => onApprove(proposal)}
          style={({ pressed }) => [
            styles.approveButton,
            approved && styles.approveButtonDone,
            pressed && !approved && styles.approveButtonPressed,
          ]}
        >
          <Ionicons
            name={approved ? 'checkmark-circle' : 'add-circle-outline'}
            size={17}
            color={approved ? TEAL : TEXT}
          />
          <Text style={[styles.approveButtonText, approved && styles.approveButtonTextDone]}>
            {busy ? 'ADDING' : approved ? 'ADDED' : 'APPROVE'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function RecordingRow({
  recording,
  busy,
  onPress,
}: {
  recording: PlaudRecording;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${recording.title}`}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.recordingRow, pressed && styles.recordingRowPressed]}
    >
      <View style={styles.recordingCopy}>
        <Text style={styles.recordingTitle} numberOfLines={2}>{recording.title}</Text>
        <Text style={styles.recordingDate}>{displayDate(recording.recordedAt)}</Text>
      </View>
      <Ionicons name={busy ? 'hourglass-outline' : 'chevron-forward'} size={18} color={busy ? TEAL : MUTED} />
    </Pressable>
  );
}

function PlaudImportReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const addInboxTask = useAppState((state) => state.addInboxTask);
  const deleteInboxTask = useAppState((state) => state.deleteInboxTask);
  const [ownerId, setOwnerId] = React.useState<string | null>(null);
  const [connected, setConnected] = React.useState(false);
  const [mode, setMode] = React.useState<ScreenMode>('connect');
  const [session, setSession] = React.useState<PlaudImportSession | null>(null);
  const [recordings, setRecordings] = React.useState<PlaudRecording[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [loadingRecordings, setLoadingRecordings] = React.useState(false);
  const [importingId, setImportingId] = React.useState<string | null>(null);
  const [confirmation, setConfirmation] = React.useState<Confirmation | null>(null);

  // Approval is read out of the Inbox rather than stored alongside it, so the
  // screen subscribes to the Inbox slice: approving, undoing, or deleting the
  // task from anywhere else in the app all re-render this list correctly, with
  // no reconciliation step and nothing left to go stale.
  const inbox = useAppState((state) => state.inbox);
  const proposals = React.useMemo(
    () => withDerivedApproval(session?.proposals ?? NO_PROPOSALS, inbox),
    [session, inbox],
  );

  const refreshConnection = React.useCallback(async (userId: string) => {
    const isConnected = await hasPlaudConnection(userId);
    setConnected(isConnected);
    return isConnected;
  }, []);

  // This path has its own spinner and no outer deadline racing it, so retries
  // genuinely run here. It still gets an explicit budget rather than the 45s
  // default: 45s of spinner for a list call is a worse failure than saying so
  // sooner. ~20s leaves room for three attempts with their backoff.
  const RECORDINGS_BUDGET_MS = 20_000;

  const loadRecordings = React.useCallback(async (userId: string) => {
    setLoadingRecordings(true);
    try {
      const items = await listPlaudRecordings(userId, RECORDINGS_BUDGET_MS);
      setRecordings(items);
      setMode('recordings');
    } catch (error) {
      const stillConnected = await refreshConnection(userId);
      if (!stillConnected) setMode('connect');
      Alert.alert('Could not load PLAUD recordings', messageOf(error, 'Try again.'));
    } finally {
      setLoadingRecordings(false);
    }
  }, [refreshConnection]);

  // The whole load is bounded, not just the calls that already bound
  // themselves. plaud-mcp and plaud-auth each carry an AbortController, but
  // supabase.auth.getSession() does not, and it performs a network token
  // refresh when the JWT has gone stale. That is the await that hung: the
  // screen sat on LOADING with no way out, intermittently, exactly when the
  // session needed refreshing. Racing the whole sequence means `loading`
  // always clears whichever await is the slow one, including any added later.
  // 15s, not 12s, because the MCP call now retries INSIDE this window rather
  // than being killed by it. At 12s with a 30s per-attempt timeout the screen
  // always aborted while attempt 1 was still in flight, so a transient PLAUD
  // failure showed "did not respond in time" having tried exactly once. The
  // budget below is what makes the extra seconds buy retries instead of a
  // longer stare.
  const LOAD_TIMEOUT_MS = 15_000;
  // Leave the screen room to render the failure rather than racing its own
  // deadline to the millisecond.
  const LOAD_BUDGET_MARGIN_MS = 750;

  const runLoad = React.useCallback(async (isActive: () => boolean) => {
    let userId: string | null = null;
    setLoadError(null);
    try {
      const startedAt = Date.now();
      const deadline = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS),
      );
      const work = (async () => {
        const { data } = await supabase.auth.getSession();
        userId = data.session?.user.id ?? null;
        if (!isActive()) return;
        setOwnerId(userId);
        if (!userId) return;
        const [envelope, isConnected] = await Promise.all([
          loadPlaudImportEnvelope(AsyncStorage, userId),
          hasPlaudConnection(userId),
        ]);
        if (!isActive()) return;
        const latest = envelope.sessions[0] ?? null;
        setSession(latest);
        setConnected(isConnected);
        setMode(latest ? 'review' : isConnected ? 'recordings' : 'connect');
        if (isConnected && !latest) {
          // Hand the MCP call the time this screen actually has left, after the
          // session refresh and Keychain reads have already spent some of it.
          // Without this it sizes its retries against a 45s default and never
          // gets to use them.
          const budget =
            LOAD_TIMEOUT_MS - (Date.now() - startedAt) - LOAD_BUDGET_MARGIN_MS;
          const items = await listPlaudRecordings(userId, budget);
          if (isActive()) setRecordings(items);
        }
      })();
      await Promise.race([work, deadline]);
    } catch (error) {
      if (!isActive()) return;
      // Do not fire an Alert here. The failure now has a place on screen with
      // a RETRY, and an alert on top of it would be a second thing to dismiss
      // before the user can act.
      const timedOut = error instanceof Error && error.message === 'timeout';
      setLoadError(
        timedOut
          ? 'PLAUD did not respond in time.'
          : messageOf(error, 'PLAUD import is unavailable right now.'),
      );
      // A failed load says nothing about whether the connection is still good,
      // so re-read it from the Keychain rather than assuming disconnected.
      try {
        const stillConnected = userId ? await hasPlaudConnection(userId) : false;
        if (isActive() && !stillConnected) {
          setConnected(false);
          setMode('connect');
        }
      } catch {
        // Keychain unreadable too. Leave the mode alone and let RETRY decide.
      }
    } finally {
      if (isActive()) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let active = true;
    void runLoad(() => active);
    return () => {
      active = false;
    };
  }, [runLoad]);

  const handleRetryLoad = React.useCallback(() => {
    setLoading(true);
    void runLoad(() => true);
  }, [runLoad]);

  const handleConnect = React.useCallback(async () => {
    if (!ownerId || connecting) return;
    setConnecting(true);
    try {
      await connectPlaud(ownerId);
      setConnected(true);
      await loadRecordings(ownerId);
      void haptic('buttonSecondary');
    } catch (error) {
      Alert.alert('PLAUD connection incomplete', messageOf(error, 'Try again.'));
    } finally {
      setConnecting(false);
    }
  }, [connecting, loadRecordings, ownerId]);

  const handleDisconnect = React.useCallback(() => {
    if (!ownerId) return;
    Alert.alert(
      'Disconnect PLAUD?',
      'This removes PLAUD credentials from this device. Existing reviews and Inbox tasks stay.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await disconnectPlaud(ownerId);
              setConnected(false);
              setRecordings([]);
              setMode(session ? 'review' : 'connect');
            })();
          },
        },
      ],
    );
  }, [ownerId, session]);

  const handleSelectRecording = React.useCallback(async (recording: PlaudRecording) => {
    if (!ownerId || importingId) return;
    setImportingId(recording.id);
    try {
      const imported = await importLivePlaudRecording(AsyncStorage, ownerId, recording);
      // A cached session is returned straight from storage and can carry the
      // same approve/undo split as a session restored at launch, so it gets
      // the identical reconciliation. A freshly interpreted one cannot drift,
      // and reconciling it is a no-op that performs no write.
      setSession(imported.session);
      setMode('review');
      void haptic('buttonSecondary');
      if (imported.omittedProposalCount > 0) {
        const count = imported.omittedProposalCount;
        Alert.alert(
          'PLAUD import completed',
          `${count} suggestion${count === 1 ? ' was' : 's were'} left out because ${count === 1 ? 'its' : 'their'} transcript evidence could not be verified.`,
        );
      }
    } catch (error) {
      const stillConnected = await refreshConnection(ownerId);
      if (!stillConnected) setMode('connect');
      Alert.alert('PLAUD import failed', messageOf(error, 'Try again.'));
    } finally {
      setImportingId(null);
    }
  }, [importingId, ownerId, refreshConnection]);

  const handleFixtureImport = React.useCallback(async () => {
    if (!IS_DEV || !ownerId || importingId) return;
    setImportingId(REVIEWED_PLAUD_TRANSCRIPT_FIXTURE.id);
    try {
      const imported = await importPlaudTranscript(
        AsyncStorage,
        ownerId,
        REVIEWED_PLAUD_TRANSCRIPT_FIXTURE,
      );
      setSession(imported);
      setMode('review');
    } catch {
      Alert.alert('Fixture import failed', 'The local reviewed fixture could not be saved.');
    } finally {
      setImportingId(null);
    }
  }, [importingId, ownerId]);

  const approveProposal = React.useCallback((proposal: PlaudImportProposal) => {
    if (!ownerId || !session) return;
    const approval = buildPlaudInboxApproval(proposal);
    if (!approval) return;
    // One mutation, and it is synchronous. Approval state is derived from the
    // Inbox, so writing the task IS the approval: there is no second store to
    // keep in step, nothing to roll back, no window in which the two can
    // disagree, and no re-entrancy to guard.
    const inboxBefore = useAppState.getState().inbox;
    const inboxTaskId = addInboxTask(approval.title, approval.options);
    const createdHere = !inboxBefore.some(
      (task) => task.proposalKey === proposal.proposalKey,
    );
    syncWidgetAfterMutation();
    void haptic('voiceSuccess');
    // Undo removes the task this press created; offering it for a task that
    // already existed would delete something the user approved earlier.
    if (createdHere) {
      setConfirmation({ proposalId: proposal.id, inboxTaskId, title: proposal.title });
    }
  }, [addInboxTask, ownerId, session]);

  const approveAll = React.useCallback(() => {
    for (const proposal of taskProposalsForBulkApproval(proposals)) {
      approveProposal(proposal);
    }
  }, [approveProposal, proposals]);

  const undoLastApproval = React.useCallback(() => {
    if (!confirmation) return;
    // Also one mutation: deleting the task un-approves the proposal by
    // definition, since nothing else records the approval.
    deleteInboxTask(confirmation.inboxTaskId);
    setConfirmation(null);
    syncWidgetAfterMutation();
    void haptic('buttonSecondary');
  }, [confirmation, deleteInboxTask]);

  const tasks = proposals.filter((proposal) => proposal.kind === 'task');
  const supporting = proposals.filter((proposal) => proposal.kind !== 'task');
  const hasPendingTasks = tasks.some((proposal) => proposal.status !== 'approved');
  const anyBusy = importingId !== null;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'PLAUD Import', headerStyle: { backgroundColor: BG }, headerTintColor: TEXT }} />
      <AdaptiveScreen>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + spacing.md }]}
        showsVerticalScrollIndicator={false}
      >
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back} accessibilityRole="button">
          <Ionicons name="chevron-back" size={16} color={GOLD} />
          <Text style={styles.backText}>BACK</Text>
        </Pressable>

        <View style={styles.titleRow}>
          <View>
            <Text style={styles.title}>PLAUD IMPORT</Text>
            <Text style={styles.subtitle}>{connected ? 'CONNECTED' : 'PRIVATE REVIEW'}</Text>
          </View>
          {connected ? (
            <Pressable
              onPress={handleDisconnect}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Disconnect PLAUD"
            >
              <Ionicons name="unlink-outline" size={19} color={MUTED} />
            </Pressable>
          ) : null}
        </View>

        {/* Order matters here, and getting it wrong shipped a bug. A null
            ownerId is AMBIGUOUS: it means either "genuinely signed out" or
            "the session lookup never finished". When the timeout fires before
            setOwnerId runs, both are true at once. Checking !ownerId first
            claimed the user was signed out and offered no retry, which is the
            same dead end the timeout existed to remove, wearing a friendlier
            label. Errors are now resolved before absence, so SIGN IN REQUIRED
            is only shown when the lookup actually succeeded and came back
            empty. */}
        {loading ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>LOADING</Text>
          </View>
        ) : !ownerId && !loadError ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>SIGN IN REQUIRED</Text>
            <Text style={styles.emptyCopy}>PLAUD reviews are scoped to your Nexus account.</Text>
          </View>
        ) : loadError ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>COULD NOT LOAD</Text>
            <Text style={styles.emptyCopy}>{loadError}</Text>
            <PrimaryPill
              onPress={handleRetryLoad}
              accessibilityLabel="Retry loading PLAUD"
              accessibilityHint="Tries to reach PLAUD again"
              style={{ marginTop: spacing.lg }}
            >
              RETRY
            </PrimaryPill>
          </View>
        ) : mode === 'connect' ? (
          <View style={styles.connectPanel}>
            <View style={styles.importIcon}>
              <Ionicons name="cloud-download-outline" size={24} color={TEAL} />
            </View>
            <Text style={styles.importTitle}>CONNECT PLAUD</Text>
            <Text style={styles.importCopy}>Choose one cloud-synced recording to review in Nexus.</Text>
            <PrimaryPill
              fullWidth
              loading={connecting}
              disabled={connecting || !ownerId}
              onPress={handleConnect}
              accessibilityLabel="Connect PLAUD"
            >
              CONNECT
            </PrimaryPill>
            {session ? (
              <Pressable onPress={() => setMode('review')} style={styles.textButton} accessibilityRole="button">
                <Text style={styles.textButtonLabel}>VIEW LAST REVIEW</Text>
              </Pressable>
            ) : null}
            {IS_DEV ? (
              <Pressable onPress={handleFixtureImport} style={styles.textButton} accessibilityRole="button">
                <Text style={styles.textButtonLabel}>IMPORT TEST FIXTURE</Text>
              </Pressable>
            ) : null}
          </View>
        ) : mode === 'recordings' ? (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>RECENT RECORDINGS</Text>
              <Pressable
                onPress={() => ownerId && loadRecordings(ownerId)}
                disabled={loadingRecordings || Boolean(importingId)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Refresh PLAUD recordings"
              >
                <Ionicons name="refresh" size={18} color={TEXT} />
              </Pressable>
            </View>
            {loadingRecordings ? (
              <Text style={styles.emptyCopy}>Loading recordings...</Text>
            ) : recordings.length ? (
              recordings.map((recording) => (
                <RecordingRow
                  key={recording.id}
                  recording={recording}
                  busy={importingId === recording.id}
                  onPress={() => handleSelectRecording(recording)}
                />
              ))
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>NO CLOUD RECORDINGS</Text>
                <Text style={styles.emptyCopy}>Enable Cloud Sync in PLAUD, then refresh.</Text>
              </View>
            )}
            {session ? (
              <Pressable onPress={() => setMode('review')} style={styles.textButton} accessibilityRole="button">
                <Text style={styles.textButtonLabel}>VIEW LAST REVIEW</Text>
              </Pressable>
            ) : null}
          </>
        ) : session ? (
          <>
            <View style={styles.sourceRow}>
              <View style={styles.sourceCopy}>
                <Text style={styles.sourceLabel}>SOURCE</Text>
                <Text style={styles.sourceTitle} numberOfLines={2}>{session.sourceTitle}</Text>
              </View>
              {connected ? (
                <Pressable
                  onPress={() => ownerId && loadRecordings(ownerId)}
                  disabled={anyBusy || loadingRecordings}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel="Choose another PLAUD recording"
                >
                  <Ionicons name="list" size={19} color={TEXT} />
                </Pressable>
              ) : null}
            </View>

            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>TASKS</Text>
              <Text style={styles.sectionMeta}>REVIEW REQUIRED</Text>
            </View>
            {tasks.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                busy={false}
                onApprove={approveProposal}
              />
            ))}
            <PrimaryPill
              fullWidth
              loading={anyBusy}
              disabled={!hasPendingTasks || anyBusy}
              onPress={approveAll}
              accessibilityLabel="Approve all pending PLAUD tasks"
            >
              {hasPendingTasks ? 'APPROVE ALL TASKS' : 'ALL TASKS ADDED'}
            </PrimaryPill>

            {supporting.length ? (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>CAPTURED CONTEXT</Text>
                </View>
                {supporting.map((proposal) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    busy={false}
                    onApprove={approveProposal}
                  />
                ))}
              </>
            ) : null}

            <View style={styles.privacyRow}>
              <Ionicons name="lock-closed-outline" size={15} color={MUTED} />
              <Text style={styles.privacyText}>Transcript text is sent through Nexus AI to create proposals. No PLAUD audio is requested or stored.</Text>
            </View>
          </>
        ) : null}
      </ScrollView>
      </AdaptiveScreen>

      {confirmation ? (
        <View style={[styles.confirmation, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <View style={styles.confirmationCopy}>
            <Text style={styles.confirmationLabel}>IN YOUR INBOX</Text>
            <Text style={styles.confirmationTitle} numberOfLines={1}>{confirmation.title}</Text>
          </View>
          <Pressable
            onPress={undoLastApproval}
            style={styles.undoButton}
            accessibilityRole="button"
            accessibilityLabel={`Undo adding ${confirmation.title}`}
          >
            <Ionicons name="arrow-undo" size={19} color={GOLD} />
          </Pressable>
        </View>
      ) : null}
      <StatusBarScrim />
    </View>
  );
}

export default function PlaudImportRoute() {
  return PLAUD_IMPORT_AVAILABLE ? <PlaudImportReviewScreen /> : <Redirect href="/settings" />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: 120 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: spacing.xs, marginBottom: spacing.sm },
  backText: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  titleRow: { minHeight: 58, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: spacing.lg },
  title: { color: TEXT, fontSize: 22, fontWeight: '800', letterSpacing: 3.5 },
  subtitle: { color: TEAL, fontSize: 11, fontWeight: '800', letterSpacing: 2, marginTop: 4 },
  connectPanel: { paddingVertical: spacing.xl, gap: spacing.md },
  importIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: tokens.color.surfaceElevated },
  importTitle: { color: TEXT, fontSize: 15, fontWeight: '800', letterSpacing: 2.4 },
  importCopy: { color: MUTED, fontSize: 13, lineHeight: 19, marginBottom: spacing.sm },
  emptyState: { paddingVertical: spacing.xl },
  emptyTitle: { color: TEXT, fontSize: 14, fontWeight: '800', letterSpacing: 2.2 },
  emptyCopy: { color: MUTED, fontSize: 13, lineHeight: 19, marginTop: 6 },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  textButtonLabel: { color: GOLD, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  recordingRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER, paddingVertical: spacing.sm },
  recordingRowPressed: { opacity: 0.65 },
  recordingCopy: { flex: 1, minWidth: 0, paddingRight: spacing.sm },
  recordingTitle: { color: TEXT, fontSize: 14, lineHeight: 19, fontWeight: '700', letterSpacing: 0 },
  recordingDate: { color: MUTED, fontSize: 11, lineHeight: 16, fontWeight: '700', letterSpacing: 0, marginTop: 4 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  sourceCopy: { flex: 1, minWidth: 0, paddingRight: spacing.sm },
  sourceLabel: { color: MUTED, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  sourceTitle: { color: TEXT, fontSize: 14, fontWeight: '700', lineHeight: 19, letterSpacing: 0, marginTop: 4 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sectionHeader: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg, marginBottom: spacing.sm },
  sectionTitle: { color: TEXT, fontSize: 12, fontWeight: '900', letterSpacing: 2 },
  sectionMeta: { color: MUTED, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  card: { backgroundColor: SURFACE, borderColor: BORDER, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: spacing.md, marginBottom: spacing.sm, ...ambientGlowSoft },
  cardHeader: { minHeight: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kindRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  kindLabel: { color: MUTED, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  approvedLabel: { color: TEAL, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  cardTitle: { color: TEXT, fontSize: 15, fontWeight: '700', lineHeight: 21, letterSpacing: 0, marginTop: spacing.sm },
  cardDetail: { color: MUTED, fontSize: 13, lineHeight: 19, letterSpacing: 0, marginTop: 6 },
  approveButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER, marginTop: spacing.md, paddingTop: spacing.sm },
  approveButtonPressed: { opacity: 0.65 },
  approveButtonDone: { opacity: 0.85 },
  approveButtonText: { color: TEXT, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  approveButtonTextDone: { color: TEAL },
  privacyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: spacing.lg },
  privacyText: { flex: 1, color: MUTED, fontSize: 12, lineHeight: 18, letterSpacing: 0 },
  confirmation: { position: 'absolute', left: 0, right: 0, bottom: 0, minHeight: 72, flexDirection: 'row', alignItems: 'center', backgroundColor: tokens.color.surfaceElevated, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER, paddingTop: spacing.md, paddingHorizontal: spacing.lg },
  confirmationCopy: { flex: 1, minWidth: 0 },
  confirmationLabel: { color: TEAL, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  confirmationTitle: { color: TEXT, fontSize: 13, fontWeight: '700', letterSpacing: 0, marginTop: 3 },
  undoButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
