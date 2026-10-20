/**
 * Command parser helpers.
 *
 * Pure, side-effect-free utilities for normalising and coercing the raw JSON
 * that the AI returns into well-typed ProposedAction objects.
 *
 * Nothing in this file calls native APIs, performs I/O, or triggers React
 * state — it is safe to unit-test outside of a React Native environment.
 */

import { normalizeProposedAction } from '../../utils/recurrence';
import { ALLOWED_TYPES, isRecord, ProposedAction, ProposedActionType } from './command-types';
import { normalizeAiTitle } from './grammar-parser';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a safe inbox title from raw user text.
 * Caps at 60 chars and provides a sensible fallback.
 */
export function fallbackTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Captured thought';
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

/**
 * Law A safety net: when the AI path fails (or resolves wholly low) with a
 * NON-EMPTY transcript, the low-tier card offers a one-tap save of the raw
 * words. The Inbox store persists only the title (InboxTask has no notes
 * field), so the title carries the FULL transcript — capped at 200 chars, not
 * fallbackTitle's display-oriented 60 — because for an unsortable capture,
 * keeping the words beats keeping them pretty. Callers must gate on a
 * TRIMMED transcript (the empty-capture sentinel is a single space).
 */
export function buildTranscriptInboxAction(transcript: string): ProposedAction {
  const trimmed = (transcript ?? '').trim();
  const title = trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
  return normalizeProposedAction({
    type: 'inbox_add',
    title: title || 'Captured thought',
    confidence: 'high',
    missingFields: [],
    explanation: 'Saved verbatim from a capture the parser could not sort.',
  });
}

// ─── parseAIResponse ─────────────────────────────────────────────────────────

/**
 * Parses the raw string returned by the AI into a shape with an `actions`
 * array. Strips markdown code fences the model occasionally wraps around JSON.
 *
 * @throws {Error} When the content is not valid JSON or lacks an actions array.
 */
export function parseAIResponse(content: string): { actions: unknown[] } {
  let parsed: unknown;
  try {
    const cleaned = content.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('AI returned invalid JSON.');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.actions)) {
    throw new Error('AI response missing valid actions array.');
  }
  return { actions: parsed.actions };
}

// ─── coerceAction ────────────────────────────────────────────────────────────

/**
 * Safely coerces an unknown AI action object into a fully-typed ProposedAction.
 *
 * Rules:
 *  - If `input` is not a plain object, routes to `inbox_add` with the raw text
 *    as a fallback title.
 *  - If `type` is not in ALLOWED_TYPES, falls back to `inbox_add`.
 *  - All optional fields are narrowed from `unknown` before use.
 *
 * Does NOT execute anything — callers decide what to do with the result.
 */
