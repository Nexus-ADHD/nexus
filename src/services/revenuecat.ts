// src/services/revenuecat.ts
// RevenueCat subscription management for Nexus
import Purchases, { PurchasesOffering, CustomerInfo, PurchasesPackage, INTRO_ELIGIBILITY_STATUS } from 'react-native-purchases';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { supabase } from './supabase';
import { onPurchase } from './nexus-profiles';
import { trackEvent, getPostHogDistinctId } from './analytics';
import { publicConfigValue } from '@/src/utils/public-config';
import type { BillingReminderInfo } from '@/src/state/billing-reminder-types';
import type { TrialNudgeInfo } from '@/src/state/trial-nudge-types';

// Public RevenueCat SDK key (Apple). Set EXPO_PUBLIC_REVENUECAT_API_KEY in .env.local.
const REVENUECAT_API_KEY = publicConfigValue(
  'EXPO_PUBLIC_REVENUECAT_API_KEY',
  process.env.EXPO_PUBLIC_REVENUECAT_API_KEY,
);
const ENTITLEMENT_ID = 'Nexus Pro';

// ─── NEX-124 conversion-funnel emission ───────────────────────────────────────
// subscription_started marks a NEW subscription (trial OR direct paid). The
// trial-vs-paid distinction lives in the `period_type` property, not separate
// events — a lapsed-trial user repurchasing starts at periodType 'normal', and
// the funnel filters period_type=trial. Trial→paid CONVERSION is observed
// server-side via the RevenueCat→PostHog integration (rc_* events), not here:
// it happens on Apple's servers when the app may be closed.

// Derives the PII-free funnel props from the active entitlement. Reads
// periodType the same way getCancelFlowStatus does.
function readEntitlementMeta(customerInfo: CustomerInfo): {
  period_type: 'trial' | 'normal';
  plan: 'annual' | 'monthly';
  product_id: string;
} {
  const ent = customerInfo.entitlements.active[ENTITLEMENT_ID];
  const periodType = String(ent?.periodType || '').toLowerCase();
  const productId = String(ent?.productIdentifier ?? '');
  return {
    period_type: periodType === 'trial' ? 'trial' : 'normal',
    plan: /annual|year/i.test(productId) ? 'annual' : 'monthly',
    product_id: productId,
  };
}

// Serialized per-install single-fire guard. A double-tap or double success
// callback can reach purchasePackage / purchaseProductDirect twice; this keeps
// subscription_started to one emission per app session. (PostHog also dedupes
// per person in funnels.) NOTE: events fired before RootLayoutInner wires the
// PostHog client are queued by the analytics emitter and drained on wiring.
let subscriptionStartedEmitted = false;
function emitSubscriptionStartedOnce(customerInfo: CustomerInfo): void {
  if (subscriptionStartedEmitted) return;
  subscriptionStartedEmitted = true;
  void trackEvent('subscription_started', readEntitlementMeta(customerInfo));
}

// NEX-119: the single place entitlement-grant side-effects live, so a grant from
// RevenueCat's remote paywall (RC purchases internally and hands us `customerInfo` via
// `onPurchaseCompleted`) runs the EXACT same analytics + profile sync as our own purchase
// buttons. Returns whether the `Nexus Pro` entitlement is active. Safe to call more than
// once (subscription_started is dedupe-guarded). The plan is derived from the active
// entitlement's product id (via readEntitlementMeta), which also fixes the
// custom/`$rc_annual` package-id mis-sync the inline `pkg.identifier === 'Annual'` path had.
export function recordEntitlementGranted(customerInfo: CustomerInfo): { unlocked: boolean } {
  const isActive = !!customerInfo.entitlements.active[ENTITLEMENT_ID];
  if (!isActive) return { unlocked: false };
  emitSubscriptionStartedOnce(customerInfo); // NEX-124
  // Fire-and-forget profile sync — upserts the plan + purchase timestamp and triggers the
  // post-purchase confirm email. onPurchase honors SIM_BYPASS internally and never throws.
  void (async () => {
    try {
      const { data } = await supabase.auth.getUser();
      const u = data?.user;
      if (!u?.id || !u?.email) return;
      const plan = readEntitlementMeta(customerInfo).plan; // 'annual' | 'monthly'
      await onPurchase(
        { id: u.id, email: u.email, name: (u.user_metadata?.name as string) ?? '' },
        plan,
      );
    } catch (e) {
      console.log('[onPurchase] swallowed:', (e as Error)?.message ?? e);
    }
  })();
  return { unlocked: true };
}

