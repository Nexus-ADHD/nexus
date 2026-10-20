/**
 * NEX-86 shared SMS helpers — Twilio REST client + email→SMS content adapter.
 * Used by: sms-opt-in, send-sms-broadcast, sms-webhook, weekly-broadcast.
 *
 * Env (set via `supabase secrets set`):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER            e.g. +15555550100
 *   TWILIO_MESSAGING_SERVICE_SID  optional; preferred once the A2P campaign
 *                                 is approved (routes through the registered
 *                                 campaign instead of the bare number)
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const TWILIO_FROM_NUMBER = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
const TWILIO_MESSAGING_SERVICE_SID = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') ?? '';

export interface SendSmsResult {
  ok: boolean;
  sid?: string;
  status?: string;
  numSegments?: number;
  errorCode?: number;
  errorMessage?: string;
}

/** Send one SMS via Twilio. Sole-prop campaigns are capped at 1 msg/sec —
 * callers batching sends must pace themselves (see send-sms-broadcast). */
export async function sendSms(
  to: string,
  body: string,
  statusCallback?: string,
): Promise<SendSmsResult> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return { ok: false, errorMessage: 'Twilio credentials not configured' };
  }
  const params = new URLSearchParams({ To: to, Body: body });
  if (TWILIO_MESSAGING_SERVICE_SID) {
    params.set('MessagingServiceSid', TWILIO_MESSAGING_SERVICE_SID);
  } else {
    params.set('From', TWILIO_FROM_NUMBER);
  }
  if (statusCallback) params.set('StatusCallback', statusCallback);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      errorCode: data?.code,
      errorMessage: data?.message ?? `Twilio HTTP ${res.status}`,
    };
  }
  return {
    ok: true,
    sid: data.sid,
    status: data.status,
    numSegments: Number(data.num_segments ?? 1),
  };
}

/**
 * Validate Twilio's X-Twilio-Signature header (HMAC-SHA1, base64).
 * Signature = HMAC(url + concat(sorted form keys + values), auth token).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export async function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  if (!TWILIO_AUTH_TOKEN || !signature) return false;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TWILIO_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // Constant-time-ish comparison (lengths are fixed for base64 SHA-1).
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ── Email-shape → SMS-shape adapter ──────────────────────────────────────────

/** Characters outside GSM-7 force UCS-2 encoding (70 chars/segment instead of
 * 160). Swap the common offenders the email composer produces. */
