/**
 * Nexus Trial Extension
 * ────────────────────────────────────────────────────────────────────
 * Grants a 7-day promotional entitlement to a RevenueCat subscriber.
 * Called from the in-app cancel flow when a trial user accepts the
 * "Take another week" offer (NEX-98).
 *
 * Why server-side: the RC promotional entitlement endpoint requires a
 * secret API key (sk_*) which must not ship with the app binary.
 *
 * Security: every request must carry a Supabase JWT in the Authorization
 * header. We verify the JWT's user.id matches the payload's appUserId so
 * a caller can only extend their own trial — not anyone else's, and not
 * repeatedly on behalf of another account.
 *
 * Trigger: app calls this function from settings-screen.tsx when the
 *          accept button is tapped in the trial-extension modal.
 *
 * One extension per account (2026-10-18 security fix): before calling
 * RevenueCat we reserve a public.trial_extensions row keyed by user id. A
 * second call hits the primary key and gets 409 already_extended. Only a
 * definitive RevenueCat rejection releases the reservation; a lost response
 * keeps it (status 'unknown'), so the failure direction is under-grant.
 *
 * Env: REVENUECAT_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY,
 *      SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const REVENUECAT_SECRET_KEY = Deno.env.get('REVENUECAT_SECRET_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ENTITLEMENT_ID = 'Nexus Pro';
const DURATION = 'weekly'; // RC accepts: daily, three_day, weekly, two_week, monthly, two_month, three_month, six_month, yearly, lifetime

// Shared CORS headers — applied to every Response so browser-based test
// clients (Supabase dashboard, Postman web, etc.) can read the body of
// success AND error responses. React Native itself ignores CORS, so this
// has no production effect.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface Payload {
  appUserId: string;
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  if (!REVENUECAT_SECRET_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    console.error('[extend-trial] missing required env');
    return jsonResponse({ error: 'server_misconfigured' }, 500);
  }

  // ── 1. Identity verification ────────────────────────────────────────
  // The Supabase client SDK injects an Authorization: Bearer <jwt> header
  // when the user is logged in. We decode it with the anon key + Supabase
  // auth to confirm the caller's identity, then bind that identity to the
  // appUserId in the payload so a user can only extend their own trial.
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const token = authHeader.slice(7).trim();

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user?.id) {
    return jsonResponse({ error: 'invalid_token' }, 401);
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  if (!payload.appUserId) {
    return jsonResponse({ error: 'missing_app_user_id' }, 400);
  }

  // Bind caller identity to appUserId. The app passes `Purchases.getAppUserID()`
  // which is set from the Supabase auth user.id (see src/services/revenuecat.ts
  // configureRevenueCat + identifyUser). They MUST match — if they don't, the
  // caller is trying to grant an entitlement on someone else's account.
  if (userData.user.id !== payload.appUserId) {
    console.warn(
      '[extend-trial] caller/payload mismatch',
      { caller: userData.user.id, requested: payload.appUserId },
    );
    return jsonResponse({ error: 'forbidden' }, 403);
  }

  // ── 2. Reserve the one-per-account extension ────────────────────────
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: reserveError } = await admin
    .from('trial_extensions')
    .insert({ user_id: userData.user.id, status: 'granting' });
  if (reserveError) {
    if (reserveError.code === '23505') {
      return jsonResponse({ error: 'already_extended' }, 409);
    }
    console.error('[extend-trial] reservation failed', reserveError.code);
    return jsonResponse({ error: 'reservation_failed' }, 500);
  }
  const setStatus = (status: 'granted' | 'unknown') =>
    admin
      .from('trial_extensions')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('user_id', userData.user.id);
  const release = () => admin.from('trial_extensions').delete().eq('user_id', userData.user.id);

  // ── 3. RevenueCat promotional entitlement grant ─────────────────────
  const url = `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(payload.appUserId)}/entitlements/${encodeURIComponent(ENTITLEMENT_ID)}/promotional`;

  try {
    const rcRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REVENUECAT_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'X-Platform': 'ios',
      },
      body: JSON.stringify({ duration: DURATION }),
    });

    const rcBody = await rcRes.text();

    if (!rcRes.ok) {
      // Log the full RC error body server-side for debugging, but do NOT
      // forward it to the client — RC error payloads can contain
      // subscriber-level detail (product IDs, entitlement state).
      console.error('[extend-trial] RC error', rcRes.status, rcBody);
      // Definitive rejection: nothing was granted, so free the reservation
      // and let the person try again.
      await release();
      return jsonResponse({ error: 'revenuecat_error' }, 502);
    }

    await setStatus('granted');
    console.log('[extend-trial] granted 7-day extension to', payload.appUserId);
    return jsonResponse({ ok: true }, 200);
  } catch (e) {
    console.error('[extend-trial] fetch error', e);
    // Ambiguous: RevenueCat may have granted it before the response was
    // lost. Keep the reservation (never risk a second free week).
    await setStatus('unknown');
    return jsonResponse({ error: 'network_error' }, 502);
  }
});
