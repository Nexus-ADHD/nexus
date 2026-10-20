/**
 * coach-opener.ts — the first line of the day in the coach thread, as pure
 * decisions (docs/plans/2026-09-02-coach-conversation.md, S3.1, S3.2).
 *
 * The screen asks the model for ONE line from the coach context and hands
 * the candidate here. This module decides what is actually shown:
 *
 *   - Pause Mode → nothing, even if a line is already stored for today.
 *   - `personalized` off (the NEX-277 kill switch) → a curated seed line;
 *     the model is never asked (the screen checks `shouldAskModelForOpener`).
 *   - an AI candidate that fails the NEX-277 syntactic filter or the coach
 *     tone check → the seed line instead. The filter proves absence of banned
 *     tokens, not on-voice-ness (LEARNINGS 2026-06-24), which is why the seed
 *     is the floor and the coach tone check is a second gate.
 *   - the result is keyed by day, so a re-open today reuses it (coach-thread's
 *     `openerForDay`).
 */

import { isNotificationQuoteSafe } from '../../ai/notification-quote-filter';
import { QUOTE_SEED } from '../../ai/notification-quote-seed';
import { checkReplyTone } from './coach-turn';
import type { CoachOpener } from './coach-thread';

export interface OpenerInput {
  /** Local YYYY-MM-DD. */
  dayKey: string;
  /** Pause Mode active now. */
  pausedNow: boolean;
  /** notificationSettings.personalizedQuotes !== false. */
  personalized: boolean;
  /** The model's line, if one was asked for. */
  candidate?: string | null;
}

/** Whether the screen should spend a model call at all. */
export function shouldAskModelForOpener(input: Pick<OpenerInput, 'pausedNow' | 'personalized'>): boolean {
  return !input.pausedNow && input.personalized;
}

/** A stable seed line for the day (same day, same line, on every device). */
export function seedOpenerFor(dayKey: string): string {
  let h = 0;
  for (let i = 0; i < dayKey.length; i += 1) h = (h * 31 + dayKey.charCodeAt(i)) >>> 0;
  return QUOTE_SEED[h % QUOTE_SEED.length];
}

/** True when the AI line may be shown as the coach's own first words. */
export function isOpenerCandidateSafe(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') return false;
  const line = candidate.trim();
  if (!line) return false;
  if (!isNotificationQuoteSafe(line)) return false;
  return checkReplyTone(line).ok;
}

export function prepareOpener(input: OpenerInput): CoachOpener | null {
  if (input.pausedNow) return null;
  if (!input.personalized) return { text: seedOpenerFor(input.dayKey), dayKey: input.dayKey };
  if (isOpenerCandidateSafe(input.candidate)) return { text: input.candidate.trim(), dayKey: input.dayKey };
  return { text: seedOpenerFor(input.dayKey), dayKey: input.dayKey };
}

/** The one-line instruction appended to the coach prompt for the opener call. */
export const OPENER_INSTRUCTION =
  'Write the first line of today\'s conversation. One sentence, under 140 characters, from "What you know" only: what is in front of them today, or one thing you noticed. No question mark is fine. Return ONLY JSON: {"reply": "the line", "plan": null}';
