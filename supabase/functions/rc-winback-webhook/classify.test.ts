/**
 * NEX-323 (C6) — pins the rc-winback-webhook event classification (S1–S7).
 *
 * Run: deno test --allow-import supabase/functions/rc-winback-webhook/
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { classifyRcEvent, ENTITLEMENT_ID, type RcWebhookEvent } from './classify.ts';

const base = (over: Partial<RcWebhookEvent> = {}): RcWebhookEvent => ({
  entitlement_ids: [ENTITLEMENT_ID],
  ...over,
});

// S1 — still-in-trial voluntary canceller → value email
Deno.test('S1: CANCELLATION + UNSUBSCRIBE + TRIAL → trial_cancel_value', () => {
  for (const pt of ['TRIAL', 'Trial', 'trial']) {
    const r = classifyRcEvent(base({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', period_type: pt }));
    assertEquals(r.action, 'trial_cancel_value', `period_type=${pt}`);
  }
});

// S2 — dunning / other cancel reasons are never messaged as rejection
Deno.test('S2: CANCELLATION + non-voluntary reasons → ignore', () => {
  for (const reason of ['BILLING_ERROR', 'CUSTOMER_SUPPORT', 'PRICE_INCREASE', 'PRODUCT_NOT_AVAILABLE', 'UNKNOWN']) {
    const r = classifyRcEvent(base({ type: 'CANCELLATION', cancel_reason: reason, period_type: 'TRIAL' }));
    assertEquals(r, { action: 'ignore', reason: 'involuntary_cancel' }, `cancel_reason=${reason}`);
  }
});

// S3 — paid (NORMAL) canceller is out of scope
Deno.test('S3: CANCELLATION + UNSUBSCRIBE + NORMAL → ignore', () => {
  const r = classifyRcEvent(base({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', period_type: 'NORMAL' }));
  assertEquals(r, { action: 'ignore', reason: 'paid_canceller_out_of_scope' });
});

// S4 — trial expired without conversion → time-boxed offer
Deno.test('S4: EXPIRATION + UNSUBSCRIBE + TRIAL → lapsed_offer', () => {
  const r = classifyRcEvent(base({ type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE', period_type: 'TRIAL' }));
  assertEquals(r.action, 'lapsed_offer');
});

// S5 — involuntary or paid expiration → ignore
Deno.test('S5: EXPIRATION + BILLING_ERROR or NORMAL → ignore', () => {
  assertEquals(
    classifyRcEvent(base({ type: 'EXPIRATION', expiration_reason: 'BILLING_ERROR', period_type: 'TRIAL' })),
    { action: 'ignore', reason: 'involuntary_expiration' },
  );
  assertEquals(
    classifyRcEvent(base({ type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE', period_type: 'NORMAL' })),
    { action: 'ignore', reason: 'non_trial_expiration' },
  );
});

// S6 — every other event type → ignore
Deno.test('S6: INITIAL_PURCHASE / RENEWAL / TEST etc → ignore', () => {
  for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'TEST', 'NON_RENEWING_PURCHASE', 'UNCANCELLATION']) {
    const r = classifyRcEvent(base({ type, period_type: 'TRIAL', cancel_reason: 'UNSUBSCRIBE' }));
    assertEquals(r, { action: 'ignore', reason: 'event_type_ignored' }, `type=${type}`);
  }
});

// S6b — the free month itself lapsing must never retrigger an offer (no loop)
Deno.test('S6b: EXPIRATION + PROMOTIONAL → ignore (no offer loop)', () => {
  const r = classifyRcEvent(base({ type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE', period_type: 'PROMOTIONAL' }));
  assertEquals(r, { action: 'ignore', reason: 'non_trial_expiration' });
});

// S7 — missing period_type or wrong/missing entitlement → ignore (under-send)
Deno.test('S7: missing period_type or entitlement → ignore', () => {
  assertEquals(
    classifyRcEvent(base({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' })),
    { action: 'ignore', reason: 'missing_period_type' },
  );
  assertEquals(
    classifyRcEvent({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', period_type: 'TRIAL' }),
    { action: 'ignore', reason: 'wrong_or_missing_entitlement' },
  );
  assertEquals(
    classifyRcEvent(base({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', period_type: 'TRIAL', entitlement_ids: ['Other Entitlement'] })),
    { action: 'ignore', reason: 'wrong_or_missing_entitlement' },
  );
});

Deno.test('malformed events → ignore, never throw', () => {
  assertEquals(classifyRcEvent(null).action, 'ignore');
  assertEquals(classifyRcEvent(undefined).action, 'ignore');
  assertEquals(classifyRcEvent({}).action, 'ignore');
});
