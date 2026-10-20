/**
 * Widget bridge — JS → App Group → Swift.
 *
 * Self-correcting snapshot model:
 *   The previous shape pre-computed completion %, dateLabel, etc.
 *   in JS at write time. If the app didn't open the next day, iOS
 *   would still call the widget's getTimeline on schedule and read
 *   the same frozen JSON, so the widget showed yesterday's date and
 *   yesterday's completion until the next launch.
 *
 *   This file now writes RAW INPUTS to the App Group. Swift derives
 *   today's view at render time using Date(), so the snapshot is
 *   self-correcting across midnight. The Swift side runs an
 *   identical filter loop that mirrors what JS used to do at write
 *   time — see deriveTodayView in NexusWidget.swift.
 */
import * as Device from 'expo-device';
import { Platform, NativeModules } from 'react-native';
import { getLevel, useAppState } from '../state/app-state';
import { deriveActiveHabitIds } from '../state/score-inclusion';
import { computeLifetimeReps } from '../state/selectors/habit-rollup';
import { trimWidgetPayload, hasRenderableWidgetContent, pickWidgetQuote } from './widget-payload-trim';

// Expo Go / simulator bypass — same pattern as RevenueCat.
// SharedGroupPreferences is not linked in Expo Go, so every
// native-bridge call no-ops here.
const SIM_BYPASS = __DEV__ && !Device.isDevice;

const _bypassLogged = new Set<string>();
function logBypassOnce(fn: string): void {
  if (_bypassLogged.has(fn)) return;
  _bypassLogged.add(fn);
  console.log('[WidgetBridge] SIM bypass — skipping');
}

const APP_GROUP = 'group.com.jhuff.nexus';

let _SharedGroupPreferences: any = null;
async function getSharedGroupPreferences(): Promise<any> {
  if (_SharedGroupPreferences) return _SharedGroupPreferences;
  if (Platform.OS !== 'ios') return null;
  try {
    _SharedGroupPreferences = (await import('react-native-shared-group-preferences')).default;
    return _SharedGroupPreferences;
  } catch {
    return null;
  }
}

export const updateWidgetData = async (data: object): Promise<void> => {
  if (SIM_BYPASS) { logBypassOnce('updateWidgetData'); return; }
  try {
    const SGP = await getSharedGroupPreferences();
    if (!SGP) return;
    await SGP.setItem('widgetData', JSON.stringify(data), APP_GROUP);
    console.log('[WidgetBridge] Written to App Group successfully');
    try {
      await NativeModules.WidgetReloader?.reloadAll();
      console.log('[WidgetBridge] WidgetKit timelines reloaded');
    } catch (e) {
      console.warn('[WidgetBridge] reloadAll failed:', e);
    }
  } catch (e) {
    console.error('[WidgetBridge] Failed to write to App Group:', e);
  }
};

// ─── Raw shape (matches Swift RawWidgetData) ─────────────────────────────────

