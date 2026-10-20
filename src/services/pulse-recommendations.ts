// NEX-26 — Pulse-generated onboarding recommendations.
//
// Reflection-driven design (locked 2026-05-11; pool-with-tap rev
// 2026-05-13 per NEX-57). The user answers up to four reflection
// prompts; Pulse extracts 3–5 mandates from their words and
// generates a POOL of 2–3 habits + 2–3 downstream actions per
// mandate. The review screen shows the pool one mandate at a time;
// the user taps ADD on what resonates and the rest stays unselected.
// Output is still a causal chain: mandate → daily practice → this
// week's moves, but the user picks from a fan of options rather
// than accepting a single take.
//
// This module is stateless and pure-data. Five exported functions:
//
//   1. generateOnboardingRecommendations(reflection)
//      Full initial generation. Returns either a RecommendationSet
//      or — if the reflection is too thin per the client-side gate —
//      a DisambiguationPrompt for the UI to surface as a follow-up card.
//
//   2. regenerateMandateOnly({ mandateId, mandate, reflection })
//      Alternative wording for the same underlying mandate. Keeps the
//      mandate's id; refreshCount tick happens in app-state, not here.
//
//   3. regenerateMandateDownstream({ mandate, reflection })
//      User inline-edited a mandate (or tapped per-mandate REGENERATE).
//      Cascade a fresh POOL of 2-3 habits + 2-3 downstream actions
//      for that mandate (NEX-57). Counters do NOT tick
//      (system-initiated). Reducer preserves ADDed items from the
//      old pool and swaps in the new ones for un-ADDed slots.
//
//   4. regenerateHabit({ slotId, mandate, reflection })
//      Alternative habit for the same mandate. Keeps slotId.
//
//   5. regenerateTodo({ slotId, mandate, reflection })
//      Alternative to-do for the same mandate. Keeps slotId.
//
// All AI failure paths return a discriminated `{ source: 'failed',
// reason }` shape rather than crashing. Length-budget violations in
// the parser surface as reason 'parse'. Callers route to the retry
// screen; the service never synthesizes fake content.
// Refresh counters live on the app-state slice; this module is
// counter-agnostic.

import { chatCompletion, type ChatMessage } from '../utils/ai-client';
// NEX-305: name the tier at the call site. These calls used to pass no model and
// silently ride the shared default, so the app's most important AI moment
// (extracting identity from the user's own reflection) ran on the same model as
// a routine daily tip. Identity work → MANDATE_GENERATION; the downstream
// practice suggestions it produces → DAILY_PULSE.
import { MODELS } from '../utils/ai-models';

// ─── Types — wire schema + persistence shape ─────────────────────────────────

/** Which of the four reflection cards a mandate was extracted from. */
export type ReflectionKey = 'bestVersion' | 'stop' | 'continue' | 'focus';

/**
 * The four reflection answers.
 *
 * NEX-38: all four fields are required strings. The flow now blocks
 * the user from advancing past any card with empty content, so by the
 * time a ReflectionInput leaves the UI it carries non-empty content
 * on all four cards. The type guarantees field PRESENCE; non-empty
 * content is a runtime invariant enforced by reflection-flow.tsx.
 * The disambiguation gate (shouldDisambiguate) still fires for
 * uniformly-thin answers where Pulse wouldn't have enough signal.
 */
export interface ReflectionInput {
  bestVersion: string;
  stop: string;
  continue: string;
  focus: string;
}

export interface RecommendedMandate {
  /** Opaque "m-XXXXXXXX" string. Stable across refreshes. */
  id: string;
  /** Alias for id — kept as a separate field per the locked schema. */
  slotId: string;
  title: string;
  category: string;             // 'BUSINESS' | 'PERSONAL' | 'VISION' on the wire
  rationaleSource: ReflectionKey;
  /**
   * Phase F addition. One short sentence (12–20 words) that names
   * the connection between the user's reflection and this mandate.
   * Renders below the mandate title on the review screen so the
   * causal chain is visible from words → identity → practice.
   */
  rationale: string;
  refreshCount: number;
}

export interface RecommendedHabit {
  slotId: string;
  title: string;
  daysOfWeek: number[];         // 0=Sun..6=Sat
  mandateId: string;
  rationale: string;
  /**
   * NEX-57: the review screen's pool-with-tap pattern. `false` on parse;
   * the UI toggles to `true` when the user taps ADD. `commitActivation`
   * sweeps only `added: true` items on Begin. Lives on every pool item
   * across the three downstream buckets so the reducer can preserve
   * ADDed slots across per-mandate REGENERATE.
   */
  added: boolean;
  refreshCount: number;
}

export interface RecommendedTodo {
  slotId: string;
  title: string;
  mandateId: string;
  rationale: string;
  /** Optional ISO date (YYYY-MM-DD). Set when Pulse infers a specific deadline from the reflection. */
  dueDate?: string;
  /** NEX-57: see RecommendedHabit.added. */
  added: boolean;
  refreshCount: number;
}

export interface RecommendedRecurringTodo {
  slotId: string;
  title: string;
  daysOfWeek: number[];           // 0=Sun..6=Sat
  mandateId: string;
  rationale: string;
  /** NEX-57: see RecommendedHabit.added. */
  added: boolean;
  refreshCount: number;
}

export interface DisambiguationPrompt {
  question: string;
  options: string[];
}

export interface RecommendationSet {
  mandates: RecommendedMandate[];
  habits: RecommendedHabit[];
  recurringTodos: RecommendedRecurringTodo[];
  todos: RecommendedTodo[];
}

export type RecommendationSource = 'pulse' | 'needs_disambiguation' | 'failed';

/**
 * Return shape for `generateOnboardingRecommendations`.
 *
 * - source === 'pulse' → data is a RecommendationSet the caller
 *   should persist via setOnboardingRecommendations.
 * - source === 'needs_disambiguation' → no recommendations were
 *   generated (the AI call did not fire); the UI must surface the
 *   question on a 5th reflection card. The caller's next move is
 *   to append the user's answer to the reflection and re-invoke
 *   this function with `skipDisambiguationGate: true`.
 * - source === 'failed' → no usable output. The caller surfaces
 *   the retry screen; no fake content is produced. NEX-35.
 */
export type RecommendationResult =
  | { source: 'pulse'; data: RecommendationSet }
  | { source: 'needs_disambiguation'; disambiguationNeeded: DisambiguationPrompt }
  | { source: 'failed'; reason: 'no_reflection' | 'network' | 'parse' };

