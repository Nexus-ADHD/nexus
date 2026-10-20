/**
 * Nexus Upsert Profile — Supabase Edge Function
 * ────────────────────────────────────────────────────────────────────
 * Called by the app when:
 *   1. User first activates (sets activatedDate) → creates the nexus_profiles row
 *   2. Purchase confirmed → updates plan_type to monthly/annual, sets subscribed=true
 *
 * This function is the write path to nexus_profiles. It should be the ONLY
 * place in the edge function layer that writes to that table.
 *
 * Usage from app (src/services/nexus-profiles.ts):
 *   await supabase.functions.invoke('upsert-profile', {
 *     body: {
 *       trigger: 'activation' | 'purchase',
 *       userId: user.id,
 *       email: user.email,
 *       name: user.name,
 *       plan: 'trial' | 'monthly' | 'annual',
 *       subscribed: boolean,
 *     }
 *   })
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { captureEdgeError } from '../_shared/sentry.ts';
import { requireUser } from '../_shared/caller-auth.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

interface Payload {
  trigger:    'activation' | 'purchase';
  userId:     string;
  email:      string;
  name:       string;
  plan:       'trial' | 'monthly' | 'annual';
  subscribed: boolean;
}

async function getServiceRoleClient() {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
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

    if (!SERVICE_ROLE_KEY) {
      console.error('[upsert-profile] SUPABASE_SERVICE_ROLE_KEY not set');
      // Only edge writer of nexus_profiles — a bad deploy here fails every
      // activation/purchase write. Alert. No PII (reason enum only).
      captureEdgeError(new Error('upsert-profile: SUPABASE_SERVICE_ROLE_KEY not configured'), {
        fn: 'upsert-profile',
        criticalPath: true,
        extra: { reason: 'service_role_missing' },
      });
      return new Response(JSON.stringify({ error: 'Server configuration error' }), { status: 500 });
    }

    // The caller must be the signed-in user whose row this is. The row's
    // user_id and email come from the verified token, never the body:
    // before 2026-10-18 anyone could overwrite any user's email here.
    const caller = await requireUser(req);
    if (caller instanceof Response) return caller;

    const payload: Payload = await req.json();

    if (!payload.userId) {
      return new Response(JSON.stringify({ error: 'userId is required' }), { status: 400 });
    }
    if (payload.userId !== caller.id) {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }
    if (!caller.email) {
      return new Response(JSON.stringify({ error: 'no_email_on_account' }), { status: 400 });
    }
    if (!['trial', 'monthly', 'annual'].includes(payload.plan)) {
      return new Response(JSON.stringify({ error: 'invalid_plan' }), { status: 400 });
    }
    if (payload.trigger !== 'activation' && payload.trigger !== 'purchase') {
      return new Response(JSON.stringify({ error: 'invalid_trigger' }), { status: 400 });
    }

    const sb = await getServiceRoleClient();

    // Build row values
    const row: Record<string, unknown> = {
      user_id:    caller.id,
      email:      caller.email,
      name:       typeof payload.name === 'string' ? payload.name.slice(0, 120) : undefined,
      plan_type:  payload.plan,
      subscribed: payload.subscribed === true,
      updated_at: new Date().toISOString(),
    };

    // On activation: set trial_start and trial_end (+13 days)
    if (payload.trigger === 'activation' && payload.plan === 'trial') {
      const trialStart = new Date();
      const trialEnd   = new Date(trialStart);
      trialEnd.setDate(trialEnd.getDate() + 13);
      row.trial_start = trialStart.toISOString();
      row.trial_end   = trialEnd.toISOString();
    }

    // On purchase: set purchased_at timestamp
    if (payload.trigger === 'purchase') {
      row.purchased_at = new Date().toISOString();
    }

    const { error } = await sb
      .from('nexus_profiles')
      .upsert(row, { onConflict: 'user_id' });

    if (error) {
      console.error('[upsert-profile] Upsert error:', error.message);
      // Critical write path failed (this fn is the ONLY writer of nexus_profiles).
      // No PII in extras: trigger/plan are enums; error.code is the Postgres
      // SQLSTATE (e.g. 23505). Do NOT include error.message — a unique/check
      // violation can echo the offending value (the email) in its message.
      captureEdgeError(new Error(`upsert-profile: nexus_profiles upsert failed`), {
        fn: 'upsert-profile',
        criticalPath: true,
        extra: { trigger: payload.trigger, plan: payload.plan, dbErrorCode: error.code },
      });
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    console.log(`[upsert-profile] ${payload.trigger}: ${caller.id} (${payload.plan}) subscribed=${payload.subscribed}`);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[upsert-profile] Fatal error:', err);
    // Capture the real exception (message + stack) — needed to debug an
    // unexpected throw. Conscious no-PII call: the only throw sites here are
    // req.json() parse errors and network/import failures, none of which
    // interpolate the email/name payload into their message.
    captureEdgeError(err, { fn: 'upsert-profile', criticalPath: true, extra: { phase: 'handler' } });
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});