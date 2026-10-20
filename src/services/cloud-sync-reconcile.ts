import {
  CLOUD_SYNC_MIRROR_FIELDS,
  type CloudSyncPayload,
  normalizeCloudSyncPayload,
  stableCloudValue,
} from './cloud-sync-payload';

type Policy = 'entities' | 'map' | 'set-map' | 'entity-map' | 'override-map' | 'history' |
  'atomic' | 'paired' | 'specialized' | 'habit-log' | 'derived' | 'mirror';

/** Explicit inventory. The parity test fails when a new wire field has no
 * policy. Conflicting atomic values use canonical lexical maximum, a stable
 * tie-break rather than an invented modification time. Both values are saved
 * in a user-scoped recovery record before the coordinator applies the result. */
export const CLOUD_SYNC_FIELD_POLICIES: Record<string, Policy> = {
  userProfile: 'map', recurringRules: 'entities', recurringToDos: 'entities',
  pinnedHabits: 'derived', habitLog: 'habit-log', habitStreaks: 'paired',
  habitStreakUpdatedDate: 'paired', milestonesShown: 'set-map', dailyTasks: 'entity-map',
  pillars: 'entities', horizonReviews: 'entities', lastReviewDates: 'map',
  inbox: 'entities', goalHabitMap: 'set-map', morningIntention: 'paired',
  morningIntentionDate: 'paired', morningIntentionCompletedDate: 'paired',
  weeklyWins: 'paired', weeklyWinsDate: 'paired', isActivated: 'atomic',
  notificationSettings: 'map', softMode: 'atomic', breakdownGrain: 'atomic',
  pauseMode: 'atomic', weeklyEmailEnabled: 'specialized', weeklyEmailConsent: 'specialized',
  weeklyEmailConsentUpdatedAt: 'specialized', weeklyEmailDay: 'atomic', totalXP: 'atomic',
  badges: 'entities', streakFreezes: 'atomic', lastFreezeDate: 'atomic',
  lastOpenDate: 'atomic', activatedDate: 'specialized', scoreHistory: 'map',
  orbitDays: 'entity-map', weeklyReflection: 'paired', weeklyReflectionDate: 'paired',
  nightlyForward: 'paired', nightlyForwardDate: 'paired', dailyScores: 'map',
  leadTimeActions: 'entities', coachThread: 'specialized', mandateFocus: 'map',
  nextWeekRuleOverrides: 'override-map', pendingMondayIntention: 'atomic',
  timezone: 'mirror', dailyWisdomQuotes: 'mirror', dailyWisdomDate: 'mirror',
  recentWisdomHistory: 'history',
};

const PAIRS = [
  ['morningIntention', 'morningIntentionDate', 'morningIntentionCompletedDate'],
  ['weeklyWins', 'weeklyWinsDate'], ['weeklyReflection', 'weeklyReflectionDate'],
  ['nightlyForward', 'nightlyForwardDate'],
] as const;
const equal = (a: any, b: any) => stableCloudValue(a) === stableCloudValue(b);
const record = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (v: any) => v == null || v === '' || (Array.isArray(v) ? v.length === 0 : record(v) && Object.keys(v).length === 0);
const validEntities = (v: any, key = 'id'): boolean => Array.isArray(v) && v.every((e) => record(e) && typeof e[key] === 'string');

export interface ReconciledCloudState {
  payload: CloudSyncPayload;
  conflicts: string[];
  unknownHistory: boolean;
  allowEmptyFields: string[];
  reconciledHabitLog: boolean;
}

