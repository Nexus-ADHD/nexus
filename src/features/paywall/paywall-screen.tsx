// src/features/paywall/paywall-screen.tsx
// Premium subscription paywall — RevenueCat integrated
// @ts-nocheck
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert, ScrollView } from 'react-native';
import tokens from '../../theme/tokens';
import { haptic } from '../../utils/haptics';
import { PrimaryPill } from '../../components/ui/PrimaryPill';
import { AdaptiveScreen } from '../../components/ui/AdaptiveScreen';
import { getOfferings, purchasePackage, restorePurchases, getProductsDirect, purchaseProductDirect, getTrialEligibility } from '../../services/revenuecat';
import { trackEvent } from '../../services/analytics';
import { resolvePaywallContent } from './paywall-content';
import { PaywallContentPreview } from './paywall-content-preview';
import { formatTrialPeriod, buildTrialDisclosure, resolveEffectiveTrialPeriod } from './trial-copy';

const BG = tokens.color.void;
const GOLD = tokens.color.gold;

// Hardcoded fallback prices, shown only when neither RevenueCat nor
// direct StoreKit returns products. Single source for the fallback
// plan cards AND the trial disclosure so the two can never drift —
// a price mismatch between card and disclosure is an App Review /
// legal problem.
const FALLBACK_ANNUAL_PRICE = '$99.99';
const FALLBACK_MONTHLY_PRICE = '$14.99';
const TEXT_COLOR = tokens.color.text;
// v3 stellar: muted gray #555 → tokens.color.textMuted.
const MUTED = tokens.color.textMuted;

interface Props {
  onSubscribed: () => void;
  // Close handle. Settings passes it so the user can back out of the upsell
  // modal they opened voluntarily. NEX-234: the launch gate now ALSO passes it
  // (dismiss → free tier) so the core capture loop is never paywalled — both an
  // always-visible top-right X and a "Not now" on-ramp below the CTA call it.
  onClose?: () => void;
  // NEX-124: where the paywall was opened from, for the funnel `entry_point`
  // property. The launch gate passes 'launch_gate'; Settings passes 'settings'.
  entryPoint?: 'launch_gate' | 'settings' | 're_offer';
  // NEX-121: which in-bundle surface this is, for the funnel. RemotePaywallScreen
  // renders us either as the deliberate 'data_preview' A/B arm (blurred preview
  // chosen via offering metadata) or as the load-failure 'fallback'. Tagging the
  // paywall_viewed / paywall_dismissed events lets the experiment separate the
  // data_preview arm's conversion from a generic fallback (the RC remote arm
  // tags surface:'remote'). Default 'fallback' (direct render / no remote wrapper).
  surface?: 'data_preview' | 'fallback';
}

