// src/features/paywall/use-paywall-reoffer.ts
// RN glue for the free-week re-offer. Decision logic lives in reoffer-logic.ts (pure,
// unit-tested); this hook only reads state, applies the once-per-session latch,
// persists the cap record, and emits paywall_reoffer_shown / paywall_reoffer_started.
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { trackEvent } from '../../services/analytics';
import { scopedDeviceFlagKey } from '../../state/legacy-grandfather';
import { decideReoffer, parseReofferState, type ReofferTrigger } from './reoffer-logic';

export const PAYWALL_REOFFER_KEY = 'nexus_paywall_reoffer_v1';

// Quiet moments only: the main tab roots. Anything else (a ceremony, a detail screen, a
// settings page, onboarding) is treated as "blocked" — fail closed.
const CALM_PATHS = new Set(['/', '/home', '/orbit', '/inbox', '/align']);
const SETTLE_MS = 4000;

// Module-level latch: one re-offer per app process, even across layout remounts.
let shownThisProcess = false;

interface Args {
  userId: string | null;
  /** App is visible (not onboarding / launch gate) and all gate checks have settled. */
  ready: boolean;
  isSubscribed: boolean;
  isLegacyFree: boolean;
  launchGateDismissed: boolean;
  activatedDate: string | null;
  firstWin: boolean;
  pathname: string | null;
}

export function usePaywallReoffer(a: Args) {
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef<ReofferTrigger>('first_win');
  const countRef = useRef(1);

  useEffect(() => {
    if (visible || shownThisProcess || !a.ready || !a.userId) return;
    const key = scopedDeviceFlagKey(PAYWALL_REOFFER_KEY, a.userId);
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let raw: string | null = null;
      try {
        raw = await AsyncStorage.getItem(key);
      } catch {
        return; // can't read the cap record -> don't present
      }
      if (cancelled || shownThisProcess) return;
      const state = parseReofferState(raw);
      const d = decideReoffer({
        now: Date.now(),
        isSubscribed: a.isSubscribed,
        isLegacyFree: a.isLegacyFree,
        launchGateDismissed: a.launchGateDismissed,
        activatedDate: a.activatedDate,
        firstWin: a.firstWin,
        state,
        shownThisSession: false,
        blocked: !a.pathname || !CALM_PATHS.has(a.pathname),
      });
      if (!d.show || !d.trigger) return;
      shownThisProcess = true;
      const next = { count: state.count + 1, lastShownAt: Date.now() };
      // Persist BEFORE presenting so a crash mid-paywall can never loop the offer.
      try {
        await AsyncStorage.setItem(key, JSON.stringify(next));
      } catch {}
      triggerRef.current = d.trigger;
      countRef.current = next.count;
      void trackEvent('paywall_reoffer_shown', {
        trigger: d.trigger,
        reoffer_number: next.count,
        entry_point: 're_offer',
      });
      setVisible(true);
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    visible,
    a.ready,
    a.userId,
    a.isSubscribed,
    a.isLegacyFree,
    a.launchGateDismissed,
    a.activatedDate,
    a.firstWin,
    a.pathname,
  ]);

  const onClose = useCallback(() => setVisible(false), []);
  const onSubscribed = useCallback(() => {
    void trackEvent('paywall_reoffer_started', {
      trigger: triggerRef.current,
      reoffer_number: countRef.current,
      entry_point: 're_offer',
    });
    setVisible(false);
  }, []);

  return { visible, onClose, onSubscribed };
}
