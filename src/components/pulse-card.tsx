import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { haptic } from '@/src/utils/haptics';
import { useAppState } from '../state/app-state';
import { chatCompletion } from '../utils/ai-client';
// NEX-305: name the tier explicitly instead of riding the shared default.
import { MODELS } from '../utils/ai-models';
import tokens from '@/src/theme/tokens';
import { buildHomeCalloutSystem } from '@/src/ai/prompts';

// The Pulse system prompt (today-only persona + signal-density state machine)
// is canonical in src/ai/prompts.js as buildHomeCalloutSystem(todayStr). It is
// deliberately narrower than AI_PERSONA in ai-context.ts — that one boasts
// "I've watched your entire week"; this one only sees today.

const GOLD = tokens.color.gold;
const TEXT_COLOR = tokens.color.text;
const MUTED = tokens.color.textMuted;

interface PulseAction {
  type: string;
  title: string;
  dateStr?: string;
  daysOfWeek?: number[];
  time?: string;
}

export interface PulseRec {
  text: string;
  action?: PulseAction;
}

interface StoreActions {
  addDailyTask: (title: string, dateStr?: string) => void;
  addRecurringRule: (title: string, days: number[], time: string | null, block: null, cat: string, extra: null) => void;
  addInboxTask: (title: string) => void;
}

function getStoreActions(): StoreActions {
  return (useAppState as { getState: () => StoreActions }).getState();
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseRecommendation(r: unknown): PulseRec {
  if (typeof r === 'string') return { text: r };
  if (r && typeof r === 'object' && 'text' in r) {
    const obj = r as Record<string, unknown>;
    return { text: String(obj.text ?? ''), action: obj.action as PulseAction | undefined };
  }
  return { text: String(r) };
}

// Hard-cap firstMove length so Home's CTA card never shows a mid-sentence
// ellipsis. Prefers cutting at a sentence boundary (period / em-dash) within
// the first 60 chars; falls back to a word boundary cut. The Pulse system
// prompt asks for ≤40 chars; this is the safety net for when the model overshoots.
function capFirstMove(s: string): string {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed.length <= 60) return trimmed;
  const slice = trimmed.slice(0, 60);
  // Try sentence/clause boundaries first, in priority order.
  const boundaries = ['. ', '! ', '? ', ' — ', '; ', ': ', ', '];
  for (const b of boundaries) {
    const idx = slice.lastIndexOf(b);
    if (idx >= 20) {
      // Strip the boundary punctuation so the visible string ends cleanly.
      return slice.slice(0, idx).replace(/[.,;:!?\s—]+$/, '').trim();
    }
  }
  // No clean boundary — cut at last word.
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= 20) return slice.slice(0, lastSpace).trim();
  // No space (single very long word) — accept the slice as-is.
  return slice.trim();
}

