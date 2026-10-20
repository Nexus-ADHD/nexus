/**
 * Reminders integration store — persisted Zustand slice tracking the
 * user's Apple Reminders connection state, list selection, and last
 * sync timestamp. Phase 1 covers everything except actual sync; the
 * `lastSyncedAt` field is reserved for Phase 2.
 *
 * `isConnected` is a derived assertion: permission granted AND at
 * least one list selected. Components consuming the doorway logic
 * should read this single boolean rather than re-deriving.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import {
  type ReminderList,
  type ReminderPermissionStatus,
  getPermissionStatus,
  listReminderLists,
  requestPermission as nativeRequestPermission,
  createNexusList as nativeCreateNexusList,
  fetchIncompleteReminders,
  fetchCompletedReminders,
  createReminder as nativeCreateReminder,
  deleteReminder as nativeDeleteReminder,
} from '../services/apple-reminders';
import { useAppState } from './app-state';
import { useTriageStore } from './triage-store';
import { shouldTriggerTriage } from './triage-decisions';

/**
 * Throttle window for focus-driven sync. Pull-to-refresh bypasses.
 * 30s is short enough that returning to the tab after a context
 * switch feels live, long enough that bouncing tabs doesn't thrash
 * EventKit.
 */
const SYNC_THROTTLE_MS = 30_000;

interface RemindersState {
  permissionStatus: ReminderPermissionStatus;
  syncedListIds: string[];
  availableLists: ReminderList[];
  lastSyncedAt: number | null;
  /**
   * The id of the user's "Nexus" reminders list (the one created via
   * createNexusList). All voice-mirrored reminders go to this list —
   * keeping voice captures from polluting the user's other lists.
   * Null when the user hasn't created the Nexus list yet, or when
   * it's been deleted externally.
   */
  nexusListId: string | null;
}

interface RemindersActions {
  /**
   * Derived: true only when permission is granted AND at least one
   * list is selected for sync. Surfaces, in particular, drive the
   * Inbox doorway empty-state on this flag.
   */
  isConnected: () => boolean;
  /**
   * Cold-start bootstrap. Called once from the root layout's
   * useEffect so the store knows the real iOS permission state
   * before any tab renders. Without this, persisted state hydrates
   * with permission='undetermined' and the Inbox doorway flickers
   * on launch — see the Phase 1 doorway-flicker bug.
   */
  bootstrap: () => Promise<void>;
  /**
   * Asks iOS for reminders access. Updates permissionStatus; if
   * granted, also refreshes availableLists. Returns the new status.
   */
  requestPermission: () => Promise<ReminderPermissionStatus>;
  /**
   * Convenience: requestPermission, then auto-select all lists. Used
   * by the "Connect Apple Reminders" CTA on the settings screen.
   */
  connectIntegration: () => Promise<ReminderPermissionStatus>;
  /**
   * Clears syncedListIds and lastSyncedAt. Permission stays whatever
   * iOS reports; user revokes via Settings → Privacy if desired.
   */
  disconnectIntegration: () => void;
  /**
   * Toggles whether a given list is included in sync. Idempotent.
   */
  toggleListSync: (listId: string) => void;
  /**
   * Re-fetches the user's reminder lists from iOS and stores them in
   * availableLists. Also re-syncs permissionStatus from the native
   * side (the user may have flipped it in iOS Settings).
   */
  refreshLists: () => Promise<void>;
  /**
   * Creates a Nexus-branded reminders list. Auto-toggles it on once
   * created. Throws on platform / creation failure (caller handles).
   */
  createNexusList: () => Promise<string>;
  /**
   * Phase 2 read path: fetch incomplete reminders from selected
   * lists, upsert into the inbox, and stamp lastSyncedAt. Returns a
   * tally for the caller's status surface. Returns zeros on:
   *   - empty syncedListIds
   *   - permission not granted
   *   - any error during fetch / upsert (logged, swallowed — sync
   *     should never crash the inbox view)
   */
  syncReminders: () => Promise<{ added: number; updated: number; skipped: number }>;
  /**
   * Phase 4 voice-mirror path. Creates an Apple Reminder in the
   * user's Nexus list. Returns { externalId } on success, null on
   * any non-fatal skip (not connected, no Nexus list, EventKit
   * failure). NEVER throws — voice capture must not fail because
   * of EventKit.
   */
  mirrorToReminders: (input: { title: string; dueDate?: string; notes?: string })
    => Promise<{ externalId: string } | null>;
  /**
   * NEX-195 undo: best-effort delete a mirrored Apple Reminder by its
   * EventKit id. NEVER throws — undo of the local Nexus item is the
   * source of truth; the reminder removal is a courtesy. No-ops when
   * not connected. Returns true only when EventKit confirmed the delete.
   */
  deleteMirroredReminder: (externalId: string) => Promise<boolean>;
  /**
   * Returns the persisted Nexus list id, or null if the user
   * hasn't created the Nexus list yet (or it was deleted).
   */
  getNexusListId: () => string | null;
  /**
   * True when lastSyncedAt is within SYNC_THROTTLE_MS. Used by the
   * Inbox focus-effect to skip redundant syncs. Pull-to-refresh
   * bypasses this check.
   */
  isThrottled: () => boolean;
}

