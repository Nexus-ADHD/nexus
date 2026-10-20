/**
 * Nexus Weekly Broadcast — Supabase Edge Function
 * ────────────────────────────────────────────────────────────────────
 * Fires every Tuesday at 14:00 UTC via pg_cron.
 *
 * Sends one of 12 rotating value-content emails to every activated user
 * who is at least 7 days past their trial_start. Each user receives the
 * weeks in order based on their own activation date, not the calendar:
 *
 *   weeksSinceTrialStart 1  → Week 1
 *   weeksSinceTrialStart 2  → Week 2
 *   ...
 *   weeksSinceTrialStart 12 → Week 12
 *   weeksSinceTrialStart 13 → Week 1 (cycle repeats)
 *
 * Idempotent: nexus_email_log is checked per (user_id, email_key) before
 * sending. Safe to re-run the same week.
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 */

import { isServiceRoleCaller } from '../_shared/caller-auth.ts';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  WEEKS,
  currentBroadcastKey,
  getFirstName,
  pickWeekContent,
  weeksSinceTrialStart,
  type WeekContent,
} from '../_shared/weekly-broadcast-shared.ts';
import { emailToSms, sendBroadcastSmsOnce } from '../_shared/sms.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL       = Deno.env.get('FROM_EMAIL') ?? 'Nexus <hello@example.com>';
const REPLY_TO         = Deno.env.get('REPLY_TO_EMAIL') ?? 'hello@example.com';

// NEX-185 SMS parity. The admin token gates only the `smsPreview` inspection
// path (mirrors send-sms-broadcast); a normal cron run needs no token.
const SMS_BROADCAST_ADMIN_TOKEN = Deno.env.get('SMS_BROADCAST_ADMIN_TOKEN') ?? '';
// NEX-319: opt-IN flag. Anything but an explicit 'true' leaves the weekly SMS
// leg off, so an unset or typo'd secret fails safe (no unintended paid texts).
const SMS_WEEKLY_BROADCAST_ENABLED =
  (Deno.env.get('SMS_WEEKLY_BROADCAST_ENABLED') ?? '').toLowerCase() === 'true';
const SMS_SEND_INTERVAL_MS = 1100;   // 1 MPS sole-prop A2P cap, with margin
const SMS_MAX_PER_RUN      = 120;    // hard cap so email+SMS fit one invocation
const SMS_DEADLINE_MS      = 130_000; // stop the SMS loop before the ~150s wall

const smsSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mask an E.164 number for preview output (never return raw PII). */
function maskPhone(p: string): string {
  return p.length <= 5 ? '•••••' : `${p.slice(0, 2)}•••••${p.slice(-4)}`;
}

interface NexusProfile {
  user_id:     string;
  email:       string;
  name:        string;
  trial_start: string;
}


