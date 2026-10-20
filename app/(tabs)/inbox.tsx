// @ts-nocheck
import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View, Pressable, KeyboardAvoidingView, Platform, Alert, TextInput, RefreshControl } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import DraggableFlatList, { RenderItemParams, ScaleDecorator, OpacityDecorator } from 'react-native-draggable-flatlist';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppState } from '../../src/state/app-state';
import { useShallow } from 'zustand/react/shallow';
import { useRemindersStore } from '../../src/state/reminders-store';
import { useRouter, useFocusEffect } from 'expo-router';
import { PLAUD_IMPORT_AVAILABLE } from '@/src/features/plaud-import/runtime-access';
import { useEntranceFrom } from '@/hooks/use-entrance-motion';
import { MotiView } from 'moti';
import tokens from '../../src/theme/tokens';
import { AdaptiveScreen } from '../../src/components/ui/AdaptiveScreen';
import { haptic } from '../../src/utils/haptics';
import { PrimaryPill } from '../../src/components/ui/PrimaryPill';
import { syncWidgetAfterMutation } from '../../src/widgets/widget-bridge';
import { relativeTime } from '../../src/utils/relative-time';
import { captureProofLine } from '../../src/features/inbox/capture-proof';
import { recordFirstReach } from '../../src/services/capture-reach-tracker';
import { markReminderComplete, updateReminderTitle } from '../../src/services/apple-reminders';
import { ambientGlowSoft } from '../../src/theme/glow';
import BreakdownStack from '../../components/inbox/BreakdownStack';
import { groupInboxRows, flattenRowsToInbox, type InboxRow } from '../../src/features/inbox/group-inbox-rows';
import { displayInboxStatus } from '../../src/features/inbox/display-status';

// v3 stellar: TextInput placeholder gray #444 → tokens.color.textDisabled.
// Matches the PLACEHOLDER_COLOR pattern from app/(tabs)/index.tsx (d403ff4).
// Workaround for JSX attribute-position comments not being valid TS.
const PLACEHOLDER_COLOR_DARK = tokens.color.textDisabled;

