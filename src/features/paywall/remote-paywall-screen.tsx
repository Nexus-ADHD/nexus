// src/features/paywall/remote-paywall-screen.tsx
// NEX-119: RevenueCat remote-paywall wrapper.
//
// RevenueCat renders the dashboard-configured paywall template (so layout, copy, and
// pricing can change without an App Store build — the goal of NEX-119) and performs the
// StoreKit purchase internally. We do NOT use a separate purchase API here; instead we react
// to RC's `onPurchaseCompleted` / `onRestoreCompleted` and run the SAME entitlement
// side-effects (subscription_started dedupe, Supabase profile sync, post-purchase email,
// subscription_restored) through the centralized `revenuecat.ts` helpers — so no side-effect
// is bypassed and no raw `Purchases.*` purchase call lives in the UI layer.
//
// This still keeps billing native App Store StoreKit (no off-store payment). The
// native-billing policy is updated to name the RC Paywall UI as a sanctioned native surface.
//
// Falls back to the in-bundle <PaywallScreen/> when RevenueCat offerings don't load
// (offline / no offering / simulator) or the native paywall view throws while rendering.
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import RevenueCatUI from 'react-native-purchases-ui';
import type { CustomerInfo } from 'react-native-purchases';
import tokens from '../../theme/tokens';
import { PaywallScreen } from './paywall-screen';
import { isGenuineDismiss, resolvePaywallMode } from './remote-paywall-logic';
import { resolvePaywallContent, type PaywallVariant } from './paywall-content';
import { getOfferings, recordEntitlementGranted, recordEntitlementRestored } from '../../services/revenuecat';
import { trackEvent } from '../../services/analytics';

// Shared so the invocation sites (launch gate + Settings) stay in sync. Deliberately
// NOT including 'onboarding' — that placement is NEX-120 and adds it when it lands.
export type PaywallEntryPoint = 'launch_gate' | 'settings' | 're_offer';

interface Props {
  onSubscribed: () => void;
  onClose?: () => void;
  entryPoint?: PaywallEntryPoint;
}

