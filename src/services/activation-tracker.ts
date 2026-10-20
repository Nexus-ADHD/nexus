// Activation event tracker for NEX-17.
//
// Activation event (per nexus-gtm-playbook.md, updated 2026-05-11):
//   "logged habits AND cleared at least one to-do on three consecutive
//    days within the trial."
//
// This module derives that predicate from app-state. It subscribes to
// the Zustand store (cheap — Zustand's subscribe is a shallow notifier)
// and recomputes on every state change. When the predicate first goes
// true we fire `activation_completed` exactly once and persist a marker
// so a re-launch doesn't double-fire.
//
// Why a derived tracker rather than a counter incremented at log time?
// Because users complete to-dos and log habits via half a dozen seams
// (voice, manual checkbox, drag-to-clear, swipe-action…) and at least
// one path — Apple Reminders sync — fills the inbox with already-
// completed items the tracker should not credit. Computing from the
// canonical state is the only path that doesn't drift.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  trackEvent,
  getActivationFiredAt,
  markActivationFired,
  recordBaselineActivation,
} from './analytics';

// Local copy of the date-key helper so this module doesn't import
// app-state (which would create a cycle — app-state may want to call
// into the tracker some day).
const localDateKey = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppStateSnapshot {
  isActivated?: boolean;
  activatedDate?: string | null;
  habitLog?: Array<{ dateKey: string }>;
  inbox?: Array<{ completed?: boolean; createdAt?: number; completedAt?: number }>;
  dailyTasks?: Record<string, Array<{ completed?: boolean; completedAt?: number }>>;
}

interface TrackerHandle {
  stop: () => void;
}

// Module-level state. The root layout mounts a single tracker; if it's
// already running, `start` is a no-op.
let activeHandle: TrackerHandle | null = null;
let lastFireAttempted = false;

// ─── Predicate ────────────────────────────────────────────────────────────────

/**
 * Compute the set of date keys (YYYY-MM-DD) that "qualify" — i.e. the
 * user logged ≥1 habit AND cleared ≥1 to-do on that day, AND the day
 * falls inside the trial window starting from `activatedDate`.
 *
 * Trial window: the day of activation through today, inclusive. The
 * acceptance criterion phrases this as "within the trial" — for the
 * baseline-rate measurement that's "since the user started," which is
 * what activatedDate marks. The 14-day cap matches the standard trial
 * length; if it ever changes we widen the window here.
 */
const TRIAL_WINDOW_DAYS = 14;

export function computeQualifyingDays(state: AppStateSnapshot): string[] {
  const startISO = state.activatedDate;
  if (!startISO) return [];

  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) return [];

  const trialEnd = new Date(start);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_WINDOW_DAYS);
  const today = new Date();
  const windowEnd = today < trialEnd ? today : trialEnd;

  // Habit-log day index.
  const habitDays = new Set<string>();
  for (const entry of state.habitLog ?? []) {
    if (entry?.dateKey) habitDays.add(entry.dateKey);
  }

  // To-do-cleared day index. Two sources:
  //   1. inbox items the user marked `completed: true` — credit the
  //      `completedAt` timestamp (stamped by toggleInboxTask on the
  //      false→true transition; NEX-26 phase F.5). If completedAt is
  //      missing (legacy item created before phase F.5, or an Apple-
  //      sync completion that never went through toggleInboxTask),
  //      we SKIP the item rather than fall back to createdAt. Under-
  //      crediting is safer than crediting the wrong day silently —
  //      the activation predicate is "3 consecutive days WITHIN the
  //      trial," and a stale createdAt would let the trial day itself
  //      satisfy day 2 and day 3, which is wrong.
  //   2. materialized daily-task completions — `dailyTasks[k][i].completed`.
  //      Prefer per-task completedAt when present (v22), else fall back
  //      to the bucket key `k` for legacy/back-compat tasks.
  const todoDays = new Set<string>();

  for (const item of state.inbox ?? []) {
    if (item?.completed && item.completedAt) {
      todoDays.add(localDateKey(new Date(item.completedAt)));
    }
  }

  for (const [dateKey, tasks] of Object.entries(state.dailyTasks ?? {})) {
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      if (!task?.completed) continue;
      if (task.completedAt) {
        todoDays.add(localDateKey(new Date(task.completedAt)));
      } else {
        todoDays.add(dateKey);
      }
    }
  }

  // Qualifying day = both sets contain the same key AND key is inside window.
  const startKey = localDateKey(start);
  const endKey = localDateKey(windowEnd);

  const qualifying: string[] = [];
  for (const day of habitDays) {
    if (!todoDays.has(day)) continue;
    if (day < startKey || day > endKey) continue;
    qualifying.push(day);
  }
  qualifying.sort();
  return qualifying;
}

