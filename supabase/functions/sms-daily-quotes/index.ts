/**
 * NEX-323 sms-daily-quotes — Supabase Edge Function
 * ────────────────────────────────────────────────────────────────────
 * Fires every 15 minutes via pg_cron (see schedule.sql in this directory).
 *
 * Texts each confirmed SMS subscriber one wisdom quote in the morning and
 * one in the evening, at THEIR local notification-slot times
 * (user_state.state_data.notificationSettings, defaults 08:00 / 20:00 —
 * matching the app's own notification defaults).
 * A slot becomes due when its local start time passes and stays due for
 * SLOT_CATCH_UP_MINUTES (3h): the per-(slot, day) dedupe key makes every
 * cron tick a safe retry, so recipients deferred by the per-run cap or the
 * deadline recover on later ticks instead of missing the slot. The usual
 * case still sends on the first tick at/after the slot start.
 *
 * Quote source (user_state.state_data):
 *   morning → yesterday's recentWisdomHistory set
 *   evening → today's dailyWisdomQuotes (when dailyWisdomDate == today),
 *             else today's recentWisdomHistory set
 *   both    → fall back to the most recent recentWisdomHistory entry
 *
 * Auth: the x-scheduler-secret header is REQUIRED (same pattern as
 * weekly-summary-scheduler). This function is service-role backed and
 * triggers PAID sends, so the platform JWT gate alone (any signed-in user)
 * is not enough. Set once:
 *   supabase secrets set SMS_DAILY_QUOTES_SCHEDULER_SECRET=<random>
 * and register the cron with the same value (see schedule.sql).
 *
 * Kill switch (opt-IN, fails safe like NEX-319): unless
 * SMS_DAILY_QUOTES_ENABLED === 'true', returns 200 { skipped: 'disabled' }
 * without touching the DB.
 *
 * At-most-once: every send goes through sendBroadcastSmsOnce with
 * broadcast_key `daily-quote:<slot>:<localDate>`; the (broadcast_key,
 * user_id) unique index dedupes a cron retry or double-tick per user.
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SMS_DAILY_QUOTES_ENABLED
 *   SMS_DAILY_QUOTES_SCHEDULER_SECRET
 *   TWILIO_* (via _shared/sms.ts)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { sendBroadcastSmsOnce } from '../_shared/sms.ts';
import {
  composeQuoteBody,
  dueSlots,
  pickQuote,
  type UserStateData,
} from './pick.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Opt-IN flag. Anything but an explicit 'true' leaves the sender off, so an
// unset or typo'd secret fails safe (no unintended paid texts).
const SMS_DAILY_QUOTES_ENABLED =
  (Deno.env.get('SMS_DAILY_QUOTES_ENABLED') ?? '').toLowerCase() === 'true';
const SCHEDULER_SECRET = Deno.env.get('SMS_DAILY_QUOTES_SCHEDULER_SECRET') ?? '';

// Consent versions whose disclosure covers the daily cadence ("up to 2
// messages per day"). v1 promised only "frequency varies" and is NOT eligible.
// Keep in sync with KNOWN_CONSENT_VERSIONS in sms-opt-in/index.ts.
const DAILY_CONSENT_VERSIONS = new Set<string>(['nex323-2026-08-03-v2']);

const SMS_SEND_INTERVAL_MS = 1100;    // 1 MPS sole-prop A2P cap, with margin
// Capacity math (Greptile): N sends cost N × (interval + per-send overhead
// ≈ 1.1s + 0.4s), so 75 × 1.5s ≈ 113s fits safely under the deadline. The
// cap does NOT lose recipients: a slot stays due for SLOT_CATCH_UP_MINUTES
// and the dedupe key makes every later tick a safe retry, so anyone deferred
// by the cap/deadline is caught by a subsequent tick.
const SMS_MAX_PER_RUN      = 75;      // hard cap so one run fits one invocation
const SMS_DEADLINE_MS      = 130_000; // stop the loop before the ~150s wall

const smsSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getServiceRoleClient() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // Service-role + paid sends: the platform JWT gate is not enough. Require
    // the scheduler shared secret before touching anything.
    if (!SCHEDULER_SECRET || req.headers.get('x-scheduler-secret') !== SCHEDULER_SECRET) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!SMS_DAILY_QUOTES_ENABLED) {
      console.log('[sms-daily-quotes] skipped: SMS_DAILY_QUOTES_ENABLED is not set');
      return new Response(JSON.stringify({ skipped: 'disabled', sent: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: 'SERVICE_ROLE_KEY not set' }), { status: 500 });
    }

    const admin = await getServiceRoleClient();
    const statusCallback = `${SUPABASE_URL}/functions/v1/sms-webhook`;

    // Confirmed opt-ins whose recorded consent covers the DAILY cadence.
    // TCPA: the v1 disclosure promised only "frequency varies" (in practice
    // roughly weekly) — sending 2/day under it would exceed the consent. Only
    // v2 ("up to 2 messages per day") and later are eligible; v1 users become
    // eligible by re-toggling SMS on a build that shows the v2 disclosure,
    // which re-stamps consent_version. Re-checked per-recipient at send time.
    const { data: optIns, error: optErr } = await admin
      .from('sms_opt_in')
      .select('user_id, phone_number')
      .eq('opt_in_status', 'confirmed')
      .in('consent_version', [...DAILY_CONSENT_VERSIONS]);
    if (optErr) throw new Error(`sms_opt_in query failed: ${optErr.message}`);

    const now = new Date();
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let remaining = 0;
    const errors: string[] = [];
    const startedAt = Date.now();
    const queue = optIns ?? [];

    for (let i = 0; i < queue.length; i++) {
      if (sent >= SMS_MAX_PER_RUN || Date.now() - startedAt > SMS_DEADLINE_MS) {
        remaining = queue.length - i;
        console.warn(`[sms-daily-quotes] stopping early; ${remaining} remaining (recover on re-run)`);
        break;
      }
      const o = queue[i];

      // Slot check: read their user_state and see if a slot is DUE (started
      // within the catch-up span and not yet sent — the dedupe key makes
      // every tick a safe retry, so cap/deadline deferrals recover on later
      // ticks). Missing state/tz/quote all skip silently (debug-level).
      const { data: stateRow, error: stateErr } = await admin
        .from('user_state')
        .select('state_data')
        .eq('user_id', o.user_id)
        .maybeSingle();
      if (stateErr) {
        console.debug('[sms-daily-quotes] user_state read failed, skipping', o.user_id, stateErr.message);
        skipped++;
        continue;
      }
      const state = (stateRow?.state_data ?? {}) as UserStateData;

      const matches = dueSlots(now, state);
      if (matches.length === 0) continue; // no slot due right now — the common case

      // STOP at send time: re-read this user's status AND consent version
      // right before sending — a STOP (or a consent change) arriving mid-run
      // is still honored. Once per user per tick, before any of their slots.
      const { data: fresh, error: freshErr } = await admin
        .from('sms_opt_in')
        .select('opt_in_status, consent_version')
        .eq('user_id', o.user_id)
        .single();
      if (
        freshErr || !fresh ||
        fresh.opt_in_status !== 'confirmed' ||
        !DAILY_CONSENT_VERSIONS.has(fresh.consent_version ?? '')
      ) {
        skipped++;
        continue;
      }

      // EVERY due slot is attempted in turn: after the morning send reserves,
      // an 'already' must fall through to an overlapping evening slot in the
      // same tick — otherwise overlapping slots starve the evening send and
      // identical slot times would never send it at all.
      for (const match of matches) {
        if (sent >= SMS_MAX_PER_RUN || Date.now() - startedAt > SMS_DEADLINE_MS) break;
        console.debug(`[sms-daily-quotes] slot ${match.slot} due for ${o.user_id} (${match.dateKey})`);

        const picked = pickQuote(state, match.slot, match.dateKey);
        if (!picked) {
          console.debug('[sms-daily-quotes] no quote available, skipping', o.user_id, match.slot);
          skipped++;
          continue;
        }
        const body = composeQuoteBody(picked.quote, picked.author);
        const broadcastKey = `daily-quote:${match.slot}:${match.dateKey}`;

        // Reserve-before-send: the unique index prevents a concurrent run's
        // duplicate paid text rather than only detecting it after the fact.
        const outcome = await sendBroadcastSmsOnce(admin, {
          to: o.phone_number, userId: o.user_id, broadcastKey, body, statusCallback,
        });

        if (outcome.kind === 'already') {
          skipped++;
          continue; // no Twilio call happened — try the next due slot
        }
        if (outcome.kind === 'reserve_failed') {
          failed++;
          errors.push(`${o.user_id}: reserve failed ${outcome.error}`);
          console.error('[sms-daily-quotes] reserve failed', o.user_id, outcome.error);
          continue;
        }
        if (outcome.kind === 'send_failed') {
          failed++;
          errors.push(`${o.user_id}: ${outcome.errorCode ?? ''} ${outcome.errorMessage ?? 'unknown'}`);
          console.error('[sms-daily-quotes] send failed', o.user_id, outcome.errorCode, outcome.errorMessage);
          await smsSleep(SMS_SEND_INTERVAL_MS);
          continue;
        }

        // sent
        sent++;
        const nowIso = new Date().toISOString();
        const { error: updErr } = await admin
          .from('sms_opt_in')
          .update({ last_sms_sent_at: nowIso, updated_at: nowIso })
          .eq('user_id', o.user_id);
        if (updErr) console.error('[sms-daily-quotes] last_sms_sent_at update failed', o.user_id, updErr.message);

        await smsSleep(SMS_SEND_INTERVAL_MS); // pace after every paid send
      } // per due slot
    } // per recipient

    console.log(`[sms-daily-quotes] Done. Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}, Remaining: ${remaining}`);

    return new Response(
      JSON.stringify({ sent, skipped, failed, remaining, errors }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    console.error('[sms-daily-quotes] Fatal error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