function buildHtml(firstName: string, week: WeekContent): string {
  const paragraphs = week.body
    .replace('{firstName}', firstName)
    .split('\n\n')
    .map(p => p.trim())
    .filter(Boolean);

  const greetingLine = paragraphs[0];
  const restParas    = paragraphs.slice(1, -1);
  const signOff      = paragraphs[paragraphs.length - 1];

  const restHtml = restParas
    .map(p => `<p style="margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;">${p}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${week.subject}</title>
</head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:40px 0;">
  <tr>
    <td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="padding:0 0 40px;text-align:center;">
            <p style="margin:0;color:#D4AF37;font-size:11px;font-weight:900;letter-spacing:6px;">N E X U S</p>
            <p style="margin:8px 0 0;color:#444;font-size:11px;letter-spacing:1px;">WEEK ${week.index} OF 12</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 28px;">
            <p style="margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;">${greetingLine}</p>
            ${restHtml}
            <p style="margin:24px 0 0;color:#F0F0F0;font-size:15px;line-height:26px;">${signOff}</p>
          </td>
        </tr>
        <tr>
          <td style="text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;padding-bottom:8px;">
            <p style="margin:0;color:#2A2A2A;font-size:11px;letter-spacing:1px;">Nexus · Built for the intentional</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

async function getServiceRoleClient() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

async function getEligibleProfiles(now: Date): Promise<NexusProfile[]> {
  const sb = await getServiceRoleClient();
  // One clock: callers pass the handler's `now` so the 7-day eligibility cutoff
  // and the per-user week math (weeksSinceTrialStart) agree at the boundary.
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('nexus_profiles')
    .select('user_id, email, name, trial_start')
    .not('trial_start', 'is', null)
    .lte('trial_start', sevenDaysAgo);
  if (error) throw new Error(`Failed to fetch profiles: ${error.message}`);
  return (data ?? []) as NexusProfile[];
}

async function alreadySent(userId: string, key: string): Promise<boolean> {
  const sb = await getServiceRoleClient();
  const { data } = await sb
    .from('nexus_email_log')
    .select('id')
    .eq('user_id', userId)
    .eq('email_key', key)
    .limit(1)
    .single();
  return !!data;
}

async function logSent(userId: string, key: string, messageId: string): Promise<void> {
  const sb = await getServiceRoleClient();
  await sb.from('nexus_email_log').upsert(
    {
      user_id:    userId,
      email_key:  key,
      sent_at:    new Date().toISOString(),
      message_id: messageId,
    },
    { onConflict: 'user_id,email_key' },
  );
}

async function sendEmail(to: string, subject: string, html: string): Promise<string> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:     FROM_EMAIL,
      to:       [to],
      subject,
      html,
      reply_to: REPLY_TO,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

// ── NEX-185 SMS parity ───────────────────────────────────────────────────────

interface SmsParityResult {
  broadcastKey: string;           // the `...#sms` dedupe key
  sent: number;
  failed: number;
  skippedAlreadySent: number;     // logged for this key by a prior/concurrent run
  skippedNotEligible: number;     // confirmed opt-in but no email-eligible profile
  skippedStopped: number;         // STOP arrived before this user's turn
  remaining: number;              // hit MAX_PER_RUN / deadline; pick up on re-run
  errors: string[];
  // Present only on preview (observational): masked phone + resolved week.
  preview?: { userId: string; phone: string; week: number; body: string }[];
}

/**
 * Send each opted-in user the SMS twin of the SAME week's content their email
 * carried. Runs after the email loop, inside the handler's try/catch, so a
 * failure here never breaks the (primary) email channel — but every Supabase
 * write also checks its own error.
 *
 * Dedupe key is `${broadcastKey}#sms`. Each send goes through
 * sendBroadcastSmsOnce (reserve-before-send), so the unique index from
 * migration nex185 gives at-most-once even across overlapping runs — a 23505
 * means the slot is already owned ⇒ skip.
 *
 * With `preview:true` it resolves recipients/bodies and returns them (masked
 * phones) WITHOUT sending — the admin-gated inspection path.
 */
async function sendWeeklySmsParity(
  now: Date,
  emailBroadcastKey: string,
  profiles: NexusProfile[],
  opts: { preview: boolean },
): Promise<SmsParityResult> {
  const smsKey = `${emailBroadcastKey}#sms`;
  const result: SmsParityResult = {
    broadcastKey: smsKey,
    sent: 0, failed: 0,
    skippedAlreadySent: 0, skippedNotEligible: 0, skippedStopped: 0,
    remaining: 0, errors: [],
  };
  if (opts.preview) result.preview = [];

  const admin = await getServiceRoleClient();
  const statusCallback = `${SUPABASE_URL}/functions/v1/sms-webhook`;

  // Confirmed opt-ins (STOP/stopped excluded). Re-checked again per-recipient
  // at send time below, so a STOP arriving mid-run is still honored.
  const { data: optIns, error: optErr } = await admin
    .from('sms_opt_in')
    .select('user_id, phone_number')
    .eq('opt_in_status', 'confirmed');
  if (optErr) throw new Error(`sms_opt_in query failed: ${optErr.message}`);

  // Intersect with the already-fetched email-eligible profiles (no 2nd query),
  // resolving each user's week once. The 7-day cutoff + shared `now` already
  // guarantee weeksSince >= 1, but we floor it here too as defense-in-depth so a
  // future loosening of the eligibility query can't text week-0 users.
  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
  const candidates: { userId: string; phone: string; week: WeekContent }[] = [];
  for (const o of optIns ?? []) {
    const profile = profileMap.get(o.user_id);
    if (!profile) { result.skippedNotEligible++; continue; } // no email either: parity
    const weeksSince = weeksSinceTrialStart(profile.trial_start, now);
    if (weeksSince < 1) { result.skippedNotEligible++; continue; }
    candidates.push({ userId: o.user_id, phone: o.phone_number, week: pickWeekContent(weeksSince) });
  }

  // Pre-filter fast-path (the unique index is the real guarantee). Fail closed
  // on a dedupe-query error rather than risk a blind re-send.
  const { data: already, error: dedupeErr } = await admin
    .from('sms_send_log')
    .select('user_id')
    .eq('broadcast_key', smsKey);
  if (dedupeErr) throw new Error(`sms_send_log dedupe query failed: ${dedupeErr.message}`);
  const sentSet = new Set((already ?? []).map((r) => r.user_id));

  const queue = candidates.filter((c) => {
    if (sentSet.has(c.userId)) { result.skippedAlreadySent++; return false; }
    return true;
  });

  // Preview: resolve bodies, send nothing. Bounded by the same cap the real
  // loop uses so a large opt-in list can't make a preview POST run long.
  if (opts.preview) {
    if (queue.length > SMS_MAX_PER_RUN) result.remaining = queue.length - SMS_MAX_PER_RUN;
    for (const c of queue.slice(0, SMS_MAX_PER_RUN)) {
      const { body } = emailToSms(c.week.sms);
      result.preview!.push({ userId: c.userId, phone: maskPhone(c.phone), week: c.week.index, body });
    }
    return result;
  }

  const startedAt = Date.now();
  for (let i = 0; i < queue.length; i++) {
    if (result.sent >= SMS_MAX_PER_RUN || Date.now() - startedAt > SMS_DEADLINE_MS) {
      result.remaining = queue.length - i;
      console.warn(`[weekly-broadcast] SMS pass stopping early; ${result.remaining} remaining (recover on re-run)`);
      break;
    }
    const c = queue[i];

    // STOP at send time: re-read this user's status right before sending.
    const { data: fresh, error: freshErr } = await admin
      .from('sms_opt_in')
      .select('opt_in_status')
      .eq('user_id', c.userId)
      .single();
    if (freshErr || !fresh || fresh.opt_in_status !== 'confirmed') {
      result.skippedStopped++;
      continue;
    }

    // Reserve-before-send: the unique index prevents a concurrent run's
    // duplicate paid text rather than only detecting it after the fact.
    const { body } = emailToSms(c.week.sms);
    const outcome = await sendBroadcastSmsOnce(admin, {
      to: c.phone, userId: c.userId, broadcastKey: smsKey, body, statusCallback,
    });

    if (outcome.kind === 'already') {
      result.skippedAlreadySent++;
      continue; // no Twilio call happened — no pacing needed
    }
    if (outcome.kind === 'reserve_failed') {
      result.failed++;
      result.errors.push(`${c.phone}: reserve failed ${outcome.error}`);
      console.error('[weekly-broadcast] SMS reserve failed', c.userId, outcome.error);
      continue; // nothing sent — no pacing needed
    }
    if (outcome.kind === 'send_failed') {
      result.failed++;
      result.errors.push(`${c.phone}: ${outcome.errorCode ?? ''} ${outcome.errorMessage ?? 'unknown'}`);
      console.error('[weekly-broadcast] SMS send failed', c.userId, outcome.errorCode, outcome.errorMessage);
      if (i < queue.length - 1) await smsSleep(SMS_SEND_INTERVAL_MS);
      continue;
    }

    // sent
    result.sent++;
    const nowIso = new Date().toISOString();
    const { error: updErr } = await admin
      .from('sms_opt_in')
      .update({ last_sms_sent_at: nowIso, updated_at: nowIso })
      .eq('user_id', c.userId);
    if (updErr) console.error('[weekly-broadcast] last_sms_sent_at update failed', c.userId, updErr.message);

    if (i < queue.length - 1) await smsSleep(SMS_SEND_INTERVAL_MS);
  }

  return result;
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

    // Tolerant parse: the cron POSTs no body. Only `smsPreview` is read.
    const body = await req.json().catch(() => null) as { smsPreview?: boolean } | null;
    const now = new Date();
    const broadcastKey = currentBroadcastKey(now);

    // ── Admin-gated SMS preview (observational; sends NO email or SMS) ──────────
    // A bare {smsPreview:true} cannot suppress the newsletter: it requires the
    // admin token and short-circuits before any send. Needs no RESEND_API_KEY.
    if (body?.smsPreview) {
      if (!SMS_BROADCAST_ADMIN_TOKEN || req.headers.get('x-admin-token') !== SMS_BROADCAST_ADMIN_TOKEN) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      if (!SERVICE_ROLE_KEY) return new Response(JSON.stringify({ error: 'SERVICE_ROLE_KEY not set' }), { status: 500 });
      const profiles = await getEligibleProfiles(now);
      const sms = await sendWeeklySmsParity(now, broadcastKey, profiles, { preview: true });
      return new Response(
        JSON.stringify({ smsPreview: true, broadcastKey, eligible: profiles.length, sms }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 2026-10-18: only the pg_cron job (service-role key) may run the send.
    // Before this, anyone with the public app key could trigger it.
    if (!(await isServiceRoleCaller(req))) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }

    if (!RESEND_API_KEY)   return new Response(JSON.stringify({ error: 'RESEND_API_KEY not set' }),   { status: 500 });
    if (!SERVICE_ROLE_KEY) return new Response(JSON.stringify({ error: 'SERVICE_ROLE_KEY not set' }), { status: 500 });

    const profiles = await getEligibleProfiles(now);

    console.log(`[weekly-broadcast] Key: ${broadcastKey} · eligible: ${profiles.length}`);

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors: { email: string; error: string }[] = [];

    for (const profile of profiles) {
      try {
        if (await alreadySent(profile.user_id, broadcastKey)) { skipped++; continue; }

        const weeksSince = weeksSinceTrialStart(profile.trial_start, now);
        if (weeksSince < 1) { skipped++; continue; }

        const week = pickWeekContent(weeksSince);
        const firstName = getFirstName(profile.name);
        const html = buildHtml(firstName, week);
        const messageId = await sendEmail(profile.email, week.subject, html);

        await logSent(profile.user_id, broadcastKey, messageId);
        sent++;
      } catch (e: any) {
        failed++;
        errors.push({ email: profile.email, error: e.message });
        console.error(`[weekly-broadcast] Failed for ${profile.email}:`, e.message);
      }
    }

    console.log(`[weekly-broadcast] Done. Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}`);

    // SMS parity pass — isolated so a failure can't break the email channel.
    //
    // NEX-319 kill switch, default OFF. The cron path carries no admin token
    // (the token gates only `smsPreview`), so before this flag the first user to
    // reach `confirmed` would be texted automatically on the next Tuesday with
    // no human in the loop — while the channel had never delivered a single
    // message. Turn this on only after one send and one inbound YES are proven.
    let sms: SmsParityResult | { error: string } | { skipped: 'disabled' } | null = null;
    if (!SMS_WEEKLY_BROADCAST_ENABLED) {
      sms = { skipped: 'disabled' };
      console.log('[weekly-broadcast] SMS parity pass skipped: SMS_WEEKLY_BROADCAST_ENABLED is not set');
    } else {
      try {
        sms = await sendWeeklySmsParity(now, broadcastKey, profiles, { preview: false });
        console.log(`[weekly-broadcast] SMS. Sent: ${sms.sent}, Failed: ${sms.failed}, SkippedAlreadySent: ${sms.skippedAlreadySent}, Remaining: ${sms.remaining}`);
      } catch (e: any) {
        sms = { error: e.message };
        console.error('[weekly-broadcast] SMS parity pass failed:', e.message);
      }
    }

    return new Response(
      JSON.stringify({ success: true, broadcastKey, eligible: profiles.length, sent, skipped, failed, errors, sms }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    console.error('[weekly-broadcast] Fatal error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