export function PulseCard({ autoLoad = false }: { autoLoad?: boolean } = {}) {
  const [pulse, setPulse] = useState<PulseRec[]>([]);
  const [pulseLoading, setPulseLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const didAutoLoad = React.useRef(false);

  const generatePulse = useCallback(async () => {
    try {
      setPulseLoading(true);
      setExpanded(false);
      const todayStr = getTodayKey();

      // ── Today-only context ─────────────────────────────────────────────
      // Pulse intentionally builds its own context (instead of consuming
      // buildAIContext from ai-context.ts) so the LLM can NEVER reference
      // yesterday, the 7-day average, weakest day, longest streaks, or any
      // other past data. Those fields are how "yesterday's stats appearing
      // as today's" creeps in.
      //
      // FUTURE-ME: any momentum-aware Pulse feature ("on a roll", streak
      // acknowledgments, "back at it") needs a deliberately-scoped lookback
      // added HERE — don't reach back into buildAIContext. Keep the scope
      // explicit and narrow so the next bug stays caught.
      const liveState = (useAppState as any).getState() as any;
      const todayLogs = (Array.isArray(liveState.habitLog) ? liveState.habitLog : [])
        .filter((e: any) => e?.dateKey === todayStr);
      const todayHabitsDone = new Set(todayLogs.map((e: any) => e.habitTitle)).size;

      // Filter pinned habits to only those scheduled today — fixes the
      // "0 of 5 done" misleading count on weekday-only habits running on
      // a weekend. The denominator the LLM sees must reflect today's
      // schedule, not the user's full habit roster.
      const dow = new Date().getDay();
      const recurringRules = Array.isArray(liveState.recurringRules) ? liveState.recurringRules : [];
      const pinnedScheduled = recurringRules.filter(
        (r: any) =>
          !r?.excludedFromScore &&
          Array.isArray(r?.daysOfWeek) &&
          r.daysOfWeek.includes(dow)
      );

      const todayIntention =
        liveState.morningIntentionDate === todayStr ? (liveState.morningIntention || '') : '';
      const todayTasks = Array.isArray((liveState.dailyTasks ?? {})[todayStr])
        ? liveState.dailyTasks[todayStr]
        : [];
      const tasksDone = todayTasks.filter((t: any) => t?.completed).length;

      // Signal density drives the state machine in the system prompt.
      const hasIntention = !!todayIntention;
      const hasHabitLogs = todayHabitsDone > 0;
      const hasTaskActivity = tasksDone > 0 || todayTasks.length > 0;
      const signalsToday =
        (hasIntention ? 1 : 0) + (hasHabitLogs ? 1 : 0) + (hasTaskActivity ? 1 : 0);

      const dayName = new Date().toLocaleDateString(undefined, { weekday: 'long' });
      const todayContext = [
        `Today is ${dayName}.`,
        hasIntention ? `Intention set: "${todayIntention}".` : 'Intention: not set yet.',
        pinnedScheduled.length > 0
          ? `Habits scheduled today: ${pinnedScheduled.length}. Logged so far: ${todayHabitsDone}.`
          : 'No habits scheduled today.',
        todayTasks.length > 0
          ? `Tasks today: ${tasksDone} done of ${todayTasks.length}.`
          : 'No tasks added yet.',
        `Signal density: ${signalsToday}/3.`,
      ].join(' ');

      const systemPrompt = buildHomeCalloutSystem(todayStr);

      const raw = await chatCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: todayContext },
      ], { model: MODELS.DAILY_PULSE });

      if (!raw) { console.log('[Pulse] Empty response'); return; }
      const cleaned = raw.replace(/```[a-z]*/g, '').replace(/```/g, '').trim();
      const parsed: unknown = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object' && 'recommendations' in parsed) {
        const recs = (parsed as { recommendations: unknown[] }).recommendations;
        if (Array.isArray(recs)) {
          const parsedRecs = recs.slice(0, 3).map(parseRecommendation);
          setPulse(parsedRecs);
          // Persist the top recommendation for Home's "Today's move" line.
          // Untyped setState matches the existing morningBriefItems pattern;
          // Home reads liveState.pulseToday with the same loose typing.
          //
          // Defensive cap: the system prompt asks for ≤40 chars, but models
          // overshoot. Hard-cap at 60 chars and truncate at the LAST sentence
          // boundary (period/em-dash/comma) to avoid mid-sentence ellipsis on
          // the Home CTA card. If no boundary lands ≤60, cut at last word.
          const rawMove = parsedRecs[0]?.text?.trim() ?? '';
          const firstMove = capFirstMove(rawMove);
          if (firstMove) {
            (useAppState as any).setState({
              pulseToday: { dateKey: todayStr, firstMove },
            });
          }
        }
      }
    } catch (e) { console.log('[Pulse] Error:', e); } finally { setPulseLoading(false); }
  }, []);

  React.useEffect(() => {
    if (autoLoad && !didAutoLoad.current) {
      didAutoLoad.current = true;
      generatePulse();
    }
  }, [autoLoad, generatePulse]);

  const executePulseAction = (rec: PulseRec) => {
    if (!rec.action) return;
    const liveState = getStoreActions();
    const { type, title, dateStr, daysOfWeek, time } = rec.action;
    try {
      if (type === 'todo_add' && dateStr) {
        liveState.addDailyTask(title, dateStr);
        haptic('voiceSuccess');
      } else if (type === 'todo_add' && !dateStr) {
        liveState.addDailyTask(title);
        haptic('voiceSuccess');
      } else if (type === 'recurring_add') {
        liveState.addRecurringRule(title, daysOfWeek ?? [0,1,2,3,4,5,6], time ?? null, null, 'PERSONAL', null);
        haptic('voiceSuccess');
      } else if (type === 'inbox_add') {
        liveState.addInboxTask(title);
        haptic('voiceSuccess');
      } else if (type === 'habit_add') {
        liveState.addRecurringRule(title, daysOfWeek ?? [0,1,2,3,4,5,6], null, null, 'PERSONAL', null);
        haptic('voiceSuccess');
      } else {
        liveState.addDailyTask(title);
        haptic('voiceSuccess');
      }
      setPulse((prev) => prev.filter((r) => r.text !== rec.text));
      Alert.alert('Added', `"${title}" has been added.`);
    } catch (e) {
      Alert.alert('Error', 'Could not add this item. Try again.');
    }
  };

  return (
    <View style={styles.pulseCard}>
      <View style={styles.pulseHeader}>
        <Text style={styles.sectionLabel}>PULSE</Text>
        <Pressable onPress={generatePulse} disabled={pulseLoading}>
          <Text style={styles.editLink}>{pulseLoading ? '···' : 'REFRESH'}</Text>
        </Pressable>
      </View>
      {pulseLoading ? (
        <ActivityIndicator color={GOLD} size="small" style={{ marginTop: tokens.spacing.xxs }} />
      ) : pulse.length > 0 ? (
        <>
          {(expanded ? pulse : pulse.slice(0, 1)).map((rec, i) => (
            <Pressable key={i} style={({ pressed }) => [styles.pulseItem, pressed && { opacity: 0.7 }]}
              onPress={() => rec.action && executePulseAction(rec)}>
              <Text style={styles.pulseDot}>◆</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.pulseText}>{rec.text}</Text>
                {rec.action && <Text style={styles.pulseTapHint}>TAP TO ADD →</Text>}
              </View>
            </Pressable>
          ))}
          {pulse.length > 1 && (
            <Pressable
              onPress={() => setExpanded((v) => !v)}
              hitSlop={8}
              style={({ pressed }) => [styles.viewAllRow, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.viewAllLink}>
                {expanded ? 'COLLAPSE' : `VIEW ALL (${pulse.length})`}
              </Text>
            </Pressable>
          )}
        </>
      ) : (
        <Text style={styles.mutedText}>Tap REFRESH to get your daily intelligence briefing.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pulseCard: {
    // FIXME(nex-56): teal-tinted near-black bg, no token (pulse gets its own semantic tint) — design review
    backgroundColor: tokens.color.surface,
    borderRadius: 20,
    borderWidth: 1,
    // FIXME(nex-56): teal-dark tint border, no token — design review
    borderColor: tokens.color.tealWash,
    // FIXME(nex-56): off-scale 20pt padding + 14pt margin — design review
    padding: 20,
    marginBottom: 14,
  },
  // FIXME(nex-56): off-scale 10pt margin — design review
  pulseHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  // FIXME(nex-56): off-scale 9pt fontSize + 10pt margin — design review
  sectionLabel: { color: MUTED, fontSize: 9, fontWeight: '900', letterSpacing: 3, marginBottom: 10 },
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  editLink: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 2 },
  // FIXME(nex-56): off-scale 14pt margin + 10pt gap — design review
  pulseItem: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14, gap: 10 },
  // FIXME(nex-56): off-scale 8pt fontSize + 5pt margin — design review
  pulseDot: { color: GOLD, fontSize: 8, marginTop: 5 },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  pulseText: { color: TEXT_COLOR, fontSize: 14, lineHeight: 21 },
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  pulseTapHint: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 1.5, marginTop: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  mutedText: { color: MUTED, fontSize: 14 },
  viewAllRow: { marginTop: tokens.spacing.xxs, paddingVertical: tokens.spacing.xxs, alignSelf: 'flex-start' },
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  viewAllLink: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 2 },
});
