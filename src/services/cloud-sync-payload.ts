// src/services/cloud-sync-payload.ts
// The outbound user_state.state_data allow-list — ONE source of truth.
// Consumers: the 5-min interval and the initial push in app/_layout.tsx, and
// the connector drain's post-apply push (src/services/connector-actions.ts),
// which must sync applied mutations before acknowledging them server-side.
// Never copy this list; extend it here.
export function buildCloudSyncPayload(state: any) {
  return {
    userProfile: state.userProfile,
    recurringRules: stripRuleDeviceLinks(state.recurringRules),
    recurringToDos: state.recurringToDos,
    pinnedHabits: state.pinnedHabits,
    habitLog: state.habitLog,
    habitStreaks: state.habitStreaks,
    habitStreakUpdatedDate: state.habitStreakUpdatedDate,
    milestonesShown: state.milestonesShown,
    dailyTasks: state.dailyTasks,
    pillars: state.pillars,
    horizonReviews: state.horizonReviews,
    lastReviewDates: state.lastReviewDates,
    inbox: state.inbox,
    goalHabitMap: state.goalHabitMap,
    morningIntention: state.morningIntention,
    morningIntentionDate: state.morningIntentionDate,
    weeklyWins: state.weeklyWins,
    weeklyWinsDate: state.weeklyWinsDate,
    isActivated: state.isActivated,
    notificationSettings: state.notificationSettings,
    softMode: state.softMode,
    breakdownGrain: state.breakdownGrain, // NEX-210: synced grain pref
    pauseMode: state.pauseMode, // NEX-207: synced intent (resumingFromPause is session-only, not synced)
    weeklyEmailEnabled: state.weeklyEmailEnabled,
    weeklyEmailConsent: state.weeklyEmailConsent,
    weeklyEmailConsentUpdatedAt: state.weeklyEmailConsentUpdatedAt,
    weeklyEmailDay: state.weeklyEmailDay,
    totalXP: state.totalXP,
    badges: state.badges,
    streakFreezes: state.streakFreezes,
    lastFreezeDate: state.lastFreezeDate,
    lastOpenDate: state.lastOpenDate,
    activatedDate: state.activatedDate,
    // activeChallenge / completedChallenges removed from outbound payload
    // 2026-04. mergeCloudState still accepts them inbound for back-compat.
    scoreHistory: state.scoreHistory,
    orbitDays: state.orbitDays,
    weeklyReflection: state.weeklyReflection,
    weeklyReflectionDate: state.weeklyReflectionDate,
    nightlyForward: state.nightlyForward,
    nightlyForwardDate: state.nightlyForwardDate,
    dailyScores: state.dailyScores,
    leadTimeActions: state.leadTimeActions, // NEX-162
    coachThread: stripCoachDevicePreference(state.coachThread), // conversation follows the account
    // Restored by mergeCloudState but never sent — so a reinstall silently
    // dropped all four (Today's-Focus picks, the Sunday-staged rule overrides,
    // the Monday pre-fill, and today's intention-completed flag). The restore
    // code existed and looked correct, which is why it went unnoticed.
    mandateFocus: state.mandateFocus,
    nextWeekRuleOverrides: state.nextWeekRuleOverrides,
    pendingMondayIntention: state.pendingMondayIntention,
    morningIntentionCompletedDate: state.morningIntentionCompletedDate,
    // NEX-323: timezone + wisdom cache, synced so the sms-daily-quotes
    // cron can send the SAME quote the push nudges led with, at the
    // user's local slot. Device remains the generator; cloud is a
    // read-only mirror for the server. recentWisdomHistory is already
    // accepted inbound by mergeCloudState — this closes the loop.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dailyWisdomQuotes: state.dailyWisdomQuotes,
    dailyWisdomDate: state.dailyWisdomDate,
    recentWisdomHistory: state.recentWisdomHistory,
  };
}

function stripRuleDeviceLinks(value: any): any {
  if (!Array.isArray(value)) return value;
  return value.map((rule) => {
    if (!rule || typeof rule !== 'object') return rule;
    const { appleEventId: _deviceLink, ...shared } = rule;
    return shared;
  });
}

function stripCoachDevicePreference(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { speakReplies: _devicePreference, ...shared } = value;
  return shared;
}

export type CloudSyncPayload = Record<string, any>;
export const CLOUD_SYNC_PAYLOAD_KEYS = Object.keys(buildCloudSyncPayload({}));
export const CLOUD_SYNC_MIRROR_FIELDS = ['timezone', 'dailyWisdomQuotes', 'dailyWisdomDate'] as const;

/** Canonicalize both legacy remote rows and local snapshots; never add today's
 * timezone or default fields to a remote baseline. JSON cloning also freezes
 * the value-in-time that an explicit connector request is acknowledging. */
export function normalizeCloudSyncPayload(value: any): CloudSyncPayload {
  const payload: CloudSyncPayload = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return payload;
  for (const key of CLOUD_SYNC_PAYLOAD_KEYS) {
    if (value[key] !== undefined) payload[key] = value[key];
  }
  if ('recurringRules' in payload) payload.recurringRules = stripRuleDeviceLinks(payload.recurringRules);
  if ('coachThread' in payload) payload.coachThread = stripCoachDevicePreference(payload.coachThread);
  return JSON.parse(JSON.stringify(payload));
}

/** Object key insertion order is not a data change. Array order still is. */
export function stableCloudValue(value: any): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(stableCloudValue).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + stableCloudValue(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function cloudPayloadsEqual(a: any, b: any, ignoreMirrors = false): boolean {
  const left = normalizeCloudSyncPayload(a);
  const right = normalizeCloudSyncPayload(b);
  if (ignoreMirrors) for (const key of CLOUD_SYNC_MIRROR_FIELDS) { delete left[key]; delete right[key]; }
  return stableCloudValue(left) === stableCloudValue(right);
}
