/**
 * Phase 5 — first-connect triage flow store.
 *
 * Holds the state of the welcoming-ritual modal that fires exactly
 * once: when the user first connects Apple Reminders and the initial
 * sync brings in items. After triage completes (or is dismissed),
 * triageCompletedAt is stamped and the modal never re-renders.
 *
 * Persisted across kills so a user who closes Nexus mid-triage can
 * pick up where they left off rather than re-triaging.
 *
 * State semantics:
 *   - currentBatch:  ordered local InboxTask ids to triage. Empty
 *                    when the modal is not active.
 *   - currentIndex:  pointer into currentBatch. When it equals
 *                    currentBatch.length, the user has decided every
 *                    card and the "Done" screen should show.
 *   - decisions:     map of itemId → decision, kept for the optional
 *                    "are you sure?" recap and for future analytics.
 *                    Cleared on complete/dismiss.
 *   - isActive:      single boolean the root layout watches to mount
 *                    or unmount the modal. Decoupling this from
 *                    currentBatch.length lets us animate the modal
 *                    out cleanly on dismiss.
 *   - triageCompletedAt: stamped on complete OR dismiss. The "did
 *                    we ever finish triage" gate.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TriageDecision } from './triage-decisions';

interface TriageState {
  triageCompletedAt: number | null;
  currentBatch: string[];
  currentIndex: number;
  decisions: Record<string, TriageDecision>;
  isActive: boolean;
}

interface TriageActions {
  /**
   * Begin triage on the given local InboxTask ids. No-op if triage
   * has already been completed once (the gate that prevents
   * disconnect/reconnect from re-triggering). No-op on empty input.
   */
  startTriage: (itemIds: string[]) => void;
  /**
   * Record the user's choice for the current card. Caller is also
   * responsible for applying the patch to app-state and (for
   * Today/This week) pushing the EventKit due-date update.
   */
  recordDecision: (itemId: string, decision: TriageDecision) => void;
  /**
   * Move to the next card. When called past the end, the modal stays
   * on the "Done" screen — the UI calls complete() to dismiss.
   */
  advance: () => void;
  /**
   * Mark triage finished cleanly. Stamps triageCompletedAt, clears
   * the batch, hides the modal.
   */
  complete: () => void;
  /**
   * Early exit. Identical to complete() in terms of gating future
   * triggers — once dismissed, triage never re-fires. Items with no
   * decision are left untouched (effectively "Later").
   */
  dismiss: () => void;
  /**
   * The current item id under triage, or null if the modal is at the
   * "Done" screen or inactive.
   */
  getCurrentItemId: () => string | null;
  /**
   * Number of items the user has not yet decided on. Drives the
   * "Skip remaining (N)" link.
   */
  remainingCount: () => number;
}

export type TriageStore = TriageState & TriageActions;

export const useTriageStore = create<TriageStore>()(
  persist(
    (set, get) => ({
      triageCompletedAt: null,
      currentBatch: [],
      currentIndex: 0,
      decisions: {},
      isActive: false,

      startTriage: (itemIds) => {
        const s = get();
        if (s.triageCompletedAt !== null) {
          // The completion gate. Disconnect/reconnect MUST NOT
          // re-trigger triage — that would be a UX trap.
          // eslint-disable-next-line no-console
          console.log('[triage] startTriage: skipped — already completed');
          return;
        }
        if (!Array.isArray(itemIds) || itemIds.length === 0) {
          // eslint-disable-next-line no-console
          console.log('[triage] startTriage: skipped — empty batch');
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`[triage] startTriage: ${itemIds.length} items`);
        set({
          currentBatch: itemIds,
          currentIndex: 0,
          decisions: {},
          isActive: true,
        });
      },

      recordDecision: (itemId, decision) => {
        const s = get();
        set({
          decisions: { ...s.decisions, [itemId]: decision },
        });
      },

      advance: () => {
        const s = get();
        const next = Math.min(s.currentIndex + 1, s.currentBatch.length);
        set({ currentIndex: next });
      },

      complete: () => {
        // Stack-trace logging is intentional: we saw an unexplained
        // [triage] complete fire immediately after startTriage on
        // first device QA, with no user input. The root cause never
        // surfaced in code review. If it recurs, the trace tells us
        // where the call came from (UI tap, hydration, effect, etc.)
        // Production cost is one Error allocation per genuine
        // complete — negligible.
        // eslint-disable-next-line no-console
        console.log('[triage] complete (stack):', new Error().stack);
        set({
          triageCompletedAt: Date.now(),
          currentBatch: [],
          currentIndex: 0,
          decisions: {},
          isActive: false,
        });
      },

      dismiss: () => {
        // Same gating as complete() — flag triage as finished so it
        // doesn't re-trigger on next connect. The user has spoken.
        // Stack-trace for the same reason as complete().
        // eslint-disable-next-line no-console
        console.log('[triage] dismiss (stack):', new Error().stack);
        set({
          triageCompletedAt: Date.now(),
          currentBatch: [],
          currentIndex: 0,
          decisions: {},
          isActive: false,
        });
      },

      getCurrentItemId: () => {
        const s = get();
        if (!s.isActive) return null;
        if (s.currentIndex >= s.currentBatch.length) return null;
        return s.currentBatch[s.currentIndex] ?? null;
      },

      remainingCount: () => {
        const s = get();
        return Math.max(0, s.currentBatch.length - s.currentIndex);
      },
    }),
    {
      name: 'nexus-triage-store',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      // Persist the gate + the in-progress batch so a kill mid-triage
      // resumes cleanly. decisions is also persisted for the same
      // reason — the user might be on card 4 of 7.
      partialize: (state) => ({
        triageCompletedAt: state.triageCompletedAt,
        currentBatch: state.currentBatch,
        currentIndex: state.currentIndex,
        decisions: state.decisions,
        isActive: state.isActive,
      }) as Partial<TriageState>,
    },
  ),
);
