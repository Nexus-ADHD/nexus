// NEX-315 (roadmap 3.2): drain Home-Screen habit completions on foreground.
//
// This is the RN half of interactive widgets. The Swift `CompleteHabitIntent`
// runs in the widget extension when a habit's button is tapped and appends a
// completion action to the App Group; it CANNOT touch app state. This module is
// what the app runs on its next foreground to make those taps real: read the
// queue, reconcile it (the pure, tested `planWidgetCompletions`), apply via
// `logHabit`, and clear the queue.
//
// The reconciler's safety story (set-to-done, so every double-apply race is a
// no-op) lives in `widget-completion-reconciler.ts`. This file is the impure
// wiring around it — App Group I/O and the store — kept as thin as possible so
// the part that can be wrong is small and the part that decides is pure.

import { planWidgetCompletions } from './widget-completion-reconciler';
import { normalize } from '../utils/text';

const APP_GROUP = 'group.com.jhuff.nexus';
/** App Group key the Swift intent appends to. Mirror in NexusWidget.swift. */
export const PENDING_KEY = 'widgetPendingCompletions';

/** What a drain did, so the caller can surface a Law A confirmation. */
export interface DrainResult {
  /** Raw titles that were newly logged, in apply order. */
  applied: string[];
}

type StoreLike = {
  habitLog?: unknown;
  recurringRules?: unknown;
  logHabit?: (title: string) => void;
};

/**
 * Given the raw queue and the current store, decide what to log TODAY.
 *
 * Split out from the I/O so it is pure and directly testable. logHabit is a
 * today-only operation (it computes `today` internally), so a completion the
 * widget stamped for a different day — a tap that crossed midnight before the
 * app was opened — is dropped here rather than logged against the wrong day.
 * The widget is a today surface, so this is the rare edge, and the habit is
 * still tappable in-app. Dropping is honest; back-dating via a today-only
 * writer would be a lie.
 *
 * @param queue      parsed pending-completions array (tolerates garbage)
 * @param habitLog   store habit log
 * @param rules      recurringRules, to derive the set of habits that exist and
 *                   each habit's daily target (timesPerDay — a 2x/day habit
 *                   accepts two taps)
 * @param todayKey   local `YYYY-MM-DD`
 * @returns raw titles to pass to logHabit, one entry PER REP to apply
 */
export function selectDrainCompletions(
  queue: unknown,
  habitLog: unknown,
  rules: unknown,
  todayKey: string,
): string[] {
  // Keys must be normalized the SAME way the reconciler normalizes action
  // titles — both use the canonical `normalize` (src/utils/text.ts, the same
  // key logHabit stores under), so there is no risk of a hand-rolled mirror
  // drifting and wrongly skipping a real habit. The value is the habit's
  // daily target so multi-rep habits (timesPerDay > 1) accept one tap PER REP.
  // Duplicate-titled rules resolve FIRST-match — exactly how logHabit picks
  // `matchingRule` (recurringRules.find) — so the drain never plans against a
  // different target than logHabit will enforce (a later duplicate with a
  // lower target would silently drop valid taps; Greptile P1 on #371).
  const requiredByKey = new Map<string, number>();
  const ruleRows = Array.isArray(rules) ? rules : [];
  for (const r of ruleRows) {
    if (r && typeof (r as any).title === 'string') {
      const k = normalize((r as any).title);
      if (!k || requiredByKey.has(k)) continue;
      const tpd = (r as any).timesPerDay;
      requiredByKey.set(k, typeof tpd === 'number' && tpd >= 1 ? Math.floor(tpd) : 1);
    }
  }

  const plan = planWidgetCompletions(queue, habitLog, requiredByKey, todayKey);
  // logHabit is today-only, so only today's completions can be applied.
  return plan.toApply.filter((c) => c.dayKey === todayKey).map((c) => c.habitTitle);
}

async function getSGP(): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = await import('react-native-shared-group-preferences');
    return (mod as any).default ?? mod;
  } catch {
    return null;
  }
}

/**
 * Read the pending queue, apply today's completions via the store, clear it.
 *
 * Fails silent and non-destructively at every step: if the App Group is
 * unavailable, or the stored value is unparseable, it applies nothing and does
 * not throw — this runs on every foreground and must never break app launch.
 * The queue is cleared whenever it was successfully read, so a single stale
 * action cannot replay forever (the reconciler already dropped invalid ones).
 *
 * @param getState  `useAppState.getState`
 * @param todayKey  local `YYYY-MM-DD`
 * @param opts.isHydrated  persist-hydration probe (e.g.
 *   `useAppState.persist.hasHydrated`). When given and false, the drain
 *   leaves the queue untouched — see the cold-start note below.
 * @returns titles applied, for a Law A confirmation, or null if nothing ran
 */
export async function drainWidgetCompletions(
  getState: () => StoreLike,
  todayKey: string,
  opts?: { isHydrated?: () => boolean },
): Promise<DrainResult | null> {
  const SGP = await getSGP();
  if (!SGP || typeof SGP.getItem !== 'function') return null;

  let raw: string | null = null;
  try {
    raw = await SGP.getItem(PENDING_KEY, APP_GROUP);
  } catch {
    return null;
  }
  if (!raw) return null;

  let queue: unknown;
  try {
    queue = JSON.parse(raw);
  } catch {
    // Unparseable: clear it so it cannot wedge every future foreground.
    try {
      await SGP.setItem(PENDING_KEY, '[]', APP_GROUP);
    } catch {
      /* best-effort */
    }
    return null;
  }

  // Cold-start race: persist rehydration from AsyncStorage is async, so an
  // early-foreground drain can run against an empty store. With no
  // recurringRules, the reconciler's deleted-habit guard would drop EVERY
  // queued tap — and clearing here would make that wrong verdict permanent
  // (user-reported: widget taps inconsistently lost on app open). So an
  // unhydrated store leaves the queue untouched for the next foreground.
  //
  // Guard on hydration ITSELF, not on an empty rule set: a hydrated user can
  // legitimately have zero habits (they deleted them all), and then queued
  // taps SHOULD drop+clear — otherwise a stale tap survives deletion and can
  // apply to a later same-titled habit recreated that day (Greptile P1).
  if (opts?.isHydrated && !opts.isHydrated()) return null;

  const state = getState();
  const titles = selectDrainCompletions(queue, state.habitLog, state.recurringRules, todayKey);

  // Clear FIRST-safe ordering: apply, then clear. If a crash lands between the
  // two, the actions replay next foreground and re-applying is a no-op (logHabit
  // self-caps, and the reconciler skips already-logged) — so favouring re-apply
  // over drop is safe here, unlike a paid side-effect.
  if (typeof state.logHabit === 'function') {
    for (const t of titles) state.logHabit(t);
  }
  try {
    await SGP.setItem(PENDING_KEY, '[]', APP_GROUP);
  } catch {
    /* best-effort; a re-drain is idempotent */
  }

  return titles.length > 0 ? { applied: titles } : null;
}
