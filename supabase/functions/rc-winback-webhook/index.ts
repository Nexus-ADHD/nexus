/**
 * NEX-323 (NEX-298 C6) — rc-winback-webhook: RevenueCat webhook receiver.
 * ────────────────────────────────────────────────────────────────────
 * The repo's first server-side subscription ingestion point. Catches the two
 * leaky moments the C0 taxonomy proved are losses, not hedges:
 *
 *   (a) still-in-trial voluntary canceller  (CANCELLATION/UNSUBSCRIBE/TRIAL)
 *       → one value email, no discount, at most once per user ever
 *   (b) lapsed-without-conversion           (EXPIRATION/UNSUBSCRIBE/TRIAL)
 *       → one 1-month RC promotional grant + one email, at most once ever
 *
 * Never messages a BILLING_ERROR/dunning user as if they rejected.
 *
 * Auth: RC sends a static `Authorization: Bearer <secret>` configured in the
 * RC dashboard; compared constant-time against REVENUECAT_WEBHOOK_AUTH.
 * verify_jwt=false (see scripts/edge-functions.manifest).
 *
 * Kill switch (opt-IN, fails safe): unless RC_WINBACK_ENABLED === 'true',
 * events are archived to revenuecat_events and never acted on — events
 * received while dark are deliberately NOT replayed later (fail-safe
 * under-send).
 *
 * Environment gate: RC_WINBACK_ALLOWED_ENV (comma list, default PRODUCTION).
 * Staging sets SANDBOX,PRODUCTION so the manual acceptance checklist can run
 * on sandbox events; prod is PRODUCTION only.
 *
 * At-most-once (mirrors _shared/sms.ts sendBroadcastSmsOnce): reserve a
 * winback_send_log row on the unique (kind, user_id) index BEFORE any side
 * effect. Definitive rejection RELEASES the reservation (retryable);
 * ambiguous failure KEEPS it (status 'unknown', never re-sent). For (b) the
 * reservation is additionally kept whenever the grant succeeded or is
 * ambiguous — releasing after a side effect would allow a re-grant, and RC
 * promotional grants stack.
 *
 * Spec: docs/plans/nex-323-cancel-winback.md
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   REVENUECAT_WEBHOOK_AUTH     shared secret for the Authorization header
 *   REVENUECAT_SECRET_KEY       RC REST (promotional grant)
 *   RESEND_API_KEY              email
 *   RC_WINBACK_ENABLED          opt-IN kill switch ('true')
 *   RC_WINBACK_ALLOWED_ENV      comma list, default 'PRODUCTION'
 *   POSTHOG_PROJECT_API_KEY     public project write key (metrics-only capture)
 *   POSTHOG_HOST                default https://us.i.posthog.com
 *   SENTRY_EDGE_DSN             optional (via _shared/sentry.ts)
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { captureEdgeError } from '../_shared/sentry.ts';
import { classifyRcEvent, type WinbackKind } from './classify.ts';
import { formatAccessUntil, FROM_EMAIL, winbackEmail } from './copy.ts';
import { grantPromotionalMonth } from './grant.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const WEBHOOK_AUTH = Deno.env.get('REVENUECAT_WEBHOOK_AUTH') ?? '';
const ENABLED = (Deno.env.get('RC_WINBACK_ENABLED') ?? '').toLowerCase() === 'true';
const ALLOWED_ENV = new Set(
  (Deno.env.get('RC_WINBACK_ALLOWED_ENV') ?? 'PRODUCTION').split(',').map((s) => s.trim()).filter(Boolean),
);
const POSTHOG_KEY = Deno.env.get('POSTHOG_PROJECT_API_KEY') ?? '';
const POSTHOG_HOST = (Deno.env.get('POSTHOG_HOST') ?? 'https://us.i.posthog.com').replace(/\/$/, '');

const EMAIL_KEY: Record<WinbackKind, string> = {
  trial_cancel_value: 'winback-trial-cancel',
  lapsed_offer: 'winback-lapsed-offer',
};

const nowIso = () => new Date().toISOString();

/**
 * Roll the suppression marker back. Best-effort: logs, never throws.
 *
 * Only correct after a DEFINITIVE send failure, where we know nothing went out
 * and the pre-written marker would otherwise silence trial_day_12/13 for an
 * email that never existed. An AMBIGUOUS failure must keep it — the same
 * may-have-happened logic the reservation itself uses.
 */