// ─── Length budgets — soft (prompt) + hard (parser) ──────────────────────────
//
// The system prompt advertises the soft budget; the parser enforces a
// slightly looser cap so Pulse has wiggle room. Output that overshoots
// the cap returns null from the parser, which the caller surfaces as
// a parse failure on the retry screen.

const MANDATE_TITLE_WORD_CAP = 6;
const HABIT_TITLE_WORD_CAP = 4;
const RECURRING_TODO_TITLE_WORD_CAP = 8;
const TODO_TITLE_WORD_CAP = 10;
const RATIONALE_WORD_CAP = 25;

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// NEX-35: CURATED_DEFAULTS / cloneCuratedDefaults removed. The
// service no longer synthesizes fake content on failure — callers
// receive { source: 'failed', reason } and surface the retry screen
// instead. See src/features/onboarding/retry-screen.tsx.

// ─── Disambiguation gate — client-side ───────────────────────────────────────
//
// NEX-38: triggers when total word count across all four reflection
// cards is below 40 (an average of 10 words per card). Under the new
// all-cards-required model, cards 2–4 are never empty, so the old
// "card 1 thin AND others empty" rule could never fire. The new rule
// catches the "uniformly thin answers" case where Pulse still
// wouldn't have enough signal to extract real mandates.
//
// The question + options are hardcoded — no AI call fires for the
// disambiguation prompt itself (per the locked Q3 answer). After the
// user answers, the caller re-invokes with skipDisambiguationGate: true.

const DISAMBIGUATION_MIN_TOTAL_WORDS = 40;

const DISAMBIGUATION_PROMPT: Readonly<DisambiguationPrompt> = {
  question: 'Tell me a bit more. What does that version of you do differently?',
  options: [
    'Body and health',
    'Work and craft',
    'Family and relationships',
    'Mind and meaning',
  ],
};

export function shouldDisambiguate(reflection: ReflectionInput): boolean {
  const total =
    countWords(reflection.bestVersion ?? '') +
    countWords(reflection.stop ?? '') +
    countWords(reflection.continue ?? '') +
    countWords(reflection.focus ?? '');
  return total < DISAMBIGUATION_MIN_TOTAL_WORDS;
}

// ─── System prompt scaffold (shared) ─────────────────────────────────────────
//
// All five exported generation functions reuse the same voice rules
// and length budgets. Each call site composes its task-specific
// instructions on top.

const VOICE_AND_BUDGETS = `Voice rules.
- No em dashes. No exclamation points.
- No "Welcome", "Unlock", "Leverage", "Crushing it", "Game-changer", or productivity-bro phrasing.
- Second person, declarative. Sentences end with weight.

Length budgets. Hard requirements. Output that exceeds these caps will be rejected and the user will see a curated fallback instead.
- Mandate titles: 4 to 6 words. Identity phrases, not goals or tasks. "Be present with my family", yes. "Spend more time with kids", no, that's a behavior.
- Habit titles: 2 to 4 words. Scannable on a phone screen. The cadence lives in daysOfWeek, not in the title.
  Good: "Morning sit", "Daily writing", "Evening reflection", "Morning sit, 10 min".
- Recurring-todo titles: 4 to 8 words. Same scannable register as habits, but action-oriented.
  Good: "Walk the dog at dusk", "Move three times this week", "Check in with one teammate".
- To-do titles: 6 to 10 words. A concrete action, not a literary description.
  Good: "Outline the next chapter of your novel", "Schedule your overdue physical this week".
- Rationales: one sentence, 12 to 20 words. Describe the practice's effect, not 'the mandate'. The mandate is already visible above the rationale on the user's screen.

Cadence.
- daysOfWeek uses 0=Sunday..6=Saturday. [0,1,2,3,4,5,6] is daily. Pick a realistic cadence per habit. Daily, weekdays, three-times-a-week.`;

