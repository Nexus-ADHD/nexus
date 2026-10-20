/**
 * confidence-tier.ts
 *
 * NEX-197 (ADHD pivot P1.4) — confidence-tiered capture, no pre-save form.
 *
 * Pure, side-effect-free, RN-free (vitest-coverable). Decides how a parsed
 * batch of ProposedActions should be confirmed:
 *
 *   high   → execute immediately (implicit confirm by relocation + one line)
 *   medium → exactly ONE scoped tap-chip question, then execute (one exchange)
 *   low    → handled by the screen (parse failure / empty) — verbatim transcript
 *
 * Safety gate (NEX-197 review): with the review form gone, scheduled/external
 * writes (todo_add due dates, calendar_add EventKit events) must NOT auto-fire
 * on a model-guessed date/time. `validateProposedAction` only checks that an
 * ISO string parses, never that the user actually said a time — so we add a
 * raw-transcript evidence check. No date/time evidence → ask one chip question
 * instead of silently writing a guess.
 */

import {
  ProposedAction,
  normalizeProposedAction,
  validateProposedAction,
} from '../../utils/recurrence';
import { todayKey, tomorrowKey, weekendKey } from './date-tokens';

export type CaptureTier = 'high' | 'medium' | 'low';

export interface ClarificationChip {
  label: string;
  patch: Partial<ProposedAction>;
}

export interface Clarification {
  /**
   * Which scoped field the single question fills. Calendar events are never
   * clarified by chip — an under-specified or low-confidence calendar_add is
   * captured to Inbox instead (a precise EventKit write must come entirely from
   * the user, never a chip-anchored guess), so 'time' is intentionally absent.
   */
  fieldKey: 'daysOfWeek' | 'date';
  /** Short, calm question text. */
  prompt: string;
  /** Indices in `actions` the chosen chip patches. */
  targetIndices: number[];
  chips: ClarificationChip[];
}

export interface CaptureResolution {
  tier: CaptureTier;
  /** The executable action list (post safety-prep + any Inbox downgrades). */
  actions: ProposedAction[];
  /** Present only when tier === 'medium'. At most one is ever returned. */
  clarification?: Clarification;
}

// ─── Raw-transcript evidence (the safety gate) ───────────────────────────────

// CALIBRATION: these regexes decide whether a scheduled write may auto-fire.
// Tune against real ADHD speech samples — keep the bands in this one file.
const TIME_RE =
  /\b\d{1,2}\s*:\s*\d{2}\b|\b\d{1,2}\s*(a\.?m\.?|p\.?m\.?)\b|\b(noon|midday|midnight|tonight|this morning|this afternoon|this evening|morning|afternoon|evening|tonite)\b/i;

const DATE_RE =
  /\b(today|tonight|tonite|tomorrow|tmrw|tmw|this week|next week|this weekend|weekend|next \w+day)\b|\b(mon|tue|tues|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|monday|tuesday)\b|\b\d{1,2}(st|nd|rd|th)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b/i;

/** True when the transcript names a clock time (or strong time-of-day word). */
export function hasExplicitTime(raw: string): boolean {
  return TIME_RE.test(raw ?? '');
}

/** True when the transcript names a date / weekday / relative day. */
export function hasExplicitDate(raw: string): boolean {
  return DATE_RE.test(raw ?? '');
}