// NEX-119: restore counterpart. A restore proves entitlement but is NOT a new subscription,
// so it is excluded from subscription_started and gets its own event (funnel accuracy).
export function recordEntitlementRestored(customerInfo: CustomerInfo): { unlocked: boolean } {
  const isActive = !!customerInfo.entitlements.active[ENTITLEMENT_ID];
  if (isActive) void trackEvent('subscription_restored', readEntitlementMeta(customerInfo));
  return { unlocked: isActive };
}

// ─── Simulator bypass ─────────────────────────────────────────────────────────
// Identical condition to SIM_BYPASS in app/_layout.tsx.
// Active only when running in the iOS Simulator under a dev build — never on a
// real device, in TestFlight, or in production.
const SIM_BYPASS = __DEV__ && !Device.isDevice;

// ─── PostHog identity link (NEX-297) ──────────────────────────────────────────
// Sets RevenueCat's reserved `$posthogUserId` subscriber attribute so RC's own
// PostHog integration (rc_* server-side events) attributes to the same person
// as our client funnel events, instead of the two systems drifting onto
// different distinct ids. Best-effort and non-blocking: a missing distinct id
// or a rejected setAttributes call is swallowed rather than surfaced — the
// caller re-asserts at the next identity change.
//
// `isStale`, when passed, is re-checked immediately before the native call —
// review found that without it, a slow call here (network retry, or the
// distinct-id wait below) can land AFTER a newer account has taken over RC's
// current app-user, mistagging that newer user's subscriber with the OLD
// user's PostHog id. Same generation-guard shape as runSubscriptionCheck's
// own isStale checks in app/_layout.tsx.
//
// `identifiedUserId` guards a SECOND, adjacent race review found: the
// anonymous configure-time call (no `distinctId` passed) has its own 300ms
// distinct-id retry-wait, so on an ordinary cold launch it can wake up AFTER
// identifyUser has already correctly bound and asserted the real user — and
// without this guard it would clobber that correct attribute back to a stale
// anonymous id, with nothing left to re-assert it for the rest of the
// process. Once any real (distinctId-carrying) assert succeeds, later
// anonymous-window asserts are skipped instead of overwriting it; a real
// assert is never itself gated by this (only the anonymous branch checks it).
let identifiedUserId: string | null = null;

async function linkPostHogIdentity(distinctId?: string, isStale?: () => boolean): Promise<void> {
  try {
    let id = distinctId ?? getPostHogDistinctId();
    if (!id) {
      // Cold start: setPostHogClient wires the client synchronously, but the
      // client's OWN internal init (reading the persisted distinct id off the
      // async-storage bridge) hasn't resolved yet at RC's configure time. A
      // short bounded wait covers the common case (a local storage read, not
      // a network call) without turning this into an unbounded poll.
      await new Promise((resolve) => setTimeout(resolve, 300));
      id = distinctId ?? getPostHogDistinctId();
    }
    if (!id) return;
    if (isStale?.()) return;
    if (!distinctId && identifiedUserId) return; // a real identity bound while this anonymous assert was waiting
    await Purchases.setAttributes({ $posthogUserId: id });
    if (distinctId) identifiedUserId = distinctId;
  } catch (e) {
    console.log('[RevenueCat] setAttributes($posthogUserId) failed:', e);
  }
}

// ─── Initialize ──────────────────────────────────────────────────────────────

