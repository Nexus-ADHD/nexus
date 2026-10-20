import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PERSIST_STORAGE_KEY, PERSIST_VERSION } from './persistence-keys';
import { durableAppStateStorage } from './persistence';
import { normalize } from '../utils/text';
import { applyRuleEdit, type RuleEditPatch } from './rule-edit';
import { migratePinsToExcluded, deriveActiveHabitIds } from './score-inclusion';
import { type QuotePool, emptyPool, removeQuote, evictForMandateChange, markShown, addCandidates, sanitizeQuotePool } from '../ai/notification-quote-pool';
import {
  type SuggestionFeedbackEntry,
  recordSuggestionOutcomes,
} from '../ai/suggestion-feedback';
import { planMoveOccurrence, planUndoMoveOccurrence, type MoveRefusal } from './move-recurring-occurrence';
import { NOTIFICATION_PROMPTS } from '../ai/notification-quote-compose';
import { isScheduledOn, dowFromDateKey, selectTodayTaskRollup } from './selectors/today-rollup';
import { reconcileInboxAgainstExternal } from './reconcile-external-state';
import { upsertRemindersIntoInbox } from './upsert-reminders';
import { applyToggleInbox } from './toggle-inbox-task';
import { prependInboxTaskIdempotently } from './prepend-inbox-task';
import { type BreakdownGrain, DEFAULT_GRAIN, normalizeGrain } from '../features/command/breakdown';
import { type LeadTimeAction, backfillLeadTimeActions, computeActByDate } from './lead-time-types';
import type { JustCaptured } from '../features/command/capture-echo';
import {
  emptyCoachThread,
  mergeCoachThreads,
  sanitizeCoachThread,
  type CoachThread,
} from '../features/coach/coach-thread';
import { clearAiSessionCache } from '../utils/ai-session-cache';
import { stopSyncSession } from '../services/sync-session';
import { getLocalDateKey as projectEventKey } from '../utils/recurrence';
import { LAPSE_THRESHOLD_DAYS } from '../features/home/return-lapse';
import { pruneGoalHabitMapToRecurringRules } from '../utils/mandate-habit-links';
import { reconcileHabitLogToRules, reconcileTitleKeyedMap } from '../utils/habit-log-reconcile';
import {
  applyMandateTitle,
  applyMandateRefresh,
  applyHabitRefresh,
  applyRecurringTodoRefresh,
  applyTodoRefresh,
  applyMandateDownstream,
  applyToggleAddedHabit,
  applyToggleAddedRecurringTodo,
  applyToggleAddedTodo,
} from './onboarding-recommendations-reducers';
import { emitHabitLogged, emitTodoCleared, trackEvent } from '../services/analytics';
import { recordOpenHour } from '../services/receptivity';
import { DEFAULT_STREAK_GRACE_MISSES, getStreakGraceStatus, previousScheduledDateKey } from '../utils/streak-grace';
// NEX-207 Pause Mode (B1): interval-history state + repair-on-return live in the
// pure helper module so the date math is vitest-covered; the store just feeds it.
import {
  EMPTY_PAUSE_MODE,
  activeGapDays,
  normalizePauseMode,
  prunePauseHistory,
  closePauseInterval,
  repairStreakAnchors,
  type PauseModeState,
  type RepairHabitInput,
} from './pause-mode';
import { repBadgeUnlocks, isComebackReturn, tripleThreatCount, foldPendingBadges } from './badges';
// Pure helper, no RN — the challenge's 30-day scoring window, made explicit now
// that scoreHistory is unbounded (see recordDailyScore).
import { scoreTargetDaysAbove } from '../components/ui/score-trend-chart-helpers';
import {
  mergeWeeklyEmailConsent,
  normalizeWeeklyEmailConsent,
  type WeeklyEmailConsent,
} from './weekly-email-consent';

export type { WeeklyEmailConsent } from './weekly-email-consent';


export const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
export const TIME_BLOCKS = ['morning', 'afternoon', 'evening', 'night'] as const;

export type TimeBlock = (typeof TIME_BLOCKS)[number];
export type Capacity = 'PEAK' | 'RECOVERY';
export type CurrentMode = 'ALL' | 'SALES' | 'VISION' | 'FAMILY';

export interface UserProfile {
  name: string;
  anchor: string;
  engine: string;
  vision: string;
  phoneNumber?: string;
  // NEX-17 quick-win: user-chosen accent tint applied to the alignment
  // ring and major Home accents. Defaults to 'gold' when unset.
  ringTint?: 'gold' | 'teal' | 'amber';
}

export interface Badge {
  id: string;
  title: string;
  description: string;
  icon: string;
  unlockedAt: number | null;
}

export const BADGE_DEFINITIONS: Omit<Badge, 'unlockedAt'>[] = [
  { id: 'first_step', title: 'First Step', description: 'Complete your first habit', icon: '👣' },
  // NEX-220: cumulative, non-resetting milestones (a miss takes none away) —
  // replaces the breakable-streak framing (Law B). first_week's 🔥 retired.
  { id: 'first_week', title: 'First Seven', description: 'Seven completions of a habit', icon: '🌱' },
  { id: 'iron_will', title: 'Iron Will', description: 'Thirty completions of a habit', icon: '⚔️' },
  { id: 'centurion', title: 'Centurion', description: 'One hundred completions of a habit', icon: '👑' },
  { id: 'all_in', title: 'All In', description: 'Complete every habit in a single day', icon: '💎' },
  { id: 'early_bird', title: 'Early Bird', description: 'Log a habit before 7am', icon: '🌅' },
  { id: 'comeback_kid', title: 'Back After A Pause', description: 'Return to a habit after a pause', icon: '🦅' },
  { id: 'triple_threat', title: 'Three On The Go', description: 'Three habits with progress in one week', icon: '⚡' },
  { id: 'level_5', title: 'Rising Star', description: 'Reach Level 5', icon: '⭐' },
  { id: 'level_10', title: 'Disciplined', description: 'Reach Level 10', icon: '🏆' },
];

/** @deprecated Removed from UI in 2026-04. Type retained for backward compatibility with cloud payloads from older app versions. Do not reference in new code. */
export interface Challenge {
  id: string;
  title: string;
  description: string;
  icon: string;
  type: 'streak_days' | 'early_log' | 'all_habits' | 'score_target' | 'intention_streak';
  target: number;
  progress: number;
  xpReward: number;
  startDate: string;
  completed: boolean;
}

/** @deprecated Removed from UI in 2026-04. Pool retained so the assignChallenge reducer keeps compiling for old persisted state. Do not reference in new code. */
export const CHALLENGE_POOL: Omit<Challenge, 'progress' | 'startDate' | 'completed'>[] = [
  { id: 'early_5', title: 'Dawn Warrior', description: 'Log a habit before 9am for 5 days', icon: '🌅', type: 'early_log', target: 5, xpReward: 100 },
  { id: 'perfect_3', title: 'Perfect Days', description: 'Complete all habits 3 days in a row', icon: '💯', type: 'all_habits', target: 3, xpReward: 150 },
  { id: 'score_80', title: 'High Performer', description: 'Score 80+ for 5 days this week', icon: '📈', type: 'score_target', target: 5, xpReward: 120 },
  { id: 'intention_7', title: 'Intentional Week', description: 'Set your morning intention every day', icon: '🎯', type: 'intention_streak', target: 7, xpReward: 100 },
  { id: 'streak_14', title: 'Two-Week Titan', description: 'Maintain any habit for 14 days straight', icon: '🔥', type: 'streak_days', target: 14, xpReward: 150 },
  { id: 'early_7', title: 'Morning Master', description: 'Log a habit before 9am for 7 days', icon: '☀️', type: 'early_log', target: 7, xpReward: 175 },
  { id: 'perfect_5', title: 'Five-Star Week', description: 'Complete all habits 5 days in a row', icon: '⭐', type: 'all_habits', target: 5, xpReward: 200 },
  { id: 'score_90', title: 'Elite Execution', description: 'Score 90+ for 3 days this week', icon: '🏆', type: 'score_target', target: 3, xpReward: 150 },
];

export const XP_HABIT_COMPLETE = 10;
// NEX-190: the consecutive-streak XP bonuses (XP_STREAK_7..365) were removed — they
// were a punishing-streak mechanic (a miss forfeited the future bonus, Law E). XP is
// now flat per completion; the 7/30/66/365 milestone ceremony carries the celebration.

export function getLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

export function getXPForLevel(level: number): number {
  return (level - 1) * (level - 1) * 50;
}

export function getXPProgress(xp: number): { level: number; current: number; needed: number; percent: number } {
  const level = getLevel(xp);
  const currentLevelXP = getXPForLevel(level);
  const nextLevelXP = getXPForLevel(level + 1);
  const current = xp - currentLevelXP;
  const needed = nextLevelXP - currentLevelXP;
  return { level, current, needed, percent: Math.min(100, Math.round((current / needed) * 100)) };
}

export interface InboxTask {
  id: string;
  title: string;
  completed: boolean;
  status?: string;
  createdAt?: number; // Unix ms timestamp
  // NEX-26 phase F.5: stamped on the false→true transition of
  // `completed` and never overwritten afterward (so re-toggling does
  // not move the timestamp). The activation tracker reads THIS, not
  // createdAt, so a clear on day N credits day N rather than the day
  // the task was added. Optional for back-compat with legacy items;
  // the tracker SKIPS items that have completed=true but no
  // completedAt rather than guess.
  completedAt?: number;
  // v17: tracks where the task originated. 'manual' is the default for
  // user-entered items. 'apple_reminders' is reserved for Phase 2's
  // read path; setting it doesn't yet trigger sync.
  source?: 'manual' | 'apple_reminders';
  // External system identifier — Apple Reminder id when source === 'apple_reminders'.
  externalId?: string;
  // Optional due date in ISO 8601 format. Apple Reminders provides this
  // when the user sets one; manual items leave it undefined.
  dueDate?: string;
  // v18: true when the externalId no longer appears in any selected
  // reminder list (deleted/moved-out). Item is auto-archived; the UI
  // shows a "removed externally" badge so the user knows why it
  // disappeared.
  orphaned?: boolean;
  // v19: true when the user said "Skip" during the first-connect
  // triage flow. The ACTIVE inbox filter excludes these so the
  // welcome ritual results in a deliberately-shaped inbox. Apple
  // Reminders is left untouched; a future "show triaged-skipped"
  // affordance could resurface them.
  triagedSkip?: boolean;
  // NEX-259 (N-2): opt-in "keep nudging" — when true, a timed reminder re-nudges
  // (every 2h, max 3/day) until resolved instead of one alert. Default off.
  keepNudging?: boolean;
  // NEX-285: breakdown-stack grouping. When the Eye breaks a capture into steps,
  // every resulting step shares one `breakdownGroupId` and carries the original
  // `goalTitle` (header label only, never a separate to-do) plus its 0-based
  // `stepIndex` (stable within-group order, since a batch shares one createdAt ms
  // and cloud state is accepted as-is). The Inbox NEW tab renders such a group as
  // a single stacked card. All three are optional so pre-feature items and every
  // non-breakdown one-off (manual, apple_reminders) render as plain rows. These
  // are item-level fields — they ride through every sync/persist path unchanged
  // (no whitelist), so no mergeCloudState/partialize/migrate wiring is needed.
  breakdownGroupId?: string;
  goalTitle?: string;
  stepIndex?: number;
  // Stable receipt for explicit approval flows. Item-level fields ride through
  // persist, cloud sync, and migration via the existing InboxTask object spread.
  proposalKey?: string;
}

export interface Pillar {
  id: string;
  title: string;
  type?: string;
  context?: string;
  identity?: string;
  completed?: boolean;
  // v21: free-form notes the user attaches on the mandate detail
  // screen ("why this matters / what success looks like"). Optional;
  // existing pillars come back undefined from older persisted state.
  // The detail-screen UI treats undefined as "" for the TextInput.
  notes?: string;
  // NEX-26: close the typing gap. Every consumer (align.tsx, ai-context.ts,
  // home-screen.tsx, mandate-catchup-banner.tsx, _layout.tsx) already
  // reads `category` off pillars and `addPillarManual` writes it; the
  // type just never declared it. Values are conventionally
  // 'BUSINESS' | 'PERSONAL' | 'VISION', but cloud-synced and legacy
  // pillars can carry other strings — kept as `string` so phases 3–6
  // can read it reliably without forcing a runtime narrowing pass.
  category?: string;
  // Legacy mirror of `category`. Pre-NEX-26 onboarding wrote
  // { subtext: category } on each preset; align.tsx still falls back
  // to `subtext` when `category` is absent. Declaring it here keeps
  // that read site honest. NEX-30 tracks the migration to drop it.
  subtext?: string;
}

// NEX-205 (Or-2): per-block energy tag. Lets a native time-block be shaped
// by energy ("deep" focus / "light" admin / "recharge") rather than clock
// precision. Nexus-side metadata only — never pushed to Apple/EventKit, and
// only meaningful on source:'manual' eventType:'time_block' blocks.
export type OrbitEnergy = 'deep' | 'light' | 'recharge';

export interface OrbitEvent {
  id: string;
  title: string;
  startISO: string;
  endISO: string;
  timeLabel: string;
  source: 'manual' | 'calendar';
  eventType: 'appointment' | 'time_block';
  notes?: string;
  cal?: string;
  // NEX-205: optional energy tag for time-blocks (undefined = untagged).
  energy?: OrbitEnergy;
}

export interface RecurringRule {
  id: string;
  title: string;
  daysOfWeek: number[];
  time: string | null;
  preferredTimeBlock: TimeBlock | null;
  cal: string;
  appleEventId?: string | null;
  // NOTE: `appleEventId` is a DEVICE-LOCAL EventKit identifier living in a
  // SYNCED object. It is kept only as a compatibility mirror for rendering and
  // for adoption on the device that can actually resolve it. Reconciliation
  // must never treat it as authoritative — the authoritative per-device link
  // lives outside the payload, in src/state/apple-link-store.ts. Reading this
  // field as "the event that backs this rule" is the bug that deleted routines
  // across devices; see src/features/orbit/recurring-reconcile.ts.
  timesPerDay?: number; // default 1; set to 2+ for twice-daily etc
  // Unix ms when the rule was first created. Used by computeHabitProgress
  // to clamp the period start so a brand-new habit doesn't show as missed
  // for days before it existed. Optional + 0-sentinel for back-compat:
  // pre-v14 rules were migrated to 0, which the selector treats as
  // "before the dawn of time" (no clamping, full retroactive credit).
  createdAt?: number;
  // Optional behavioral anchor — the cue that should trigger this habit.
  // Examples: "After morning coffee", "When kids leave for school". Used
  // by computeAnchorAdherence to detect timing drift; null means no
  // anchor declared. Added in PERSIST_VERSION 15; existing rules
  // backfilled to null in the migrate block.
  anchor?: string | null;
  // Forward-compat soft-archive flag. Read defensively across the app
  // (home-screen habit filters, widget-bridge, alignment scoring) to exclude
  // archived habits; nothing sets it true yet (no archive UI). Always falsy
  // today. Declared so typed RecurringRule consumers don't need `(r: any)`.
  archived?: boolean;
  // NEX-171: when true, this habit does NOT count toward the daily score
  // (still visible + loggable). Replaces the confusing pinnedHabits filter.
  // Falsy = counts. Migrated from pinnedHabits in PERSIST_VERSION 27.
  excludedFromScore?: boolean;
  // NEX-202: the user-confirmed mandate (pillar id) echoed beneath this habit on
  // Home ("You said this matters: '<mandate>'."). Set ONLY by an explicit user
  // tap in HabitEditView — never auto-sourced from the AI-tainted goalHabitMap.
  // null/undefined = no echo. Rides along with recurringRules persistence/sync;
  // cleared in deletePillar when its mandate is removed (render also stale-guards).
  mandateEchoPillarId?: string | null;
  // NEX-208: an optional pre-framed "ridiculously small" first step — the start
  // that lowers the initiation barrier. Surfaced on Home as a tappable line that
  // gives an ephemeral "started" acknowledgment. null/undefined = none. Rides
  // recurringRules persistence/sync; dies with the habit; survives rename.
  firstStep?: string | null;
  // NEX-209: an optional if-then cue (implementation intention) the habit is
  // anchored to, e.g. "After morning coffee". Set in HabitEditView; surfaced on
  // Home as a quiet trigger line. Distinct from the legacy `anchor` field so the
  // timing-drift leverage machinery stays dormant. Rides recurringRules persist/
  // sync; dies with the habit; survives rename.
  cue?: string | null;
}

export interface RecurringToDo {
  id: string;
  title: string;
  daysOfWeek: number[];
  interval?: number; // 1 = every week (default), 2 = every other week
  intervalAnchorDate?: string; // YYYY-MM-DD reference date to calculate which weeks apply
  // YYYY-MM-DD dateKeys to suppress materialization for. Lets the user
  // skip "just today" without breaking the recurring series — Apple
  // Calendar's per-day exception model. Backfilled to [] in v15.
  exceptions?: string[];
  // NEX-60: optional parent mandate id. Set when the rule is created
  // from onboarding's recurringTodos bucket so mandate detail can
  // surface it under LINKED RECURRING. Manual recurring to-dos leave
  // this undefined. Mirrors DailyTask.pillarId.
  pillarId?: string;
}

export interface DailyTask {
  id: string;
  title: string;
  completed: boolean;
  // NEX-309: provenance for an occurrence detached from a recurring rule by
  // "Move Just This Day". Item-level optional fields inside `dailyTasks`, which
  // is persisted + cloud-synced as an opaque map (partialize rest-spreads,
  // migrate preserves it verbatim, mergeCloudState takes the whole object), so
  // per the NEX-285 precedent they ride every sync path with no 8-site wiring.
  // NOTE: three PROJECTIONS do narrow the fields and will drop these —
  // widget-bridge (id/title/completed), NexusWidget.swift, and
  // selectTodayTaskRollup. Nothing needs them there today; wire them
  // deliberately if a consumer ever does.
  movedFromRuleId?: string;
  movedFromDateKey?: string;
  // v22: first completion timestamp for activation-day crediting.
  // Stamped on false→true only and never overwritten thereafter.
  completedAt?: number;
  // v21: when a daily task is created via the Strengthen flow's
  // to-do Add for a specific mandate, this holds that mandate's
  // pillar id so the mandate detail screen can list tasks linked
  // to it. Manual to-dos and tasks created via voice / pulse leave
  // this undefined.
  pillarId?: string;
}

export type ReviewCadence = 'weekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export interface HorizonReview {
  id: string;
  cadence: ReviewCadence;
  dateKey: string; // YYYY-MM-DD
  summary: string; // AI-generated
  responses: Record<string, string>; // prompt key -> user answer
  periodLabel: string; // e.g. "March 2026", "Q1 2026"
  // Snapshot of leverage analysis at submit time. Used by the home-tab
  // "THIS WEEK'S LEVERAGE" card (phase 2). Optional for back-compat.
  leverage?: LeveragePointSnapshot[];
}

// A proposed (and possibly applied) adjustment to a recurring rule for the
// upcoming week. Created during the weekly review; merged into the rule at
// Monday rollover.
export interface NextWeekRuleOverride {
  ruleId: string;
  title: string;
  reason: string; // human-readable rationale shown in the confirm sheet
  before: { daysOfWeek: number[]; timesPerDay: number };
  after: { daysOfWeek: number[]; timesPerDay: number };
  appliedAt: number; // unix ms — only present once user confirms
}

// A leverage-point snapshot kept on the HorizonReview entry so the home tab
// can render "THIS WEEK'S LEVERAGE" without recomputing.
export interface LeveragePointSnapshot {
  ruleId: string;
  title: string;
  rate: number;          // 0–100, completion rate over the reviewed period
  kind: 'leverage' | 'graduate';
  targetTimesPerDay: number;
  targetDaysOfWeek: number[];
}

// Sunday-set focus pre-fill for the upcoming Monday. 1-day TTL: only consumed
// or shown when today === targetDateKey; expires on its own otherwise.
export interface PendingMondayIntention {
  text: string;
  targetDateKey: string;  // YYYY-MM-DD of the Monday it's intended for
  createdAt: number;      // unix ms — informational only
}

// Timestamped habit completion log entry
export interface HabitLogEntry {
  id: string;
  habitTitle: string;       // normalized habit name e.g. "meditation"
  goalIds: string[];        // pillar IDs this habit feeds
  dateKey: string;          // YYYY-MM-DD
  timestamp: number;        // Unix ms
}

// Maps a habit title (lowercase) to an array of pillar IDs
export type GoalHabitMap = Record<string, string[]>;

// ─── NEX-26 — Onboarding recommendations ────────────────────────────────────
//
// Reflection-driven shape (locked 2026-05-11 rev 3). Pulse extracts
// mandates from the user's four-card reflection and proposes one
// habit + 1–2 to-dos per mandate. This slice holds those recommendations
// *before* they're committed to the canonical pillars / recurringRules /
// recurringToDos lists, so the review screen can:
//   - Edit mandate text inline (no counter tick).
//   - Refresh any slot up to 8 times (per-slot counter, cap enforced
//     in src/state/onboarding-recommendations-reducers.ts).
//   - NEX-35: no longer carries a curated-defaults flag — Pulse
//     failures surface the retry screen instead of fake content.
//
// Local-only — intentionally NOT included in syncStateToCloud. The
// canonical pillars / rules / to-dos that this slice produces are
// already cloud-synced; this is scaffolding around onboarding only.

/** Which reflection card a mandate was extracted from. */
export type ReflectionRationaleSource = 'bestVersion' | 'stop' | 'continue' | 'focus';

export interface OnboardingRecommendedMandate {
  /** Opaque "m-XXXXXXXX" string from Pulse. Stable across refreshes. */
  id: string;
  /** Alias for id. Preserved as a separate field to match the wire schema. */
  slotId: string;
  title: string;
  /** Conventionally 'BUSINESS' | 'PERSONAL' | 'VISION'; kept as string for cloud tolerance. */
  category: string;
  /** Which reflection card surfaced this mandate. */
  rationaleSource: ReflectionRationaleSource;
  /**
   * One short sentence (12–20 words) tying the mandate back to the
   * user's reflection. Renders below the mandate title on the
   * review screen. Added in NEX-26 phase F.
   */
  rationale: string;
  /** Per-slot refresh counter. Capped at 8 by the reducer. */
  refreshCount: number;
}