async function removeSuppressionMarker(
  admin: SupabaseClient,
  userId: string,
  kind: WinbackKind,
): Promise<void> {
  const { error } = await admin
    .from('nexus_email_log')
    .delete()
    .eq('user_id', userId)
    .eq('email_key', EMAIL_KEY[kind]);
  if (error) console.error('[rc-winback-webhook] marker rollback failed', error.message);
}

/**
 * Write the suppression marker, idempotently. Returns an error message, or null.
 *
 * This row is what stops email-scheduler sending trial_day_12/13 to someone we
 * have just emailed: its `alreadySent` check is existence-only
 * (`select('id').eq(user_id).eq(email_key)`), which is why a marker written
 * WITHOUT a `message_id` still suppresses correctly — it still says "we wrote
 * to this person".
 *
 * One helper for the pre-send write and the retry repair, so the two paths
 * cannot drift into writing different rows.
 */
async function writeSuppressionMarker(
  admin: SupabaseClient,
  userId: string,
  kind: WinbackKind,
  sentAt: string,
  messageId?: string,
): Promise<string | null> {
  const row: Record<string, unknown> = {
    user_id: userId,
    email_key: EMAIL_KEY[kind],
    sent_at: sentAt,
  };
  if (messageId) row.message_id = messageId;
  const { error } = await admin
    .from('nexus_email_log')
    .upsert(row, { onConflict: 'user_id,email_key' });
  return error ? error.message : null;
}

async function getServiceRoleClient() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Constant-time string compare (fixed-length bearer secrets). */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type AttemptPhase = 'create_failed' | 'ambiguous' | 'log_write_failed';

/** Best-effort failure audit — never changes control flow (mirrors logSmsAttempt). */
async function logAttempt(
  admin: SupabaseClient,
  params: { phase: AttemptPhase; userId: string; kind: WinbackKind; errorCode?: string | null; errorMessage?: string | null },
): Promise<void> {
  try {
    const { error } = await admin.from('winback_send_attempt_log').insert({
      phase: params.phase,
      user_id: params.userId,
      kind: params.kind,
      error_code: params.errorCode ?? null,
      error_message: params.errorMessage?.slice(0, 500) ?? null,
    });
    if (error) console.error('[rc-winback-webhook] attempt log insert failed', params.phase, error.message);
  } catch (e) {
    console.error('[rc-winback-webhook] attempt log threw', e instanceof Error ? e.message : String(e));
  }
}

type SendOutcome =
  | { kind: 'sent'; id: string }
  | { kind: 'definitive'; status: number }
  | { kind: 'ambiguous'; error: string };

async function sendResendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  headers: Record<string, string>;
}): Promise<SendOutcome> {
  if (!RESEND_API_KEY) return { kind: 'ambiguous', error: 'resend_not_configured' };
  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        headers: opts.headers,
      }),
    });
  } catch (e) {
    return { kind: 'ambiguous', error: e instanceof Error ? e.message : String(e) };
  }
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data?.id) return { kind: 'sent', id: data.id };
    return { kind: 'ambiguous', error: 'resend_no_id' };
  }
  // Log the body server-side only — Resend error bodies can echo the recipient (PII).
  console.error('[rc-winback-webhook] Resend error', res.status, await res.text().catch(() => ''));
  if (res.status >= 400 && res.status < 500) return { kind: 'definitive', status: res.status };
  return { kind: 'ambiguous', error: `resend_http_${res.status}` };
}

/** Fire-and-forget PostHog capture — metrics-only, never affects the send. */
function captureWinbackSent(distinctId: string, kind: WinbackKind): void {
  if (!POSTHOG_KEY) return;
  const pending = fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      event: 'winback_sent',
      distinct_id: distinctId,
      properties: { kind },
    }),
  }).then((res) => {
    if (!res.ok) console.error('[rc-winback-webhook] posthog capture failed', res.status);
  }).catch((e) => {
    console.error('[rc-winback-webhook] posthog capture threw', e instanceof Error ? e.message : String(e));
  });
  // @ts-ignore EdgeRuntime is a Supabase Deno runtime global, not in Deno types.
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(pending);
  }
}

/** Candidate identity ids, strongest first (Claude #8 / Codex #7). */
function identityCandidates(event: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v);
  };
  push(event.app_user_id);
  push(event.original_app_user_id);
  if (Array.isArray(event.aliases)) for (const a of event.aliases) push(a);
  const attrs = event.subscriber_attributes as Record<string, { value?: unknown }> | undefined;
  push(attrs?.['$posthogUserId']?.value);
  return out;
}

