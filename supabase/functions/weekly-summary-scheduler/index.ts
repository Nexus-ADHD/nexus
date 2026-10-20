/**
 * Nexus Weekly Summary Scheduler — Supabase Edge Function
 * ────────────────────────────────────────────────────────────────────
 * pg_cron runs this once per day (~9am ET). For every user whose persisted
 * state opts into weekly summaries AND whose configured day == today (ET), it
 * recomputes the weekly digest server-side and sends it via Resend. This makes
 * the weekly email reliable regardless of whether the user opens the app —
 * replacing the old client-only, startup-race-dependent trigger.
 *
 * Modeled on email-scheduler/index.ts:
 *   - service-role read of user data
 *   - nexus_email_log for idempotency (alreadySent / logEmailSent)
 *   - safe to run multiple times; safe to call directly for testing
 *
 * Data sources:
 *   - user_state.state_data — recurringRules, habitLog, habitStreaks,
 *     dailyScores/scoreHistory, weeklyEmailEnabled, weeklyEmailDay, userProfile.
 *   - nexus_profiles — email + name. (UserProfile in state_data has NO email,
 *     so the address must come from here; joined on user_id.)
 *
 * Idempotency key is WEEK-SCOPED: `weekly_summary_<ISO week>`, e.g.
 *   weekly_summary_2026-W22
 * A static key would block every future week after the first send — the
 * easiest thing to get wrong. ISO week is computed in ET (see weekly-digest.ts).
 *
 * Timezone: ET (America/New_York), matching email-scheduler's 9am-ET cadence.
 *
 * Manual / dry-run testing (no waiting for cron):
 *   POST with JSON body:
 *     { "dryRun": true }            → compute + return payloads, send NOTHING
 *     { "force": true }             → ignore the day-of-week gate (still sends)
 *     { "userId": "<uuid>" }        → limit to one user (combine with dryRun)
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
 *   WEEKLY_SCHEDULER_SECRET (shared secret the cron sends in x-scheduler-secret)
 *
 * Deploy (from merged main only): supabase functions deploy weekly-summary-scheduler
 * Crontab (Supabase SQL editor) — canonical copy lives in schedule.sql; the
 * x-scheduler-secret header is REQUIRED (the function authorizes on it):
 *   SELECT cron.schedule(
 *     'nexus-daily-weekly-summary',
 *     '0 13 * * *',   -- every day at 13:00 UTC ≈ 9 AM ET; the function gates
 *                     -- per-user on weeklyEmailDay so only the right users send
 *     $$
 *     SELECT net.http_post(
 *       url := '<SUPABASE_URL>/functions/v1/weekly-summary-scheduler',
 *       headers := jsonb_build_object(
 *         'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
 *         'x-scheduler-secret', '<WEEKLY_SCHEDULER_SECRET>',
 *         'Content-Type', 'application/json'
 *       ),
 *       body := jsonb_build_object('run_type', 'scheduled')
 *     );
 *     $$
 *   );
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  buildWeeklyDigestPayload,
  isoWeekKey,
  weeklyEmailDueToday,
} from '../_shared/weekly-digest.ts';
import { sendWeeklySummaryEmail } from '../_shared/weekly-summary-email.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY    = Deno.env.get('RESEND_API_KEY') ?? '';
// Dedicated shared secret that authorizes callers (the pg_cron job sends it in
// the x-scheduler-secret header). Set once: supabase secrets set
// WEEKLY_SCHEDULER_SECRET=<random>; reference the same value in schedule.sql.
const SCHEDULER_SECRET  = Deno.env.get('WEEKLY_SCHEDULER_SECRET') ?? '';

interface RunResult {
  user_id: string;
  email?: string;
  email_key?: string;
  sent: boolean;
  skipped?: string;   // reason when not sent
  dryRun?: boolean;
  error?: string;
  logError?: string;  // email sent but the idempotency-ledger write failed
  preview?: { completionRate: number; longestStreakDays: number; disciplineScoreAvg: number };
}

async function getServiceRoleClient() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

async function alreadySent(sb: any, userId: string, emailKey: string): Promise<boolean> {
  // .maybeSingle() returns { data: null } for zero rows WITHOUT erroring (unlike
  // .single(), which errors PGRST116). Surface any real error instead of
  // swallowing it — a transient DB failure read as "not sent" would risk a
  // duplicate send.
  const { data, error } = await sb
    .from('nexus_email_log')
    .select('id')
    .eq('user_id', userId)
    .eq('email_key', emailKey)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`nexus_email_log check failed: ${error.message}`);
  return !!data;
}

async function logEmailSent(sb: any, userId: string, emailKey: string, messageId: string): Promise<void> {
  const { error } = await sb.from('nexus_email_log').upsert({
    user_id:    userId,
    email_key:  emailKey,
    sent_at:    new Date().toISOString(),
    message_id: messageId,
  }, { onConflict: 'user_id,email_key' });
  // The Supabase client returns { error } rather than throwing. The email has
  // already been delivered by the time we get here, so a dropped ledger row
  // means next cron's alreadySent() returns false and the user is re-emailed.
  // Surface it (mirrors alreadySent) so the caller can record/alert.
  if (error) throw new Error(`nexus_email_log write failed: ${error.message}`);
}

/**
 * Constant-time string compare. Iterates over a fixed length (the secret) and
 * folds the length difference into the accumulator instead of early-returning on
 * mismatched lengths — an early length check would leak the secret's length via
 * timing. `provided` is the caller-supplied value, `secret` the expected one.
 */
