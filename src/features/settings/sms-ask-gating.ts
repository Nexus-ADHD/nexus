// NEX-321: pure gating helper for the in-app SMS opt-in ask sheet. Extracted
// from sms-opt-in-sheet.tsx so the show/don't-show decision is unit-testable —
// this repo's vitest setup is pure-Node with no RN runtime, so anything living
// inside the RN component can't be exercised this way.

// AsyncStorage flag set when the user taps "Not now" (or completes an enable),
// so the sheet never re-asks.
export const SMS_ASK_DISMISSED_KEY = 'nexus_smsAskDismissed';

export interface SmsAskGateInputs {
  isActivated: boolean;
  demonstratedValue: boolean;
  dismissed: boolean;
  emailConsent: 'granted' | 'denied' | 'unset';
  emailDecisionDayKey: string | null;
  todayKey: string;
  // Server-authoritative opt-in status from the sms-opt-in edge function
  // (null when no row exists). 'pending' and 'confirmed' are a live
  // subscription in flight or active, so they must suppress the ask.
  serverStatus: string | null;
}

export function shouldShowSmsAsk({
  isActivated,
  demonstratedValue,
  dismissed,
  emailConsent,
  emailDecisionDayKey,
  todayKey,
  serverStatus,
}: SmsAskGateInputs): boolean {
  if (!isActivated || !demonstratedValue || dismissed) return false;
  if (emailConsent === 'unset' || !emailDecisionDayKey || todayKey <= emailDecisionDayKey) return false;
  if (serverStatus === 'pending' || serverStatus === 'confirmed') return false;
  return true;
}