/**
 * Return true iff `days` contains 3 consecutive YYYY-MM-DD keys.
 *
 * "Consecutive" = calendar-adjacent days. We don't try to handle DST;
 * a date-key compare against (d+1) is sufficient since keys are local
 * dates and the rollover boundary is unambiguous.
 */
export function hasThreeConsecutive(days: string[]): boolean {
  if (days.length < 3) return false;
  const sorted = [...days].sort();
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T12:00:00');
    const cur = new Date(sorted[i] + 'T12:00:00');
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    if (diffDays === 1) {
      run++;
      if (run >= 3) return true;
    } else if (diffDays > 1) {
      run = 1;
    }
  }
  return false;
}

// ─── Subscription ─────────────────────────────────────────────────────────────

interface ZustandStoreLike {
  getState: () => AppStateSnapshot;
  subscribe: (listener: () => void) => () => void;
}

let lastQualifyingSnapshot: string[] = [];

// Days already reported, persisted. Without this every cold launch re-derived the
// qualifying days from state and re-emitted all of them (up to 14 per launch): 8,482
// events from one device in the 2026-10-11 PostHog audit, for what should be ~1/day.
const KEY_EMITTED_DAYS = 'nexus_activation_qualifying_days_emitted_v1';
let emittedDays: Set<string> | null = null;

async function loadEmittedDays(): Promise<Set<string>> {
  if (emittedDays) return emittedDays;
  let loaded: Set<string>;
  try {
    const raw = await AsyncStorage.getItem(KEY_EMITTED_DAYS);
    const arr = raw ? JSON.parse(raw) : [];
    loaded = new Set(Array.isArray(arr) ? arr.filter((d) => typeof d === 'string') : []);
  } catch {
    loaded = new Set();
  }
  // A concurrent evaluate may have installed the set while we awaited; keep that one.
  if (!emittedDays) emittedDays = loaded;
  return emittedDays;
}

async function evaluate(store: ZustandStoreLike): Promise<void> {
  if (lastFireAttempted) return; // already attempted this session
  const state = store.getState();
  if (!state.isActivated) return;

  const emitted = await loadEmittedDays();
  const qualifying = computeQualifyingDays(store.getState());

  // Emit per-day events as new qualifying days appear. The set diff
  // keeps this idempotent on rapid state changes.
  let emittedNew = false;
  for (const day of qualifying) {
    if (!lastQualifyingSnapshot.includes(day) && !emitted.has(day)) {
      // Add synchronously, before any await, so concurrent evaluates can't both emit.
      emitted.add(day);
      emittedNew = true;
      void trackEvent('activation_qualifying_day', { dateKey: day });
    }
  }
  lastQualifyingSnapshot = qualifying;
  if (emittedNew) {
    AsyncStorage.setItem(KEY_EMITTED_DAYS, JSON.stringify([...emitted])).catch(() => {});
  }

  if (!hasThreeConsecutive(qualifying)) return;

  const alreadyFired = await getActivationFiredAt();
  if (alreadyFired) {
    lastFireAttempted = true;
    return;
  }

  lastFireAttempted = true;
  const ts = Date.now();
  await markActivationFired(ts);
  await recordBaselineActivation(ts);
  void trackEvent('activation_completed', {
    qualifyingDays: qualifying.slice(-3).join(','),
    daysFromActivation: state.activatedDate
      ? Math.round((ts - new Date(state.activatedDate).getTime()) / 86400000)
      : -1,
  });
}

/**
 * Mount the tracker. Safe to call repeatedly — only the first call
 * subscribes. Returns a handle the caller can use to tear it down,
 * which in practice is unnecessary (the tracker lives for the lifetime
 * of the app process).
 */
export function startActivationTracker(store: ZustandStoreLike): TrackerHandle {
  if (activeHandle) return activeHandle;

  // Run once at mount to catch a returning user whose state already
  // qualifies — without this they'd never see activation fire post-
  // install since the subscription only triggers on state changes.
  void evaluate(store);

  const unsubscribe = store.subscribe(() => {
    void evaluate(store);
  });

  activeHandle = {
    stop: () => {
      unsubscribe();
      activeHandle = null;
      lastFireAttempted = false;
      lastQualifyingSnapshot = [];
      emittedDays = null;
    },
  };
  return activeHandle;
}

// Test-only escape hatch. Not exported from the public surface.
export function __resetForTests(): void {
  if (activeHandle) activeHandle.stop();
  activeHandle = null;
  lastFireAttempted = false;
  lastQualifyingSnapshot = [];
  emittedDays = null;
}