const FULL_GENERATION_PROMPT = `You are Pulse, the recommendation engine for Nexus, a personal operating system.

The user just answered up to four reflection prompts that ask who they want to become and what they want to do about it. Your job is to read their reflection, extract the underlying mandates, and propose the daily practice that operationalizes each one.

The four reflection cards.
1. "What does the best version of you look like?" Required.
2. "What do you want to stop?" Optional.
3. "What do you want to continue?" Optional.
4. "What do you want to focus on moving forward?" Optional.

You will receive whichever cards the user filled in. Use what is there. Do not invent content from cards the user skipped.

${VOICE_AND_BUDGETS}

User voice preservation.
- Use the user's own words and phrases where you can. Reshape into identity phrases, but preserve their voice and vocabulary.
- A mandate title should read like something the user could imagine saying about themselves, in their own register. Not a category label.
- Worked example. User reflection says: "I keep running ahead of the people I love, half-listening, already on the next thing." Good mandate: "Stay with the people I love." That uses the user's own phrasing for "the people I love" and reshapes it as identity. Bad mandate: "Be more present." That's a generic category label the user did not say.

Extraction rules.
- Extract 3 to 5 mandates from the reflection. Track the reflection's depth. A longer, more textured answer earns more mandates. A thinner answer earns fewer.
- Mandates appear in the order the user surfaced them in their reflection. Do not rank or re-sort.
- Each mandate is an identity phrase, not a goal or task.
- Each mandate carries a category: BUSINESS, PERSONAL, or VISION. Pick the category that names the life surface the mandate operates on.
- Each mandate carries a rationaleSource, the reflection card it was extracted from: bestVersion, stop, continue, or focus.
- Each mandate carries an id you assign. An opaque 8-character random string prefixed with "m-" (lowercase letters and digits, e.g. "m-a3b4c5d6"). Ids must be unique within the response.
- Each mandate carries a rationale. One short sentence, 12 to 20 words, that names the connection between the user's reflection and this mandate. Paraphrase the user's words. Do not quote them verbatim. Describe the link, not 'the mandate' itself.

Three downstream buckets. Read carefully — this is where most engines fail.

Each mandate has TWO TO THREE habit options and TWO TO THREE downstream actions. The downstream actions split across two buckets — you decide which bucket each one belongs in.

Why multiple options. The user sees the pool and picks what resonates. Some will tap on one habit, others on two or three. Give them real choice, not a single take-it-or-leave-it offer. Within each mandate, the options must be DISTINCT angles on the mandate — not three variations of the same practice. If the mandate is "Be present with my family", the habits might be "Phone-free dinners" (presence at meals), "Saturday family ritual" (a weekly anchor), and "Evening device-down hour" (a daily window). Three different surfaces, not three flavors of phone-free.

Bucket 1: HABIT.
- A recurring practice the user wants to TRACK with streak feedback.
- Has daysOfWeek. The user will see their streak grow as they log it.
- 2 to 3 habit options per mandate.
- Examples: "Morning sit, 10 min", "Phone-free dinners", "Deep work, 90 min", "Read 20 minutes", "No work after 6pm".

Bucket 2: RECURRING-TODO.
- Something the user wants to do ON A CADENCE but not be scored on. A recurring intention, not a tracked discipline.
- Has daysOfWeek. Appears in the user's day. No streak math.
- Use for actions that recur but the user did not frame as a discipline they want to track.
- Examples: "Walk the dog at dusk", "Check in with one teammate", "Move three times this week".

Bucket 3: ONE-TIME-TODO.
- A discrete, specific action the user completes once and checks off. Has a clear endpoint.
- Optional dueDate (ISO YYYY-MM-DD) when the user specified a window. Omit otherwise.
- Examples: "Schedule your overdue physical this week", "Reach out to your old mentor for coffee", "Book one date night this week".

Classification decision tree (applies to each downstream action).
1. Will the user want to see a streak for it, or did they speak of it as a tracked discipline? → HABIT.
2. Otherwise, does it RECUR (more than once)? → RECURRING-TODO.
3. Otherwise, it is a ONE-TIME-TODO.

Recurring-action heuristic. "Move three times this week", "Stretch 20 minutes three times this week", "Journal each morning" are recurring actions. They are NEVER one-time-todos. Default to RECURRING-TODO unless the user explicitly framed the action as a streak they want to track, in which case HABIT.

Dedupe rule. Hard requirement.
- Each concept appears in exactly ONE bucket. Never two.
- Within a mandate's pool, each habit option must be a DISTINCT practice — not three variations of the same routine. Same rule for recurring-todos and one-time-todos within the mandate.
- Do not restate a habit as a recurring-todo or one-time-todo. If "No work after 6pm" is a habit option, do not also list "Close work by 6pm every day" as a recurring-todo or one-time-todo.
- Do not restate a recurring-todo as a one-time-todo. If "Stretch three times this week" is a recurring-todo, do not also list "Stretch on Friday" as a one-time-todo.
- Downstream actions must move the mandate forward in ways the habits alone cannot. Complementary, not redundant.
- Worked example of the failure mode. BAD: habits include "No work after 6pm" and one-time-todo "Close work by 6pm every day this week" — the same commitment described twice. GOOD: habits include "No work after 6pm" and one-time-todo "Schedule one date night this week with your spouse" — the to-do is a distinct move the habits alone cannot deliver.

Practice rules.
- 2 to 3 habits per mandate.
- 2 to 3 downstream actions per mandate, split across recurringTodos and todos by classification.
- Every habit, recurringTodo, and todo carries a mandateId matching its parent mandate.

Return valid JSON. No markdown fences. No prose.

Schema (values demonstrate the tight scannable register, match the length and voice; the example shows variable bucket counts).
{
  "mandates": [
    { "id": "m-a3b4c5d6", "title": "Be present with my family", "category": "PERSONAL", "rationaleSource": "bestVersion", "rationale": "Picks up the family thread you led with when you described who you want to be." },
    { "id": "m-x7y8z9w1", "title": "Build something worth my name", "category": "BUSINESS", "rationaleSource": "focus", "rationale": "Carries the work thread that ran through the longest part of your reflection." }
  ],
  "habits": [
    { "title": "Phone-free dinners", "daysOfWeek": [0,1,2,3,4,5,6], "mandateId": "m-a3b4c5d6", "rationale": "Removes the device that quietly pulls attention away from the room every evening." },
    { "title": "Saturday family ritual", "daysOfWeek": [6], "mandateId": "m-a3b4c5d6", "rationale": "Reserves one weekly anchor for the people you most want to see clearly." },
    { "title": "Evening device-down hour", "daysOfWeek": [0,1,2,3,4,5,6], "mandateId": "m-a3b4c5d6", "rationale": "Carves a daily window from the feed and gives it back to the room around you." },
    { "title": "Deep work, 90 min", "daysOfWeek": [1,2,3,4,5], "mandateId": "m-x7y8z9w1", "rationale": "One block where you defend the work from everything that wants to interrupt it." },
    { "title": "Daily writing", "daysOfWeek": [1,2,3,4,5], "mandateId": "m-x7y8z9w1", "rationale": "Builds the craft one weekday session at a time before context fragments." }
  ],
  "recurringTodos": [
    { "title": "Walk together after dinner", "daysOfWeek": [0,2,4,6], "mandateId": "m-a3b4c5d6", "rationale": "An untracked routine that gives the family a shared end-of-day reset without ceremony." }
  ],
  "todos": [
    { "title": "Call your parents this Sunday evening", "mandateId": "m-a3b4c5d6", "rationale": "Closes a recurring family loop you have been carrying silently for weeks." },
    { "title": "Ship the draft you have been editing for weeks", "mandateId": "m-x7y8z9w1", "dueDate": "2026-05-17", "rationale": "Closes the revision spiral by giving the draft a real release date this week." },
    { "title": "Outline the next chapter this Friday", "mandateId": "m-x7y8z9w1", "rationale": "Turns the work into a concrete artifact you can actually finish this week." }
  ]
}

Use a duration suffix like "10 min" or "90 min" only when the duration is the practice. Skip it for open-ended habits.`;

function buildReflectionUserPrompt(reflection: ReflectionInput): string {
  const lines: string[] = ['User reflection.'];
  lines.push(`Card 1 (best version of you): "${reflection.bestVersion.trim()}"`);
  if (reflection.stop?.trim())     lines.push(`Card 2 (what to stop): "${reflection.stop.trim()}"`);
  if (reflection.continue?.trim()) lines.push(`Card 3 (what to continue): "${reflection.continue.trim()}"`);
  if (reflection.focus?.trim())    lines.push(`Card 4 (focus moving forward): "${reflection.focus.trim()}"`);
  return lines.join('\n');
}

// ─── Parser — full payload ───────────────────────────────────────────────────
//
// The parser is silent on failure (returns null). A module-local
// `lastParseFailReason` captures the specific rule that fired so the
// caller's __DEV__ warn can show both reason + raw response. Tests
// can call `getLastParseFailReason()` after a null return to assert
// the exact validation path.

let lastParseFailReason: string | null = null;

function fail(reason: string): null {
  lastParseFailReason = reason;
  return null;
}

export function getLastParseFailReason(): string | null {
  return lastParseFailReason;
}

