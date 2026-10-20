// src/features/paywall/remote-paywall-logic.ts
// NEX-119: pure decision helper for RemotePaywallScreen, kept free of React-Native /
// react-native-purchases-ui imports so the vitest (Node) suite can cover it.
import type { PaywallVariant } from './paywall-content';

/**
 * RevenueCat fires onDismiss on a successful purchase/restore as well as on a real close.
 * A dismiss is only the user backing out (NEX-234 free-tier path) when nothing completed;
 * otherwise onDismiss is the post-success close, where we unlock instead.
 */
export function isGenuineDismiss(flags: { purchaseCompleted: boolean; restoreCompleted: boolean }): boolean {
  return !flags.purchaseCompleted && !flags.restoreCompleted;
}

/**
 * Choose which surface RemotePaywallScreen shows.
 *
 * NEX-121: the `data_preview` variant (the blurred "paywall as content" preview of
 * the user's own alignment/debrief data) is a CUSTOM in-bundle layout — it can't be
 * a RevenueCat dashboard template, since RC templates can't render the user's live
 * data. So when an offering's metadata selects it, render the in-bundle
 * `<PaywallScreen/>` (which hosts the preview) EVEN THOUGH offerings loaded. That
 * makes `data_preview` a real A/B arm against the RC template, not a
 * load-failure-only fallback.
 *
 * Otherwise the original rule holds: RC remote template when offerings load,
 * in-bundle fallback when they don't.
 */
export function resolvePaywallMode(args: { hasOffering: boolean; variant: PaywallVariant }): 'remote' | 'fallback' {
  if (args.variant === 'data_preview') return 'fallback';
  return args.hasOffering ? 'remote' : 'fallback';
}
