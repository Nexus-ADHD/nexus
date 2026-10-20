/**
 * NEX-86 sms-webhook — Twilio inbound + status callbacks (public endpoint).
 *
 * Deploy with --no-verify-jwt; authenticity is enforced by validating
 * X-Twilio-Signature against TWILIO_AUTH_TOKEN instead.
 *
 * Handles two Twilio payload shapes (form-encoded POST):
 *
 *   1. Status callback (MessageStatus + MessageSid present):
 *      update sms_send_log with delivery status, price, price_unit.
 *
 *   2. Inbound message (Body + From present):
 *      YES / CONFIRM        → pending → confirmed (double opt-in completes)
 *      STOP family          → any → stopped (Twilio also auto-blocks at the
 *                             number level; this keeps our state in sync)
 *      START / UNSTOP       → re-opt-in → confirmed
 *      HELP                 → reply with brand + support contact
 *
 * Twilio's default opt-out handling auto-replies to STOP/HELP keywords for
 * long codes; we return an empty TwiML response for those to avoid double
 * replies, and only send our own copy for YES (not a reserved keyword).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_AUTH_TOKEN,
 *      SMS_WEBHOOK_URL (optional canonical URL override for signature
 *      validation when behind a proxy that rewrites Host)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logSmsAttempt, validateTwilioSignature } from '../_shared/sms.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CANONICAL_URL =
  Deno.env.get('SMS_WEBHOOK_URL') ?? `${SUPABASE_URL}/functions/v1/sms-webhook`;

// Terminal delivery failures (NEX-319). `sent`/`queued`/`accepted` are still in
// flight and `delivered` succeeded, so none of those are audited as failures.
const FAILED_STATUSES = new Set(['failed', 'undelivered']);

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'UNSTOP']);
const YES_WORDS = new Set(['YES', 'Y', 'CONFIRM']);

const CONFIRMED_REPLY =
  'Nexus: Confirmed. Content updates will arrive at this number. ' +
  'Reply STOP to unsubscribe, HELP for help.';
// No HELP reply constant on purpose: HELP/INFO keywords defer to Twilio's
// auto-reply (configured in the Console), so ours would double up.

function twiml(message?: string): Response {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return new Response(body, { headers: { 'Content-Type': 'text/xml' } });
}

serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const form = await req.formData().catch(() => null);
  if (!form) return new Response('bad request', { status: 400 });
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const signature = req.headers.get('X-Twilio-Signature') ?? '';
  const valid = await validateTwilioSignature(CANONICAL_URL, params, signature);
  if (!valid) {
    console.error('sms-webhook: invalid Twilio signature');
    return new Response('forbidden', { status: 403 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Shape 1: delivery status callback ──────────────────────────────────────
  const messageStatus = params.MessageStatus ?? params.SmsStatus;
  if (messageStatus && params.MessageSid && !params.Body) {
    const update: Record<string, unknown> = {
      status: messageStatus,
      updated_at: new Date().toISOString(),
    };
    if (params.Price) {
      update.price = Math.abs(Number(params.Price));
      update.price_unit = params.PriceUnit ?? 'USD';
    }
    // NEX-319: Twilio only sends ErrorCode/ErrorMessage on a failed delivery, and
    // this is the one place they ever reach us. Without persisting them, a
    // `failed`/`undelivered` row says only THAT it failed, never why — which is
    // exactly how the 2026-06-24 send became undiagnosable.
    const errorCode = params.ErrorCode ? Number(params.ErrorCode) : null;
    const errorMessage = params.ErrorMessage ?? null;
    if (errorCode !== null && Number.isFinite(errorCode)) update.error_code = errorCode;
    if (errorMessage) update.error_message = errorMessage;

    const { error } = await admin
      .from('sms_send_log')
      .update(update)
      .eq('message_sid', params.MessageSid);
    if (error) console.error('sms-webhook: status update failed', error);

    // A terminal failure also lands in the append-only audit, so the reason
    // survives even if the ledger row is later released for retry.
    if (FAILED_STATUSES.has(messageStatus)) {
      await logSmsAttempt(admin, {
        phase: 'callback_failed',
        phoneNumber: params.To ?? '',
        messageSid: params.MessageSid,
        errorCode: errorCode !== null && Number.isFinite(errorCode) ? errorCode : null,
        errorMessage,
      });

      // NEX-322: if the dead message was an opt-in CONFIRMATION, flip the user's
      // row from 'pending' to 'expired'. Without this the row wedges at pending
      // forever (the real 2026-08-03 incident: STOP blocked the number at
      // Twilio, the confirmation failed delivery with 21610, and the user's
      // toggle sat uselessly "on" with no text ever arriving). 'expired'
      // renders like 'stopped' in Settings, so the user can simply re-tap.
      //
      // TWO compare-and-set guards, both required:
      //  1. still-pending: a row that has since confirmed (late YES, START) or
      //     stopped must not be dragged backwards by a late callback.
      //  2. same-attempt: opted_in_at is stamped when the pending row is
      //     written, moments BEFORE the confirmation is sent (and its send_log
      //     row created). A STALE callback — a failure for an EARLIER attempt's
      //     confirmation arriving after the user has re-opted — then has
      //     created_at < the current row's opted_in_at and must NOT expire the
      //     fresh attempt (its YES is still coming).
      const { data: sendRow, error: sendRowErr } = await admin
        .from('sms_send_log')
        .select('user_id, broadcast_key, created_at')
        .eq('message_sid', params.MessageSid)
        .maybeSingle();
      if (sendRowErr) console.error('sms-webhook: send-log lookup failed', sendRowErr);
      if (
        sendRow?.user_id &&
        typeof sendRow.broadcast_key === 'string' &&
        sendRow.broadcast_key.startsWith('optin-confirm:')
      ) {
        const { error: expireErr } = await admin
          .from('sms_opt_in')
          .update({ opt_in_status: 'expired', updated_at: new Date().toISOString() })
          .eq('user_id', sendRow.user_id)
          .eq('opt_in_status', 'pending')
          .lte('opted_in_at', sendRow.created_at);
        if (expireErr) console.error('sms-webhook: expire-on-failure update failed', expireErr);
      }
    }
    // 204 is a null-body status: passing ANY body, even '', makes the Response
    // constructor throw "Response with null body status cannot have body" and
    // the function 500s. Present since NEX-86 and invisible the whole time,
    // because the DB update above lands BEFORE the throw — so delivery status
    // was recorded while Twilio saw a 500, retried, and eventually gave up.
    // That is why a message could sit at 'queued' forever with no error.
    return new Response(null, { status: 204 });
  }

  // ── Shape 2: inbound message ───────────────────────────────────────────────
  const from = params.From ?? '';
  const keyword = (params.Body ?? '').trim().toUpperCase();
  if (!from) return twiml();

  const now = new Date().toISOString();

  if (STOP_WORDS.has(keyword)) {
    // NEX-321: scope to live rows. The partial unique index guarantees at most
    // one live (pending/confirmed) row per number, so this stops exactly the
    // current subscriber instead of re-stamping every historical row that ever
    // used the phone (the old cross-talk bug: two accounts sharing a number
    // both got stopped/confirmed by one person's keyword).
    const { error } = await admin
      .from('sms_opt_in')
      .update({ opt_in_status: 'stopped', stopped_at: now, updated_at: now })
      .eq('phone_number', from)
      .in('opt_in_status', ['pending', 'confirmed']);
    if (error) console.error('sms-webhook: STOP update failed', error);
    return twiml(); // Twilio default opt-out sends the unsubscribe confirmation
  }

  if (START_WORDS.has(keyword)) {
    // NEX-181: re-opt-in via the SMS keyword shows NO in-app disclosure, so we
    // intentionally carry forward the row's existing consent_version/consent_text
    // (the disclosure from the user's last in-app opt-in). The SMS keyword flow is
    // governed by Twilio's reserved-keyword copy, not the in-app disclosure. (An
    // append-only consent-event log that stamps each re-opt-in is a planned
    // follow-up; documented as acceptable for go-live.)
    //
    // NEX-321: pick the row to re-confirm by status, NOT by latest updated_at.
    // The NEX-321 dedupe migration stamps stopped loser rows with a FRESH
    // updated_at, so a naive latest-row lookup would resurrect a historical
    // account and (worse) displace the live subscriber. Rule: if a live row
    // exists for this number it IS the current subscription — a START from a
    // number whose subscriber never stopped must not transfer consent. Only
    // when nothing is live do we revive the most recently stopped row (the
    // normal "I texted STOP, now I want back in" case).
    const { data: live, error: liveErr } = await admin
      .from('sms_opt_in')
      .select('user_id')
      .eq('phone_number', from)
      .in('opt_in_status', ['pending', 'confirmed'])
      .maybeSingle();
    if (liveErr) {
      // Fail closed: a failed live lookup may be concealing a current
      // subscriber. Falling through to revive a stopped row could then
      // conflict with (or displace the meaning of) the live subscription.
      // Twilio retries nothing here, but the user can simply text START again.
      console.error('sms-webhook: START live lookup failed', liveErr);
      return twiml();
    }
    let targetUserId: string | undefined = live?.user_id;
    // Compare-and-set predicate for the update below: the row must still be in
    // the state we read. A START that raced a STOP/disable (row now 'stopped')
    // or any other newer transition then updates ZERO rows instead of
    // resurrecting consent after a newer opt-out committed.
    let expectLive = true;
    if (!targetUserId) {
      // Only a deliberately STOPPED subscription may be revived by START. An
      // 'expired' row is a pending opt-in whose confirmation never completed —
      // consent was never established, so a bare START must not confirm it.
      const { data: latestStopped, error: stoppedErr } = await admin
        .from('sms_opt_in')
        .select('user_id')
        .eq('phone_number', from)
        .eq('opt_in_status', 'stopped')
        .order('stopped_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (stoppedErr) console.error('sms-webhook: START stopped lookup failed', stoppedErr);
      targetUserId = latestStopped?.user_id;
      expectLive = false;
    }
    if (targetUserId) {
      // No steal-stop needed here: targetUserId is the live row when one
      // exists, and a stopped row only when nothing is live — so this update
      // can never conflict with the partial unique index on live rows.
      let update = admin
        .from('sms_opt_in')
        .update({ opt_in_status: 'confirmed', confirmed_at: now, stopped_at: null, updated_at: now })
        .eq('user_id', targetUserId);
      update = expectLive
        ? update.in('opt_in_status', ['pending', 'confirmed'])
        : update.eq('opt_in_status', 'stopped');
      const { error } = await update;
      if (error) console.error('sms-webhook: START update failed', error);
    }
    return twiml(); // Twilio default opt-out sends the resubscribe confirmation
  }

  if (keyword === 'HELP' || keyword === 'INFO') {
    return twiml(); // Twilio default opt-out replies; ours would double up.
  }

  if (YES_WORDS.has(keyword)) {
    const { data: rows, error } = await admin
      .from('sms_opt_in')
      .update({ opt_in_status: 'confirmed', confirmed_at: now, stopped_at: null, updated_at: now })
      .eq('phone_number', from)
      .eq('opt_in_status', 'pending')
      .select('user_id');
    if (error) {
      console.error('sms-webhook: YES update failed', error);
      return twiml();
    }
    if (rows && rows.length > 0) return twiml(CONFIRMED_REPLY);
    return twiml(); // No pending row for this number; stay silent.
  }

  // Anything else: log and stay silent (no two-way conversation in v1).
  console.log('sms-webhook: unhandled inbound', from, keyword.slice(0, 40));
  return twiml();
});
