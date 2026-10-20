// src/features/paywall/trial-copy.ts
// NEX-122 — honest soft-commitment trial copy.
//
// Pure helpers that turn a StoreKit/RevenueCat product's REAL intro offer and
// price into accurate, §18-voice-clean disclosure copy. The paywall previously
// hardcoded "7 days free", which silently drifts from whatever the App Store
// Connect intro offer is actually configured to (the LEARNINGS-flagged bug:
// paywall said 7 days while the server trial was +13d). Everything here derives
// from the product so the copy can never assert a trial length or saving the
// product doesn't back.
//
// This module imports NOTHING from `react-native-purchases` (which transitively
// pulls native code) so it stays importable in the Node vitest suite. The
// consumer passes plain values shaped by the local interfaces below.

/**
 * The subset of RevenueCat's `PurchasesIntroPrice` this module needs. A FREE
 * trial is `price === 0`; a paid intro offer (price > 0) is NOT a free trial
 * and must never be described as "free". `periodUnit` is typed `string` in the
 * RC types (DAY / WEEK / MONTH / YEAR in practice) — treated as an open string
 * with an explicit unknown → null fallback below.
 *
 * `cycles` is deliberately NOT consumed: a StoreKit free trial is a single
 * subscription period (Apple expresses a longer trial as a larger
 * `periodNumberOfUnits`, not more cycles), so multiplying by cycles can only
 * ever OVER-state the free length — the opposite of what this honesty fix is for.
 */
export interface IntroOffer {
  price: number;
  periodUnit: string;
  periodNumberOfUnits: number;
}

const UNIT_LABELS: Record<string, string> = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
};

/**
 * Human trial length from a product's intro offer, e.g. "7 days", "1 week",
 * "1 month". Returns null when there is no free trial to truthfully state:
 *   - no intro offer, or
 *   - the intro offer is paid (`price !== 0`), or
 *   - the period is missing / non-positive / an unrecognized unit.
 *
 * The free length is the offer's single subscription period
 * (`periodNumberOfUnits` of `periodUnit`); see the IntroOffer note on why
 * `cycles` is not multiplied in.
 */
export function formatTrialPeriod(intro: IntroOffer | null | undefined): string | null {
  if (!intro) return null;
  if (intro.price !== 0) return null; // paid intro offer — not a free trial

  const unit = UNIT_LABELS[String(intro.periodUnit).toUpperCase()];
  if (!unit) return null; // unknown unit — degrade to generic disclosure

  const total = intro.periodNumberOfUnits;
  if (!Number.isFinite(total) || total <= 0) return null;

  return `${total} ${unit}${total === 1 ? '' : 's'}`;
}

export interface TrialDisclosureInput {
  /** Whether a real purchasable product loaded (vs the offline fallback cards). */
  productLoaded: boolean;
  /** From `formatTrialPeriod`, already gated on trial existence. */
  trialPeriod: string | null;
  /** Interval-bearing price for the selected plan, e.g. "$99.99/yr". */
  priceLabel: string | null;
}

/**
 * The trial-note sentence under the CTA. Calm, declarative, §18-clean (no em
 * dashes, no exclamation points, no second-person coaching, no emoji). Never
 * claims "free" without a trial to back it, and defers specifics to the App
 * Store sheet when no product is loaded.
 */
export function buildTrialDisclosure({
  productLoaded,
  trialPeriod,
  priceLabel,
}: TrialDisclosureInput): string {
  const cancelLine = 'Cancel anytime in Settings.';

  // No product loaded (offline / load error fallback cards). The CTA still
  // offers a free trial, but we can't read its real length or price — defer to
  // the App Store, which always shows both before purchase.
  if (!productLoaded) {
    return `The App Store confirms the trial length and price before purchase. ${cancelLine}`;
  }

  // Product loaded, real free trial present.
  if (trialPeriod) {
    const then = priceLabel
      ? `Then ${priceLabel} unless cancelled.`
      : 'Then billed automatically unless cancelled.';
    return `Free for ${trialPeriod}. ${then} ${cancelLine}`;
  }

  // Product loaded, NO free trial (intro offer absent, paid, or user-ineligible
  // as gated by the caller). Never imply a trial that isn't there.
  const renews = priceLabel
    ? `${priceLabel}, renews until cancelled.`
    : 'Renews until cancelled.';
  return `${renews} ${cancelLine}`;
}

/**
 * Gate a product's trial length on the CURRENT user's eligibility. The product's
 * `introPrice` only describes the *configured* offer; a user who already consumed
 * the free trial is ineligible and would be charged immediately. `eligible` is
 * the per-product RC eligibility (true = eligible, false = ineligible, null =
 * unknown, undefined = not yet fetched).
 *
 * Fail-safe direction (deliberate): suppress the trial claim ONLY on an explicit
 * `false` (RC INELIGIBLE / NO_INTRO_OFFER). Unknown / unfetched / eligible keep
 * the trial — a new user (the dominant paywall audience) is Apple-eligible by
 * default, so showing the trial on an unknown signal is the ACCURATE outcome for
 * them; RC reliably reports INELIGIBLE for lapsed users (it holds their receipt);
 * and the paywall is never blocked waiting on this. The App Store sheet is the
 * final source of truth at purchase.
 */
export function resolveEffectiveTrialPeriod(
  trialPeriod: string | null,
  eligible: boolean | null | undefined,
): string | null {
  return eligible === false ? null : trialPeriod;
}
