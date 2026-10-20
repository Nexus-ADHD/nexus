/**
 * In-trial Day-0/1 activation nudge (NEX-301) — pure types + the scheduling decision.
 *
 * Pure module (no RN imports) so the math is unit-testable in the Node vitest
 * suite — same direction as `billing-reminder-types.ts` / `lead-time-types.ts`.
 * The reconciler (`src/services/notifications.ts`) and the RC accessor
 * (`src/services/revenuecat.ts`) consume this.
 *
 * Source of truth is RevenueCat's entitlement `originalPurchaseDateMillis` (the
 * first time this entitlement was ever purchased), never any Supabase field
 * (`nexus_profiles.trial_start`/`trial_end` are a +13d estimate stamped at
 * activation, independent of what the paywall actually promises — see
 * `billing-reminder-types.ts`'s header for the same reasoning re: trial end).
 * `originalPurchaseDateMillis` is safe to treat as "this trial's start" without
 * a resubscribe-collision risk: a lapsed-trial user repurchasing starts at
 * `periodType` `'normal'`, not `'trial'` again (see the comment on
 * `readEntitlementMeta` in `revenuecat.ts`), so whenever `periodType==='trial'`
 * is observed it is necessarily the user's first (and only) trial.
 *
 * Deliberately does NOT gate on `willRenew` (unlike `computeBillingReminder`):
 * the billing reminder already excludes a mid-trial canceller by returning
 * `null` when `!willRenew`, and reaching exactly that population — before they
 * decide to cancel, or to re-engage them if they already have — is this
 * feature's whole purpose.
 *
 * Two pure functions, not one, because a single function that both computes
 * candidate fire times AND filters them by "is this still in the future" is
 * fragile against the reconciler's later quiet-hours shift: a raw candidate
 * that looks past-due can still be a genuinely-future notification once
 * shifted forward out of a quiet window, and filtering on the raw time would
 * wrongly let a cancel-by-family delete it.
 */

import { shiftOutOfQuietHours, type QuietWindow } from '@/src/utils/notification-quiet-hours';

/** A few hours after trial start — the Day-0 nudge. */
export const DAY0_OFFSET_MS = 4 * 60 * 60 * 1000;
/** The next day — the Day-1 nudge. */
export const DAY1_OFFSET_MS = 24 * 60 * 60 * 1000;
/** Minimum gap enforced between Day-0 and Day-1 if a quiet-hours shift/clamp
 *  would otherwise push them together or invert their order. Local to this
 *  feature — no shared minimum-gap convention exists elsewhere in the codebase. */
export const TRIAL_NUDGE_MIN_GAP_MS = 60 * 60 * 1000;

export type TrialNudgeDay = 0 | 1;

/** Lite, PII-free projection of the active `Nexus Pro` entitlement. */
export interface TrialNudgeInfo {
  /** RC `periodType` as-is (any case): 'TRIAL' | 'INTRO' | 'NORMAL' | 'PREPAID' | … */
  periodType: string;
  /** RC `originalPurchaseDateMillis` — the first time this entitlement was purchased (ms), or null. */
  originalPurchaseMs: number | null;
  /** RC `expirationDateMillis` — the trial's end/charge instant (ms), or null. */
  expirationMs: number | null;
  /** RC `ownershipType === 'FAMILY_SHARED'` — this device's user inherited the
   *  trial from another family member, not this app's own paywall/onboarding
   *  flow; the "activation always precedes a trial" invariant doesn't hold for
   *  them, so they're excluded (mirrors `BillingReminderInfo.familyShared`). */
  familyShared: boolean;
}

export interface TrialNudge {
  day: TrialNudgeDay;
  /** When to fire the local notification. */
  fireAtMs: number;
}

/**
 * Compute the raw (pre-quiet-hours-shift) candidate nudges for a trial, or []
 * when none apply. RC-only — no `nowMs`-based futurity filtering here; that is
 * `resolveTrialNudgeSchedule`'s job, applied AFTER the quiet-hours shift.
 */
export function computeTrialNudgeCandidates(
  info: TrialNudgeInfo | null,
  nowMs: number,
): TrialNudge[] {
  if (!info) return [];
  // Not the trial-starter (family-shared) → activation may not even have
  // happened on this device yet; not this feature's intended audience.
  if (info.familyShared) return [];

  const period = String(info.periodType || '').toLowerCase();
  if (period !== 'trial') return [];

  const expirationMs = info.expirationMs;
  if (typeof expirationMs !== 'number' || !Number.isFinite(expirationMs)) return [];
  if (expirationMs <= nowMs) return []; // trial already over

  const originalPurchaseMs = info.originalPurchaseMs;
  if (typeof originalPurchaseMs !== 'number' || !Number.isFinite(originalPurchaseMs)) return [];

  const candidates: TrialNudge[] = [];
  const day0FireAtMs = originalPurchaseMs + DAY0_OFFSET_MS;
  if (day0FireAtMs < expirationMs) candidates.push({ day: 0, fireAtMs: day0FireAtMs });

  const day1FireAtMs = originalPurchaseMs + DAY1_OFFSET_MS;
  if (day1FireAtMs < expirationMs) candidates.push({ day: 1, fireAtMs: day1FireAtMs });

  return candidates;
}

/**
 * Resolve raw candidates into the final schedule: shift each out of quiet
 * hours, re-assert Day-0 before Day-1 (a shift can invert them independently),
 * drop anything that landed at/after the trial's own end, then drop anything
 * that is no longer strictly future. This is what the reconciler actually
 * schedules.
 */
export function resolveTrialNudgeSchedule(
  candidates: TrialNudge[],
  nowMs: number,
  quiet: QuietWindow | null | undefined,
  expirationMs: number | null,
): TrialNudge[] {
  let shifted = candidates.map((c) => ({
    ...c,
    fireAtMs: quiet ? shiftOutOfQuietHours(c.fireAtMs, quiet) : c.fireAtMs,
  }));

  const day0 = shifted.find((c) => c.day === 0);
  const day1 = shifted.find((c) => c.day === 1);
  if (day0 && day1 && day1.fireAtMs <= day0.fireAtMs) {
    shifted = shifted.map((c) =>
      c.day === 1 ? { ...c, fireAtMs: day0.fireAtMs + TRIAL_NUDGE_MIN_GAP_MS } : c,
    );
  }

  return shifted.filter((c) => {
    if (typeof expirationMs === 'number' && Number.isFinite(expirationMs) && c.fireAtMs >= expirationMs) return false;
    return c.fireAtMs > nowMs;
  });
}

/**
 * Warm, §18-clean copy (no em dash, no exclamation, declarative, value-forward
 * — never "you'll be charged," never shame). Drives to the core-value surface.
 */
export function trialNudgeContent(day: TrialNudgeDay): { title: string; body: string } {
  if (day === 0) {
    return {
      title: 'Your first win is one tap away.',
      body: 'Say one thing you want to do today. Nexus turns it into a plan.',
    };
  }
  return {
    title: "Today's a new day to build the practice.",
    body: "Open Nexus and see what's already yours.",
  };
}