let isConfigured = false;

export async function configureRevenueCat(userId?: string) {
  if (SIM_BYPASS) {
    console.log('[RevenueCat] SIM bypass — skipping config');
    return;
  }
  if (isConfigured) return;
  if (!REVENUECAT_API_KEY) {
    console.log('[RevenueCat] EXPO_PUBLIC_REVENUECAT_API_KEY not set, subscriptions disabled');
    return;
  }
  try {
    if (Platform.OS === 'ios') {
      Purchases.configure({ apiKey: REVENUECAT_API_KEY, appUserID: userId || undefined });
      isConfigured = true;
      console.log('[RevenueCat] Configured');
      // NEX-294: collect Apple Search Ads (AdServices) attribution so RevenueCat
      // attributes subscribers to ASA campaign/keyword. iOS-only, no ATT prompt,
      // no IDFA. Fire-and-forget: AdServices token resolution can take seconds
      // right after install, so it must never delay identity binding on the 8s
      // launch race, and a rejection (organic install / older iOS) must stay
      // non-fatal. Reachable only on the single configure that flips isConfigured
      // false→true, so it runs exactly once per process (self-heal callers skip it
      // via the isConfigured guard above).
      void Purchases.enableAdServicesAttributionTokenCollection().catch((e) =>
        console.warn('[RevenueCat] ASA attribution collection failed:', e),
      );
      // NEX-297: link to whatever PostHog distinct id is current (anonymous or
      // real). Same fire-and-forget, once-per-process reachability as the ASA
      // call above — re-asserted with the real userId once identifyUser succeeds.
      void linkPostHogIdentity();
    }
  } catch (e) {
    console.log('[RevenueCat] Config error:', e);
  }
}

// ─── Check subscription status ───────────────────────────────────────────────

export interface SubscriptionInfo {
  isSubscribed: boolean;
  plan: 'lifetime' | 'yearly' | 'monthly' | null;
  expiresAt: string | null;
  // NEX-231: honest post-cancel state. willRenew alone is ambiguous (RevenueCat
  // sets it false for cancel, billing-retry/grace, AND lifetime/promo), so the
  // settings label also needs the two "why" timestamps + trial flag to avoid
  // mislabeling a grace-period user as if they cancelled. See subscriptionDateLabel.
  willRenew: boolean;
  unsubscribeDetectedAt: string | null;
  billingIssueDetectedAt: string | null;
  isTrial: boolean;
}

const NOT_SUBSCRIBED: SubscriptionInfo = {
  isSubscribed: false, plan: null, expiresAt: null,
  willRenew: false, unsubscribeDetectedAt: null, billingIssueDetectedAt: null, isTrial: false,
};

/**
 * Strict read: THROWS if the RevenueCat read itself fails (transient/offline), and
 * only returns NOT_SUBSCRIBED for a genuine no-active-entitlement state. Use this
 * where a transient failure must NOT masquerade as "free" (e.g. the post-Apple
 * foreground refresh, which should retry rather than wrongly downgrade the user).
 * `checkSubscription` wraps this and swallows errors to NOT_SUBSCRIBED for callers
 * that just want a best-effort boolean.
 */
export async function checkSubscriptionStrict(): Promise<SubscriptionInfo> {
  if (SIM_BYPASS) {
    return {
      isSubscribed: true, plan: 'monthly', expiresAt: null,
      willRenew: true, unsubscribeDetectedAt: null, billingIssueDetectedAt: null, isTrial: false,
    };
  }
  const customerInfo = await Purchases.getCustomerInfo(); // throws on a real read failure
  const entitlement = customerInfo.entitlements.active[ENTITLEMENT_ID];
  if (!entitlement) return NOT_SUBSCRIBED;

  // Determine plan type
  let plan: 'lifetime' | 'yearly' | 'monthly' | null = null;
  const productId = entitlement.productIdentifier || '';
  if (productId.includes('lifetime')) plan = 'lifetime';
  else if (productId.includes('year')) plan = 'yearly';
  else if (productId.includes('month')) plan = 'monthly';
  else plan = 'monthly'; // default

  return {
    isSubscribed: true,
    plan,
    expiresAt: entitlement.expirationDate || null,
    willRenew: entitlement.willRenew,
    unsubscribeDetectedAt: entitlement.unsubscribeDetectedAt ?? null,
    billingIssueDetectedAt: entitlement.billingIssueDetectedAt ?? null,
    isTrial: String(entitlement.periodType || '').toLowerCase() === 'trial',
  };
}