export interface RawWidgetData {
  recurringRules: {
    id: string;
    title: string;
    timesPerDay: number;
    /** NEX-267: weekly schedule (0=Sun … 6=Sat) so the widget counts only today's habits. */
    daysOfWeek: number[];
    archived: boolean;
    /** NEX-219: lifetime reps; Swift picks the max-reps rule as the cumulative headline. */
    reps: number;
    /** Widget daily-score: per-rule score-inclusion flag (NEX-171). Shipping it
     * natively disambiguates "user excluded EVERY habit" from "legacy snapshot
     * with empty pinnedHabits" — Swift prefers this over the pinnedHabits shim
     * when present (NEX-171b). */
    excludedFromScore: boolean;
  }[];
  /** Local "YYYY-MM-DD" date keys. NEX-268: today's entries only (the widget
   * uses this for today's completion; lifetime reps live on recurringRules). */
  habitLog: { date: string; habitTitle: string }[];
  /** IDs (with title fallback for legacy snapshots). */
  pinnedHabits: string[];
  recurringToDos: {
    id: string;
    title: string;
    daysOfWeek: number[]; // 0=Sun … 6=Sat
    interval: number; // 1=weekly, 2=biweekly
    intervalAnchorDate: string | null; // YYYY-MM-DD
    archived: boolean;
    // NEX-306: per-day skip exceptions (YYYY-MM-DD). Swift must drop a rule
    // whose exceptions include today, mirroring the app's selectTodayTaskRollup
    // (today-rollup.ts). Without this the widget shows to-dos the user skipped.
    exceptions: string[];
  }[];
  /** Keyed by "YYYY-MM-DD" local. NEX-268: today + tomorrow keys only. */
  dailyTasks: Record<string, { id?: string; title: string; completed: boolean }[]>;
  /** NEX-268: pending only (`!completed && status != "ARCHIVED" && !triagedSkip`), capped. */
  inbox: { title: string; completed: boolean; status?: string; triagedSkip?: boolean }[];
  /** Today + tomorrow window, raw ISO timestamps. Swift filters by startISO > now. */
  events: { title: string; startISO: string }[];
  habitStreaks: Record<string, number | { days: number; title?: string }>;
  /** NEX-219: Soft Mode (opt-in). Swift shows the breakable streak only when true. */
  softMode: boolean;
  totalXP: number;
  /** Pre-computed via getLevel() so Swift doesn't need to port the curve. */
  level: number;
  /** Widget daily-score: today's win text + its date key. Swift scores the
   * 33-point intention factor only when morningIntentionDate == todayKey at
   * RENDER time (raw-inputs contract — the score self-corrects at midnight). */
  morningIntention: string | null;
  morningIntentionDate: string | null; // YYYY-MM-DD
  /** The day's shortest wisdom quote, pre-picked by pickWidgetQuote (null when
   * Today's Wisdom is disabled or nothing well-formed exists). Swift shows it
   * only when dailyWisdomDate == todayKey at render time. */
  dailyQuote: { quote: string; author: string | null } | null;
  dailyWisdomDate: string; // YYYY-MM-DD, '' when never generated
  /** Epoch ms — write-time only; not used by Swift derivation. */
  lastUpdated: number;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoToLocalDateKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Already a YYYY-MM-DD key.
  if (DATE_KEY_RE.test(value)) return value;
  // Otherwise treat as ISO and project to LOCAL date.
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

/**
 * Builds the raw snapshot. Pure normalizer — no filtering by today,
 * no aggregation, no formatting. Swift does all of that at render
 * time so the widget rolls over correctly at midnight without an
 * app launch.
 */
export function buildWidgetData(params: {
  recurringRules: any[];
  habitLog: any[];
  habitStreaks: Record<string, number | { days: number; title?: string }>;
  pinnedHabits: string[];
  totalXP: number;
  inbox: any[];
  recurringToDos: any[];
  dailyTasks: Record<string, any[]>;
  /** Today + tomorrow window, raw event objects with at least { title, startISO }. */
  events: any[];
  /** NEX-219: required so a missed call site is a TS compile error. */
  softMode: boolean;
  /** Widget daily-score: required for the same reason — all three call sites
   * (here, home-screen's widget effect, syncWidgetDataDeferred) must pass them. */
  morningIntention: string | null;
  morningIntentionDate: string | null;
  /** Raw store quotes + count; the single widget quote is derived here via
   * pickWidgetQuote (handles wisdomQuoteCount === 0 and malformed entries). */
  dailyWisdomQuotes: any[];
  dailyWisdomDate: string;
  wisdomQuoteCount: number;
}): RawWidgetData {
  if (SIM_BYPASS) {
    logBypassOnce('buildWidgetData');
    return {
      recurringRules: [],
      habitLog: [],
      pinnedHabits: [],
      recurringToDos: [],
      dailyTasks: {},
      inbox: [],
      events: [],
      habitStreaks: {},
      softMode: false,
      totalXP: 0,
      level: 1,
      morningIntention: null,
      morningIntentionDate: null,
      dailyQuote: null,
      dailyWisdomDate: '',
      lastUpdated: Date.now(),
    };
  }

  const {
    recurringRules,
    habitLog,
    habitStreaks,
    pinnedHabits,
    totalXP,
    inbox,
    recurringToDos,
    dailyTasks,
    events,
    softMode,
    morningIntention,
    morningIntentionDate,
    dailyWisdomQuotes,
    dailyWisdomDate,
    wisdomQuoteCount,
  } = params;

  // Recurring rules (habits): keep only what Swift needs to derive
  // completion. archived defaults to false (existing schema has no
  // archive flag yet — the field is forward-compat).
  const rules = (Array.isArray(recurringRules) ? recurringRules : [])
    .filter((r: any) => r && typeof r.id === 'string' && typeof r.title === 'string')
    .map((r: any) => ({
      id: String(r.id),
      title: String(r.title),
      timesPerDay: typeof r.timesPerDay === 'number' && r.timesPerDay >= 1 ? r.timesPerDay : 1,
      // NEX-267: send the habit's weekly schedule so the widget counts only
      // TODAY's habits (it previously counted every rule on every day). Mirrors
      // the recurringToDos payload below. 0=Sun … 6=Sat.
      daysOfWeek: Array.isArray(r.daysOfWeek)
        ? r.daysOfWeek.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [],
      archived: r.archived === true,
      // NEX-219: lifetime reps from the RAW log (computeLifetimeReps reads only
      // habitTitle, so the un-projected log is correct and counts every entry).
      reps: computeLifetimeReps(r, habitLog),
      // NEX-171b: ship the score-inclusion flag natively so Swift can tell
      // "every habit excluded" apart from "legacy empty pinnedHabits".
      excludedFromScore: r.excludedFromScore === true,
    }));

  // Habit log: project to LOCAL "YYYY-MM-DD". Existing entries use
  // dateKey (preferred) or a legacy ISO timestamp under various
  // field names — coerce both.
  const log = (Array.isArray(habitLog) ? habitLog : [])
    .map((e: any) => {
      if (!e || typeof e !== 'object') return null;
      const date = isoToLocalDateKey(e.dateKey ?? e.date ?? e.timestamp);
      const title = String(e.habitTitle ?? '').trim();
      if (!date || !title) return null;
      return { date, habitTitle: title };
    })
    .filter((x): x is { date: string; habitTitle: string } => !!x);

  // NEX-171: the widget's "active set" = non-excluded rule ids, derived from
  // the per-rule flag (not the legacy pinnedHabits param). Swift filters these
  // by its own schedule at render for midnight rollover. (Phase 2 / NEX-171b
  // updates Swift to read excludedFromScore directly and drop this shim.)
  void pinnedHabits;
  const pinned = deriveActiveHabitIds(recurringRules);

  // Recurring to-dos: keep daysOfWeek + interval + anchor for Swift's
  // biweekly math. archived field is forward-compat (schema has none yet).
  const toDos = (Array.isArray(recurringToDos) ? recurringToDos : [])
    .filter((r: any) => r && typeof r.id === 'string' && typeof r.title === 'string')
    .map((r: any) => ({
      id: String(r.id),
      title: String(r.title),
      daysOfWeek: Array.isArray(r.daysOfWeek)
        ? r.daysOfWeek.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [],
      interval: typeof r.interval === 'number' && r.interval >= 1 ? r.interval : 1,
      intervalAnchorDate: typeof r.intervalAnchorDate === 'string' ? r.intervalAnchorDate : null,
      archived: r.archived === true,
      // NEX-306: pass per-day skip exceptions through so Swift can honor them.
      // Keep only well-formed date keys (the app writes YYYY-MM-DD; guard anyway
      // since this crosses into a native decoder).
      exceptions: Array.isArray(r.exceptions)
        ? r.exceptions.filter((d: any) => typeof d === 'string' && DATE_KEY_RE.test(d))
        : [],
    }));

  // dailyTasks: pass through the dateKey → tasks map. Drop any non-
  // standard date keys to keep Swift's lookup simple.
  const tasks: Record<string, { id?: string; title: string; completed: boolean }[]> = {};
  if (dailyTasks && typeof dailyTasks === 'object') {
    for (const [key, list] of Object.entries(dailyTasks)) {
      if (!DATE_KEY_RE.test(key) || !Array.isArray(list)) continue;
      tasks[key] = list
        .filter((t: any) => t && typeof t.title === 'string')
        .map((t: any) => ({
          id: typeof t.id === 'string' ? t.id : undefined,
          title: String(t.title),
          completed: t.completed === true,
        }));
    }
  }

  const inboxOut = (Array.isArray(inbox) ? inbox : [])
    .filter((i: any) => i && typeof i.title === 'string')
    .map((i: any) => ({
      title: String(i.title),
      completed: i.completed === true,
      status: typeof i.status === 'string' ? i.status : undefined,
      // NEX-268: carry the skip flag (only when set) so trimWidgetPayload drops
      // skipped items — the app hides triagedSkip from the active inbox
      // (app-state activeInbox / home-screen), so the widget must too.
      ...(i.triagedSkip === true ? { triagedSkip: true as const } : {}),
    }));

  // Events: strip down to title + startISO. Swift filters by
  // startISO > now() at render time — this is what makes the
  // "3pm event vanishes after 3pm" behavior automatic.
  const eventsOut = (Array.isArray(events) ? events : [])
    .filter((e: any) => e && typeof e.title === 'string' && typeof e.startISO === 'string')
    .map((e: any) => ({ title: String(e.title), startISO: String(e.startISO) }));

  // Single clock read shared by lastUpdated and the trim's todayKey, so the
  // snapshot timestamp and the "today" it's trimmed to can't straddle midnight.
  const now = new Date();
  const data: RawWidgetData = {
    recurringRules: rules,
    habitLog: log,
    pinnedHabits: pinned,
    recurringToDos: toDos,
    dailyTasks: tasks,
    inbox: inboxOut,
    events: eventsOut,
    habitStreaks: habitStreaks ?? {},
    softMode: softMode === true,
    totalXP: typeof totalXP === 'number' ? totalXP : 0,
    level: getLevel(typeof totalXP === 'number' ? totalXP : 0),
    morningIntention: typeof morningIntention === 'string' && morningIntention.trim()
      ? morningIntention
      : null,
    morningIntentionDate:
      typeof morningIntentionDate === 'string' && DATE_KEY_RE.test(morningIntentionDate)
        ? morningIntentionDate
        : null,
    dailyQuote: pickWidgetQuote(dailyWisdomQuotes, wisdomQuoteCount),
    dailyWisdomDate: typeof dailyWisdomDate === 'string' ? dailyWisdomDate : '',
    lastUpdated: now.getTime(),
  };

  // NEX-268: trim to today-relevant data LAST — after `reps` is computed from
  // the full log above — so a heavy user's months-deep history isn't shipped
  // into the widget extension's ~30MB budget (it was OOM-killing the extension,
  // leaving the widget stuck on its blank placeholder).
  return trimWidgetPayload(data, now);
}

/**
 * Best-effort post-mutation widget sync. Reads current state and
 * writes a fresh raw snapshot. Used after habit completes,
 * inbox additions, etc. — same call sites as before.
 */
export function syncWidgetAfterMutation(): void {
  if (SIM_BYPASS) { logBypassOnce('syncWidgetAfterMutation'); return; }
  setTimeout(() => {
    try {
      const s = (useAppState as any).getState() as any;

      // Today + tomorrow event window. Merges two sources:
      //   - orbitDays:        user-created events stored on the dayKey map
      //   - appleEventsWindow: Apple Calendar events fetched by home-screen
      //                       and lifted into the store (NEX-45) so this
      //                       function can see them. Before NEX-45, this
      //                       path wrote events:[] for Apple-only users,
      //                       and last-write-wins clobbered home-screen's
      //                       merged snapshot.
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const tom = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const tomorrowKey = `${tom.getFullYear()}-${String(tom.getMonth() + 1).padStart(2, '0')}-${String(tom.getDate()).padStart(2, '0')}`;
      const orbitDays = s.orbitDays ?? {};
      const appleEventsWindow = Array.isArray(s.appleEventsWindow) ? s.appleEventsWindow : [];
      const events = [
        ...((orbitDays?.[todayKey] ?? []) as any[]),
        ...((orbitDays?.[tomorrowKey] ?? []) as any[]),
        ...appleEventsWindow,
      ];

      // NEX-306: this used to gate on "has at least one active recurringRule",
      // which silently skipped every widget write for a user with to-dos but no
      // habits — including the move-a-one-off sync added in this change. Widen
      // to "has anything renderable", INCLUDING the composed events (the widget
      // renders those too, so a calendar-only user must get a write). Checked
      // after composition so the guard tests exactly what is about to be
      // written. An un-hydrated store still reads false, so the cold-launch
      // protection (don't clobber a good snapshot with an empty payload) is
      // preserved. Predicate is pure + unit-tested.
      if (!hasRenderableWidgetContent(s, events)) return;

      updateWidgetData(buildWidgetData({
        recurringRules: s.recurringRules ?? [],
        habitLog: Array.isArray(s.habitLog) ? s.habitLog : [],
        habitStreaks: s.habitStreaks ?? {},
        pinnedHabits: s.pinnedHabits ?? [],
        totalXP: s.totalXP ?? 0,
        inbox: s.inbox ?? [],
        recurringToDos: s.recurringToDos ?? [],
        dailyTasks: s.dailyTasks ?? {},
        events,
        softMode: s.softMode === true,
        morningIntention: s.morningIntention ?? null,
        morningIntentionDate: s.morningIntentionDate ?? null,
        dailyWisdomQuotes: Array.isArray(s.dailyWisdomQuotes) ? s.dailyWisdomQuotes : [],
        dailyWisdomDate: typeof s.dailyWisdomDate === 'string' ? s.dailyWisdomDate : '',
        wisdomQuoteCount: typeof s.wisdomQuoteCount === 'number' ? s.wisdomQuoteCount : 3,
      }));
    } catch {}
  }, 300);
}