export type RemindersStore = RemindersState & RemindersActions;

export const useRemindersStore = create<RemindersStore>()(
  persist(
    (set, get) => ({
      permissionStatus: 'undetermined',
      syncedListIds: [],
      availableLists: [],
      lastSyncedAt: null,
      nexusListId: null,

      isConnected: () => {
        const s = get();
        return s.permissionStatus === 'granted' && s.syncedListIds.length > 0;
      },

      bootstrap: async () => {
        try {
          const status = await getPermissionStatus();
          if (status === 'granted') {
            const lists = await listReminderLists();
            // If we don't have a persisted nexusListId yet but the
            // user already has a "Nexus" list (from a prior install
            // or manual creation in iOS), auto-detect and stamp it.
            // Phase 4 mirror needs this id; without it, voice
            // captures silently fall back to manual.
            const persistedNexus = get().nexusListId;
            const detectedNexus = persistedNexus ?? (lists.find((l) => l.isNexus)?.id ?? null);
            set({
              permissionStatus: status,
              availableLists: lists,
              nexusListId: detectedNexus,
            });
            // eslint-disable-next-line no-console
            console.log(
              `[reminders] bootstrap: permission=${status}, lists=${lists.length}, synced=${get().syncedListIds.length}, nexusListId=${detectedNexus ?? 'none'}`,
            );
          } else {
            set({ permissionStatus: status });
            // eslint-disable-next-line no-console
            console.log(
              `[reminders] bootstrap: permission=${status}, lists=0, synced=${get().syncedListIds.length}`,
            );
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[reminders] bootstrap failed:', (e as Error)?.message ?? e);
        }
      },

      requestPermission: async () => {
        const status = await nativeRequestPermission();
        if (status === 'granted') {
          const lists = await listReminderLists();
          set({ permissionStatus: status, availableLists: lists });
        } else {
          set({ permissionStatus: status });
        }
        return status;
      },

      connectIntegration: async () => {
        const status = await get().requestPermission();
        if (status === 'granted') {
          // Auto-select all lists on first connect. User can untoggle
          // any they don't want from the settings screen.
          const allIds = get().availableLists.map((l) => l.id);
          set({ syncedListIds: allIds });
        }
        return status;
      },

      disconnectIntegration: () => {
        // Archive any imported items first so they don't keep cluttering
        // the active inbox after the user breaks the connection. The
        // app-state action handles this in one pass; we still clear our
        // own state afterward.
        try {
          const archive = (useAppState as any).getState().archiveAllAppleReminders;
          if (typeof archive === 'function') archive();
        } catch (e) {
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.warn('[reminders] archive on disconnect failed:', (e as Error)?.message ?? e);
          }
        }
        set({ syncedListIds: [], lastSyncedAt: null });
      },

      toggleListSync: (listId: string) => {
        const current = get().syncedListIds;
        const next = current.includes(listId)
          ? current.filter((id) => id !== listId)
          : [...current, listId];
        set({ syncedListIds: next });
      },

      refreshLists: async () => {
        const status = await getPermissionStatus();
        if (status !== 'granted') {
          set({ permissionStatus: status, availableLists: [] });
          return;
        }
        const lists = await listReminderLists();
        // Drop any synced ids that no longer exist in availableLists —
        // user deleted the list in iOS Reminders.
        const liveIds = new Set(lists.map((l) => l.id));
        const prunedSelection = get().syncedListIds.filter((id) => liveIds.has(id));
        set({
          permissionStatus: status,
          availableLists: lists,
          syncedListIds: prunedSelection,
        });
      },

      createNexusList: async () => {
        const id = await nativeCreateNexusList();
        // Re-fetch so availableLists includes the new list.
        const lists = await listReminderLists();
        const current = get().syncedListIds;
        const next = current.includes(id) ? current : [...current, id];
        // Stamp nexusListId so Phase 4's voice mirror can target it
        // without needing to re-detect every time.
        set({ availableLists: lists, syncedListIds: next, nexusListId: id });
        return id;
      },

      syncReminders: async () => {
        const zeros = { added: 0, updated: 0, skipped: 0 };
        // If permission hasn't been resolved yet (cold-start race
        // where useFocusEffect fires before bootstrap), bootstrap
        // now and re-read state. Without this, the very first sync
        // after launch silently bails and lastSyncedAt stays null
        // forever — that's Bug B from the Phase 3.1 brief.
        let state = get();
        if (state.permissionStatus !== 'granted') {
          // eslint-disable-next-line no-console
          console.log('[reminders] sync: permission unknown, bootstrapping');
          await get().bootstrap();
          state = get();
        }
        if (state.permissionStatus !== 'granted' || state.syncedListIds.length === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[reminders] sync: skipped — not connected (perm=${state.permissionStatus}, listCount=${state.syncedListIds.length})`,
          );
          return zeros;
        }
        // eslint-disable-next-line no-console
        console.log(`[reminders] sync: start (lists=${state.syncedListIds.length})`);
        try {
          // Fetch incomplete + completed in one window. Both inside
          // the same try/catch so a partial failure doesn't leave the
          // reconcile pass running on stale data — we'd rather skip
          // the sync entirely and let pull-to-refresh retry.
          const [incompletes, completes] = await Promise.all([
            fetchIncompleteReminders(state.syncedListIds),
            fetchCompletedReminders(state.syncedListIds, 30),
          ]);
          // eslint-disable-next-line no-console
          console.log(
            `[reminders] sync: fetched ${incompletes.length} incomplete, ${completes.length} completed`,
          );
          const appState = (useAppState as any).getState();
          const upsert = appState.upsertRemindersFromApple;
          const reconcile = appState.reconcileExternalState;
          const tally = typeof upsert === 'function' ? upsert(incompletes) : zeros;
          // eslint-disable-next-line no-console
          console.log(
            `[reminders] sync: upserted +${tally.added} ~${tally.updated} -${tally.skipped}`,
          );
          if (typeof reconcile === 'function') {
            reconcile({
              incompleteIds: new Set(incompletes.map((r: any) => r.id)),
              completedIds: new Set(completes.map((r: any) => r.id)),
            });
          }
          // Phase 5: first-connect triage trigger. shouldTriggerTriage
          // is the single source of truth for "is this the welcoming
          // ritual moment?" — depends on triageCompletedAt staying
          // null AND lastSyncedAt being null AND added > 0. Compute
          // BEFORE we stamp lastSyncedAt below.
          const triageState = (useTriageStore as any).getState();
          const trigger = shouldTriggerTriage({
            triageCompletedAt: triageState.triageCompletedAt,
            lastSyncedAt: state.lastSyncedAt,
            added: tally.added,
          });
          if (trigger) {
            // Resolve fetched-record externalIds back to local InboxTask
            // ids by reading the post-upsert inbox. The triage store
            // batch is keyed on local ids so the UI can apply patches
            // via app-state.updateInboxTask.
            const incomingExternal = new Set(incompletes.map((r: any) => r.id));
            const post = (useAppState as any).getState().inbox as Array<{
              id: string;
              externalId?: string;
              source?: string;
              status?: string;
            }>;
            const batch = post
              .filter(
                (t) =>
                  t.source === 'apple_reminders' &&
                  t.status !== 'ARCHIVED' &&
                  t.externalId &&
                  incomingExternal.has(t.externalId),
              )
              .map((t) => t.id);
            if (batch.length > 0) {
              // eslint-disable-next-line no-console
              console.log(`[reminders] sync: triggering first-connect triage (${batch.length} items)`);
              triageState.startTriage(batch);
            }
          }
          const ts = Date.now();
          set({ lastSyncedAt: ts });
          // eslint-disable-next-line no-console
          console.log(`[reminders] sync: done (lastSyncedAt=${new Date(ts).toISOString()})`);
          return tally;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[reminders] sync: ERROR', e);
          if (__DEV__) {
            // Surface the failure on-device so we can diagnose without
            // tailing Metro. Production builds stay silent — error log
            // above is enough for crash reporters.
            try {
              Alert.alert('Reminders sync error', String((e as any)?.message ?? e));
            } catch {
              /* Alert can fail if the JS thread is bad — ignore. */
            }
          }
          // Don't stamp lastSyncedAt on failure — pull-to-refresh
          // should retry without throttle confusion.
          return zeros;
        }
      },

      isThrottled: () => {
        const ts = get().lastSyncedAt;
        if (ts === null) return false;
        return Date.now() - ts < SYNC_THROTTLE_MS;
      },

      getNexusListId: () => get().nexusListId,

      mirrorToReminders: async (input) => {
        const state = get();
        // Connection IS the consent — but we still need a target list.
        // If the user hasn't created the Nexus list, silently no-op
        // rather than dumping voice captures into another list.
        if (state.permissionStatus !== 'granted' || state.syncedListIds.length === 0) {
          // eslint-disable-next-line no-console
          console.log('[reminders] mirror: skipped — not connected');
          return null;
        }
        if (!state.nexusListId) {
          // eslint-disable-next-line no-console
          console.log('[reminders] mirror: skipped — no Nexus list (create one in Settings → Apple Reminders)');
          return null;
        }
        try {
          const externalId = await nativeCreateReminder({
            listId: state.nexusListId,
            title: input.title,
            dueDate: input.dueDate,
            notes: input.notes,
          });
          // eslint-disable-next-line no-console
          console.log(`[reminders] mirror: created ${externalId}`);
          return { externalId };
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[reminders] mirror: ERROR', e);
          // Never throw — voice capture must succeed locally even if
          // the EventKit write fails. Caller treats null as "didn't
          // mirror" and leaves the local item as manual-source.
          return null;
        }
      },

      deleteMirroredReminder: async (externalId) => {
        const id = (externalId ?? '').trim();
        if (!id) return false;
        // Connection IS the consent — and `disconnectIntegration` clears
        // syncedListIds while LEAVING permissionStatus granted, so a bare
        // permission check would still delete a real EventKit reminder from a
        // stale undo tap after the user disconnected. Gate on the same
        // isConnected() check sync/mirror use (granted AND has synced lists).
        if (!get().isConnected()) {
          return false;
        }
        try {
          await nativeDeleteReminder(id);
          return true;
        } catch (e) {
          console.error('[reminders] undo-delete: ERROR', e);
          // Never throw — the local Nexus undo already succeeded.
          return false;
        }
      },
    }),
    {
      name: 'nexus-reminders-store',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist user choice + last sync. permissionStatus and
      // availableLists are re-fetched from iOS on app start so we
      // always have a fresh view.
      partialize: (state) => ({
        syncedListIds: state.syncedListIds,
        // lastSyncedAt is persisted so the throttle window survives
        // app restarts. Without persistence, every cold start would
        // refetch immediately even if a sync just ran.
        lastSyncedAt: state.lastSyncedAt,
        // nexusListId persists so voice-mirror has a target on cold
        // start without waiting for bootstrap to re-detect.
        nexusListId: state.nexusListId,
      }) as Partial<RemindersState>,
    },
  ),
);