// Catches a render throw from the native <Paywall/> view and flips the parent to the
// in-bundle fallback. (A try/catch around JSX would not catch a child render error.)
class PaywallErrorBoundary extends React.Component<
  { onError: () => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.log('[RemotePaywall] remote render failed, using fallback:', error);
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type Mode = 'loading' | 'remote' | 'fallback';

export function RemotePaywallScreen({ onSubscribed, onClose, entryPoint = 'launch_gate' }: Props) {
  const [mode, setMode] = useState<Mode>('loading');
  // NEX-121: the resolved A/B variant, so the fallback render can tag PaywallScreen's
  // funnel events as the 'data_preview' arm vs a generic load-failure 'fallback'.
  const [variant, setVariant] = useState<PaywallVariant>('standard');
  // RC fires onDismiss on a successful purchase/restore as well as on a real close, so
  // we track completion to tell the two apart. onSubscribed is fired exactly once.
  const purchaseCompletedRef = useRef(false);
  const restoreCompletedRef = useRef(false);
  const subscribedFiredRef = useRef(false);
  const viewedFiredRef = useRef(false);

  // Decide remote vs fallback once per mount. The embedded <Paywall/> has no load-error
  // callback, so we gate on offering availability: if RC offerings load we show the
  // remote template (RC renders the configured paywall, or its own default if none is
  // set); otherwise we fall back to <PaywallScreen/> (its own retry + direct-StoreKit path).
  useEffect(() => {
    let active = true;
    (async () => {
      let hasOffering = false;
      // NEX-121: the offering's metadata may select the 'data_preview' A/B arm,
      // which is a custom in-bundle layout (not an RC template). Default
      // 'standard' so any fetch error keeps the original remote/fallback rule.
      let variant: PaywallVariant = 'standard';
      try {
        const off = await getOfferings();
        hasOffering = !!off?.availablePackages?.length;
        variant = resolvePaywallContent(off?.metadata).variant;
      } catch {
        hasOffering = false;
      }
      if (active) {
        setVariant(variant);
        setMode(resolvePaywallMode({ hasOffering, variant }));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // paywall_viewed: emit on the remote path only — the fallback <PaywallScreen/> emits
  // its own, so emitting here too would double-count.
  useEffect(() => {
    if (mode !== 'remote' || viewedFiredRef.current) return;
    viewedFiredRef.current = true;
    // offerings_loaded is always true on the remote surface — it IS the gate condition
    // for entering 'remote' mode (the fallback PaywallScreen reports the real outcome).
    void trackEvent('paywall_viewed', {
      entry_point: entryPoint,
      offerings_loaded: true,
      surface: 'remote',
    });
  }, [mode, entryPoint]);

  const unlockOnce = () => {
    if (subscribedFiredRef.current) return;
    subscribedFiredRef.current = true;
    onSubscribed();
  };

  // RC completed the purchase internally and handed us customerInfo. Run the same
  // revenuecat.ts side-effects (granted there, with all analytics + profile sync), and
  // DEFER the unlock to onDismiss: unlocking now would unmount the native <Paywall/> while
  // it is still showing its success state / animating closed. RC fires onDismiss right after.
  const handlePurchaseCompleted = ({ customerInfo }: { customerInfo: CustomerInfo }) => {
    if (recordEntitlementGranted(customerInfo).unlocked) purchaseCompletedRef.current = true;
  };
  // RC's onRestoreCompleted can fire with no active entitlement — only mark completion (and
  // later unlock) when the entitlement is actually present.
  const handleRestoreCompleted = ({ customerInfo }: { customerInfo: CustomerInfo }) => {
    if (recordEntitlementRestored(customerInfo).unlocked) restoreCompletedRef.current = true;
  };

  const handleDismiss = () => {
    if (!isGenuineDismiss({
      purchaseCompleted: purchaseCompletedRef.current,
      restoreCompleted: restoreCompletedRef.current,
    })) {
      // The purchase/restore already succeeded and the native paywall is closing — now
      // it's safe to unlock (and unmount). No dismiss analytics / onClose: not a back-out.
      unlockOnce();
      return;
    }
    // A genuine close: persist the launch-gate free tier (NEX-234) + emit the funnel event.
    void trackEvent('paywall_dismissed', { entry_point: entryPoint, surface: 'remote' });
    onClose?.();
  };

  if (mode === 'fallback') {
    // NEX-121: PaywallScreen re-fetches offerings itself (its own load + retry +
    // direct-StoreKit path) — the offering we fetched above to pick the variant is
    // intentionally not threaded down. Tag the surface so the funnel separates the
    // deliberate data_preview A/B arm from a generic load-failure fallback.
    return (
      <PaywallScreen
        onSubscribed={onSubscribed}
        onClose={onClose}
        entryPoint={entryPoint}
        surface={variant === 'data_preview' ? 'data_preview' : 'fallback'}
      />
    );
  }
  if (mode === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={tokens.color.gold} />
      </View>
    );
  }
  return (
    <PaywallErrorBoundary onError={() => setMode('fallback')}>
      {/* displayCloseButton is honored for original templates but IGNORED for V2
          dashboard paywalls (SDK caveat). The NEX-234 free-tier escape at the launch
          gate therefore depends on the configured dashboard template including a close
          component — a hard requirement enforced by the release/TestFlight checklist,
          not guaranteed by this prop. */}
      {/* onPurchaseError / onPurchaseCancelled are intentionally NOT wired: in RC's
          standard internal-purchase mode RC owns the error/cancel UI on the paywall, and
          a cancel/error simply leaves the user on the paywall. We only react to the
          terminal success (onPurchaseCompleted/onRestoreCompleted) and close (onDismiss). */}
      <RevenueCatUI.Paywall
        style={styles.fill}
        options={{ displayCloseButton: true }}
        onPurchaseCompleted={handlePurchaseCompleted}
        onRestoreCompleted={handleRestoreCompleted}
        onDismiss={handleDismiss}
      />
    </PaywallErrorBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.color.void,
  },
});