// A recurring cadence in the transcript ("every Sunday", "every weekday",
// "daily", "every morning"). For a RECURRING calendar_add the cadence IS the
// schedule, so it stands in for the one-off-date evidence DATE_RE looks for
// (DATE_RE matches named weekdays but not "daily"/"every day"/"every weekday").
// `every`/`each` are NOT standalone alternatives — they must be followed by a
// time-unit/weekday (optionally "other"/"N") so "check EACH task at 10am" or
// "remind EVERYone" don't trivially satisfy this safety gate (the gate is the
// sole code guard against a spurious irreversible recurring EventKit write).
const RECURRENCE_RE =
  /\b(?:everyday|daily|weekly|biweekly|fortnightly|recurring)\b|\b(?:every|each)\s+(?:other\s+|second\s+|two\s+|three\s+|\d+\s+)?(?:days?|weeks?|months?|mornings?|afternoons?|evenings?|nights?|weekdays?|weekends?|sun(?:day)?|mon(?:day)?|tues?(?:day)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b|\b(?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|weekdays|weekends)\b/i;

/** True when the transcript expresses a recurring cadence. */
export function hasExplicitRecurrence(raw: string): boolean {
  return RECURRENCE_RE.test(raw ?? '');
}

// Local naive-ISO date helpers (todayKey/tomorrowKey/weekendKey) now live in
// ./date-tokens so the Tier-1 grammar parser resolves dates in the same format
// this gate expects (NEX-223).

// ─── Inbox capture (one builder, used by prep + downgrades) ──────────────────

/**
 * Convert any action into a visible Inbox capture with explicit copy.
 * NEX-302: the normalized title no longer carries the schedule words the old
 * verbatim title incidentally kept ("Podcast", not "…at 5 PM today"), so a
 * downgrade backfills the raw transcript into the description — what the user
 * actually said stays on the surfaced item (Law A: surfacing must not shed the
 * capture's content).
 */
function toInbox(action: ProposedAction, explanation: string, raw?: string): ProposedAction {
  return normalizeProposedAction({
    type: 'inbox_add',
    title: action.title,
    description: action.description || (raw?.trim() ? raw.trim() : undefined),
    confidence: action.confidence,
    nextAction: 'Schedule from Inbox',
    explanation,
  });
}

// ─── Action prep + per-action "need" ─────────────────────────────────────────

/**
 * Default `timesPerDay: 1` for any habit with no explicit time-of-day, so the
 * only thing a habit can ever be missing is its days. A timeless habit
 * ("meditate every day") is valid as-is, and a dayless one becomes valid the
 * instant the "Which days?" chip is tapped — never an ask-then-Inbox-downgrade.
 * Hick's-law default over choice (ADHD §1.5 Law D).
 */
function prepareAction(action: ProposedAction, raw: string): ProposedAction {
  const a = normalizeProposedAction(action);

  // A low-confidence recurring action (habit or chore) means the model wasn't
  // sure this is a repeating commitment. Creating a recurring rule off that is
  // too committal — capture it to a visible Inbox item so the user confirms it,
  // rather than auto-executing an uncertain habit. (P1) A lone one falls to the
  // low tier (retry) via the wholly-low check; in a mixed batch it stays visible.
  if (
    (a.type === 'recurring_add' || a.type === 'recurring_todo_add') &&
    a.confidence === 'low'
  ) {
    return toInbox(a, 'Captured to Inbox — confirm it there when ready.', raw);
  }

  if (
    a.type === 'recurring_add' &&
    !a.time &&
    !a.preferredTimeBlock &&
    !(a.timesPerDay && a.timesPerDay >= 1)
  ) {
    return normalizeProposedAction({ ...a, timesPerDay: 1 });
  }

  // Interval-only chore ("water plants every other day"): the parser emits a
  // recurring_todo_add with interval>=2 and no weekday. A day-interval cadence is
  // not representable in the daysOfWeek + week-interval model (the today rollup
  // matches daysOfWeek first, so defaulting to every-day would fire every day on
  // alternating weeks, not every other day). Capture it to Inbox so the cadence
  // is set deliberately rather than silently corrupted or asked the wrong way. (P2)
  if (
    a.type === 'recurring_todo_add' &&
    (a.interval ?? 1) >= 2 &&
    (a.daysOfWeek?.length ?? 0) === 0
  ) {
    return toInbox(a, 'Captured to Inbox. A day-interval cadence is not schedulable yet, so set it up here.', raw);
  }

  // A calendar event is an irreversible external EventKit write that needs a
  // precise time AND a schedule. We never resolve a missing/guessed date or time
  // with a chip (anchoring a guess, or making an uncertain event executable). So a
  // calendar_add only survives as a calendar when the user explicitly stated a
  // time AND its schedule AND the model is explicitly high-confidence; anything
  // less is captured to Inbox to schedule deliberately. (P1 — require positive
  // confidence, not just non-low.) The "schedule" evidence is a recurring cadence
  // for a repeating block (the cadence IS the schedule) or an explicit one-off
  // date otherwise.
  if (a.type === 'calendar_add') {
    const recurring = !!a.recurrence;
    const fullySpecified =
      validateProposedAction(a).valid &&
      hasExplicitTime(raw) &&
      a.confidence === 'high' &&
      (recurring ? hasExplicitRecurrence(raw) : hasExplicitDate(raw));
    if (!fullySpecified) {
      return toInbox(a, 'Captured to Inbox. Add the day and time, then it lands on your calendar.', raw);
    }
    return a;
  }

  return a;
}

type FieldKey = Clarification['fieldKey'];

/** Returns the single scoped field this action still needs, or null if high-ready. */
function actionNeed(action: ProposedAction, raw: string): FieldKey | null {
  switch (action.type) {
    case 'inbox_add':
    case 'align':
      return null;
    case 'recurring_add':
    case 'recurring_todo_add':
      // Interval-only chores are pre-defaulted to every-day in prepareAction, so
      // the only thing still missing here is genuinely weekdays.
      return (action.daysOfWeek?.length ?? 0) > 0 ? null : 'daysOfWeek';
    case 'todo_add': {
      const valid = validateProposedAction(action).valid;
      // A one-off may only auto-write its due date when it has a user-evidenced
      // date AND the model is explicitly high-confidence. Anything less routes to
      // the "When?" chips (Today/Tomorrow/Weekend) — an explicit one-tap user
      // confirmation, never a silent write off a guessed or uncertain parse. (P1)
      return valid && hasExplicitDate(raw) && action.confidence === 'high' ? null : 'date';
    }
    case 'calendar_add':
      // prepareAction already routed any under-specified or low-confidence
      // calendar_add to Inbox, so a surviving calendar_add is fully high-ready.
      return null;
    default:
      return null;
  }
}

const FALLBACK_REASON: Record<FieldKey, string> = {
  daysOfWeek: 'Captured to Inbox — pick its days when ready.',
  date: 'Captured to Inbox — it still needs a date.',
};

/**
 * Coerce a still-unschedulable action into a visible Inbox capture (never silent).
 * `missingField` makes the confirmation copy accurate.
 */
export function inboxFallback(
  action: ProposedAction,
  missingField?: FieldKey,
  raw?: string,
): ProposedAction {
  return toInbox(
    action,
    missingField ? FALLBACK_REASON[missingField] : 'Captured to Inbox — schedule it when ready.',
    raw,
  );
}

// ─── Clarification builders ──────────────────────────────────────────────────

function buildClarification(
  fieldKey: FieldKey,
  targetIndices: number[],
  now: Date,
): Clarification {
  if (fieldKey === 'daysOfWeek') {
    return {
      fieldKey,
      prompt: 'Which days?',
      targetIndices,
      chips: [
        { label: 'Every day', patch: { daysOfWeek: [0, 1, 2, 3, 4, 5, 6] } },
        { label: 'Weekdays', patch: { daysOfWeek: [1, 2, 3, 4, 5] } },
        { label: 'Weekends', patch: { daysOfWeek: [0, 6] } },
      ],
    };
  }
  // date — the chips are explicit user choices, never a guess.
  return {
    fieldKey,
    prompt: 'When?',
    targetIndices,
    chips: [
      { label: 'Today', patch: { dateStr: todayKey(now) } },
      { label: 'Tomorrow', patch: { dateStr: tomorrowKey(now) } },
      { label: 'This weekend', patch: { dateStr: weekendKey(now) } },
    ],
  };
}

// ─── The reducer ─────────────────────────────────────────────────────────────

const FIELD_PRIORITY: FieldKey[] = ['daysOfWeek', 'date'];

/**
 * Resolve the confirmation tier for a parsed batch.
 *
 * Guarantees:
 *  - At most ONE clarification is ever returned ("one question max").
 *  - A `recurring_add` (a habit) is never downgraded to Inbox — habits are
 *    always resolvable via the days question or the timesPerDay default
 *    (rule 16 / Law E: a spoken "habit" must not become a buried Inbox note).
 *  - Heterogeneous unresolved scheduled actions are coerced to a VISIBLE Inbox
 *    capture (surfaced in the ledger), never silently dropped.
 *
 * `now` is injectable for deterministic tests.
 */
export function resolveCaptureTier(
  rawActions: ProposedAction[],
  rawText: string,
  now: Date = new Date(),
): CaptureResolution {
  let actions = (Array.isArray(rawActions) ? rawActions : []).map((a) => prepareAction(a, rawText));
  if (actions.length === 0) return { tier: 'low', actions: [] };

  // Compound safety: the transcript-level date/time evidence in prepareAction
  // cannot be attributed to a specific action, so in a multi-action capture a
  // calendar_add could pass the gate on date/time words that actually belonged to
  // a sibling action ("add standup tomorrow at 9am and a dentist appointment" —
  // the dentist has no time of its own). A single-utterance calendar write stays
  // direct; a compound one is captured to Inbox to schedule deliberately. (P1)
  if (actions.length > 1) {
    actions = actions.map((a) =>
      a.type === 'calendar_add'
        ? toInbox(a, 'Captured to Inbox. Add the day and time, then it lands on your calendar.', rawText)
        : a,
    );
  }

  // A wholly low-confidence batch means the model wasn't sure it understood the
  // capture at all — show the transcript + retry, never silently save or write it.
  // Covers the coerceAction `[null]` inbox fallback AND a lone low-confidence
  // calendar/todo that would otherwise pass the evidence checks. (P1)
  if (actions.every((a) => a.confidence === 'low')) {
    return { tier: 'low', actions: [] };
  }

  // Drop low-confidence parse NOISE when confident actions exist alongside it: the
  // coerceAction malformed/vague fallback carries nextAction 'Clarify intent'.
  // Saving that next to a confident sibling is an incorrect save. We do NOT drop a
  // scheduled item that prepareAction deliberately downgraded to a VISIBLE Inbox
  // capture (nextAction 'Schedule from Inbox') — that one must stay visible so the
  // user still sees it. (A wholly low/empty batch already returned low above.)
  const isParseNoise = (a: ProposedAction) =>
    a.type === 'inbox_add' && a.confidence === 'low' && a.nextAction === 'Clarify intent';
  const kept = actions.filter((a) => !isParseNoise(a));
  if (kept.length === 0) return { tier: 'low', actions: [] };
  actions = kept;

  const needs = actions.map((a, i) => ({ i, field: actionNeed(a, rawText) }));
  const needing = needs.filter((n) => n.field !== null) as { i: number; field: FieldKey }[];

  if (needing.length === 0) return { tier: 'high', actions };

  const presentFields = FIELD_PRIORITY.filter((f) => needing.some((n) => n.field === f));

  // Homogeneous: every needing action wants the same field → one question, patch all.
  if (presentFields.length === 1) {
    const fieldKey = presentFields[0];
    const targetIndices = needing.map((n) => n.i);
    return {
      tier: 'medium',
      actions,
      clarification: buildClarification(fieldKey, targetIndices, now),
    };
  }

  // Heterogeneous: ask the single highest-priority field; capture the rest to Inbox.
  const chosen = presentFields[0];
  const targetIndices = needing.filter((n) => n.field === chosen).map((n) => n.i);
  const downgraded = actions.map((a, i) => {
    const need = needs[i].field;
    if (need && need !== chosen) return inboxFallback(a, need, rawText);
    return a;
  });
  return {
    tier: 'medium',
    actions: downgraded,
    clarification: buildClarification(chosen, targetIndices, now),
  };
}