export function parseRecommendationPayload(raw: string): RecommendationSet | null {
  lastParseFailReason = null;
  if (typeof raw !== 'string' || !raw.trim()) return fail('empty raw input');
  const cleaned = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return fail('JSON.parse threw');
  }
  if (!parsed || typeof parsed !== 'object') return fail('top-level is not an object');

  const mandates = parseMandates(parsed.mandates);
  if (!mandates) return null;

  const mandateIds = new Set(mandates.map((m) => m.id));

  const habits = parseHabits(parsed.habits, mandateIds);
  if (!habits) return null;

  const recurringTodos = parseRecurringTodos(parsed.recurringTodos, mandateIds);
  if (!recurringTodos) return null;

  const todos = parseTodos(parsed.todos, mandateIds);
  if (!todos) return null;

  // NEX-57: per-mandate exactly 2 or 3 habits + 2 or 3 downstream
  // actions was too strict in practice — GPT-4o reliably gives 1-2,
  // not 2-3, even with explicit prompting. Relaxed to 1-3 so a
  // model that underdelivers still ships a working flow. The pool
  // concept still works with a smaller pool. We can tighten when
  // we add a model retry/repair pipeline.
  for (const m of mandates) {
    const habitCount = habits.filter((h) => h.mandateId === m.id).length;
    if (habitCount < 1 || habitCount > 3) {
      return fail(`mandate ${m.id} has ${habitCount} habits, expected 1 to 3`);
    }
    const recurringCount = recurringTodos.filter((rt) => rt.mandateId === m.id).length;
    const todoCount = todos.filter((t) => t.mandateId === m.id).length;
    const downstream = recurringCount + todoCount;
    if (downstream < 1 || downstream > 3) {
      return fail(
        `mandate ${m.id} has ${downstream} downstream actions ` +
        `(${recurringCount} recurringTodos + ${todoCount} todos), expected 1 to 3`,
      );
    }
  }

  return {
    mandates,
    habits,
    recurringTodos,
    todos,
  };
}

// Canonical mandate id format. Pulse is asked to emit this exact
// shape; the parser accepts any non-empty unique string for resilience
// but logs in dev when drift happens so we can tune the prompt.
const MANDATE_ID_FORMAT = /^m-[a-z0-9]{8}$/;

function parseMandates(raw: any): RecommendedMandate[] | null {
  if (!Array.isArray(raw)) return fail('mandates not an array');
  if (raw.length < 3 || raw.length > 5) return fail(`mandates length ${raw.length} not in 3..5`);
  const seenIds = new Set<string>();
  const out: RecommendedMandate[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') return fail('mandate entry not an object');
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    const title = typeof m.title === 'string' ? m.title.trim() : '';
    const category = typeof m.category === 'string' ? m.category.trim() : '';
    const rationaleSource = typeof m.rationaleSource === 'string' ? m.rationaleSource.trim() : '';
    const rationale = typeof m.rationale === 'string' ? m.rationale.trim() : '';
    if (!id) return fail('mandate missing id');
    if (seenIds.has(id)) return fail(`duplicate mandate id ${id}`);
    if (!MANDATE_ID_FORMAT.test(id) && typeof __DEV__ !== 'undefined' && __DEV__) {
      // Visibility only — id is accepted regardless of format so the user
      // doesn't hit the retry screen for a cosmetic id-format drift.
      // eslint-disable-next-line no-console
      console.warn(`[Pulse] mandate id "${id}" does not match canonical /^m-[a-z0-9]{8}$/ format`);
    }
    if (!title) return fail(`mandate ${id} missing title`);
    if (countWords(title) > MANDATE_TITLE_WORD_CAP) {
      return fail(`mandate ${id} title exceeds ${MANDATE_TITLE_WORD_CAP}-word cap`);
    }
    if (!category) return fail(`mandate ${id} missing category`);
    if (!isReflectionKey(rationaleSource)) {
      return fail(`mandate ${id} rationaleSource "${rationaleSource}" not a ReflectionKey`);
    }
    if (!rationale) return fail(`mandate ${id} missing rationale`);
    if (countWords(rationale) > RATIONALE_WORD_CAP) {
      return fail(`mandate ${id} rationale exceeds ${RATIONALE_WORD_CAP}-word cap`);
    }
    seenIds.add(id);
    out.push({
      id,
      slotId: id,
      title,
      category,
      rationaleSource,
      rationale,
      refreshCount: 0,
    });
  }
  return out;
}

function parseHabits(raw: any, mandateIds: Set<string>): RecommendedHabit[] | null {
  if (!Array.isArray(raw)) return fail('habits not an array');
  // NEX-57: 1-3 habits per mandate × 3-5 mandates = 3..15. Relaxed
  // from the strict 6..15 floor when we found GPT-4o reliably
  // underdelivers; the per-mandate check inside
  // parseRecommendationPayload still enforces the 1-3-per-mandate
  // rule.
  if (raw.length < 3 || raw.length > 15) return fail(`habits length ${raw.length} not in 3..15`);
  const out: RecommendedHabit[] = [];
  for (let i = 0; i < raw.length; i++) {
    const h = raw[i];
    if (!h || typeof h !== 'object') return fail('habit entry not an object');
    const title = typeof h.title === 'string' ? h.title.trim() : '';
    const rationale = typeof h.rationale === 'string' ? h.rationale.trim() : '';
    const mandateId = typeof h.mandateId === 'string' ? h.mandateId.trim() : '';
    if (!title) return fail(`habit ${i} missing title`);
    if (countWords(title) > HABIT_TITLE_WORD_CAP) {
      return fail(`habit "${title}" exceeds ${HABIT_TITLE_WORD_CAP}-word cap`);
    }
    if (!rationale) return fail(`habit ${i} missing rationale`);
    if (countWords(rationale) > RATIONALE_WORD_CAP) {
      return fail(`habit "${title}" rationale exceeds ${RATIONALE_WORD_CAP}-word cap`);
    }
    if (!Array.isArray(h.daysOfWeek) || h.daysOfWeek.length === 0) {
      return fail(`habit "${title}" missing or empty daysOfWeek`);
    }
    const cleanDays = h.daysOfWeek.filter(
      (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6,
    );
    if (cleanDays.length !== h.daysOfWeek.length) {
      return fail(`habit "${title}" daysOfWeek contains invalid integers`);
    }
    if (!mandateId || !mandateIds.has(mandateId)) {
      return fail(`habit "${title}" mandateId "${mandateId}" does not match any mandate`);
    }
    out.push({
      slotId: `h-${i}-${title.slice(0, 8).toLowerCase().replace(/\s/g, '')}`,
      title,
      daysOfWeek: cleanDays,
      mandateId,
      rationale,
      added: false,
      refreshCount: 0,
    });
  }
  return out;
}

function parseTodos(raw: any, mandateIds: Set<string>): RecommendedTodo[] | null {
  if (!Array.isArray(raw)) return fail('todos not an array');
  // NEX-57: one bucket could in theory hold all downstream (up to 3
  // per mandate × 5 mandates = 15). Per-mandate check enforces the
  // 2-or-3-combined rule.
  if (raw.length > 15) return fail(`todos length ${raw.length} exceeds 15`);
  const out: RecommendedTodo[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t || typeof t !== 'object') return fail('todo entry not an object');
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    const rationale = typeof t.rationale === 'string' ? t.rationale.trim() : '';
    const mandateId = typeof t.mandateId === 'string' ? t.mandateId.trim() : '';
    if (!title) return fail(`todo ${i} missing title`);
    if (countWords(title) > TODO_TITLE_WORD_CAP) {
      return fail(`todo "${title}" exceeds ${TODO_TITLE_WORD_CAP}-word cap`);
    }
    if (!rationale) return fail(`todo ${i} missing rationale`);
    if (countWords(rationale) > RATIONALE_WORD_CAP) {
      return fail(`todo "${title}" rationale exceeds ${RATIONALE_WORD_CAP}-word cap`);
    }
    if (!mandateId || !mandateIds.has(mandateId)) {
      return fail(`todo "${title}" mandateId "${mandateId}" does not match any mandate`);
    }
    // Optional dueDate (YYYY-MM-DD). Absent / empty string / null all
    // resolve to undefined (no due date set, app defaults to today).
    let dueDate: string | undefined;
    if (t.dueDate !== undefined && t.dueDate !== null) {
      if (typeof t.dueDate !== 'string') {
        return fail(`todo "${title}" dueDate must be a string when present`);
      }
      const trimmed = t.dueDate.trim();
      if (trimmed) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
          return fail(`todo "${title}" dueDate "${trimmed}" not in YYYY-MM-DD format`);
        }
        dueDate = trimmed;
      }
    }
    out.push({
      slotId: `t-${i}-${title.slice(0, 8).toLowerCase().replace(/\s/g, '')}`,
      title,
      mandateId,
      rationale,
      ...(dueDate ? { dueDate } : {}),
      added: false,
      refreshCount: 0,
    });
  }
  return out;
}

