/**
 * NEX-204 — legacy free-user grandfather cutoff (pure, unit-testable).
 *
 * The onboarding↔paywall reorder makes a brand-new user `isActivated` BEFORE the
 * paywall, so the grandfather can no longer be minted on `isActivated &&
 * !isSubscribed` alone (that would grandfather every new user free). Only users
 * who activated under the prior (paywall-before-onboarding) flow are legacy —
 * i.e. activated before this reorder shipped.
 *
 * The durable fix is a server-side `createdAt < paywall-launch-date` check
 * (see the TODO by the legacy effect in app/_layout.tsx); this client cutoff is
 * the interim guard.
 */

/**
 * The reorder ship instant — users activated before this are the legacy cohort.
 *
 * Set to the merge/deploy day (this PR merges 2026-06-19; the cutoff is the start
 * of the next UTC day so EVERY same-day old-build activation is still grandfathered).
 *
 * Revenue-safety invariant — keep `cutoff <= the moment the reordered build first
 * reaches users`: a post-reorder new user can only activate AFTER the build is
 * delivered, so a cutoff at/under that instant never grandfathers them (they're
 * `>= cutoff` → must pay). For an App Store release the review lag makes this
 * automatic; if shipping via OTA, do not deliver the reordered bundle before this
 * cutoff (or bump it). Setting the cutoff LATER than delivery is the only unsafe
 * direction (it would grandfather new users in the gap).
 *
 * Conversely, a genuine legacy user (activated under a prior skip-allowed paywall)
 * activated long ago, far below this cutoff, so they are correctly grandfathered.
 * Today's old-build users who happen to fall on the wrong side are harmless anyway:
 * having passed the old paywall-FIRST flow they already subscribed or dismissed,
 * so `isSubscribed` / `launchPaywallDismissed` cover them without this grandfather.
 *
 * Durable replacement: the server `createdAt < paywall-launch-date` check (TODO in
 * app/_layout.tsx).
 */
export const PAYWALL_REORDER_CUTOFF_MS = Date.parse('2026-06-20T00:00:00.000Z');

/**
 * Whether a user's activation predates the reorder (→ legacy-grandfather eligible).
 *
 * A null / unparseable `activatedDate` is treated as **pre-reorder (legacy)**: a
 * new user under the reordered flow ALWAYS has a freshly-stamped, post-cutoff
 * `activatedDate` (`activateUser` stamps `new Date().toISOString()`), so a missing
 * date can only be an older migrated user — and migrated users can legitimately be
 * `isActivated === true` with `activatedDate === null` (see app-state.ts). Failing
 * such a user OUT of the grandfather would trap a paying-exempt existing user
 * behind the paywall, the exact regression this guards against.
 *
 * NOTE: `activatedDate` is cloud-mutable (`mergeCloudState` can pull it backward),
 * so this is best-effort pending the server `createdAt` check.
 */
export function isActivatedBeforeReorder(
  activatedDate: string | null | undefined,
  cutoffMs: number = PAYWALL_REORDER_CUTOFF_MS,
): boolean {
  if (!activatedDate) return true; // null/empty → migrated pre-reorder user → legacy
  const ts = Date.parse(activatedDate);
  return !Number.isFinite(ts) || ts < cutoffMs;
}

/** AsyncStorage key bases for the two device-level paywall-skip flags (NEX-204). */
export const LEGACY_FREE_USER_KEY = 'nexus_legacy_free_user';
export const LAUNCH_PAYWALL_DISMISSED_KEY = 'nexus_launch_paywall_dismissed';

/**
 * NEX-204 — scope a device-flag key per signed-in user.
 *
 * Both paywall-skip flags (`nexus_legacy_free_user`, `nexus_launch_paywall_dismissed`)
 * were device-level, so on a shared device account B inherited account A's free
 * access. Keying them `base:<uid>` makes each account read only its own flag, so the
 * leak can't happen regardless of which sign-out/reset path runs.
 *
 * Returns `null` for a missing/empty uid so callers never persist an unscoped
 * `base:null` key (which would collide across all anonymous/pre-auth states).
 */
export function scopedDeviceFlagKey(
  base: string,
  uid: string | null | undefined,
): string | null {
  if (!uid) return null;
  return `${base}:${uid}`;
}
