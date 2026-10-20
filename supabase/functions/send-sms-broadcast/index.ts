/**
 * NEX-86 send-sms-broadcast — admin-triggered SMS broadcast.
 *
 * POST (header: x-admin-token: $SMS_BROADCAST_ADMIN_TOKEN)
 * {
 *   content:      string   // markdown, same shape the email composer produces
 *   broadcastKey: string   // idempotency key, e.g. "newsletter-2026-w23"
 *   linkUrl?:     string   // web view of the full content
 *   testNumber?:  string   // E.164; if set, send ONLY to this number
 *   dryRun?:      boolean  // resolve recipients + body, send nothing
 * }
 *
 * Sends to every sms_opt_in row with opt_in_status = 'confirmed', skipping
 * users already logged for this broadcastKey (safe to re-run after a partial
 * failure). Paced at ~1 msg/sec — the sole-proprietor A2P campaign cap.
 * Cost-per-send lands in sms_send_log: the create response gives segments,
 * the Twilio status callback (sms-webhook) fills in price.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SMS_BROADCAST_ADMIN_TOKEN,
 *      TWILIO_* (see _shared/sms.ts)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { emailToSms, logSmsAttempt, sendBroadcastSmsOnce, sendSms } from '../_shared/sms.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ADMIN_TOKEN = Deno.env.get('SMS_BROADCAST_ADMIN_TOKEN') ?? '';

const SEND_INTERVAL_MS = 1100; // 1 MPS sole-prop cap, with margin

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!ADMIN_TOKEN || req.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  const payload = await req.json().catch(() => null);
  const { content, broadcastKey, linkUrl, testNumber, dryRun } = payload ?? {};
  if (!content || typeof content !== 'string') return json({ error: 'content_required' }, 400);
  if (!broadcastKey || typeof broadcastKey !== 'string') {
    return json({ error: 'broadcast_key_required' }, 400);
  }

  const { body } = emailToSms(content, { linkUrl });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const statusCallback = `${SUPABASE_URL}/functions/v1/sms-webhook`;

  // ── Test send: one number, no opt-in gating, logged with a test marker ────
  if (testNumber) {
    if (dryRun) return json({ dryRun: true, body, recipients: [testNumber] });
    const res = await sendSms(testNumber, body, statusCallback);
    if (res.ok) {
      await admin.from('sms_send_log').insert({
        phone_number: testNumber,
        message_sid: res.sid,
        broadcast_key: `${broadcastKey}#test`,
        body_preview: body.slice(0, 160),
        segments: res.numSegments,
        status: res.status,
      });
    } else {
      // NEX-319: a failed test send used to record nothing at all, so the very
      // call you reach for to diagnose the channel was itself invisible.
      await logSmsAttempt(admin, {
        phase: 'create_failed',
        phoneNumber: testNumber,
        broadcastKey: `${broadcastKey}#test`,
        errorCode: res.errorCode,
        errorMessage: res.errorMessage,
      });
    }
    return json({
      sent: res.ok ? 1 : 0,
      failed: res.ok ? 0 : 1,
      body,
      error: res.errorMessage,
      errorCode: res.errorCode,
    });
  }

  // ── Real broadcast ─────────────────────────────────────────────────────────
  const { data: recipients, error: recErr } = await admin
    .from('sms_opt_in')
    .select('user_id, phone_number')
    .eq('opt_in_status', 'confirmed');
  if (recErr) return json({ error: 'recipient_query_failed' }, 500);

  // Idempotency: drop anyone already logged for this key.
  const { data: alreadySent } = await admin
    .from('sms_send_log')
    .select('user_id')
    .eq('broadcast_key', broadcastKey);
  const sentSet = new Set((alreadySent ?? []).map((r) => r.user_id));
  const queue = (recipients ?? []).filter((r) => !sentSet.has(r.user_id));

  if (dryRun) {
    return json({
      dryRun: true,
      body,
      recipientCount: queue.length,
      skippedAlreadySent: sentSet.size,
    });
  }

  let sent = 0;
  let failed = 0;
  let racedAlready = 0; // reserved/sent by a concurrent run after our pre-filter
  const errors: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const r = queue[i];
    // Reserve-before-send (NEX-185): the unique index on (broadcast_key,
    // user_id) prevents a concurrent run's duplicate paid text, not just
    // detects it after the fact.
    const outcome = await sendBroadcastSmsOnce(admin, {
      to: r.phone_number, userId: r.user_id, broadcastKey, body, statusCallback,
    });
    if (outcome.kind === 'already') {
      racedAlready++;
      continue; // nothing sent — no pacing needed
    }
    if (outcome.kind === 'reserve_failed') {
      failed++;
      errors.push(`${r.phone_number}: reserve failed ${outcome.error}`);
      console.error('broadcast reserve failed', r.user_id, outcome.error);
      continue;
    }
    if (outcome.kind === 'send_failed') {
      failed++;
      errors.push(`${r.phone_number}: ${outcome.errorCode ?? ''} ${outcome.errorMessage ?? 'unknown'}`);
      console.error('broadcast send failed', r.user_id, outcome.errorCode, outcome.errorMessage);
      if (i < queue.length - 1) await sleep(SEND_INTERVAL_MS);
      continue;
    }
    sent++;
    const now = new Date().toISOString();
    await admin
      .from('sms_opt_in')
      .update({ last_sms_sent_at: now, updated_at: now })
      .eq('user_id', r.user_id);
    // Pace at 1 MPS; no sleep after the final message (response latency).
    if (i < queue.length - 1) await sleep(SEND_INTERVAL_MS);
  }

  return json({
    sent,
    failed,
    skippedAlreadySent: sentSet.size + racedAlready,
    errors: errors.slice(0, 10),
  });
});