export function PaywallScreen({ onSubscribed, onClose, entryPoint = 'launch_gate', surface = 'fallback' }: Props) {
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);
  const [offering, setOffering] = useState<any>(null);
  const [directProducts, setDirectProducts] = useState<any[]>([]); // StoreKit fallback
  // Default selection is Monthly (lower commitment) — users who don't
  // actively choose land on the less expensive option. Index 1 matches
  // the hardcoded fallback UI (Annual at 0, Monthly at 1); both
  // load-success paths set the index explicitly to the detected
  // monthly package, so the initial value is only user-visible there.
  const [selectedIdx, setSelectedIdx] = useState(1);
  const [loadError, setLoadError] = useState(false);
  // NEX-122 follow-up: per-product trial eligibility (productId -> true eligible /
  // false ineligible / null unknown). Empty until fetched; an absent entry is
  // treated as "show the trial" (fail-safe — see resolveEffectiveTrialPeriod).
  const [trialEligibility, setTrialEligibility] = useState<Record<string, boolean | null>>({});
  // NEX-124: synchronous guard so two fast taps can't both reach a purchase
  // call (React-state `purchasing` only disables the button a tick later).
  const purchaseInFlightRef = useRef(false);
  // NEX-234: dismiss is a one-shot, mutually-exclusive action that unmounts the
  // screen; guard so two fast taps (X or "Not now") can't double-fire
  // paywall_dismissed / onClose (mirrors purchaseInFlightRef).
  const dismissedRef = useRef(false);

  // NEX-119: marketing copy (tagline, headline, features, plan subtexts, badge)
  // is sourced from the RevenueCat offering's metadata, so it can change without
  // an App Store build; resolvePaywallContent falls back per-field to today's
  // exact strings, so loading / direct-StoreKit-fallback / failure (offering ===
  // null → metadata undefined) all render the default copy. Dep is [offering]
  // (object identity) — do NOT "optimize" to [offering?.metadata]: RC can return
  // a fresh metadata object each call, and the cost here is trivial regardless.
  const content = useMemo(() => resolvePaywallContent(offering?.metadata), [offering]);

  useEffect(() => {
    // Auto-retry up to 3x with backoff — sandbox can be slow to populate products
    let attempt = 0;
    let cancelled = false;
    const tryLoad = async () => {
      let loaded = false;
      while (!cancelled && attempt < 3) {
        attempt++;
        console.log(`[Paywall] Load attempt ${attempt}`);
        const success = await loadOfferings();
        if (success) { loaded = true; break; }
        if (cancelled) return;
        // Wait 1s, 2s, 4s between attempts
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
      // NEX-124: the paywall was viewed. Fire once after load settles so
      // `offerings_loaded` reflects the real outcome. Gate paywall mounts on
      // every cold launch for unsubscribed users — PostHog funnels dedupe per
      // person, so per-view firing is fine.
      if (!cancelled) {
        void trackEvent('paywall_viewed', { entry_point: entryPoint, offerings_loaded: loaded, surface });
      }
    };
    tryLoad();
    return () => { cancelled = true; };
  }, []);

  const loadOfferings = async (): Promise<boolean> => {
    setLoadError(false);
    try {
      // Primary path: RevenueCat offerings
      const off = await getOfferings();
      if (off?.availablePackages?.length) {
        setOffering(off);
        console.log(`[Paywall] Loaded ${off.availablePackages.length} packages via RevenueCat`);
        // Default select Monthly. The product?.identifier check covers
        // custom RC packages wrapping the monthly StoreKit product,
        // whose id is literally 'Nexus' (revenuecat.ts NEXUS_PRODUCT_IDS).
        // Always set a valid index — package order isn't guaranteed and
        // a stale index on a short array strands the CTA on the
        // "Not Available" alert.
        const monthlyIdx = off.availablePackages.findIndex((p: any) =>
          p.packageType === 'MONTHLY' || p.identifier?.toLowerCase().includes('month') || p.product?.identifier === 'Nexus'
        );
        setSelectedIdx(monthlyIdx >= 0 ? monthlyIdx : 0);
        setLoading(false);
        return true;
      }

      // Fallback path: Direct StoreKit fetch (bypasses RevenueCat offering config).
      // Works in sandbox even if offering isn't configured / hasn't propagated yet.
      console.log('[Paywall] RevenueCat offerings empty — trying direct StoreKit fetch');
      const products = await getProductsDirect();
      if (products.length > 0) {
        setDirectProducts(products);
        console.log(`[Paywall] Loaded ${products.length} products via direct StoreKit`);
        // Default select Monthly. The monthly product id is literally
        // 'Nexus' (revenuecat.ts NEXUS_PRODUCT_IDS = ['Nexus','Annual'])
        // so a 'month' substring can never match — exact-match first,
        // then first non-annual, then 0. Always set a valid index;
        // StoreKit product order isn't guaranteed.
        const monthlyIdx = products.findIndex((p: any) => p.identifier === 'Nexus');
        const nonAnnualIdx = products.findIndex((p: any) => p.identifier != null && !(
          p.identifier.includes('Annual') || p.identifier.includes('annual') || p.identifier.includes('year')
        ));
        setSelectedIdx(monthlyIdx >= 0 ? monthlyIdx : nonAnnualIdx >= 0 ? nonAnnualIdx : 0);
        setLoading(false);
        return true;
      }

      // Nothing loaded either way
      console.log('[Paywall] No products from RevenueCat OR direct StoreKit');
      setLoadError(true);
      setLoading(false);
      return false;
    } catch (e) {
      console.log('[Paywall] Load error:', e);
      setLoadError(true);
      setLoading(false);
      return false;
    }
  };

  const handlePurchase = async () => {
    // NEX-124: synchronous re-entry guard. Two fast taps would otherwise both
    // reach a purchase call before `setPurchasing(true)` re-renders the button.
    if (purchaseInFlightRef.current) return;
    purchaseInFlightRef.current = true;
    try {
      await runPurchase();
    } finally {
      purchaseInFlightRef.current = false;
    }
  };

  const runPurchase = async () => {
    const pkgCount = offering?.availablePackages?.length ?? 0;
    const directCount = directProducts.length;
    console.log(`[Paywall] START FREE TRIAL tapped — RC packages: ${pkgCount}, direct products: ${directCount}, selectedIdx: ${selectedIdx}`);

    // Try RevenueCat path first
    if (offering?.availablePackages?.[selectedIdx]) {
      setPurchasing(true);
      haptic('dragDrop');
      try {
        const pkg = offering.availablePackages[selectedIdx];
        const result = await purchasePackage(pkg);
        if (result.success) {
          haptic('voiceSuccess');
          onSubscribed();
        } else if (result.cancelled) {
          // User cancelled
        } else {
          Alert.alert('Purchase Failed', result.error || 'Please try again.');
        }
      } catch (e: any) {
        Alert.alert('Error', e.message || 'Please try again.');
      } finally {
        setPurchasing(false);
      }
      return;
    }

    // Try direct StoreKit path
    if (directProducts[selectedIdx]) {
      setPurchasing(true);
      haptic('dragDrop');
      try {
        const product = directProducts[selectedIdx];
        const result = await purchaseProductDirect(product);
        if (result.success) {
          haptic('voiceSuccess');
          onSubscribed();
        } else if (result.cancelled) {
          // User cancelled
        } else {
          Alert.alert('Purchase Failed', result.error || 'Please try again.');
        }
      } catch (e: any) {
        Alert.alert('Error', e.message || 'Please try again.');
      } finally {
        setPurchasing(false);
      }
      return;
    }

    // No products loaded via either path
    Alert.alert('Not Available', 'Subscription plans could not be loaded. Please check your connection and try again.', [
      { text: 'Retry', onPress: () => { setLoading(true); loadOfferings(); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleRestore = async () => {
    setLoading(true);
    try {
      const result = await restorePurchases();
      if (result.success) {
        haptic('voiceSuccess');
        onSubscribed();
      } else {
        Alert.alert('No Subscription Found', 'No previous subscription found for this account.');
      }
    } catch (e: any) {
      Alert.alert('Restore Failed', e.message || 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // NEX-234: any dismiss affordance (top-right X or the launch-gate "Not now"
  // on-ramp) routes here so the funnel records the dismissal once, with the
  // entry point — symmetric with the paywall_viewed emit on mount. Only reached
  // when onClose is defined (both affordances render only then).
  const handleDismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    void trackEvent('paywall_dismissed', { entry_point: entryPoint, surface });
    onClose?.();
  };

  // Primary packages from RevenueCat. If empty, fall back to direct StoreKit products
  // wrapped in a package-like shape so the render loop doesn't need to change.
  const packages = offering?.availablePackages?.length
    ? offering.availablePackages
    : directProducts.map((p: any) => ({
        identifier: p.identifier,
        packageType: p.identifier?.toLowerCase().includes('annual') || p.identifier?.toLowerCase().includes('year') ? 'ANNUAL' : 'MONTHLY',
        product: p,
      }));

  // NEX-122 follow-up: fetch per-product trial eligibility once the products are
  // known. Stable, sorted, deduped key so the effect only re-fires when the real
  // product set changes (packages is rebuilt every render). Render is never
  // blocked on this — the fetch updates state when it resolves; the rare late
  // ineligible result simply refines the copy to the more honest state.
  const eligibilityKey = Array.from(
    new Set(packages.map((p: any) => p.product?.identifier).filter(Boolean)),
  ).sort().join(',');
  useEffect(() => {
    if (!eligibilityKey) return;
    let cancelled = false;
    (async () => {
      const map = await getTrialEligibility(eligibilityKey.split(','));
      if (!cancelled) setTrialEligibility(map);
    })();
    return () => { cancelled = true; };
  }, [eligibilityKey]);

  const getPlanLabel = (pkg: any): string => {
    const type = pkg.packageType || '';
    const id = (pkg.identifier || '').toLowerCase();
    if (type === 'LIFETIME' || id.includes('lifetime')) return 'Lifetime';
    if (type === 'ANNUAL' || id.includes('annual') || id.includes('year')) return 'Annual';
    if (type === 'MONTHLY' || id.includes('month')) return 'Monthly';
    return pkg.identifier || 'Plan';
  };

  const getPlanSubtext = (pkg: any): string => {
    const type = pkg.packageType || '';
    const id = (pkg.identifier || '').toLowerCase();
    // 'lifetime' has no real product (NEX-233 forbids non-consumable paid
    // plans), so its subtext is dead-branch default copy and is deliberately
    // NOT remote-configurable. Annual/monthly come from offering metadata.
    if (type === 'LIFETIME' || id.includes('lifetime')) return 'Pay once, own forever';
    if (type === 'ANNUAL' || id.includes('annual') || id.includes('year')) return content.planSubtexts.annual;
    return content.planSubtexts.monthly;
  };

  const isBestValue = (pkg: any): boolean => {
    const type = pkg.packageType || '';
    const id = (pkg.identifier || '').toLowerCase();
    return type === 'ANNUAL' || id.includes('annual') || id.includes('year');
  };

  // Period suffix for the trial disclosure. priceString is the bare
  // localized price ("$99.99"); the plan card conveys the period via
  // its title, but the disclosure must state it inline so the user
  // knows what START FREE TRIAL commits them to.
  const getPeriodSuffix = (pkg: any): string | null => {
    if (isBestValue(pkg)) return '/yr';
    const type = pkg.packageType || '';
    const id = (pkg.identifier || '').toLowerCase();
    if (type === 'MONTHLY' || id.includes('month') || pkg.product?.identifier === 'Nexus') return '/mo';
    // Unknown period (LIFETIME etc. — unreachable per locked pricing,
    // defensive only). Null so the disclosure falls back to the generic
    // static string instead of stating a price with no period.
    return null;
  };

  // Price label for the currently selected plan, driving the trial
  // disclosure. Three cases:
  //   1. Loaded package (RC or wrapped direct StoreKit) — localized
  //      priceString + period suffix.
  //   2. Hardcoded fallback cards showing (!loading && no packages) —
  //      fixed labels matching those cards' indices.
  //   3. Loading spinner / missing priceString — null; the disclosure
  //      keeps the generic static string rather than asserting a price
  //      before any plan cards exist.
  const selectedPkg = packages[selectedIdx];
  const selectedPeriodSuffix = selectedPkg ? getPeriodSuffix(selectedPkg) : null;
  const selectedPriceLabel = selectedPkg?.product?.priceString && selectedPeriodSuffix !== null
    ? `${selectedPkg.product.priceString}${selectedPeriodSuffix}`
    : !loading && packages.length === 0
      ? (selectedIdx === 1 ? `${FALLBACK_MONTHLY_PRICE}/mo` : `${FALLBACK_ANNUAL_PRICE}/yr`)
      : null;

  // NEX-122: honest trial disclosure. The trial length is derived from the
  // selected product's REAL StoreKit intro offer (introPrice) — never a
  // hardcoded "7 days" that silently drifts from the App Store Connect config
  // (the prior bug). buildTrialDisclosure also refuses to claim "free" when the
  // loaded product has no free-trial intro, and defers to the App Store sheet
  // when no product loaded. Stays in code (not remote) — it states price +
  // cancellation, which carry App-Review / legal weight (paywall-content.ts scope).
  // Both load paths put a RevenueCat `PurchasesStoreProduct` at `pkg.product`
  // (offering packages, and `getProductsDirect`'s `Purchases.getProducts`
  // result), and both carry `introPrice` — so the trial derivation works on the
  // direct-StoreKit fallback too. If `introPrice` is ever absent, this resolves
  // to null and the CTA falls to "SUBSCRIBE": the honest fail-safe is to
  // under-promise (never claim a trial we can't confirm), not over-promise.
  // NEX-122 follow-up: gate the product's configured trial on THIS user's
  // eligibility. A user who already consumed the free trial is ineligible and
  // would be charged immediately, so the claim is suppressed for them. Only an
  // explicit ineligible verdict suppresses it; unknown / not-yet-fetched keeps
  // the trial (fail-safe — see resolveEffectiveTrialPeriod). The lookup key is
  // the same `product.identifier` on both the RC-offering and direct paths.
  const selectedTrialPeriod = resolveEffectiveTrialPeriod(
    formatTrialPeriod(selectedPkg?.product?.introPrice),
    selectedPkg?.product?.identifier ? trialEligibility[selectedPkg.product.identifier] : undefined,
  );
  const trialDisclosure = buildTrialDisclosure({
    productLoaded: packages.length > 0,
    trialPeriod: selectedTrialPeriod,
    priceLabel: selectedPriceLabel,
  });
  // NEX-122: the CTA must not promise a free trial the disclosure denies. Say
  // "START FREE TRIAL" when a trial is actually offered — a real free intro on
  // the loaded product (and the user is eligible), OR the pre-load / offline
  // state (the Nexus products do offer trials; the App Store sheet confirms the
  // specifics). When a product loads with NO free trial for this user, the
  // honest label is "SUBSCRIBE".
  const ctaLabel = packages.length === 0 || selectedTrialPeriod ? 'START FREE TRIAL' : 'SUBSCRIBE';

  return (
    <View style={styles.container}>
      {onClose && (
        <Pressable
          onPress={handleDismiss}
          hitSlop={16}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={{ position: 'absolute', top: 50 /* FIXME(nex-56): off-scale spacing 50 — review */, right: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, zIndex: 10, width: 36, height: 36, borderRadius: 18, backgroundColor: tokens.color.surfaceElevated, alignItems: 'center', justifyContent: 'center' }}
        >
          {/* FIXME(nex-56): off-scale fontSize 18 (close glyph ×), design review */}
          <Text style={{ color: MUTED, fontSize: 18, fontWeight: '700' }}>×</Text>
        </Pressable>
      )}
      <AdaptiveScreen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        <Text style={styles.logo}>N E X U S</Text>
        {/* NEX-119: tagline + headline from offering metadata (default = today's
            copy). The '◆' bullet stays in code — it's brand ornament, not copy. */}
        <Text style={styles.tagline}>{content.tagline}</Text>

        {/* NEX-242: dropped "Unlock" (§19 banned copy) and the locked-app
            implication — NEX-234 added a free tier, so this is Premium's pitch,
            not a gate. Premium = the full experience; free = the core. */}
        <Text style={styles.headline}>{content.headline}</Text>

        {/* NEX-121: remote-selectable layout. The 'data_preview' variant (set via
            offering metadata, A/B-tested) replaces the feature list with the
            "paywall as content" blurred-shape preview of the user's own insight.
            Default 'standard' renders the feature list byte-for-byte. Same slot
            (above the plans), so dismiss / CTA / restore / legal are untouched. */}
        {content.variant === 'data_preview' ? (
          <PaywallContentPreview style={styles.dataPreview} />
        ) : (
          <View style={styles.features}>
            {content.features.map((text, i) => (
              <View key={i} style={styles.featureRow}>
                <Text style={styles.featureIcon}>◆</Text>
                <Text style={styles.featureText}>{text}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Plans from RevenueCat */}
        {loading ? (
          <ActivityIndicator color={GOLD} size="large" style={{ marginVertical: 30 }} />
        ) : packages.length > 0 ? (
          <View style={styles.plans}>
            {packages.map((pkg: any, idx: number) => {
              const selected = idx === selectedIdx;
              const bestValue = isBestValue(pkg);
              return (
                <Pressable
                  key={pkg.identifier}
                  style={[styles.planCard, selected && styles.planCardSelected]}
                  onPress={() => { setSelectedIdx(idx); haptic('tabChange'); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${getPlanLabel(pkg)}, ${pkg.product?.priceString || '$--'}`}
                >
                  {bestValue && (
                    <View style={styles.planBadge}>
                      <Text style={styles.planBadgeText}>{content.bestValueBadge}</Text>
                    </View>
                  )}
                  <Text style={styles.planTitle}>{getPlanLabel(pkg)}</Text>
                  <Text style={styles.planPrice}>{pkg.product?.priceString || '$--'}</Text>
                  {/* NEX-122: annual effective monthly cost, from RevenueCat's
                      own localized per-month price (pricePerMonthString). Derived
                      and accurate — never a hardcoded figure. The saving claim
                      stays in the remote planSubtext below (NEX-119). Guard the
                      "/mo" suffix: pricePerMonthString is a bare localized price
                      today, but only append the period when it isn't already
                      present so a future SDK can't yield "$8.33/mo/mo". */}
                  {bestValue && pkg.product?.pricePerMonthString ? (
                    <Text style={styles.planEffective}>
                      {/\/m/i.test(pkg.product.pricePerMonthString)
                        ? pkg.product.pricePerMonthString
                        : `${pkg.product.pricePerMonthString}/mo`}
                    </Text>
                  ) : null}
                  <Text style={styles.planSub}>{getPlanSubtext(pkg)}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          // NEX-119: these hardcoded fallback cards render ONLY in the degraded
          // no-offering state (offering load failed → no metadata exists to read),
          // so they are intentionally NOT remote-driven and stay frozen here.
          <View style={styles.plans}>
            <Pressable
              style={[styles.planCard, selectedIdx === 0 && styles.planCardSelected]}
              onPress={() => { setSelectedIdx(0); haptic('tabChange'); }}
              accessibilityRole="radio"
              accessibilityState={{ selected: selectedIdx === 0 }}
              accessibilityLabel={`Annual, ${FALLBACK_ANNUAL_PRICE} per year`}
            >
              <View style={styles.planBadge}><Text style={styles.planBadgeText}>BEST VALUE</Text></View>
              <Text style={styles.planTitle}>Annual</Text>
              <Text style={styles.planPrice}>{`${FALLBACK_ANNUAL_PRICE}/year`}</Text>
              <Text style={styles.planSub}>$8.33/month · Save 44%</Text>
            </Pressable>
            <Pressable
              style={[styles.planCard, selectedIdx === 1 && styles.planCardSelected]}
              onPress={() => { setSelectedIdx(1); haptic('tabChange'); }}
              accessibilityRole="radio"
              accessibilityState={{ selected: selectedIdx === 1 }}
              accessibilityLabel={`Monthly, ${FALLBACK_MONTHLY_PRICE} per month`}
            >
              <Text style={styles.planTitle}>Monthly</Text>
              <Text style={styles.planPrice}>{`${FALLBACK_MONTHLY_PRICE}/month`}</Text>
              <Text style={styles.planSub}>Cancel anytime</Text>
            </Pressable>
          </View>
        )}

        {/* Load error state */}
        {/* FIXME(nex-56): tokens.color.textDisabled off-scale gray for retry-button background — design review */}
        {loadError && !loading && (
          <Pressable
            onPress={() => { setLoading(true); loadOfferings(); }}
            style={[styles.ctaBtn, { backgroundColor: tokens.color.surface, marginBottom: tokens.spacing.sm }]}
            accessibilityRole="button"
            accessibilityLabel="Retry loading plans"
          >
            <Text style={[styles.ctaText, { color: GOLD }]}>RETRY LOADING PLANS</Text>
          </Pressable>
        )}

        {/* CTA — never fully disabled so Apple reviewer can always tap it */}
        <PrimaryPill fullWidth style={{ marginBottom: tokens.spacing.sm }} onPress={handlePurchase} loading={purchasing}>
          {ctaLabel}
        </PrimaryPill>

        <Text style={styles.trialNote}>{trialDisclosure}</Text>

        {/* NEX-234: launch-gate free on-ramp. The top-right X (above) already
            guarantees a visible dismiss; this above-fold button states plainly
            that dismissing gives a usable free tier rather than closing the app.
            Settings keeps just the X (it opened the modal voluntarily). */}
        {entryPoint !== 'settings' && onClose && (
          <Pressable
            onPress={() => { haptic('tabChange'); handleDismiss(); }}
            style={styles.freeTierBtn}
            accessibilityRole="button"
          >
            <Text style={styles.freeTierText}>Not now · try free</Text>
          </Pressable>
        )}

        <Pressable
          onPress={handleRestore}
          style={styles.linkBtn}
          accessibilityRole="button"
          accessibilityLabel="Restore purchase"
        >
          <Text style={styles.linkText}>Restore Purchase</Text>
        </Pressable>

        <Text style={styles.legal}>
          Payment is charged to your Apple ID account at confirmation of purchase. Subscription automatically renews unless cancelled at least 24 hours before the end of the current period.
        </Text>

      </ScrollView>
      </AdaptiveScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  scroll: { paddingHorizontal: 28 /* FIXME(nex-56): off-scale spacing 28 — between lg(24) and xl(32), review */, paddingTop: 60 /* FIXME(nex-56): off-scale spacing 60 — between xxl(48) and xxxl(72), review */, paddingBottom: 40 /* FIXME(nex-56): off-scale spacing 40 — review */ },
  // FIXME(nex-56): fontSize 16 matches buttonPrimary size but fontWeight '900' ≠ token '600' — design review
  logo: { color: GOLD, fontSize: 16, fontWeight: '900', letterSpacing: 8, textAlign: 'center', marginBottom: tokens.spacing.xxs },
  // FIXME(nex-56): off-scale fontSize 8, design review
  tagline: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 3, textAlign: 'center', marginBottom: 40 /* FIXME(nex-56): off-scale spacing 40 — review */ },
  // FIXME(nex-56): off-scale fontSize 32 (paywall headline display), design review
  headline: { color: TEXT_COLOR, fontSize: 32, fontWeight: '800', textAlign: 'center', lineHeight: 40, marginBottom: tokens.spacing.xl, letterSpacing: -1 },
  features: { marginBottom: tokens.spacing.xl },
  dataPreview: { marginBottom: tokens.spacing.xl }, // NEX-121: occupies the feature-list slot
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.sm, marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */ },
  // FIXME(nex-56): off-scale fontSize 12, design review
  featureIcon: { color: GOLD, fontSize: 12 },
  // FIXME(nex-56): fontSize 15 matches bodyMd size but fontWeight '500' ≠ token '400' (matches bodyMdEmphasis weight); no fontFamily set — design review
  featureText: { color: TEXT_COLOR, fontSize: 15, fontWeight: '500', opacity: 0.9 },
  plans: { gap: tokens.spacing.sm, marginBottom: tokens.spacing.lg },
  // Note: 111 close to surface (111113, delta 1 digit, established precedent)
  // v3 stellar: neutral border #222 → tokens.color.goldHairline (now luminous white).
  planCard: { backgroundColor: tokens.color.surface, borderRadius: 16, borderWidth: 1.5, borderColor: tokens.color.goldHairline, padding: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, position: 'relative' },
  // v3 stellar: gold-dark tint #0A0800 → tokens.color.goldWash (subtle gold rgba).
  planCardSelected: { borderColor: GOLD, backgroundColor: tokens.color.goldWash },
  planBadge: { position: 'absolute', top: -10 /* FIXME(nex-56): negative spacing -10, design review */, right: tokens.spacing.md, backgroundColor: GOLD, borderRadius: 6, paddingHorizontal: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, paddingVertical: 3 /* FIXME(nex-56): off-scale spacing 3 — review */ },
  // FIXME(nex-56): off-scale fontSize 8, design review
  planBadgeText: { color: tokens.color.textInverse, fontSize: 8, fontWeight: '900', letterSpacing: 1.5 },
  // FIXME(nex-56): off-scale fontSize 18 (plan title), design review
  planTitle: { color: TEXT_COLOR, fontSize: 18, fontWeight: '700', marginBottom: tokens.spacing.xxs },
  // FIXME(nex-56): fontSize 22 matches titleSection size but fontWeight '900' ≠ token '600' — design review
  planPrice: { color: GOLD, fontSize: 22, fontWeight: '900', marginBottom: 2 /* FIXME(nex-56): off-scale spacing 2 — review */ },
  // NEX-122: annual effective monthly ("$8.33/mo"). Muted + small so it reads as
  // a factual sub-line under the headline price, not a competing figure.
  // FIXME(nex-56): off-scale fontSize 12, design review
  planEffective: { color: MUTED, fontSize: 12, marginBottom: 2 /* FIXME(nex-56): off-scale spacing 2 — review */ },
  // FIXME(nex-56): off-scale fontSize 12, design review
  planSub: { color: MUTED, fontSize: 12 },
  ctaBtn: { backgroundColor: GOLD, borderRadius: 16, paddingVertical: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, alignItems: 'center', marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): off-scale fontSize 14, design review
  ctaText: { color: tokens.color.textInverse, fontSize: 14, fontWeight: '900', letterSpacing: 2 },
  // FIXME(nex-56): off-scale fontSize 11, design review
  trialNote: { color: MUTED, fontSize: 11, textAlign: 'center', marginBottom: tokens.spacing.md },
  // NEX-234: launch-gate free on-ramp. Sits above-fold below the CTA; tracked-
  // caps muted text so it reads as a calm secondary action, not a competing CTA.
  freeTierBtn: { alignItems: 'center', paddingVertical: 16, marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale fontSize 13 + letterSpacing — design review
  freeTierText: { color: MUTED, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  linkBtn: { alignItems: 'center', paddingVertical: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 12, design review
  linkText: { color: tokens.color.textMuted, fontSize: 12, textDecorationLine: 'underline' },
  // FIXME(nex-56): tokens.color.textDisabled off-scale gray (legal fine-print) — design review
  // FIXME(nex-56): off-scale fontSize 9, design review
  legal: { color: tokens.color.textDisabled, fontSize: 9, textAlign: 'center', lineHeight: 14, marginTop: tokens.spacing.md },
});