function parseRecurringTodos(raw: any, mandateIds: Set<string>): RecommendedRecurringTodo[] | null {
  if (!Array.isArray(raw)) return fail('recurringTodos not an array');
  // NEX-57: see parseTodos cap. Same upper bound.
  if (raw.length > 15) return fail(`recurringTodos length ${raw.length} exceeds 15`);
  const out: RecommendedRecurringTodo[] = [];
  for (let i = 0; i < raw.length; i++) {
    const rt = raw[i];
    if (!rt || typeof rt !== 'object') return fail('recurringTodo entry not an object');
    const title = typeof rt.title === 'string' ? rt.title.trim() : '';
    const rationale = typeof rt.rationale === 'string' ? rt.rationale.trim() : '';
    const mandateId = typeof rt.mandateId === 'string' ? rt.mandateId.trim() : '';
    if (!title) return fail(`recurringTodo ${i} missing title`);
    if (countWords(title) > RECURRING_TODO_TITLE_WORD_CAP) {
      return fail(`recurringTodo "${title}" exceeds ${RECURRING_TODO_TITLE_WORD_CAP}-word cap`);
    }
    if (!rationale) return fail(`recurringTodo ${i} missing rationale`);
    if (countWords(rationale) > RATIONALE_WORD_CAP) {
      return fail(`recurringTodo "${title}" rationale exceeds ${RATIONALE_WORD_CAP}-word cap`);
    }
    if (!Array.isArray(rt.daysOfWeek) || rt.daysOfWeek.length === 0) {
      return fail(`recurringTodo "${title}" missing or empty daysOfWeek`);
    }
    const cleanDays = rt.daysOfWeek.filter(
      (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6,
    );
    if (cleanDays.length !== rt.daysOfWeek.length) {
      return fail(`recurringTodo "${title}" daysOfWeek contains invalid integers`);
    }
    if (!mandateId || !mandateIds.has(mandateId)) {
      return fail(`recurringTodo "${title}" mandateId "${mandateId}" does not match any mandate`);
    }
    out.push({
      slotId: `rt-${i}-${title.slice(0, 8).toLowerCase().replace(/\s/g, '')}`,
      title,
      daysOfWeek: cleanDays,
      mandateId,
      rationale,
      added: false,
      refreshCount: 0,
    });
  }
  return out;
}

function isReflectionKey(v: string): v is ReflectionKey {
  return v === 'bestVersion' || v === 'stop' || v === 'continue' || v === 'focus';
}

// ─── Parsers — single-target regeneration ────────────────────────────────────
//
// Each single-target function uses its own narrow parser that mirrors
// the wire shape Pulse is asked to return for that call. Reusing the
// full-payload parser would be heavier than necessary and would force
// the model to return scaffolding (mandates[] / habits[] / todos[])
// for a single-slot regen.

interface SingleMandatePayload {
  title: string;
  category: string;
  rationaleSource: ReflectionKey;
  rationale: string;
}

function parseSingleMandate(raw: string): SingleMandatePayload | null {
  lastParseFailReason = null;
  if (typeof raw !== 'string' || !raw.trim()) return fail('empty raw input');
  const cleaned = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  let parsed: any;
  try { parsed = JSON.parse(cleaned); } catch { return fail('JSON.parse threw'); }
  if (!parsed || typeof parsed !== 'object') return fail('top-level not an object');
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const category = typeof parsed.category === 'string' ? parsed.category.trim() : '';
  const rationaleSource = typeof parsed.rationaleSource === 'string' ? parsed.rationaleSource.trim() : '';
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  if (!title) return fail('mandate missing title');
  if (countWords(title) > MANDATE_TITLE_WORD_CAP) {
    return fail(`mandate title exceeds ${MANDATE_TITLE_WORD_CAP}-word cap`);
  }
  if (!category) return fail('mandate missing category');
  if (!isReflectionKey(rationaleSource)) return fail(`rationaleSource "${rationaleSource}" invalid`);
  if (!rationale) return fail('mandate missing rationale');
  if (countWords(rationale) > RATIONALE_WORD_CAP) {
    return fail(`mandate rationale exceeds ${RATIONALE_WORD_CAP}-word cap`);
  }
  return { title, category, rationaleSource, rationale };
}

interface SingleHabitPayload {
  title: string;
  daysOfWeek: number[];
  rationale: string;
}

function parseSingleHabit(raw: string): SingleHabitPayload | null {
  lastParseFailReason = null;
  if (typeof raw !== 'string' || !raw.trim()) return fail('empty raw input');
  const cleaned = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  let parsed: any;
  try { parsed = JSON.parse(cleaned); } catch { return fail('JSON.parse threw'); }
  if (!parsed || typeof parsed !== 'object') return fail('top-level not an object');
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  if (!title) return fail('habit missing title');
  if (countWords(title) > HABIT_TITLE_WORD_CAP) {
    return fail(`habit title exceeds ${HABIT_TITLE_WORD_CAP}-word cap`);
  }
  if (!rationale) return fail('habit missing rationale');
  if (countWords(rationale) > RATIONALE_WORD_CAP) {
    return fail(`habit rationale exceeds ${RATIONALE_WORD_CAP}-word cap`);
  }
  if (!Array.isArray(parsed.daysOfWeek) || parsed.daysOfWeek.length === 0) {
    return fail('habit missing or empty daysOfWeek');
  }
  const cleanDays = parsed.daysOfWeek.filter(
    (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6,
  );
  if (cleanDays.length !== parsed.daysOfWeek.length) return fail('daysOfWeek contains invalid integers');
  return { title, daysOfWeek: cleanDays, rationale };
}

interface SingleTodoPayload {
  title: string;
  rationale: string;
}

function parseSingleTodo(raw: string): SingleTodoPayload | null {
  lastParseFailReason = null;
  if (typeof raw !== 'string' || !raw.trim()) return fail('empty raw input');
  const cleaned = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  let parsed: any;
  try { parsed = JSON.parse(cleaned); } catch { return fail('JSON.parse threw'); }
  if (!parsed || typeof parsed !== 'object') return fail('top-level not an object');
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  if (!title) return fail('todo missing title');
  if (countWords(title) > TODO_TITLE_WORD_CAP) {
    return fail(`todo title exceeds ${TODO_TITLE_WORD_CAP}-word cap`);
  }
  if (!rationale) return fail('todo missing rationale');
  if (countWords(rationale) > RATIONALE_WORD_CAP) {
    return fail(`todo rationale exceeds ${RATIONALE_WORD_CAP}-word cap`);
  }
  return { title, rationale };
}

interface SingleRecurringTodoPayload {
  title: string;
  daysOfWeek: number[];
  rationale: string;
}

function parseSingleRecurringTodo(raw: string): SingleRecurringTodoPayload | null {
  lastParseFailReason = null;
  if (typeof raw !== 'string' || !raw.trim()) return fail('empty raw input');
  const cleaned = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  let parsed: any;
  try { parsed = JSON.parse(cleaned); } catch { return fail('JSON.parse threw'); }
  if (!parsed || typeof parsed !== 'object') return fail('top-level not an object');
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  if (!title) return fail('recurringTodo missing title');
  if (countWords(title) > RECURRING_TODO_TITLE_WORD_CAP) {
    return fail(`recurringTodo title exceeds ${RECURRING_TODO_TITLE_WORD_CAP}-word cap`);
  }
  if (!rationale) return fail('recurringTodo missing rationale');
  if (countWords(rationale) > RATIONALE_WORD_CAP) {
    return fail(`recurringTodo rationale exceeds ${RATIONALE_WORD_CAP}-word cap`);
  }
  if (!Array.isArray(parsed.daysOfWeek) || parsed.daysOfWeek.length === 0) {
    return fail('recurringTodo missing or empty daysOfWeek');
  }
  const cleanDays = parsed.daysOfWeek.filter(
    (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6,
  );
  if (cleanDays.length !== parsed.daysOfWeek.length) return fail('daysOfWeek contains invalid integers');
  return { title, daysOfWeek: cleanDays, rationale };
}

interface DownstreamPayload {
  habits: SingleHabitPayload[];
  recurringTodos: SingleRecurringTodoPayload[];
  todos: SingleTodoPayload[];
}

function parseDownstreamPayload(raw: string): DownstreamPayload | null {
  lastParseFailReason = null;
  if (typeof raw !== 'string' || !raw.trim()) return fail('empty raw input');
  const cleaned = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  let parsed: any;
  try { parsed = JSON.parse(cleaned); } catch { return fail('JSON.parse threw'); }
  if (!parsed || typeof parsed !== 'object') return fail('top-level not an object');
  // NEX-57: 1 to 3 habits per mandate. Relaxed from strict 2-3 when
  // we found GPT-4o reliably underdelivers in production.
  if (!Array.isArray(parsed.habits)) return fail('downstream missing habits array');
  if (parsed.habits.length < 1 || parsed.habits.length > 3) {
    return fail(`downstream habits count ${parsed.habits.length}, expected 1..3`);
  }
  const habits: SingleHabitPayload[] = [];
  for (let i = 0; i < parsed.habits.length; i++) {
    const h = parseSingleHabit(JSON.stringify(parsed.habits[i]));
    if (!h) return null;
    habits.push(h);
  }
  // Recurring todos — optional (model may emit empty array or omit).
  const recurringTodos: SingleRecurringTodoPayload[] = [];
  if (parsed.recurringTodos != null) {
    if (!Array.isArray(parsed.recurringTodos)) return fail('downstream recurringTodos not an array');
    for (let i = 0; i < parsed.recurringTodos.length; i++) {
      const rt = parseSingleRecurringTodo(JSON.stringify(parsed.recurringTodos[i]));
      if (!rt) return null;
      recurringTodos.push(rt);
    }
  }
  // Todos — optional (model may emit empty array or omit).
  const todos: SingleTodoPayload[] = [];
  if (parsed.todos != null) {
    if (!Array.isArray(parsed.todos)) return fail('downstream todos not an array');
    for (let i = 0; i < parsed.todos.length; i++) {
      const t = parseSingleTodo(JSON.stringify(parsed.todos[i]));
      if (!t) return null;
      todos.push(t);
    }
  }
  // NEX-57: combined downstream rule is 1 to 3 actions across the two buckets.
  const downstream = recurringTodos.length + todos.length;
  if (downstream < 1 || downstream > 3) {
    return fail(`downstream count ${downstream} (${recurringTodos.length} recurring + ${todos.length} todos), expected 1..3`);
  }
  return { habits, recurringTodos, todos };
}

// ─── Dev-mode logging helpers ────────────────────────────────────────────────

function devWarn(label: string, raw?: string): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  const reason = lastParseFailReason ?? 'unknown';
  // eslint-disable-next-line no-console
  console.warn(`[Pulse] ${label} (reason: ${reason})`, raw ? raw.slice(0, 500) : '');
}

// ─── Exported function 1: full initial generation ────────────────────────────

export async function generateOnboardingRecommendations(
  reflection: ReflectionInput,
  options: { skipDisambiguationGate?: boolean } = {},
): Promise<RecommendationResult> {
  // NEX-35: empty / missing card 1 is the no_reflection failure
  // path. Callers surface the retry screen.
  if (!reflection || !reflection.bestVersion?.trim()) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[Pulse] generateOnboardingRecommendations called without bestVersion. Surfacing failed/no_reflection.');
    }
    return { source: 'failed', reason: 'no_reflection' };
  }

  // Client-side disambiguation gate. Returns BEFORE any AI call.
  if (!options.skipDisambiguationGate && shouldDisambiguate(reflection)) {
    return {
      source: 'needs_disambiguation',
      disambiguationNeeded: { ...DISAMBIGUATION_PROMPT, options: [...DISAMBIGUATION_PROMPT.options] },
    };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: FULL_GENERATION_PROMPT },
    { role: 'user', content: buildReflectionUserPrompt(reflection) },
  ];

  let raw: string;
  try {
    raw = await chatCompletion(messages, {
      model: MODELS.MANDATE_GENERATION,
      response_format: { type: 'json_object' },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pulse-recommendations] chatCompletion failed:', (e as Error)?.message ?? e);
    return { source: 'failed', reason: 'network' };
  }

  const parsed = parseRecommendationPayload(raw);
  if (!parsed) {
    // One silent retry before surfacing failed/parse — a transient
    // malformed response shouldn't send the user to the retry screen
    // on the first miss. Network failures inside the retry fall
    // through to the same failed/parse result (the first response
    // DID arrive; the problem is parse, not network).
    devWarn('Recommendation parse failed on first attempt, retrying once. Raw response:', raw);
    let raw2: string | undefined;
    try {
      raw2 = await chatCompletion(messages, {
        model: MODELS.MANDATE_GENERATION,
        response_format: { type: 'json_object' },
      });
      const parsed2 = parseRecommendationPayload(raw2);
      if (parsed2) return { source: 'pulse', data: parsed2 };
    } catch (_) {
      // swallow — fall through to failed/parse below
    }
    devWarn('Recommendation parse failed after retry. Retry response:', raw2);
    return { source: 'failed', reason: 'parse' };
  }
  return { source: 'pulse', data: parsed };
}

