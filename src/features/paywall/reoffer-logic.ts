// src/features/paywall/reoffer-logic.ts
// Pure, Node-importable decision logic for the "free week" re-offer: a second,
// dismissible paywall shown to a free-tier user AFTER they have had a first win.
//
// Why: the launch-gate paywall is shown once, minutes after onboarding, before the
// user has felt any value. Every tracked stranger dismissed it and was never asked
// again (PostHog audit 2026-10-11). This re-offers once value is proven.
//
// No React Native / app-state / AsyncStorage imports so the truth table runs under
// pure-Node vitest, like placement-logic.ts.

export const DAY_MS = 86_400_000;

export const REOFFER_CAPS = {
  /** Never more than this many re-offers per user, ever. */
  maxLifetime: 3,
  /** Minimum gap between two re-offers (also covers the "just dismissed it" case). */
  minGapMs: 7 * DAY_MS,
  /** Quiet period after the launch-gate paywall (proxied by activation time). */
  afterLaunchGateMs: DAY_MS,
  /** Day-N-of-use fallback trigger when no first win has been recorded. */
  fallbackDayOfUse: 3,
} as const;

export type ReofferTrigger = 'first_win' | 'day_3';

export interface ReofferState {
  count: number;
  lastShownAt: number | null;
}

export interface ReofferInput {
  now: number;
  isSubscribed: boolean; // includes an active free-week trial
  /** Grandfathered free user (kept access from before the paywall reorder). */
  isLegacyFree: boolean;
  /** The launch-gate paywall was dismissed (user is on the free tier). */
  launchGateDismissed: boolean;
  /** activatedDate ISO string from app state (also proxies the launch-gate time). */
  activatedDate: string | null;
  /** First alignment score was seen (first win). */
  firstWin: boolean;
  state: ReofferState;
  /** A paywall already presented this app session. */
  shownThisSession: boolean;
  /** Fail-CLOSED: true when a ceremony / onboarding / modal is on screen or unknown. */
  blocked: boolean;
}

export type ReofferReason =
  | 'show'
  | 'invalid-now'
  | 'subscribed'
  | 'legacy-free'
  | 'launch-gate-pending'
  | 'not-activated'
  | 'blocked'
  | 'already-shown-this-session'
  | 'lifetime-cap'
  | 'min-gap'
  | 'too-soon-after-launch-gate'
  | 'no-trigger-yet';

export interface ReofferDecision {
  show: boolean;
  trigger: ReofferTrigger | null;
  reason: ReofferReason;
}

export function decideReoffer(i: ReofferInput): ReofferDecision {
  const no = (reason: Exclude<ReofferReason, 'show'>): ReofferDecision => ({
    show: false,
    trigger: null,
    reason,
  });
  if (!Number.isFinite(i.now)) return no('invalid-now');
  if (i.isSubscribed) return no('subscribed');
  // Grandfathered full-access users are never re-offered (founder 2026-10-11).
  if (i.isLegacyFree) return no('legacy-free');
  // Only the free tier created by dismissing the launch gate is re-offered; while the
  // launch gate is still the active screen it IS the offer.
  if (!i.launchGateDismissed) return no('launch-gate-pending');
  const activatedAt = i.activatedDate ? new Date(i.activatedDate).getTime() : NaN;
  if (!Number.isFinite(activatedAt)) return no('not-activated');
  if (i.blocked) return no('blocked');
  if (i.shownThisSession) return no('already-shown-this-session');
  if (i.state.count >= REOFFER_CAPS.maxLifetime) return no('lifetime-cap');
  const last = i.state.lastShownAt;
  // Non-finite or future timestamps suppress (never leak on a corrupt clock).
  if (last != null && (!Number.isFinite(last) || i.now - last < REOFFER_CAPS.minGapMs)) {
    return no('min-gap');
  }
  if (i.now - activatedAt < REOFFER_CAPS.afterLaunchGateMs) {
    return no('too-soon-after-launch-gate');
  }
  if (i.firstWin) return { show: true, trigger: 'first_win', reason: 'show' };
  if (i.now - activatedAt >= REOFFER_CAPS.fallbackDayOfUse * DAY_MS) {
    return { show: true, trigger: 'day_3', reason: 'show' };
  }
  return no('no-trigger-yet');
}

export function parseReofferState(raw: string | null): ReofferState {
  if (!raw) return { count: 0, lastShownAt: null };
  try {
    const p = JSON.parse(raw);
    const count = Number.isFinite(p?.count) && p.count > 0 ? Math.floor(p.count) : 0;
    const lastShownAt = Number.isFinite(p?.lastShownAt) ? Number(p.lastShownAt) : null;
    return { count, lastShownAt };
  } catch {
    // Corrupt record: fail toward NOT re-offering until the cap logic can see real data.
    return { count: REOFFER_CAPS.maxLifetime, lastShownAt: null };
  }
}