export function coerceAction(input: unknown, rawText: string): ProposedAction {
  if (!isRecord(input)) {
    return normalizeProposedAction({
      type: 'inbox_add',
      title: fallbackTitle(rawText),
      nextAction: 'Clarify intent',
      description: rawText,
      confidence: 'low',
      explanation: 'AI returned an invalid action object, so this was routed to Inbox for triage.',
    });
  }

  const maybeType = typeof input.type === 'string' ? input.type : '';
  const safeType: ProposedActionType = ALLOWED_TYPES.has(maybeType as ProposedActionType)
    ? (maybeType as ProposedActionType)
    : 'inbox_add';

  const safeTitle =
    typeof input.title === 'string' && input.title.trim() ? input.title.trim() : fallbackTitle(rawText);

  // NEX-302: prompt Rule 16 asks the model to strip request framing / schedule
  // tails from the title, but it's unenforced — a calendar event shipped titled
  // "Can you add podcast at 5 PM today?". normalizeAiTitle is the deterministic
  // guarantee behind the prompt. The schedule evidence gates the tail strip:
  // only an action that CARRIES its schedule in fields may lose it from the
  // title (an inbox capture's "at 5 pm" is information, not redundancy).
  // Each disjunct mirrors the forwarding condition for that field below — a
  // value the coercion DROPS (an off-spec preferredTimeBlock, a frequency-less
  // recurrence) must not count as schedule evidence, or the title sheds words
  // for a schedule the action never carries. The same rule gates the TYPE: an
  // unsupported AI type falls back to inbox_add, which executes no schedule —
  // its schedule words are title CONTENT, so they must survive the strip.
  const schedulableType =
    safeType === 'calendar_add' ||
    safeType === 'todo_add' ||
    safeType === 'recurring_add' ||
    safeType === 'recurring_todo_add';
  const hasSchedule =
    schedulableType &&
    (typeof input.startISO === 'string' ||
    typeof input.time === 'string' ||
    typeof input.dateStr === 'string' ||
    (isRecord(input.recurrence) && typeof input.recurrence.frequency === 'string') ||
    (Array.isArray(input.daysOfWeek) && input.daysOfWeek.some((d) => typeof d === 'number')) ||
    typeof input.timesPerDay === 'number' ||
    input.preferredTimeBlock === 'morning' ||
    input.preferredTimeBlock === 'afternoon' ||
    input.preferredTimeBlock === 'evening' ||
    input.preferredTimeBlock === 'night');

  return normalizeProposedAction({
    type: safeType,
    title: normalizeAiTitle(safeTitle, { hasSchedule, isCalendar: safeType === 'calendar_add' }),
    startISO: typeof input.startISO === 'string' ? input.startISO : undefined,
    endISO: typeof input.endISO === 'string' ? input.endISO : undefined,
    description: typeof input.description === 'string' ? input.description : undefined,
    daysOfWeek: Array.isArray(input.daysOfWeek)
      ? input.daysOfWeek.filter((d): d is number => typeof d === 'number')
      : undefined,
    time: typeof input.time === 'string' ? input.time : undefined,
    preferredTimeBlock:
      input.preferredTimeBlock === 'morning' ||
      input.preferredTimeBlock === 'afternoon' ||
      input.preferredTimeBlock === 'evening' ||
      input.preferredTimeBlock === 'night'
        ? input.preferredTimeBlock
        : undefined,
    nextAction:
      typeof input.nextAction === 'string'
        ? input.nextAction
        : safeType === 'inbox_add'
        ? 'Clarify intent'
        : undefined,
    dateStr: typeof input.dateStr === 'string' ? input.dateStr : undefined,
    // Week-interval for a recurring_todo_add (biweekly etc.). Forwarded so the
    // executor (which reads action.interval) actually receives it — without this
    // every AI-emitted "every other X" chore silently collapsed to weekly.
    interval: typeof input.interval === 'number' ? input.interval : undefined,
    // Nested recurrence for a calendar_add (a repeating Apple Calendar event).
    // Frequency is passed through as-is (even an off-spec value) so
    // validateProposedAction can reject it; out-of-range days / bad intervals are
    // sanitized by normalizeProposedAction below. Without forwarding this, a
    // correct recurring calendar_add from the AI was created as a one-off.
    recurrence:
      isRecord(input.recurrence) && typeof input.recurrence.frequency === 'string'
        ? {
            frequency: input.recurrence.frequency as 'daily' | 'weekly',
            ...(typeof input.recurrence.interval === 'number'
              ? { interval: input.recurrence.interval }
              : {}),
            ...(Array.isArray(input.recurrence.daysOfWeek)
              ? {
                  daysOfWeek: input.recurrence.daysOfWeek.filter(
                    (d): d is number => typeof d === 'number'
                  ),
                }
              : {}),
          }
        : undefined,
    confidence:
      input.confidence === 'high' || input.confidence === 'medium' || input.confidence === 'low'
        ? input.confidence
        : undefined,
    missingFields: Array.isArray(input.missingFields)
      ? input.missingFields.filter((f): f is string => typeof f === 'string')
      : undefined,
    explanation: typeof input.explanation === 'string' ? input.explanation : undefined,
  });
}