interface Profile {
  user_id: string;
  email: string;
  name: string | null;
}

/**
 * The profile this event is about, chosen by IDENTITY PRIORITY.
 *
 * `identityCandidates` emits strongest-first — app_user_id, then
 * original_app_user_id, then aliases, then the PostHog id — and that order is
 * the whole point: a webhook can carry identities belonging to more than one
 * account (a re-install, a shared device, an alias that outlived its owner).
 *
 * `.in(...)` is an unordered SET lookup, so pairing it with `.limit(1)` asked
 * Postgres for "any one of these" and then trusted whatever came back first.
 * When two profiles matched, a lower-priority identity could win — and the
 * chosen row is what receives the entitlement grant AND the email, so the wrong
 * person got both. Fetch every match, then pick by candidate order.
 */
async function resolveProfile(admin: SupabaseClient, candidates: string[]): Promise<Profile | null> {
  if (candidates.length === 0) return null;
  const { data, error } = await admin
    .from('nexus_profiles')
    .select('user_id, email, name')
    .in('user_id', candidates);
  if (error) {
    console.error('[rc-winback-webhook] profile lookup failed', error.message);
    return null;
  }
  const rows = (data ?? []) as Profile[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Worth seeing in the logs: it means the identities disagree about who this is.
    console.warn(
      `[rc-winback-webhook] ${rows.length} profiles match ${candidates.length} identities; taking the strongest`,
    );
  }
  // Strongest match WINS, whether or not it has an email. Falling through to a
  // lower-priority profile that happens to have one re-creates the very bug
  // this function was fixed for: the resolved row also receives the ledger
  // entry and the RevenueCat promotional GRANT, so "no email here, try the next
  // account" quietly moves a paid entitlement onto a different person. If the
  // subject has no email we simply cannot mail them — that is a skip, not a
  // reason to pick somebody else.
  for (const id of candidates) {
    const hit = rows.find((r) => r.user_id === id);
    if (hit) return hit;
  }
  return null;
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
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // Provider auth: RC's static Authorization header, constant-time compare.
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!WEBHOOK_AUTH || !secretEquals(token, WEBHOOK_AUTH)) {
      return json({ error: 'unauthorized' }, 401);
    }

    let body: { event?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const event = body?.event;
    if (!event || typeof event.id !== 'string' || event.id.length === 0) {
      return json({ error: 'missing_event' }, 400);
    }

    if (!SERVICE_ROLE_KEY) return json({ error: 'service_role_not_configured' }, 500);
    const admin = await getServiceRoleClient();

    // Inbound audit FIRST, but ON CONFLICT DO NOTHING and processing CONTINUES
    // on conflict: RC retries reuse the event id, and the send ledger is the
    // only side-effect dedupe. An audit short-circuit here would burn every
    // retry whose first attempt failed after the audit row landed (Claude #2).
    const { error: auditErr } = await admin.from('revenuecat_events').upsert({
      id: event.id,
      app_user_id: typeof event.app_user_id === 'string' ? event.app_user_id : null,
      type: typeof event.type === 'string' ? event.type : null,
      period_type: typeof event.period_type === 'string' ? event.period_type : null,
      environment: typeof event.environment === 'string' ? event.environment : null,
      cancel_reason: typeof event.cancel_reason === 'string' ? event.cancel_reason : null,
      expiration_reason: typeof event.expiration_reason === 'string' ? event.expiration_reason : null,
      payload: event,
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (auditErr) console.error('[rc-winback-webhook] audit insert failed', auditErr.message);

    // Kill switch — archived above, never acted on while dark.
    if (!ENABLED) return json({ skipped: 'disabled' });

    // Environment gate — sandbox events never send in prod; staging allows
    // them so the acceptance checklist can run (S10b).
    const env = typeof event.environment === 'string' ? event.environment : '';
    if (!ALLOWED_ENV.has(env)) return json({ skipped: 'environment', environment: env });

    const classification = classifyRcEvent(event);
    if (classification.action === 'ignore') return json({ skipped: classification.reason });
    const kind = classification.action;

    // Recipient: try every identity the webhook carries (S18).
    const profile = await resolveProfile(admin, identityCandidates(event));
    if (!profile) return json({ skipped: 'no_profile' });
    // The subject is decided by identity priority alone (see resolveProfile).
    // No address means we cannot write to THIS person — and picking a different
    // one would move the promotional grant with it, so this is a skip.
    if (!profile.email) {
      console.warn('[rc-winback-webhook] strongest identity has no email; skipping');
      return json({ skipped: 'no_email' });
    }

    // ── Reserve BEFORE any side effect (unique (kind, user_id)) ────────────
    const { error: resErr } = await admin.from('winback_send_log').insert({
      user_id: profile.user_id,
      kind,
      status: 'sending',
    });
    if (resErr) {
      if ((resErr as { code?: string }).code === '23505') {
        // Already reserved — do NOT re-send. This is also the ONLY path a retry
        // can take, so it is where a suppression marker lost by an earlier
        // attempt gets repaired; without that the marker was unrecoverable.
        //
        // But the reservation is taken BEFORE the send, so its existence alone
        // does NOT mean an email went out. Repairing unconditionally would
        // suppress trial_day_12/13 for a win-back the user never received —
        // silencing them entirely, which is worse than the duplicate this
        // marker exists to prevent.
        //
        // So repair only on POSITIVE EVIDENCE of a send. `finalize` writes
        // status='sent' + resend_id and runs BEFORE the marker, so the failure
        // this repairs (marker write failed after a good send) always leaves
        // that evidence behind. With no evidence we deliberately do not
        // suppress: the failure direction favours an extra trial email over
        // silence.
        const { data: prior } = await admin
          .from('winback_send_log')
          .select('status, resend_id')
          .eq('kind', kind)
          .eq('user_id', profile.user_id)
          .maybeSingle();
        const didSend = prior?.status === 'sent' || !!prior?.resend_id;
        if (!didSend) {
          console.warn(
            `[rc-winback-webhook] dedupe with no send evidence (status=${prior?.status ?? 'missing'}); not suppressing`,
          );
          return json({ ok: true, deduped: true, kind, suppressed: false });
        }
        const repairErr = await writeSuppressionMarker(admin, profile.user_id, kind, nowIso());
        if (repairErr) {
          console.error('[rc-winback-webhook] marker repair failed', repairErr);
          return json({ error: 'suppression_marker_failed', deduped: true, kind }, 500);
        }
        return json({ ok: true, deduped: true, kind, suppressed: true });
      }
      console.error('[rc-winback-webhook] reserve failed', resErr.message);
      return json({ error: 'reserve_failed' }, 500);
    }

    const releaseReservation = () =>
      admin.from('winback_send_log').delete().eq('kind', kind).eq('user_id', profile.user_id);
    const keepReservation = () =>
      admin.from('winback_send_log').update({ status: 'unknown', updated_at: new Date().toISOString() })
        .eq('kind', kind).eq('user_id', profile.user_id);

    // ── (b) grant BEFORE the email — the email only describes what is true ──
    if (kind === 'lapsed_offer') {
      const grant = await grantPromotionalMonth(profile.user_id);
      if (grant.kind === 'granted') {
        await admin.from('winback_send_log')
          .update({ granted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('kind', kind).eq('user_id', profile.user_id);
      } else if (grant.kind === 'definitive') {
        // The grant definitely did NOT happen → release, retryable (S15).
        await logAttempt(admin, {
          phase: 'create_failed', userId: profile.user_id, kind,
          errorCode: String(grant.status), errorMessage: 'rc_grant_definitive',
        });
        await releaseReservation();
        return json({ released: 'grant_definitive', status: grant.status });
      } else {
        // The grant may have landed → keep the reservation, NO email (never
        // promise an offer that may not have landed) (S15).
        await logAttempt(admin, {
          phase: 'ambiguous', userId: profile.user_id, kind, errorMessage: grant.error,
        });
        await keepReservation();
        return json({ held: 'grant_ambiguous' });
      }
    }

    // ── Send the email ──────────────────────────────────────────────────────
    const firstName = (profile.name ?? '').split(' ')[0];
    const email = winbackEmail(kind, {
      firstName,
      accessUntil: typeof event.expiration_at_ms === 'number'
        ? formatAccessUntil(event.expiration_at_ms)
        : undefined,
    });
    // ── Suppress BEFORE sending, for the same reason we reserve before ──────
    // Written here, not after, because a marker can only be lost by a write
    // that happens AFTER the thing it describes. Post-send, "Resend accepted
    // but both the finalize and the marker write failed" left a delivered email
    // with no durable trace, and the retry could not tell it from a reservation
    // that never sent — so it could neither suppress nor safely repair.
    //
    // Writing first inverts that: if the email goes out, the marker is already
    // there. The rollback below removes it on a DEFINITIVE failure (nothing was
    // sent), and an ambiguous failure keeps it, which is the same
    // may-have-happened logic the reservation already uses.
    const preErr = await writeSuppressionMarker(admin, profile.user_id, kind, nowIso());
    if (preErr) {
      console.error('[rc-winback-webhook] pre-send marker write failed', preErr);
      await logAttempt(admin, {
        phase: 'log_write_failed', userId: profile.user_id, kind, errorMessage: preErr,
      });
      // Nothing sent yet — release and let RevenueCat retry the whole thing.
      if (kind === 'trial_cancel_value') await releaseReservation();
      else await keepReservation();
      return json({ error: 'suppression_marker_failed_presend', kind }, 500);
    }

    const send = await sendResendEmail({
      to: profile.email,
      subject: email.subject,
      html: email.html,
      headers: email.headers,
    });

    if (send.kind === 'definitive') {
      await logAttempt(admin, {
        phase: 'create_failed', userId: profile.user_id, kind,
        errorCode: String(send.status), errorMessage: 'resend_definitive',
      });
      // Definitive: nothing was sent, so the pre-written marker is a lie and
      // would silence trial_day_12/13 for an email that never existed.
      await removeSuppressionMarker(admin, profile.user_id, kind);
      if (kind === 'trial_cancel_value') {
        // No side effect has happened → release, retryable.
        await releaseReservation();
        return json({ released: 'resend_definitive', status: send.status });
      }
      // lapsed_offer: the grant already landed — releasing would allow a
      // re-grant, and RC promotional grants stack. Keep (S16); the residual
      // is an under-sent email, the safe direction.
      await keepReservation();
      return json({ held: 'resend_definitive_after_grant', status: send.status });
    }
    if (send.kind === 'ambiguous') {
      await logAttempt(admin, {
        phase: 'ambiguous', userId: profile.user_id, kind, errorMessage: send.error,
      });
      await keepReservation();
      return json({ held: 'resend_ambiguous' });
    }

    // ── Finalize: ledger → email ecosystem log → metrics ────────────────────
    const now = new Date().toISOString();
    const { error: finErr } = await admin.from('winback_send_log').update({
      status: 'sent',
      resend_id: send.id,
      updated_at: now,
    }).eq('kind', kind).eq('user_id', profile.user_id);
    if (finErr) {
      // Sent but not finalized: the row stays 'sending' → at-most-once holds,
      // only the receipt is missing (same tradeoff as sendBroadcastSmsOnce).
      console.error('[rc-winback-webhook] finalize failed (email sent)', finErr.message);
      await logAttempt(admin, {
        phase: 'log_write_failed', userId: profile.user_id, kind, errorMessage: finErr.message,
      });
    }

    // nexus_email_log is the SUPPRESSION MARKER: email-scheduler skips
    // trial_day_12/13 when `winback-lapsed-offer` is present. Unlike the
    // finalize above, losing this is NOT a missing receipt — it causes a wrong
    // outbound action later, two conflicting emails to someone we just wrote to.
    // So it is the one write here that must be retried until it lands.
    const nelErr = await writeSuppressionMarker(admin, profile.user_id, kind, now, send.id);
    if (nelErr) {
      console.error('[rc-winback-webhook] nexus_email_log write failed', nelErr);
      await logAttempt(admin, {
        phase: 'log_write_failed', userId: profile.user_id, kind, errorMessage: nelErr,
      });
      captureWinbackSent(profile.user_id, kind);
      // 5xx so RevenueCat retries. The retry cannot re-send — the reservation
      // is held — and the dedupe branch above repairs the marker instead.
      return json({ error: 'suppression_marker_failed', kind, resend_id: send.id }, 500);
    }

    captureWinbackSent(profile.user_id, kind);
    return json({ ok: true, kind, resend_id: send.id });
  } catch (err) {
    console.error('[rc-winback-webhook] unexpected error', err);
    captureEdgeError(err, { fn: 'rc-winback-webhook', criticalPath: true, extra: { phase: 'handler' } });
    return json({ error: err instanceof Error ? err.message : 'unexpected' }, 500);
  }
});
