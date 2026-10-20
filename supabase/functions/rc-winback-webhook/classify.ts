/**
 * NEX-323 (C6) — pure classification of a RevenueCat webhook event into the
 * win-back action it warrants. No I/O, no env — fully deno-testable.
 *
 * Takes the UNWRAPPED `event` object: RC webhook bodies are
 * `{ api_version, event: { id, type, app_user_id, ... } }` and `index.ts`
 * unwraps once before calling.
 *
 * Split strictly on the C0 taxonomy: only VOLuntary cancels
 * (`cancel_reason = UNSUBSCRIBE`) get messaged. A BILLING_ERROR/dunning user
 * is never messaged as if they rejected.
 *
 * Safe direction is always UNDER-send: any missing/ambiguous field → ignore.
 *
 * Spec: docs/plans/nex-323-cancel-winback.md (S1–S7).
 */

export const ENTITLEMENT_ID = 'Nexus Pro';

export type WinbackKind = 'trial_cancel_value' | 'lapsed_offer';

export interface Classification {
  action: WinbackKind | 'ignore';
  reason: string;
}

/** The subset of the RC webhook event object this classifier reads. */
export interface RcWebhookEvent {
  type?: string;
  period_type?: string;
  cancel_reason?: string;
  expiration_reason?: string;
  entitlement_ids?: string[] | null;
}

function isTrial(periodType: string | undefined): boolean | null {
  if (!periodType) return null; // absent — caller treats as unknown, not false
  return periodType.toLowerCase() === 'trial';
}

export function classifyRcEvent(event: RcWebhookEvent | null | undefined): Classification {
  if (!event || typeof event.type !== 'string' || event.type.length === 0) {
    return { action: 'ignore', reason: 'no_event_type' };
  }

  // Only events about OUR entitlement. entitlement_ids is always present on RC
  // subscriber events; treat its absence as unknown → under-send (S7).
  if (!Array.isArray(event.entitlement_ids) || !event.entitlement_ids.includes(ENTITLEMENT_ID)) {
    return { action: 'ignore', reason: 'wrong_or_missing_entitlement' };
  }

  const trial = isTrial(event.period_type);
  if (trial === null) {
    return { action: 'ignore', reason: 'missing_period_type' };
  }

  if (event.type === 'CANCELLATION') {
    // (a) still-in-trial voluntary canceller. period_type stays TRIAL at the
    // cancel moment — access runs until expiration. A NORMAL canceller is a
    // paid user (out of scope), BILLING_ERROR is dunning (never message as
    // rejection).
    if (event.cancel_reason !== 'UNSUBSCRIBE') {
      return { action: 'ignore', reason: 'involuntary_cancel' };
    }
    if (!trial) {
      return { action: 'ignore', reason: 'paid_canceller_out_of_scope' };
    }
    return { action: 'trial_cancel_value', reason: 'voluntary_trial_cancel' };
  }

  if (event.type === 'EXPIRATION') {
    // (b) lapsed-without-conversion. A converting trial never emits a
    // trial-period EXPIRATION, so period_type=TRIAL here means the trial
    // ended without conversion by construction. PROMOTIONAL expirations (the
    // free month itself lapsing) are ignored — no offer loop, ever (S6b).
    if (event.expiration_reason !== 'UNSUBSCRIBE') {
      return { action: 'ignore', reason: 'involuntary_expiration' };
    }
    if (!trial) {
      return { action: 'ignore', reason: 'non_trial_expiration' };
    }
    return { action: 'lapsed_offer', reason: 'trial_expired_unconverted' };
  }

  return { action: 'ignore', reason: 'event_type_ignored' };
}
