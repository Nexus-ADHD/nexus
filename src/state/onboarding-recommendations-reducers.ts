// NEX-26 phase D — pure reducers for the onboardingRecommendations slice.
//
// The Zustand actions in app-state.ts wrap these helpers. Keeping the
// logic pure (state in, state out) matches the existing reducer
// pattern in src/state/ (reconcile-external-state, upsert-reminders)
// and lets vitest exercise the slot-mutation semantics without
// touching AsyncStorage or the rest of the store.
//
// Cap-reached gating happens HERE, not in the UI. The UI reads
// refreshCount from the slice and disables the button at >= 8 — the
// reducer is the safety net that no-ops a stray callthrough.

import type {
  OnboardingRecommendations,
  OnboardingRecommendedMandate,
  OnboardingRecommendedHabit,
  OnboardingRecommendedTodo,
  OnboardingRecommendedRecurringTodo,
} from './app-state';

/** Per-slot refresh cap. Beyond this, refresh mutators no-op. */
export const REFRESH_CAP = 8;

/**
 * Edit the title of a mandate. Does NOT tick refreshCount — title
 * edits are cheap user-initiated changes, not "ask Pulse for an
 * alternative." If the new title is identical or empty after trim,
 * returns the unchanged slice (no-op).
 */
export function applyMandateTitle(
  recs: OnboardingRecommendations | null,
  mandateId: string,
  newTitle: string,
): OnboardingRecommendations | null {
  if (!recs) return recs;
  const trimmed = newTitle.trim();
  if (!trimmed) return recs;
  const idx = recs.mandates.findIndex((m) => m.id === mandateId);
  if (idx === -1) return recs;
  if (recs.mandates[idx].title === trimmed) return recs;
  const next = [...recs.mandates];
  next[idx] = { ...next[idx], title: trimmed };
  return { ...recs, mandates: next };
}

/**
 * Replace a mandate with a refreshed version. Caller passes the new
 * mandate fields (title, category, rationaleSource). Counter ticks
 * here so all callers get the cap-gating uniformly.
 *
 * No-op if the mandate is already at cap or if mandateId isn't found.
 */
export function applyMandateRefresh(
  recs: OnboardingRecommendations | null,
  mandateId: string,
  fields: Pick<OnboardingRecommendedMandate, 'title' | 'category' | 'rationaleSource' | 'rationale'>,
): OnboardingRecommendations | null {
  if (!recs) return recs;
  const idx = recs.mandates.findIndex((m) => m.id === mandateId);
  if (idx === -1) return recs;
  if (recs.mandates[idx].refreshCount >= REFRESH_CAP) return recs;
  const next = [...recs.mandates];
  next[idx] = {
    ...next[idx],
    title: fields.title,
    category: fields.category,
    rationaleSource: fields.rationaleSource,
    rationale: fields.rationale,
    refreshCount: next[idx].refreshCount + 1,
  };
  return { ...recs, mandates: next };
}

/**
 * Replace a habit with a refreshed version. Keeps slotId and
 * mandateId. Ticks refreshCount. No-op at cap.
 */
export function applyHabitRefresh(
  recs: OnboardingRecommendations | null,
  slotId: string,
  fields: Pick<OnboardingRecommendedHabit, 'title' | 'daysOfWeek' | 'rationale'>,
): OnboardingRecommendations | null {
  if (!recs) return recs;
  const idx = recs.habits.findIndex((h) => h.slotId === slotId);
  if (idx === -1) return recs;
  if (recs.habits[idx].refreshCount >= REFRESH_CAP) return recs;
  const next = [...recs.habits];
  next[idx] = {
    ...next[idx],
    title: fields.title,
    daysOfWeek: [...fields.daysOfWeek],
    rationale: fields.rationale,
    refreshCount: next[idx].refreshCount + 1,
  };
  return { ...recs, habits: next };
}

/**
 * Replace a todo with a refreshed version. Keeps slotId and
 * mandateId. Ticks refreshCount. No-op at cap.
 */
export function applyTodoRefresh(
  recs: OnboardingRecommendations | null,
  slotId: string,
  fields: Pick<OnboardingRecommendedTodo, 'title' | 'rationale'>,
): OnboardingRecommendations | null {
  if (!recs) return recs;
  const idx = recs.todos.findIndex((t) => t.slotId === slotId);
  if (idx === -1) return recs;
  if (recs.todos[idx].refreshCount >= REFRESH_CAP) return recs;
  const next = [...recs.todos];
  next[idx] = {
    ...next[idx],
    title: fields.title,
    rationale: fields.rationale,
    refreshCount: next[idx].refreshCount + 1,
  };
  return { ...recs, todos: next };
}

/**
 * Replace a recurring-todo with a refreshed version. Keeps slotId and
 * mandateId. Ticks refreshCount. No-op at cap. NEX-60.
 */
