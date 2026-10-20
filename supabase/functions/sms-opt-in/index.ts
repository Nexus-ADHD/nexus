/**
 * NEX-86 sms-opt-in — user-facing consent endpoint (JWT-authed).
 *
 * POST { action: 'enable' | 'disable' | 'status' }
 *
 *   enable  → upsert sms_opt_in row as 'pending' from user_profile.phone_number
 *             and send the double-opt-in confirmation SMS (Reply YES).
 *   disable → set opt_in_status 'stopped'.
 *   status  → return the current opt-in row (or null).
 *
 * Consent transitions are server-authoritative: the client never writes
 * sms_opt_in directly (no RLS write policies). The YES confirmation itself
 * arrives via Twilio inbound webhook (see sms-webhook).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *      TWILIO_* (see _shared/sms.ts)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logSmsAttempt, sendSms } from '../_shared/sms.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CONFIRM_SMS =
  'Nexus: Reply YES to confirm daily quotes and content updates by text. ' +
  'Msg & data rates may apply. Up to 2 msgs/day. ' +
  'Reply STOP to unsubscribe, HELP for help.';

// NEX-181: consent audit fields. The version is server-validated against this
// allowlist so we never persist an arbitrary client string as "evidence"; bump
// it here whenever SMS_CONSENT_VERSION changes in settings-screen.tsx. The
// verbatim text the client rendered is the audit-of-record, length-capped to
// bound abuse. NEX-323: v1 stays allowed — builds older than the v2 copy still
// opt in with the old version id, and their recorded consent text is accurate
// for what those users saw.
const KNOWN_CONSENT_VERSIONS = new Set<string>([
  'nex181-2026-06-23-v1',
  'nex323-2026-08-03-v2',
]);
const CONSENT_TEXT_MAX = 1000;

function sanitizeConsent(
  version: unknown,
  text: unknown,
): { consent_version: string | null; consent_text: string | null } {
  return {
    consent_version:
      typeof version === 'string' && KNOWN_CONSENT_VERSIONS.has(version) ? version : null,
    consent_text:
      typeof text === 'string' && text.length > 0 && text.length <= CONSENT_TEXT_MAX ? text : null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// 2026-10-18 SMS pumping guard (see the enable path).
const CONFIRM_LIMITS = { perUserDay: 3, perPhoneDay: 3, globalHour: 60 };

async function countConfirmations(
  admin: SupabaseClient,
  sinceIso: string,
  filter: { userId?: string; phone?: string },
): Promise<number> {
  let total = 0;
  for (const table of ['sms_send_log', 'sms_send_attempt_log'] as const) {
    let q = admin
      .from(table)
      .select('broadcast_key', { count: 'exact', head: true })
      .like('broadcast_key', filter.userId ? `optin-confirm:${filter.userId}:%` : 'optin-confirm:%')
      .gte('created_at', sinceIso);
    if (filter.phone) q = q.eq('phone_number', filter.phone);
    if (table === 'sms_send_attempt_log') q = q.eq('phase', 'ambiguous');
    const { count, error } = await q;
    // Fail CLOSED: if we cannot count, we cannot prove the send is safe.
    if (error) throw new Error(`confirmation count failed: ${error.message}`);
    total += count ?? 0;
  }
  return total;
}

async function confirmationLimitHit(
  admin: SupabaseClient,
  userId: string,
  phone: string,
): Promise<string | null> {
  const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const hour = new Date(Date.now() - 3600 * 1000).toISOString();
  try {
    if ((await countConfirmations(admin, day, { userId })) >= CONFIRM_LIMITS.perUserDay) return 'account_daily';
    if ((await countConfirmations(admin, day, { phone })) >= CONFIRM_LIMITS.perPhoneDay) return 'number_daily';
    if ((await countConfirmations(admin, hour, {})) >= CONFIRM_LIMITS.globalHour) return 'global_hourly';
    return null;
  } catch (e) {
    console.error('sms-opt-in rate-limit check failed', e instanceof Error ? e.message : String(e));
    return 'check_unavailable';
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Resolve the calling user from their JWT.
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { action, consentVersion, consentText } = await req
    .json()
    .catch(() => ({ action: null }));

  if (action === 'status') {
    // A lookup failure must NOT be masked as "no subscription" — the client
    // (NEX-321 opt-in sheet) treats optIn:null as safe-to-ask, so reporting
    // null on a DB error would surface the consent prompt precisely when we
    // cannot know the user's current state. Fail loudly instead; the sheet
    // stays hidden on any non-2xx.
    const { data, error } = await admin
      .from('sms_opt_in')
      .select('opt_in_status, phone_number, confirmed_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('sms-opt-in status lookup failed', error);
      return json({ error: 'status_lookup_failed' }, 500);
    }
    return json({ optIn: data ?? null });
  }

  if (action === 'enable') {
    const { data: profile } = await admin
      .from('user_profile')
      .select('phone_number')
      .eq('user_id', userId)
      .maybeSingle();
    const phone = profile?.phone_number;
    if (!phone) return json({ error: 'phone_required' }, 400);

    // Already confirmed or pending on the same number: nothing to do.
    // The pending guard matters for TCPA hygiene — re-tapping the toggle
    // before replying YES must not fire a duplicate confirmation SMS.
    // Full snapshot of the pre-existing row — used both for the pending guard
    // and to roll back if the confirmation SMS fails to send (see below).
    const { data: existing } = await admin
      .from('sms_opt_in')
      .select(
        'opt_in_status, phone_number, opted_in_at, confirmed_at, stopped_at, consent_version, consent_text',
      )
      .eq('user_id', userId)
      .maybeSingle();
    if (
      (existing?.opt_in_status === 'confirmed' || existing?.opt_in_status === 'pending') &&
      existing.phone_number === phone
    ) {
      return json({ optIn: { opt_in_status: existing.opt_in_status } });
    }

    const now = new Date().toISOString();
    // NEX-321: one live subscription per phone (partial unique index). If the
    // live row belongs to ANOTHER account, refuse — do NOT steal it. The
    // profile phone number is unverified at this point (possession is only
    // proven when the YES reply arrives), so stealing here would let any
    // signed-in user kill someone else's subscription just by typing their
    // number. The legitimate path when a number has really changed hands:
    // text STOP from the phone itself (proves possession, stops the old row),
    // then enable here.
    const { data: otherLive, error: otherLiveErr } = await admin
      .from('sms_opt_in')
      .select('user_id')
      .eq('phone_number', phone)
      .neq('user_id', userId)
      .in('opt_in_status', ['pending', 'confirmed'])
      .maybeSingle();
    if (otherLiveErr) {
      console.error('sms-opt-in live-phone lookup failed', otherLiveErr);
      return json({ error: 'opt_in_write_failed' }, 500);
    }
    if (otherLive) return json({ error: 'phone_in_use' }, 409);

    // 2026-10-18: SMS pumping guard. Every enable on a stopped/changed number
    // sends a paid confirmation text, and nothing limited how often, so a
    // script could cycle enable/disable (or rotate numbers) to run up the
    // Twilio bill. Cap confirmations per account and per number per 24 h, plus
    // a project-wide hourly ceiling. Counts both logged sends and ambiguous
    // attempts (a lost response may still have been delivered).
    const limited = await confirmationLimitHit(admin, userId, phone);
    if (limited) return json({ error: 'too_many_confirmations', limit: limited }, 429);
    // NEX-181: capture the disclosure the user agreed to (server-validated version
    // + verbatim text). A new opt-in always re-stamps these; a legacy/stopped row
    // re-opting in here correctly records the CURRENT disclosure it just showed.
    const consent = sanitizeConsent(consentVersion, consentText);
    const { error: upsertErr } = await admin.from('sms_opt_in').upsert({
      user_id: userId,
      phone_number: phone,
      opt_in_status: 'pending',
      opt_in_method: 'double-opt-in',
      opted_in_at: now,
      confirmed_at: null,
      stopped_at: null,
      consent_version: consent.consent_version,
      consent_text: consent.consent_text,
      updated_at: now,
    });
    if (upsertErr) {
      console.error('sms-opt-in upsert failed', upsertErr);
      return json({ error: 'opt_in_write_failed' }, 500);
    }

    // NEX-319: the confirmation text is the single most important message in the
    // funnel and used to be sent blind — no status callback, no log row — so a
    // confirmation that never arrived left the user wedged at `pending` with no
    // evidence anywhere. The key is per-ATTEMPT, never per-user: the NEX-185
    // unique index on (broadcast_key, user_id) would otherwise make a per-user
    // key a permanent one-shot, locking out anyone who legitimately re-opts in
    // after a STOP or a phone-number change.
    const confirmKey = `optin-confirm:${userId}:${crypto.randomUUID()}`;
    const statusCallback = `${SUPABASE_URL}/functions/v1/sms-webhook`;

    // sendSms wraps fetch(), which THROWS on a network failure. Unguarded, that
    // threw straight out of the handler: the 500 skipped the rollback below, the
    // row stayed `pending`, and the same-phone pending guard then short-circuited
    // every future re-tap — a permanent lockout with nothing recorded anywhere.
    //
    // The failure direction here is deliberately the OPPOSITE of
    // sendBroadcastSmsOnce, which keeps its reservation on an ambiguous throw to
    // avoid re-sending a paid broadcast. That asymmetry is the point: a duplicate
    // confirmation text is a minor annoyance and replying YES once still works,
    // whereas a stuck `pending` row is unrecoverable without operator action. So
    // an ambiguous confirmation rolls back and lets the user try again.
    // Rollback helper for every post-upsert failure path. Rolls the row back
    // so the pending guard above doesn't wedge the retry: without this, the
    // row stays 'pending' and every re-tap short-circuits to 200 without ever
    // sending a confirmation SMS. The rollback is scoped to `opted_in_at: now`
    // — the marker this request wrote — so a concurrent enable that changed
    // the row in the meantime is left untouched (the rollback then no-ops,
    // which is intentional and benign: the row belongs to the newer attempt,
    // which sends its own confirmation SMS).
    const rollbackPending = async () => {
      const restore = existing
        ? admin
            .from('sms_opt_in')
            .update({
              opt_in_status: existing.opt_in_status,
              phone_number: existing.phone_number,
              opted_in_at: existing.opted_in_at,
              confirmed_at: existing.confirmed_at,
              stopped_at: existing.stopped_at,
              // NEX-181: restore the PRIOR consent fields too — otherwise a failed
              // re-opt-in leaves the new version/text stamped on a row reverted to
              // its old status, i.e. false consent evidence.
              consent_version: existing.consent_version,
              consent_text: existing.consent_text,
              updated_at: now,
            })
            .eq('user_id', userId)
            .eq('opted_in_at', now)
            // CAS: only roll back a row that is STILL pending. The YES webhook
            // confirms without touching opted_in_at, so without this predicate
            // a late failure path could revert an already-completed consent.
            .eq('opt_in_status', 'pending')
        : admin
            .from('sms_opt_in')
            .delete()
            .eq('user_id', userId)
            .eq('opted_in_at', now)
            .eq('opt_in_status', 'pending');
      const { error: rollbackErr } = await restore;
      if (rollbackErr) {
        // The send already failed; if the rollback write also fails the row may
        // stay 'pending' (a true fix needs a DB transaction — out of scope).
        // Log loudly so it's diagnosable; still surface the original failure.
        console.error('sms-opt-in rollback after failure also failed', rollbackErr);
      }
    };

    let sent: Awaited<ReturnType<typeof sendSms>>;
    let threw = false;
    try {
      sent = await sendSms(phone, CONFIRM_SMS, statusCallback);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error('sms-opt-in confirm send threw', errorMessage);
      threw = true;
      await logSmsAttempt(admin, {
        phase: 'ambiguous',
        phoneNumber: phone,
        userId,
        broadcastKey: confirmKey,
        errorMessage,
      });
      sent = { ok: false, errorMessage };
    }
    if (sent.ok && sent.sid) {
      const { error: logErr } = await admin.from('sms_send_log').insert({
        user_id: userId,
        phone_number: phone,
        message_sid: sent.sid,
        broadcast_key: confirmKey,
        body_preview: CONFIRM_SMS.slice(0, 160),
        segments: sent.numSegments,
        status: sent.status,
      });
      if (logErr) {
        // NEX-322: the send_log row is what lets a failed DELIVERY callback
        // find and expire this pending row (see sms-webhook). Without it the
        // user wedges at pending with no in-app retry if the text dies at the
        // carrier. Logging is observability, but consent recoverability is
        // consent — so a failed log write rolls the attempt back and the user
        // simply re-taps. Accepted edge: if the text DID deliver and the user
        // replies YES after the rollback, the YES no-ops (no pending row) and
        // re-tapping sends a fresh confirmation.
        console.error('sms-opt-in: confirm log insert failed', logErr.message);
        await logSmsAttempt(admin, {
          phase: 'log_write_failed',
          phoneNumber: phone,
          userId,
          broadcastKey: confirmKey,
          errorMessage: logErr.message,
        });
        await rollbackPending();
        return json({ error: 'confirm_log_failed' }, 502);
      }
    }
    if (!sent.ok) {
      console.error('sms-opt-in confirm send failed', sent.errorCode, sent.errorMessage);
      // A throw already recorded itself as `ambiguous` above; only a definitive
      // Twilio rejection is logged here, so one attempt never writes two rows.
      if (!threw) {
        await logSmsAttempt(admin, {
          phase: 'create_failed',
          phoneNumber: phone,
          userId,
          broadcastKey: confirmKey,
          errorCode: sent.errorCode,
          errorMessage: sent.errorMessage,
        });
      }
      // Roll the row back so the pending guard above doesn't wedge the retry.
      await rollbackPending();
      return json({ error: 'confirm_send_failed' }, 502);
    }
    return json({ optIn: { opt_in_status: 'pending' } });
  }

  if (action === 'disable') {
    const now = new Date().toISOString();
    const { error: updErr } = await admin
      .from('sms_opt_in')
      .update({ opt_in_status: 'stopped', stopped_at: now, updated_at: now })
      .eq('user_id', userId);
    if (updErr) {
      console.error('sms-opt-in disable failed', updErr);
      return json({ error: 'opt_out_write_failed' }, 500);
    }
    return json({ optIn: { opt_in_status: 'stopped' } });
  }

  return json({ error: 'unknown_action' }, 400);
});
