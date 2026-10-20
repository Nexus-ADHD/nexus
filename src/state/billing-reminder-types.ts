/**
 * Pre-charge reminder (NEX-232) — pure types + the scheduling decision.
 *
 * Pure module (no RN imports) so the math is unit-testable in the Node vitest
 * suite — same direction as `lead-time-types.ts` / `today-rollup.ts`. The
 * reconciler (`src/services/notifications.ts`) and the RC accessor
 * (`src/services/revenuecat.ts`) consume this; the reconciler schedules at most
 * one local DATE notification a set window before a charge.
 *
 * Source of truth is RevenueCat's entitlement (the real Apple charge instant via
 * `expirationDateMillis`), never the app-side `nexus_profiles.trial_end` estimate
 * (which can be wrong — the paywall says "7 days free" while upsert-profile uses
 * +13d). Apple owns the charge date.
 */

/** 24h before a free-trial / intro period converts to a paid charge. */
export const WINDOW_TRIAL_MS = 24 * 60 * 60 * 1000;
/** 3 days before an annual renewal charges. */
export const WINDOW_RENEWAL_MS = 3 * 24 * 60 * 60 * 1000;

export type BillingReminderKind = 'trial' | 'renewal';

/** Lite, PII-free projection of the active `Nexus Pro` entitlement. */
export interface BillingReminderInfo {
  /** RC `periodType` as-is (any case): 'TRIAL' | 'INTRO' | 'NORMAL' | 'PREPAID' | … */
  periodType: string;
  /** RC `expirationDateMillis` — the real charge/renewal instant (ms), or null. */
  expirationMs: number | null;
  /** RC `willRenew` — false for a cancelled (but still-active) trial/sub: no upcoming charge. */
  willRenew: boolean;
  /** Derived via /annual|year/i on the product id (the literal annual id is "Annual"). */
  plan: 'annual' | 'monthly';
  /** RC `ownershipType === 'FAMILY_SHARED'` — this user is not the payer, no charge to warn about. */
  familyShared: boolean;
}

export interface BillingReminder {
  kind: BillingReminderKind;
  /** When to fire the local notification — always strictly in the future. */
  fireAtMs: number;
  /** The charge instant (for the copy's date). */
  chargeMs: number;
}

/**
 * Decide the single pre-charge reminder, or null when none applies.
 *
 * Returns at most one, always with a strictly-future `fireAtMs` (scheduled as a
 * DATE one-shot). We deliberately do NOT fire an immediate catch-up when first
 * observed already inside the window (reinstall / delayed RC config / permission
 * granted late) — that is the accepted client-local gap, closed by the
 * server-webhook follow-on. A future-only fire is also trivially always
 * pre-charge (`fireAtMs < expirationMs` since the windows are positive).
 */
export function computeBillingReminder(
  info: BillingReminderInfo | null,
  nowMs: number,
): BillingReminder | null {
  if (!info) return null;
  // Not the payer (family-shared) → no charge to this user.
  if (info.familyShared) return null;
  // No upcoming charge unless it will auto-renew / convert. Covers a cancelled
  // (but still-active) trial — periodType is still 'trial' but willRenew is false.
  if (!info.willRenew) return null;

  const expirationMs = info.expirationMs;
  if (typeof expirationMs !== 'number' || !Number.isFinite(expirationMs)) return null;
  if (expirationMs <= nowMs) return null; // charge already happened / lifetime / no future charge

  const period = String(info.periodType || '').toLowerCase();
  // 'trial' and 'intro' both convert from a free/discounted period to a full charge.
  const isTrialLike = period === 'trial' || period === 'intro';
  const isAnnualRenewal = period === 'normal' && info.plan === 'annual';

  let kind: BillingReminderKind;
  let windowMs: number;
  if (isTrialLike) {
    kind = 'trial';
    windowMs = WINDOW_TRIAL_MS;
  } else if (isAnnualRenewal) {
    kind = 'renewal';
    windowMs = WINDOW_RENEWAL_MS;
  } else {
    // Monthly renewal (frequent / low-surprise), prepaid (no auto-charge), etc. — out of scope.
    return null;
  }

  const fireAtMs = expirationMs - windowMs;
  if (fireAtMs <= nowMs) return null; // first observed already inside the window — documented gap

  return { kind, fireAtMs, chargeMs: expirationMs };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Local "Month D" (e.g. "June 21") — the user's local perception of the charge day. */
export function formatChargeDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Warm, §18-clean copy (no em dash, no exclamation, declarative). Price is
 * intentionally omitted for v1 — Apple's manage screen shows the authoritative
 * price on tap, and asserting a possibly-stale price is a trust risk.
 */
export function billingReminderContent(
  kind: BillingReminderKind,
  chargeMs: number,
): { title: string; body: string } {
  const date = formatChargeDate(chargeMs);
  if (kind === 'trial') {
    return { title: 'Your free trial ends soon.', body: `Nexus Pro begins ${date}. Manage anytime.` };
  }
  return { title: 'Your Nexus Pro renews soon.', body: `Renews ${date}. Manage anytime.` };
}