export async function checkSubscription(): Promise<SubscriptionInfo> {
  try {
    return await checkSubscriptionStrict();
  } catch (e) {
    console.log('[RevenueCat] Check error:', e);
    return NOT_SUBSCRIBED;
  }
}

export async function getCancelFlowStatus(): Promise<{
  isTrialUser: boolean;
  isPaidSubscriber: boolean;
  managementURL: string | null;
}> {
  if (SIM_BYPASS) {
    return {
      isTrialUser: true,
      isPaidSubscriber: false,
      managementURL: 'https://apps.apple.com/account/subscriptions',
    };
  }
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    const entitlement = customerInfo.entitlements.active[ENTITLEMENT_ID];
    if (!entitlement) {
      return { isTrialUser: false, isPaidSubscriber: false, managementURL: null };
    }

    const periodType = String(entitlement.periodType || '').toLowerCase();
    const isTrialUser = periodType === 'trial';
    const isPaidSubscriber = periodType === 'normal';
    const managementURL = customerInfo.managementURL || 'https://apps.apple.com/account/subscriptions';
    return { isTrialUser, isPaidSubscriber, managementURL };
  } catch (e) {
    console.log('[RevenueCat] getCancelFlowStatus error:', e);
    return {
      isTrialUser: false,
      isPaidSubscriber: false,
      managementURL: 'https://apps.apple.com/account/subscriptions',
    };
  }
}

// ─── Get offerings ───────────────────────────────────────────────────────────

export async function getOfferings(): Promise<PurchasesOffering | null> {
  if (SIM_BYPASS) return null;
  if (Platform.OS !== 'ios') return null;
  // Self-heal: if not configured (e.g. paywall opened before _layout finishes
  // or before the user signs in), configure now. Apple reviewers don't sign up.
  if (!isConfigured) {
    console.log('[RevenueCat] getOfferings called before config — self-configuring');
    await configureRevenueCat();
  }
  try {
    const offerings = await Purchases.getOfferings();
    if (!offerings.current) {
      console.log('[RevenueCat] No current offering. All keys:', Object.keys(offerings.all || {}));
    }
    return offerings.current;
  } catch (e) {
    console.log('[RevenueCat] Offerings error:', e);
    return null;
  }
}

// ─── Direct StoreKit product fetch (bypass RevenueCat offering layer) ──────
// Fallback when getOfferings() returns null. Fetches products directly from
// StoreKit using raw ASC product IDs. Works even if RevenueCat's offering
// configuration is missing, misconfigured, or slow to fetch in sandbox.

const NEXUS_PRODUCT_IDS = ['Nexus', 'Annual'];

export async function getProductsDirect(): Promise<any[]> {
  if (SIM_BYPASS) return [];
  if (Platform.OS !== 'ios') return [];
  if (!isConfigured) {
    await configureRevenueCat();
  }
  try {
    const products = await Purchases.getProducts(NEXUS_PRODUCT_IDS);
    console.log(`[RevenueCat] getProducts returned ${products.length} products`);
    return products || [];
  } catch (e) {
    console.log('[RevenueCat] getProducts error:', e);
    return [];
  }
}