export function applyRecurringTodoRefresh(
  recs: OnboardingRecommendations | null,
  slotId: string,
  fields: Pick<OnboardingRecommendedRecurringTodo, 'title' | 'daysOfWeek' | 'rationale'>,
): OnboardingRecommendations | null {
  if (!recs) return recs;
  const idx = recs.recurringTodos.findIndex((rt) => rt.slotId === slotId);
  if (idx === -1) return recs;
  if (recs.recurringTodos[idx].refreshCount >= REFRESH_CAP) return recs;
  const next = [...recs.recurringTodos];
  next[idx] = {
    ...next[idx],
    title: fields.title,
    daysOfWeek: [...fields.daysOfWeek],
    rationale: fields.rationale,
    refreshCount: next[idx].refreshCount + 1,
  };
  return { ...recs, recurringTodos: next };
}

/**
 * System-initiated cascade for per-mandate REGENERATE. Rewritten for
 * NEX-57's pool-with-tap pattern:
 *
 *   - Items already ADDed for this mandate are PRESERVED across the
 *     cascade. The user's picks survive.
 *   - Items still un-ADDed for this mandate are DROPPED, and the
 *     fresh pool from Pulse takes their place.
 *   - Items belonging to other mandates are untouched.
 *
 * New items arrive with fresh slotIds (the service generates them);
 * the reducer stamps `added: false`, `refreshCount: 0`, and forces
 * `mandateId` to the parent mandate even if the caller passed
 * something else.
 *
 * No counter ticks anywhere — this is system-initiated regeneration,
 * not a user-requested alternative. No cap-gating; the user can keep
 * regenerating un-ADDed slots as long as they want.
 */
export function applyMandateDownstream(
  recs: OnboardingRecommendations | null,
  mandateId: string,
  newHabits: OnboardingRecommendedHabit[],
  newRecurringTodos: OnboardingRecommendedRecurringTodo[],
  newTodos: OnboardingRecommendedTodo[],
): OnboardingRecommendations | null {
  if (!recs) return recs;
  if (!recs.mandates.some((m) => m.id === mandateId)) return recs;

  // For each bucket: keep items from OTHER mandates, plus ADDed items
  // from THIS mandate. Drop un-ADDed items from this mandate.
  const keptHabits = recs.habits.filter(
    (h) => h.mandateId !== mandateId || h.added,
  );
  const keptRecurringTodos = recs.recurringTodos.filter(
    (rt) => rt.mandateId !== mandateId || rt.added,
  );
  const keptTodos = recs.todos.filter(
    (t) => t.mandateId !== mandateId || t.added,
  );

  return {
    ...recs,
    habits: [
      ...keptHabits,
      ...newHabits.map((h) => ({ ...h, mandateId, added: false, refreshCount: 0 })),
    ],
    recurringTodos: [
      ...keptRecurringTodos,
      ...newRecurringTodos.map((rt) => ({ ...rt, mandateId, added: false, refreshCount: 0 })),
    ],
    todos: [
      ...keptTodos,
      ...newTodos.map((t) => ({ ...t, mandateId, added: false, refreshCount: 0 })),
    ],
  };
}

// ─── NEX-57 — ADD-toggle reducers ────────────────────────────────────────────
//
// Flip `added` on a single pool item by slotId. No refresh counter
// tick (this is the user picking, not asking for an alternative).
// No cap-gating (a user might add+un-add a card several times before
// settling). No-op if slotId isn't found in the relevant bucket.
// `commitActivation` reads these flags on Begin to know which items
// to route into canonical state.

export function applyToggleAddedHabit(
  recs: OnboardingRecommendations | null,
  slotId: string,
): OnboardingRecommendations | null {
  if (!recs) return recs;
  const idx = recs.habits.findIndex((h) => h.slotId === slotId);
  if (idx === -1) return recs;
  const next = [...recs.habits];
  next[idx] = { ...next[idx], added: !next[idx].added };
  return { ...recs, habits: next };
}

export function applyToggleAddedRecurringTodo(
  recs: OnboardingRecommendations | null,
  slotId: string,
): OnboardingRecommendations | null {
  if (!recs) return recs;
  const idx = recs.recurringTodos.findIndex((rt) => rt.slotId === slotId);
  if (idx === -1) return recs;
  const next = [...recs.recurringTodos];
  next[idx] = { ...next[idx], added: !next[idx].added };
  return { ...recs, recurringTodos: next };
}

export function applyToggleAddedTodo(
  recs: OnboardingRecommendations | null,
  slotId: string,
): OnboardingRecommendations | null {
  if (!recs) return recs;
  const idx = recs.todos.findIndex((t) => t.slotId === slotId);
  if (idx === -1) return recs;
  const next = [...recs.todos];
  next[idx] = { ...next[idx], added: !next[idx].added };
  return { ...recs, todos: next };
}
