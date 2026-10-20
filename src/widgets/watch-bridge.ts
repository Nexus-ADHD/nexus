import { Platform } from 'react-native';
import { getLevel } from '../state/app-state';
import { topHabitByReps } from '../state/selectors/habit-rollup';
import { normalize, stripEmoji } from '../utils/text';

export interface WatchData {
  disciplineScore: number;
  completionPercent: number;
  level: number;
  totalXP: number;
  /** NEX-219: cumulative, non-resetting headline (Law B default). */
  topHabitReps: number;
  topHabitTitle: string;
  /** Soft Mode (opt-in). The breakable-streak fields below are zeroed unless on. */
  softMode: boolean;
  longestStreakDays: number;
  longestStreakHabit: string;
  todayHabits: { title: string; completed: boolean }[];
  topStreaks: { title: string; days: number }[];
  dateLabel: string;
  lastUpdated: number;
}

export function buildWatchData(appState: {
  recurringRules: any[];
  habitLog: any[];
  habitStreaks: Record<string, number>;
  pinnedHabits: string[];
  computeDailyScore: (dateKey: string) => number;
  totalXP?: number;
  /** Required so a missed call site is a compile error (NEX-219). */
  softMode: boolean;
}): WatchData {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const dateKey = `${y}-${m}-${d}`;
  const dateLabel = today.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  // NEX-171: the watch shows the non-excluded (scored) habits.
  // NEX-219: also drop archived rules — the widget/home hide them, and the new
  // cumulative topHabitByReps headline (and todayHabits) must not resurrect an
  // archived habit just because it still carries lifetime reps in recurringRules.
  const rules = (appState.recurringRules ?? []).filter((r: any) => !r?.excludedFromScore && !r?.archived);

  const todayLogEntries = (appState.habitLog ?? [])
    .filter((e: any) => e.dateKey === dateKey);

  // Per-habit completion (binary — matches the row-list semantics of the
  // home chip and widget). A 2×/day habit needs both logs to read as done.
  const todayHabits = rules.map((r: any) => {
    const key = normalize(r.title);
    const required = r.timesPerDay || 1;
    const count = todayLogEntries.filter((e: any) => normalize(e.habitTitle) === key).length;
    return {
      title: stripEmoji(r.title),
      completed: count >= required,
    };
  });

  // Aggregate % counts OCCURRENCES, not rules — a 2×/day habit at 1 of 2
  // contributes 1 to completed / 2 to total, so partial credit shows in
  // the watch ring. Mirrors widget-bridge + home single-day math.
  let totalOccurrences = 0;
  let completedOccurrences = 0;
  rules.forEach((r: any) => {
    const key = normalize(r.title);
    const required = r.timesPerDay || 1;
    const count = todayLogEntries.filter((e: any) => normalize(e.habitTitle) === key).length;
    totalOccurrences += required;
    completedOccurrences += Math.min(required, count);
  });
  const completionPercent = totalOccurrences > 0
    ? Math.round((completedOccurrences / totalOccurrences) * 100)
    : 0;

  const streakEntries = Object.entries(appState.habitStreaks ?? {})
    .map(([title, days]) => ({ title, days: days as number }))
    .sort((a, b) => b.days - a.days);

  const xp = appState.totalXP || 0;
  const softMode = appState.softMode === true;

  // NEX-219: cumulative top habit (lifetime reps) over the same active set the
  // watch already uses (non-excludedFromScore rules). Default surface, Law B.
  const top = topHabitByReps(rules, appState.habitLog);

  return {
    disciplineScore: appState.computeDailyScore(dateKey),
    completionPercent,
    level: getLevel(xp),
    totalXP: xp,
    topHabitReps: top?.reps ?? 0,
    topHabitTitle: stripEmoji(top?.title ?? ''),
    softMode,
    // Law B: the breakable streak is a Soft-Mode-only surface. Zero it otherwise
    // so the default watch payload carries no breakable streak.
    longestStreakDays: softMode ? (streakEntries[0]?.days ?? 0) : 0,
    longestStreakHabit: softMode ? stripEmoji(streakEntries[0]?.title ?? '') : '',
    todayHabits,
    topStreaks: softMode
      ? streakEntries.slice(0, 3).map((entry) => ({ ...entry, title: stripEmoji(entry.title) }))
      : [],
    dateLabel,
    lastUpdated: Date.now(),
  };
}

export async function sendDataToWatch(data: WatchData): Promise<void> {
  if (Platform.OS !== 'ios') return;

  try {
    const { sendMessage, updateApplicationContext } = require('react-native-watch-connectivity');
    const jsonData = JSON.stringify(data);

    try {
      await updateApplicationContext({ nexus_watch_data: jsonData });
    } catch {}

    try {
      sendMessage({ nexus_watch_data: jsonData }, () => {}, () => {});
    } catch {}
  } catch (e) {
    console.warn('[Watch] Watch connectivity not available:', e);
  }
}
