/**
 * Mandate Strengthen — AI suggestion sheet.
 *
 * Given a mandate (identity statement), generates 3 habit
 * suggestions and 2 to-do suggestions tied to that mandate. Each
 * card has one-tap Add. Habits create recurring rules + auto-link
 * to the mandate via goalHabitMap. To-dos add to today's
 * dailyTasks.
 *
 * Pattern mirrors src/components/pulse-card.tsx — same chatCompletion
 * call, same Haptics conventions, same one-tap-add UX. The visual
 * register is a bottom sheet (heavier surface than Pulse's inline
 * card) since this is a deliberate ritual moment, not a passive
 * suggestion.
 *
 * Edge cases:
 *   - If the mandate already has 5+ linked habits, show
 *     "well-supported" copy instead of auto-querying the AI. The user
 *     can still regenerate manually.
 *   - If chatCompletion fails or returns malformed JSON, show a
 *     retry button. Never crash.
 *   - "Regenerate" is usable once per session, then disabled.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { MotiView } from 'moti';
import { haptic } from '@/src/utils/haptics';
import { PrimaryPill } from '@/src/components/ui/PrimaryPill';
import { Sheet } from '@/src/components/ui/Sheet';
import { useEntranceFrom } from '@/hooks/use-entrance-motion';
import { useAppState } from '../state/app-state';
import { chatCompletion } from '../utils/ai-client';
import { resolveMandateFields } from '../ai/mandate-prompt-context';
import { formatTasteForPrompt } from '../ai/suggestion-taste-context';
import { AI_PERSONA } from '../utils/ai-context';
import { countLinkedHabitsForPillar } from '../utils/mandate-habit-links';
import {
  fetchStrengthenSuggestions,
  type StrengthenResult,
  type SuggestedItem,
  type SuggestionPayload,
} from '../utils/strengthen-suggestions';
import { normalize, stripEmoji } from '../utils/text';
import tokens from '@/src/theme/tokens';

const GOLD = tokens.color.gold;
const TEXT_COLOR = tokens.color.text;
const MUTED = tokens.color.textMuted;
const SURFACE = tokens.color.surfaceSunken;
const BORDER = tokens.color.surfaceElevated;

export interface MandateRef {
  id: string;
  title: string;
  category: string;
}

/**
 * NEX-307: everything the PROMPT needs about a mandate, resolved LIVE from the
 * store by id at build time.
 *
 * `MandateRef` is an identity token, not a data carrier. Two review rounds on
 * #336 taught the same lesson from both directions:
 *
 *  1. Carrying `notes` on the object made its identity change on every notes
 *     blur, and `fetchSuggestions` closes over that object — so writing a note
 *     silently spent an AI call. (T-Rex measured fetch count 1 -> 2.)
 *  2. Fixing that by narrowing the fetch to `mandate?.id` then left
 *     `buildPrompt` reading `title`/`category` off the closed-over object, so
 *     renaming a mandate without changing its id prompted with the OLD title.
 *     The first fix moved the bug rather than removing it.
 *
 * One rule resolves both: the prompt reads live by id; the object carries
 * identity only. Fields are then always current at prompt time and never enter
 * fetch identity.
 *
 * Falls back to the ref's own values if the pillar cannot be resolved (deleted
 * while the sheet is open), so the prompt degrades to slightly-stale rather
 * than empty.
 */
function liveMandateFields(mandate: MandateRef) {
  // The resolution itself is a pure function in the prompt-context module so
  // the Node vitest suite can cover it; this component cannot be imported
  // there. All this wrapper does is supply the current pillar list.
  return resolveMandateFields((useAppState.getState() as any).pillars, mandate);
}

