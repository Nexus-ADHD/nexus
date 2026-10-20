/**
 * Nexus Account Export — Supabase Edge Function (NEX-155)
 * ────────────────────────────────────────────────────────────────────
 * Returns every row Nexus holds for the caller, as JSON. Satisfies the
 * GDPR/CCPA access ("export my data") right and pairs with the policy's
 * export language. The set returned here mirrors exactly what
 * delete-account removes, so "export" and "delete" describe the same data.
 * (NEX-320: the three sms_* tables were added to delete-account after this
 * function shipped and were missing here until NEX-320 restored parity.
 * Keep USER_TABLES in sync with delete-account's list.)
 *
 * Security: the user is identified from their Supabase JWT, so a caller
 * can only ever export their own data.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Same user-scoped tables delete-account removes. `orderBy` gives a stable
// sort for multi-page tables so .range() pagination can't dupe/gap rows. Only
// the append-only tables need it; the rest are one-or-few rows per user and
// have no in-repo schema, so they use a count guard instead of a hardcoded
// (and possibly wrong) order column.
interface TableSpec {
  name: string;
  orderBy?: string[];
}
const USER_TABLES: TableSpec[] = [
  { name: 'nexus_profiles' },
  { name: 'user_profile' },
  { name: 'sms_opt_in' },
  { name: 'sms_send_log', orderBy: ['created_at', 'id'] },
  { name: 'sms_send_attempt_log', orderBy: ['created_at', 'id'] },
  { name: 'user_state' },
  { name: 'nexus_email_log' },
  { name: 'nexus_events', orderBy: ['event_ts', 'event_id'] },
  { name: 'nexus_activation_daily', orderBy: ['day_key'] },
];

const PAGE = 1000;

type FetchResult =
  | { rows: unknown[]; warning?: string }
  | { error: string };

// Read every row for `userId` from one table. Tables with a stable `orderBy`
// are paginated to completion via .range(). Tables without one are read as a
// single page with an exact count; if more than one page exists we refuse to
// paginate unordered (would risk dupes/gaps) and flag a warning instead.
async function fetchTable(
  // deno-lint-ignore no-explicit-any
  admin: any,
  spec: TableSpec,
  userId: string,
): Promise<FetchResult> {
  if (!spec.orderBy?.length) {
    const { data: rows, error, count } = await admin
      .from(spec.name)
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .range(0, PAGE - 1);
    if (error) return { error: error.message };
    const result: { rows: unknown[]; warning?: string } = { rows: rows ?? [] };
    if (typeof count === 'number' && count > PAGE) {
      result.warning = `truncated: ${count} rows, returned first ${PAGE} (no stable sort key)`;
    }
    return result;
  }

  const all: unknown[] = [];
  let from = 0;
  for (;;) {
    let query = admin.from(spec.name).select('*').eq('user_id', userId);
    for (const col of spec.orderBy) query = query.order(col, { ascending: true });
    const { data: rows, error } = await query.range(from, from + PAGE - 1);
    if (error) return { error: error.message };
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return { rows: all };
}

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    console.error('[export-account] missing required env');
    return jsonResponse({ error: 'server_misconfigured' }, 500);
  }

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

  // Service-role read so the export is complete regardless of RLS shape.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const data: Record<string, unknown> = {};
  const warnings: Record<string, string> = {};
  for (const spec of USER_TABLES) {
    const result = await fetchTable(admin, spec, userId);
    if ('error' in result) {
      data[spec.name] = { error: result.error };
      warnings[spec.name] = result.error;
    } else {
      data[spec.name] = result.rows;
      if (result.warning) warnings[spec.name] = result.warning;
    }
  }

  const hasWarnings = Object.keys(warnings).length > 0;
  return jsonResponse(
    {
      exportedAt: new Date().toISOString(),
      userId,
      data,
      complete: !hasWarnings,
      ...(hasWarnings ? { warnings } : {}),
    },
    200,
  );
});