// ─── Trial / intro-price eligibility ──────────────────────────────────────────
// NEX-122 follow-up: the paywall's "free trial" copy must reflect the CURRENT
// user's eligibility, not just the product's configured intro offer — a user who
// already consumed the trial is ineligible and would be charged immediately.
// Returns a per-product map: true = eligible, false = ineligible (or no intro
// offer exists), null = RevenueCat couldn't determine. Never throws; on any
// failure the caller keeps showing the trial (fail-safe — the dominant launch-
// gate cohort is new + Apple-eligible, and the App Store sheet is the final word).
export async function getTrialEligibility(
  productIds: string[],
): Promise<Record<string, boolean | null>> {
  if (SIM_BYPASS) return {};
  if (Platform.OS !== 'ios') return {};
  const ids = Array.from(new Set((productIds || []).filter(Boolean)));
  if (ids.length === 0) return {};
  // Self-heal exactly like getOfferings/getProductsDirect: the paywall can mount
  // before _layout finishes configuring RC.
  if (!isConfigured) {
    await configureRevenueCat();
  }
  try {
    const result = await Purchases.checkTrialOrIntroductoryPriceEligibility(ids);
    const out: Record<string, boolean | null> = {};
    for (const [id, eligibility] of Object.entries(result)) {
      switch (eligibility?.status) {
        case INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE:
          out[id] = true;
          break;
        case INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE:
        case INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS:
          out[id] = false;
          break;
        default: // UNKNOWN or anything unexpected — caller fails safe to showing the trial
          out[id] = null;
      }
    }
    return out;
  } catch (e) {
    console.log('[RevenueCat] checkTrialOrIntroductoryPriceEligibility error:', e);
    return {};
  }
}

export async function purchaseProductDirect(product: any): Promise<{
  success: boolean;
  customerInfo?: CustomerInfo;
  error?: string;
  cancelled?: boolean;
}> {
  if (SIM_BYPASS) return { success: true };
  try {
    const { customerInfo } = await Purchases.purchaseStoreProduct(product);
    const { unlocked } = recordEntitlementGranted(customerInfo); // NEX-119: one side-effect path
    return { success: unlocked, customerInfo };
  } catch (e: any) {
    if (e.userCancelled) return { success: false, cancelled: true };
    return { success: false, error: e.message || 'Purchase failed' };
  }
}

// ─── Purchase ────────────────────────────────────────────────────────────────

export async function purchasePackage(pkg: PurchasesPackage): Promise<{
  success: boolean;
  customerInfo?: CustomerInfo;
  error?: string;
  cancelled?: boolean;
}> {
  if (SIM_BYPASS) return { success: true };
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    const { unlocked } = recordEntitlementGranted(customerInfo); // NEX-119: one side-effect path
    return { success: unlocked, customerInfo };
  } catch (e: any) {
    if (e.userCancelled) {
      return { success: false, cancelled: true };
    }
    return { success: false, error: e.message || 'Purchase failed' };
  }
}

// ─── Restore ─────────────────────────────────────────────────────────────────

export async function restorePurchases(): Promise<{
  success: boolean;
  customerInfo?: CustomerInfo;
  error?: string;
}> {
  if (SIM_BYPASS) return { success: true };
  if (!isConfigured || Platform.OS !== 'ios') {
    return { success: false, error: 'Subscriptions are only available on iOS.' };
  }
  try {
    const customerInfo = await Purchases.restorePurchases();
    const { unlocked } = recordEntitlementRestored(customerInfo); // NEX-119: one side-effect path
    return { success: unlocked, customerInfo };
  } catch (e: any) {
    return { success: false, error: e.message || 'Restore failed' };
  }
}

// ─── Identify user (link to auth) ───────────────────────────────────────────