export interface OnboardingRecommendedHabit {
  /** Stable id for this slot. Survives refresh; new on cascade. */
  slotId: string;
  title: string;
  daysOfWeek: number[];                // 0=Sun..6=Sat
  /** Parent mandate id. Every habit ties to exactly one mandate. */
  mandateId: string;
  rationale: string;
  /**
   * NEX-57: review screen's pool-with-tap pattern. `false` on parse;
   * the UI toggles to `true` when the user taps ADD on this card.
   * `commitActivation` sweeps only `added: true` items on Begin.
   * REGENERATE-per-mandate preserves ADDed slots, only refreshes
   * the rest.
   */
  added: boolean;
  /** Per-slot refresh counter. Capped at 8 by the reducer. */
  refreshCount: number;
}

export interface OnboardingRecommendedTodo {
  slotId: string;
  title: string;
  mandateId: string;
  rationale: string;
  /** Optional ISO date (YYYY-MM-DD). Set when Pulse infers a specific deadline from the reflection. */
  dueDate?: string;
  /** NEX-57: see OnboardingRecommendedHabit.added. */
  added: boolean;
  refreshCount: number;
}

// NEX-60: third bucket. A recurring intention the user wants to do
// on a cadence but not be scored on. Persisted as a RecurringToDo
// (with pillarId stamped to the parent mandate) on commitActivation.
export interface OnboardingRecommendedRecurringTodo {
  slotId: string;
  title: string;
  daysOfWeek: number[];                // 0=Sun..6=Sat
  mandateId: string;
  rationale: string;
  /** NEX-57: see OnboardingRecommendedHabit.added. */
  added: boolean;
  refreshCount: number;
}

/** Pulse's "this reflection is too thin" follow-up question. */
export interface OnboardingDisambiguationPrompt {
  question: string;
  options: string[];
}

export interface OnboardingRecommendations {
  /** Unix ms when this set was generated. */
  generatedAt: number;
  mandates: OnboardingRecommendedMandate[];
  habits: OnboardingRecommendedHabit[];
  // NEX-60: recurring intentions, untracked. Persisted as RecurringToDo
  // entries on commitActivation. Separate from habits (which get streak
  // math) and todos (one-time).
  recurringTodos: OnboardingRecommendedRecurringTodo[];
  todos: OnboardingRecommendedTodo[];
  disambiguation: OnboardingDisambiguationPrompt | null;
}

// NEX-136 P3: analytics is off until the user explicitly opts in. 'unset'
// means the first-run consent prompt hasn't been answered yet (existing
// users migrate to 'unset' so they see it once).
export type AnalyticsConsent = 'unset' | 'granted' | 'denied';

export interface NotificationSettings {
  morningHour: number;   // 0-23, default 8
  morningMinute: number; // 0-59, default 0
  eveningHour: number;   // 0-23, default 20
  eveningMinute: number; // 0-59, default 0
  weeklyDay: number;     // 0=Sun..6=Sat, default 0
  weeklyHour: number;    // default 10
  streakAlerts: boolean;
  milestoneAlerts: boolean;
  // NEX-236: quiet-hours window (local minutes-since-midnight) for arbitrary-time
  // one-shots. Optional so older cloud blobs without these keys are fine —
  // consumers default at the READ site (?? 1320 / ?? 480), no migration needed.
  quietHoursStart?: number; // default 1320 (22:00)
  quietHoursEnd?: number;   // default 480 (08:00)
  // NEX-212 (N-3): "Smart timing" — when on (default), the daily morning/evening
  // prompts are nudged toward the hours the user tends to launch the app
  // (appLaunchHourCounts), within a conservative ±2h window. Off forces the exact
  // configured hours. Optional + read everywhere as `!== false` so a pre-feature
  // cloud blob (no key -> undefined) reads as on.
  smartTiming?: boolean;
  // Notification quotes: append a short on-voice quote to the morning/evening
  // notifications. Opt-in, default OFF (read as `=== true`), so a pre-feature
  // blob with no key stays off and no lock screen changes without consent.
  includeQuotes?: boolean;
  // NEX-277: the personalization kill switch. When true (default), AI lines
  // personalized from the user's mandates auto-schedule once filter-safe. When
  // false, selection reverts to the curated seed floor only — an instant revert
  // with no app update. Read everywhere as `!== false` so a pre-feature blob
  // (undefined) defaults to on (matching the owner's "auto-use now" choice).
  personalizedQuotes?: boolean;
}

export interface ManualOrbitEventInput {
  title: string;
  dateKey: string;
  startTime: string;
  endTime: string;
  notes?: string;
  eventType?: 'appointment' | 'time_block';
  cal?: string;
  energy?: OrbitEnergy; // NEX-205: optional energy tag, time_block only
}

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const getLocalDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const getDayIndexFromDateKey = (dateKey: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return new Date().getDay();
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0, 0).getDay();
};

const isDateKey = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const isTime = (value: string) => /^\d{2}:\d{2}$/.test(value);

const normalizeDaysOfWeek = (days: number[]) =>
  Array.from(
    new Set(
      (Array.isArray(days) ? days : [])
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
        .sort((a, b) => a - b)
    )
  );

const combineLocalDateAndTimeToISO = (dateKey: string, time: string) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return date.toISOString();
};

export const formatTimeLabel = (startISO: string, endISO: string) => {
  const start = new Date(startISO);
  const end = new Date(endISO);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return '';
  }

  const fmt = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  return `${fmt.format(start)} – ${fmt.format(end)}`;
};

const parseLooseTimeTo24h = (input: string) => {
  const raw = String(input || '').trim().toUpperCase();
  const match = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM|A|P)?/i);

  if (!match) return '12:00';

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3] ? match[3].toUpperCase() : '';

  if ((meridiem === 'PM' || meridiem === 'P') && hours < 12) hours += 12;
  if ((meridiem === 'AM' || meridiem === 'A') && hours === 12) hours = 0;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return `${hh}:${mm}`;
};

/**
 * NEX-45/NEX-44: connected calendar events for the rolling today + tomorrow window.
 * Promoted from component-local state so the widget bridge can include
 * them in every snapshot, not just snapshots written by home-screen.
 */
export interface AppleCalendarWindowEvent {
  id: string;
  title: string;
  startISO: string;
  endISO?: string;
  provider?: 'apple' | 'google' | 'outlook';
  cal?: string;
}

// Connector-actions drain (docs/plans/connector-actions.md): outcome of one
// logHabitForDate call, mapped by the drainer onto the row's terminal status —
// 'applied' → applied, 'already_at_times_per_day' → noop, the rest → failed.
export type LogHabitOutcome =
  | 'applied'
  | 'already_at_times_per_day'
  | 'unknown_habit'
  | 'invalid_date_key';

interface AppState {
  isActivated: boolean;
  activatedDate: string | null;
  // NEX-164: durable Day-1 activation signals. firstHabitCompletedAt is the
  // source of truth for `is_first` on the habit_completed event (set-once,
  // not derived from habitLog — see HomeScreen emit). firstActionIntent is
  // set by the onboarding step-4 guided action and consumed on first
  // completion to attribute analytics `source`.
  firstHabitCompletedAt: string | null;
  firstActionIntent: 'complete_habit' | 'add_habit' | null;
  setFirstHabitCompleted: () => void;
  setFirstActionIntent: (intent: 'complete_habit' | 'add_habit' | null) => void;
  userProfile: UserProfile | null;
  // Persisted provenance only; never sent to cloud. null means legacy/unknown.
  localUserId: string | null;
  modeLabels: { ALL: string; SALES: string; VISION: string; FAMILY: string };
  inbox: InboxTask[];
  // NEX-196: ephemeral "just captured" ref driving the Home echo chip.
  // DELIBERATELY session-only — NOT persisted: excluded from migrate /
  // mergeCloudState / both _layout.tsx sync payloads / localStoreHasUserData /
  // hasRecoverableUserData. Cleared on resetState (sign-out). See capture-echo.ts.
  justCaptured: JustCaptured | null;
  leadTimeActions: LeadTimeAction[]; // NEX-162 Lead-Time Radar
  pillars: Pillar[];
  orbitDays: Record<string, OrbitEvent[]>;
  habits: string[];
  habitStrength: Record<string, number>;
  currentMode: CurrentMode;
  capacity: Capacity;

  // Daily intention
  morningIntention: string | null;
  morningIntentionDate: string | null; // YYYY-MM-DD
  // Date the user marked today's intention completed. When this matches
  // today's key, the Win shows a completed treatment. Naturally invalidates
  // at midnight without a sweeper since the comparison is date-keyed.
  morningIntentionCompletedDate: string | null;

  // Weekly reflection
  weeklyReflection: string | null;
  weeklyReflectionDate: string | null; // YYYY-MM-DD of Sunday

  // Nightly debrief close-the-loop sentence
  nightlyForward: string | null;
  nightlyForwardDate: string | null; // YYYY-MM-DD

  // Daily score (0-100) per YYYY-MM-DD key
  dailyScores: Record<string, number>;

  // Habit streaks: habit title (lowercase) -> current streak in days
  habitStreaks: Record<string, number>;
  habitStreakUpdatedDate: Record<string, string>; // last date streak was updated
  // NEX-190: rep-milestones (7/30/66/365) already celebrated per habit (lowercase
  // title -> thresholds). Makes the cumulative milestone ceremony fire ONCE — an
  // unlog-then-relog across a threshold can't re-fire it.
  milestonesShown: Record<string, number[]>;

  // Weekly wins (3 things that would make this week a win)
  weeklyWins: string[];
  weeklyWinsDate: string | null;

  // Horizon reviews
  horizonReviews: HorizonReview[];
  lastReviewDates: Record<string, string>; // 'monthly' | 'quarterly' | 'semiannual' | 'annual' -> YYYY-MM-DD

  // Daily wisdom quotes (persisted so they don't regenerate on every tab visit)
  dailyWisdomQuotes: { quote: string; author: string }[];
  dailyWisdomDate: string; // YYYY-MM-DD
  // The today's-win (morningIntention) the cached quotes were generated for,
  // so Orbit can re-roll once when the win changes. Device-local day cache —
  // mirrors dailyWisdomDate exactly (NOT cloud-synced; absent from
  // mergeCloudState / the _layout sync payloads / localStoreHasUserData /
  // data-durability). '' = generated with no win; null = legacy pre-field.
  dailyWisdomIntention: string | null;
  wisdomQuoteCount: 0 | 1 | 3 | 5;

  // Rolling 30-day history of every quote shown — feeds the banlist that
  // keeps the daily quotes from repeating. Trimmed at write-time.
  recentWisdomHistory: Array<{ quote: string; author: string; dateKey: string }>;

  // Pinned habits — user-selected habits to track
  pinnedHabits: string[]; // habit titles

  // Onboarding / tutorial
  hasSeenTutorial: boolean;

  // NEX-124 conversion-funnel set-once guards. Install-scoped: persisted,
  // cleared on resetState (so a second account on the same install fires its
  // own funnel events), and Boolean-coerced on rehydrate. Per-install re-fire
  // on reinstall/new-device is acceptable — PostHog funnels dedupe per person.
  firstMandateCommittedFired: boolean;
  firstAlignmentScoreSeenFired: boolean;

  // Mandate Strengthen catch-up banner — dismissible one-time banner
  // on Align that surfaces under-supported mandates so the user can
  // strengthen each in one sitting. Once true, never reappears, even
  // if new weak mandates show up later (per UX intent — this is a
  // catch-up, not a recurring nag).
  strengthenBannerDismissed: boolean;

  // Gamification
  totalXP: number;
  badges: Badge[];
  streakFreezes: number;
  lastFreezeDate: string | null;
  lastOpenDate: string | null;
  // NEX-212 (N-3): 24-slot histogram of the local HOUR at each cold launch
  // (recorded in recordAppOpen), the passive "receptivity" signal that nudges the
  // daily prompt times. DEVICE-LOCAL: persisted, but deliberately NOT in
  // mergeCloudState / the _layout sync payloads / localStoreHasUserData /
  // data-durability — a phone-use pattern is per-device, not recoverable user
  // data, so it must never sync. Cleared in resetState. (Same device-local
  // treatment intent as the ephemeral flags below, but this one IS persisted.)
  appLaunchHourCounts: number[];
  // NEX-308: what the user did with AI suggestions (accepted / regenerated
  // away). DEVICE-LOCAL: persisted, but deliberately NOT in mergeCloudState /
  // the _layout sync payloads / localStoreHasUserData / data-durability — same
  // treatment as appLaunchHourCounts. This is behavioral telemetry for local
  // personalization, not recoverable user content, and keeping it off the wire
  // avoids a cloud surface carrying inferences about the user. Cleared in
  // resetState. Capped in the pure reducer (recordSuggestionOutcomes).
  suggestionFeedback: SuggestionFeedbackEntry[];
  // Notification-quote pool (device-local, NOT cloud-synced — same treatment as
  // appLaunchHourCounts). NEX-277: live + pending are BOTH schedulable AI lines
  // (auto-use, no human gate); `removed` tombstones owner-deleted lines; `mandateHash`
  // tracks the mandate context for staleness. Drives the morning/evening quote.
  quotesPool: QuotePool;
  /**
   * The coach thread (docs/plans/2026-09-02-coach-conversation.md). Synced:
   * it follows the account. Every write goes through setCoachThread, which
   * sanitizes, so no row can enter by a path that skipped normalization.
   */
  coachThread: CoachThread;
  // NEX-191: session-only flag — true on first open after a >=3-day lapse, so
  // Home collapses to the shame-free return surface. Ephemeral (never persisted,
  // synced, or migrated); recomputed each launch in recordAppOpen. Boolean only —
  // the day count is never stored (Law C: never count an absence).
  returningFromLapse: boolean;

  // NEX-207 Pause Mode (B1): a planned break that freezes expectations and
  // silences nudges. Synced intent (round-trips like softMode/streakFreezes).
  // See src/state/pause-mode.ts for the interval-history model + repair logic.
  pauseMode: PauseModeState;
  // Session-only flag — true on the open after resuming a pause, so Home shows
  // the forward-only resume surface (NOT the lapse surface). Ephemeral like
  // returningFromLapse: never persisted, synced, or migrated (Law C).
  resumingFromPause: boolean;

  // Gamification events (transient flags for UI reactions)
  pendingLevelUp: number | null; // new level just reached
  pendingBadgeUnlock: Badge | null; // badge currently being toasted
  // NEX-220: badges unlocked in the same transaction beyond the one being
  // toasted. clearPendingBadgeUnlock drains this so each newly-unlocked badge
  // gets its own toast (e.g. an existing high-rep user self-healing first_week +
  // iron_will + centurion at once). Local UI state only — never cloud-synced.
  pendingBadgeUnlockQueue: Badge[];

  // Challenges
  /** @deprecated Removed from UI in 2026-04. Field retained for backward compatibility with cloud payloads from older app versions. Do not reference in new code. */
  activeChallenge: Challenge | null;
  /** @deprecated Removed from UI in 2026-04. Field retained for backward compatibility with cloud payloads from older app versions. Do not reference in new code. */
  completedChallenges: string[];

  // Score history (last 30 days)
  scoreHistory: Record<string, number>; // YYYY-MM-DD -> score

  // Notification settings
  notificationSettings: NotificationSettings;

  // NEX-190 De-streak: default surface shows cumulative, non-resetting progress.
  // Soft Mode is the opt-in for the breakable consecutive-day streak (one free
  // miss, never red). Off by default — a breakable streak is never the default.
  softMode: boolean;

  // NEX-210: remembered "break into steps" granularity (the user's last-picked
  // grain). Synced like softMode. The breakdown itself is always opt-in/offer.
  breakdownGrain: BreakdownGrain;

  // NEX-136 P3: PostHog analytics consent. 'unset' until the first-run
  // prompt is answered; analytics only captures when 'granted'.
  analyticsConsent: AnalyticsConsent;

  // Weekly email digest
  weeklyEmailEnabled: boolean;
  weeklyEmailConsent: WeeklyEmailConsent;
  weeklyEmailConsentUpdatedAt: number | null;
  weeklyEmailDay: number; // 0=Sun..6=Sat, default 0 (Sunday)

  // Today's Focus picks for the Align tab — one mandate per category.
  // Persists indefinitely; user changes via long-press → 'Set as today's
  // focus'. Missing key falls back to first pillar in that category.
  // Stale ids (deleted pillars) auto-skip without delete-time cleanup
  // because the selector does a presence lookup.
  mandateFocus: Record<string, string>;

  recurringRules: RecurringRule[];
  recurringToDos: RecurringToDo[];
  dailyTasks: Record<string, DailyTask[]>;
  habitLog: HabitLogEntry[];
  goalHabitMap: GoalHabitMap;

  // Pending rule adjustments staged during the weekly review, keyed by the
  // Sunday dateKey on which they were created. Drained at Monday rollover.
  nextWeekRuleOverrides: Record<string, NextWeekRuleOverride[]>;

  // Sunday-set focus pre-fill for the upcoming Monday (1-day TTL).
  pendingMondayIntention: PendingMondayIntention | null;

  // NEX-26: Pulse-generated onboarding recommendations. Null until the
  // mandates flow generates a set; populated by the service layer in
  // phase 3 and read by the UI in phases 3–6. Cleared on resetState.
  // Local-only — not in syncStateToCloud.
  onboardingRecommendations: OnboardingRecommendations | null;

  // Dev-only: when true, app/_layout.tsx mounts OnboardingScreen over the
  // normal gate (wins over isActivated and the simulator bypass) so the
  // flow can be re-recorded for App Store Connect previews. Session-only —
  // stripped in the persist partialize so a restart can never strand the
  // app in onboarding. Settable only from __DEV__-gated UI.
  devReplayOnboarding: boolean;
  setDevReplayOnboarding: (value: boolean) => void;

  // NEX-45/NEX-44: connected calendar events fetched by home-screen for the
  // today + tomorrow window. Lifted into the store so syncWidgetAfterMutation
  // can include them in every snapshot (it can't see component-local
  // state). Refreshed every time home-screen mounts. Persisted with
  // the rest of the store; ~1s cold-start staleness is acceptable.
  appleEventsWindow: AppleCalendarWindowEvent[];

  activateUser: (profile: UserProfile) => void;
  setPhoneNumber: (phoneNumber: string | undefined) => void;
  setMode: (mode: CurrentMode) => void;
  setCapacity: (capacity: Capacity) => void;
  updateModeLabel: (key: CurrentMode, label: string) => void;

  toggleHabit: (id: string) => void;

  // Returns the new pillar's id so callers can attach follow-up data
  // (notes, links) without a title-based read-back race.
  addPillarManual: (title: string, context?: string, category?: string) => string;
  deletePillar: (id: string) => void;
  updatePillarManual: (id: string, title: string) => void;
  // Mandate detail screen — free-form notes attached to a pillar.
  // Empty string clears notes; undefined never reaches here from
  // the UI (TextInput coalesces).
  updatePillarNotes: (id: string, notes: string) => void;

  // Phase 4: returns the new task's id so callers can stamp it later
  // (mirror externalId, etc.). Options object allows due dates and
  // initial source — defaults to 'manual'.
  addInboxTask: (
    title: string,
    options?: {
      dueDate?: string;
      source?: 'manual' | 'apple_reminders';
      status?: string;
      proposalKey?: string;
    },
  ) => string;
  toggleInboxTask: (id: string) => void;
  deleteInboxTask: (id: string) => void;
  // NEX-198: idempotent resolve (archive) for an ambient reminder.
  resolveInboxTask: (id: string) => void;
  // NEX-259: opt-in "keep nudging" toggle for a timed reminder (idempotent).
  setInboxKeepNudging: (id: string, on: boolean) => void;
  // NEX-196: set/clear the ephemeral Home-echo ref. setJustCaptured stamps `at`.
  setJustCaptured: (c: Omit<JustCaptured, 'at'>) => void;
  clearJustCaptured: () => void;
  // NEX-162 Lead-Time Radar. actByDate is computed from eventDate − leadDays
  // unless an explicit actByDate is supplied (user-edited).
  addLeadTimeAction: (input: {
    title: string;
    eventTitle: string;
    eventDate: string;
    leadDays: number;
    eventId?: string | null;
    actByDate?: string;
  }) => string;
  updateLeadTimeAction: (
    id: string,
    patch: Partial<Pick<LeadTimeAction, 'title' | 'eventTitle' | 'eventDate' | 'leadDays' | 'actByDate' | 'eventId'>>,
  ) => void;
  toggleLeadTimeAction: (id: string) => void;
  deleteLeadTimeAction: (id: string) => void;
  // Phase 4: accepts either a string (legacy: title only) or a partial
  // patch object. The patch form is used by the voice-mirror flow to
  // stamp source/externalId on a freshly-created inbox item once the
  // EventKit write resolves.
  updateInboxTask: (
    id: string,
    patchOrTitle:
      | string
      | {
          title?: string;
          source?: 'manual' | 'apple_reminders';
          externalId?: string;
          dueDate?: string;
        },
  ) => void;
  setInboxOrder: (tasks: InboxTask[]) => void;
  /**
   * Phase 2 Apple Reminders read path. Merges fetched reminder
   * records into the inbox by externalId. Adds new items at the
   * top, updates title/dueDate in place when they drift, and skips
   * archived items so user-triaged work doesn't resurrect. Returns
   * a tally for the caller's status surface.
   */
  upsertRemindersFromApple: (records: Array<{
    id: string;
    title: string;
    dueDate?: string;
    notes?: string;
    listId: string;
  }>) => { added: number; updated: number; skipped: number };
  /**
   * Phase 3 reconcile: given the externalIds the latest sync saw as
   * incomplete vs completed, mark Apple-sourced inbox items
   * accordingly. Items absent from both sets are orphaned (archived
   * with `orphaned: true`). Already-archived items are left alone.
   */
  reconcileExternalState: (buckets: { incompleteIds: Set<string>; completedIds: Set<string> }) => void;
  /**
   * Archives every source: 'apple_reminders' inbox item. Used on
   * disconnect so a stale list of imported items doesn't keep
   * cluttering the active inbox. Doesn't touch `completed` or
   * `orphaned` — disconnect ≠ user-triaged-as-done.
   */
  archiveAllAppleReminders: () => void;