function formatDueDate(iso: string): string {
  try {
    // A date-only key (YYYY-MM-DD, e.g. the NEX-193 first-win capture) must be
    // parsed from local date parts. `new Date('YYYY-MM-DD')` parses as UTC
    // midnight, which renders the prior day in negative-offset (US) time zones.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    const d = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return sameYear
      ? `${months[d.getMonth()]} ${d.getDate()}`
      : `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  } catch {
    return iso;
  }
}

/**
 * NEX-215 (I-2): the quiet capture-proof line ("Captured 2h ago") plus the
 * due-date line for a manual-source Inbox item. Module-scope (defined once) so a
 * list row doesn't allocate a closure per render. `captureProofLine` returns null
 * for Apple-Reminders items, so caller-side guarding stays a single check.
 */
function ProvenanceLines({ task }: { task: { source?: string; createdAt?: number; dueDate?: string } }) {
  const proof = captureProofLine(task);
  if (!proof && !task.dueDate) return null;
  return (
    <>
      {proof && (
        <Text style={styles.sourceBadge} accessibilityLabel={proof}>{proof}</Text>
      )}
      {task.dueDate && (
        <Text
          style={[styles.sourceBadge, proof && styles.stackedBadge]}
          accessibilityLabel={`Due ${formatDueDate(task.dueDate)}`}
        >{`Due ${formatDueDate(task.dueDate)}`}</Text>
      )}
    </>
  );
}

export default function InboxScreen() {
  const { inbox, addInboxTask, toggleInboxTask, deleteInboxTask, updateInboxTask, setInboxOrder } = useAppState(
    useShallow((s: any) => ({
      inbox: s.inbox,
      addInboxTask: s.addInboxTask,
      toggleInboxTask: s.toggleInboxTask,
      deleteInboxTask: s.deleteInboxTask,
      updateInboxTask: s.updateInboxTask,
      setInboxOrder: s.setInboxOrder,
    })),
  );
  const router = useRouter();
  const remindersConnected = useRemindersStore((s: any) => s.isConnected());
  const remindersPermission = useRemindersStore((s: any) => s.permissionStatus);
  const syncedListIds = useRemindersStore((s: any) => s.syncedListIds);
  const lastSyncedAt = useRemindersStore((s: any) => s.lastSyncedAt);
  const syncReminders = useRemindersStore((s: any) => s.syncReminders);
  const isThrottled = useRemindersStore((s: any) => s.isThrottled);
  // Manual-add write-back: when the user types into the "Park
  // something for later…" input, mirror the new item into the
  // user's Nexus list in Apple Reminders. Same flow the voice
  // executor uses for inbox_add (Phase 4) — the bug was that the
  // Inbox input never picked it up.
  const mirrorToReminders = useRemindersStore((s: any) => s.mirrorToReminders);
  const [filter, setFilter] = useState<'NEW' | 'ARCHIVED'>('NEW');
  const [refreshing, setRefreshing] = useState(false);
  // The bottom tab bar floats over content (default React Navigation
  // behavior with no custom positioning). useBottomTabBarHeight
  // returns the bar's height; on some devices/configurations it
  // does NOT include the home-indicator inset — so we add
  // safe-area bottom inset explicitly. Belt + suspenders. Without
  // this, the last inbox card tucks under the indicator on Pro
  // Max-class devices.
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  // Hoisted to the component top level: renderItem is a nested render
  // function (not its own React component), so its MotiView entrance
  // must draw its `from` from a hook called here, not inside renderItem.
  const entranceFrom = useEntranceFrom(10);

  // Focus-driven sync: runs when the user lands on the Inbox tab,
  // gated by isConnected and the 30s throttle. Pull-to-refresh has
  // its own handler that bypasses the throttle.
  useFocusEffect(
    useCallback(() => {
      if (!remindersConnected) return;
      if (isThrottled()) {
        const ago = Math.floor((Date.now() - (lastSyncedAt ?? 0)) / 1000);
        // eslint-disable-next-line no-console
        console.log(`[reminders] sync: skipped — throttled (${ago}s ago)`);
        return;
      }
      syncReminders().catch(() => {});
    }, [remindersConnected, isThrottled, syncReminders, lastSyncedAt]),
  );

  const handlePullToRefresh = useCallback(async () => {
    if (!remindersConnected) return;
    setRefreshing(true);
    try {
      await syncReminders();
    } finally {
      setRefreshing(false);
    }
  }, [remindersConnected, syncReminders]);
  
  const [newTaskTitle, setNewTaskTitle] = useState('');
  // NEX-213 (I-4): the empty state's one action focuses this composer (same
  // action as the persistent "Park something…" input → no dual affordance).
  const composerRef = useRef<TextInput>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editAction, setEditAction] = useState('');

  // NEX-285: derive display rows from the FULL inbox. groupInboxRows reproduces
  // the exact per-tab filter (NEW hides ARCHIVED + triagedSkip; ARCHIVED shows
  // only archived) AND collapses each breakdown group into one stacked row on the
  // NEW tab. Memoized on [inbox, filter] — a fresh `data` identity mid-drag can
  // jitter an in-progress drag, so this is correctness, not just perf.
  const rows = useMemo<InboxRow[]>(() => groupInboxRows(inbox, filter), [inbox, filter]);

  // Which breakdown stack is expanded (one at a time). Cleared when that group
  // degenerates or clears so a reappearing group doesn't spring open unexpectedly.
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  useEffect(() => {
    if (
      expandedGroupId &&
      !rows.some((r) => r.kind === 'group' && r.groupId === expandedGroupId)
    ) {
      setExpandedGroupId(null);
    }
  }, [rows, expandedGroupId]);
  const handleToggleExpand = useCallback((gid: string) => {
    setExpandedGroupId((cur) => (cur === gid ? null : gid));
  }, []);

  // NEX-285: "Complete all" — archive every remaining incomplete step of a
  // breakdown at once, so the whole stack resolves and clears. Mirrors
  // handleStatusChange's manual-item flip (status only; manual items don't carry
  // `completed`) in a single batched setState. Breakdown steps are always
  // source:'manual', so there's no Apple EventKit write-back here. Reach
  // analytics still fire per step (the tracker no-ops for already-reached ones),
  // and it's fully undoable by restoring from the Archived tab.
  const handleCompleteGroup = useCallback((steps: any[]) => {
    const list = Array.isArray(steps) ? steps.filter((s) => s && s.id) : [];
    if (list.length === 0) return;
    const idSet = new Set(list.map((s) => s.id));
    const before = (useAppState as any).getState().inbox;
    for (const s of list) {
      void recordFirstReach(s.id, {
        surface: 'inbox',
        accessMethod: 'manual_nav',
        capturedAtMs: typeof s.createdAt === 'number' ? s.createdAt : undefined,
      });
    }
    (useAppState as any).setState({
      inbox: before.map((t: any) => (idSet.has(t.id) ? { ...t, status: 'ARCHIVED' } : t)),
    });
    syncWidgetAfterMutation();
  }, []);

  const handleStatusChange = async (id: string, currentStatus: string) => {
    haptic('dragDrop');
    const newStatus = currentStatus === 'ARCHIVED' ? 'NEW' : 'ARCHIVED';
    const completedNow = newStatus === 'ARCHIVED';
    const before = (useAppState as any).getState().inbox;
    const target = before.find((t: any) => t.id === id);
    // NEX-261: completing/restoring a captured one-off from the Inbox list is a
    // deliberate manual_nav first-reach (engaged via the list, not a surfaced
    // affordance). The tracker no-ops for non-captures + already-reached, so this
    // fires only for genuine, not-yet-surfaced captures.
    void recordFirstReach(id, {
      surface: 'inbox',
      accessMethod: 'manual_nav',
      capturedAtMs: typeof target?.createdAt === 'number' ? target.createdAt : undefined,
    });
    // Optimistic flip: archive ↔ active. For Apple-sourced items this
    // also flips `completed` so the local view matches the EventKit
    // write we're about to fire — and matches what reconcileExternalState
    // would set when an item arrives back as completed.
    (useAppState as any).setState({
      inbox: before.map((t: any) =>
        t.id === id
          ? {
              ...t,
              status: newStatus,
              ...(t.source === 'apple_reminders' ? { completed: completedNow } : {}),
            }
          : t,
      ),
    });
    syncWidgetAfterMutation();

    // EventKit write-back for Apple-sourced items only.
    if (target?.source === 'apple_reminders' && target?.externalId) {
      try {
        await markReminderComplete(target.externalId, completedNow);
      } catch (e: any) {
        // Revert and surface the failure. The user can retry.
        (useAppState as any).setState({ inbox: before });
        syncWidgetAfterMutation();
        Alert.alert('Sync failed', 'Could not update Apple Reminders. Try again.');
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn('[inbox] markReminderComplete failed:', e?.cause || e?.message || e);
        }
      }
    }
  };

  const handleManualAdd = () => {
    const title = newTaskTitle.trim();
    if (!title) return;
    setNewTaskTitle('');
    haptic('voiceSuccess');

    // Mirrors the voice executor's inbox_add flow (Phase 4). Bug was
    // that this input went straight to addInboxTask without firing
    // the EventKit write — items added here lived only in Nexus and
    // silently never appeared in Apple Reminders. Pattern below:
    //   - If reminders is connected, optimistically stamp the local
    //     item with source='apple_reminders' (unstamped) so the
    //     Phase-4 race-window dedup in upsertRemindersIntoInbox
    //     attaches the externalId on the next sync rather than
    //     creating a duplicate.
    //   - Fire mirrorToReminders. On externalId returned, stamp it
    //     onto the local row. On null/failure, revert source to
    //     'manual' so a later sync doesn't see an unstamped
    //     apple_reminders item past the dedup window.
    const willMirror = remindersConnected;
    const localId = addInboxTask(title, {
      source: willMirror ? 'apple_reminders' : 'manual',
      status: 'UNPROCESSED',
    });
    syncWidgetAfterMutation();

    if (willMirror && typeof mirrorToReminders === 'function') {
      void mirrorToReminders({ title })
        .then((result: { externalId: string } | null) => {
          if (result?.externalId) {
            updateInboxTask(localId, {
              source: 'apple_reminders',
              externalId: result.externalId,
            });
          } else {
            // Mirror skipped or failed — revert to manual so
            // future syncs don't see an unstamped apple_reminders
            // item past the 10s dedup window.
            updateInboxTask(localId, { source: 'manual' });
          }
        })
        .catch(() => {
          updateInboxTask(localId, { source: 'manual' });
        });
    }
  };

  const startEdit = (task: any) => {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditAction(task.nextAction || '');
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const target = (useAppState as any).getState().inbox.find(
      (t: any) => t.id === editingId,
    );
    const newTitle = editTitle.trim();
    // Empty / unchanged title → close cleanly without writing. Avoids
    // a no-op EventKit round-trip and preserves prior behavior of
    // simply dismissing the modal when the user changed nothing.
    if (!target || !newTitle || newTitle === target.title) {
      setEditingId(null);
      return;
    }

    // 1. Optimistic local update — patch form so updateInboxTask
    //    only touches the title field.
    updateInboxTask(editingId, { title: newTitle });
    haptic('voiceSuccess');
    setEditingId(null);

    // 2. Mirror back to Apple Reminders for source='apple_reminders'.
    //    Manual items stay local. updateReminderTitle is non-destructive
    //    (read-merge-write via patchReminder) so notes/alarms/dueDate
    //    are preserved across the title change.
    if (target.source === 'apple_reminders' && target.externalId) {
      try {
        await updateReminderTitle(target.externalId, newTitle);
      } catch (e: any) {
        // Roll back local change so the visible state matches Apple
        // again. The user can retry or edit manually in Reminders.
        updateInboxTask(editingId, { title: target.title });
        Alert.alert(
          'Sync failed',
          'Could not update Apple Reminders. Title reverted.',
        );
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn('[inbox] updateReminderTitle failed:', e?.cause || e?.message || e);
        }
      }
    }
  };

  const handleLongPress = (task: any) => {
    haptic('longPressStart');
    // NEX-261: long-pressing to manage a captured one-off is a deliberate
    // manual_nav first-reach (no-op for non-captures + already-reached).
    void recordFirstReach(task.id, {
      surface: 'inbox',
      accessMethod: 'manual_nav',
      capturedAtMs: typeof task?.createdAt === 'number' ? task.createdAt : undefined,
    });
    Alert.alert(
      "Manage Item",
      "What would you like to do?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Edit", onPress: () => startEdit(task) },
        { 
          text: "Delete Permanently", 
          style: "destructive", 
          onPress: () => {
            deleteInboxTask(task.id);
            syncWidgetAfterMutation();
          }
        }
      ]
    );
  };


  // Mapping lives in src/features/inbox/display-status.ts so it is testable and
  // so an internal identifier (UNPROCESSED) can never reach the screen again.
  const getDisplayStatus = (task: any): string => displayInboxStatus(task);

  // FIXME(nex-56): inbox status-color palette — 4 semantic colors (blue/gold/green/gray),
  // design review needed (CLAUDE.md doesn't define a state-color system for inbox cards).
  // Reviewing this state machine piecewise is worse than reviewing it whole — surface-pass
  // ticket should propose inbox.statusNew/Open/Scheduled/Archived tokens.
  // Even the gold variant that has a clean token mapping is kept literal here so the
  // whole palette gets reviewed as one unit (precedent: orb state palette in index.tsx).
  // Per-case FIXMEs below mirror the orb palette form and satisfy the canonical
  // 3-line proximity gate.
  // v3 stellar: status palette retoned. Blue → stateInfo (celestial blue-gray);
  // gold → new bright gold; green → teal (success uses teal in v3); archived
  // gray → textDisabled.
  const getStatusColor = (status: string) => {
    switch(status) {
      case 'NEW':       return tokens.color.stateInfo;
      case 'OPEN':      return tokens.color.gold;
      case 'SCHEDULED': return tokens.color.teal;
      case 'ARCHIVED':  return tokens.color.textDisabled;
      default:          return tokens.color.gold;
    }
  };

  // NEX-285: `data` is now the reordered InboxRow[] (singles + group stacks).
  // flattenRowsToInbox expands each row to the live task references it represents
  // (a group → its incomplete steps), then appends every remaining live item
  // (each group's archived members, the other tab's items, triaged-skip, Apple
  // items). Reads live store state at drop, preserves references, drops nothing
  // and duplicates nothing (output ids === live ids, each once).
  const handleDragEnd = useCallback(({ data }: { data: InboxRow[] }) => {
    const liveInbox = (useAppState as any).getState().inbox;
    setInboxOrder(flattenRowsToInbox(data, liveInbox));
    syncWidgetAfterMutation();
  }, [setInboxOrder]);

  const renderItem = useCallback(({ item: row, drag, isActive }: RenderItemParams<InboxRow>) => {
    // NEX-285: a breakdown group renders as a single stacked card. Completing a
    // step routes through the same handleStatusChange as a normal row, so reach
    // analytics + Apple write-back are preserved and the next step auto-advances.
    if (row.kind === 'group') {
      // ScaleDecorator matches the single-row path so a group stack gets the same
      // scale-up-while-dragging feedback (BreakdownStack adds the opacity dim).
      return (
        <ScaleDecorator>
          <BreakdownStack
            row={row}
            expanded={expandedGroupId === row.groupId}
            onToggleExpand={handleToggleExpand}
            onCompleteStep={(step: any) => handleStatusChange(step.id, step.status || 'NEW')}
            onCompleteAll={handleCompleteGroup}
            drag={drag}
            isActive={isActive}
          />
        </ScaleDecorator>
      );
    }
    const task = row.task;
    return (
    <ScaleDecorator>
      <Pressable
        onLongPress={() => handleLongPress(task)}
        delayLongPress={300}
        disabled={isActive}
      >
        <MotiView
          from={entranceFrom}
          animate={{ opacity: isActive ? 0.85 : 1, translateY: 0 }}
          style={[
            styles.card,
            { borderLeftWidth: 3, borderLeftColor: getStatusColor(getDisplayStatus(task)), paddingLeft: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
            isActive && { shadowColor: tokens.color.gold, shadowOpacity: 0.3, shadowRadius: 12, elevation: 8 },
          ]}
        >
          {editingId === task.id ? (
            <View style={styles.editContainer}>
              <Text style={styles.editLabel}>EDIT TITLE</Text>
              {/* FIXME(nex-56): tokens.color.textMuted off-scale gray (JSX attribute placeholderTextColor) — design review */}
              <TextInput style={styles.editInput} value={editTitle} onChangeText={setEditTitle} placeholderTextColor={tokens.color.textMuted} accessibilityLabel="Edit title" />

              <View style={styles.editActions}>
                <Pressable onPress={() => setEditingId(null)} style={styles.cancelBtn} hitSlop={tokens.icon.hitTarget.linkSlopTight} accessibilityRole="button" accessibilityLabel="Cancel">
                  <Text style={styles.cancelBtnText}>CANCEL</Text>
                </Pressable>
                <PrimaryPill size="compact" onPress={saveEdit} accessibilityLabel="Save">SAVE</PrimaryPill>
              </View>
            </View>
          ) : (
            <>
              {/* The loud state badges are still gone. What is here instead is
                  one quiet tracked label, because the colored left border was
                  left as the SOLE carrier of status and that fails twice:
                  color alone conveys it visually, and VoiceOver announced it
                  not at all. The earlier reasoning assumed the source
                  provenance line carried the meaning, but that line only
                  renders for Apple Reminders imports (see the sourceRow
                  below), so a manually captured item had nothing.

                  A visible Text fixes both at once — screen readers read it,
                  and sighted users get a non-color carrier — which is why this
                  is a label rather than an accessibilityLabel on the card. */}
              <View style={styles.cardHeader}>
                <Text style={styles.statusLabel}>{getDisplayStatus(task)}</Text>
                <Pressable
                  onPress={() => handleStatusChange(task.id, task.status || 'NEW')}
                  style={[styles.checkBtn, task.status === 'ARCHIVED' && styles.checkBtnArchived]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    task.status === 'ARCHIVED'
                      ? `Restore ${task.title || 'this item'}`
                      : `Complete ${task.title || 'this item'}`
                  }
                >
                  <Text
                    style={[styles.checkText, task.status === 'ARCHIVED' && styles.checkTextArchived]}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  >
                    {task.status === 'ARCHIVED' ? '↺' : '✓'}
                  </Text>
                </Pressable>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.cardTitle, task.status === 'ARCHIVED' && styles.cardTitleArchived, { flex: 1 }]}>
                  {task.title}
                </Text>
                <Pressable
                  onLongPress={drag}
                  delayLongPress={150}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Reorder ${task.title || 'this item'}`}
                  accessibilityHint="Double tap and hold, then drag to reorder"
                >
                  <Text style={styles.dragHandle} accessibilityElementsHidden importantForAccessibility="no">≡</Text>
                </Pressable>
              </View>

              {/* Source badge for Apple-Reminders-imported items.
                  Manual items render nothing here, preserving the
                  Phase-1 visual baseline. Phase 3: orphaned items
                  (deleted/moved externally) render in muted color
                  with a "removed externally" tag. */}
              {task.source === 'apple_reminders' && (
                <Text
                  style={[
                    styles.sourceBadge,
                    task.orphaned && styles.sourceBadgeOrphaned,
                  ]}
                  accessibilityLabel={
                    task.orphaned
                      ? 'From Apple Reminders, removed externally'
                      : task.dueDate
                        ? `From Apple Reminders, due ${formatDueDate(task.dueDate)}`
                        : 'From Apple Reminders'
                  }
                >
                  {task.orphaned
                    ? '↳ Apple Reminders · removed externally'
                    : task.dueDate
                      ? `↳ Apple Reminders · Due ${formatDueDate(task.dueDate)}`
                      : '↳ Apple Reminders'}
                </Text>
              )}

              {/* NEX-215 (I-2): quiet capture-PROOF + due-date provenance for
                  manual-source items (Apple-Reminders items render their own line
                  above). Extracted to a module-scope <ProvenanceLines/> so the
                  list row doesn't allocate a closure per render. */}
              {task.source !== 'apple_reminders' && <ProvenanceLines task={task} />}
            </>
          )}
        </MotiView>
      </Pressable>
    </ScaleDecorator>
    );
  }, [editingId, editTitle, editAction, expandedGroupId, handleToggleExpand, handleCompleteGroup]);

  const ListEmpty = useCallback(() => {
    // Doorway: when the user has no items AND no Apple Reminders
    // connection, surface the "Connect Reminders" CTA in place of
    // the standard "NOTHING PARKED" empty state. Stays out of the
    // way once the user is connected (or has stuff in the inbox).
    if (filter === 'NEW' && !remindersConnected) {
      return (
        <View style={styles.emptyState}>
          <View style={styles.doorwayCard}>
            <Text style={styles.doorwayTitle}>NOTHING PARKED</Text>
            <Text style={styles.doorwayBody}>
              Apple Reminders holds the things you said you'd do. Bring them here.
            </Text>
            <PrimaryPill
              onPress={() => {
                router.push('/settings/apple-reminders');
              }}
              accessibilityLabel="Connect Reminders"
              accessibilityHint="Opens Apple Reminders settings"
            >
              CONNECT REMINDERS
            </PrimaryPill>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>{filter === 'NEW' ? 'NOTHING PARKED' : 'NOTHING ARCHIVED'}</Text>
        <Text style={styles.emptySub}>
          {filter === 'NEW'
            ? 'A place to store things for later. Today\'s tasks live in Orbit.'
            : 'Items you\'ve archived from your inbox land here.'}
        </Text>
        {/* NEX-213 (I-4): one low-threshold action on the plain NEW empty —
            focus the existing composer. ARCHIVED stays a passive bucket. */}
        {filter === 'NEW' && (
          <PrimaryPill
            onPress={() => {
              composerRef.current?.focus();
            }}
            accessibilityLabel="Park something"
            accessibilityHint="Focuses the inbox input"
            testID="inbox-empty-add"
            style={{ marginTop: tokens.spacing.lg }}
          >
            Park something
          </PrimaryPill>
        )}
      </View>
    );
  }, [filter, remindersConnected, router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
        <AdaptiveScreen>
        <View style={styles.header} />

        {/* Header status row. Three states:
              - permission granted, ≥1 list synced → timestamp
              - permission granted, 0 lists      → tappable "no lists selected"
              - permission not granted           → render nothing
        */}
        {/* These two are doorways to somewhere else, so they are shaped like
            doorways: a bordered surface, a chevron, and a real 44pt target.
            They previously rendered as bare monospace lines and read as status
            text, which is why the owner asked for them to look tappable.
            Apple Reminders is now pressable in BOTH states, not only when no
            lists are selected. Once something looks like a button, a tap that
            does nothing is worse than no button. */}
        {remindersPermission === 'granted' && (
          <Pressable
            style={({ pressed }) => [styles.sourceRow, pressed && styles.sourceRowPressed]}
            onPress={() => {
              haptic('tabChange');
              router.push('/settings/apple-reminders');
            }}
            accessibilityRole="button"
            accessibilityLabel={
              syncedListIds.length === 0
                ? 'Apple Reminders, no lists selected'
                : lastSyncedAt === null
                  ? 'Apple Reminders, syncing'
                  : `Apple Reminders, synced ${relativeTime(lastSyncedAt)}`
            }
            accessibilityHint="Opens Apple Reminders settings"
          >
            <Text style={styles.sourceRowLabel} numberOfLines={1}>
              {syncedListIds.length === 0
                ? 'APPLE REMINDERS · no lists selected'
                : lastSyncedAt === null
                  ? 'APPLE REMINDERS · syncing…'
                  : `APPLE REMINDERS · synced ${relativeTime(lastSyncedAt)}`}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={tokens.color.textMuted} />
          </Pressable>
        )}

        {/* PLAUD belongs beside Apple Reminders because it answers the same
            question: what is already written down somewhere else that should
            be in here. */}
        {PLAUD_IMPORT_AVAILABLE && (
          <Pressable
            style={({ pressed }) => [styles.sourceRow, pressed && styles.sourceRowPressed]}
            onPress={() => {
              haptic('tabChange');
              router.push('/settings/plaud-import');
            }}
            accessibilityRole="button"
            accessibilityLabel="PLAUD import"
            accessibilityHint="Opens PLAUD import to turn a recording into tasks you approve"
          >
            <Text style={styles.sourceRowLabel} numberOfLines={1}>PLAUD · import a recording</Text>
            <Ionicons name="chevron-forward" size={14} color={tokens.color.textMuted} />
          </Pressable>
        )}

        <View style={styles.tabContainer}>
          <Pressable
            onPress={() => { setFilter('NEW'); haptic('tabChange'); }}
            style={styles.tab}
            accessibilityRole="tab"
            accessibilityLabel="Active"
            accessibilityState={{ selected: filter === 'NEW' }}
          >
            <Text style={[styles.tabText, filter === 'NEW' && styles.tabTextActive]}>ACTIVE</Text>
            {filter === 'NEW' && <MotiView style={styles.tabIndicator} layout={{ type: 'spring' }} />}
          </Pressable>
          <Pressable
            onPress={() => { setFilter('ARCHIVED'); haptic('tabChange'); }}
            style={styles.tab}
            accessibilityRole="tab"
            accessibilityLabel="Archived"
            accessibilityState={{ selected: filter === 'ARCHIVED' }}
          >
            <Text style={[styles.tabText, filter === 'ARCHIVED' && styles.tabTextActive]}>ARCHIVED</Text>
            {filter === 'ARCHIVED' && <MotiView style={styles.tabIndicator} layout={{ type: 'spring' }} />}
          </Pressable>
        </View>

        {/* Composer is hoisted out of the FlatList header. Putting the
            TextInput inside ListHeaderComponent caused FlatList to remount
            the header subtree on every keystroke (newTaskTitle was in the
            useCallback deps → new function reference → new component type),
            which dismissed the keyboard. Persistent above the list now. */}
        {filter === 'NEW' && (
          <View style={styles.inputWrapper}>
            <TextInput
              ref={composerRef}
              style={styles.input}
              placeholder="Park something for later..."
              placeholderTextColor={PLACEHOLDER_COLOR_DARK}
              value={newTaskTitle}
              onChangeText={setNewTaskTitle}
              onSubmitEditing={handleManualAdd}
              returnKeyType="done"
              accessibilityLabel="Park something for later"
              accessibilityHint="Adds an item to your inbox"
            />
          </View>
        )}

        <DraggableFlatList
          // Bound the list's height or it can never scroll: RN views default
          // to flexShrink 0, so without flex:1 the container + FlatList grow
          // to the content's full height — a scroll view whose frame equals
          // its content just rubber-bands (the "stuck, bounces back" bug).
          // containerStyle bounds the library's wrapper Animated.View; style
          // passes through onto the inner FlatList itself. Both are needed.
          containerStyle={{ flex: 1 }}
          style={{ flex: 1 }}
          data={rows}
          onDragEnd={handleDragEnd}
          keyExtractor={(item: InboxRow) => item.key}
          renderItem={renderItem}
          ListEmptyComponent={ListEmpty}
          // Compose the static horizontal padding from styles.scroll
          // with dynamic top + bottom insets:
          //   - paddingTop: 8 prevents the first card's top edge
          //     (border radius corners + checkmark) from clipping
          //     against the filter tabs above the list.
          //   - paddingBottom: tabBarHeight + insets.bottom + 40
          //     guarantees clearance over the floating tab bar AND
          //     the home indicator. The +40 is breathing room so
          //     overscroll bounce doesn't tuck the last card.
          contentContainerStyle={[
            styles.scroll,
            {
              paddingTop: tokens.spacing.xs,
              // FIXME(nex-56): off-scale spacing 40 — composed with dynamic tabBarHeight + insets.bottom
              paddingBottom: tabBarHeight + insets.bottom + 40,
              flexGrow: 1,
            },
          ]}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          activationDistance={10}
          refreshControl={
            remindersConnected ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handlePullToRefresh}
                tintColor={tokens.color.gold}
                colors={[tokens.color.gold]}
              />
            ) : undefined
          }
        />
        </AdaptiveScreen>
      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent', paddingTop: 80 /* FIXME(nex-56): off-scale spacing 80 — between xxxl(72) and huge(96), review */ },
  header: { alignItems: 'center', marginBottom: 25 /* FIXME(nex-56): off-scale spacing 25 — between lg(24) and xl(32), review */ },
  // FIXME(nex-56): off-scale fontSize 12, design review
  headerTitle: { color: tokens.color.gold, fontSize: 12, fontWeight: '900', letterSpacing: 6 },
  tabContainer: { flexDirection: 'row', justifyContent: 'center', marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, borderBottomWidth: 1, borderBottomColor: tokens.color.surfaceElevated },
  tab: { alignItems: 'center', paddingBottom: tokens.spacing.sm, paddingHorizontal: 30 /* FIXME(nex-56): off-scale spacing 30 — between lg(24) and xl(32), review */ },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 10, design review
  tabText: { color: tokens.color.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  // FIXME(nex-56): tokens.color.text off-scale neutral white — design review (table maps text/text variants but not bare #FFF here)
  tabTextActive: { color: tokens.color.text },
  tabIndicator: { height: 2, width: '100%', backgroundColor: tokens.color.gold, position: 'absolute', bottom: -1 },
  // paddingBottom is composed inline at the call site using
  // useBottomTabBarHeight() so it adapts to device safe areas.
  scroll: { paddingHorizontal: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  // tokens.color.surface close to surface (#111113, ΔE<0.5) — established precedent
  // FIXME(nex-56): tokens.color.goldHairline neutral border, no token — design review (CLAUDE.md §6.2 wants gold hairline)
  inputWrapper: { backgroundColor: tokens.color.surface, borderRadius: 16, borderWidth: 1, borderColor: tokens.color.goldHairline, marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  // FIXME(nex-56): tokens.color.text off-scale neutral white — design review
  // FIXME(nex-56): off-scale fontSize 14, design review
  input: { padding: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, color: tokens.color.text, fontSize: 14 },
  emptyState: { alignItems: 'center', marginTop: 100 /* FIXME(nex-56): off-scale spacing 100 — above huge(96), review */, paddingHorizontal: tokens.spacing.xl },
  // v3 stellar follow-up: empty-state text was tokens.color.textDisabled
  // (#4A5260) — a v2 holdover that disappeared against the cosmic backdrop.
  // Bumped to text + textSecondary with a soft dark text-shadow so the
  // text floats *above* the nebula instead of dissolving into it. The
  // shadow pattern (0/0/4px black @60%) is the standard "text on photo"
  // contrast lift; subtle enough that it doesn't read as a stickered glow.
  emptyText: {
    color: tokens.color.text,
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 6,
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 1 },
  },
  emptySub: {
    color: tokens.color.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: tokens.spacing.md,
    fontStyle: 'italic',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
  // Apple Reminders doorway card — replaces the standard empty state
  // when the user has no items AND no Reminders connection.
  doorwayCard: { backgroundColor: tokens.color.surface, borderRadius: 16, padding: tokens.spacing.lg, borderWidth: 1, borderColor: tokens.color.luminousEdge, alignItems: 'center', width: '100%', ...ambientGlowSoft },
  // FIXME(nex-56): off-scale fontSize 11, design review
  doorwayTitle: { color: tokens.color.gold, fontSize: 11, fontWeight: '900', letterSpacing: 3, marginBottom: tokens.spacing.sm, textAlign: 'center' },
  // FIXME(nex-56): tokens.color.textSecondary off-scale gray — design review
  // FIXME(nex-56): fontSize 13 matches caption size but lineHeight 19 ≠ token 18, fontWeight default ≠ token '500' — design review
  doorwayBody: { color: tokens.color.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 18 /* FIXME(nex-56): off-scale spacing 18 — review */ },
  // Sync status row above the tabs — only when Apple Reminders is connected.
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 10, design review
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    marginHorizontal: 20 /* FIXME(nex-56): off-scale spacing 20 — matches syncStatus */,
    marginBottom: tokens.spacing.sm,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdgeSoft,
    backgroundColor: tokens.color.surface,
  },
  sourceRowPressed: {
    borderColor: tokens.color.luminousEdge,
  },
  sourceRowLabel: {
    flex: 1,
    color: tokens.color.textMuted,
    fontSize: 10,
    fontFamily: tokens.font.plexMonoRegular,
    letterSpacing: 2,
  },
  syncStatus: {
    color: tokens.color.textMuted,
    fontSize: 10,
    fontFamily: tokens.font.plexMonoRegular,
    letterSpacing: 2,
    paddingHorizontal: 20 /* FIXME(nex-56): off-scale spacing 20 — review */,
    marginBottom: tokens.spacing.sm,
  },
  // Per-card source attribution. Sits below cardTitle, above any nextAction row.
  // FIXME(nex-56): tokens.color.textDisabled off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 9, design review
  sourceBadge: {
    color: tokens.color.textDisabled,
    fontSize: 9,
    fontFamily: tokens.font.plexMonoRegular,
    letterSpacing: 2,
    marginTop: -8 /* FIXME(nex-56): negative spacing -8 — overlap layout, review */,
    marginBottom: tokens.spacing.xs,
  },
  // Phase 3: items orphaned by external deletion render the badge a
  // shade darker so the "removed externally" tag reads as muted.
  // v3 stellar: orphaned badge gray #3A3A3A → tokens.color.textDisabled.
  sourceBadgeOrphaned: { color: tokens.color.textDisabled },
  // NEX-215: a second provenance line (e.g. the due-date line under the
  // capture-proof line) cancels sourceBadge's -8 tuck so the two stack cleanly
  // instead of overlapping.
  stackedBadge: { marginTop: 0 },
  card: { backgroundColor: tokens.color.surface, borderRadius: 16, padding: 18 /* FIXME(nex-56): off-scale spacing 18 — review */, marginBottom: tokens.spacing.sm, borderWidth: 1, borderColor: tokens.color.luminousEdge, ...ambientGlowSoft },
  cardHeader: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginBottom: tokens.spacing.xs },
  // The non-color carrier for item status. Deliberately the quietest label on
  // the card — same 10pt tracked mono as the source rows — so status is
  // legible and announced without becoming the badge noise that was removed.
  // flex: 1 takes the free space so the complete/restore button stays right.
  statusLabel: {
    flex: 1,
    color: tokens.color.textMuted,
    fontSize: 10,
    fontFamily: tokens.font.plexMonoRegular,
    letterSpacing: 2,
  },
  // v3 stellar: legacy gold tint rgba(212,175,55,...) → tokens.color.goldWash
  // (new gold-rgba). Border kept as token-driven gold.
  checkBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: tokens.color.goldWash, justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: tokens.color.gold },
  // v3 stellar: archived btn border #333 → tokens.color.goldHairline (now white).
  checkBtnArchived: { backgroundColor: 'rgba(255,255,255,0.05)', borderColor: tokens.color.goldHairline },
  // FIXME(nex-56): fontSize 13 matches caption size but fontWeight '900' ≠ token '500' — design review
  checkText: { color: tokens.color.gold, fontSize: 13, fontWeight: '900' },
  // v3 stellar: archived check text gray #555 → tokens.color.textMuted.
  checkTextArchived: { color: tokens.color.textMuted },
  // v3 stellar: neutral white #FFF → tokens.color.text (now pure white).
  // FIXME(nex-56): fontSize 16 matches buttonPrimary size but fontWeight '600' ≠ token '600' AND lineHeight 23 ≠ token 20 — design review
  cardTitle: { color: tokens.color.text, fontSize: 16, fontWeight: '600', lineHeight: 23, marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */ },
  // v3 stellar: archived title gray #555 → tokens.color.textMuted.
  cardTitleArchived: { color: tokens.color.textMuted, textDecorationLine: 'line-through' },
  // v3 stellar: drag-handle gray #333 → tokens.color.textDisabled.
  // FIXME(nex-56): off-scale fontSize 20, design review
  dragHandle: { color: tokens.color.textDisabled, fontSize: 20, fontWeight: '700', paddingLeft: tokens.spacing.sm },
  // tokens.color.surface close to surface (#111113, ΔE<0.5) — established precedent
  // FIXME(nex-56): tokens.color.goldHairline neutral border, no token — design review
  actionRow: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: tokens.color.surface, padding: 15 /* FIXME(nex-56): off-scale spacing 15 — review */, borderRadius: 12, borderWidth: 1, borderColor: tokens.color.goldHairline },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 9, design review
  actionLabel: { color: tokens.color.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 2, marginRight: tokens.spacing.sm, marginTop: 2 /* FIXME(nex-56): off-scale spacing 2 — review */ },
  // FIXME(nex-56): off-scale fontSize 12, design review
  actionValue: { flex: 1, color: tokens.color.gold, fontSize: 12, fontWeight: '600', lineHeight: 18 },
  editContainer: { width: '100%' },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 9, design review
  editLabel: { color: tokens.color.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.xs },
  // tokens.color.surface close to surface (#111113, ΔE<0.5) — established precedent
  // FIXME(nex-56): tokens.color.text off-scale neutral white — design review
  // FIXME(nex-56): tokens.color.goldHairline neutral border, no token — design review
  // FIXME(nex-56): off-scale fontSize 14, design review
  editInput: { backgroundColor: tokens.color.surface, color: tokens.color.text, fontSize: 14, padding: 15 /* FIXME(nex-56): off-scale spacing 15 — review */, borderRadius: 12, borderWidth: 1, borderColor: tokens.color.goldHairline, marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ },
  cancelBtn: { paddingVertical: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, paddingHorizontal: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, marginRight: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 11, design review
  cancelBtnText: { color: tokens.color.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 2 }
});
