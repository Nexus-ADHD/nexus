// src/utils/ai-context.ts
// Builds a rich context string from app state for AI prompts
// Used by: Morning Brief, Pulse, Weekly Debrief, Horizon Reviews, Quotes

import { useAppState } from '../state/app-state';
import { normalize, stripEmoji } from './text';
import { isPausedOn } from '../state/pause-mode';
import { topHabitByReps } from '../state/selectors/habit-rollup';
import { formatMandatesForPrompt } from '../ai/mandate-prompt-context';

// NEX-224: match rule titles to log titles emoji-robustly (normalize + stripEmoji on
// both sides), so a log whose stored title drifts from the current rule title by emoji
// ("Meditate" vs "Meditate 🧘") is still counted. Matches the completion logic elsewhere.
const matchKey = (t: unknown): string => normalize(stripEmoji(String(t ?? '')));

function getLocalDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface PatternData {
  // User
  name: string;
  todayKey: string;
  dayOfWeek: string;

  // Habits
  pinnedHabitNames: string[];
  habitPatterns: string; // "Read: 6/7 days, skipped Saturday. Meditation: 7/7 days."
  todayHabitProgress: string; // "3 of 5 habits done"

  // Tasks
  pendingTasks: string;
  completedTasks: number;
  totalTasks: number;

  // Score
  todayScore: number | null;
  yesterdayScore: number | null;
  weekAvgScore: number | null;
  bestDayThisWeek: string; // "Wednesday (92)"
  worstDayThisWeek: string; // "Tuesday (34)"

  // Mandates
  mandatesSummary: string; // "BUSINESS: 4 mandates. PERSONAL: 3. VISION: 2."
  /** NEX-307: the mandates themselves — title, category, and the user's own
   *  "why" (Pillar.notes), bounded. One per line; '' when there are none. */
  mandatesDetail: string;

  // Cumulative (NEX-224: replaces the breakable "longest streak")
  topHabitReps: string; // "Meditation (142 reps)"

  // Reviews
  lastReviewSummary: string;

  // Intention
  todayIntention: string;

  // Full context string for AI
  contextString: string;
}

