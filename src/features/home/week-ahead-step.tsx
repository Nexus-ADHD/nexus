// NEX-163 — the WEEK AHEAD step of the weekly Horizon Review (forward scan).
// Typed (no @ts-nocheck). Presentational `WeekAheadStep` + a thin fetch hook +
// `WeekAheadStepContainer` (owns the create-sheet + error boundary so the modal's
// wiring diff stays minimal). All date/matching logic lives in the unit-tested
// pure helpers (src/utils/week-ahead.ts); this file is RN/UI + data wiring only.

import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import * as Calendar from 'expo-calendar';
import * as Sentry from '@sentry/react-native';
import tokens from '@/src/theme/tokens';
import { ambientGlowSoft } from '@/src/theme/glow';
import { useAppState, type OrbitEvent } from '@/src/state/app-state';
import { type LeadTimeAction, formatKeyShortWithWeekday } from '@/src/state/lead-time-types';
import { selectLeadTimeRollup } from '@/src/state/selectors/lead-time';
import { LeadTimeCreateSheet, type LeadTimePrefill } from '@/src/components/lead-time/LeadTimeCreateSheet';
import { fetchConnectedCalendarEventsWindow } from '@/src/services/calendar-events';
import { useCalendarSourcesStore } from '@/src/state/calendar-sources-store';
import { getLocalDateKey } from '@/src/utils/recurrence';
import {
  addDaysKey,
  eventsNeedingLeadTime,
  groupEventsByWeek,
  projectEventDateKey,
  thisWeekEvents,
  type WeekAheadEvent,
} from '@/src/utils/week-ahead';

const FURTHER_WEEKS = 5; // FURTHER OUT covers weeks 2–6

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(dateKey: string): string {
  const [, m, d] = dateKey.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}
function weekRangeLabel(startKey: string, endKey: string): string {
  return `${shortDate(startKey)} – ${shortDate(endKey)}`;
}

// ─── fetch hook ───────────────────────────────────────────────────────────────
// Awaits external-calendar store hydration before any syncWindow (a cold modal
// otherwise sees accounts=[] and wipes the live window — Codex), then fetches the
// 6-week window with a NON-prompting permission check.
function useWeekAheadEvents(todayKey: string): {
  events: WeekAheadEvent[];
  loading: boolean;
  calendarDenied: boolean;
} {
  const orbitDays = useAppState((s) => s.orbitDays) as Record<string, OrbitEvent[]>;
  const [calEvents, setCalEvents] = useState<WeekAheadEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [calendarDenied, setCalendarDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const persist = useCalendarSourcesStore.persist;
        if (persist && !persist.hasHydrated()) {
          await new Promise<void>((resolve) => {
            let done = false;
            let timer: ReturnType<typeof setTimeout>;
            let unsub: (() => void) | undefined;
            const finish = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              unsub?.();
              resolve();
            };
            unsub = persist.onFinishHydration(finish);
            timer = setTimeout(finish, 3000); // 3s cap so we never hang on hydration
          });
        }
        const perm = await Calendar.getCalendarPermissionsAsync();
        const includeApple = perm.status === 'granted';
        if (cancelled) return;
        setCalendarDenied(!includeApple);

        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setDate(end.getDate() + 6 + FURTHER_WEEKS * 7);
        end.setHours(23, 59, 59, 999);

        const events = await fetchConnectedCalendarEventsWindow({ startDate: start, endDate: end, includeApple });
        if (cancelled) return;
        setCalEvents(
          events.map((e) => ({
            // Namespace the id: calendar and manual OrbitEvent ids come from
            // different generators and could collide, which would mean duplicate
            // React keys AND a mis-keyed coverage Set. eventId stays raw (the
            // corroborator). See code-review WARN.
            id: `cal:${e.id}`,
            title: e.title,
            dateKey: projectEventDateKey(e.startISO, e.allDay),
            eventId: e.id,
          })),
        );
      } catch {
        if (!cancelled) setCalendarDenied(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // todayKey is stable for the life of the modal; fetch once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const manualEvents = useMemo<WeekAheadEvent[]>(() => {
    const endKey = addDaysKey(todayKey, 6 + FURTHER_WEEKS * 7);
    const out: WeekAheadEvent[] = [];
    for (const [dateKey, evs] of Object.entries(orbitDays ?? {})) {
      if (dateKey < todayKey || dateKey > endKey) continue;
      for (const ev of evs ?? []) {
        out.push({ id: `man:${ev.id}`, title: ev.title, dateKey, eventId: ev.id });
      }
    }
    return out;
  }, [orbitDays, todayKey]);

  const events = useMemo(() => [...calEvents, ...manualEvents], [calEvents, manualEvents]);
  return { events, loading, calendarDenied };
}

