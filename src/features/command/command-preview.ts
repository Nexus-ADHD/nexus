/**
 * command-preview.ts — pure projection for the live "here's what I'll do"
 * preview (NEX-318, Phase 2). RN-free, vitest-coverable.
 *
 * As the user TYPES, the command screen debounces the text and asks this module
 * what to show. It runs the OFFLINE grammar only (never the AI) so it is instant
 * and safe to call per keystroke. A single confident grammar hit becomes a
 * preview the user can confirm; anything else returns null and the capture falls
 * through to the normal submit → AI flow unchanged.
 *
 * The preview is BOUND to its `sourceText` (Codex NEX-318): the caller confirms
 * only when the live input still equals `sourceText`, so an edit after the
 * preview renders can never commit a stale parse.
 *
 * For the one irreversible case — an ambiguous "next <weekday>" calendar write
 * (NEX-316 emits it at 'medium', which resolveCaptureTier routes to Inbox) — the
 * preview offers TWO date chips (this-coming vs next-week). Picking one produces
 * a concrete high-confidence action via `applyPreviewDate`; the caller then
 * re-runs `resolveCaptureTier` on it (never a blind execute) so every tier-gate
 * safety still applies.
 */

import { ProposedAction } from '../../utils/recurrence';
import { parseCaptureGrammar } from './grammar-parser';
import { isAmbiguousNextWeekday } from './chrono-date';
import { dateKeyOf, nextWeekday } from './date-tokens';
import { getActionDestination, getActionTypeLabel, getActionTimingLabel } from './command-labels';

export interface PreviewDateChip {
  /** e.g. "This Thursday · Jul 30" */
  label: string;
  /** naive-local YYYY-MM-DD */
  dateStr: string;
}

export interface CommandPreview {
  /** The exact text this was parsed from — confirm only while the input equals it. */
  sourceText: string;
  /** The single grammar-parsed action being previewed. */
  action: ProposedAction;
  destinationLabel: string; // "Calendar", "Tasks", "Orbit / Habits", …
  typeLabel: string; // "Calendar Event", "Task", …
  timingLabel: string; // "Thu Jul 30 at 11:30 AM", "Every day", "" …
  /**
   * Present ONLY for an ambiguous "next <weekday>" calendar write. Two explicit
   * date choices; picking one resolves the this-coming-vs-next-week ambiguity.
   * Non-ambiguous previews are null (one primary "Add").
   */
  dateCandidates: [PreviewDateChip, PreviewDateChip] | null;
}

const WEEKDAY_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Naive-local `YYYY-MM-DDTHH:mm:ss` (mirrors the grammar's buildEventISO; never toISOString). */
function toNaiveLocalISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

function shortMonthDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  try {
    return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function buildDateCandidates(now: Date, dow: number): [PreviewDateChip, PreviewDateChip] {
  const thisStr = nextWeekday(now, dow); // nearest upcoming occurrence (today if today is dow)
  const [y, m, d] = thisStr.split('-').map(Number);
  const nextDate = new Date(y, m - 1, d);
  nextDate.setDate(nextDate.getDate() + 7);
  const nextStr = dateKeyOf(nextDate);
  const wd = WEEKDAY_FULL[dow] ?? '';
  return [
    { label: `This ${wd} · ${shortMonthDay(thisStr)}`, dateStr: thisStr },
    { label: `Next ${wd} · ${shortMonthDay(nextStr)}`, dateStr: nextStr },
  ];
}

/**
 * Build the live preview for `text` at `now`, or null when there's nothing to
 * confidently preview (empty, no grammar match, or a compound multi-action
 * capture — those stay on the normal submit flow for v1).
 */
export function projectCommandPreview(text: string, now: Date): CommandPreview | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;

  let actions: ProposedAction[] | null = null;
  try {
    actions = parseCaptureGrammar(text, now);
  } catch {
    return null;
  }
  if (!actions || actions.length !== 1) return null; // single-action previews only (v1)

  const action = actions[0];

  let dateCandidates: [PreviewDateChip, PreviewDateChip] | null = null;
  if (action.type === 'calendar_add' && action.startISO && isAmbiguousNextWeekday(text)) {
    const dow = new Date(action.startISO).getDay();
    if (dow >= 0 && dow <= 6) dateCandidates = buildDateCandidates(now, dow);
  }

  return {
    sourceText: text,
    action,
    destinationLabel: getActionDestination(action),
    typeLabel: getActionTypeLabel(action),
    timingLabel: getActionTimingLabel(action),
    dateCandidates,
  };
}

/**
 * Resolve an ambiguous calendar preview to a concrete date: move start/end to
 * `dateStr` (preserving the original time-of-day and duration) and mark the
 * action high-confidence. The caller MUST still run it through
 * `resolveCaptureTier` (and reject a past start) before executing — this only
 * builds the candidate, it does not authorize the write.
 */
export function applyPreviewDate(action: ProposedAction, dateStr: string): ProposedAction {
  if (!action.startISO) return { ...action, confidence: 'high' };
  const start = new Date(action.startISO);
  const end = action.endISO ? new Date(action.endISO) : new Date(start.getTime() + 60 * 60 * 1000);
  const durationMs = Math.max(0, end.getTime() - start.getTime());
  const [y, m, d] = dateStr.split('-').map(Number);
  const newStart = new Date(y, m - 1, d, start.getHours(), start.getMinutes(), start.getSeconds(), 0);
  const newEnd = new Date(newStart.getTime() + durationMs);
  return {
    ...action,
    startISO: toNaiveLocalISO(newStart),
    endISO: toNaiveLocalISO(newEnd),
    confidence: 'high',
  };
}