// NEX-297: one bounded retry (300ms) — a transient network hiccup on the first
// attempt is the common failure mode, and a second consecutive failure is
// treated as non-fatal same as before (never rethrows; runSubscriptionCheck's
// 8s race relies on this function never throwing). On success, re-asserts
// `$posthogUserId` with the userId itself rather than re-querying PostHog's
// current distinct id — the layout-level posthog.identify(userId) effect isn't
// guaranteed to have run yet at this point, but userId IS the value PostHog's
// distinct id is guaranteed to eventually converge to, so this avoids the race.
// `isStale`, when passed, flows through to linkPostHogIdentity so a slow retry
// here can't tag a newer account's RC subscriber with this stale userId — see
// runSubscriptionCheck in app/_layout.tsx, which passes its own isStale.
export async function identifyUser(userId: string, isStale?: () => boolean) {
  if (SIM_BYPASS) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await Purchases.logIn(userId);
      console.log('[RevenueCat] Identified user:', userId);
      void linkPostHogIdentity(userId, isStale);
      return;
    } catch (e) {
      console.log(`[RevenueCat] Identify error (attempt ${attempt + 1}):`, e);
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

// ─── Listener ────────────────────────────────────────────────────────────────

export function onCustomerInfoUpdated(callback: (info: CustomerInfo) => void): () => void {
  if (SIM_BYPASS) return () => {};
  Purchases.addCustomerInfoUpdateListener(callback);
  // Return a remover so the caller's effect can clean up — otherwise listeners
  // stack across remounts / Fast Refresh / user switches and each update fires
  // the work multiple times.
  return () => { Purchases.removeCustomerInfoUpdateListener(callback); };
}

// ─── Pre-charge reminder (NEX-232) ───────────────────────────────────────────
// PII-free projection of the active entitlement for computeBillingReminder.

// Pure: project an in-hand CustomerInfo (no fetch). The onCustomerInfoUpdated
// listener already holds the freshest CustomerInfo, so it projects directly and
// the reconciler skips the extra getCustomerInfo() round-trip.
export function projectBillingReminderInfo(customerInfo: CustomerInfo): BillingReminderInfo | null {
  const ent = customerInfo.entitlements.active[ENTITLEMENT_ID];
  if (!ent) return null;
  const productId = String(ent.productIdentifier ?? '');
  return {
    periodType: String(ent.periodType ?? ''),
    expirationMs: ent.expirationDateMillis ?? null,
    willRenew: !!ent.willRenew,
    // Annual via /annual|year/i (the literal annual product id is "Annual") —
    // matches readEntitlementMeta, NOT checkSubscription's includes('year').
    plan: /annual|year/i.test(productId) ? 'annual' : 'monthly',
    familyShared: ent.ownershipType === 'FAMILY_SHARED',
  };
}

// Fetch path (launch reconcile). Throws on fetch failure (so the reconciler can
// skip rather than drop a valid reminder); returns null when no entitlement.
export async function getBillingReminderInfo(): Promise<BillingReminderInfo | null> {
  if (SIM_BYPASS) return null;
  const customerInfo = await Purchases.getCustomerInfo(); // may throw → caller skips this reconcile
  return projectBillingReminderInfo(customerInfo);
}

// ─── In-trial Day-0/1 activation nudge (NEX-301) ─────────────────────────────
// PII-free projection of the active entitlement for computeTrialNudgeCandidates.
// Same entitlement, same pattern as the pre-charge reminder above — a separate,
// purpose-built projection rather than extending BillingReminderInfo, since the
// two features' gating semantics are opposite (this one deliberately ignores
// willRenew).

export function projectTrialNudgeInfo(customerInfo: CustomerInfo): TrialNudgeInfo | null {
  const ent = customerInfo.entitlements.active[ENTITLEMENT_ID];
  if (!ent) return null;
  return {
    periodType: String(ent.periodType ?? ''),
    originalPurchaseMs: ent.originalPurchaseDateMillis ?? null,
    expirationMs: ent.expirationDateMillis ?? null,
    familyShared: ent.ownershipType === 'FAMILY_SHARED',
  };
}

export async function getTrialNudgeInfo(): Promise<TrialNudgeInfo | null> {
  if (SIM_BYPASS) return null;
  const customerInfo = await Purchases.getCustomerInfo(); // may throw → caller skips this reconcile
  return projectTrialNudgeInfo(customerInfo);
}