// ─── presentational step ────────────────────────────────────────────────────
interface WeekAheadStepProps {
  events: WeekAheadEvent[];
  leadTimeActions: LeadTimeAction[];
  todayKey: string;
  loading: boolean;
  calendarDenied: boolean;
  onAttach: (event: WeekAheadEvent) => void;
  onDone: () => void;
}

export function WeekAheadStep({
  events,
  leadTimeActions,
  todayKey,
  loading,
  calendarDenied,
  onAttach,
  onDone,
}: WeekAheadStepProps) {
  const rollup = useMemo(() => selectLeadTimeRollup(leadTimeActions, todayKey), [leadTimeActions, todayKey]);
  const week = useMemo(() => thisWeekEvents(events, todayKey), [events, todayKey]);
  const further = useMemo(() => groupEventsByWeek(events, todayKey, FURTHER_WEEKS), [events, todayKey]);
  const needing = useMemo(
    () => new Set(eventsNeedingLeadTime(events, leadTimeActions).map((e) => e.id)),
    [events, leadTimeActions],
  );

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={tokens.color.teal} />
        <Text style={styles.quiet}>Reading the weeks ahead.</Text>
      </View>
    );
  }

  return (
    <>
      <Text style={styles.stepTitle}>THE WEEK AHEAD</Text>

      <Text style={styles.sectionHeader}>THIS WEEK</Text>
      <View style={[styles.card, ambientGlowSoft]}>
        {week.length === 0 && rollup.surfacing.length === 0 ? (
          <Text style={styles.quiet}>Nothing scheduled in the next seven days.</Text>
        ) : (
          <>
            {week.map((e) => (
              <View key={e.id} style={styles.row}>
                <Text style={styles.rowDate}>{formatKeyShortWithWeekday(e.dateKey)}</Text>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {e.title}
                </Text>
              </View>
            ))}
            {rollup.surfacing.map((a) => (
              <View key={a.id} style={styles.row}>
                <Text style={[styles.rowDate, styles.dueLabel]}>{a.status === 'overdue' ? 'OVERDUE' : 'DUE'}</Text>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {a.title}
                </Text>
              </View>
            ))}
          </>
        )}
      </View>

      <Text style={styles.sectionHeader}>FURTHER OUT</Text>
      {calendarDenied && <Text style={styles.quiet}>Connect a calendar to scan the weeks beyond this one.</Text>}
      {further.length === 0 ? (
        <Text style={styles.quiet}>Nothing waits further out.</Text>
      ) : (
        further.map((bucket) => (
          <View key={bucket.weekStartKey} style={[styles.card, ambientGlowSoft]}>
            <Text style={styles.weekLabel}>{weekRangeLabel(bucket.weekStartKey, bucket.weekEndKey)}</Text>
            {bucket.events.map((e) => (
              <View key={e.id} style={styles.row}>
                <Text style={styles.rowDate}>{formatKeyShortWithWeekday(e.dateKey)}</Text>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {e.title}
                </Text>
                {needing.has(e.id) && (
                  <Pressable hitSlop={8} style={styles.attach} onPress={() => onAttach(e)}>
                    <Text style={styles.attachText}>LEAD TIME</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        ))
      )}

      <Pressable style={styles.btn} onPress={onDone}>
        <Text style={styles.btnText}>DONE →</Text>
      </Pressable>
    </>
  );
}

// ─── error boundary ───────────────────────────────────────────────────────────
// The parent modal's render try/catch does NOT catch a throw inside this subtree
// (Codex #7). Quiet fallback + an always-available exit.
class WeekAheadErrorBoundary extends React.Component<
  { onExit: () => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    // Swallow for UX — the step is non-critical; the user can still close the
    // review. NEX-269: still report to Sentry (no-op when uninitialized) so a
    // silently-failing step is observable.
    Sentry.captureException(error);
  }
  render() {
    if (this.state.failed) {
      return (
        <View>
          <Text style={styles.quiet}>The week ahead could not be loaded.</Text>
          <Pressable style={styles.btn} onPress={this.props.onExit}>
            <Text style={styles.btnText}>DONE →</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

// ─── container (data + sheet + boundary) ──────────────────────────────────────
export function WeekAheadStepContainer({ onDone }: { onDone: () => void }) {
  const todayKey = getLocalDateKey(new Date());
  const leadTimeActions = useAppState((s) => s.leadTimeActions) as LeadTimeAction[];
  const { events, loading, calendarDenied } = useWeekAheadEvents(todayKey);
  const [sheet, setSheet] = useState<{ visible: boolean; prefill: LeadTimePrefill | null }>({
    visible: false,
    prefill: null,
  });

  const onAttach = (e: WeekAheadEvent) =>
    setSheet({ visible: true, prefill: { eventTitle: e.title, eventDate: e.dateKey, eventId: e.eventId ?? null } });

  return (
    <WeekAheadErrorBoundary onExit={onDone}>
      <WeekAheadStep
        events={events}
        leadTimeActions={leadTimeActions ?? []}
        todayKey={todayKey}
        loading={loading}
        calendarDenied={calendarDenied}
        onAttach={onAttach}
        onDone={onDone}
      />
      <LeadTimeCreateSheet
        visible={sheet.visible}
        prefill={sheet.prefill}
        onClose={() => setSheet({ visible: false, prefill: null })}
      />
    </WeekAheadErrorBoundary>
  );
}

const card: ViewStyle = {
  backgroundColor: tokens.color.surface,
  borderWidth: 1,
  borderColor: tokens.color.goldHairline,
  borderRadius: 16,
  padding: 16,
  marginBottom: tokens.spacing.md,
};

const styles = StyleSheet.create({
  loading: { alignItems: 'center', paddingVertical: 48, gap: 12 },
  stepTitle: {
    color: tokens.color.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
    marginBottom: tokens.spacing.md,
  },
  sectionHeader: {
    color: tokens.color.textMuted,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 2,
    marginTop: tokens.spacing.sm,
    marginBottom: tokens.spacing.sm,
  },
  card,
  weekLabel: {
    color: tokens.color.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.8,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 12 },
  rowDate: {
    color: tokens.color.textMuted,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    width: 96, // fits "Wed, Jun 24" (weekday added — NEX-271); was 64 for "Jun 24"
  },
  dueLabel: { color: tokens.color.gold, fontWeight: '700', letterSpacing: 0.5 },
  rowTitle: { color: tokens.color.textSecondary, fontSize: 15, flex: 1 },
  attach: {
    borderWidth: 1,
    borderColor: tokens.color.gold,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  attachText: { color: tokens.color.gold, fontSize: 11, fontWeight: '600', letterSpacing: 1.2 },
  btn: {
    backgroundColor: tokens.color.text,
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: tokens.spacing.md,
  },
  btnText: { color: tokens.color.textInverse, fontSize: 16, fontWeight: '600' },
  quiet: { color: tokens.color.textMuted, fontSize: 14, lineHeight: 20 },
});
