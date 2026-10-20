export const PERSIST_STORAGE_KEY = 'nexus-sovereign-storage';
// v15 (fix/pre-testflight-bundle): backfill RecurringToDo.exceptions = [].
// v16 (redesign/scoring-phase-0-data): backfill RecurringRule.anchor = null.
// v17 (feat/apple-reminders-phase-1): backfill InboxTask.source = 'manual'.
// v18-v21: additive inbox/banner/detail fields.
// v23 (fix/nex-76-mandate-habit-link-integrity): scrub legacy orphan goalHabitMap keys.
// v24 (NEX-108): wrap persistence with automatic raw backups before hydration/migration and after writes.
// v25 (fix/emoji-rename-orphaned-logs): re-attach habit-log completions orphaned when the v3 UI push
//   stripped emoji from titles (rename migrated goalHabitMap but not habitLog). See habit-log-reconcile.ts.
// v26 (NEX-164): backfill firstHabitCompletedAt (established users get a non-null value so the new
//   habit_completed is_first signal never fires for them) + firstActionIntent default.
// v27 (NEX-171): derive per-rule excludedFromScore from the legacy pinnedHabits
//   (pins → only-pinned-count; the un-pinned become excluded). pinnedHabits is
//   kept (derived = non-excluded ids) for one release for widget + cloud compat.
// v28 (NEX-162): introduce leadTimeActions (Lead-Time Radar). Additive — the
//   migrate body backfills via backfillLeadTimeActions (undefined → []); the
//   field is added to the migrate allow-list so a later bump can't wipe it.
// v29 (NEX-207): introduce pauseMode (Pause Mode interval-history). Additive —
//   the migrate allow-list returns normalizePauseMode(draft.pauseMode) (→ inactive
//   default for existing users) so a later bump can't wipe it.
// v30 (coach thread): introduce coachThread (docs/plans/2026-09-02-coach-
//   conversation.md). Additive — the migrate allow-list returns
//   sanitizeCoachThread(draft.coachThread) (→ empty thread for existing users)
//   so a later bump can't wipe it.
export const PERSIST_VERSION = 30;