  addOrbitEvent: (title: string, timeStr: string, calType?: string) => void;
  addManualOrbitEvent: (input: ManualOrbitEventInput) => void;
  updateEvent: (id: string, newTitle: string) => void;
  deleteEvent: (id: string) => void;
  // NEX-205 (Or-2, PR2b): reschedule a native time-block's window (move-to-next-
  // window + its undo). Spreads the event so energy/notes survive; re-derives
  // timeLabel and re-sorts the day. Same-day only (caller caps at day-end).
  setOrbitEventTime: (id: string, startISO: string, endISO: string) => void;

  addRecurringRule: (
    title: string,
    daysOfWeek: number[],
    time?: string | null,
    preferredTimeBlock?: TimeBlock | null,
    cal?: string,
    appleEventId?: string | null,
    timesPerDay?: number | null,
    firstStep?: string | null
  ) => string;

  linkRecurringRuleToAppleEvent: (ruleId: string, appleEventId: string) => void;
  /**
   * Clear the rule's mirror without deleting the rule. The recoverable
   * alternative to deleteRecurringRule. The device-local link is released
   * separately via clearAppleLink().
   */
  unlinkRecurringRuleFromAppleEvent: (ruleId: string) => void;
  updateRecurringRuleFromApple: (
    ruleId: string,
    updates: {
      title?: string;
      daysOfWeek?: number[];
      time?: string | null;
      preferredTimeBlock?: TimeBlock | null;
      appleEventId?: string | null;
    }
  ) => void;
  deleteRecurringRule: (ruleId: string) => void;
  renameRecurringRule: (ruleId: string, newTitle: string) => void;
  // NEX-54: atomic edit of one rule — title (with the same habit-log re-key
  // as rename), daysOfWeek, and timesPerDay in a single functional update.
  updateRecurringRule: (ruleId: string, patch: RuleEditPatch) => void;

  // NEX-195: returns the new rule id so the capture confirmation can
  // offer one-tap undo/jump for a recurring to-do.
  addRecurringToDo: (title: string, daysOfWeek: number[], interval?: number) => string;
  updateRecurringToDo: (id: string, updates: Partial<RecurringToDo>) => void;
  deleteRecurringToDo: (id: string) => void;
  /**
   * Per-day exception write — suppresses materialization for a single
   * dateKey without altering the rule's daysOfWeek/interval. Idempotent:
   * adding the same dateKey twice is a no-op.
   */
  addRecurringToDoException: (id: string, dateKey: string) => void;
  /**
   * NEX-309: move ONE occurrence of a recurring to-do to another day (the
   * detaching half of Apple Calendar's model). Returns the detached task id on
   * success so the caller can offer undo, or a refusal reason to surface.
   * All three writes land in a single `set` — never three separate setStates.
   */
  moveRecurringOccurrence: (
    ruleId: string,
    fromDateKey: string,
    toDateKey: string,
  ) => { ok: true; detachedId: string } | { ok: false; reason: MoveRefusal };
  undoMoveRecurringOccurrence: (
    ruleId: string,
    fromDateKey: string,
    toDateKey: string,
    detachedId: string,
  ) => void;
  // NEX-60: like addRecurringToDo but stamps pillarId for the
  // mandate detail's LINKED RECURRING section. Onboarding's
  // recurringTodos bucket routes through here on commitActivation.
  addRecurringToDoForPillar: (title: string, daysOfWeek: number[], pillarId: string) => void;

  addDailyTask: (arg1: string, arg2?: string) => void;
  // Mandate detail / Strengthen flow — adds a daily task with the
  // pillar id stamped so the detail screen can list "linked to-dos."
  // Separate from addDailyTask so the existing arg1/arg2 sniffing
  // shape stays intact.
  addDailyTaskForPillar: (title: string, dateKey: string, pillarId: string) => void;
  toggleDailyTask: (dateKey: string, id: string) => void;
  reorderDailyTask: (dateKey: string, id: string, direction: 'up' | 'down') => void;
  setDailyTasksOrder: (dateKey: string, tasks: DailyTask[]) => void;
  deleteDailyTask: (dateKey: string, id: string) => void;

  logHabit: (habitTitle: string) => void;
  // Connector-actions drain (docs/plans/connector-actions.md): date-aware
  // logHabit with outcome reporting. Runs the exact logHabit reducer (streaks,
  // XP, badges, challenges) but against `dateKey` instead of hardcoded today,
  // and refuses habits with no matching recurring rule instead of logging an
  // orphaned entry.
  logHabitForDate: (habitTitle: string, dateKey: string) => LogHabitOutcome;
  unlogHabit: (habitTitle: string) => void;
  linkHabitToGoal: (habitTitle: string, pillarId: string) => void;
  unlinkHabitFromGoal: (habitTitle: string, pillarId: string) => void;
  getGoalStats: (pillarId: string, windowDays: number) => { completed: number; total: number };

  setMorningIntention: (intention: string) => void;
  toggleMorningIntentionComplete: () => void;
  setWeeklyReflection: (reflection: string) => void;
  setNightlyForward: (forward: string) => void;
  setWeeklyWins: (wins: string[]) => void;
  // Connector-actions drain (docs/plans/connector-actions.md): read-modify-write
  // append of one win — never a raw setWeeklyWins replace, which would clobber
  // wins the user already entered this week.
  appendWeeklyWin: (title: string) => void;
  addHorizonReview: (review: HorizonReview) => void;
  updateHorizonReview: (id: string, patch: Partial<Pick<HorizonReview, 'responses' | 'summary' | 'periodLabel' | 'leverage'>>) => void;
  deleteHorizonReview: (id: string) => void;
  setLastReviewDate: (cadence: string, dateKey: string) => void;
  setNextWeekRuleOverride: (sundayDateKey: string, override: NextWeekRuleOverride) => void;
  removeNextWeekRuleOverride: (sundayDateKey: string, ruleId: string) => void;
  clearNextWeekRuleOverrides: (sundayDateKey: string) => void;
  applyPendingRuleOverrides: () => void;

  setPendingMondayIntention: (text: string, targetDateKey: string) => void;
  consumePendingMondayIntention: () => void;
  clearPendingMondayIntention: () => void;
  setDailyWisdom: (quotes: { quote: string; author: string }[], dateKey: string, intention: string) => void;
  appendWisdomHistory: (quotes: { quote: string; author: string }[], dateKey: string) => void;
  setWisdomQuoteCount: (count: 0 | 1 | 3 | 5) => void;
  setPinnedHabits: (habits: string[]) => void;
  // NEX-171: per-habit score inclusion (replaces pinning).
  setHabitExcludedFromScore: (ruleId: string, value: boolean) => void;
  setHasSeenTutorial: (seen: boolean) => void;
  setStrengthenBannerDismissed: (dismissed: boolean) => void;
  setNotificationSettings: (settings: Partial<NotificationSettings>) => void;
  // Notification-quote pool actions (NEX-277: AI lines auto-schedule; no human gate).
  setQuotesPool: (pool: QuotePool) => void;
  // Tombstone a scheduled AI line the owner removed (drops it + blocks re-add).
  removeNotificationQuote: (quote: string) => void;
  // Evict stale personalized lines when the mandate context hash changes (NEX-277).
  syncMandateContext: (hash: string) => void;
  // Atomic deltas against the CURRENT pool (two async writers on launch — generation
  // + the scheduler — must not clobber each other's snapshot):
  recordQuotesShown: (quotes: string[], dayIndex: number) => void;
  mergeGeneratedQuotes: (generated: QuotePool) => void;
  /**
   * NEX-308: record what became of AI suggestions. Takes an ARRAY because
   * regenerate rejects a whole shown set at once — one atomic `set`, no
   * read-modify-write race between items.
   */
  recordSuggestionFeedback: (entries: Partial<SuggestionFeedbackEntry>[]) => void;
  setSoftMode: (on: boolean) => void;
  // NEX-210: remember the picked breakdown grain; land N broken-down steps as
  // plain inbox one-offs, returning their ids (for the ledger's undo).
  setBreakdownGrain: (grain: BreakdownGrain) => void;
  /**
   * Atomic read-modify-write for the coach thread (a snapshot-replace setter
   * would race the cloud merge on launch). Pass a reducer from coach-thread.ts.
   */
  setCoachThread: (next: CoachThread | ((current: CoachThread) => CoachThread)) => void;
  addBrokenDownSteps: (steps: string[], goalTitle?: string) => string[];
  markMilestoneShown: (habitTitle: string, reps: number) => void;
  setAnalyticsConsent: (value: AnalyticsConsent) => void;
  setWeeklyEmail: (enabled: boolean, day?: number) => void;
  setMandateFocus: (category: string, mandateId: string | null) => void;
  clearPendingLevelUp: () => void;
  clearPendingBadgeUnlock: () => void;
  /** @deprecated Removed from UI in 2026-04. Field retained for backward compatibility with cloud payloads from older app versions. Do not reference in new code. */
  assignChallenge: () => void;
  recordDailyScore: (dateKey: string, score: number) => void;
  // `force` bypasses the NEX-142 empty-install guard — only for callers whose
  // clock comparison already proved the cloud row is NEWER than what this
  // device last saw (the Phase 1 sync guard; see services/cloud-sync-guard.ts).
  mergeCloudState: (cloudState: any, opts?: { force?: boolean; allowEmptyFields?: readonly string[]; reconciledHabitLog?: boolean }) => void;
  resetState: () => void;
  // NEX-124: synchronous claim-once setters. Set the flag BEFORE the async
  // trackEvent fires, so a double-render can't double-emit.
  markFirstMandateCommitted: () => void;
  markFirstAlignmentScoreSeen: () => void;

  // NEX-26: replace the recommendation slice wholesale. Passing null
  // clears it. Slot-level mutators (refresh, dismiss-rationale) will
  // land alongside their consuming UI in phases 5 and 6.
  setOnboardingRecommendations: (value: OnboardingRecommendations | null) => void;
  setAppleEventsWindow: (events: AppleCalendarWindowEvent[]) => void;

  // NEX-26 phase D — slot-level mutators. All five wrap pure
  // reducers in src/state/onboarding-recommendations-reducers.ts.
  // The reducers enforce cap-at-8 on refreshX calls (no-op at cap)
  // and zero refresh counters on cascade. Pulse-call orchestration
  // (figuring out what new values to pass) lives in phase E.
  setMandateTitle: (mandateId: string, newTitle: string) => void;
  refreshMandate: (
    mandateId: string,
    fields: { title: string; category: string; rationaleSource: 'bestVersion' | 'stop' | 'continue' | 'focus'; rationale: string },
  ) => void;
  refreshHabit: (
    slotId: string,
    fields: { title: string; daysOfWeek: number[]; rationale: string },
  ) => void;
  refreshRecurringTodo: (
    slotId: string,
    fields: { title: string; daysOfWeek: number[]; rationale: string },
  ) => void;
  refreshTodo: (
    slotId: string,
    fields: { title: string; rationale: string },
  ) => void;
  regenerateMandateDownstream: (
    mandateId: string,
    newHabits: OnboardingRecommendedHabit[],
    newRecurringTodos: OnboardingRecommendedRecurringTodo[],
    newTodos: OnboardingRecommendedTodo[],
  ) => void;
  // NEX-57: ADD-toggle for the review screen's pool-with-tap pattern.
  // Each flips `added` on the matching pool item. No refresh counter
  // tick. `commitActivation` reads these on Begin to know which
  // items to route into canonical state.
  toggleAddedHabit: (slotId: string) => void;
  toggleAddedRecurringTodo: (slotId: string) => void;
  toggleAddedTodo: (slotId: string) => void;
  computeDailyScore: (dateKey: string) => number;
  incrementStreak: (habitTitle: string) => void;
  getStreak: (habitTitle: string) => number;
  awardXP: (amount: number) => void;
  unlockBadge: (badgeId: string) => void;
  useStreakFreeze: () => boolean;
  recordAppOpen: () => void;
  setReturningFromLapse: (v: boolean) => void;
  // NEX-207 Pause Mode (B1). startPauseMode begins a pause (optional planned end);
  // resumePauseMode atomically repairs streaks, closes the interval, and flags the
  // resume surface — atomic so a resume-then-log can't lose a streak.
  startPauseMode: (plannedUntil?: string | null) => void;
  resumePauseMode: () => void;
  setResumingFromPause: (v: boolean) => void;

  syncAllData: () => void;
}

type GoalStats = { completed: number; total: number };
const goalStatsCacheByHabitLog = new WeakMap<HabitLogEntry[], Map<string, GoalStats>>();

// NEX-142: true when the local store already holds real user data. The
// Supabase snapshot is a backup, never authoritative over a populated local
// store, so mergeCloudState refuses to run when this is true — a stale cloud
// copy can never overwrite fresh local completions/settings/pins. Seeding from
// cloud only happens on a genuinely empty install. Exported as the single
// source of truth for "is this install empty?" — the launch-time seed gate in
// app/_layout.tsx imports this so the two gates can never drift. Mirrors
// hasRecoverableUserData in services/data-durability.ts.
export function localStoreHasUserData(s: any): boolean {
  if (!s || typeof s !== 'object') return false;
  if (s.isActivated === true) return true;
  const arrays = [
    s.recurringRules,
    s.recurringToDos,
    s.habitLog,
    s.pillars,
    s.inbox,
    s.leadTimeActions,
    s.habits,
    s.horizonReviews,
    s.pinnedHabits,
  ];
  if (arrays.some((a) => Array.isArray(a) && a.length > 0)) return true;
  const objects = [
    s.dailyTasks,
    s.orbitDays,
    s.goalHabitMap,
    s.dailyScores,
    s.habitStreaks,
    s.scoreHistory,
  ];
  if (objects.some((o) => o && typeof o === 'object' && Object.keys(o).length > 0)) return true;
  // A conversation is user data (decision in the coach plan): a thread-only
  // install must not be treated as empty and overwritten by a stale cloud row.
  // Only the person's own turns count: the auto-generated opener must not make a
  // fresh install read as populated and block the NEX-142 first-launch restore.
  if (Array.isArray(s.coachThread?.messages) && s.coachThread.messages.some((m: any) => m?.role === 'user')) return true;
  if (s.coachThread?.pendingPlan) return true;
  return false;
}

// NEX-124: mandate category is a prompt contract, not validated code — whitelist
// before it becomes a PostHog property. Anything off-list → 'other'.
const ALLOWED_MANDATE_CATEGORIES = new Set(['business', 'vision', 'personal']);

// The full habit-log reducer, shared by logHabit (user tap, dateKey = today)
// and logHabitForDate (connector drain, explicit dateKey). Returns the zustand
// set() patch; returns `s` unchanged when the habit is already at its
// timesPerDay cap for dateKey. `now` still timestamps the entry and drives the
// hour/week-window badge logic even when dateKey is a past date.
function buildHabitLogPatch(
  s: AppState,
  habitTitle: string,
  dateKey: string,
  now: Date,
): Partial<AppState> {
  // NEX-220: `today` is the log's dateKey — captured once per transaction by
  // the caller so `hour`, the triple-threat week window, and `todayDay` can't
  // straddle a local-midnight boundary against it.
  const today = dateKey;
  // Calendar context (weekday, week window, the rules scheduled THAT day)
  // derives from the log's target date, not from `now`: a historical log from
  // the connector drain evaluated against today's calendar would award or
  // withhold badges (all_in, triple_threat) on the wrong schedule. Noon dodge
  // keeps DST edges out of the weekday math. Identical to `now` when the
  // target IS today, so a user tap's behavior is unchanged.
  const [targetY, targetM, targetD] = today.split('-').map(Number);
  const targetDate = new Date(targetY, targetM - 1, targetD, 12, 0, 0, 0);
  const key = normalize(habitTitle);
  const goalIds = s.goalHabitMap[key] ?? [];
  const matchingRule = (s.recurringRules ?? []).find(
    (r: any) => normalize(r.title) === key
  );
  const required = (matchingRule as any)?.timesPerDay || 1;
  const todayCount = s.habitLog.filter(
    (e) => normalize(e.habitTitle) === key && e.dateKey === today
  ).length;
  if (todayCount >= required) return s;
  emitHabitLogged();
  const entry: HabitLogEntry = {
    id: createId(),
    habitTitle: key,
    goalIds,
    dateKey: today,
    timestamp: Date.now(),
  };
  const lastUpdated = s.habitStreakUpdatedDate[key];
  // NEX-109: Grace Day is now the default streak mechanic.
  // One missed scheduled occurrence holds the current streak instead
  // of silently resetting it; the next completion continues from the
  // held count. This stays schedule-aware for M/W/F-style habits.
  const daysOfWeek = (matchingRule as any)?.daysOfWeek;
  const prevScheduled = previousScheduledDateKey(today, daysOfWeek, 1);
  const graceAnchor = previousScheduledDateKey(today, daysOfWeek, DEFAULT_STREAK_GRACE_MISSES + 1);
  const currentStreak = s.habitStreaks[key] ?? 0;
  let newStreak = currentStreak;
  const isFirstCompletionToday = todayCount === 0;
  // A backdated completion (the connector drain's order need not match the
  // payload date_keys) must never move streak state BACKWARDS: the reset
  // branch below would otherwise write the older date over a newer anchor and
  // collapse a live streak to 1. Record the rep, keep the streak and anchor.
  // String compare is safe — both sides are YYYY-MM-DD local date keys.
  const isBackfill = lastUpdated !== undefined && lastUpdated > today;
  if (isFirstCompletionToday && !isBackfill) {
    if (lastUpdated === today) {
      newStreak = currentStreak;
    } else if (lastUpdated === prevScheduled || lastUpdated === graceAnchor || currentStreak === 0) {
      newStreak = currentStreak + 1;
    } else {
      newStreak = 1;
    }
  }

  // NEX-190: flat XP per completion. The old consecutive-streak XP bonus was a
  // punishing-streak mechanic (a miss forfeited the future bonus — Law E); removed
  // so XP is purely additive and symmetric with unlog. The 7/30/66/365 milestone
  // ceremony (home-screen) carries the celebration instead.
  const xpGain = XP_HABIT_COMPLETE;

  // NEX-220: immutable badge update — replace the element when stamping
  // unlockedAt rather than mutating shared objects, so newlyUnlocked can
  // still diff the new badges against s.badges (mutation would hide it).
  const newBadges = (s.badges || []).map((b: Badge) => ({ ...b }));
  const unlock = (id: string) => {
    const i = newBadges.findIndex((x: Badge) => x.id === id);
    if (i >= 0 && !newBadges[i].unlockedAt) newBadges[i] = { ...newBadges[i], unlockedAt: Date.now() };
  };

  // allHabitLogs (post-entry) is the source of truth for cumulative reps —
  // counting s.habitLog would be one log behind on a 6→7 crossing.
  const allHabitLogs = [...s.habitLog, entry];

  if (s.habitLog.length === 0) unlock('first_step');

  // NEX-220: cumulative rep milestones (a miss takes none away), not streaks.
  // Unlock EVERY earned threshold so an existing high-rep user (e.g. ≥100
  // reps, all locked from the old streak-keyed scheme) never has an
  // earned-but-locked badge after a log. Each newly-unlocked badge is then
  // toasted in turn via the pendingBadgeUnlockQueue (built at the return),
  // so unlocking several at once never silently drops a celebration.
  const thisHabitReps = allHabitLogs.filter(e => normalize(e.habitTitle) === key).length;
  for (const id of repBadgeUnlocks(thisHabitReps)) unlock(id);
  // "Back after a pause" — returned after a real (scheduled) gap. Derive the
  // previous completion date from habitLog itself (not the
  // habitStreakUpdatedDate cache, which unlogHabit does not roll back, so a
  // log/unlog/log dance could otherwise suppress or falsely award it), and
  // only on the first completion today.
  const priorDateKeys = s.habitLog
    .filter((e) => normalize(e.habitTitle) === key && e.dateKey < today)
    .map((e) => e.dateKey);
  const prevLogDateKey = priorDateKeys.length
    ? priorDateKeys.reduce((a, b) => (a > b ? a : b))
    : null;
  if (isFirstCompletionToday && isComebackReturn({ prevLogDateKey, todayKey: today, daysOfWeek })) {
    unlock('comeback_kid');
  }
  // Greptile #392 round 9: time-of-day credit (early_bird badge, early_log
  // challenge) only applies to SAME-DAY logs. A backfill says nothing about
  // when the rep actually happened, so a historical log drained before
  // 7/9 AM must not earn early credit. Date-keyed logic (streaks, all_in,
  // triple_threat, comeback) stays target-date-relative either way.
  const isHistoricalLog = today < getLocalDateKey(now);
  const hour = now.getHours();
  if (!isHistoricalLog && hour < 7) unlock('early_bird');

  // NEX-220: three distinct LIVE habits with progress this week, not 3 streaks.
  const weekStartD = new Date(targetDate);
  weekStartD.setDate(weekStartD.getDate() - weekStartD.getDay());
  weekStartD.setHours(0, 0, 0, 0);
  const weekStartKey = getLocalDateKey(weekStartD);
  // Mirror the score/Home "live habit" filter (~app-state.ts:2473): drop
  // archived and excludedFromScore rules so a paused/archived habit can't
  // count toward triple_threat when the rest of the app treats it as not live.
  const liveTitles = (s.recurringRules ?? [])
    .filter((r: any) => !r?.archived && !r?.excludedFromScore)
    .map((r: any) => r.title);
  if (tripleThreatCount(allHabitLogs, liveTitles, weekStartKey, today) >= 3) unlock('triple_threat');

  const oldLevel = getLevel(s.totalXP || 0);
  const newXP = (s.totalXP || 0) + xpGain;
  const newLevel = getLevel(newXP);
  if (newLevel >= 5) unlock('level_5');
  if (newLevel >= 10) unlock('level_10');

  const allRules = s.recurringRules ?? [];
  const todayDay = targetDate.getDay();
  const todayRules = allRules.filter((r: any) => r.daysOfWeek?.includes(todayDay));
  // (allHabitLogs computed above, in the badge section)
  const allDoneToday = todayRules.length > 0 && todayRules.every((r: any) => {
    const rKey = normalize(r.title);
    const rRequired = (r as any).timesPerDay || 1;
    const rCount = allHabitLogs.filter(e => normalize(e.habitTitle) === rKey && e.dateKey === today).length;
    return rCount >= rRequired;
  });
  if (allDoneToday) unlock('all_in');

  let leveledUp = newLevel > oldLevel ? newLevel : null;
  // NEX-220: every badge newly unlocked in THIS transaction (a log can
  // earn several at once — e.g. an existing high-rep user self-healing
  // first_week + iron_will + centurion). Fold them into the pending-toast
  // state via foldPendingBadges so a still-in-flight celebration from a
  // prior log is never clobbered (logHabit runs on every completion).
  const newlyUnlockedList = newBadges.filter(
    (b: Badge) => b.unlockedAt && !(s.badges || []).find((ob: Badge) => ob.id === b.id && ob.unlockedAt)
  );
  const badgePending = foldPendingBadges<Badge>(
    { pendingBadgeUnlock: s.pendingBadgeUnlock, pendingBadgeUnlockQueue: s.pendingBadgeUnlockQueue ?? [] },
    newlyUnlockedList,
  );

  const challengeUpdate: Partial<{ activeChallenge: Challenge | null; totalXP: number; completedChallenges: string[] }> = {};
  if (s.activeChallenge && !s.activeChallenge.completed) {
    const c = { ...s.activeChallenge };
    if (c.type === 'early_log' && !isHistoricalLog && hour < 9) {
      const logs = allHabitLogs.filter(e => e.dateKey === today);
      if (logs.length === 1) c.progress = Math.min(c.progress + 1, c.target);
    } else if (c.type === 'streak_days') {
      const maxStreak = Math.max(...Object.values({ ...s.habitStreaks, [key]: newStreak }).map(v => v as number));
      c.progress = Math.min(maxStreak, c.target);
    } else if (c.type === 'all_habits' && allDoneToday) {
      const lastProgressDate = (c as any).lastProgressDate;
      if (lastProgressDate !== today) {
        c.progress = Math.min(c.progress + 1, c.target);
        (c as any).lastProgressDate = today;
      }
    }
    if (c.progress >= c.target && !c.completed) {
      c.completed = true;
      const challengeXP = newXP + c.xpReward;
      challengeUpdate.totalXP = challengeXP;
      challengeUpdate.completedChallenges = [...(s.completedChallenges || []), c.id];
      const challengeLevel = getLevel(challengeXP);
      if (challengeLevel > newLevel) {
        leveledUp = challengeLevel;
      }
    }
    challengeUpdate.activeChallenge = c;
  }

  return {
    habitLog: allHabitLogs,
    habitStreaks: { ...s.habitStreaks, [key]: newStreak },
    // Backfill guard: never overwrite a newer anchor with an older date.
    habitStreakUpdatedDate: { ...s.habitStreakUpdatedDate, [key]: isBackfill ? lastUpdated : today },
    totalXP: challengeUpdate.totalXP ?? newXP,
    badges: newBadges,
    pendingLevelUp: leveledUp,
    pendingBadgeUnlock: badgePending.pendingBadgeUnlock,
    pendingBadgeUnlockQueue: badgePending.pendingBadgeUnlockQueue,
    ...(challengeUpdate.activeChallenge !== undefined ? { activeChallenge: challengeUpdate.activeChallenge } : {}),
    ...(challengeUpdate.completedChallenges ? { completedChallenges: challengeUpdate.completedChallenges } : {}),
  };
}

