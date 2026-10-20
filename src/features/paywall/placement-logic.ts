// src/features/paywall/placement-logic.ts
// NEX-123 — pure, Node-importable decision logic for value-moment paywall placements.
//
// This module holds ONLY pure functions (no React Native, no app-state, no AsyncStorage,
// no PostHog imports) so the whole truth table is unit-tested under vitest (the repo's
// test suite is pure-Node — importing app/ or state/app-state.ts fails by design). The RN
// glue (reading consent + flags + cap timestamps, presenting the paywall) lives in separate
// modules that import this one (PR-2/PR-3).
//
// Two fail-safe properties are load-bearing and proven here:
//   1. resolveFlagVariant only yields a presentable variant when consent is GRANTED, the
//      client is enabled, AND the flag explicitly resolves to a known variant. A cached/
//      bootstrapped flag readable while disabled/unconsented must NOT present (PostHog's
//      getFeatureFlag bypasses `disabled`, so consent is checked here, not trusted from the SDK).
//   2. decidePlacement treats `ceremonyActive` as fail-CLOSED: the caller passes `true` when
//      the ceremony signal is unknown/unwired/loading, so the §1.5 sacred-ceremony guardrail
//      suppresses the upsell rather than leaking it.

export type PlacementVariant = 'control' | 'annual_focus';
export type PlacementId = 'first_alignment' | 'first_debrief' | 'power_nudge';

export const DAY_MS = 86_400_000;

// Frequency caps (research-backed defaults — RevenueCat/Superwall/Adapty): at most once per
// day per placement, no two paywalls within 48h across all placements, and a 7-day quiet
// period after any dismissal. Exported so tests and callers share one source of truth.
export const CAPS = {
  perPlacementCooldownMs: DAY_MS,
  globalFloorMs: 2 * DAY_MS,
  postDismissSuppressionMs: 7 * DAY_MS,
} as const;

/**
 * Fail-safe flag resolution. Returns a presentable variant ONLY when ALL hold:
 *   - analytics consent is granted (read from app-state, NOT inferred from the SDK — a cached
 *     flag is readable while opted-out, so consent is the independent gate);
 *   - the PostHog client is not disabled;
 *   - the raw flag value is an explicit known variant ('control' | 'annual_focus').
 * Everything else — consent denied/unknown, client disabled, 'off', boolean true/false,
 * `undefined` (loading / no match), or any unknown string — returns `null` (no paywall).
 */
export function resolveFlagVariant(input: {
  consentGranted: boolean;
  clientDisabled: boolean;
  rawVariant: string | boolean | undefined;
}): PlacementVariant | null {
  if (!input.consentGranted) return null;
  if (input.clientDisabled) return null;
  if (input.rawVariant === 'control' || input.rawVariant === 'annual_focus') {
    return input.rawVariant;
  }
  return null;
}

export interface PlacementDecisionInput {
  placementId: PlacementId;
  /** Already-resolved variant from resolveFlagVariant (null ⇒ do not show). */
  variant: PlacementVariant | null;
  isSubscribed: boolean;
  isLegacyFree: boolean;
  now: number;
  /** Last time THIS placement presented a paywall (ms epoch), or null if never. */
  lastShownAt: number | null;
  /** Last time ANY paywall presented (ms epoch), or null. Includes the launch-gate + Settings. */
  lastAnyShownAt: number | null;
  /** Last time ANY paywall was dismissed (ms epoch), or null. */
  lastDismissedAt: number | null;
  /** A paywall already presented this app session (in-memory latch, set by every entry point). */
  shownThisSession: boolean;
  /** Fail-CLOSED: caller passes `true` when the ceremony signal is unknown/unwired. */
  ceremonyActive: boolean;
}

export interface PlacementDecision {
  show: boolean;
  variant: PlacementVariant | null;
  /** Machine-readable reason for the outcome (for logs / the optional evaluated event). */
  reason:
    | 'show'
    | 'invalid-now'
    | 'subscribed'
    | 'legacy-free'
    | 'flag-off-or-unresolved'
    | 'ceremony-active'
    | 'already-shown-this-session'
    | 'post-dismiss-suppression'
    | 'global-floor'
    | 'per-placement-cooldown';
}

/**
 * True when `last` falls inside `[last, last + windowMs)` relative to `now` — i.e. the cap is
 * still suppressing. Fail-safe-SUPPRESS on adversarial timestamps: a null `last` is "never shown"
 * (not in any window), but a non-finite OR FUTURE `last` (clock skew / NTP correction backward)
 * is deliberately treated as in-window so a corrupted timestamp can never let a paywall leak.
 * (A future `last` self-heals once real time passes it; the cap state is device-local, not
 * cloud-restored, so the skew window is bounded by a single device's clock drift.)
 */
function withinWindow(now: number, last: number | null, windowMs: number): boolean {
  if (last == null) return false;
  if (!Number.isFinite(last)) return true;
  return now - last < windowMs; // future `last` → negative delta → < window → suppress
}

/**
 * Decide whether a value-moment placement may present the paywall right now. Pure: all state
 * is passed in. Order is deliberate — the guardrails (invalid clock, subscribed, fail-safe
 * variant, ceremony) are checked before the frequency caps so a sacred moment or an unentitled
 * read can never be overridden by cap timing, and the `reason` reflects the first blocking rule.
 */
export function decidePlacement(i: PlacementDecisionInput): PlacementDecision {
  const block = (reason: Exclude<PlacementDecision['reason'], 'show'>): PlacementDecision => ({
    show: false,
    variant: null,
    reason,
  });

  // Fail-CLOSED on a non-finite clock (NaN/Infinity from a caller bug): NaN comparisons are
  // always false, so an unguarded NaN `now` would slip past every cap and present. Block first.
  if (!Number.isFinite(i.now)) return block('invalid-now');
  if (i.isSubscribed) return block('subscribed');
  if (i.isLegacyFree) return block('legacy-free');
  if (i.variant == null) return block('flag-off-or-unresolved'); // fail-safe
  if (i.ceremonyActive) return block('ceremony-active'); // §1.5 structural guardrail (fail-closed)
  if (i.shownThisSession) return block('already-shown-this-session');
  if (withinWindow(i.now, i.lastDismissedAt, CAPS.postDismissSuppressionMs)) {
    return block('post-dismiss-suppression');
  }
  if (withinWindow(i.now, i.lastAnyShownAt, CAPS.globalFloorMs)) return block('global-floor');
  if (withinWindow(i.now, i.lastShownAt, CAPS.perPlacementCooldownMs)) {
    return block('per-placement-cooldown');
  }
  return { show: true, variant: i.variant, reason: 'show' };
}
