import { normalize } from './text';

export type HabitLinkRule = {
  title?: string | null;
};

export type GoalHabitMapLike = Record<string, string[]>;

export function countLinkedHabitsForPillar(
  pillarId: string | null | undefined,
  recurringRules: HabitLinkRule[] | null | undefined,
  goalHabitMap: GoalHabitMapLike | null | undefined,
): number {
  if (!pillarId || !Array.isArray(recurringRules) || !goalHabitMap) return 0;

  // Walk recurringRules, not goalHabitMap keys, so legacy orphan keys
  // from deleted/renamed habits cannot inflate the count.
  let count = 0;
  for (const rule of recurringRules) {
    const key = normalize(rule?.title);
    if (!key) continue;
    const ids = Array.isArray(goalHabitMap[key]) ? goalHabitMap[key] : [];
    if (ids.includes(pillarId)) count += 1;
  }
  return count;
}

export function pruneGoalHabitMapToRecurringRules(
  goalHabitMap: unknown,
  recurringRules: HabitLinkRule[] | null | undefined,
): GoalHabitMapLike {
  if (!goalHabitMap || typeof goalHabitMap !== 'object') return {};

  const validRuleKeys = new Set(
    (Array.isArray(recurringRules) ? recurringRules : [])
      .map((rule) => normalize(rule?.title))
      .filter(Boolean),
  );

  const next: GoalHabitMapLike = {};
  for (const [rawKey, rawIds] of Object.entries(goalHabitMap as Record<string, unknown>)) {
    const key = normalize(rawKey);
    if (!key || !validRuleKeys.has(key)) continue;

    const ids = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const existing = next[key] ?? [];
    for (const id of ids) {
      if (!existing.includes(id)) existing.push(id);
    }
    next[key] = existing;
  }
  return next;
}
