/**
 * Mandate detail screen — first-class object view for a single
 * pillar (mandate). Reached by tapping any mandate card on the
 * Align tab.
 *
 * Five sections, top to bottom:
 *   1. Header — back chevron, category label, title.
 *   2. Strengthen — inline AI suggestion engine (same as the sheet
 *      uses; embedded directly here, no Modal).
 *   3. Linked habits — recurringRules tied to this pillar via
 *      goalHabitMap. Title + unlink × per row.
 *   4. Linked to-dos — incomplete dailyTasks where pillarId matches.
 *      Created by the Strengthen flow's "this week" Add.
 *   5. Notes — auto-saving multiline input via updatePillarNotes.
 *   + Footer — edit title (inline replace), delete (confirmation).
 *   (A-3 / NEX-203: no completion toggle, no progress %/score, no streak
 *    badge — a mandate is steady identity fact, never a scorecard.)
 *
 * Architecture note: the screen subscribes to pillars / recurringRules /
 * goalHabitMap / dailyTasks so every section updates live as the user adds
 * via Strengthen or unlinks a habit. There's no manual refresh logic.
 * A-3 (NEX-203): no habit streaks / completion % / completion verdict are
 * surfaced here — a mandate is steady identity fact, never a scorecard.
 */
// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import tokens from '../../src/theme/tokens';
import { AdaptiveScreen } from '../../src/components/ui/AdaptiveScreen';
import { ambientGlow } from '../../src/theme/glow';
import { haptic } from '../../src/utils/haptics';
import { PrimaryPill } from '../../src/components/ui/PrimaryPill';
import { useAppState } from '../../src/state/app-state';
import { MandateStrengthenInline } from '../../src/components/mandate-strengthen-sheet';
import { useLiveTranscription } from '../../src/features/command/use-live-transcription';
import { normalize, stripEmoji } from '../../src/utils/text';
import { formatDaysOfWeek } from '../../src/features/onboarding/format-days-of-week';
import { StatusBarScrim } from '../../src/components/ui/StatusBarScrim';
import { releaseMandateDetailNavigationGuard } from '../../src/utils/mandate-navigation';

const GOLD = tokens.color.gold;
const TEXT_COLOR = tokens.color.text;
const MUTED = tokens.color.textMuted;
// FIXME(nex-56): off-scale gray for TextInput placeholders, no token — design review
// Same pattern as PLACEHOLDER_COLOR (d403ff4) and PLACEHOLDER_COLOR_DARK (5082e4d, 997148f).
const DIM = tokens.color.textDisabled;
// FIXME(nex-56): page background uses bare-black; table maps to textInverse (text-use) — design review (per orbit.tsx + align.tsx precedent)
const BG = tokens.color.voidDeep;
const SURFACE = tokens.color.void;
const BORDER = tokens.color.surfaceElevated;

// FIXME(nex-56): mandate category-color palette — 3 semantic colors (gold/blue/purple),
// design review needed (CLAUDE.md doesn't define a category-color system).
// Duplicated from app/(tabs)/align.tsx — surface-pass should consolidate to a shared
// constants module when proposing category.business/vision/personal tokens.
// Per-entry FIXMEs below satisfy the canonical 3-line proximity gate.
const CATEGORY_COLORS: Record<string, string> = {
  // FIXME(nex-56): category-palette gold (business) — see palette block above
  BUSINESS: tokens.color.gold,
  // FIXME(nex-56): category-palette blue (vision) — see palette block above
  VISION: tokens.color.stateInfo,
  // FIXME(nex-56): category-palette purple (personal) — see palette block above
  PERSONAL: tokens.color.nebulaMagenta,
};

