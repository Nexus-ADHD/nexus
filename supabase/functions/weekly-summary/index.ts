/**
 * Nexus Weekly Summary — Supabase Edge Function
 * ────────────────────────────────────────────────────────────────────
 * Sends a weekly digest email via Resend from a fully-formed payload. The
 * caller must be signed in, opted in in persisted state, and can send only to
 * the server-owned address attached to that account.
 *
 * As of the server-cron migration, the PRIMARY path is
 * `weekly-summary-scheduler` (pg_cron, recomputes the digest from user_state).
 * This function remains the client-invoked BACKSTOP: the RN app
 * (src/services/weekly-email.ts) still calls it via
 * supabase.functions.invoke('weekly-summary', { body: payload }).
 *
 * The HTML template + subject + Resend send live in
 * supabase/functions/_shared/weekly-summary-email.ts so this function and the
 * scheduler share one template (no duplication).
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveConsentedWeeklyEmailRecipient } from '../_shared/weekly-email-consent.ts';
import {
  sendWeeklySummaryEmail,
  type WeeklySummaryPayload,
} from '../_shared/weekly-summary-email.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    if (req.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !RESEND_API_KEY) {
      console.error('[weekly-summary] Required server environment is not configured');
      return json({ error: 'server_misconfigured' }, 500);
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return json({ error: 'unauthorized' }, 401);
    }
    const token = authHeader.slice(7).trim();
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData?.user?.id) return json({ error: 'unauthorized' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const userId = userData.user.id;
    const [stateResult, profileResult] = await Promise.all([
      admin.from('user_state').select('state_data').eq('user_id', userId).maybeSingle(),
      admin.from('nexus_profiles').select('email, name').eq('user_id', userId).maybeSingle(),
    ]);
    if (stateResult.error || profileResult.error) {
      console.error('[weekly-summary] Account state lookup failed', {
        state: stateResult.error?.message,
        profile: profileResult.error?.message,
      });
      return json({ error: 'account_lookup_failed' }, 500);
    }

    const recipient = resolveConsentedWeeklyEmailRecipient({
      stateData: stateResult.data?.state_data,
      profileEmail: profileResult.data?.email,
      authEmail: userData.user.email,
    });
    if (!recipient) return json({ error: 'weekly_email_consent_required' }, 403);

    const callerPayload: WeeklySummaryPayload = await req.json();
    const payload: WeeklySummaryPayload = {
      ...callerPayload,
      userEmail: recipient,
      userName: profileResult.data?.name || callerPayload.userName,
    };

    const id = await sendWeeklySummaryEmail(payload, RESEND_API_KEY);
    console.log('[weekly-summary] Email sent:', id);

    return json({ success: true, id });
  } catch (err: unknown) {
    console.error('[weekly-summary] Unexpected error:', err);
    return json({ error: err instanceof Error ? err.message : 'unexpected_error' }, 500);
  }
});
