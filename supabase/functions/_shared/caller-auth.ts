/**
 * Caller authentication for edge functions deployed with verify_jwt=false.
 * ────────────────────────────────────────────────────────────────────
 * These functions are reachable by anyone who knows the URL, so each one
 * must establish WHO is calling before it acts:
 *
 *   - requireUser(req): the caller must present a real signed-in user's
 *     access token. The anon key is not a user, so it is rejected. Returns
 *     the verified { id, email } or a ready-to-send 401 Response.
 *   - isServiceRoleCaller(req): the caller presented the project's service
 *     role key (server-to-server, e.g. pg_cron). Constant-time compare.
 *
 * Callers must take identity (user id, recipient email) from the verified
 * user, never from the request body. 2026-10-18 security fix: upsert-profile
 * and the lifecycle email functions trusted body fields with no auth.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export interface VerifiedUser {
  id: string;
  email: string | null;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization') ?? req.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

function jsonError(error: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export async function requireUser(
  req: Request,
  headers: Record<string, string> = {},
): Promise<VerifiedUser | Response> {
  const token = bearerToken(req);
  if (!token) return jsonError('unauthorized', 401, headers);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[caller-auth] SUPABASE_URL / SUPABASE_ANON_KEY not set');
    return jsonError('server_misconfigured', 500, headers);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) return jsonError('invalid_token', 401, headers);
  return { id: data.user.id, email: data.user.email ?? null };
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * True when the caller presented the project's service-role key.
 *
 * The env SUPABASE_SERVICE_ROLE_KEY can be the NEW secret key (sb_secret_...)
 * while pg_cron jobs still send the LEGACY service_role JWT, so an exact match
 * alone would lock the cron out (it did on 2026-10-18, caught before any run).
 * A token that is not the env key but CLAIMS role=service_role is verified by
 * asking our own auth server to do something only a service-role key can do.
 * The claim alone proves nothing (anyone can write a payload); the signature
 * check happens server-side in that call.
 */
export async function isServiceRoleCaller(req: Request): Promise<boolean> {
  const token = bearerToken(req);
  if (!token) return false;
  if (SERVICE_ROLE_KEY && constantTimeEqual(token, SERVICE_ROLE_KEY)) return true;
  if (jwtRole(token) !== 'service_role' || !SUPABASE_URL) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A display first name from an untrusted string: control characters out,
 * whitespace collapsed, first word only, capped. Plain text (escape it
 * separately before putting it in HTML).
 */
export function firstNameFrom(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // deno-lint-ignore no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const first = cleaned.split(' ')[0] ?? '';
  return first.length > 0 ? first.slice(0, 40) : fallback;
}