// ─── Exported function 2: regenerateMandateOnly ──────────────────────────────

const REGEN_MANDATE_ONLY_PROMPT = `You are Pulse, returning an alternative wording for an existing mandate. Keep the underlying meaning the same. The mandate id, the user's reflection, the current title, and the current rationale are provided. Suggest a different phrasing of the same identity, with a fresh rationale that ties the new wording back to the user's reflection.

${VOICE_AND_BUDGETS}

User voice preservation.
- Reshape into a new identity phrase, but keep the user's voice and vocabulary where you can.
- The new title should read like something the user could imagine saying about themselves, in their own register.

Rules.
- Title must be 4 to 6 words. Identity phrase, not a goal or task.
- Rationale is one sentence, 12 to 20 words, paraphrasing the user's reflection. Do not quote them verbatim. Describe the link, not 'the mandate' itself.
- category and rationaleSource stay the same as the input. Do not change them.
- Return valid JSON. No markdown fences. No prose.

{ "title": "...", "category": "...", "rationaleSource": "bestVersion", "rationale": "..." }`;

export async function regenerateMandateOnly(input: {
  mandate: Pick<RecommendedMandate, 'id' | 'slotId' | 'title' | 'category' | 'rationaleSource' | 'rationale'>;
  reflection: ReflectionInput;
}): Promise<RecommendedMandate | null> {
  const userPrompt = [
    `Mandate id: ${input.mandate.id}`,
    `Current title: "${input.mandate.title}"`,
    `Current rationale: "${input.mandate.rationale}"`,
    `Category: ${input.mandate.category}`,
    `RationaleSource: ${input.mandate.rationaleSource}`,
    '',
    buildReflectionUserPrompt(input.reflection),
  ].join('\n');
  let raw: string;
  try {
    raw = await chatCompletion(
      [
        { role: 'system', content: REGEN_MANDATE_ONLY_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { model: MODELS.MANDATE_GENERATION, response_format: { type: 'json_object' } },
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pulse-recommendations] regenerateMandateOnly chatCompletion failed:', (e as Error)?.message ?? e);
    return null;
  }
  const parsed = parseSingleMandate(raw);
  if (!parsed) {
    devWarn('regenerateMandateOnly parse failed', raw);
    return null;
  }
  return {
    id: input.mandate.id,
    slotId: input.mandate.slotId,
    title: parsed.title,
    category: input.mandate.category,
    rationaleSource: input.mandate.rationaleSource,
    rationale: parsed.rationale,
    refreshCount: 0, // caller bumps via the reducer
  };
}

// ─── Exported function 3: regenerateMandateDownstream ────────────────────────

const REGEN_DOWNSTREAM_PROMPT = `You are Pulse. The user just edited a mandate (or asked for a fresh pool of options). Generate a fresh POOL of 2 TO 3 habit options + 2 TO 3 downstream actions that operationalize the EDITED mandate. The mandate id, the EDITED title, and the user's reflection are provided.

${VOICE_AND_BUDGETS}

Three downstream buckets.

Bucket 1: HABIT.
- A recurring practice the user wants to TRACK with streak feedback. daysOfWeek. 2 to 3 distinct options per mandate — each a different angle on the mandate, not three flavors of the same routine.

Bucket 2: RECURRING-TODO.
- Something the user wants to do ON A CADENCE but not be scored on. daysOfWeek. No streak math.

Bucket 3: ONE-TIME-TODO.
- A discrete action with a clear endpoint. Optional dueDate (YYYY-MM-DD) when the user specified a window.

Classification (per downstream action).
1. Will the user want a streak for it? → HABIT.
2. Otherwise does it recur? → RECURRING-TODO.
3. Otherwise → ONE-TIME-TODO.

Recurring-action heuristic. "Move three times this week", "Stretch each morning" are recurring actions, never one-time-todos.

Dedupe rule. Hard requirement. Each concept appears in exactly ONE bucket. Habit options within the mandate must be DISTINCT practices — not three variations of the same routine. If "No work after 6pm" is a habit option, do not also list "Close work by 6pm" as a recurring-todo or one-time-todo. Downstream actions move the mandate forward in ways the habits alone cannot. Complementary, not redundant.

Rules.
- 2 to 3 habits per mandate. 2 to 3 downstream actions total, split across recurringTodos and todos by classification.
- All linked to the provided mandate (mandateId is added by the runtime; you do not need to emit it).
- Return valid JSON. No markdown fences. No prose.

{
  "habits": [
    { "title": "Phone-free dinners", "daysOfWeek": [0,1,2,3,4,5,6], "rationale": "Removes the device that quietly pulls attention away from the room every evening." },
    { "title": "Saturday family ritual", "daysOfWeek": [6], "rationale": "Reserves one weekly anchor for the people you most want to see clearly." },
    { "title": "Evening device-down hour", "daysOfWeek": [0,1,2,3,4,5,6], "rationale": "Carves a daily window from the feed and gives it back to the room around you." }
  ],
  "recurringTodos": [
    { "title": "Walk together after dinner", "daysOfWeek": [0,2,4,6], "rationale": "An untracked routine that gives the family a shared end-of-day reset without ceremony." }
  ],
  "todos": [
    { "title": "Call your parents this Sunday evening", "rationale": "Closes a recurring family loop you have been carrying silently for weeks." }
  ]
}`;

export async function regenerateMandateDownstream(input: {
  mandate: Pick<RecommendedMandate, 'id' | 'title' | 'category' | 'rationaleSource'>;
  reflection: ReflectionInput;
}): Promise<{ habits: RecommendedHabit[]; recurringTodos: RecommendedRecurringTodo[]; todos: RecommendedTodo[] } | null> {
  const userPrompt = [
    `Mandate (edited): "${input.mandate.title}"`,
    `Category: ${input.mandate.category}`,
    `Mandate id: ${input.mandate.id}`,
    '',
    buildReflectionUserPrompt(input.reflection),
  ].join('\n');
  let raw: string;
  try {
    raw = await chatCompletion(
      [
        { role: 'system', content: REGEN_DOWNSTREAM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { model: MODELS.DAILY_PULSE, response_format: { type: 'json_object' } },
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pulse-recommendations] regenerateMandateDownstream chatCompletion failed:', (e as Error)?.message ?? e);
    return null;
  }
  const parsed = parseDownstreamPayload(raw);
  if (!parsed) {
    devWarn('regenerateMandateDownstream parse failed', raw);
    return null;
  }
  const now = Date.now();
  return {
    habits: parsed.habits.map((h, i) => ({
      slotId: `h-${input.mandate.id}-${now}-${i}`,
      title: h.title,
      daysOfWeek: h.daysOfWeek,
      mandateId: input.mandate.id,
      rationale: h.rationale,
      added: false,
      refreshCount: 0,
    })),
    recurringTodos: parsed.recurringTodos.map((rt, i) => ({
      slotId: `rt-${input.mandate.id}-${now}-${i}`,
      title: rt.title,
      daysOfWeek: rt.daysOfWeek,
      mandateId: input.mandate.id,
      rationale: rt.rationale,
      added: false,
      refreshCount: 0,
    })),
    todos: parsed.todos.map((t, i) => ({
      slotId: `t-${input.mandate.id}-${now}-${i}`,
      title: t.title,
      mandateId: input.mandate.id,
      rationale: t.rationale,
      added: false,
      refreshCount: 0,
    })),
  };
}

// ─── Exported function 4: regenerateHabit ────────────────────────────────────

const REGEN_HABIT_PROMPT = `You are Pulse. Suggest an alternative habit for a mandate the user has already accepted. Keep the mandate's meaning. Propose a different practice that operationalizes the same identity.

${VOICE_AND_BUDGETS}

Rules.
- One habit. Title 2 to 4 words. Realistic daysOfWeek.
- Rationale describes the practice's effect, not 'the mandate'. The mandate is already visible above the rationale on the user's screen.
- Return valid JSON. No markdown fences. No prose.

{ "title": "...", "daysOfWeek": [...], "rationale": "..." }`;

export async function regenerateHabit(input: {
  slotId: string;
  mandate: Pick<RecommendedMandate, 'id' | 'title' | 'category'>;
  reflection: ReflectionInput;
}): Promise<RecommendedHabit | null> {
  const userPrompt = [
    `Mandate: "${input.mandate.title}" (category: ${input.mandate.category})`,
    `Mandate id: ${input.mandate.id}`,
    '',
    buildReflectionUserPrompt(input.reflection),
  ].join('\n');
  let raw: string;
  try {
    raw = await chatCompletion(
      [
        { role: 'system', content: REGEN_HABIT_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { model: MODELS.DAILY_PULSE, response_format: { type: 'json_object' } },
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pulse-recommendations] regenerateHabit chatCompletion failed:', (e as Error)?.message ?? e);
    return null;
  }
  const parsed = parseSingleHabit(raw);
  if (!parsed) {
    devWarn('regenerateHabit parse failed', raw);
    return null;
  }
  return {
    slotId: input.slotId,
    title: parsed.title,
    daysOfWeek: parsed.daysOfWeek,
    mandateId: input.mandate.id,
    rationale: parsed.rationale,
    added: false,
    refreshCount: 0,
  };
}

// ─── Exported function 5: regenerateTodo ─────────────────────────────────────

const REGEN_TODO_PROMPT = `You are Pulse. Suggest an alternative to-do for a mandate the user has already accepted. Keep the mandate's meaning. Propose a different concrete action that operationalizes the same identity.

${VOICE_AND_BUDGETS}

Rules.
- One to-do. Title 6 to 10 words.
- Rationale describes the action's effect, not 'the mandate'. The mandate is already visible above the rationale on the user's screen.
- Return valid JSON. No markdown fences. No prose.

{ "title": "...", "rationale": "..." }`;

export async function regenerateTodo(input: {
  slotId: string;
  mandate: Pick<RecommendedMandate, 'id' | 'title' | 'category'>;
  reflection: ReflectionInput;
}): Promise<RecommendedTodo | null> {
  const userPrompt = [
    `Mandate: "${input.mandate.title}" (category: ${input.mandate.category})`,
    `Mandate id: ${input.mandate.id}`,
    '',
    buildReflectionUserPrompt(input.reflection),
  ].join('\n');
  let raw: string;
  try {
    raw = await chatCompletion(
      [
        { role: 'system', content: REGEN_TODO_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { model: MODELS.DAILY_PULSE, response_format: { type: 'json_object' } },
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pulse-recommendations] regenerateTodo chatCompletion failed:', (e as Error)?.message ?? e);
    return null;
  }
  const parsed = parseSingleTodo(raw);
  if (!parsed) {
    devWarn('regenerateTodo parse failed', raw);
    return null;
  }
  return {
    slotId: input.slotId,
    title: parsed.title,
    mandateId: input.mandate.id,
    rationale: parsed.rationale,
    added: false,
    refreshCount: 0,
  };
}