export const useAppState = create<AppState>()(
  persist(
    (set, get) => ({
      localUserId: null,
      isActivated: false,
      activatedDate: null,
      firstHabitCompletedAt: null,
      firstActionIntent: null,
      userProfile: null,
      modeLabels: { ALL: 'ALL', SALES: 'SALES', VISION: 'VISION', FAMILY: 'FAMILY' },
      inbox: [],
      justCaptured: null, // NEX-196: ephemeral, never persisted
      leadTimeActions: [],
      pillars: [],
      orbitDays: {},
      habits: [],
      habitStrength: {},
      currentMode: 'ALL',
      capacity: 'PEAK',

      recurringRules: [],
      recurringToDos: [],
      dailyTasks: {},
      habitLog: [],
      goalHabitMap: {},
      nextWeekRuleOverrides: {},
      pendingMondayIntention: null,
      morningIntention: null,
      morningIntentionDate: null,
      morningIntentionCompletedDate: null,
      weeklyReflection: null,
      weeklyReflectionDate: null,
      nightlyForward: null,
      nightlyForwardDate: null,
      dailyScores: {},
      habitStreaks: {},
      habitStreakUpdatedDate: {},
      milestonesShown: {},
      weeklyWins: [],
      weeklyWinsDate: null,
      horizonReviews: [],
      lastReviewDates: {},
      dailyWisdomQuotes: [],
      dailyWisdomDate: '',
      dailyWisdomIntention: null,
      wisdomQuoteCount: 3,
      recentWisdomHistory: [],
      pinnedHabits: [],
      hasSeenTutorial: false,
      firstMandateCommittedFired: false,
      firstAlignmentScoreSeenFired: false,
      strengthenBannerDismissed: false,
      totalXP: 0,
      badges: BADGE_DEFINITIONS.map(b => ({ ...b, unlockedAt: null })),
      streakFreezes: 1,
      lastFreezeDate: null,
      lastOpenDate: null,
      appLaunchHourCounts: [], // NEX-212: device-local launch-hour histogram
      suggestionFeedback: [], // NEX-308: device-local AI-suggestion outcomes
      quotesPool: emptyPool(), // notification-quote pool (device-local)
      coachThread: emptyCoachThread(),
      returningFromLapse: false,
      pauseMode: { ...EMPTY_PAUSE_MODE },
      resumingFromPause: false,
      pendingLevelUp: null,
      pendingBadgeUnlock: null,
      pendingBadgeUnlockQueue: [],
      activeChallenge: null,
      completedChallenges: [],
      scoreHistory: {},
      notificationSettings: {
        morningHour: 8,
        morningMinute: 0,
        eveningHour: 20,
        eveningMinute: 0,
        weeklyDay: 0,
        weeklyHour: 10,
        streakAlerts: true,
        milestoneAlerts: true,
        quietHoursStart: 22 * 60, // NEX-236: 22:00
        quietHoursEnd: 8 * 60,    // NEX-236: 08:00
        smartTiming: true,        // NEX-212: receptivity nudge on by default
        includeQuotes: false,     // notification quotes: opt-in, default off
        personalizedQuotes: true, // NEX-277: kill switch — personalized AI auto-use on by default
      },
      softMode: false,
      breakdownGrain: DEFAULT_GRAIN,
      analyticsConsent: 'unset',
      weeklyEmailEnabled: false,
      weeklyEmailConsent: 'unset',
      weeklyEmailConsentUpdatedAt: null,
      weeklyEmailDay: 0,
      mandateFocus: {},

      // NEX-26: null until the mandates flow runs in phase 3.
      onboardingRecommendations: null,

      // Dev-only onboarding replay flag — never persisted (see partialize).
      devReplayOnboarding: false,

      // NEX-45: refreshed every time home-screen mounts. Empty default
      // is intentional; syncWidgetAfterMutation passes an empty array
      // through to the widget bridge, which is the correct semantic
      // pre-fetch.
      appleEventsWindow: [],

      activateUser: (profile) =>
        set((s) => ({
          isActivated: true,
          userProfile: profile,
          // Set-once: only stamp activatedDate on the very first call. Later
          // callers (e.g. anchor edits routed through activateUser) must not
          // reset the activation timestamp, otherwise first-week nudges restart.
          activatedDate: s.activatedDate ?? new Date().toISOString(),
        })),
      // NEX-164: set-once — stamp only on the very first habit completion so
      // is_first is durable across unlog/relog, day-filtering, and re-renders.
      setFirstHabitCompleted: () =>
        set((s) => (s.firstHabitCompletedAt ? {} : { firstHabitCompletedAt: new Date().toISOString() })),
      setFirstActionIntent: (firstActionIntent) => set({ firstActionIntent }),
      // NEX-85 follow-up: focused setter for phoneNumber so the post-sign-in
      // hydration path can merge the cloud value without blowing away the
      // rest of userProfile (activateUser replaces wholesale).
      setPhoneNumber: (phoneNumber: string | undefined) =>
        set((s) => ({
          userProfile: s.userProfile
            ? { ...s.userProfile, phoneNumber }
            : s.userProfile,
        })),
      setMode: (mode) => set({ currentMode: mode }),
      setCapacity: (capacity) => set({ capacity }),
      updateModeLabel: (key, label) =>
        set((s) => ({
          modeLabels: { ...s.modeLabels, [key]: String(label).toUpperCase() },
        })),

      toggleHabit: (id) =>
        set((s) => {
          const isCompleting = !s.habits.includes(id);
          const currentStr = s.habitStrength[id] || 0;

          return {
            habits: isCompleting
              ? [...s.habits, id]
              : s.habits.filter((h) => h !== id),
            habitStrength: {
              ...s.habitStrength,
              [id]: isCompleting
                ? Math.min(100, currentStr + 10)
                : Math.max(0, currentStr - 5),
            },
          };
        }),

      addPillarManual: (title, context = '', category = 'BUSINESS') => {
        // NEX-124: the zero-mandate cohort (onboarding finished with 0 mandates
        // because Pulse failed) commits its first mandate here. Fire
        // first_mandate_committed only when this is the FIRST pillar AND the
        // set-once guard hasn't fired. Claim synchronously before the async
        // trackEvent. The onboarding path emits its own (source: 'onboarding').
        const prev = get();
        const isFirstMandate = prev.pillars.length === 0 && !prev.firstMandateCommittedFired;
        const id = createId();
        set((s) => ({
          pillars: [
            ...s.pillars,
            {
              id,
              title: String(title).trim(),
              type: 'ACTION',
              context,
              category: category.toUpperCase(),
              identity: 'MODULAR EXECUTION',
            },
          ],
          ...(isFirstMandate ? { firstMandateCommittedFired: true } : {}),
        }));
        if (isFirstMandate) {
          const cat = String(category).trim().toLowerCase();
          const normalized = ALLOWED_MANDATE_CATEGORIES.has(cat) ? cat : 'other';
          void trackEvent('first_mandate_committed', {
            mandate_count: 1,
            categories: normalized,
            source: 'manual',
          });
        }
        return id;
      },

      // NEX-76: also strip the deleted pillar id from every habit's
      // value list in goalHabitMap. Without this, deleting a mandate
      // leaves dead-id ghosts in the map that survive the lifetime of
      // any habit. Same hygiene pattern as deleteRecurringRule's key
      // cleanup. Empty arrays left behind are harmless — every reader
      // already handles `[]` correctly — so we don't bother deleting
      // empty keys here.
      deletePillar: (id) =>
        set((s) => {
          const nextPillars = s.pillars.filter((p) => p.id !== id);
          const map = s.goalHabitMap ?? {};
          let mapChanged = false;
          const nextMap: Record<string, string[]> = {};
          for (const key of Object.keys(map)) {
            const list = map[key] ?? [];
            if (list.includes(id)) {
              mapChanged = true;
              nextMap[key] = list.filter((x) => x !== id);
            } else {
              nextMap[key] = list;
            }
          }
          // NEX-202: a removed mandate must not dangle as a habit's echo anchor.
          // Clear mandateEchoPillarId on any rule pointing at the deleted pillar.
          // (The Home render also stale-guards, so this is belt-and-suspenders that
          // keeps the persisted/synced value from carrying an orphan reference.)
          let rulesChanged = false;
          const nextRules = (Array.isArray(s.recurringRules) ? s.recurringRules : []).map((r) => {
            if (r.mandateEchoPillarId === id) {
              rulesChanged = true;
              return { ...r, mandateEchoPillarId: null };
            }
            return r;
          });
          return {
            pillars: nextPillars,
            ...(mapChanged ? { goalHabitMap: nextMap } : {}),
            ...(rulesChanged ? { recurringRules: nextRules } : {}),
          };
        }),

      updatePillarManual: (id, title) =>
        set((s) => ({
          pillars: s.pillars.map((p) =>
            p.id === id ? { ...p, title: String(title).trim() } : p
          ),
        })),

      updatePillarNotes: (id, notes) =>
        set((s) => ({
          pillars: s.pillars.map((p) =>
            p.id === id ? { ...p, notes: String(notes ?? '') } : p
          ),
        })),

      addInboxTask: (title, options) => {
        const id = createId();
        let resolvedId = id;
        set((s) => {
          const result = prependInboxTaskIdempotently(s.inbox, {
            id,
            title: String(title).trim(),
            completed: false,
            status: options?.status ?? 'NEW',
            createdAt: Date.now(),
            source: options?.source ?? 'manual',
            ...(options?.dueDate ? { dueDate: options.dueDate } : {}),
            ...(options?.proposalKey ? { proposalKey: options.proposalKey } : {}),
          });
          resolvedId = result.id;
          return result.created ? { inbox: result.inbox } : s;
        });
        return resolvedId;
      },

      toggleInboxTask: (id) =>
        set((s) => {
          const prev = s.inbox.find((t) => t.id === id);
          const willComplete = prev ? !prev.completed : false;
          if (willComplete) emitTodoCleared('inbox');
          return { inbox: applyToggleInbox(s.inbox, id, Date.now()) };
        }),

      deleteInboxTask: (id) =>
        set((s) => ({
          inbox: s.inbox.filter((t) => t.id !== id),
        })),

      // NEX-198 (N-1): idempotent resolve for an ambient reminder — used by the
      // Home REMINDERS pin and (PR B) the notification DONE action. Archives the
      // item if (and only if) it isn't already, so a double-DONE / resolve-from-
      // two-places can't un-resolve (unlike toggleInboxTask, which toggles). The
      // reminder reconcile effect then cancels the OS one-shot. Unlike the Inbox
      // screen's handler this fires the Apple write-back best-effort with no
      // Alert/revert (it runs from Home / a notification action, not a screen).
      resolveInboxTask: (id) => {
        const task = get().inbox.find((t) => t.id === id);
        if (!task || task.status === 'ARCHIVED') return;
        const isApple = task.source === 'apple_reminders';
        set((s) => ({
          inbox: s.inbox.map((t) =>
            t.id === id
              ? { ...t, status: 'ARCHIVED', ...(isApple ? { completed: true } : {}) }
              : t,
          ),
        }));
        if (isApple && task.externalId) {
          import('../services/apple-reminders')
            .then((m) => m.markReminderComplete(task.externalId as string, true))
            .catch(() => {});
        }
      },

      // NEX-259 (N-2): opt-in "keep nudging" toggle. Idempotent — no-op if the
      // item is gone or already at `on` (avoids a redundant inbox ref change /
      // reconcile). Mutating inbox re-fires the [inbox]-keyed reconcile effect,
      // which (re)schedules or cancels the nudge family.
      setInboxKeepNudging: (id, on) => {
        const task = get().inbox.find((t) => t.id === id);
        if (!task || !!task.keepNudging === !!on) return;
        set((s) => ({
          inbox: s.inbox.map((t) => (t.id === id ? { ...t, keepNudging: !!on } : t)),
        }));
      },

      // NEX-196: ephemeral Home-echo ref. setJustCaptured overwrites (next
      // capture wins); clearJustCaptured on tap-through / undo / Home blur.
      setJustCaptured: (c) => set(() => ({ justCaptured: { ...c, at: Date.now() } })),
      clearJustCaptured: () => set(() => ({ justCaptured: null })),

      // ── Lead-Time Radar (NEX-162) ───────────────────────────────────
      addLeadTimeAction: (input) => {
        const id = createId();
        const eventDate = projectEventKey(input.eventDate);
        const leadDays = Number.isFinite(input.leadDays) ? Math.max(0, Math.round(input.leadDays)) : 0;
        const actByDate = input.actByDate ? projectEventKey(input.actByDate) : computeActByDate(eventDate, leadDays);
        set((s) => ({
          leadTimeActions: [
            {
              id,
              title: String(input.title).trim(),
              eventTitle: String(input.eventTitle ?? '').trim(),
              eventDate,
              eventId: input.eventId ?? null,
              actByDate,
              leadDays,
              completed: false,
              createdAt: Date.now(),
              source: 'manual' as const,
            },
            ...s.leadTimeActions,
          ],
        }));
        return id;
      },

      updateLeadTimeAction: (id, patch) =>
        set((s) => ({
          leadTimeActions: s.leadTimeActions.map((a) => {
            if (a.id !== id) return a;
            const next: LeadTimeAction = { ...a };
            if (typeof patch.title === 'string') next.title = patch.title.trim();
            if (typeof patch.eventTitle === 'string') next.eventTitle = patch.eventTitle.trim();
            if (typeof patch.eventDate === 'string') next.eventDate = projectEventKey(patch.eventDate);
            if (typeof patch.leadDays === 'number' && Number.isFinite(patch.leadDays)) {
              next.leadDays = Math.max(0, Math.round(patch.leadDays));
            }
            if ('eventId' in patch) next.eventId = patch.eventId ?? null;
            // Recompute actByDate when its inputs change, unless explicitly set.
            if (typeof patch.actByDate === 'string') next.actByDate = projectEventKey(patch.actByDate);
            else if (typeof patch.eventDate === 'string' || typeof patch.leadDays === 'number') {
              next.actByDate = computeActByDate(next.eventDate, next.leadDays);
            }
            return next;
          }),
        })),

      // completedAt stamps once on false→true, never cleared (InboxTask precedent
      // via the shared applyToggleInbox helper — LeadTimeAction is TaskLike).
      toggleLeadTimeAction: (id) =>
        set((s) => ({ leadTimeActions: applyToggleInbox(s.leadTimeActions, id, Date.now()) })),

      deleteLeadTimeAction: (id) =>
        set((s) => ({ leadTimeActions: s.leadTimeActions.filter((a) => a.id !== id) })),

      updateInboxTask: (id, patchOrTitle) =>
        set((s) => {
          // Two call shapes: legacy string (title) and patch object.
          // Manual edit flow still passes a string; the voice-mirror
          // flow passes { source, externalId } once the EventKit
          // write returns. Empty-string title is rejected (matches
          // pre-Phase-4 behavior); empty patch is a no-op.
          let patch: Record<string, any>;
          if (typeof patchOrTitle === 'string') {
            const trimmed = patchOrTitle.trim();
            if (!trimmed) return s;
            patch = { title: trimmed };
          } else {
            patch = { ...patchOrTitle };
            if (typeof patch.title === 'string') {
              const trimmed = patch.title.trim();
              if (!trimmed) delete patch.title;
              else patch.title = trimmed;
            }
            if (Object.keys(patch).length === 0) return s;
          }
          return {
            inbox: s.inbox.map((t) => (t.id === id ? { ...t, ...patch } : t)),
          };
        }),

      setInboxOrder: (tasks) => set(() => ({ inbox: tasks })),

      upsertRemindersFromApple: (records) => {
        let tally = { added: 0, updated: 0, skipped: 0 };
        set((s) => {
          const result = upsertRemindersIntoInbox(s.inbox, records, createId, Date.now());
          tally = { added: result.added, updated: result.updated, skipped: result.skipped };
          return { inbox: result.inbox };
        });
        return tally;
      },

      reconcileExternalState: (buckets) =>
        set((s) => ({
          // NEX-26 phase F.5 ext: pass Date.now() so external-completion
          // flips stamp completedAt for the activation tracker.
          inbox: reconcileInboxAgainstExternal(s.inbox, buckets, Date.now()),
        })),

      archiveAllAppleReminders: () =>
        set((s) => ({
          inbox: s.inbox.map((t) =>
            t.source === 'apple_reminders' && t.status !== 'ARCHIVED'
              ? { ...t, status: 'ARCHIVED' }
              : t,
          ),
        })),

      addOrbitEvent: (title, timeStr, calType = 'ROUTINE') =>
        set((s) => {
          const dateKey = getLocalDateKey(new Date());
          const startTime = parseLooseTimeTo24h(timeStr);
          const [hh, mm] = startTime.split(':').map(Number);

          const start = new Date();
          start.setHours(hh, mm, 0, 0);

          const end = new Date(start.getTime() + 60 * 60 * 1000);

          const event: OrbitEvent = {
            id: createId(),
            title: String(title).trim(),
            startISO: start.toISOString(),
            endISO: end.toISOString(),
            timeLabel: formatTimeLabel(start.toISOString(), end.toISOString()),
            source: 'manual',
            eventType: 'appointment',
            cal: calType,
          };

          const nextDay = [...(s.orbitDays[dateKey] ?? []), event].sort(
            (a, b) =>
              new Date(a.startISO).getTime() - new Date(b.startISO).getTime()
          );

          return {
            orbitDays: {
              ...s.orbitDays,
              [dateKey]: nextDay,
            },
          };
        }),

      addManualOrbitEvent: (input) =>
        set((s) => {
          const dateKey = isDateKey(input.dateKey)
            ? input.dateKey
            : getLocalDateKey(new Date());

          const startTime = isTime(input.startTime) ? input.startTime : '09:00';
          const endTime = isTime(input.endTime) ? input.endTime : '10:00';

          const startISO = combineLocalDateAndTimeToISO(dateKey, startTime);
          const endISO = combineLocalDateAndTimeToISO(dateKey, endTime);

          const event: OrbitEvent = {
            id: createId(),
            title: String(input.title).trim(),
            startISO,
            endISO,
            timeLabel: formatTimeLabel(startISO, endISO),
            source: 'manual',
            eventType: input.eventType ?? 'appointment',
            notes: input.notes?.trim() || undefined,
            cal: input.cal ?? 'ROUTINE',
            // NEX-205: energy only meaningful on time_blocks; ignore on appointments.
            energy: input.eventType === 'time_block' ? input.energy : undefined,
          };

          const nextDay = [...(s.orbitDays[dateKey] ?? []), event].sort(
            (a, b) =>
              new Date(a.startISO).getTime() - new Date(b.startISO).getTime()
          );

          return {
            orbitDays: {
              ...s.orbitDays,
              [dateKey]: nextDay,
            },
          };
        }),

      updateEvent: (id, newTitle) =>
        set((s) => {
          const orbitDays: Record<string, OrbitEvent[]> = {};

          Object.keys(s.orbitDays).forEach((dayKey) => {
            orbitDays[dayKey] = (s.orbitDays[dayKey] ?? []).map((ev) =>
              ev.id === id ? { ...ev, title: String(newTitle).trim() } : ev
            );
          });

          return { orbitDays };
        }),

      deleteEvent: (id) =>
        set((s) => {
          const orbitDays: Record<string, OrbitEvent[]> = {};

          Object.keys(s.orbitDays).forEach((dayKey) => {
            orbitDays[dayKey] = (s.orbitDays[dayKey] ?? []).filter(
              (ev) => ev.id !== id
            );
          });

          return { orbitDays };
        }),

      // NEX-205 (PR2b): apply a new window to a native time-block (move + undo).
      // Spread preserves energy/notes/cal; timeLabel is re-derived; the day is
      // re-sorted by start. No-op if the id isn't found.
      setOrbitEventTime: (id, startISO, endISO) =>
        set((s) => {
          const orbitDays: Record<string, OrbitEvent[]> = {};
          Object.keys(s.orbitDays).forEach((dayKey) => {
            const day = s.orbitDays[dayKey] ?? [];
            let mutated = false;
            const touched = day.map((ev) => {
              if (ev.id !== id) return ev;
              mutated = true;
              return { ...ev, startISO, endISO, timeLabel: formatTimeLabel(startISO, endISO) };
            });
            // Only the day that actually held the event needs re-sorting; leave
            // every other day's array untouched (no work, stable reference).
            orbitDays[dayKey] = mutated
              ? touched.sort((a, b) => new Date(a.startISO).getTime() - new Date(b.startISO).getTime())
              : day;
          });
          return { orbitDays };
        }),

      addRecurringRule: (
        title: string,
        daysOfWeek: number[],
        time: string | null = null,
        preferredTimeBlock: TimeBlock | null = null,
        cal: string = 'ROUTINE',
        appleEventId: string | null = null,
        timesPerDay: number | null = null,
        firstStep: string | null = null
      ): string => {
        const trimmedFirstStep = typeof firstStep === 'string' && firstStep.trim() ? firstStep.trim() : null;
        const newId = createId();
        const sanitizedTimesPerDay =
          typeof timesPerDay === 'number' && Number.isFinite(timesPerDay) && timesPerDay >= 1
            ? Math.min(12, Math.round(timesPerDay))
            : undefined;
        set((s) => {
          const recurringRules = [
            {
              id: newId,
              title: String(title).trim(),
              daysOfWeek: normalizeDaysOfWeek(daysOfWeek),
              time: (time && isTime(time) ? time : null) as string | null,
              preferredTimeBlock: preferredTimeBlock ?? null,
              cal,
              appleEventId: appleEventId ?? null,
              createdAt: Date.now(),
              anchor: null,
              ...(trimmedFirstStep ? { firstStep: trimmedFirstStep } : {}),
              ...(sanitizedTimesPerDay !== undefined ? { timesPerDay: sanitizedTimesPerDay } : {}),
            },
            ...s.recurringRules,
          ];
          // NEX-171: keep derived pinnedHabits fresh (new habit counts by default).
          return { recurringRules, pinnedHabits: deriveActiveHabitIds(recurringRules) };
        });
        return newId;
      },

      linkRecurringRuleToAppleEvent: (ruleId, appleEventId) =>
        set((s) => ({
          recurringRules: s.recurringRules.map((r) =>
            r.id === ruleId ? { ...r, appleEventId } : r
          ),
        })),

      unlinkRecurringRuleFromAppleEvent: (ruleId) =>
        set((s) => ({
          recurringRules: s.recurringRules.map((r) =>
            r.id === ruleId ? { ...r, appleEventId: null } : r
          ),
        })),

      updateRecurringRuleFromApple: (ruleId, updates) =>
        set((s) => ({
          recurringRules: s.recurringRules.map((r) =>
            r.id === ruleId ? { ...r, ...updates } : r
          ),
        })),

      // NEX-76: also strip the deleted rule's normalize(title) key from
      // goalHabitMap. Without this the map accumulates orphan entries
      // that inflate mandate "tied to N habits" counts and other
      // downstream lookups that traverse goalHabitMap directly.
      deleteRecurringRule: (ruleId) =>
        set((s) => {
          const rule = s.recurringRules.find((r) => r.id === ruleId);
          const nextRules = s.recurringRules.filter((r) => r.id !== ruleId);
          // NEX-171: re-derive pinnedHabits so the deleted id never lingers.
          const pinnedHabits = deriveActiveHabitIds(nextRules);
          if (!rule?.title) return { recurringRules: nextRules, pinnedHabits };
          const key = normalize(rule.title);
          if (!(key in (s.goalHabitMap ?? {}))) return { recurringRules: nextRules, pinnedHabits };
          const nextMap = { ...s.goalHabitMap };
          delete nextMap[key];
          return { recurringRules: nextRules, pinnedHabits, goalHabitMap: nextMap };
        }),

      // NEX-76: migrate goalHabitMap[normalize(oldTitle)] over to
      // normalize(newTitle) atomically. Before this, a rename orphaned
      // the old key (still holding pillar memberships for a title no
      // rule has) and left the new title with no map entry → habit
      // dropped from LINKED HABITS lists but still counted in stale
      // count surfaces.
      // NEX-54: both rename and the richer edit route through the shared
      // pure applyRuleEdit (src/state/rule-edit.ts) so the load-bearing
      // habit-log / goalHabitMap / streak-map re-key happens identically and
      // atomically. renameRecurringRule is now a title-only patch.
      renameRecurringRule: (ruleId, newTitle) =>
        set((s) => applyRuleEdit(s, ruleId, { title: newTitle })),

      updateRecurringRule: (ruleId, patch) =>
        set((s) => applyRuleEdit(s, ruleId, patch)),

      addRecurringToDo: (title, daysOfWeek, interval = 1) => {
        // NEX-195: compute the id up front so we can return it for the
        // capture confirmation's undo/jump.
        const id = createId();
        set((s) => ({
          recurringToDos: [
            {
              id,
              title: String(title).trim(),
              daysOfWeek: normalizeDaysOfWeek(daysOfWeek),
              interval: interval > 1 ? interval : 1,
              intervalAnchorDate: getLocalDateKey(new Date()),
              exceptions: [],
            },
            ...s.recurringToDos,
          ],
        }));
        return id;
      },

      updateRecurringToDo: (id, updates) =>
        set((s) => ({
          recurringToDos: s.recurringToDos.map((r) =>
            r.id === id ? { ...r, ...updates } : r
          ),
        })),

      deleteRecurringToDo: (id) =>
        set((s) => ({
          recurringToDos: s.recurringToDos.filter((r) => r.id !== id),
        })),

      addRecurringToDoException: (id, dateKey) =>
        set((s) => ({
          recurringToDos: s.recurringToDos.map((r) => {
            if (r.id !== id) return r;
            const existing = Array.isArray(r.exceptions) ? r.exceptions : [];
            if (existing.includes(dateKey)) return r;
            return { ...r, exceptions: [...existing, dateKey] };
          }),
        })),

      // NEX-309: atomic one-day move. The planner decides (and can refuse); this
      // applies its result in ONE set so the exception, the detached task and
      // the -auto cleanup can never land partially. Reads live state inside the
      // updater rather than closing over a snapshot.
      moveRecurringOccurrence: (ruleId, fromDateKey, toDateKey) => {
        const s = get();
        const plan = planMoveOccurrence(
          {
            recurringToDos: s.recurringToDos,
            dailyTasks: s.dailyTasks,
            ruleId,
            fromDateKey,
            toDateKey,
          },
          createId,
        );
        if (!plan.ok) return plan;
        set({
          recurringToDos: plan.recurringToDos as any,
          dailyTasks: plan.dailyTasks as any,
        });
        return { ok: true, detachedId: plan.detachedId };
      },

      undoMoveRecurringOccurrence: (ruleId, fromDateKey, toDateKey, detachedId) =>
        set((s) => {
          const next = planUndoMoveOccurrence({
            recurringToDos: s.recurringToDos,
            dailyTasks: s.dailyTasks,
            ruleId,
            fromDateKey,
            toDateKey,
            detachedId,
          });
          return {
            recurringToDos: next.recurringToDos as any,
            dailyTasks: next.dailyTasks as any,
          };
        }),

      addRecurringToDoForPillar: (title, daysOfWeek, pillarId) =>
        set((s) => ({
          recurringToDos: [
            {
              id: createId(),
              title: String(title).trim(),
              daysOfWeek: normalizeDaysOfWeek(daysOfWeek),
              interval: 1,
              intervalAnchorDate: getLocalDateKey(new Date()),
              exceptions: [],
              pillarId: String(pillarId),
            },
            ...s.recurringToDos,
          ],
        })),

      addDailyTask: (arg1, arg2) =>
        set((s) => {
          let dateKey = getLocalDateKey(new Date());
          let title = '';

          if (typeof arg2 === 'undefined') {
            title = String(arg1).trim();
          } else if (isDateKey(arg1)) {
            dateKey = arg1;
            title = String(arg2).trim();
          } else if (isDateKey(arg2)) {
            dateKey = arg2;
            title = String(arg1).trim();
          } else {
            title = String(arg2).trim() || String(arg1).trim();
          }

          const nextTask: DailyTask = {
            id: createId(),
            title,
            completed: false,
          };

          return {
            dailyTasks: {
              ...s.dailyTasks,
              [dateKey]: [nextTask, ...(s.dailyTasks[dateKey] ?? [])],
            },
          };
        }),

      addDailyTaskForPillar: (title, dateKey, pillarId) =>
        set((s) => {
          const trimmed = String(title ?? '').trim();
          if (!trimmed) return s;
          const key = isDateKey(dateKey) ? dateKey : getLocalDateKey(new Date());
          const nextTask: DailyTask = {
            id: createId(),
            title: trimmed,
            completed: false,
            pillarId: String(pillarId),
          };
          return {
            dailyTasks: {
              ...s.dailyTasks,
              [key]: [nextTask, ...(s.dailyTasks[key] ?? [])],
            },
          };
        }),

      toggleDailyTask: (dateKey, id) =>
        set((s) => {
          const existing = (s.dailyTasks[dateKey] ?? []).find((t) => t.id === id);
          const willComplete = existing ? !existing.completed : false;
          if (willComplete) emitTodoCleared('daily_task');
          return {
            dailyTasks: {
              ...s.dailyTasks,
              [dateKey]: (s.dailyTasks[dateKey] ?? []).map((task) =>
                task.id === id
                  ? {
                      ...task,
                      completed: !task.completed,
                      completedAt:
                        !task.completed && task.completedAt == null
                          ? Date.now()
                          : task.completedAt,
                    }
                  : task
              ),
            },
          };
        }),

      reorderDailyTask: (dateKey, id, direction) =>
        set((s) => {
          const tasks = [...(s.dailyTasks[dateKey] ?? [])];
          const idx = tasks.findIndex(t => t.id === id);
          if (idx === -1) return {};
          const newIdx = direction === 'up' ? idx - 1 : idx + 1;
          if (newIdx < 0 || newIdx >= tasks.length) return {};
          const copy = [...tasks];
          [copy[idx], copy[newIdx]] = [copy[newIdx], copy[idx]];
          return { dailyTasks: { ...s.dailyTasks, [dateKey]: copy } };
        }),

      setDailyTasksOrder: (dateKey, tasks) =>
        set((s) => ({ dailyTasks: { ...s.dailyTasks, [dateKey]: tasks } })),

      deleteDailyTask: (dateKey, id) =>
        set((s) => ({
          dailyTasks: {
            ...s.dailyTasks,
            [dateKey]: (s.dailyTasks[dateKey] ?? []).filter(
              (task) => task.id !== id
            ),
          },
        })),

      logHabit: (habitTitle) => {
        const now = new Date();
        set((s) => buildHabitLogPatch(s, habitTitle, getLocalDateKey(now), now));
      },

      // docs/plans/connector-actions.md: date-aware logHabit for the connector
      // drain, with per-call outcome reporting. Same reducer as a user tap, but
      // refuses titles with no matching recurring rule — a chat-queued habit the
      // app does not know must surface as failed, not log an orphaned entry.
      logHabitForDate: (habitTitle, dateKey) => {
        if (!isDateKey(dateKey)) return 'invalid_date_key';
        const key = normalize(habitTitle);
        const matchingRule = (get().recurringRules ?? []).find(
          (r: any) => normalize(r.title) === key
        );
        if (!matchingRule) return 'unknown_habit';
        const required = (matchingRule as any)?.timesPerDay || 1;
        const dateCount = get().habitLog.filter(
          (e) => normalize(e.habitTitle) === key && e.dateKey === dateKey
        ).length;
        if (dateCount >= required) return 'already_at_times_per_day';
        const now = new Date();
        set((s) => buildHabitLogPatch(s, habitTitle, dateKey, now));
        return 'applied';
      },

      unlogHabit: (habitTitle) => {
        set((s) => {
          const key = normalize(habitTitle);
          const today = getLocalDateKey(new Date());
          const todayEntries = s.habitLog.filter(
            (e) => normalize(e.habitTitle) === key && e.dateKey === today
          );
          if (todayEntries.length === 0) return s;
          const lastEntry = todayEntries[todayEntries.length - 1];
          const isRemovingLastForToday = todayEntries.length <= 1;
          // NEX-190: flat XP, symmetric with logHabit (no streak-bonus to reverse).
          const xpLoss = XP_HABIT_COMPLETE;
          return {
            habitLog: s.habitLog.filter((e) => e.id !== lastEntry.id),
            habitStreaks: isRemovingLastForToday ? {
              ...s.habitStreaks,
              [key]: Math.max(0, (s.habitStreaks[key] ?? 1) - 1),
            } : s.habitStreaks,
            totalXP: Math.max(0, (s.totalXP || 0) - xpLoss),
          };
        });
      },

      linkHabitToGoal: (habitTitle, pillarId) =>
        set((s) => {
          const key = normalize(habitTitle);
          const current = s.goalHabitMap[key] ?? [];
          if (current.includes(pillarId)) return s;
          return {
            goalHabitMap: { ...s.goalHabitMap, [key]: [...current, pillarId] },
          };
        }),

      unlinkHabitFromGoal: (habitTitle, pillarId) =>
        set((s) => {
          const key = normalize(habitTitle);
          const current = s.goalHabitMap[key] ?? [];
          return {
            goalHabitMap: {
              ...s.goalHabitMap,
              [key]: current.filter((id) => id !== pillarId),
            },
          };
        }),

      getGoalStats: (pillarId, windowDays) => {
        const s = get();
        const todayKey = new Date().toISOString().slice(0, 10);
        const cacheKey = `${pillarId}:${windowDays}:${todayKey}`;
        let cacheForLog = goalStatsCacheByHabitLog.get(s.habitLog);
        if (!cacheForLog) {
          cacheForLog = new Map<string, GoalStats>();
          goalStatsCacheByHabitLog.set(s.habitLog, cacheForLog);
        }
        const cached = cacheForLog.get(cacheKey);
        if (cached) {
          return cached;
        }
        const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
        const relevantEntries = s.habitLog.filter(
          (e) => e.goalIds.includes(pillarId) && e.timestamp >= cutoff
        );
        // Count unique days completed
        const uniqueDays = new Set(relevantEntries.map((e) => e.dateKey)).size;
        const value = { completed: uniqueDays, total: windowDays };
        cacheForLog.set(cacheKey, value);
        return value;
      },

      setWeeklyWins: (wins) => {
        const today = getLocalDateKey(new Date());
        set({ weeklyWins: wins, weeklyWinsDate: today });
      },

      // docs/plans/connector-actions.md: read-modify-write append for the
      // connector drain — never a raw setWeeklyWins replace, which would
      // clobber wins the user already entered. weeklyWins is week-scoped (Home
      // only renders it when weeklyWinsDate matches this week's Sunday key,
      // see getThisSundayKey in home-screen), so stamp the Sunday key rather
      // than today and start a fresh list when the stamped week has rolled.
      appendWeeklyWin: (title) => {
        const trimmed = String(title ?? '').trim();
        if (!trimmed) return;
        const sunday = new Date();
        sunday.setDate(sunday.getDate() - sunday.getDay());
        const sundayKey = getLocalDateKey(sunday);
        set((s) => ({
          weeklyWins: [
            ...(s.weeklyWinsDate === sundayKey ? (s.weeklyWins ?? []) : []),
            trimmed,
          ],
          weeklyWinsDate: sundayKey,
        }));
      },

      addHorizonReview: (review) =>
        set((s) => ({ horizonReviews: [review, ...(s.horizonReviews || [])] })),

      updateHorizonReview: (id, patch) =>
        set((s) => ({
          horizonReviews: (s.horizonReviews || []).map((r) =>
            r.id === id ? { ...r, ...patch } : r,
          ),
        })),

      deleteHorizonReview: (id) =>
        set((s) => ({
          horizonReviews: (s.horizonReviews || []).filter((r) => r.id !== id),
        })),

      setLastReviewDate: (cadence, dateKey) =>
        set((s) => ({ lastReviewDates: { ...(s.lastReviewDates || {}), [cadence]: dateKey } })),

      setNextWeekRuleOverride: (sundayDateKey, override) =>
        set((s) => {
          const map = s.nextWeekRuleOverrides ?? {};
          const existing = Array.isArray(map[sundayDateKey]) ? map[sundayDateKey] : [];
          // Replace any prior override for the same rule on the same day.
          const filtered = existing.filter((o) => o.ruleId !== override.ruleId);
          return {
            nextWeekRuleOverrides: {
              ...map,
              [sundayDateKey]: [...filtered, override],
            },
          };
        }),

      clearNextWeekRuleOverrides: (sundayDateKey) =>
        set((s) => {
          const map = { ...(s.nextWeekRuleOverrides ?? {}) };
          delete map[sundayDateKey];
          return { nextWeekRuleOverrides: map };
        }),

      removeNextWeekRuleOverride: (sundayDateKey, ruleId) =>
        set((s) => {
          const map = s.nextWeekRuleOverrides ?? {};
          const existing = Array.isArray(map[sundayDateKey]) ? map[sundayDateKey] : [];
          const filtered = existing.filter((o) => o.ruleId !== ruleId);
          if (filtered.length === existing.length) return s;
          if (filtered.length === 0) {
            const next = { ...map };
            delete next[sundayDateKey];
            return { nextWeekRuleOverrides: next };
          }
          return { nextWeekRuleOverrides: { ...map, [sundayDateKey]: filtered } };
        }),

      applyPendingRuleOverrides: () => {
        // Drain any override keyed within the prior 7 days (excluding today,
        // so a Sunday-applied override doesn't take effect until Monday). The
        // 7-day window catches users who skip Monday and open the app later.
        // Anything older than the cutoff is pruned without applying — too
        // stale to retroactively change last-month's habits.
        const today = getLocalDateKey(new Date());
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        const cutoffKey = getLocalDateKey(cutoff);

        set((s) => {
          const map = s.nextWeekRuleOverrides ?? {};
          const entries = Object.entries(map);
          const draining = entries
            .filter(([key]) => key >= cutoffKey && key < today)
            .sort(([a], [b]) => a.localeCompare(b)); // older overrides first; later ones win on conflict
          const stale = entries.filter(([key]) => key < cutoffKey);

          if (draining.length === 0 && stale.length === 0) return s;

          // Build a per-rule "winning" override (last-wins by date key).
          const winners = new Map<string, NextWeekRuleOverride>();
          draining.forEach(([, list]) => {
            (list || []).forEach((o) => winners.set(o.ruleId, o));
          });

          const updatedRules = winners.size > 0
            ? (s.recurringRules || []).map((rule) => {
                const o = winners.get(rule.id);
                if (!o) return rule;
                return {
                  ...rule,
                  daysOfWeek: Array.isArray(o.after.daysOfWeek) ? o.after.daysOfWeek : rule.daysOfWeek,
                  timesPerDay: typeof o.after.timesPerDay === 'number' ? o.after.timesPerDay : rule.timesPerDay,
                };
              })
            : s.recurringRules;

          const remaining = { ...map };
          draining.forEach(([key]) => { delete remaining[key]; });
          stale.forEach(([key]) => { delete remaining[key]; });

          return {
            recurringRules: updatedRules,
            nextWeekRuleOverrides: remaining,
          };
        });
      },

      setPendingMondayIntention: (text, targetDateKey) =>
        set({
          pendingMondayIntention: {
            text: String(text || '').trim(),
            targetDateKey,
            createdAt: Date.now(),
          },
        }),

      consumePendingMondayIntention: () => {
        const s = get();
        const pending = s.pendingMondayIntention;
        if (!pending) return;
        const today = getLocalDateKey(new Date());
        // TTL gate: only consume on the target Monday itself.
        if (pending.targetDateKey !== today) {
          set({ pendingMondayIntention: null });
          return;
        }
        set({
          morningIntention: pending.text,
          morningIntentionDate: today,
          pendingMondayIntention: null,
        });
      },

      clearPendingMondayIntention: () => set({ pendingMondayIntention: null }),

      setDailyWisdom: (quotes, dateKey, intention) => {
        set({ dailyWisdomQuotes: quotes, dailyWisdomDate: dateKey, dailyWisdomIntention: intention });
      },

      appendWisdomHistory: (quotes, dateKey) =>
        set((s) => {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - 30);
          const cutoffKey = getLocalDateKey(cutoff);
          const newEntries = (Array.isArray(quotes) ? quotes : [])
            .filter((q) => q && typeof q.quote === 'string' && typeof q.author === 'string')
            .map((q) => ({ quote: q.quote, author: q.author, dateKey }));
          const merged = [...(s.recentWisdomHistory ?? []), ...newEntries];
          const trimmed = merged.filter(
            (e) => typeof e.dateKey === 'string' && e.dateKey >= cutoffKey
          );
          return { recentWisdomHistory: trimmed };
        }),
      setWisdomQuoteCount: (count) =>
        set({ wisdomQuoteCount: count, dailyWisdomQuotes: [], dailyWisdomIntention: null }),

      setPinnedHabits: (habits) => {
        set({ pinnedHabits: habits });
      },

      // NEX-171: toggle a habit's score inclusion; keep the derived pinnedHabits
      // (= non-excluded ids) in sync for the widget/watch/cloud contract.
      setHabitExcludedFromScore: (ruleId, value) =>
        set((s) => {
          const recurringRules = s.recurringRules.map((r) =>
            r.id === ruleId ? { ...r, excludedFromScore: value } : r,
          );
          return { recurringRules, pinnedHabits: deriveActiveHabitIds(recurringRules) };
        }),

      setHasSeenTutorial: (seen) => set({ hasSeenTutorial: seen }),

      // NEX-124: claim the funnel set-once guards synchronously.
      markFirstMandateCommitted: () => set({ firstMandateCommittedFired: true }),
      markFirstAlignmentScoreSeen: () => set({ firstAlignmentScoreSeenFired: true }),

      setStrengthenBannerDismissed: (dismissed) =>
        set({ strengthenBannerDismissed: dismissed }),

      setNotificationSettings: (settings) =>
        set((s) => ({
          notificationSettings: { ...s.notificationSettings, ...settings },
        })),
      setQuotesPool: (pool) => set({ quotesPool: pool }),
      // NEX-277: remove a scheduled AI line — tombstones it (so the next generation
      // cycle can't re-add it) and drops it from both schedulable arrays.
      removeNotificationQuote: (quote) =>
        set((s) => ({ quotesPool: removeQuote(s.quotesPool, [quote]) })),
      // NEX-277: when the mandate context changes, evict AI lines generated from the
      // old context so stale personalized lines stop firing (no-op if hash unchanged).
      syncMandateContext: (hash) =>
        set((s) => ({ quotesPool: evictForMandateChange(s.quotesPool, hash) })),
      // Advance the no-repeat `shown` map on the CURRENT pool (only `shown` is
      // touched, so a concurrent generation write to pending/lastGenAtMs survives).
      recordQuotesShown: (quotes, dayIndex) =>
        set((s) => {
          let pool = s.quotesPool;
          for (const q of quotes) pool = markShown(pool, q, dayIndex);
          return { quotesPool: pool };
        }),
      // Fold a generation result into the CURRENT pool: add only genuinely-new
      // lines (addCandidates dedupes vs current live/pending/seed/removed) and
      // advance lastGenAtMs — preserving `shown`/`removed`/`mandateHash` a
      // concurrent write set.
      mergeGeneratedQuotes: (generated) =>
        set((s) => {
          const merged = addCandidates(s.quotesPool, generated.pending, [...NOTIFICATION_PROMPTS]);
          return { quotesPool: { ...merged, lastGenAtMs: Math.max(s.quotesPool.lastGenAtMs, generated.lastGenAtMs) } };
        }),

      // NEX-308: append AI-suggestion outcomes to the device-local log. Applied
      // as a delta against the CURRENT array inside `set` (never a snapshot
      // replace) so two writes racing on one screen can't clobber each other —
      // the pattern LEARNINGS 2026-06-24 makes mandatory for this store. The
      // pure reducer sanitizes and caps; a malformed entry is dropped rather
      // than thrown, because this rides a UI tap path where bookkeeping must
      // never break the user's actual action.
      recordSuggestionFeedback: (entries) =>
        set((s) => ({
          suggestionFeedback: recordSuggestionOutcomes(s.suggestionFeedback, entries),
        })),

      setSoftMode: (on) => set({ softMode: !!on }),

      // NEX-210: remember the user's picked breakdown grain.
      setBreakdownGrain: (grain) => set({ breakdownGrain: normalizeGrain(grain) }),
      setCoachThread: (next) =>
        set((state) => ({
          coachThread: sanitizeCoachThread(typeof next === 'function' ? next(state.coachThread) : next),
        })),

      // NEX-210 / NEX-285: land broken-down steps as inbox one-offs (the original
      // capture is left as-is). Returns the created ids so the ledger offer can
      // undo by deleting exactly them. Newest-first like addInboxTask.
      // NEX-285: all steps of one breakdown share a `breakdownGroupId` and carry
      // the original `goalTitle` + a 0-based `stepIndex` so the Inbox can render
      // them as a single stacked card. The goal is a header label, not a task.
      addBrokenDownSteps: (steps, goalTitle) => {
        const clean = (Array.isArray(steps) ? steps : [])
          .map((s) => String(s ?? '').trim())
          .filter(Boolean);
        if (clean.length === 0) return [];
        const breakdownGroupId = createId();
        const goal = String(goalTitle ?? '').trim() || undefined;
        const created = clean.map((title, i) => ({
          id: createId(),
          title,
          completed: false,
          status: 'NEW',
          createdAt: Date.now(),
          source: 'manual' as const,
          breakdownGroupId,
          goalTitle: goal,
          stepIndex: i,
        }));
        set((s) => ({ inbox: [...created, ...s.inbox] }));
        return created.map((t) => t.id);
      },

      // NEX-190: record a rep-milestone as celebrated for a habit (idempotent), so
      // the ceremony never re-fires if the user crosses the threshold again.
      markMilestoneShown: (habitTitle, reps) =>
        set((s) => {
          const key = normalize(habitTitle);
          const shown = s.milestonesShown[key] ?? [];
          if (shown.includes(reps)) return s;
          return { milestonesShown: { ...s.milestonesShown, [key]: [...shown, reps] } };
        }),

      setAnalyticsConsent: (value) => set({ analyticsConsent: value }),

      setWeeklyEmail: (enabled, day) =>
        set((s) => {
          // Calls without a day come from an explicit on/off choice, including
          // "No weekly email" while the default is already false. Day-only
          // changes preserve the original consent timestamp.
          const preferenceChanged = day === undefined || enabled !== s.weeklyEmailEnabled;
          return {
            weeklyEmailEnabled: enabled,
            weeklyEmailConsent: preferenceChanged
              ? (enabled ? 'granted' : 'denied')
              : s.weeklyEmailConsent,
            weeklyEmailConsentUpdatedAt: preferenceChanged
              ? Date.now()
              : s.weeklyEmailConsentUpdatedAt,
            weeklyEmailDay: day !== undefined ? day : s.weeklyEmailDay,
          };
        }),

      setMandateFocus: (category, mandateId) =>
        set((s) => {
          const next = { ...(s.mandateFocus ?? {}) };
          const cat = String(category).toUpperCase();
          if (mandateId) {
            next[cat] = mandateId;
          } else {
            delete next[cat];
          }
          return { mandateFocus: next };
        }),

      clearPendingLevelUp: () => set({ pendingLevelUp: null }),
      // NEX-220: advance to the next queued badge so multi-unlock transactions
      // toast each in turn; null + empty queue when none remain.
      clearPendingBadgeUnlock: () => set((s) => {
        const [next, ...rest] = s.pendingBadgeUnlockQueue;
        return { pendingBadgeUnlock: next ?? null, pendingBadgeUnlockQueue: rest };
      }),

      assignChallenge: () => {
        const s = get();
        if (s.activeChallenge && !s.activeChallenge.completed) return;
        const completed = s.completedChallenges || [];
        const available = CHALLENGE_POOL.filter(c => !completed.includes(c.id));
        if (available.length === 0) return;
        const pick = available[Math.floor(Math.random() * available.length)];
        const today = new Date();
        const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        set({
          activeChallenge: { ...pick, progress: 0, startDate: dateKey, completed: false },
        });
      },

      recordDailyScore: (dateKey, score) => {
        set((s) => {
          // Score history is UNBOUNDED (owner request, 2026-08-25): the Score
          // Trend chart's 6M / 1Y / ALL ranges are only honest if the days are
          // still here. The old newest-30-keys prune is gone — a day-key plus a
          // small integer is a few KB per year, and nothing else depended on the
          // cap except the challenge counter below, which now windows itself.
          const history = { ...(s.scoreHistory || {}) };
          history[dateKey] = score;
          const result: any = { scoreHistory: history };
          if (s.activeChallenge && !s.activeChallenge.completed) {
            const c = { ...s.activeChallenge };
            if (c.type === 'score_target') {
              const threshold = c.id.includes('90') ? 90 : 80;
              // Explicitly the last 30 recorded days — identical to what the
              // prune used to make implicit. Without the window, an account with
              // years of history would complete a "score 80+ for N days"
              // challenge off days that predate the challenge entirely.
              const daysAbove = scoreTargetDaysAbove(history, threshold);
              c.progress = Math.min(daysAbove, c.target);
              if (c.progress >= c.target && !c.completed) {
                c.completed = true;
                result.totalXP = (s.totalXP || 0) + c.xpReward;
                result.completedChallenges = [...(s.completedChallenges || []), c.id];
                const newLevel = getLevel(result.totalXP);
                const oldLevel = getLevel(s.totalXP || 0);
                if (newLevel > oldLevel) result.pendingLevelUp = newLevel;
              }
              result.activeChallenge = c;
            }
          }
          return result;
        });
      },

      // NEX-26: phase 2 — minimal wholesale-set. Phases 3–6 add slot-
      // level mutators (refresh, dismiss-rationale). Passing null
      // clears the slice; resetState also clears it.
      setOnboardingRecommendations: (value) =>
        set({ onboardingRecommendations: value }),

      setDevReplayOnboarding: (value) =>
        set({ devReplayOnboarding: value }),

      // NEX-45/NEX-44: home-screen calls this with the today + tomorrow
      // connected calendar window after each fetch. syncWidgetAfterMutation reads
      // the field so non-Home mutations still ship a full events array
      // through to the widget snapshot.
      setAppleEventsWindow: (events) =>
        set({ appleEventsWindow: events }),

      // ── NEX-26 phase D slot mutators ───────────────────────────────────
      // Each delegates to a pure reducer in
      // src/state/onboarding-recommendations-reducers.ts. Cap-reached
      // gating happens at the reducer level — UI reads refreshCount
      // and disables the button at >= 8; the reducer no-ops a stray
      // callthrough. setMandateTitle does NOT tick refreshCount;
      // refreshMandate / refreshHabit / refreshTodo DO tick;
      // regenerateMandateDownstream is system-initiated and bypasses
      // cap gating, resets counters on the new slots.
      setMandateTitle: (mandateId, newTitle) =>
        set((s) => ({
          onboardingRecommendations: applyMandateTitle(s.onboardingRecommendations, mandateId, newTitle),
        })),
      refreshMandate: (mandateId, fields) =>
        set((s) => ({
          onboardingRecommendations: applyMandateRefresh(s.onboardingRecommendations, mandateId, fields),
        })),
      refreshHabit: (slotId, fields) =>
        set((s) => ({
          onboardingRecommendations: applyHabitRefresh(s.onboardingRecommendations, slotId, fields),
        })),
      refreshRecurringTodo: (slotId, fields) =>
        set((s) => ({
          onboardingRecommendations: applyRecurringTodoRefresh(s.onboardingRecommendations, slotId, fields),
        })),
      refreshTodo: (slotId, fields) =>
        set((s) => ({
          onboardingRecommendations: applyTodoRefresh(s.onboardingRecommendations, slotId, fields),
        })),
      regenerateMandateDownstream: (mandateId, newHabits, newRecurringTodos, newTodos) =>
        set((s) => ({
          onboardingRecommendations: applyMandateDownstream(
            s.onboardingRecommendations,
            mandateId,
            newHabits,
            newRecurringTodos,
            newTodos,
          ),
        })),

      // NEX-57: ADD-toggle store actions. Delegate to pure reducers.
      toggleAddedHabit: (slotId) =>
        set((s) => ({
          onboardingRecommendations: applyToggleAddedHabit(s.onboardingRecommendations, slotId),
        })),
      toggleAddedRecurringTodo: (slotId) =>
        set((s) => ({
          onboardingRecommendations: applyToggleAddedRecurringTodo(s.onboardingRecommendations, slotId),
        })),
      toggleAddedTodo: (slotId) =>
        set((s) => ({
          onboardingRecommendations: applyToggleAddedTodo(s.onboardingRecommendations, slotId),
        })),

      mergeCloudState: (cloudState: any, opts?: { force?: boolean; allowEmptyFields?: readonly string[]; reconciledHabitLog?: boolean }) => {
        if (!cloudState || typeof cloudState !== 'object') return;
        // NEX-142 defense-in-depth: never let a (possibly stale) cloud snapshot
        // overwrite a populated local store, regardless of caller. Cloud is a
        // restore source for empty installs only; local is the source of truth.
        // `force` (Phase 1 sync guard) overrides this ONLY when the caller's
        // clock comparison proved the cloud row is newer than this device's
        // last-seen cloud timestamp — without it, multi-device LWW-by-clock
        // inbound merges could never land on a populated install.
        if (!opts?.force && localStoreHasUserData(get())) return;
        // Only a coordinator with acknowledged history can prove an intentional
        // clear. Untrusted/legacy callers keep the existing empty-install guards.
        const clearable = new Set([
          'recurringRules', 'recurringToDos', 'pillars', 'inbox', 'dailyTasks',
          'scoreHistory', 'dailyScores', 'badges', 'morningIntention',
          'morningIntentionDate', 'morningIntentionCompletedDate',
          'pendingMondayIntention', 'weeklyWinsDate', 'lastFreezeDate',
          'lastOpenDate', 'activeChallenge',
        ]);
        const allowsEmpty = (key: string) => clearable.has(key) && opts?.allowEmptyFields?.includes(key) === true;
        const replaceHabitLog = opts?.reconciledHabitLog === true &&
          Array.isArray(cloudState.habitLog) && cloudState.habitLog.every(
            (entry: any) => entry && typeof entry === 'object' && typeof entry.id === 'string',
          );
        // NEX-171: migrate an OLD cloud payload's pinnedHabits → excludedFromScore
        // ONCE, then reuse for both recurringRules and the derived pinnedHabits.
        const migratedCloudRules: any[] | null =
          Array.isArray(cloudState.recurringRules) && (cloudState.recurringRules.length > 0 || allowsEmpty('recurringRules'))
            ? migratePinsToExcluded(cloudState.recurringRules, cloudState.pinnedHabits)
            : null;
        // Fresh-device convergence guard (2026-08-26): an EMPTY inbound
        // collection must not clobber a NON-EMPTY local one. Whole-blob LWW
        // can't distinguish "the user cleared this on another device" from "a
        // fresh second device's defaults" — and the latter is how a new iPad's
        // empty inbox/tasks/scores would erase real data while converging.
        const hasKeys = (v: any): boolean =>
          !!v && typeof v === 'object' && Object.keys(v).length > 0;
        const nonEmptyArr = (v: any): boolean => Array.isArray(v) && v.length > 0;
        // habitLog converges as a UNION by entry id, not a replace: completion
        // events are append-mostly, so a device merging a stale-but-newer blob
        // must not lose entries it logged locally (e.g. today's completions
        // when a second device uploaded an older snapshot). Entries carry
        // unique ids + timestamps, so the union is deterministic.
        // Trade-off: a remote habit UN-toggle can resurrect an entry —
        // accepted; whole-blob LWW favors not losing data (tombstones belong
        // to a future per-entity sync).
        const unionHabitLog = (local: any, inbound: any[]): any[] => {
          const base: any[] = Array.isArray(local) ? [...local] : [];
          const seen = new Set(base.map((e) => e?.id));
          for (const e of inbound) {
            if (e && typeof e.id === 'string' && !seen.has(e.id)) {
              seen.add(e.id);
              base.push(e);
            }
          }
          base.sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0));
          return base;
        };
        set((s) => ({
          ...s,
          ...(cloudState.userProfile ? { userProfile: cloudState.userProfile } : {}),
          ...(migratedCloudRules ? { recurringRules: migratedCloudRules.map((rule: any) => {
            // Calendar event identifiers belong to this device. Never import a
            // remote link, even from older clients that still publish it.
            const { appleEventId: _remoteLink, ...sharedRule } = rule;
            const localRule = s.recurringRules.find((local) => local.id === rule.id);
            return localRule && 'appleEventId' in localRule
              ? { ...sharedRule, appleEventId: localRule.appleEventId }
              : sharedRule;
          }) } : {}),
          ...(Array.isArray(cloudState.recurringToDos) && (cloudState.recurringToDos.length > 0 || allowsEmpty('recurringToDos')) ? { recurringToDos: cloudState.recurringToDos } : {}),
          // NEX-171: keep pinnedHabits DERIVED from the migrated rules (not the raw
          // legacy inbound value) so the widget/cloud "active set" stays consistent.
          ...(migratedCloudRules
            ? { pinnedHabits: deriveActiveHabitIds(migratedCloudRules) }
            : (Array.isArray(cloudState.pinnedHabits) ? { pinnedHabits: cloudState.pinnedHabits } : {})),
          ...(Array.isArray(cloudState.habitLog) && (cloudState.habitLog.length > 0 || replaceHabitLog)
            ? { habitLog: replaceHabitLog ? cloudState.habitLog : unionHabitLog(s.habitLog, cloudState.habitLog) }
            : {}),
          ...(cloudState.habitStreaks ? { habitStreaks: cloudState.habitStreaks } : {}),
          ...(cloudState.milestonesShown && typeof cloudState.milestonesShown === 'object' ? { milestonesShown: cloudState.milestonesShown } : {}),
          ...(cloudState.habitStreakUpdatedDate ? { habitStreakUpdatedDate: cloudState.habitStreakUpdatedDate } : {}),
          ...(hasKeys(cloudState.dailyTasks) || (cloudState.dailyTasks && (!hasKeys(s.dailyTasks) || allowsEmpty('dailyTasks')))
            ? { dailyTasks: cloudState.dailyTasks }
            : {}),
          ...(Array.isArray(cloudState.pillars) && (cloudState.pillars.length > 0 || allowsEmpty('pillars')) ? { pillars: cloudState.pillars } : {}),
          ...(Array.isArray(cloudState.horizonReviews) ? { horizonReviews: cloudState.horizonReviews } : {}),
          ...(cloudState.lastReviewDates ? { lastReviewDates: cloudState.lastReviewDates } : {}),
          ...(Array.isArray(cloudState.inbox) && (cloudState.inbox.length > 0 || !nonEmptyArr(s.inbox) || allowsEmpty('inbox'))
            ? { inbox: cloudState.inbox }
            : {}),
          // NEX-162: sanitize inbound lead-time actions (drops malformed rows).
          ...(Array.isArray(cloudState.leadTimeActions) ? { leadTimeActions: backfillLeadTimeActions(cloudState.leadTimeActions) } : {}),
          ...(cloudState.goalHabitMap ? { goalHabitMap: cloudState.goalHabitMap } : {}),
          ...(cloudState.nextWeekRuleOverrides && typeof cloudState.nextWeekRuleOverrides === 'object'
            ? { nextWeekRuleOverrides: cloudState.nextWeekRuleOverrides }
            : {}),
          ...(allowsEmpty('pendingMondayIntention') && cloudState.pendingMondayIntention === null
            ? { pendingMondayIntention: null } : {}),
          ...(cloudState.pendingMondayIntention &&
            typeof cloudState.pendingMondayIntention === 'object' &&
            typeof cloudState.pendingMondayIntention.text === 'string' &&
            typeof cloudState.pendingMondayIntention.targetDateKey === 'string'
            ? { pendingMondayIntention: cloudState.pendingMondayIntention }
            : {}),
          ...(Array.isArray(cloudState.recentWisdomHistory)
            ? { recentWisdomHistory: cloudState.recentWisdomHistory }
            : {}),
          ...(cloudState.isActivated !== undefined ? { isActivated: cloudState.isActivated } : {}),
          ...((): { activatedDate?: string } => {
            // Only accept cloud activatedDate if local is null OR cloud is
            // strictly older. Cloud should never push the timestamp forward —
            // that would replay the first-week nudges.
            const incoming = cloudState.activatedDate;
            if (!incoming) return {};
            const localTs = s.activatedDate ? new Date(s.activatedDate).getTime() : NaN;
            const incomingTs = new Date(incoming).getTime();
            if (Number.isNaN(incomingTs)) return {};
            if (Number.isNaN(localTs)) return { activatedDate: incoming };
            return incomingTs < localTs ? { activatedDate: incoming } : {};
          })(),
          ...((): { firstHabitCompletedAt?: string } => {
            // NEX-164: cloud restores bypass the persisted-state migration, so
            // backfill the durable first-habit flag for an established cloud
            // user — otherwise their next habit log would falsely emit
            // is_first:true. Prefer an explicit cloud value; else stamp from the
            // cloud activation signals (activatedDate / isActivated / habitLog).
            if (typeof cloudState.firstHabitCompletedAt === 'string') {
              return { firstHabitCompletedAt: cloudState.firstHabitCompletedAt };
            }
            const established =
              Boolean(cloudState.isActivated) ||
              !!cloudState.activatedDate ||
              (Array.isArray(cloudState.habitLog) && cloudState.habitLog.length > 0);
            return established
              ? { firstHabitCompletedAt: cloudState.activatedDate ?? new Date(0).toISOString() }
              : {};
          })(),
          ...(cloudState.firstActionIntent === 'complete_habit' || cloudState.firstActionIntent === 'add_habit'
            ? { firstActionIntent: cloudState.firstActionIntent }
            : {}),
          ...(cloudState.morningIntention !== undefined && (cloudState.morningIntention !== null || s.morningIntention == null || allowsEmpty('morningIntention'))
            ? { morningIntention: cloudState.morningIntention }
            : {}),
          ...(cloudState.morningIntentionDate !== undefined && (cloudState.morningIntentionDate !== null || s.morningIntentionDate == null || allowsEmpty('morningIntentionDate'))
            ? { morningIntentionDate: cloudState.morningIntentionDate }
            : {}),
          ...(cloudState.morningIntentionCompletedDate !== undefined && (cloudState.morningIntentionCompletedDate !== null || s.morningIntentionCompletedDate == null || allowsEmpty('morningIntentionCompletedDate'))
            ? { morningIntentionCompletedDate: cloudState.morningIntentionCompletedDate }
            : {}),
          ...(typeof cloudState.totalXP === 'number' ? { totalXP: cloudState.totalXP } : {}),
          ...(Array.isArray(cloudState.badges) && (cloudState.badges.length > 0 || !nonEmptyArr(s.badges) || allowsEmpty('badges'))
            ? { badges: cloudState.badges }
            : {}),
          ...(typeof cloudState.streakFreezes === 'number' ? { streakFreezes: cloudState.streakFreezes } : {}),
          ...(cloudState.lastFreezeDate || (cloudState.lastFreezeDate === null && allowsEmpty('lastFreezeDate')) ? { lastFreezeDate: cloudState.lastFreezeDate } : {}),
          ...(cloudState.lastOpenDate || (cloudState.lastOpenDate === null && allowsEmpty('lastOpenDate')) ? { lastOpenDate: cloudState.lastOpenDate } : {}),
          ...(cloudState.activeChallenge || (cloudState.activeChallenge === null && allowsEmpty('activeChallenge')) ? { activeChallenge: cloudState.activeChallenge } : {}),
          ...(Array.isArray(cloudState.completedChallenges) ? { completedChallenges: cloudState.completedChallenges } : {}),
          ...(hasKeys(cloudState.scoreHistory) || (cloudState.scoreHistory && typeof cloudState.scoreHistory === 'object' && (!hasKeys(s.scoreHistory) || allowsEmpty('scoreHistory')))
            ? { scoreHistory: cloudState.scoreHistory }
            : {}),
          ...(cloudState.notificationSettings ? { notificationSettings: cloudState.notificationSettings } : {}),
          ...(typeof cloudState.softMode === 'boolean' ? { softMode: cloudState.softMode } : {}),
          ...(cloudState.breakdownGrain ? { breakdownGrain: normalizeGrain(cloudState.breakdownGrain) } : {}),
          // NEX-207: pauseMode is synced intent. Normalize the inbound blob so a
          // malformed cloud payload can't poison the freeze math.
          ...(cloudState.pauseMode ? { pauseMode: normalizePauseMode(cloudState.pauseMode) } : {}),
          // Coach thread: its own merge (union by id, clear-as-tombstone) — an
          // empty inbound thread never wipes a real one, a newer Clear does.
          ...(cloudState.coachThread ? { coachThread: mergeCoachThreads(get().coachThread, cloudState.coachThread) } : {}),
          ...(() => {
            const merged = mergeWeeklyEmailConsent(
              s.weeklyEmailConsent,
              s.weeklyEmailConsentUpdatedAt,
              cloudState.weeklyEmailConsent,
              cloudState.weeklyEmailConsentUpdatedAt,
            );
            return {
              weeklyEmailConsent: merged.consent,
              weeklyEmailConsentUpdatedAt: merged.updatedAt,
              // Consent is authoritative. A legacy cloud boolean never grants it.
              weeklyEmailEnabled: merged.consent === 'granted',
            };
          })(),
          ...(cloudState.mandateFocus && typeof cloudState.mandateFocus === 'object' ? { mandateFocus: cloudState.mandateFocus } : {}),
          ...(typeof cloudState.weeklyEmailDay === 'number' ? { weeklyEmailDay: cloudState.weeklyEmailDay } : {}),
          ...(cloudState.weeklyWins ? { weeklyWins: cloudState.weeklyWins } : {}),
          ...(cloudState.weeklyWinsDate || (cloudState.weeklyWinsDate === null && allowsEmpty('weeklyWinsDate')) ? { weeklyWinsDate: cloudState.weeklyWinsDate } : {}),
          ...(cloudState.orbitDays && typeof cloudState.orbitDays === 'object' ? { orbitDays: cloudState.orbitDays } : {}),
          ...(cloudState.weeklyReflection !== undefined ? { weeklyReflection: cloudState.weeklyReflection } : {}),
          ...(cloudState.weeklyReflectionDate !== undefined ? { weeklyReflectionDate: cloudState.weeklyReflectionDate } : {}),
          ...(cloudState.nightlyForward !== undefined ? { nightlyForward: cloudState.nightlyForward } : {}),
          ...(cloudState.nightlyForwardDate !== undefined ? { nightlyForwardDate: cloudState.nightlyForwardDate } : {}),
          ...(hasKeys(cloudState.dailyScores) || (cloudState.dailyScores && typeof cloudState.dailyScores === 'object' && (!hasKeys(s.dailyScores) || allowsEmpty('dailyScores')))
            ? { dailyScores: cloudState.dailyScores }
            : {}),
        }));
      },

      resetState: () => {
        // Invalidate before subscribers observe the reset and queue an empty write.
        stopSyncSession();
        // The next person on this phone must never reuse the previous one's
        // access token when their first AI call's session lookup wedges.
        clearAiSessionCache();
        // Wipes all user-data fields back to their first-construction defaults.
        // Used on Sign Out (settings-screen.tsx) and the auth listener's
        // signed-out branch (app/_layout.tsx).
        //
        // Note: nexus_legacy_free_user is in raw AsyncStorage, keyed per-userId
        // (NEX-204: `nexus_legacy_free_user:<uid>`), and survives resetState by
        // design — the SAME grandfathered user keeps their bypass when they sign
        // back in, without leaking to another account on the device. Zustand's
        // persist middleware only manages the PERSIST_STORAGE_KEY
        // ('nexus-sovereign-storage') namespace.
        //
        // Fields explicitly preserved (device/UX preferences, not user-data):
        //   - hasSeenTutorial: once shown, stays shown across accounts on the
        //     same install — re-replaying the tutorial after every sign-out
        //     would be hostile.
        //   - notificationSettings: device-level scheduling pref. The user
        //     configured their own quiet hours; respect that.
        //   - weeklyEmailDay: harmless display preference.
        set({
          // ── Identity & activation ────────────────────────────────────
          localUserId: null,
          isActivated: false,
          activatedDate: null,
          // NEX-164: account-scoped — a second account on this install must
          // start its own Day-1 activation, so clear both first-action fields
          // (a leftover non-null firstHabitCompletedAt would make the next
          // account's first completion report is_first:false).
          firstHabitCompletedAt: null,
          firstActionIntent: null,
          userProfile: null,
          // NEX-124: a second account on this install should fire its own
          // funnel events, so clear the set-once guards on sign-out.
          firstMandateCommittedFired: false,
          firstAlignmentScoreSeenFired: false,

          // ── Mode / capacity (transient UX state) ─────────────────────
          modeLabels: { ALL: 'ALL', SALES: 'SALES', VISION: 'VISION', FAMILY: 'FAMILY' },
          currentMode: 'ALL',
          capacity: 'PEAK',
          // NEX-190: a fresh account starts in the default cumulative mode — never
          // inherit a prior user's Soft Mode opt-in across sign-out.
          softMode: false,
          breakdownGrain: DEFAULT_GRAIN, // NEX-210: reset grain pref on sign-out

          // ── Habits & rules ───────────────────────────────────────────
          recurringRules: [],
          recurringToDos: [],
          pinnedHabits: [],
          habits: [],
          habitStrength: {},
          habitLog: [],
          habitStreaks: {},
          habitStreakUpdatedDate: {},
          milestonesShown: {},
          goalHabitMap: {},

          // ── Tasks, inbox, calendar ───────────────────────────────────
          inbox: [],
          justCaptured: null, // NEX-196: clear the Home-echo ref on sign-out (no cross-account leak)
          returningFromLapse: false, // NEX-191: session-only; never leak a return state across accounts
          pauseMode: { ...EMPTY_PAUSE_MODE }, // NEX-207: never inherit a prior user's pause across sign-out
          resumingFromPause: false, // NEX-207: session-only; never leak across accounts
          leadTimeActions: [], // NEX-162: account-scoped — don't leak across sign-out
          pillars: [],
          orbitDays: {},
          dailyTasks: {},

          // ── Daily intention & reflection ─────────────────────────────
          morningIntention: null,
          morningIntentionDate: null,
          morningIntentionCompletedDate: null,
          weeklyReflection: null,
          weeklyReflectionDate: null,
          nightlyForward: null,
          nightlyForwardDate: null,
          weeklyWins: [],
          weeklyWinsDate: null,

          // ── Scores & gamification ────────────────────────────────────
          dailyScores: {},
          scoreHistory: {},
          totalXP: 0,
          badges: BADGE_DEFINITIONS.map((b) => ({ ...b, unlockedAt: null })),
          streakFreezes: 1,
          lastFreezeDate: null,
          lastOpenDate: null,
          appLaunchHourCounts: [], // NEX-212: no receptivity-pattern leak across sign-out
          suggestionFeedback: [], // NEX-308: don't leak one user's AI-outcome log across sign-out
          quotesPool: emptyPool(), // don't leak one user's quote pool across sign-out
          coachThread: emptyCoachThread(), // a conversation never outlives sign-out
          pendingLevelUp: null,
          pendingBadgeUnlock: null,
          pendingBadgeUnlockQueue: [],
          // Deprecated challenge fields — cleared for the same UX-leak reason
          // even though no UI consumes them anymore. Old cloud payloads may
          // still carry them; mergeCloudState stays tolerant.
          activeChallenge: null,
          completedChallenges: [],

          // ── Reviews & reflection history ─────────────────────────────
          horizonReviews: [],
          lastReviewDates: {},

          // ── Wisdom & content ─────────────────────────────────────────
          dailyWisdomQuotes: [],
          dailyWisdomDate: '',
          dailyWisdomIntention: null,
          wisdomQuoteCount: 3,
          recentWisdomHistory: [],

          // ── Communication consent (account-scoped) ───────────────────
          weeklyEmailEnabled: false,
          weeklyEmailConsent: 'unset',
          weeklyEmailConsentUpdatedAt: null,

          // ── Pending / staged state ───────────────────────────────────
          nextWeekRuleOverrides: {},
          pendingMondayIntention: null,
          // Account-scoped: mandateFocus is now in the outbound cloud payload,
          // so leaving it uncleared would push user A's Today's-Focus picks
          // into user B's cloud row after a sign-out/sign-in on this device.
          mandateFocus: {},

          // ── Onboarding (NEX-26) ──────────────────────────────────────
          onboardingRecommendations: null,

          // ── Widget (NEX-45) ──────────────────────────────────────────
          appleEventsWindow: [],
        });
      },

      computeDailyScore: (dateKey) => {
        const s = get();
        let score = 0;

        // Factor 1: morning intention set (33 pts)
        if (s.morningIntentionDate === dateKey && s.morningIntention) {
          score += 33;
        }

        // Factor 2: habit completions (33 pts)
        // Score only the habits actually DUE this day — the same set the Home
        // card row shows and lets you check off. Counting the entire habit
        // library here (rules not scheduled today, archived rules) put habits
        // you were never shown into the denominator, so a perfect day scored
        // <100. Mirror the UI's filter: not-archived + scheduled-today +
        // not paused from the score (NEX-171 excludedFromScore).
        const allRules = Array.isArray(s.recurringRules) ? s.recurringRules : [];
        const dow = dowFromDateKey(dateKey);
        const scoredHabits = allRules.filter(r =>
          !r?.archived &&
          isScheduledOn(r, dow) &&
          !r?.excludedFromScore
        );
        const totalRules = scoredHabits.length;
        if (totalRules > 0) {
          const loggedTitles = new Set(
            Array.isArray(s.habitLog)
              ? s.habitLog.filter(e => e.dateKey === dateKey).map(e => normalize(e.habitTitle))
              : []
          );
          const loggedToday = Math.min(totalRules, scoredHabits.filter(r => loggedTitles.has(normalize(r.title))).length);
          score += Math.round((loggedToday / totalRules) * 33);
        }

        // Factor 3: daily task completions (34 pts)
        // NEX-148 review (Codex P2): route through the SAME rollup the live ring
        // uses so recorded/watch scores agree with scoreBreakdown — including
        // recurring to-dos due today not yet materialized into dailyTasks.
        const taskRollup = selectTodayTaskRollup(s.recurringToDos, s.dailyTasks[dateKey], dateKey);
        if (taskRollup.total > 0) {
          score += Math.round((taskRollup.completed / taskRollup.total) * 34);
        } else if (totalRules === 0) {
          score += 34; // nothing due today = not penalized
        }

        return Math.min(100, Math.max(0, score));
      },

      incrementStreak: (habitTitle) =>
        set((s) => {
          const key = normalize(habitTitle);
          const today = getLocalDateKey(new Date());
          const lastUpdated = s.habitStreakUpdatedDate[key];
          const matchingRule = (s.recurringRules ?? []).find(
            (r: any) => normalize(r.title) === key
          );
          const daysOfWeek = (matchingRule as any)?.daysOfWeek;
          const prevScheduled = previousScheduledDateKey(today, daysOfWeek, 1);
          const graceAnchor = previousScheduledDateKey(today, daysOfWeek, DEFAULT_STREAK_GRACE_MISSES + 1);

          let newStreak = s.habitStreaks[key] ?? 0;
          if (lastUpdated === today) return s; // already counted today
          if (lastUpdated === prevScheduled || lastUpdated === graceAnchor || newStreak === 0) {
            newStreak += 1; // continued, grace-held, or started
          } else {
            newStreak = 1; // more than one missed scheduled day starts a fresh run
          }
          return {
            habitStreaks: { ...s.habitStreaks, [key]: newStreak },
            habitStreakUpdatedDate: { ...s.habitStreakUpdatedDate, [key]: today },
          };
        }),

      getStreak: (habitTitle) => {
        const s = get();
        const key = normalize(habitTitle);
        const currentStreak = s.habitStreaks[key] ?? 0;
        const matchingRule = (s.recurringRules ?? []).find(
          (r: any) => normalize(r.title) === key
        );
        const status = getStreakGraceStatus({
          currentStreak,
          lastUpdatedDateKey: s.habitStreakUpdatedDate[key],
          daysOfWeek: (matchingRule as any)?.daysOfWeek,
        });
        return status === 'current' || status === 'held' ? currentStreak : 0;
      },

      setMorningIntention: (intention) => {
        const today = getLocalDateKey(new Date());
        const s = get();
        const challengeUpdate: any = {};
        if (s.activeChallenge && !s.activeChallenge.completed && s.activeChallenge.type === 'intention_streak') {
          const c = { ...s.activeChallenge };
          if (s.morningIntentionDate !== today) {
            c.progress = Math.min(c.progress + 1, c.target);
            if (c.progress >= c.target) {
              c.completed = true;
              const newXP = (s.totalXP || 0) + c.xpReward;
              challengeUpdate.totalXP = newXP;
              challengeUpdate.completedChallenges = [...(s.completedChallenges || []), c.id];
              const newLevel = getLevel(newXP);
              const oldLevel = getLevel(s.totalXP || 0);
              if (newLevel > oldLevel) challengeUpdate.pendingLevelUp = newLevel;
            }
            challengeUpdate.activeChallenge = c;
          }
        }
        set({ morningIntention: intention, morningIntentionDate: today, ...challengeUpdate });
      },

      toggleMorningIntentionComplete: () => {
        const today = getLocalDateKey(new Date());
        set((s) => ({
          morningIntentionCompletedDate:
            s.morningIntentionCompletedDate === today ? null : today,
        }));
      },

      setWeeklyReflection: (reflection) => {
        const today = getLocalDateKey(new Date());
        set({ weeklyReflection: reflection, weeklyReflectionDate: today });
      },

      setNightlyForward: (forward) => {
        const today = getLocalDateKey(new Date());
        set({ nightlyForward: forward, nightlyForwardDate: today });
      },

      awardXP: (amount) => {
        set((s) => {
          const newXP = s.totalXP + amount;
          const newBadges = [...s.badges];
          const lvl = getLevel(newXP);
          if (lvl >= 5) {
            const b = newBadges.find(x => x.id === 'level_5');
            if (b && !b.unlockedAt) b.unlockedAt = Date.now();
          }
          if (lvl >= 10) {
            const b = newBadges.find(x => x.id === 'level_10');
            if (b && !b.unlockedAt) b.unlockedAt = Date.now();
          }
          return { totalXP: newXP, badges: newBadges };
        });
      },

      unlockBadge: (badgeId) => {
        set((s) => {
          const badges = s.badges.map(b =>
            b.id === badgeId && !b.unlockedAt ? { ...b, unlockedAt: Date.now() } : b
          );
          return { badges };
        });
      },

      useStreakFreeze: () => {
        const s = get();
        const today = getLocalDateKey(new Date());
        if (s.streakFreezes <= 0) return false;
        if (s.lastFreezeDate === today) return false;
        set({ streakFreezes: s.streakFreezes - 1, lastFreezeDate: today });
        return true;
      },

      recordAppOpen: () => {
        // NEX-191: detect a shame-free return atomically with the overwrite, so the
        // prior lastOpenDate is read before it's clobbered (no detection-vs-record
        // race). Gated on `isActivated` (an established user) — NOT on
        // hasSeenTutorial (device-local, not cloud-restored) and NOT on
        // activatedDate alone (older migrated users can be isActivated===true with
        // activatedDate===null when there was no habit log to back-date from).
        // isActivated is synced + restored by mergeCloudState, so it survives a
        // fresh-install restore. The home-onboarding collision is handled on the
        // screen (startFlow gated on !returnMode). Boolean only; day count never
        // stored (Law C).
        const now = new Date();
        const prevOpen = get().lastOpenDate;
        // NEX-207: a planned pause must NOT read as an unplanned lapse. Don't fire
        // while actively paused, and threshold the NON-PAUSED gap (activeGapDays)
        // so paused days don't count toward the lapse. Resume drives its own
        // forward-only surface via resumingFromPause, not this lapse path.
        const pm = get().pauseMode;
        const lapsed =
          !pm?.active &&
          // NEX-207 B2: a just-resumed open is a forward resume, not a lapse — the
          // resume card wins. (resumePauseMode also clears returningFromLapse.)
          !get().resumingFromPause &&
          activeGapDays(prevOpen, now, pm) >= LAPSE_THRESHOLD_DAYS &&
          get().isActivated === true;
        // Always write the flag (both paths): a non-lapsed open must clear a stale
        // `true` left over from an earlier same-runtime open, or Home would keep
        // showing the collapsed return surface when this open isn't a lapse.
        set({
          lastOpenDate: getLocalDateKey(now),
          returningFromLapse: lapsed,
          // NEX-212 (N-3): record this launch's local hour into the device-local
          // receptivity histogram (read at schedule time to nudge prompt times).
          appLaunchHourCounts: recordOpenHour(get().appLaunchHourCounts, now.getHours()),
        });
      },

      setReturningFromLapse: (v) => set({ returningFromLapse: v }),

      // NEX-207 Pause Mode (B1). Begin a pause from today (optional planned end).
      // Idempotent — re-calling while paused is a no-op. Notification silence is
      // re-applied by reconcileNotificationsFromState (wired in the notif commit).
      startPauseMode: (plannedUntil = null) =>
        set((s) => {
          if (s.pauseMode?.active) return s;
          const todayKey = getLocalDateKey(new Date());
          // NEX-207: if Home already recorded a score for today before the user
          // paused, drop it — today is now a paused day and must not linger as a
          // low/"Drifting" day in the debrief (Law C). The recorder's write-skip
          // only covers FUTURE writes; this retracts a same-day pre-pause score.
          let scoreHistory = s.scoreHistory;
          if (scoreHistory && Object.prototype.hasOwnProperty.call(scoreHistory, todayKey)) {
            const { [todayKey]: _dropped, ...rest } = scoreHistory;
            scoreHistory = rest;
          }
          // Also retract the legacy dailyScores entry for today — buildAIContext /
          // weekly-email / Horizon still read dailyScores, so a same-day score
          // there (from older or cloud-restored state) would otherwise let the
          // planned break be summarized as a scored day.
          let dailyScores = s.dailyScores;
          if (dailyScores && Object.prototype.hasOwnProperty.call(dailyScores, todayKey)) {
            const { [todayKey]: _d2, ...restDs } = dailyScores;
            dailyScores = restDs;
          }
          return {
            scoreHistory,
            dailyScores,
            pauseMode: {
              active: true,
              since: todayKey,
              plannedUntil: typeof plannedUntil === 'string' ? plannedUntil : null,
              history: prunePauseHistory(s.pauseMode?.history ?? [], todayKey),
            },
            resumingFromPause: false,
            // NEX-207 B2: starting a planned break clears any stale lapse-return
            // flag so Home can't show the "what piled up" surface under a pause.
            returningFromLapse: false,
          };
        }),

      // Atomic resume: repair streaks, close the interval, flag the resume surface
      // — all in one set() so a resume-then-log can't reset a streak before repair
      // runs. Repair only revives runs that were alive entering the pause and that
      // missed only paused (or within-grace) scheduled days (see repairStreakAnchors).
      resumePauseMode: () =>
        set((s) => {
          const pm = s.pauseMode;
          if (!pm?.active || !pm.since) return { resumingFromPause: false };
          const todayKey = getLocalDateKey(new Date());
          const since = pm.since;
          const rules = Array.isArray(s.recurringRules) ? s.recurringRules : [];
          const habits: RepairHabitInput[] = rules
            .filter((r: any) => r && typeof r.title === 'string' && !r.archived)
            .map((r: any) => {
              const key = normalize(r.title);
              // Pre-pause grace status = status as the pause BEGAN (today = since),
              // so a run that already died before the pause is never resurrected.
              const prePauseStatus = getStreakGraceStatus({
                currentStreak: s.habitStreaks[key] ?? 0,
                lastUpdatedDateKey: s.habitStreakUpdatedDate[key],
                today: since,
                daysOfWeek: r.daysOfWeek,
              });
              return { key, lastUpdated: s.habitStreakUpdatedDate[key], daysOfWeek: r.daysOfWeek, prePauseStatus };
            });
          const patch = repairStreakAnchors(habits, pm, todayKey);
          const habitStreakUpdatedDate = Object.keys(patch).length
            ? { ...s.habitStreakUpdatedDate, ...patch }
            : s.habitStreakUpdatedDate;
          // NEX-279: the resume day is ACTIVE again, so close the interval at the
          // day BEFORE resume (closePauseInterval → null for a same-day pause).
          // The old `endedOn: todayKey` left the resume day flagged paused, which
          // dropped that day's alignment score (the reporter's Monday 100%).
          const closed = closePauseInterval(since, todayKey);
          const nextHistory = prunePauseHistory(
            closed ? [...(pm.history ?? []), closed] : (pm.history ?? []),
            todayKey,
          );
          // Restore the resume day's score ATOMICALLY here (not via Home's
          // recorder effect): startPauseMode dropped scoreHistory[today] on
          // pause-start, and relying on the effect leaves a persist-gap (app
          // killed before re-render) + couples to Home being mounted. The effect
          // still maintains it through the day (idempotent). Only scoreHistory is
          // restored — `dailyScores` is dead for live writes (the AI path reads
          // scoreHistory aliased as dailyScores), so a normal active day has no
          // dailyScores entry either; restoring it would make today anomalous.
          const resumeDayScore = get().computeDailyScore(todayKey);
          const scoreHistory = { ...(s.scoreHistory ?? {}), [todayKey]: resumeDayScore };
          return {
            habitStreakUpdatedDate,
            scoreHistory,
            pauseMode: {
              active: false,
              since: null,
              plannedUntil: null,
              history: nextHistory,
            },
            resumingFromPause: true,
            // NEX-207 B2: a forward resume must beat the lapse surface — clear any
            // stale returningFromLapse so Home shows the resume card, not "piled up".
            returningFromLapse: false,
          };
        }),

      setResumingFromPause: (v) => set({ resumingFromPause: !!v }),

      syncAllData: () => {},
    }),
    {
      name: PERSIST_STORAGE_KEY,
      version: PERSIST_VERSION,
      storage: durableAppStateStorage as any,
      // devReplayOnboarding is a dev-session-only flag. Stripping it here
      // (rather than relying on the default false) guarantees a restart
      // always returns to the real onboarding gate. Everything else
      // persists exactly as before this partialize was added (functions
      // were already dropped by JSON serialization). The `as any` keeps
      // the persist middleware's partialized-state generic at its default
      // — letting TS infer it from the rest-spread of this huge store
      // degrades inference inside the creator (unknown leaks at distant
      // lines).
      partialize: ((state: any) => {
        // NEX-196: justCaptured is session-only — drop it here (the real persist
        // gate) so a restart can't rehydrate a stale "Just captured" Home chip.
        // NEX-191: returningFromLapse is session-only — drop it here so a restart
        // can't rehydrate a stale return state (it's recomputed in recordAppOpen).
        // NEX-207: resumingFromPause is session-only — drop it here so a restart
        // can't rehydrate a stale resume surface. pauseMode itself DOES persist.
        const { devReplayOnboarding: _omit, justCaptured: _omit2, returningFromLapse: _omit3, resumingFromPause: _omit4, ...rest } = state;
        return rest;
      }) as any,
      migrate: (persistedState: any) => {
        const draft = persistedState ?? {};

        // v13: opt all existing users into weekly email summaries.
        // v12 audit: between the executor extraction and the timesPerDay-arg
        // fix, voice-created habits could persist without their timesPerDay
        // value (the 7th arg was dropped when the executor was lifted out of
        // commitProposal). State has no signal to programmatically reconstruct
        // what the user originally said, so just log what's there — the user
        // can correct via the MANAGE HABITS stepper if anything reads as 1×
        // when it should be higher.
        try {
          const rules = Array.isArray(draft.recurringRules) ? draft.recurringRules : [];
          if (rules.length > 0) {
            console.log(
              '[Migration v11→v12] Recurring rules audit:',
              rules.map((r: any) => ({ title: r?.title, timesPerDay: r?.timesPerDay ?? 1 }))
            );
          }
        } catch (e) {
          console.log('[Migration v11→v12] audit failed:', e);
        }

        // v8: back-date activatedDate for returning users whose timestamp was
        // overwritten by stray activateUser calls (e.g. anchor edits) or who
        // predate the field. If habitLog is unavailable or malformed, fall
        // back to leaving activatedDate null and let the nudge block hide.
        let migratedActivatedDate: string | null = draft.activatedDate ?? null;
        try {
          const log = Array.isArray(draft.habitLog) ? draft.habitLog : null;
          if (log && log.length > 0) {
            let oldestKey: string | null = null;
            for (const entry of log) {
              const k = entry?.dateKey;
              if (typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)) {
                if (oldestKey === null || k < oldestKey) oldestKey = k;
              }
            }
            if (oldestKey) {
              const [y, m, d] = oldestKey.split('-').map(Number);
              const oldestDate = new Date(y, m - 1, d, 0, 0, 0, 0);
              const oldestTs = oldestDate.getTime();
              if (!Number.isNaN(oldestTs)) {
                const currentTs = migratedActivatedDate
                  ? new Date(migratedActivatedDate).getTime()
                  : NaN;
                const shouldBackdate =
                  !migratedActivatedDate ||
                  Number.isNaN(currentTs) ||
                  currentTs > oldestTs;
                if (shouldBackdate) {
                  migratedActivatedDate = oldestDate.toISOString();
                }
              }
            }
          }
        } catch {
          // Parse failure — leave migratedActivatedDate as-is.
        }

        // NEX-171: migrate legacy pinnedHabits → per-rule excludedFromScore in
        // the same pass (so every downstream consumer sees the flag).
        const migratedRecurringRules = migratePinsToExcluded(
          Array.isArray(draft.recurringRules)
            ? draft.recurringRules.map((r: any) => ({
                ...r,
                createdAt: typeof r?.createdAt === 'number' ? r.createdAt : 0,
                anchor: typeof r?.anchor === 'string' || r?.anchor === null
                  ? r.anchor
                  : null,
              }))
            : [],
          draft.pinnedHabits,
        );

        // v23 / NEX-76: goalHabitMap keys are derived from normalize(rule.title).
        // Older delete/rename paths could leave orphan keys behind, which made
        // surfaces that counted map keys disagree with the mandate detail list.
        // Prune to current recurringRules only; category-based unlinking is not
        // applied here because the simulator audit found no cross-category links.
        const migratedGoalHabitMap = pruneGoalHabitMapToRecurringRules(
          draft.goalHabitMap,
          migratedRecurringRules,
        );

        // v25: re-attach emoji-orphaned completions. The v3 UI push
        // stripped emoji from habit titles via renameRecurringRule, which
        // migrated goalHabitMap but not habitLog — so every pre-rename
        // completion (stored keyed by e.g. "🧘 meditation") stopped
        // matching its renamed rule ("Meditation") and silently dropped
        // out of every schedule-aware % surface. A daily habit could read
        // ~29% despite an unbroken record. Reconcile is emoji-insensitive,
        // unambiguous-only, and idempotent. See habit-log-reconcile.ts.
        const migratedHabitLog = reconcileHabitLogToRules(
          Array.isArray(draft.habitLog) ? draft.habitLog : [],
          migratedRecurringRules,
        );

        // v25: the title-keyed scalar maps (streaks, streak-update dates,
        // strength) are keyed by normalize(title) just like habitLog, so the
        // same emoji-strip rename orphaned them too. Remap with the identical
        // unambiguous matching so a repaired habit keeps its streak and
        // strength instead of resetting to zero on the first new completion.
        const migratedHabitStreaks = reconcileTitleKeyedMap(
          draft.habitStreaks && typeof draft.habitStreaks === 'object' ? draft.habitStreaks : {},
          migratedRecurringRules,
        );
        const migratedHabitStreakUpdatedDate = reconcileTitleKeyedMap(
          draft.habitStreakUpdatedDate && typeof draft.habitStreakUpdatedDate === 'object' ? draft.habitStreakUpdatedDate : {},
          migratedRecurringRules,
        );
        const migratedHabitStrength = reconcileTitleKeyedMap(
          draft.habitStrength && typeof draft.habitStrength === 'object' ? draft.habitStrength : {},
          migratedRecurringRules,
        );

        return {
          isActivated: Boolean(draft.isActivated),
          activatedDate: migratedActivatedDate,
          // NEX-164: backfill the durable first-habit flag for EXISTING users
          // so their next habit log never emits is_first:true. Anyone already
          // activated, with an activation date, or with habit history is
          // established → stamp a non-null value (their activation date, or an
          // epoch sentinel if unknown). Genuinely new installs hydrate from the
          // initial state (null) instead of this migration branch.
          firstHabitCompletedAt:
            typeof draft.firstHabitCompletedAt === 'string'
              ? draft.firstHabitCompletedAt
              : (Boolean(draft.isActivated) || migratedActivatedDate || (Array.isArray(draft.habitLog) && draft.habitLog.length > 0))
                ? (migratedActivatedDate ?? new Date(0).toISOString())
                : null,
          firstActionIntent:
            draft.firstActionIntent === 'complete_habit' || draft.firstActionIntent === 'add_habit'
              ? draft.firstActionIntent
              : null,
          localUserId: typeof draft.localUserId === 'string' ? draft.localUserId : null,
          userProfile: draft.userProfile ?? null,
          modeLabels: {
            ALL: draft.modeLabels?.ALL ?? 'ALL',
            SALES: draft.modeLabels?.SALES ?? 'SALES',
            VISION: draft.modeLabels?.VISION ?? 'VISION',
            FAMILY: draft.modeLabels?.FAMILY ?? 'FAMILY',
          },
          // v17: every existing inbox item gets source: 'manual' so the
          // type narrowing works downstream. Apple Reminders items will
          // arrive with source: 'apple_reminders' from Phase 2 onward.
          inbox: Array.isArray(draft.inbox)
            ? draft.inbox.map((t: any) => ({
                ...t,
                source: t?.source === 'apple_reminders' ? 'apple_reminders' : 'manual',
              }))
            : [],
          // NEX-196: `justCaptured` is INTENTIONALLY not migrated/restored — it
          // is a session-only Home-echo ref (re-derived fresh each capture).
          // Its absence here is by design, not a missing wire-up.
          pillars: Array.isArray(draft.pillars) ? draft.pillars : [],
          orbitDays:
            draft.orbitDays && typeof draft.orbitDays === 'object'
              ? draft.orbitDays
              : {},
          habits: Array.isArray(draft.habits) ? draft.habits : [],
          habitStrength: migratedHabitStrength,
          currentMode:
            draft.currentMode === 'SALES' ||
            draft.currentMode === 'VISION' ||
            draft.currentMode === 'FAMILY'
              ? draft.currentMode
              : 'ALL',
          capacity: draft.capacity === 'RECOVERY' ? 'RECOVERY' : 'PEAK',
          // v14: backfill missing createdAt with 0 (sentinel = "before the
          // dawn of time"). computeHabitProgress treats this as no-clamp,
          // so existing rules show identical % to today's calc — no
          // retroactive penalty. New rules from this version forward stamp
          // Date.now() in addRecurringRule.
          // v16: backfill missing anchor with null. computeAnchorAdherence
          // treats anchor=null as "no drift detection," so existing rules
          // show no spurious anchor-drift flags until users opt in.
          recurringRules: migratedRecurringRules,
          // v15: backfill exceptions = [] on every existing recurring
          // to-do. Pre-v15 rules had no per-day skip mechanism; the
          // empty array means "no skips," so behavior is identical to
          // before for legacy rules.
          recurringToDos: Array.isArray(draft.recurringToDos)
            ? draft.recurringToDos.map((r: any) => ({
                ...r,
                exceptions: Array.isArray(r?.exceptions) ? r.exceptions : [],
              }))
            : [],
          // v22: no-op migration for DailyTask.completedAt (additive/optional).
          // Legacy tasks remain valid with completedAt undefined; tracker
          // falls back to the bucket key for back-compat.
          dailyTasks:
            draft.dailyTasks && typeof draft.dailyTasks === 'object'
              ? draft.dailyTasks
              : {},
          habitLog: migratedHabitLog,
          goalHabitMap: migratedGoalHabitMap,
          nextWeekRuleOverrides:
            draft.nextWeekRuleOverrides && typeof draft.nextWeekRuleOverrides === 'object'
              ? draft.nextWeekRuleOverrides
              : {},
          pendingMondayIntention:
            draft.pendingMondayIntention &&
            typeof draft.pendingMondayIntention === 'object' &&
            typeof draft.pendingMondayIntention.text === 'string' &&
            typeof draft.pendingMondayIntention.targetDateKey === 'string'
              ? draft.pendingMondayIntention
              : null,
          morningIntention: draft.morningIntention ?? null,
          morningIntentionDate: draft.morningIntentionDate ?? null,
          morningIntentionCompletedDate: draft.morningIntentionCompletedDate ?? null,
          weeklyReflection: draft.weeklyReflection ?? null,
          weeklyReflectionDate: draft.weeklyReflectionDate ?? null,
          nightlyForward: draft.nightlyForward ?? null,
          nightlyForwardDate: draft.nightlyForwardDate ?? null,
          dailyScores: draft.dailyScores && typeof draft.dailyScores === 'object' ? draft.dailyScores : {},
          habitStreaks: migratedHabitStreaks,
          habitStreakUpdatedDate: migratedHabitStreakUpdatedDate,
          // NEX-190: additive; backfill {} for everyone. MUST be in this allow-list
          // object or a later version bump silently wipes it (per LEARNINGS).
          milestonesShown: draft.milestonesShown && typeof draft.milestonesShown === 'object' ? draft.milestonesShown : {},
          weeklyWins: Array.isArray(draft.weeklyWins) ? draft.weeklyWins : [],
          weeklyWinsDate: draft.weeklyWinsDate ?? null,
          horizonReviews: Array.isArray(draft.horizonReviews) ? draft.horizonReviews : [],
          lastReviewDates: typeof draft.lastReviewDates === 'object' && draft.lastReviewDates ? draft.lastReviewDates : {},
          dailyWisdomQuotes: Array.isArray(draft.dailyWisdomQuotes) ? draft.dailyWisdomQuotes : [],
          dailyWisdomDate: typeof draft.dailyWisdomDate === 'string' ? draft.dailyWisdomDate : '',
          // Device-local; MUST be in this allow-list or a version bump wipes it
          // (per LEARNINGS). Legacy users land at null → re-rolls once on first
          // Orbit focus only if a win is set today (wisdomIsStale handles it).
          dailyWisdomIntention: typeof draft.dailyWisdomIntention === 'string' ? draft.dailyWisdomIntention : null,
          wisdomQuoteCount:
            draft.wisdomQuoteCount === 0 || draft.wisdomQuoteCount === 1 || draft.wisdomQuoteCount === 3 || draft.wisdomQuoteCount === 5
              ? draft.wisdomQuoteCount
              : 3,
          recentWisdomHistory: Array.isArray(draft.recentWisdomHistory)
            ? draft.recentWisdomHistory.filter(
                (e: any) =>
                  e &&
                  typeof e.quote === 'string' &&
                  typeof e.author === 'string' &&
                  typeof e.dateKey === 'string'
              )
            : [],
          // NEX-171: pinnedHabits is now DERIVED (= non-excluded rule ids) — kept
          // for the native widget + cross-version cloud sync (one release).
          pinnedHabits: deriveActiveHabitIds(migratedRecurringRules),
          hasSeenTutorial: Boolean(draft.hasSeenTutorial),
          // NEX-124: existing users land here with these undefined → false, so
          // they re-fire once under this build (acceptable, dedupes per person).
          firstMandateCommittedFired: Boolean(draft.firstMandateCommittedFired),
          firstAlignmentScoreSeenFired: Boolean(draft.firstAlignmentScoreSeenFired),
          // v20: pre-v20 users land here with strengthenBannerDismissed
          // undefined. Default to false so the catch-up banner CAN
          // surface for them (the whole point of v20). Once they
          // dismiss it via the × button, this stamps true permanently.
          strengthenBannerDismissed: draft.strengthenBannerDismissed === true,
          totalXP: typeof draft.totalXP === 'number' ? draft.totalXP : 0,
          badges: Array.isArray(draft.badges) ? draft.badges : BADGE_DEFINITIONS.map(b => ({ ...b, unlockedAt: null })),
          streakFreezes: typeof draft.streakFreezes === 'number' ? draft.streakFreezes : 1,
          lastFreezeDate: draft.lastFreezeDate ?? null,
          lastOpenDate: draft.lastOpenDate ?? null,
          // NEX-212: device-local launch-hour histogram — MUST be in this
          // allow-list or a version bump silently wipes it (per LEARNINGS).
          appLaunchHourCounts: Array.isArray(draft.appLaunchHourCounts) ? draft.appLaunchHourCounts : [],
          // NEX-308: device-local; MUST be in this allow-list or a version bump
          // silently wipes it (per LEARNINGS). Re-sanitized through the pure
          // reducer so a corrupted persisted write can't pass through.
          suggestionFeedback: recordSuggestionOutcomes(draft.suggestionFeedback, []),
          // device-local; MUST be in this allow-list or a version bump wipes it (per LEARNINGS).
          // sanitizeQuotePool validates the nested arrays/shape so a corrupted write can't pass through.
          quotesPool: sanitizeQuotePool(draft.quotesPool),
          pendingLevelUp: null,
          pendingBadgeUnlock: null,
          pendingBadgeUnlockQueue: [],
          activeChallenge: draft.activeChallenge ?? null,
          completedChallenges: Array.isArray(draft.completedChallenges) ? draft.completedChallenges : [],
          scoreHistory: draft.scoreHistory && typeof draft.scoreHistory === 'object' ? draft.scoreHistory : {},
          notificationSettings: {
            morningHour: draft.notificationSettings?.morningHour ?? 8,
            morningMinute: draft.notificationSettings?.morningMinute ?? 0,
            eveningHour: draft.notificationSettings?.eveningHour ?? 20,
            eveningMinute: draft.notificationSettings?.eveningMinute ?? 0,
            weeklyDay: draft.notificationSettings?.weeklyDay ?? 0,
            weeklyHour: draft.notificationSettings?.weeklyHour ?? 10,
            streakAlerts: draft.notificationSettings?.streakAlerts !== false,
            milestoneAlerts: draft.notificationSettings?.milestoneAlerts !== false,
            quietHoursStart: draft.notificationSettings?.quietHoursStart ?? 22 * 60, // NEX-236
            quietHoursEnd: draft.notificationSettings?.quietHoursEnd ?? 8 * 60,       // NEX-236
            // NEX-212: hand-listed literal has no draft spread, so this key MUST be
            // here or a version bump wipes a user's "off". `!== false` preserves an
            // explicit false and defaults undefined (pre-feature) -> on.
            smartTiming: draft.notificationSettings?.smartTiming !== false,
            // notification quotes: hand-listed literal has no draft spread, so this
            // key MUST be here or a version bump wipes it. Default OFF (`=== true`)
            // so a pre-feature blob (undefined) stays off.
            includeQuotes: draft.notificationSettings?.includeQuotes === true,
            // NEX-277 kill switch — MUST be in this literal or a version bump wipes
            // it. Default ON (`!== false`) so a pre-feature blob (undefined) auto-uses.
            personalizedQuotes: draft.notificationSettings?.personalizedQuotes !== false,
          },
          // NEX-190: opt-in Soft Mode, default off. MUST live in this allow-list
          // object or a later version bump silently wipes it (per LEARNINGS).
          softMode: draft.softMode === true,
          // NEX-210: grain pref — MUST be in this allow-list or a version bump
          // silently wipes it (per LEARNINGS); normalize legacy/garbage values.
          breakdownGrain: normalizeGrain(draft.breakdownGrain),
          // NEX-207: pauseMode MUST live in this allow-list return object or a
          // later version bump silently wipes it (per LEARNINGS). Normalize so a
          // malformed persisted blob defaults to inactive for existing users.
          pauseMode: normalizePauseMode(draft.pauseMode),
          coachThread: sanitizeCoachThread(draft.coachThread),
          // NEX-136 P3: existing users have never consented, so they default
          // to 'unset' and see the first-run prompt once. Only an explicit
          // prior choice survives migration.
          analyticsConsent:
            draft.analyticsConsent === 'granted' || draft.analyticsConsent === 'denied'
              ? draft.analyticsConsent
              : 'unset',
          // Explicit-consent migration: an older boolean is not evidence of a
          // user choice. Existing users remain off until they opt in.
          weeklyEmailConsent: normalizeWeeklyEmailConsent(draft.weeklyEmailConsent),
          weeklyEmailConsentUpdatedAt:
            normalizeWeeklyEmailConsent(draft.weeklyEmailConsent) !== 'unset' &&
            typeof draft.weeklyEmailConsentUpdatedAt === 'number'
              ? draft.weeklyEmailConsentUpdatedAt
              : null,
          weeklyEmailEnabled:
            normalizeWeeklyEmailConsent(draft.weeklyEmailConsent) === 'granted',
          weeklyEmailDay: typeof draft.weeklyEmailDay === 'number' ? draft.weeklyEmailDay : 0,
          mandateFocus: (draft.mandateFocus && typeof draft.mandateFocus === 'object') ? draft.mandateFocus : {},
          // NEX-26: phase 2 — null-default for existing users. Zustand's
          // persist middleware shallow-merges defaults for fields the
          // persisted blob doesn't carry, so this is belt-and-suspenders;
          // it also documents the migration intent next to its sibling
          // fields. No version bump needed — the field is additive and
          // null-defaulted, no transformation of prior state required.
          onboardingRecommendations:
            draft.onboardingRecommendations && typeof draft.onboardingRecommendations === 'object'
              ? draft.onboardingRecommendations
              : null,
          // NEX-162 (v28): additive. Backfill returns [] for everyone (the field
          // is new) but MUST be in this allow-list object or a later version bump
          // would silently wipe it. Idempotent.
          leadTimeActions: backfillLeadTimeActions(draft.leadTimeActions),
        };
      },
    }
  )
);

/**
 * Phase 5 selectors. These mirror the inline filter in
 * app/(tabs)/inbox.tsx so future surfaces don't have to re-derive
 * the rules. The Inbox tab itself still inlines its filter for now
 * (it also keys on the NEW vs ARCHIVED tab state); these are here
 * for the optional "show triaged-skipped" affordance and for
 * future scoring/analytics surfaces that should respect triage.
 */
export function selectActiveInbox(inbox: InboxTask[]): InboxTask[] {
  return inbox.filter((t) => t.status !== 'ARCHIVED' && !t.triagedSkip);
}

export function selectSkippedInbox(inbox: InboxTask[]): InboxTask[] {
  return inbox.filter((t) => t.triagedSkip === true);
}