// FIXME(nex-56): defers to the category palette FIXME above. All consumers
// (header category text, top-bar completion text, todo checkbox active state)
// resolve through this function — single point of token migration when the
// palette is reviewed.
function getCatColor(cat?: string): string {
  return CATEGORY_COLORS[(cat ?? 'BUSINESS').toUpperCase()] ?? GOLD;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface LinkedHabit {
  id: string;
  title: string;
}

interface LinkedTodo {
  id: string;
  title: string;
  dateKey: string;
  completed: boolean;
}

// NEX-60: recurring intentions tied to this mandate via RecurringToDo.pillarId.
// Stamped at commitActivation when onboarding's recurringTodos bucket routes
// through addRecurringToDoForPillar. Manual recurring to-dos leave pillarId
// undefined and never appear here.
interface LinkedRecurringTodo {
  id: string;
  title: string;
  daysOfWeek: number[];
}

export default function MandateDetailScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const params = useLocalSearchParams<{ id: string }>();
  const id = String(params.id ?? '');
  const backingOutRef = useRef(false);
  const backGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isFocused) releaseMandateDetailNavigationGuard(id);
  }, [isFocused, id]);

  useEffect(
    () => () => {
      if (backGuardTimerRef.current) clearTimeout(backGuardTimerRef.current);
    },
    [],
  );

  // ── Live subscriptions ────────────────────────────────────────────
  // Each slice is read independently so changes elsewhere (Strengthen
  // sheet adds, habit completions on Orbit, etc.) flow into this
  // screen without manual refresh.
  const pillars = useAppState((s: any) => s.pillars);
  const recurringRules = useAppState((s: any) => s.recurringRules);
  const goalHabitMap = useAppState((s: any) => s.goalHabitMap);
  const dailyTasks = useAppState((s: any) => s.dailyTasks);
  // NEX-60: live subscription to the recurringToDos slice. Filtered by
  // pillarId === id in linkedRecurringTodos below.
  const recurringToDos = useAppState((s: any) => s.recurringToDos);

  // NEX-76: each action via its own selector so this screen doesn't
  // subscribe to the entire store. The previous bare `useAppState()`
  // destructure re-rendered the screen on every state mutation
  // anywhere in the app (habit toggles on Orbit, Pulse refreshes,
  // orb state changes, etc.) — compounding with slow mounts to
  // produce the freeze users tapped-through. Action references are
  // stable across renders so each selector returns the same fn.
  const updatePillarManual = useAppState((s: any) => s.updatePillarManual);
  const updatePillarNotes = useAppState((s: any) => s.updatePillarNotes);
  const deletePillar = useAppState((s: any) => s.deletePillar);
  const unlinkHabitFromGoal = useAppState((s: any) => s.unlinkHabitFromGoal);
  const toggleDailyTask = useAppState((s: any) => s.toggleDailyTask);
  const deleteDailyTask = useAppState((s: any) => s.deleteDailyTask);
  const deleteRecurringToDo = useAppState((s: any) => s.deleteRecurringToDo);
  // A-3 (NEX-203): the identity screen does not consume getGoalStats / habitLog /
  // habitStreaks — no completion %/score or streak verdict on a mandate.

  const pillar = useMemo(
    () => (Array.isArray(pillars) ? pillars.find((p: any) => p?.id === id) : null),
    [pillars, id],
  );

  const category = String(pillar?.category ?? 'BUSINESS').toUpperCase();
  const catColor = getCatColor(category);

  // ── Linked habits ────────────────────────────────────────────────
  // A recurring rule is "linked" to this pillar when this pillar's
  // id appears in goalHabitMap[normalize(rule.title)]. We walk
  // recurringRules for the source-of-truth list of habits and check
  // membership in O(rules) — simpler than reverse-mapping.
  const linkedHabits: LinkedHabit[] = useMemo(() => {
    if (!Array.isArray(recurringRules)) return [];
    const out: LinkedHabit[] = [];
    for (const r of recurringRules) {
      if (!r?.id || !r?.title) continue;
      const key = normalize(r.title);
      const ids = (goalHabitMap ?? {})[key] ?? [];
      if (!ids.includes(id)) continue;
      out.push({
        id: String(r.id),
        title: String(r.title),
      });
    }
    return out;
  }, [recurringRules, goalHabitMap, id]);

  // ── Linked to-dos ────────────────────────────────────────────────
  // Walk every dateKey in dailyTasks and pull tasks whose pillarId
  // matches. Sort by dateKey ascending so today comes first; older
  // dangling tasks (rare) follow.
  const linkedTodos: LinkedTodo[] = useMemo(() => {
    if (!dailyTasks || typeof dailyTasks !== 'object') return [];
    const out: LinkedTodo[] = [];
    for (const dateKey of Object.keys(dailyTasks)) {
      const list = dailyTasks[dateKey];
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        if (!t?.id || t?.pillarId !== id) continue;
        out.push({
          id: String(t.id),
          title: String(t.title ?? ''),
          dateKey,
          completed: !!t.completed,
        });
      }
    }
    out.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    return out;
  }, [dailyTasks, id]);

  // ── Linked recurring (NEX-60) ────────────────────────────────────
  // RecurringToDo entries with pillarId === this pillar. Stamped at
  // commitActivation when the onboarding recurringTodos bucket routes
  // through addRecurringToDoForPillar. Manual recurring to-dos leave
  // pillarId undefined and never appear here.
  const linkedRecurringTodos: LinkedRecurringTodo[] = useMemo(() => {
    if (!Array.isArray(recurringToDos)) return [];
    const out: LinkedRecurringTodo[] = [];
    for (const r of recurringToDos) {
      if (!r?.id || r?.pillarId !== id) continue;
      out.push({
        id: String(r.id),
        title: String(r.title ?? ''),
        daysOfWeek: Array.isArray(r.daysOfWeek) ? r.daysOfWeek : [],
      });
    }
    return out;
  }, [recurringToDos, id]);

  // ── Progress stats ───────────────────────────────────────────────
  // A-3 (NEX-203): no 7-/30-day completion % on the identity screen — a
  // mandate is steady fact, never a scorecard. (getGoalStats stays in the
  // store; it is just not consumed here.)

  // ── Editing state ────────────────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState<string>(String(pillar?.notes ?? ''));

  // Sync notesDraft when the pillar object changes (e.g. switching
  // mandates while this route is somehow stacked, or initial load).
  React.useEffect(() => {
    setNotesDraft(String(pillar?.notes ?? ''));
  }, [pillar?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── NEX-77: voice-to-text for the NOTES field ────────────────────
  // Reuses the same useLiveTranscription hook the orb uses on Command
  // and onboarding. The audio-session handling lives in <VoiceOrb>'s
  // mixWithOthers config (Command tab) — on this screen there's no
  // orb mounted, so the hook attaches the recognizer cleanly.
  //
  // Append-don't-overwrite: noteVoiceBaseRef captures the notes value
  // at the moment the user tapped to start speaking. Every interim
  // update writes base + sep + transcript. On stop we lock in the
  // final transcript (with belt-and-suspenders fallbacks).
  const noteVoice = useLiveTranscription();
  const noteVoiceBaseRef = useRef<string | null>(null);
  const micPulse = useSharedValue(1);

  // Pulse the mic while listening — opacity drifts 1 → 0.5 → 1 every
  // ~800ms via withRepeat. Settles back to 1 on stop.
  useEffect(() => {
    if (noteVoice.isRecognizing) {
      micPulse.value = withRepeat(
        withTiming(0.5, { duration: 400, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      micPulse.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) });
    }
  }, [noteVoice.isRecognizing, micPulse]);

  const micAnimStyle = useAnimatedStyle(() => ({
    opacity: micPulse.value,
  }));

  // Stream interim transcript into the notes field while listening.
  // Append after a separator so existing notes aren't clobbered.
  useEffect(() => {
    if (!noteVoice.isRecognizing) return;
    const base = noteVoiceBaseRef.current ?? '';
    const live = noteVoice.finalTranscript || noteVoice.interimTranscript;
    if (!live) return;
    const sep = base.length > 0 && !base.endsWith(' ') ? ' ' : '';
    setNotesDraft(base + sep + live);
  }, [noteVoice.interimTranscript, noteVoice.finalTranscript, noteVoice.isRecognizing]);

  const handleMicTap = useCallback(async () => {
    if (noteVoice.isRecognizing) {
      await noteVoice.stop();
      const final =
        noteVoice.finalTranscript ||
        noteVoice.getLastFinal() ||
        noteVoice.interimTranscript;
      const base = noteVoiceBaseRef.current ?? notesDraft;
      if (final && final.trim()) {
        const sep = base.length > 0 && !base.endsWith(' ') ? ' ' : '';
        setNotesDraft(base + sep + final.trim());
      }
      noteVoiceBaseRef.current = null;
      noteVoice.reset();
      // Persist the freshly-spoken notes immediately. The TextInput
      // hasn't blurred, so handleNotesBlur won't fire on its own.
      if (pillar) {
        const finalText =
          base.length > 0 && !base.endsWith(' ') && final && final.trim()
            ? base + ' ' + final.trim()
            : base + (final?.trim() ?? '');
        if (finalText !== String(pillar.notes ?? '')) {
          updatePillarNotes(pillar.id, finalText);
        }
      }
    } else {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      noteVoiceBaseRef.current = notesDraft;
      const ok = await noteVoice.start();
      if (!ok) noteVoiceBaseRef.current = null;
    }
  }, [noteVoice, notesDraft, pillar, updatePillarNotes]);

  const startEditTitle = useCallback(() => {
    if (!pillar) return;
    setTitleDraft(String(pillar.title ?? ''));
    setEditingTitle(true);
  }, [pillar]);

  const saveEditTitle = useCallback(() => {
    if (!pillar) return;
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === pillar.title) {
      setEditingTitle(false);
      return;
    }
    updatePillarManual(pillar.id, trimmed);
    setEditingTitle(false);
  }, [pillar, titleDraft, updatePillarManual]);

  const handleNotesBlur = useCallback(() => {
    if (!pillar) return;
    const trimmed = notesDraft;
    if (trimmed === String(pillar.notes ?? '')) return;
    updatePillarNotes(pillar.id, trimmed);
  }, [pillar, notesDraft, updatePillarNotes]);

  // A-3 (NEX-203): a mandate is steady and permanent — you edit or delete it,
  // you never "complete" it. The MARK COMPLETE toggle + title strikethrough
  // were an identity verdict and were removed. (The persisted `completed`
  // field is left in place as legacy; nothing here sets it anymore.)

  const handleUnlinkHabit = useCallback(
    (habitTitle: string) => {
      if (!pillar) return;
      haptic('buttonSecondary');
      unlinkHabitFromGoal(habitTitle, pillar.id);
    },
    [pillar, unlinkHabitFromGoal],
  );

  const handleToggleTodo = useCallback(
    (todo: LinkedTodo) => {
      // Per chat 2026-05-18: intent-over-literal — task completion gesture
      // maps to habitResolve regardless of the original selectionAsync type.
      haptic('habitResolve');
      toggleDailyTask(todo.dateKey, todo.id);
    },
    [toggleDailyTask],
  );

  const handleDeleteTodo = useCallback(
    (todo: LinkedTodo) => {
      haptic('buttonSecondary');
      deleteDailyTask(todo.dateKey, todo.id);
    },
    [deleteDailyTask],
  );

  // NEX-60: deletes the recurring rule entirely (mirrors to-do × behavior).
  // Unlike habits which use a many-to-many goalHabitMap, recurring-todos
  // are stamped 1:1 via pillarId — there's no "unlink without delete".
  const handleDeleteRecurringTodo = useCallback(
    (rt: LinkedRecurringTodo) => {
      haptic('buttonSecondary');
      deleteRecurringToDo(rt.id);
    },
    [deleteRecurringToDo],
  );

  const handleBackPress = useCallback(() => {
    if (backingOutRef.current) return;
    backingOutRef.current = true;
    // NEX-76 (PR #27 follow-up): schedule the release timer BEFORE
    // router.back() so a synchronous throw can't leave backingOutRef
    // stuck. Try/catch then releases immediately on throw for full
    // parity with pushToMandateDetail (no 500ms wait to recover).
    backGuardTimerRef.current = setTimeout(() => {
      backingOutRef.current = false;
      backGuardTimerRef.current = null;
    }, 500);
    try {
      router.back();
    } catch (error) {
      backingOutRef.current = false;
      if (backGuardTimerRef.current) {
        clearTimeout(backGuardTimerRef.current);
        backGuardTimerRef.current = null;
      }
      throw error;
    }
  }, [router]);

  const handleDeleteMandate = useCallback(() => {
    if (!pillar) return;
    Alert.alert(
      'Delete Mandate',
      `Delete "${pillar.title}"? Linked habits and to-dos will remain — only this mandate is removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deletePillar(pillar.id);
            haptic('voiceAmbiguous');
            handleBackPress();
          },
        },
      ],
    );
  }, [pillar, deletePillar, handleBackPress]);

  // Memoized on the three fields the ref actually carries — NOT the
  // pillar object. With the Strengthen section now active (auto-fetch),
  // a `[pillar, category]` dep meant any pillar replacement (notes
  // blur, completion toggle) minted a new ref and triggered a fresh AI
  // fetch, discarding suggestions the user was looking at.
  const mandateRefForStrengthen = useMemo(
    () =>
      pillar
        ? { id: String(pillar.id), title: String(pillar.title ?? ''), category }
        : null,
    // NEX-307/#336: `pillar.notes` is deliberately NOT a dep here. Strengthen
    // reads notes live from the store by id, so this object stays stable across
    // a notes edit — including it made every blur a new mandate identity and
    // refetched suggestions, spending an AI call per save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pillar?.id, pillar?.title, category],
  );

  // ── Render ───────────────────────────────────────────────────────
  if (!pillar) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.notFoundWrap}>
          <Text style={styles.notFoundText}>This mandate is gone.</Text>
          <Pressable
            style={styles.backBtn}
            onPress={handleBackPress}
            unstable_pressDelay={0}
          >
            <Text style={styles.backBtnText}>← BACK</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* NEX-76: header config (headerShown: false) is owned by the
          parent Stack's screenOptions in app/_layout.tsx — the previous
          per-screen <Stack.Screen options> caused a one-frame flash of
          the default header during push transition, which intercepted
          taps mid-mount. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <AdaptiveScreen>
        {/* Top bar */}
        <View style={styles.topBar}>
          <Pressable
            onPress={handleBackPress}
            // NEX-76: bumped hitSlop 12 → 20 (effective tap target
            // 40+20*2 = 80×80pt). Catches transition-window taps that
            // landed just outside the visible chevron during the iOS
            // push slide-in. delayPressIn={0} is the default; explicit
            // for future readers — no press-in lag wanted on a back btn.
            hitSlop={20}
            delayPressIn={0}
            unstable_pressDelay={0}
            style={({ pressed }) => [styles.topBarBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.topBarBtnText}>‹</Text>
          </Pressable>
          {/* A-3 (NEX-203): no MARK COMPLETE on an identity statement. */}
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header — category + title */}
          <View style={styles.header}>
            <Text style={[styles.category, { color: catColor }]}>{category}</Text>
            {editingTitle ? (
              <View style={styles.titleEditRow}>
                <TextInput
                  style={styles.titleInput}
                  value={titleDraft}
                  onChangeText={setTitleDraft}
                  autoFocus
                  multiline
                  onSubmitEditing={saveEditTitle}
                  blurOnSubmit
                />
                <PrimaryPill size="compact" style={{ marginTop: tokens.spacing.xs }} onPress={saveEditTitle}>SAVE</PrimaryPill>
              </View>
            ) : (
              <Pressable onPress={startEditTitle}>
                {/* A-3 (NEX-203): identity title is steady fact — no completed
                    strikethrough verdict. */}
                <Text style={styles.title}>
                  {pillar.title}
                </Text>
              </Pressable>
            )}
          </View>

          {/* A-3 (NEX-203): the per-mandate 7-/30-day completion % scorecard was
              removed — the identity statement is not graded. The LINKED HABITS
              section below carries the supporting practices as steady fact. */}

          {/* Strengthen — inline. active so suggestions auto-generate on
              open (spinner immediately, not the idle empty state). The
              previous active={false} left the section permanently idle:
              the auto-fetch effect never fired and users only ever saw
              "No suggestions yet". Well-supported mandates still skip
              the AI call inside the component. */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>STRENGTHEN</Text>
            <MandateStrengthenInline
              mandate={mandateRefForStrengthen}
              active
            />
          </View>

          {/* Linked habits */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>LINKED HABITS</Text>
            {linkedHabits.length === 0 ? (
              <Text style={styles.emptyText}>
                No habits linked yet. Use Strengthen above.
              </Text>
            ) : (
              linkedHabits.map((h) => (
                <View key={h.id} style={styles.linkedRow}>
                  <View style={{ flex: 1, paddingRight: tokens.spacing.sm }}>
                    {/* A-3 (NEX-203): the practice title is the steady fact —
                        no "NO STREAK YET" verdict under the identity. */}
                    <Text style={styles.linkedTitle} numberOfLines={2}>{stripEmoji(h.title)}</Text>
                  </View>
                  <Pressable
                    onPress={() => handleUnlinkHabit(h.title)}
                    hitSlop={10}
                    style={({ pressed }) => [
                      styles.unlinkBtn,
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Text style={styles.unlinkText}>×</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>

          {/* Linked recurring (NEX-60) */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>LINKED RECURRING</Text>
            {linkedRecurringTodos.length === 0 ? (
              <Text style={styles.emptyText}>No recurring intentions linked yet.</Text>
            ) : (
              linkedRecurringTodos.map((rt) => (
                <View key={rt.id} style={styles.linkedRow}>
                  <View style={{ flex: 1, paddingRight: tokens.spacing.sm }}>
                    <Text style={styles.linkedTitle} numberOfLines={2}>{rt.title}</Text>
                    <Text style={styles.linkedMeta}>
                      {formatDaysOfWeek(rt.daysOfWeek).toUpperCase()}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleDeleteRecurringTodo(rt)}
                    hitSlop={10}
                    style={({ pressed }) => [
                      styles.unlinkBtn,
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Text style={styles.unlinkText}>×</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>

          {/* Linked to-dos */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>LINKED TO-DOS</Text>
            {linkedTodos.length === 0 ? (
              <Text style={styles.emptyText}>No to-dos linked yet.</Text>
            ) : (
              linkedTodos.map((t) => (
                <View key={`${t.dateKey}-${t.id}`} style={styles.linkedRow}>
                  <Pressable
                    onPress={() => handleToggleTodo(t)}
                    hitSlop={6}
                    style={[
                      styles.todoCheck,
                      t.completed && { backgroundColor: catColor, borderColor: catColor },
                    ]}
                  >
                    {t.completed && <Text style={styles.todoCheckMark}>✓</Text>}
                  </Pressable>
                  <View style={{ flex: 1, paddingHorizontal: tokens.spacing.sm }}>
                    <Text
                      style={[
                        styles.linkedTitle,
                        t.completed && styles.linkedTitleDone,
                      ]}
                      numberOfLines={2}
                    >
                      {t.title}
                    </Text>
                    <Text style={styles.linkedMeta}>
                      {t.dateKey === todayKey() ? 'TODAY' : t.dateKey}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleDeleteTodo(t)}
                    hitSlop={10}
                    style={({ pressed }) => [
                      styles.unlinkBtn,
                      pressed && { opacity: 0.6 },
                    ]}
                  >
                    <Text style={styles.unlinkText}>×</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>

          {/* Notes */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>NOTES</Text>
            {/* NEX-77 — relative wrapper so the mic Pressable can sit
                absolute-positioned over the input's bottom-right corner. */}
            <View style={styles.notesInputWrap}>
              <TextInput
                style={styles.notesInput}
                value={notesDraft}
                onChangeText={setNotesDraft}
                onBlur={handleNotesBlur}
                placeholder="Why this matters, what success looks like, anything you want to remember."
                placeholderTextColor={DIM}
                multiline
                textAlignVertical="top"
              />
              <Pressable
                onPress={handleMicTap}
                hitSlop={10}
                style={({ pressed }) => [
                  styles.notesMicBtn,
                  pressed && { opacity: 0.6 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={
                  noteVoice.isRecognizing
                    ? 'Stop dictating'
                    : 'Dictate notes'
                }
              >
                <Animated.View style={micAnimStyle}>
                  <Ionicons
                    name={noteVoice.isRecognizing ? 'mic' : 'mic-outline'}
                    size={18}
                    color={GOLD}
                  />
                </Animated.View>
              </Pressable>
            </View>
            {/* Tap-to-speak / tap-when-done affordance (consistent with the
                Command tab + onboarding): the mic pulses while recording; this
                tells the user a second tap ends the dictation. */}
            {noteVoice.isRecognizing && (
              <Text style={styles.notesMicHint}>TAP WHEN DONE</Text>
            )}
            {noteVoice.errorMessage && (
              <Text style={styles.notesMicError}>{noteVoice.errorMessage}</Text>
            )}
          </View>

          {/* Footer actions */}
          <View style={styles.footerActions}>
            <Pressable
              onPress={startEditTitle}
              style={({ pressed }) => [
                styles.footerBtn,
                pressed && { opacity: 0.6 },
              ]}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel="Edit title"
            >
              <Text style={styles.footerBtnText}>EDIT TITLE</Text>
            </Pressable>
            <Pressable
              onPress={handleDeleteMandate}
              style={({ pressed }) => [
                styles.footerBtnDanger,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text style={styles.footerBtnDangerText}>DELETE MANDATE</Text>
            </Pressable>
          </View>
        </ScrollView>
        </AdaptiveScreen>
      </KeyboardAvoidingView>
      <StatusBarScrim />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18 /* FIXME(nex-56): off-scale spacing 18 — review */,
    paddingVertical: tokens.spacing.sm,
  },
  topBarBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBarBtnText: {
    color: TEXT_COLOR,
    // FIXME(nex-56): off-scale fontSize 32 (decorative chevron), design review
    fontSize: 32,
    fontWeight: '300',
    lineHeight: 32,
  },

  scrollContent: { paddingHorizontal: 22 /* FIXME(nex-56): off-scale spacing 22 — review */, paddingBottom: 60 /* FIXME(nex-56): off-scale spacing 60 — between xxl(48) and xxxl(72), review */ },

  // Header
  header: { marginBottom: 22 /* FIXME(nex-56): off-scale spacing 22 — review */ },
  category: {
    // FIXME(nex-56): off-scale fontSize 10, design review
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 4,
    fontFamily: 'IBMPlexMono-Medium',
    marginBottom: tokens.spacing.sm,
  },
  title: {
    color: TEXT_COLOR,
    // FIXME(nex-56): off-scale fontSize 30 (Fraunces italic display) — closest token poeticHero is 28; design review
    fontSize: 30,
    lineHeight: 38,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
  },
  titleEditRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: tokens.spacing.sm,
  },
  titleInput: {
    flex: 1,
    color: TEXT_COLOR,
    // FIXME(nex-56): off-scale fontSize 26 (Fraunces italic input), design review
    fontSize: 26,
    lineHeight: 32,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    paddingVertical: tokens.spacing.xs,
  },


  // Sections
  section: { marginBottom: 28 /* FIXME(nex-56): off-scale spacing 28 — review */ },
  sectionLabel: {
    color: MUTED,
    // FIXME(nex-56): off-scale fontSize 9, design review
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 3,
    marginBottom: tokens.spacing.sm,
    fontFamily: 'IBMPlexMono-Medium',
  },
  emptyText: {
    color: MUTED,
    // FIXME(nex-56): fontSize 13 matches caption size but family Fraunces (italic) diverges from token Inter — design review
    fontSize: 13,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
    paddingVertical: tokens.spacing.xs,
  },

  // Linked rows (habits + todos share style)
  linkedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // NEX-161: frosted parity. List row — no ambientGlow (rows stay plain).
    backgroundColor: tokens.color.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.color.luminousEdge,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    marginBottom: tokens.spacing.xs,
  },
  linkedTitle: {
    color: TEXT_COLOR,
    // FIXME(nex-56): fontSize 15 matches bodyMdEmphasis size + weight '500' but no fontFamily set (defaults to system, not Inter-Medium) — design review
    fontSize: 15,
    fontWeight: '500',
    marginBottom: tokens.spacing.xxs,
  },
  linkedTitleDone: { color: MUTED, textDecorationLine: 'line-through' },
  linkedMeta: {
    color: MUTED,
    // FIXME(nex-56): off-scale fontSize 9, design review
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 2,
  },
  unlinkBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unlinkText: {
    color: MUTED,
    // FIXME(nex-56): fontSize 22 (decorative × glyph) with weight '300' — no token match, design review
    fontSize: 22,
    fontWeight: '300',
    lineHeight: 24,
  },

  // To-do checkbox
  todoCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todoCheckMark: {
    // FIXME(nex-56): off-scale fontSize 12, design review
    color: tokens.color.textInverse,
    fontSize: 12,
    fontWeight: '900',
  },

  // Notes
  // NEX-77: relative wrapper around the input so the mic Pressable
  // can sit absolute-positioned at the input's bottom-right corner.
  notesInputWrap: {
    position: 'relative',
  },
  // NEX-77: mic button inside the input's bottom-right corner. Small
  // and quiet — this is a secondary affordance, not a hero element.
  notesMicBtn: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: tokens.color.goldHairline,
  },
  // NEX-77: dictation error caption. Mirrors the voice-error pattern
  // on the Command tab; sits below the input field.
  notesMicError: {
    color: tokens.color.stateError,
    fontSize: 12,
    marginTop: 6,
  },
  notesMicHint: {
    ...tokens.type.labelTrackedSm,
    color: tokens.color.teal,
    marginTop: 6,
  },
  notesInput: {
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER,
    color: TEXT_COLOR,
    // FIXME(nex-56): off-scale fontSize 14, design review
    fontSize: 14,
    lineHeight: 20,
    minHeight: 110,
    paddingVertical: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    // NEX-77: extra right padding so long text doesn't run under the
    // 36pt mic button sitting in the corner.
    paddingRight: 56,
    paddingHorizontal: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    fontFamily: 'Inter-Regular',
  },

  // Footer
  footerActions: { gap: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, marginTop: tokens.spacing.xs },
  footerBtn: {
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER,
    paddingVertical: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    alignItems: 'center',
  },
  footerBtnText: {
    color: TEXT_COLOR,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 3,
  },
  footerBtnDanger: {
    backgroundColor: 'transparent',
    borderRadius: 12,
    borderWidth: 1,
    // FIXME(nex-56): 'rgba(229,91,69,0.30)' red-dark tint border, no token — design review
    borderColor: 'rgba(229,91,69,0.30)',
    paddingVertical: 14 /* FIXME(nex-56): off-scale spacing 14 — review */,
    alignItems: 'center',
  },
  footerBtnDangerText: {
    // FIXME(nex-56): tokens.color.stateError no token for red — design review
    color: tokens.color.stateError,
    // FIXME(nex-56): off-scale fontSize 11, design review
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 3,
  },

  // Not-found state
  notFoundWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.lg,
  },
  notFoundText: {
    color: TEXT_COLOR,
    fontSize: 22,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
  },
  backBtn: {
    borderWidth: 1,
    borderColor: GOLD,
    borderRadius: 12,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: 28 /* FIXME(nex-56): off-scale spacing 28 — review */,
  },
  // FIXME(nex-56): off-scale fontSize 11, design review
  backBtnText: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
});