export function buildAIContext(): PatternData {
  const state = (useAppState as any).getState() as any;
  const now = new Date();
  const todayKey = getLocalDateKey(now);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = days[now.getDay()];
  const name = state.userProfile?.name || '';
  // NEX-207: while paused, the AI must never frame missed days as lapses
  // (Law C). Paused days are dropped from the 7-day pattern, and the at-risk /
  // weakest-day shame surfaces are suppressed while actively paused.
  const pauseMode = state.pauseMode;
  const pausedNow = !!pauseMode?.active;

  // ─── Habit patterns (last 7 days) ───
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoKey = getLocalDateKey(sevenDaysAgo);

  const recentLogs = (state.habitLog || []).filter((e: any) => e.dateKey >= sevenDaysAgoKey && e.dateKey <= todayKey);

  // NEX-171: the "active" (scored, non-excluded) habits for AI context.
  // NEX-224: also drop archived habits — a retired habit must not appear in
  // habitPatterns / pinnedHabitNames or inflate the "X of N habits done" denominator
  // (the AI would treat archived work as current expected progress). Matches the
  // widget/score active set.
  const pinnedRules = (state.recurringRules || []).filter((r: any) => !r?.excludedFromScore && !r?.archived);

  const pinnedHabitNames = pinnedRules.map((r: any) => r.title);

  const habitPatterns = pinnedRules.map((rule: any) => {
    const key = matchKey(rule.title);
    const required = rule.timesPerDay || 1;
    const dayLogs: Record<string, number> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dk = getLocalDateKey(d);
      // NEX-207: paused days are not in the window — so the denominator below is
      // non-paused days (a fully-paused week reads "paused", never "0/7 days").
      if (isPausedOn(dk, pauseMode)) continue;
      dayLogs[dk] = recentLogs.filter((e: any) => matchKey(e.habitTitle) === key && e.dateKey === dk).length;
    }
    const windowDays = Object.keys(dayLogs).length;
    const daysLogged = Object.values(dayLogs).filter(v => v >= required).length;
    const missedDays = Object.entries(dayLogs)
      .filter(([, v]) => v < required)
      .map(([dk]) => days[new Date(dk + 'T12:00:00').getDay()])
      .slice(0, 2);
    // NEX-224: no `, N-day streak` suffix (Law B — no breakable streak as a default signal).
    let pattern = windowDays > 0 ? `${rule.title}: ${daysLogged}/${windowDays} days` : `${rule.title}: paused`;
    if (missedDays.length > 0 && missedDays.length < 4) pattern += `, skipped ${missedDays.join(' & ')}`;
    return pattern;
  }).join('. ');

  // NEX-224: "at-risk streaks" removed entirely — "(8d) — not logged today" is a
  // breakable-streak / count-an-absence frame (Law C). yesterdayKey is still needed
  // for the yesterday score below.
  const yesterdayKey = getLocalDateKey(new Date(now.getTime() - 86400000));

  // Today's habit progress
  const todayLogs = recentLogs.filter((e: any) => e.dateKey === todayKey);
  // NEX-224: count only logs for ACTIVE habits (the pinnedRules set), so the
  // numerator can't exceed the denominator — e.g. a habit logged then archived the
  // same day must not read "2 of 1 habits done". Uses matchKey (emoji-robust) so a
  // completed habit with emoji title drift is still counted.
  const pinnedKeys = new Set(pinnedRules.map((r: any) => matchKey(r.title)));
  const uniqueHabitsToday = new Set(
    todayLogs.map((e: any) => matchKey(e.habitTitle)).filter((k: string) => pinnedKeys.has(k))
  ).size;
  // NEX-207: on a paused day this must not read as "0 of N habits done" (a
  // missed-day verdict the AI could echo). A planned break has no daily target.
  const todayHabitProgress = isPausedOn(todayKey, pauseMode)
    ? 'paused (planned break)'
    : `${uniqueHabitsToday} of ${pinnedRules.length} habits done`;

  // ─── Tasks ───
  const todayTasks = (state.dailyTasks ?? {})[todayKey] ?? [];
  const completedTasks = todayTasks.filter((t: any) => t.completed).length;
  const pendingTasks = todayTasks.filter((t: any) => !t.completed).map((t: any) => t.title).join(', ');

  // ─── Scores ───
  // NEX-207: a paused day has no score to report (Law C).
  const todayScore = isPausedOn(todayKey, pauseMode) ? null : (state.dailyScores?.[todayKey] ?? null);
  const yesterdayScore = isPausedOn(yesterdayKey, pauseMode) ? null : (state.dailyScores?.[yesterdayKey] ?? null);

  const weekScores: [string, number][] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dk = getLocalDateKey(d);
    const score = state.dailyScores?.[dk];
    // NEX-207: paused days don't enter the avg / best / weakest-day computation.
    if (typeof score === 'number' && !isPausedOn(dk, pauseMode)) weekScores.push([dk, score]);
  }
  const weekAvgScore = weekScores.length > 0
    ? Math.round(weekScores.reduce((a, [, s]) => a + s, 0) / weekScores.length)
    : null;
  const bestDay = weekScores.length > 0
    ? weekScores.reduce((a, b) => b[1] > a[1] ? b : a)
    : null;
  const worstDay = weekScores.length > 0
    ? weekScores.reduce((a, b) => b[1] < a[1] ? b : a)
    : null;
  const bestDayThisWeek = bestDay ? `${days[new Date(bestDay[0] + 'T12:00:00').getDay()]} (${bestDay[1]})` : '';
  const worstDayThisWeek = worstDay ? `${days[new Date(worstDay[0] + 'T12:00:00').getDay()]} (${worstDay[1]})` : '';

  // ─── Mandates ───
  const pillars = state.pillars || [];
  const byCat: Record<string, number> = {};
  pillars.forEach((p: any) => {
    const cat = (p.category || 'PERSONAL').toUpperCase();
    byCat[cat] = (byCat[cat] || 0) + 1;
  });
  const mandatesSummary = Object.entries(byCat).map(([cat, n]) => `${cat}: ${n}`).join('. ');

  // NEX-307: the count alone ("BUSINESS: 4. PERSONAL: 3") told the model nothing
  // it could act on — not even the titles. Send the actual mandates with the
  // user's own "why" (Pillar.notes), bounded + sanitized by the shared module
  // since notes are untrusted, cloud-synced free text. This feeds IN-APP
  // surfaces only (morning brief, wisdom, voice journal); notification quotes
  // deliberately stay titles-only — see mandate-prompt-context.ts for why.
  const mandatesDetail = formatMandatesForPrompt(pillars);

  // ─── Most reps (cumulative, never-resetting) ───
  // NEX-224: replaces the breakable "longest streak". Reuses pinnedRules (the
  // !excludedFromScore && !archived active set) so the headline can't name a habit
  // absent from the rest of the context.
  const top = topHabitByReps(pinnedRules, state.habitLog);
  const topHabitReps = top ? `${top.title} (${top.reps} reps)` : '';

  // ─── Last review ───
  const lastReview = Array.isArray(state.horizonReviews) && state.horizonReviews.length > 0
    ? state.horizonReviews[0]
    : null;
  const lastReviewSummary = lastReview
    ? `Last ${lastReview.cadence} review (${lastReview.periodLabel}): ${(lastReview.summary || '').slice(0, 100)}`
    : '';

  // ─── Intention ───
  const todayIntention = state.morningIntentionDate === todayKey ? (state.morningIntention || '') : '';

  // ─── Build full context string ───
  const parts = [];
  if (name) parts.push(`Name: ${name}`);
  parts.push(`Today: ${dayOfWeek}, ${todayKey}`);
  // NEX-207: tell the model this is a chosen break — never a lapse to recover
  // from, never an absence to count (Law C). Forward-looking framing only.
  if (pausedNow) parts.push('Status: Pause Mode active (a planned break). Do not frame missed days as lapses or count an absence; expectations are paused.');
  if (todayIntention) parts.push(`Today's intention: "${todayIntention}"`);
  if (habitPatterns) parts.push(`Habit patterns (7d): ${habitPatterns}`);
  parts.push(`Today: ${todayHabitProgress}`);
  if (pendingTasks) parts.push(`Pending tasks: ${pendingTasks}`);
  if (todayScore !== null) parts.push(`Today's score: ${todayScore}/100`);
  if (yesterdayScore !== null) parts.push(`Yesterday: ${yesterdayScore}/100`);
  if (weekAvgScore !== null) parts.push(`7-day avg: ${weekAvgScore}/100`);
  if (bestDayThisWeek) parts.push(`Best day: ${bestDayThisWeek}`);
  if (worstDayThisWeek && worstDayThisWeek !== bestDayThisWeek) parts.push(`Weakest day: ${worstDayThisWeek}`);
  if (topHabitReps) parts.push(`Most reps: ${topHabitReps}`);
  if (mandatesSummary) parts.push(`Mandates: ${mandatesSummary}`);
  // Multi-line block, so it goes last — the rest of contextString is one
  // sentence-joined line and a newline block mid-string would read as noise.
  if (mandatesDetail) parts.push(`Their mandates:\n${mandatesDetail}`);

  return {
    name,
    todayKey,
    dayOfWeek,
    pinnedHabitNames,
    habitPatterns,
    todayHabitProgress,
    pendingTasks,
    completedTasks,
    totalTasks: todayTasks.length,
    todayScore,
    yesterdayScore,
    weekAvgScore,
    bestDayThisWeek,
    worstDayThisWeek,
    mandatesSummary,
    /** NEX-307: titles + capped notes, '' when there are no active mandates. */
    mandatesDetail,
    topHabitReps,
    lastReviewSummary,
    todayIntention,
    contextString: parts.join('. ') + '.',
  };
}

// The AI persona used across all AI calls. Canonical text lives in
// src/ai/prompts.js (single source shared with the Node eval harness);
// re-exported here so existing importers stay unchanged.
export { AI_PERSONA } from '@/src/ai/prompts';