export function reconcileCloudState(
  rawBase: CloudSyncPayload | null,
  rawLocal: CloudSyncPayload,
  rawRemote: CloudSyncPayload,
  localIsEmpty = false,
  habitCompletionXP?: number,
): ReconciledCloudState {
  const base = rawBase === null ? null : normalizeCloudSyncPayload(rawBase);
  const local = normalizeCloudSyncPayload(rawLocal);
  const remote = normalizeCloudSyncPayload(rawRemote);
  const conflicts: string[] = [];

  function atomic(b: any, l: any, r: any, known: boolean, path: string): any {
    if (equal(l, r)) return l;
    if (known && equal(l, b)) return r;
    if (known && equal(r, b)) return l;
    if (l === undefined) return r;
    if (r === undefined) return l;
    // An empty defaults-only install is never evidence of a remote clear.
    if (!known && empty(r) && !empty(l)) return l;
    if (!known && empty(l) && !empty(r)) return r;
    conflicts.push(path);
    return stableCloudValue(l) > stableCloudValue(r) ? l : r;
  }

  function entities(b: any, l: any, r: any, known: boolean, path: string, key = 'id'): any {
    if (!validEntities(l, key) || !validEntities(r, key)) return atomic(b, l, r, known, path);
    const bm = new Map<string, any>((Array.isArray(b) ? b : []).map((e) => [e[key], e]));
    const lm = new Map<string, any>(l.map((e: any) => [e[key], e]));
    const rm = new Map<string, any>(r.map((e: any) => [e[key], e]));
    if (equal(l, r)) return l;
    if (known && equal(l, b)) return r;
    if (known && equal(r, b)) return l;
    const ids = [...new Set([...lm.keys(), ...rm.keys(), ...bm.keys()])].sort();
    const result: any[] = [];
    for (const id of ids) {
      const bv = bm.get(id), lv = lm.get(id), rv = rm.get(id);
      // With history, a missing unchanged entity means an intentional
      // deletion. Delete-versus-edit keeps the edited value and saves both.
      if (known && bv !== undefined && (lv === undefined || rv === undefined)) {
        const survivor = lv ?? rv;
        if (survivor === undefined || equal(survivor, bv)) continue;
        conflicts.push(path + '.' + id);
        result.push(survivor);
        continue;
      }
      const merged = object(bv, lv, rv, known && bv !== undefined, path + '.' + id);
      if (merged !== undefined) result.push(merged);
    }
    return result;
  }

  function primitiveSet(b: any, l: any, r: any, known: boolean, path: string): any {
    if (!Array.isArray(l) || !Array.isArray(r) || [...l, ...r].some((v) => typeof v === 'object')) {
      return atomic(b, l, r, known, path);
    }
    const bm = new Set(Array.isArray(b) ? b.map(stableCloudValue) : []);
    const lm = new Map(l.map((v) => [stableCloudValue(v), v]));
    const rm = new Map(r.map((v) => [stableCloudValue(v), v]));
    return [...new Set([...lm.keys(), ...rm.keys()])].sort()
      .filter((id) => !known || !bm.has(id) || (lm.has(id) && rm.has(id)))
      .map((id) => lm.get(id) ?? rm.get(id));
  }

  function object(b: any, l: any, r: any, known: boolean, path: string, childPolicy?: Policy): any {
    if (!record(l) || !record(r)) return atomic(b, l, r, known, path);
    if (equal(l, r)) return l;
    if (known && equal(l, b)) return r;
    if (known && equal(r, b)) return l;
    const result: Record<string, any> = Object.create(null);
    for (const key of [...new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b ?? {})])].sort()) {
      const bv = b?.[key], lv = l[key], rv = r[key];
      const fieldKnown = known && record(b) && Object.prototype.hasOwnProperty.call(b, key);
      let merged: any;
      if (fieldKnown && (lv === undefined || rv === undefined)) {
        const survivor = lv ?? rv;
        if (survivor === undefined || equal(survivor, bv)) continue;
        conflicts.push(path + '.' + key);
        merged = survivor;
      } else if (childPolicy === 'entity-map' || childPolicy === 'override-map') {
        merged = entities(bv, lv, rv, fieldKnown, path + '.' + key, childPolicy === 'override-map' ? 'ruleId' : 'id');
      } else if (childPolicy === 'set-map' || (Array.isArray(lv) && Array.isArray(rv) &&
                 [...lv, ...rv].every((v) => typeof v === 'string' || typeof v === 'number'))) {
        merged = primitiveSet(bv, lv, rv, fieldKnown, path + '.' + key);
      } else {
        merged = object(bv, lv, rv, fieldKnown, path + '.' + key);
      }
      if (merged !== undefined) result[key] = merged;
    }
    return result;
  }

  const payload: CloudSyncPayload = {};
  let reconciledHabitLog = false;
  for (const [key, policy] of Object.entries(CLOUD_SYNC_FIELD_POLICIES)) {
    if (policy === 'paired') continue;
    const b = base?.[key], l = local[key], r = remote[key];
    const known = base !== null && Object.prototype.hasOwnProperty.call(base, key);
    let merged: any;
    if (policy === 'mirror') merged = l;
    else if (r === undefined) merged = l; // an older wire schema omits fields; omission is not a top-level clear
    else if (policy === 'specialized') merged = r;
    else if (localIsEmpty) merged = r;
    else if (policy === 'habit-log') {
      reconciledHabitLog = known && validEntities(b) && validEntities(l) && validEntities(r);
      merged = reconciledHabitLog ? entities(b, l, r, true, key) : r;
    } else if (policy === 'entities') merged = entities(b, l, r, known, key);
    else if (policy === 'history') {
      const identify = (values: any) => Array.isArray(values) ? values.map((entry: any) => ({
        ...entry, __syncId: stableCloudValue([entry?.dateKey, entry?.quote, entry?.author]),
      })) : values;
      const entries = entities(identify(b), identify(l), identify(r), known, key, '__syncId');
      merged = Array.isArray(entries) ? entries.map(({ __syncId: _id, ...entry }) => entry) : entries;
    } else if (policy === 'derived') merged = primitiveSet(b, l, r, known, key);
    else if (policy === 'map' || policy.endsWith('-map')) merged = object(b, l, r, known, key, policy);
    else if (key === 'isActivated' && (l === true || r === true)) merged = true;
    else merged = atomic(b, l, r, known, key);
    if (merged !== undefined) payload[key] = merged;
  }

  for (const keys of PAIRS) {
    const group = (source: CloudSyncPayload | null) => Object.fromEntries(keys
      .filter((key) => source?.[key] !== undefined).map((key) => [key, source![key]]));
    const b = group(base), l = group(local), r = group(remote);
    const known = base !== null && keys.some((key) => Object.prototype.hasOwnProperty.call(base, key));
    // Missing members in a legacy payload inherit that side's accepted
    // baseline so dates and text are always chosen as one coherent value.
    const remoteGroup = { ...b, ...r };
    // Wins within one week are a set of independent contributions. A prior
    // week's list cannot prove a removal from this week. Different weeks
    // still use the paired policy so a list never acquires another date.
    if (keys[0] === 'weeklyWins' && !localIsEmpty &&
        typeof l.weeklyWinsDate === 'string' && l.weeklyWinsDate.length > 0 &&
        l.weeklyWinsDate === remoteGroup.weeklyWinsDate &&
        Array.isArray(l.weeklyWins) && Array.isArray(remoteGroup.weeklyWins) &&
        [...l.weeklyWins, ...remoteGroup.weeklyWins].every((win) => typeof win === 'string')) {
      payload.weeklyWinsDate = l.weeklyWinsDate;
      payload.weeklyWins = primitiveSet(b.weeklyWins, l.weeklyWins, remoteGroup.weeklyWins,
        known && b.weeklyWinsDate === l.weeklyWinsDate && Array.isArray(b.weeklyWins), 'weeklyWins');
      continue;
    }
    const groupEmpty = (value: Record<string, any>) => Object.values(value).every(empty);
    const selected = Object.keys(r).length === 0 ? l : localIsEmpty ? remoteGroup :
      !known && groupEmpty(remoteGroup) && !groupEmpty(l) ? l :
      !known && groupEmpty(l) && !groupEmpty(remoteGroup) ? remoteGroup :
      atomic(b, l, remoteGroup, known, keys[0]);
    Object.assign(payload, selected);
  }

  // A streak's count and date form one per-habit record. Merging their maps
  // independently can stamp yesterday's count with a newer reset date.
  const streaks: Record<string, any> = {}, streakDates: Record<string, any> = {};
  const streakKeys = new Set([
    ...Object.keys(base?.habitStreaks ?? {}), ...Object.keys(local.habitStreaks ?? {}),
    ...Object.keys(remote.habitStreaks ?? {}), ...Object.keys(local.habitStreakUpdatedDate ?? {}),
    ...Object.keys(remote.habitStreakUpdatedDate ?? {}),
  ]);
  for (const key of streakKeys) {
    const group = (source: CloudSyncPayload | null) => ({
      count: source?.habitStreaks?.[key], date: source?.habitStreakUpdatedDate?.[key],
    });
    const b = group(base), l = group(local), r = group(remote);
    const known = base !== null && (b.count !== undefined || b.date !== undefined);
    const localAbsent = l.count === undefined && l.date === undefined;
    const remoteAbsent = r.count === undefined && r.date === undefined;
    const remoteMapsPresent = remote.habitStreaks !== undefined && remote.habitStreakUpdatedDate !== undefined;
    let chosen;
    if (known && (localAbsent || (remoteAbsent && remoteMapsPresent))) {
      const survivor = localAbsent ? r : l;
      if ((localAbsent && remoteAbsent) || equal(survivor, b)) continue;
      conflicts.push('habitStreaks.' + key);
      chosen = survivor;
    } else {
      chosen = remoteAbsent ? l : localAbsent || localIsEmpty ? r : atomic(b, l, r, known, 'habitStreaks.' + key);
    }
    if (chosen.count !== undefined) streaks[key] = chosen.count;
    if (chosen.date !== undefined) streakDates[key] = chosen.date;
  }
  if (local.habitStreaks !== undefined || remote.habitStreaks !== undefined) payload.habitStreaks = streaks;
  if (local.habitStreakUpdatedDate !== undefined || remote.habitStreakUpdatedDate !== undefined) payload.habitStreakUpdatedDate = streakDates;

  // Only event-explained XP is additive. Arbitrary awardXP and legacy
  // challenge rewards have no operation IDs, so summing their deltas could
  // double-award the same event. Those retain the atomic/recovery policy.
  if (base && reconciledHabitLog && typeof habitCompletionXP === 'number' && habitCompletionXP > 0 &&
      [base.totalXP, local.totalXP, remote.totalXP].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    const uniqueCount = (entries: any[]) => new Set(entries.map((entry) => entry.id)).size;
    const baseCount = uniqueCount(base.habitLog);
    const expectedLocal = base.totalXP + (uniqueCount(local.habitLog) - baseCount) * habitCompletionXP;
    const expectedRemote = base.totalXP + (uniqueCount(remote.habitLog) - baseCount) * habitCompletionXP;
    const mergedXP = base.totalXP + (uniqueCount(payload.habitLog) - baseCount) * habitCompletionXP;
    if (local.totalXP === expectedLocal && remote.totalXP === expectedRemote && mergedXP >= 0) {
      payload.totalXP = mergedXP;
      const conflictIndex = conflicts.indexOf('totalXP');
      if (conflictIndex !== -1) conflicts.splice(conflictIndex, 1);
    } else if (local.totalXP !== base.totalXP && remote.totalXP !== base.totalXP && !equal(local.habitLog, remote.habitLog)) {
      conflicts.push('totalXP');
    }
  }

  const allowEmptyFields = base ? Object.keys(payload).filter((key) =>
    !['specialized', 'mirror', 'habit-log', 'derived'].includes(CLOUD_SYNC_FIELD_POLICIES[key]) &&
    Object.prototype.hasOwnProperty.call(base, key) && !empty(base[key]) && empty(payload[key])) : [];
  for (const key of CLOUD_SYNC_MIRROR_FIELDS) if (local[key] !== undefined) payload[key] = local[key];
  return {
    payload, conflicts: [...new Set(conflicts)], unknownHistory: base === null && !localIsEmpty,
    allowEmptyFields, reconciledHabitLog,
  };
}