function timingSafeEqual(provided: string, secret: string): boolean {
  let diff = provided.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) {
    diff |= secret.charCodeAt(i) ^ (i < provided.length ? provided.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/**
 * Authorize the caller via a dedicated shared secret carried in the
 * `x-scheduler-secret` header (the pg_cron job sends it; see schedule.sql).
 *
 * Why a shared secret rather than inspecting the bearer token:
 *  - Decoding a JWT's `role` claim is forgeable unless verify_jwt is on, so it
 *    made the gate's safety depend on an un-auditable deploy flag (#64 P1).
 *  - String-matching SUPABASE_SERVICE_ROLE_KEY broke because Supabase's newer
 *    API-key system injects a value that no longer byte-matches the dashboard
 *    key the cron sends (the original 403).
 * A secret we own sidesteps both: it's safe regardless of verify_jwt, and it
 * doesn't care about Supabase's key format (legacy JWT vs new sb_secret_…).
 * App users never see this secret, so they're rejected. Compared in constant
 * time. Fails closed if the secret isn't configured.
 */
function isAuthorizedCaller(req: Request): boolean {
  if (!SCHEDULER_SECRET) return false;
  const provided = (req.headers.get('x-scheduler-secret') ?? '').trim();
  return provided.length > 0 && timingSafeEqual(provided, SCHEDULER_SECRET);
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), { status: 500 });
    }
    if (!SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }), { status: 500 });
    }
    if (!SCHEDULER_SECRET) {
      return new Response(JSON.stringify({ error: 'WEEKLY_SCHEDULER_SECRET not configured' }), { status: 500 });
    }

    // Caller auth: only the pg_cron job (which knows WEEKLY_SCHEDULER_SECRET) may
    // invoke this. Without this gate a signed-in app user who knows the URL could
    // POST {force:true} to blast every opted-in user, or {dryRun:true} to
    // enumerate other users' emails + habit stats. Checked before parsing any
    // control flags. See isAuthorizedCaller for why this is a shared secret.
    if (!isAuthorizedCaller(req)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    }

    // Optional control params (default = real scheduled run).
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body = scheduled run */ }
    const dryRun = body?.dryRun === true;
    const force  = body?.force === true;
    const onlyUserId: string | undefined = typeof body?.userId === 'string' ? body.userId : undefined;

    const now = new Date();
    const emailKey = `weekly_summary_${isoWeekKey(now)}`;

    const sb = await getServiceRoleClient();

    // Pull state rows. Filter to one user when testing.
    let stateQuery = sb.from('user_state').select('user_id, state_data');
    if (onlyUserId) stateQuery = stateQuery.eq('user_id', onlyUserId);
    const { data: stateRows, error: stateErr } = await stateQuery;
    if (stateErr) throw new Error(`user_state read failed: ${stateErr.message}`);

    // Email + name come from nexus_profiles (state_data.userProfile has no email).
    // Scope to the single user when testing so we don't load every user's PII
    // into memory for a one-user run — mirrors the user_state filter above.
    let profileQuery = sb.from('nexus_profiles').select('user_id, email, name');
    if (onlyUserId) profileQuery = profileQuery.eq('user_id', onlyUserId);
    const { data: profileRows, error: profErr } = await profileQuery;
    if (profErr) throw new Error(`nexus_profiles read failed: ${profErr.message}`);
    const profileById = new Map<string, { email: string; name: string | null }>();
    for (const p of (profileRows ?? [])) {
      profileById.set(p.user_id, { email: p.email, name: p.name ?? null });
    }

    const results: RunResult[] = [];

    for (const row of (stateRows ?? [])) {
      const userId = row.user_id;
      const stateData = row.state_data;

      try {
        if (!weeklyEmailDueToday(stateData, now, force)) {
          results.push({ user_id: userId, sent: false, skipped: 'not_due_or_disabled' });
          continue;
        }

        // Email comes from nexus_profiles (authoritative), with a fallback to
        // the email some builds persist on state_data.userProfile.
        const profile = profileById.get(userId);
        const email = profile?.email || stateData?.userProfile?.email || null;
        const name = profile?.name ?? stateData?.userProfile?.name ?? null;
        if (!email) {
          results.push({ user_id: userId, sent: false, skipped: 'no_email' });
          continue;
        }

        const payload = buildWeeklyDigestPayload({
          stateData,
          email,
          name,
          now,
        });
        if (!payload) {
          results.push({ user_id: userId, email, sent: false, skipped: 'no_payload' });
          continue;
        }

        const preview = {
          completionRate: payload.completionRate,
          longestStreakDays: payload.longestStreakDays,
          disciplineScoreAvg: payload.disciplineScoreAvg,
        };

        // Week-scoped idempotency: never send twice in the same ISO week.
        if (await alreadySent(sb, userId, emailKey)) {
          results.push({ user_id: userId, email, email_key: emailKey, sent: false, skipped: 'already_sent', preview });
          continue;
        }

        if (dryRun) {
          results.push({ user_id: userId, email, email_key: emailKey, sent: false, dryRun: true, skipped: 'dry_run', preview });
          continue;
        }

        const messageId = await sendWeeklySummaryEmail(payload, RESEND_API_KEY);
        // The email is out. If the ledger write fails, record it as sent (true)
        // but flag logError loudly — do NOT let it fall to the outer catch,
        // which would mislabel a delivered email as sent:false.
        try {
          await logEmailSent(sb, userId, emailKey, messageId);
          results.push({ user_id: userId, email, email_key: emailKey, sent: true, preview });
        } catch (logErr: any) {
          console.error(`[weekly-summary-scheduler] ledger write failed after send for ${userId} (week ${emailKey}); risk of re-send next run:`, logErr?.message ?? logErr);
          results.push({ user_id: userId, email, email_key: emailKey, sent: true, logError: logErr?.message ?? String(logErr), preview });
        }
      } catch (e: any) {
        results.push({ user_id: userId, sent: false, error: e?.message ?? String(e) });
      }
    }

    const sent = results.filter(r => r.sent).length;
    const failed = results.filter(r => r.error).length;
    const logErrors = results.filter(r => r.logError).length;
    console.log(`[weekly-summary-scheduler] week=${emailKey} dryRun=${dryRun} force=${force} processed=${results.length} sent=${sent} failed=${failed} logErrors=${logErrors}`);

    return new Response(JSON.stringify({
      success: true,
      week: emailKey,
      dryRun,
      force,
      processed: results.length,
      sent,
      failed,
      logErrors,
      results,
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err: any) {
    console.error('[weekly-summary-scheduler] Fatal error:', err);
    return new Response(JSON.stringify({ error: err?.message ?? String(err) }), { status: 500 });
  }
});
