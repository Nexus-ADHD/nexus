/**
 * Pure edit logic for a single recurring habit rule (NEX-54).
 *
 * Extracted from app-state's `renameRecurringRule` so both rename and the
 * new `updateRecurringRule` apply a title change — and its load-bearing
 * habit-log / goalHabitMap / streak-map re-keying — in ONE functional update,
 * alongside daysOfWeek / timesPerDay field edits. Splitting a title change
 * (which re-keys logs by title) from raw field setState risks stale/partial
 * writes; this keeps it atomic.
 *
 * No RN imports — unit-testable in the pure-Node vitest suite.
 */
import { normalize } from '../utils/text';
import type { TimeBlock } from '../utils/recurrence';

export interface RuleEditPatch {
  title?: string;
  daysOfWeek?: number[];
  timesPerDay?: number;
  // NEX-206: a one-tap accepted wide time-of-day anchor. `null` clears it
  // (undo-timing). Set together with `appleEventId` so the rule never carries a
  // block without its backing Apple Calendar event (which Orbit would otherwise
  // render as a fabricated clock block — see the atomic-accept rationale).
  preferredTimeBlock?: TimeBlock | null;
  // NEX-206: the linked Apple Calendar event id. Set on accept, `null` on
  // undo-timing. This is the explicit unlink path the store otherwise lacked
  // (linkRecurringRuleToAppleEvent only ever sets a non-null id).
  appleEventId?: string | null;
  // NEX-202: the user-confirmed mandate (pillar id) echoed beneath this habit on
  // Home. `null` severs the echo. NOT sourced from the AI-tainted goalHabitMap —
  // only ever set by an explicit user tap in HabitEditView. Scalar, no re-key.
  mandateEchoPillarId?: string | null;
  // NEX-208: an optional pre-framed "ridiculously small" first step (the start
  // that lowers the initiation barrier). `null` clears it. Scalar, no re-key.
  firstStep?: string | null;
  // NEX-209: an optional if-then cue (implementation intention) from the cue
  // library, e.g. "After morning coffee". `null` clears it. Distinct from the
  // legacy `anchor` field (whose timing-drift leverage stays dormant). No re-key.
  cue?: string | null;
}

/** True if another rule (not `exceptId`) already uses this normalized title. */
export function isDuplicateHabitTitle(
  rules: Array<{ id: string; title: string }> | undefined,
  title: string,
  exceptId?: string,
): boolean {
  const key = normalize(title);
  return (Array.isArray(rules) ? rules : []).some(
    (r) => r.id !== exceptId && normalize(r.title) === key,
  );
}

/**
 * Returns the partial app-state slices to apply for an edit to one rule.
 * Mirrors `renameRecurringRule`'s re-key exactly (goalHabitMap, habitLog,
 * habitStreaks, habitStreakUpdatedDate, habitStrength), and additionally
 * applies daysOfWeek / timesPerDay. A no-op title (normalized unchanged)
 * skips the re-key and just writes the field edits.
 */
export function applyRuleEdit(
  s: any,
  ruleId: string,
  patch: RuleEditPatch,
): Record<string, any> {
  const rule = (s.recurringRules ?? []).find((r: any) => r.id === ruleId);
  const trimmedTitle = patch.title !== undefined ? patch.title.trim() : undefined;
  const nextDays =
    patch.daysOfWeek !== undefined
      ? Array.from(new Set(patch.daysOfWeek)).sort((a, b) => a - b)
      : undefined;

  const nextRules = (s.recurringRules ?? []).map((r: any) => {
    if (r.id !== ruleId) return r;
    const next = { ...r };
    if (trimmedTitle !== undefined) next.title = trimmedTitle;
    if (nextDays !== undefined) next.daysOfWeek = nextDays;
    if (patch.timesPerDay !== undefined) next.timesPerDay = patch.timesPerDay;
    if (patch.preferredTimeBlock !== undefined) next.preferredTimeBlock = patch.preferredTimeBlock;
    if (patch.appleEventId !== undefined) next.appleEventId = patch.appleEventId;
    if (patch.mandateEchoPillarId !== undefined) next.mandateEchoPillarId = patch.mandateEchoPillarId;
    if (patch.firstStep !== undefined) next.firstStep = patch.firstStep;
    if (patch.cue !== undefined) next.cue = patch.cue;
    return next;
  });

  // Only re-key when the title actually changed (normalized).
  if (!rule?.title || trimmedTitle === undefined) {
    return { recurringRules: nextRules };
  }
  const oldKey = normalize(rule.title);
  const newKey = normalize(trimmedTitle);
  if (oldKey === newKey) {
    return { recurringRules: nextRules };
  }

  // goalHabitMap migration (NEX-76): carry pillar links to the new key,
  // merging + deduping in case the new key already held entries.
  const map = s.goalHabitMap ?? {};
  let nextMap = map;
  const oldList = map[oldKey];
  if (oldList) {
    nextMap = { ...map };
    const merged = Array.from(new Set([...(map[newKey] ?? []), ...oldList]));
    nextMap[newKey] = merged;
    delete nextMap[oldKey];
  }

  // Relabel completion history to the new key (else a rename orphans every
  // prior completion from its rule — see habit-log-reconcile.ts / v25).
  let nextHabitLog = s.habitLog;
  if (Array.isArray(s.habitLog)) {
    let logMutated = false;
    const relabeled = s.habitLog.map((e: any) => {
      if (normalize(e?.habitTitle) === oldKey) {
        logMutated = true;
        return { ...e, habitTitle: newKey };
      }
      return e;
    });
    if (logMutated) nextHabitLog = relabeled;
  }

  // Carry the title-keyed scalar maps — only when the new key is empty, so
  // renaming into an existing habit's key never clobbers its live value.
  const moveScalarKey = <V,>(
    obj: Record<string, V> | undefined,
  ): Record<string, V> | undefined => {
    if (!obj || typeof obj !== 'object' || !(oldKey in obj)) return obj;
    const next = { ...obj };
    if (!(newKey in next)) next[newKey] = next[oldKey];
    delete next[oldKey];
    return next;
  };
  const nextStreaks = moveScalarKey(s.habitStreaks);
  const nextStreakUpdated = moveScalarKey(s.habitStreakUpdatedDate);
  const nextStrength = moveScalarKey(s.habitStrength);
  // NEX-190: carry the celebrated rep-milestones to the new key so a rename
  // doesn't orphan the record (which would let a past milestone re-fire). Unlike
  // the scalar maps, this is a SET — on a key collision (renaming onto a title
  // that already has milestones) we UNION the two lists so neither side re-fires.
  const moveMilestones = (
    obj: Record<string, number[]> | undefined,
  ): Record<string, number[]> | undefined => {
    if (!obj || typeof obj !== 'object' || !(oldKey in obj)) return obj;
    const next = { ...obj };
    next[newKey] = Array.from(new Set([...(next[newKey] ?? []), ...(next[oldKey] ?? [])]));
    delete next[oldKey];
    return next;
  };
  const nextMilestones = moveMilestones(s.milestonesShown);

  return {
    recurringRules: nextRules,
    goalHabitMap: nextMap,
    habitLog: nextHabitLog,
    ...(nextStreaks !== s.habitStreaks ? { habitStreaks: nextStreaks } : {}),
    ...(nextStreakUpdated !== s.habitStreakUpdatedDate
      ? { habitStreakUpdatedDate: nextStreakUpdated }
      : {}),
    ...(nextStrength !== s.habitStrength ? { habitStrength: nextStrength } : {}),
    ...(nextMilestones !== s.milestonesShown ? { milestonesShown: nextMilestones } : {}),
  };
}
