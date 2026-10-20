/**
 * NEX-323 (C6) — RevenueCat promotional entitlement grant for the (b) lapsed
 * win-back offer. Mirrors extend-trial/index.ts:110-121 exactly: encoded path
 * segments (the entitlement id "Nexus Pro" contains a space), X-Platform
 * header, and never forwarding upstream error bodies (they can carry
 * subscriber-level detail).
 *
 * Failure shapes are split the way the at-most-once ledger needs:
 *   - granted:    2xx — the entitlement is on their account
 *   - definitive: 4xx — RC rejected it; the grant did NOT happen → retryable
 *   - ambiguous:  5xx or a network throw — the grant may have landed → never
 *                 re-attempt blindly (a second grant would stack free months)
 */

import { ENTITLEMENT_ID } from './classify.ts';

const REVENUECAT_SECRET_KEY = Deno.env.get('REVENUECAT_SECRET_KEY') ?? '';
// RC v1 accepts: daily, three_day, weekly, two_week, monthly, two_month,
// three_month, six_month, yearly, lifetime (extend-trial/index.ts:29).
// (v1 `duration` is deprecated in RC v2 in favor of an explicit expires_at —
// noted in the spec; extend-trial uses v1 the same way.)
const DURATION = 'monthly';

export type GrantOutcome =
  | { kind: 'granted' }
  | { kind: 'definitive'; status: number }
  | { kind: 'ambiguous'; error: string };

export async function grantPromotionalMonth(appUserId: string): Promise<GrantOutcome> {
  if (!REVENUECAT_SECRET_KEY) {
    // Missing config is not a per-user rejection — treat as ambiguous so the
    // reservation is kept and an operator can fix the secret, not a released
    // retry storm.
    return { kind: 'ambiguous', error: 'revenuecat_secret_not_configured' };
  }

  const url =
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}` +
    `/entitlements/${encodeURIComponent(ENTITLEMENT_ID)}/promotional`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REVENUECAT_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'X-Platform': 'ios',
      },
      body: JSON.stringify({ duration: DURATION }),
    });
  } catch (e) {
    return { kind: 'ambiguous', error: e instanceof Error ? e.message : String(e) };
  }

  // Drain the body server-side for logs; never forward it anywhere.
  const body = await res.text();
  if (res.ok) return { kind: 'granted' };
  console.error('[rc-winback-webhook] RC grant error', res.status, body);
  if (res.status >= 400 && res.status < 500) return { kind: 'definitive', status: res.status };
  return { kind: 'ambiguous', error: `rc_http_${res.status}` };
}