function normalizeForGsm(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

/** Strip markdown to plain text suitable for SMS. */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // links: keep text
    .replace(/^\s*[-*+]\s+/gm, '- ') // bullets
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SmsContent {
  body: string;
  truncated: boolean;
}

const SMS_PREFIX = 'Nexus: ';
const SMS_SUFFIX = ' Reply STOP to unsubscribe.';
const SMS_LINK_LABEL = ' Read in full: ';
// 2 concatenated GSM-7 segments = 2 × 153 chars (UDH header eats 7 per segment).
const TWO_SEGMENT_BUDGET = 306;

/**
 * Convert email-shape markdown into an SMS body.
 * The TOTAL assembled body (prefix + content + optional link + opt-out
 * suffix) is budgeted to ≤ 2 GSM-7 segments so cost per send stays
 * predictable. Twilio handles the actual segmentation.
 */
export function emailToSms(
  markdown: string,
  opts: { linkUrl?: string; maxContentChars?: number } = {},
): SmsContent {
  const linkPart = opts.linkUrl ? SMS_LINK_LABEL + opts.linkUrl : '';
  const max =
    opts.maxContentChars ??
    Math.max(40, TWO_SEGMENT_BUDGET - SMS_PREFIX.length - SMS_SUFFIX.length - linkPart.length);
  let text = normalizeForGsm(stripMarkdown(markdown)).replace(/\s+/g, ' ').trim();
  let truncated = false;
  if (text.length > max) {
    const cut = text.slice(0, max - 3); // reserve room for the ellipsis
    text = cut.slice(0, cut.lastIndexOf(' ')).trim() + '...';
    truncated = true;
  }
  return { body: SMS_PREFIX + text + linkPart + SMS_SUFFIX, truncated };
}

// ── Failure audit (NEX-319) ──────────────────────────────────────────────────

/** Where in the send lifecycle an attempt died. */
export type SmsAttemptPhase = 'create_failed' | 'ambiguous' | 'callback_failed' | 'log_write_failed';

/**
 * Append one row to `sms_send_attempt_log`.
 *
 * Best-effort by construction: a failure to record a failure must never change
 * the caller's control flow, so this swallows its own errors after logging
 * them. Callers treat it as fire-and-forget.
 *
 * This exists because `sms_send_log` is the at-most-once dedupe ledger, not an
 * audit trail — `sendBroadcastSmsOnce` deletes its reservation on a definitive
 * rejection so a retry can re-attempt, which erased the only evidence of why a
 * send failed. That blindness is what left the channel dark for a month.
 */
export async function logSmsAttempt(
  admin: SupabaseClient,
  params: {
    phase: SmsAttemptPhase;
    phoneNumber: string;
    userId?: string | null;
    broadcastKey?: string | null;
    errorCode?: number | null;
    errorMessage?: string | null;
    messageSid?: string | null;
  },
): Promise<void> {
  try {
    const { error } = await admin.from('sms_send_attempt_log').insert({
      phase: params.phase,
      phone_number: params.phoneNumber,
      user_id: params.userId ?? null,
      broadcast_key: params.broadcastKey ?? null,
      error_code: params.errorCode ?? null,
      error_message: params.errorMessage?.slice(0, 500) ?? null,
      message_sid: params.messageSid ?? null,
    });
    if (error) console.error('logSmsAttempt: insert failed', params.phase, error.message);
  } catch (e) {
    console.error('logSmsAttempt: threw', e instanceof Error ? e.message : String(e));
  }
}

// ── At-most-once broadcast send (NEX-185) ────────────────────────────────────

export type SmsDedupeOutcome =
  | { kind: 'sent'; sid: string; segments?: number }
  | { kind: 'already' }                                   // a prior/concurrent run owns this (key,user)
  | { kind: 'reserve_failed'; error: string }             // DB error reserving — not sent
  | { kind: 'send_failed'; errorCode?: number; errorMessage?: string };

/**
 * Send one broadcast SMS with **at-most-once** semantics for a (broadcastKey,
 * userId) pair. Order: reserve a `sms_send_log` row (status `sending`) BEFORE
 * calling Twilio, so the unique index on (broadcast_key, user_id) *prevents* a
 * concurrent run's duplicate send instead of only detecting it after the text
 * is already out. On a 23505 the slot is owned elsewhere → `already`. On
 * success the row is finalized with the SID/status/segments.
 *
 * Failure handling always favors at-most-once:
 *   - definitive Twilio rejection ({ok:false}) → release (delete) → retryable;
 *   - ambiguous throw (lost response) → KEEP the row (mark `unknown`) so a
 *     possibly-delivered text is never re-sent;
 *   - crash after reserving / before finalize → row stays `sending` → skipped.
 * So the only residual is a rare UNDER-send (safe direction), never a
 * double-send; a sweeper for stale `sending`/`unknown` rows is a follow-up.
 *
 * For per-user broadcast rows only (userId must be non-null — the unique index
 * uses NULLS DISTINCT, so null-user test rows are not deduped and must not go
 * through here).
 */
export async function sendBroadcastSmsOnce(
  admin: SupabaseClient,
  params: { to: string; userId: string; broadcastKey: string; body: string; statusCallback?: string },
): Promise<SmsDedupeOutcome> {
  const { to, userId, broadcastKey, body, statusCallback } = params;

  // 1. Reserve. A 23505 means another run already owns this (key, user).
  const { error: resErr } = await admin.from('sms_send_log').insert({
    user_id: userId,
    phone_number: to,
    broadcast_key: broadcastKey,
    body_preview: body.slice(0, 160),
    status: 'sending',
  });
  if (resErr) {
    if ((resErr as { code?: string }).code === '23505') return { kind: 'already' };
    return { kind: 'reserve_failed', error: resErr.message };
  }

  // 2. Send. Two failure shapes, handled in OPPOSITE directions because this is
  // an at-most-once channel:
  //   - sendSms THROWS (network error / lost response): AMBIGUOUS — the POST may
  //     have reached Twilio and queued the text. KEEP the reservation (mark it
  //     `unknown`) so no later run can re-send a possibly-delivered message. The
  //     rare cost is an under-send on a true network failure; an out-of-band
  //     sweeper reconciles `sending`/`unknown` rows.
  //   - sendSms returns {ok:false}: DEFINITIVE Twilio rejection (not sent) →
  //     release the reservation so a retry can re-attempt.
  let res: SendSmsResult;
  try {
    res = await sendSms(to, body, statusCallback);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    await admin.from('sms_send_log').update({ status: 'unknown' })
      .eq('broadcast_key', broadcastKey).eq('user_id', userId);
    await logSmsAttempt(admin, {
      phase: 'ambiguous', phoneNumber: to, userId, broadcastKey, errorMessage,
    });
    return { kind: 'send_failed', errorMessage };
  }
  if (!res.ok || !res.sid) {
    // Audit BEFORE releasing: the delete below is what makes this retryable, and
    // it is also what would otherwise destroy the only record that we tried.
    await logSmsAttempt(admin, {
      phase: 'create_failed',
      phoneNumber: to,
      userId,
      broadcastKey,
      errorCode: res.errorCode,
      errorMessage: res.errorMessage,
    });
    await admin.from('sms_send_log').delete()
      .eq('broadcast_key', broadcastKey).eq('user_id', userId);
    return { kind: 'send_failed', errorCode: res.errorCode, errorMessage: res.errorMessage };
  }

  // 3. Finalize. If this fails the row stays `sending` (no SID) → next run skips
  //    it → at-most-once preserved; we just miss the delivery receipt.
  const { error: updErr } = await admin.from('sms_send_log').update({
    message_sid: res.sid,
    status: res.status,
    segments: res.numSegments,
  }).eq('broadcast_key', broadcastKey).eq('user_id', userId);
  if (updErr) {
    console.error('sendBroadcastSmsOnce: finalize failed (delivered; row left as sending)', userId, updErr.message);
  }
  return { kind: 'sent', sid: res.sid, segments: res.numSegments };
}