interface Props {
  visible: boolean;
  mandate: MandateRef | null;
  onClose: () => void;
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildPrompt(mandate: MandateRef): { system: string; user: string } {
  const liveState = useAppState.getState();
  const profile = liveState.userProfile;
  const anchor = String(profile?.anchor ?? '').trim();
  const vision = String(profile?.vision ?? '').trim();
  const recurringTitles: string[] = liveState.recurringRules
    .map((r) => r.title.trim())
    .filter((t) => t.length > 0);
  const pillarTitles: string[] = liveState.pillars
    .map((p) => p.title.trim())
    .filter((t) => t.length > 0);

  const system = `${AI_PERSONA}

You generate concrete habits and to-dos that strengthen a single mandate the user has declared. Mandates are identity statements ("I am someone who..."), not goals — your suggestions should be the daily practices and short-term moves a person living that identity would actually do.

Rules:
- Return EXACTLY 3 habits and 2 to-dos. No more, no less.
- Habits are recurring practices (e.g. "Lift 4x/week, 45 min", "Read 30 min before bed"). Specific cadence, specific duration when relevant.
- To-dos are this-week tasks that move the mandate forward (e.g. "Book DEXA scan", "Sketch first chapter outline").
- Specific over generic. "30-min zone-2 cardio Mon/Wed/Fri" — yes. "Exercise more" — no.
- Skip anything already in the user's existing recurring rules (you'll see the list; do not duplicate).
- Each rationale is ONE short sentence — concrete, second person, no clichés.
- If a "Why this matters to them" line is present, treat it as the PRIMARY steer: it is the user's own words about this mandate. Suggestions should follow what they actually said matters, not a generic reading of the mandate title.
- If a "What this person has taken / passed on" block is present, use it to calibrate STYLE and SCALE, not vocabulary. It is weaker evidence than the mandate and the "why" above it: when it conflicts with either, follow the mandate.

Return ONLY valid JSON, no markdown fencing:
{"habits":[{"title":"...","rationale":"..."},{"title":"...","rationale":"..."},{"title":"...","rationale":"..."}],"todos":[{"title":"...","rationale":"..."},{"title":"...","rationale":"..."}]}`;

  // NEX-307: title, category and the user's own "why" all read LIVE from the
  // store by id (see liveMandateFields). The ref is identity only, so a rename
  // or a re-category is reflected on the very next prompt without ever entering
  // fetch identity.
  const live = liveMandateFields(mandate);

  const userBlocks: string[] = [
    `Mandate: "${live.title}" (category: ${live.category})`,
  ];
  // Placed immediately after the mandate so the model reads identity and reason
  // as one unit.
  if (live.notes) userBlocks.push(`Why this matters to them: "${live.notes}"`);
  if (anchor) userBlocks.push(`Anchor: "${anchor}"`);
  if (vision) userBlocks.push(`Vision: "${vision}"`);
  if (pillarTitles.length > 0) {
    // Exclude THIS mandate from the "other mandates" list by its live title,
    // or a renamed mandate would list itself as one of the others.
    userBlocks.push(`Other mandates: ${pillarTitles.filter((t) => t !== live.title).slice(0, 12).join(' · ')}`);
  }
  if (recurringTitles.length > 0) {
    userBlocks.push(`Existing recurring habits (DO NOT duplicate): ${recurringTitles.slice(0, 24).join(' · ')}`);
  } else {
    userBlocks.push('Existing recurring habits: (none)');
  }

  // NEX-310: what this person has actually taken from past suggestions, and
  // what they regenerated away. Returns null until there is enough history to
  // say something honest, and the block is simply omitted then — so a new
  // user's prompt is byte-identical to the one before this feature existed.
  // Placed last so the model reads it as a refinement on everything above
  // rather than as the brief itself.
  const taste = formatTasteForPrompt(liveState.suggestionFeedback, mandate.id);
  if (taste) userBlocks.push(taste);

  return { system, user: userBlocks.join('\n') };
}

/**
 * Reusable engine for the Strengthen flow. Renders the well-
 * supported / loading / error / suggestion-list states plus the
 * Add buttons, with no Modal wrapper. The sheet wraps this in a
 * Modal. The mandate detail screen embeds it inline.
 *
 * Props:
 *   - mandate: which mandate to strengthen
 *   - active: when true, auto-fetches and resets state on mandate
 *     change. The sheet passes `visible`; the mandate detail screen
 *     passes `true` so suggestions auto-generate on open (it used to
 *     pass `false`, which left the section permanently idle — the
 *     reported "No suggestions yet" bug).
 *   - showHeader: render the eyebrow + mandate title block above
 *     the section content. Sheet passes true; detail passes false
 *     because it has its own header.
 */
interface InlineProps {
  mandate: MandateRef | null;
  active: boolean;
  showHeader?: boolean;
}

export function MandateStrengthenInline({
  mandate,
  active,
  showHeader = false,
}: InlineProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<SuggestionPayload | null>(null);
  // NEX-307/#336: drives the empty-note nudge ONLY. A selector subscription, so
  // writing a note re-renders this line (the nudge disappears) without changing
  // `mandate` identity — which is what previously dragged fetchSuggestions into
  // a refetch. Prompt-time fields are read separately via liveMandateFields.
  const liveNoteForNudge = useAppState((st: any) => {
    if (!mandate?.id) return '';
    const found = Array.isArray(st?.pillars)
      ? st.pillars.find((p: any) => p && String(p.id) === String(mandate.id))
      : null;
    return typeof found?.notes === 'string' ? found.notes.trim() : '';
  });
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [regenUsed, setRegenUsed] = useState(false);

  // NEX-76: reactive subscriptions for the count. Was previously
  // computed via imperative useAppState.getState() with a frozen memo
  // dep array — meant the count never updated when habits were
  // linked/unlinked mid-session. Now subscribes to both fields the
  // count depends on, refreshes on every change.
  const goalHabitMap = useAppState((s) => s.goalHabitMap);
  const recurringRules = useAppState((s) => s.recurringRules);

  const wellSupportedCount = useMemo(
    () =>
      mandate
        ? countLinkedHabitsForPillar(
            mandate.id,
            Array.isArray(recurringRules) ? recurringRules : [],
            goalHabitMap ?? {},
          )
        : 0,
    [mandate, recurringRules, goalHabitMap],
  );
  const isWellSupported = wellSupportedCount >= 5;

  // Two guards, serving different purposes:
  //  - inFlightForRef (single-slot, keyed by the mandate id of the MOST
  //    RECENTLY STARTED fetch): the auto-fetch effect and the fallback
  //    effect below both run in the same commit on first activation, and
  //    the fallback's closure still sees the pre-fetch loading=false — state
  //    alone can't dedupe that same-tick double-fire. It also means a fetch
  //    already running for mandate A never blocks a fetch just started for
  //    mandate B — a single global boolean here left the sheet stuck on
  //    "Drafting suggestions…" for the new mandate until the old mandate's
  //    request finished. It is NOT a per-mandate set: rapidly switching
  //    A -> B -> A while A's first request is still in flight can start a
  //    second concurrent request for A (an extra wasted call, never worse)
  //    — requestIdRef below is what actually guarantees correctness.
  //  - requestIdRef (freshness / ownership): bumped on every fetch start.
  //    Gates BOTH which response may paint state (a stale response, from a
  //    mandate switch or a close/reopen, is discarded) AND which call may
  //    release inFlightForRef / loading — only the request that owns the
  //    CURRENT requestId may do either, so a superseded request's `finally`
  //    can never clear a slot a newer, still-in-flight request now owns.
  const inFlightForRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchSuggestions = useCallback(async () => {
    if (!mandate) return;
    if (inFlightForRef.current === mandate.id) return;
    inFlightForRef.current = mandate.id;
    const requestId = ++requestIdRef.current;
    setError(null);
    setLoading(true);
    try {
      const { system, user } = buildPrompt(mandate);
      const result: StrengthenResult = await fetchStrengthenSuggestions(
        { system, user },
        (messages, options) => chatCompletion(messages, options),
      );
      if (requestIdRef.current !== requestId) return; // superseded — discard
      if (result.kind === 'ok') {
        setPayload(result.payload);
      } else {
        setPayload(null);
        setError(
          result.kind === 'timeout'
            ? 'That took a while. Tap retry.'
            : result.kind === 'parse'
              ? 'Could not read the suggestions. Try again.'
              : 'Could not generate suggestions. Try again.',
        );
      }
    } finally {
      // Ownership by requestId, not mandate id — a superseded request whose
      // mandate id happens to match a NEWER, still-in-flight request's
      // mandate id must not release a slot it doesn't own (see the guard
      // note above).
      if (requestIdRef.current === requestId) {
        inFlightForRef.current = null;
        setLoading(false);
      }
    }
    // NEX-307/#336: deps are the mandate ID, not the mandate OBJECT. Closing
    // over the object made every notes blur a new callback identity, which the
    // auto-fetch effects below list as a dep — so saving a note refetched
    // suggestions and spent an AI call. Title/category/notes are all resolved
    // from the live store inside buildPrompt, so the id is the only identity
    // this callback actually needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mandate?.id]);

  // Reset + auto-fetch when active flips on or mandate changes.
  // NEX-76: flip loading synchronously before fetchSuggestions runs.
  // Without this there's a one-frame race where active=true,
  // payload=null, loading=false — all four ternary branches fail and
  // nothing renders. The async fetchSuggestions sets loading=true
  // inside its body, but that's one tick too late. Setting it here
  // ensures "Drafting suggestions…" lights up immediately.
  useEffect(() => {
    if (!active) return;
    if (!mandate) return;
    setPayload(null);
    setAddedKeys(new Set());
    setRegenUsed(false);
    setError(null);
    if (!isWellSupported) {
      setLoading(true);
      fetchSuggestions();
    } else {
      setLoading(false);
    }
  }, [active, mandate?.id, isWellSupported, fetchSuggestions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback trigger — safety net for the primary effect above: if the
  // component is active but sitting in the idle empty state (no fetch
  // running, no payload, no error, not well-supported), kick the fetch.
  // On first activation this runs in the same commit as the primary
  // effect with a stale loading=false closure — the inFlightForRef guard
  // inside fetchSuggestions dedupes that synchronously. Every fetch
  // outcome sets payload or error, so this can't loop.
  useEffect(() => {
    if (!active) return;
    if (!mandate) return;
    if (loading || payload || error || isWellSupported) return;
    setLoading(true);
    fetchSuggestions();
  }, [active, mandate?.id, loading, payload, error, isWellSupported, fetchSuggestions]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddHabit = useCallback(
    (item: SuggestedItem) => {
      if (!mandate) return;
      const key = `habit:${normalize(item.title)}`;
      if (addedKeys.has(key)) return;
      const state = useAppState.getState();
      // Default to all-week recurrence; user can edit cadence later.
      // Category is propagated from the mandate so the habit groups
      // visually with related rules.
      const addRule = state.addRecurringRule;
      const linkHabit = state.linkHabitToGoal;
      if (typeof addRule !== 'function') return;
      // Live category, same rule as the prompt: this is a WRITE, so a mandate
      // re-categorized while the sheet is open would otherwise file the new
      // habit under the mandate's OLD category and group it with the wrong
      // rules. The ref carries identity; the current value comes from the store.
      addRule(item.title, [0, 1, 2, 3, 4, 5, 6], null, null, liveMandateFields(mandate).category, null);
      if (typeof linkHabit === 'function') {
        linkHabit(item.title, mandate.id);
      }
      // NEX-308: the user took this one. Sits INSIDE the addedKeys guard above,
      // so re-tapping an already-added suggestion can't double-log it.
      state.recordSuggestionFeedback?.([
        { kind: 'habit', outcome: 'accepted', title: item.title, mandateId: mandate.id },
      ]);
      setAddedKeys((s) => new Set(s).add(key));
    },
    [mandate, addedKeys],
  );

  const handleAddTodo = useCallback(
    (item: SuggestedItem) => {
      if (!mandate) return;
      const key = `todo:${normalize(item.title)}`;
      if (addedKeys.has(key)) return;
      const state = useAppState.getState();
      // Use the pillar-aware variant so the new task is linked to
      // this mandate. The detail screen's "Linked To-Dos" section
      // filters by pillarId. Falls back to addDailyTask if the
      // pillar-aware action isn't present (defensive — shouldn't
      // happen post-v21).
      const addForPillar = state.addDailyTaskForPillar;
      const addDailyTask = state.addDailyTask;
      if (typeof addForPillar === 'function') {
        addForPillar(item.title, getTodayKey(), mandate.id);
      } else if (typeof addDailyTask === 'function') {
        addDailyTask(item.title, getTodayKey());
      } else {
        return;
      }
      // NEX-308: as above — inside the addedKeys guard, so no double-log.
      state.recordSuggestionFeedback?.([
        { kind: 'todo', outcome: 'accepted', title: item.title, mandateId: mandate.id },
      ]);
      setAddedKeys((s) => new Set(s).add(key));
    },
    [mandate, addedKeys],
  );

  const handleRegenerate = useCallback(() => {
    if (regenUsed || loading || isWellSupported) return;
    // NEX-308: asking for a different set is the only rejection signal this UI
    // produces (there is no explicit "no thanks" control). Log the currently
    // shown items the user did NOT add — the ones they had a chance to take and
    // passed on. Already-added items are excluded so an accept is never also
    // counted as a rejection. One call, one atomic store write.
    if (mandate && payload) {
      const rejected = [
        ...payload.habits
          .filter((h) => !addedKeys.has(`habit:${normalize(h.title)}`))
          .map((h) => ({ kind: 'habit' as const, title: h.title })),
        ...payload.todos
          .filter((t) => !addedKeys.has(`todo:${normalize(t.title)}`))
          .map((t) => ({ kind: 'todo' as const, title: t.title })),
      ].map((e) => ({ ...e, outcome: 'regenerated' as const, mandateId: mandate.id }));
      if (rejected.length > 0) {
        useAppState.getState().recordSuggestionFeedback?.(rejected);
      }
    }
    setRegenUsed(true);
    haptic('buttonSecondary');
    fetchSuggestions();
  }, [regenUsed, loading, isWellSupported, fetchSuggestions, mandate, payload, addedKeys]);

  if (!mandate) return null;

  const canRegenerate = !loading && !error && !isWellSupported;
  const showWellSupportedMessage = isWellSupported && !payload;

  return (
    <View>
      {showHeader && (
        <View style={styles.header}>
          <Text style={styles.eyebrow}>STRENGTHEN</Text>
          <Text style={styles.mandateTitle} numberOfLines={3}>
            {mandate.title}
          </Text>
          <Text style={styles.category}>{mandate.category}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={GOLD} size="small" />
          <Text style={styles.loadingText}>Drafting suggestions…</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={fetchSuggestions}>
            <Text style={styles.retryBtnText}>RETRY</Text>
          </Pressable>
        </View>
      ) : showWellSupportedMessage ? (
        <View style={styles.wellSupported}>
          <Text style={styles.wellSupportedTitle}>This one has its practices.</Text>
          <Text style={styles.wellSupportedBody}>
            {wellSupportedCount} habits already carry this mandate. Strengthen another, or live this one.
          </Text>
        </View>
      ) : payload && payload.habits.length === 0 && payload.todos.length === 0 ? (
        // NEX-76: LLM returned valid JSON but with no habits or todos.
        // Without this branch the body rendered nothing while the
        // REGENERATE pill below sat alone — looked broken. The user
        // now sees an explicit "nothing this time" line; REGENERATE
        // still renders below so they can try again.
        <View style={styles.emptyPayloadWrap}>
          <Text style={styles.emptyPayloadBody}>
            Nothing surfaced this time. Tap regenerate, or live what's here.
          </Text>
        </View>
      ) : payload ? (
        <>
          {/* NEX-307: when this mandate has no "why", say so once, quietly, and
              make it the reason suggestions could be better — never a nag, never
              a gate (§1.5 Law C/E). Declarative third person, no imperative, no
              exclamation (§18.1). Tapping is not wired here because the notes
              field lives on the mandate detail screen; the line is informational
              where Strengthen is shown from elsewhere.

              Deliberately NOT auto-refetching when notes change: the fetch keys
              on `mandate?.id`, so writing a note does not silently spend an AI
              call on every blur. The user-visible feedback loop is that this
              line disappears once a note exists, and REGENERATE is already on
              screen. Auto-refetch-on-blur would be a mechanism with its own
              race/cost edges for a case one existing tap already covers. */}
          {!liveNoteForNudge && (
            <Text style={styles.noteHint}>
              Suggestions get sharper once this mandate has a why.
            </Text>
          )}
          {payload.habits.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>HABITS</Text>
              {payload.habits.map((item, idx) => {
                const key = `habit:${normalize(item.title)}`;
                const added = addedKeys.has(key);
                return (
                  <SuggestionCard
                    key={`habit-${idx}-${item.title}`}
                    item={item}
                    displayTitle={stripEmoji(item.title)}
                    added={added}
                    onAdd={() => handleAddHabit(item)}
                  />
                );
              })}
            </View>
          )}
          {payload.todos.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>THIS WEEK</Text>
              {payload.todos.map((item, idx) => {
                const key = `todo:${normalize(item.title)}`;
                const added = addedKeys.has(key);
                return (
                  <SuggestionCard
                    key={`todo-${idx}-${item.title}`}
                    item={item}
                    displayTitle={stripEmoji(item.title)}
                    added={added}
                    onAdd={() => handleAddTodo(item)}
                  />
                );
              })}
            </View>
          )}
        </>
      ) : (
        <View style={styles.emptyPayloadWrap}>
          <Text style={styles.emptyPayloadBody}>
            No suggestions yet. Tap regenerate to try.
          </Text>
        </View>
      )}

      {canRegenerate && (
        <Pressable
          onPress={handleRegenerate}
          disabled={regenUsed}
          style={({ pressed }) => [
            styles.regenWrap,
            pressed && { opacity: 0.6 },
            regenUsed && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.regenText}>
            {regenUsed ? 'REGENERATED' : 'REGENERATE'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function MandateStrengthenSheet({ visible, mandate, onClose }: Props) {
  const handleClose = useCallback(() => {
    haptic('tabChange');
    onClose();
  }, [onClose]);

  if (!visible || !mandate) return null;

  return (
    <Sheet visible={visible} onDismiss={handleClose} accessibilityLabel="Strengthen mandate">
      <ScrollView
        contentContainerStyle={{ paddingBottom: tokens.spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <MandateStrengthenInline
          mandate={mandate}
          active={visible}
          showHeader
        />
      </ScrollView>

      <Pressable style={styles.doneBtn} onPress={handleClose}>
        <Text style={styles.doneBtnText}>DONE</Text>
      </Pressable>
    </Sheet>
  );
}

function SuggestionCard({
  item,
  displayTitle,
  added,
  onAdd,
}: {
  item: SuggestedItem;
  displayTitle?: string;
  added: boolean;
  onAdd: () => void;
}) {
  const entranceFrom = useEntranceFrom(6);
  return (
    <MotiView
      from={entranceFrom}
      animate={{ opacity: added ? 0.45 : 1, translateY: 0 }}
      transition={{ type: 'timing', duration: 220 }}
      style={styles.card}
    >
      <View style={{ flex: 1, paddingRight: tokens.spacing.sm }}>
        <Text style={styles.cardTitle}>{displayTitle ?? item.title}</Text>
        {item.rationale ? (
          <Text style={styles.cardRationale}>{item.rationale}</Text>
        ) : null}
      </View>
      <PrimaryPill
        size="compact"
        onPress={onAdd}
        disabled={added}
      >
        {added ? 'ADDED' : 'ADD'}
      </PrimaryPill>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  // FIXME(nex-56): off-scale 18pt margin — design review
  header: {
    paddingTop: tokens.spacing.sm,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    marginBottom: 18,
  },
  // FIXME(nex-56): off-scale 10pt fontSize — design review
  eyebrow: {
    color: GOLD,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 4,
    marginBottom: tokens.spacing.sm,
  },
  // FIXME(nex-56): fontSize 22 matches poeticMd 22 + italic + Fraunces family + 28pt lineHeight differs from token 30pt — design review
  mandateTitle: {
    color: TEXT_COLOR,
    fontSize: 22,
    lineHeight: 28,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
    marginBottom: tokens.spacing.xs,
  },
  // FIXME(nex-56): off-scale 9pt fontSize — design review
  category: {
    color: MUTED,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 2,
  },

  // FIXME(nex-56): off-scale 48pt paddingVertical + 14pt gap — design review
  loadingWrap: {
    paddingVertical: 48,
    alignItems: 'center',
    gap: 14,
  },
  // FIXME(nex-56): off-scale 13pt fontSize — design review
  loadingText: {
    color: MUTED,
    fontSize: 13,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
  },

  // FIXME(nex-56): off-scale 36pt paddingVertical + 14pt gap — design review
  errorWrap: { paddingVertical: 36, alignItems: 'center', gap: 14 },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  errorText: { color: MUTED, fontSize: 14, textAlign: 'center' },
  // FIXME(nex-56): off-scale 10pt paddingVertical + 28pt paddingHorizontal — design review
  retryBtn: {
    borderWidth: 1,
    borderColor: GOLD,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 28,
  },
  // FIXME(nex-56): off-scale 11pt fontSize — design review
  retryBtnText: { color: GOLD, fontSize: 11, fontWeight: '900', letterSpacing: 2 },

  // FIXME(nex-56): off-scale 36pt paddingVertical + 10pt gap — design review
  wellSupported: {
    paddingVertical: 36,
    paddingHorizontal: tokens.spacing.sm,
    alignItems: 'center',
    gap: tokens.spacing.sm,
  },
  // FIXME(nex-56): fontSize 22 matches poeticMd 22 + italic + Fraunces family — design review (no lineHeight set, may differ from token default)
  wellSupportedTitle: {
    color: TEXT_COLOR,
    fontSize: 22,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
    textAlign: 'center',
  },
  // FIXME(nex-56): off-scale 14pt fontSize — design review
  noteHint: {
    color: MUTED,
    fontSize: 13,
    lineHeight: 19,
    fontStyle: 'italic',
    fontFamily: tokens.font.fraunces,
    marginBottom: 14,
  },

  wellSupportedBody: {
    color: MUTED,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },

  // NEX-76: empty-payload state when the LLM returned valid JSON but
  // with no suggestions. Mirrors wellSupportedBody's typography — same
  // muted body register, centered, no icon, no title above it.
  emptyPayloadWrap: {
    paddingVertical: 36,
    paddingHorizontal: tokens.spacing.sm,
    alignItems: 'center',
  },
  emptyPayloadBody: {
    color: MUTED,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },

  // FIXME(nex-56): off-scale 18pt margin — design review
  section: { marginBottom: 18 },
  // FIXME(nex-56): off-scale 9pt fontSize + 10pt margin — design review
  sectionLabel: {
    color: MUTED,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 3,
    marginBottom: 10,
  },
  // FIXME(nex-56): off-scale 10pt margin — design review
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: SURFACE,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER,
    padding: tokens.spacing.md,
    marginBottom: 10,
  },
  // FIXME(nex-56): off-scale 15pt fontSize (matches bodyMd but weight 600 differs) — design review
  cardTitle: {
    color: TEXT_COLOR,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: tokens.spacing.xxs,
  },
  // FIXME(nex-56): off-scale 13pt fontSize + 19pt lineHeight — design review
  cardRationale: {
    color: MUTED,
    fontSize: 13,
    lineHeight: 19,
  },

  // FIXME(nex-56): off-scale 18pt paddingVertical — design review
  regenWrap: {
    alignItems: 'center',
    paddingVertical: 18,
  },
  // FIXME(nex-56): off-scale 10pt fontSize — design review
  regenText: {
    color: GOLD,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 3,
  },

  // FIXME(nex-56): off-scale negative margins -22/-12 (full-bleed override) — design review
  doneBtn: {
    backgroundColor: SURFACE,
    borderTopWidth: 1,
    borderTopColor: BORDER,
    paddingVertical: tokens.spacing.md,
    alignItems: 'center',
    marginHorizontal: -22,
    marginBottom: -12,
  },
  // FIXME(nex-56): off-scale 12pt fontSize — design review
  doneBtnText: {
    color: TEXT_COLOR,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 3,
  },
});
