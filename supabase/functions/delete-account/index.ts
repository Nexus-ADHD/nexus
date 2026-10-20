/**
 * Nexus Account Deletion — Supabase Edge Function (NEX-155)
 * ────────────────────────────────────────────────────────────────────
 * Permanently deletes the caller's account: all Supabase rows scoped to
 * their user_id, the Supabase auth identity itself, and best-effort
 * vendor-side data (PostHog, RevenueCat).
 *
 * Why server-side: the previous in-app flow only ran
 * `user_state.delete()` + `signOut()`, leaving the profile (email/phone),
 * the analytics event log, and the auth user alive — a deletion the app
 * called "permanent" but wasn't. Truly deleting requires the service-role
 * key and the auth admin API, neither of which can ship in the binary.
 *
 * Security: the user is identified from their Supabase JWT (never from a
 * body-supplied id), so a caller can only ever delete themselves.
 *
 * Idempotent / partial-tolerant: each step's result is collected and the
 * flow never aborts on a single failure. Only a missing/invalid JWT is
 * fatal. The client logs the returned `steps`.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *      (vendor, optional) POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID,
 *      POSTHOG_HOST, REVENUECAT_SECRET_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { captureEdgeError } from '../_shared/sentry.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const POSTHOG_API_KEY = Deno.env.get('POSTHOG_PERSONAL_API_KEY') ?? '';
const POSTHOG_PROJECT_ID = Deno.env.get('POSTHOG_PROJECT_ID') ?? '';
const POSTHOG_HOST = (Deno.env.get('POSTHOG_HOST') ?? 'https://us.posthog.com').replace(/\/$/, '');
const REVENUECAT_SECRET_KEY = Deno.env.get('REVENUECAT_SECRET_KEY') ?? '';

// Every public table that carries a user_id. Deletion order puts the PII
// (email in nexus_profiles, phone in user_profile) first. nexus_events and
// nexus_activation_daily also cascade from auth.users ON DELETE CASCADE, so
// the explicit deletes here are a belt-and-suspenders backstop that also
// guarantees data is gone even if the auth-user delete fails.
const USER_TABLES = [
  'nexus_profiles',        // email, name, trial dates
  'user_profile',          // phone_number
  'sms_opt_in',            // phone_number + SMS consent state (NEX-86)
  'sms_send_log',          // phone_number + message previews (NEX-86) — FK is
                           // ON DELETE SET NULL, so without this explicit
                           // delete the phone PII would outlive the account
  'sms_send_attempt_log',  // phone_number + failure detail (NEX-319) — same
                           // ON DELETE SET NULL shape as sms_send_log, so it
                           // needs the same explicit purge
  'user_state',            // app state blob
  'nexus_email_log',       // email send log
  'nexus_events',          // raw analytics event log
  'nexus_activation_daily', // per-day activation rollup
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Delete the PostHog person (by distinct_id = user.id) and their events.
// Requires a personal API key + project id; skipped if unconfigured.
async function deletePostHogPerson(userId: string): Promise<string> {
  if (!POSTHOG_API_KEY || !POSTHOG_PROJECT_ID) return 'skipped: not configured';
  const auth = { Authorization: `Bearer ${POSTHOG_API_KEY}` };
  const lookup = await fetch(
    `${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/persons/?distinct_id=${encodeURIComponent(userId)}`,
    { headers: auth },
  );
  if (!lookup.ok) return `error: lookup ${lookup.status}`;
  const body = await lookup.json() as { results?: { id: number | string }[] };
  const person = body.results?.[0];
  if (!person) return 'ok: no person found';
  const del = await fetch(
    `${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/persons/${person.id}/?delete_events=true`,
    { method: 'DELETE', headers: auth },
  );
  return del.ok ? 'ok' : `error: delete ${del.status}`;
}

// Delete the RevenueCat subscriber (app_user_id = user.id). Skipped if
// unconfigured. A 404 means there was nothing to delete — treat as ok.
async function deleteRevenueCatSubscriber(userId: string): Promise<string> {
  if (!REVENUECAT_SECRET_KEY) return 'skipped: not configured';
  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${REVENUECAT_SECRET_KEY}` } },
  );
  if (res.ok || res.status === 404) return 'ok';
  return `error: ${res.status}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    console.error('[delete-account] missing required env');
    // Critical path down for everyone — a bad deploy / secret rotation must alert.
    captureEdgeError(new Error('delete-account: Supabase credentials not configured'), {
      fn: 'delete-account',
      criticalPath: true,
      extra: { reason: 'supabase_creds_missing' },
    });
    return jsonResponse({ error: 'server_misconfigured' }, 500);
  }

  try {
    // ── 1. Identify the caller from their JWT (never trust a body id) ────
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    const token = authHeader.slice(7).trim();
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userError } = await anon.auth.getUser(token);
    if (userError || !userData?.user?.id) {
      return jsonResponse({ error: 'invalid_token' }, 401);
    }
    const userId = userData.user.id;

    // ── 2. Service-role client (bypasses RLS) ───────────────────────────
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const steps: Record<string, string> = {};

    // ── 3. Delete every user-scoped row, collecting per-step results ────
    for (const table of USER_TABLES) {
      try {
        const { error } = await admin.from(table).delete().eq('user_id', userId);
        steps[table] = error ? `error: ${error.message}` : 'ok';
      } catch (e) {
        steps[table] = `error: ${(e as Error).message}`;
      }
    }

    // The auth identity itself. Sign-out is not deletion.
    try {
      const { error } = await admin.auth.admin.deleteUser(userId);
      steps.auth_user = error ? `error: ${error.message}` : 'ok';
    } catch (e) {
      steps.auth_user = `error: ${(e as Error).message}`;
    }

    // ── 4. Vendor-side, best-effort, never fatal ────────────────────────
    try {
      steps.posthog = await deletePostHogPerson(userId);
    } catch (e) {
      steps.posthog = `error: ${(e as Error).message}`;
    }
    try {
      steps.revenuecat = await deleteRevenueCatSubscriber(userId);
    } catch (e) {
      steps.revenuecat = `error: ${(e as Error).message}`;
    }
    // AI proxy / Braintrust: metrics-only by constraint — no user *content*
    // is retained there, so there is nothing to delete today.
    steps.braintrust = 'skipped: metrics-only, no user content';

    // ── 5. Surface partial failures (NEX-134) ───────────────────────────
    // This flow is partial-tolerant by design: it returns 200 even when some
    // step failed. That's correct for the client (it must not retry-loop), but a
    // failed Supabase row delete is an irreversible-data-path failure we MUST
    // see. Capture when any step errored. No PII in extras: only the failed-step
    // KEYS (table/vendor names) go to Sentry — the raw error strings are omitted
    // (a constraint/admin error message can echo identifiers), as is the userId.
    // The Supabase log (above) keeps the full `steps` for correlated triage.
    const failedSteps = Object.entries(steps)
      .filter(([, v]) => v.startsWith('error:'))
      .map(([k]) => k);
    if (failedSteps.length > 0) {
      captureEdgeError(new Error(`delete-account: partial failure [${failedSteps.join(', ')}]`), {
        fn: 'delete-account',
        criticalPath: true,
        extra: { failedSteps },
      });
    }

    console.log('[delete-account] done', userId, JSON.stringify(steps));
    return jsonResponse({ ok: true, steps }, 200);
  } catch (err) {
    // Unexpected throw before/around the step loop (e.g. anon.auth.getUser
    // throwing instead of returning { error }) — would otherwise be an uncaught
    // 500 with no telemetry. Capture, then return the same 500 shape. No PII:
    // phase tag only (the userId may not even be resolved yet).
    console.error('[delete-account] unexpected error:', err);
    captureEdgeError(err, { fn: 'delete-account', criticalPath: true, extra: { phase: 'handler' } });
    return jsonResponse({ error: 'server_error' }, 500);
  }
});
