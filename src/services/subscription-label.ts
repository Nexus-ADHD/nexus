/**
 * NEX-231 — honest subscription date label. Pure (no RN imports) so vitest covers
 * the multi-state branch directly. RevenueCat sets willRenew=false for several
 * DIFFERENT reasons (cancel, billing-retry/grace, lifetime, promo), so a naive
 * `willRenew ? 'Renews' : 'Access until'` would mislabel a billing-retry user as
 * if they had cancelled — dishonest in the opposite direction on a trust ticket.
 * This distinguishes the states the user actually needs to understand.
 */

export interface SubscriptionLabelInput {
  /** periodType === 'trial' — a trial converts to paid on expiry, it doesn't "renew". */
  isTrial: boolean;
  /** entitlement.willRenew. */
  willRenew: boolean;
  /** entitlement.unsubscribeDetectedAt — set when the user cancelled (still active until expiry). */
  unsubscribeDetectedAt: string | null;
  /** entitlement.billingIssueDetectedAt — set during Apple's billing retry / grace. */
  billingIssueDetectedAt: string | null;
}

/**
 * Label for the date row next to `expiresAt`. Precedence (most-specific first):
 *   1. cancelled  → "Access until"     (genuine user cancel; the core honest state)
 *   2. billing issue → "Renewal pending"  (grace/retry — NOT a clean wind-down,
 *      and NOT a confident renewal; don't claim either)
 *   3. trial      → "Free until"        (trial converts to paid, doesn't renew)
 *   4. otherwise  → "Renews"            (active paid, will auto-renew)
 *
 * Declarative, no shame, no em dash (CLAUDE.md §18 / Law C). "Access until" beats
 * "Expires" — it states retained access, not a punishment.
 */
export function subscriptionDateLabel(s: SubscriptionLabelInput): string {
  if (s.unsubscribeDetectedAt) return 'Access until';
  if (s.billingIssueDetectedAt) return 'Renewal pending';
  // Only claim a renewal when the entitlement will actually auto-renew. A trial
  // that will convert reads "Free until"; an auto-renewing paid plan "Renews".
  if (s.willRenew) return s.isTrial ? 'Free until' : 'Renews';
  // willRenew=false with no detected cancel/billing reason (e.g. a non-renewing
  // prepaid plan, or auto-renew turned off without an unsubscribe signal): the
  // entitlement is still active but won't renew, so access simply runs until the
  // expiry date. "Access until" is the honest neutral — never "Renews".
  return 'Access until';
}
