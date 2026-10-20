/**
 * Nexus Post-Purchase Confirmation Email
 * ────────────────────────────────────────────────────────────────────
 * Sent immediately after a user upgrades to Nexus Pro.
 * Includes a Calendly link for first 500 annual subscribers — the
 * contrarian bet from the GTM playbook: 1:1 onboarding call converts
 * trial users into long-term retained users.
 *
 * Trigger: called by the app when a purchase is confirmed (RevenueCat webhook
 *          or app-side purchase handler). Passed a purchased_plan hint so the
 *          Calendly CTA is only shown for annual subscribers.
 *
 * Env: RESEND_API_KEY
 */

import { captureEdgeError } from '../_shared/sentry.ts';
import { escapeHtml, firstNameFrom, requireUser } from '../_shared/caller-auth.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') ?? 'Nexus <hello@example.com>';
const CALENDLY_URL = Deno.env.get('ONBOARDING_CALL_URL') ?? 'https://example.com/book-a-call';
// The CTA link is fixed server-side; the request body never chooses it.
const APP_STORE_URL = 'https://apps.apple.com/app/id6761865566';

interface Payload {
  userEmail: string;
  userName: string;
  plan: 'monthly' | 'annual';
  appUrl: string;
}

function buildHtml(p: Payload): string {
  const first = escapeHtml(firstNameFrom(p.userName, 'there'));
  const isAnnual = p.plan === 'annual';
  const showCalendly = isAnnual; // Calendly offer only for annual subscribers

  return `<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"UTF-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<title>You're in — welcome to Nexus Pro</title>
</head>
<body style=\"margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\">
<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#000;padding:40px 0;\">
  <tr>
    <td align=\"center\">
      <table width=\"560\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;width:100%;\">

        <!-- Header -->
        <tr>
          <td style=\"padding:0 0 40px;text-align:center;\">
            <p style=\"margin:0;color:#D4AF37;font-size:11px;font-weight:900;letter-spacing:6px;\">N E X U S</p>
          </td>
        </tr>

        <!-- Plan label -->
        <tr>
          <td style=\"padding:0 0 32px;\">
            <p style=\"margin:0;color:#B0B0B0;font-size:13px;letter-spacing:0.5px;\">${isAnnual ? 'Annual' : 'Monthly'} Pro · Activated</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style=\"padding:0 0 28px;\">
            <p style=\"margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;\">
              Hey ${first},
            </p>
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              You're in. Nexus Pro is now active — no ads, no friction, full access.
            </p>
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              What you just did matters. You chose to invest in a system that measures your days against your standards. That's not a small decision — it's an identity-level one.
            </p>
            ${showCalendly ? `
            <!-- Calendly offer — annual subscribers only -->
            <p style=\"margin:0 0 20px;color:#F0F0F0;font-size:15px;line-height:26px;font-weight:600;\">
              One more thing:
            </p>
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              I'm offering a 20-minute 1:1 call — no pitch, no sales. Just me walking through how to get the most out of Nexus Pro based on how you use it. It's completely free and completely optional.
            </p>
            <p style=\"margin:0 0 28px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              If you're interested, book a time below. First 500 annual subscribers only — I'll keep my word on that.
            </p>
            ` : `
            <p style=\"margin:0 0 28px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              Everything you need is already in the app. Your history is preserved, your streaks remain intact. Go build on top of what you started.
            </p>
            `}
          </td>
        </tr>

        <!-- CTAs -->
        <tr>
          <td style=\"padding:0 0 16px;\" align=\"center\">
            <a href=\"${APP_STORE_URL}\"
               style=\"display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;\">
              OPEN NEXUS
            </a>
          </td>
        </tr>
        ${showCalendly ? `
        <tr>
          <td style=\"padding:0 0 40px;\" align=\"center\">
            <a href=\"${CALENDLY_URL}\"
               style=\"display:inline-block;border:1px solid #333;color:#888;font-size:12px;font-weight:600;letter-spacing:1px;padding:12px 32px;border-radius:30px;text-decoration:none;\">
              BOOK A 1:1 ONBOARDING CALL →
            </a>
          </td>
        </tr>
        ` : `
        <tr><td style=\"height:40px;\"></td></tr>
        `}

        <!-- Footer -->
        <tr>
          <td style=\"text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;\">
            <p style=\"margin:0;color:#2A2A2A;font-size:11px;letter-spacing:1px;\">Nexus · Built for the intentional</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
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

    // Only a signed-in user can trigger this, and only to their own address:
    // the recipient comes from the verified token, never the body.
    const caller = await requireUser(req);
    if (caller instanceof Response) return caller;
    if (!caller.email) {
      return new Response(JSON.stringify({ error: 'no_email_on_account' }), { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const payload: Payload = {
      userEmail: caller.email,
      userName: firstNameFrom(body?.userName, ''),
      plan: body?.plan === 'annual' ? 'annual' : 'monthly',
      appUrl: APP_STORE_URL,
    };

    if (!RESEND_API_KEY) {
      console.error('[post-purchase-confirm] RESEND_API_KEY not set');
      // Non-throwing 500 — capture explicitly (it never reaches the catch below).
      captureEdgeError(new Error('post-purchase-confirm: RESEND_API_KEY not configured'), {
        fn: 'post-purchase-confirm',
        criticalPath: true,
        extra: { reason: 'resend_not_configured' },
      });
      return new Response(JSON.stringify({ error: 'Email service not configured' }), { status: 500 });
    }

    const html = buildHtml(payload);
    const first = firstNameFrom(payload.userName, 'there');
    const subject = `You're in, ${first} — welcome to Nexus Pro`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [payload.userEmail],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[post-purchase-confirm] Resend error:', errText);
      // Non-throwing 500 — capture explicitly. Do NOT include errText: Resend
      // error bodies can echo the recipient email (PII). Status code only.
      captureEdgeError(new Error('post-purchase-confirm: Resend send failed'), {
        fn: 'post-purchase-confirm',
        criticalPath: true,
        extra: { reason: 'resend_send_failed', status: res.status },
      });
      return new Response(JSON.stringify({ error: 'Failed to send email', detail: errText }), { status: 500 });
    }

    const data = await res.json();
    console.log('[post-purchase-confirm] Sent:', data.id);

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[post-purchase-confirm] Unexpected error:', err);
    // Capture the real exception (message + stack). Conscious no-PII call: the
    // throw sites here are req.json() parse errors and the Resend network fetch,
    // neither of which interpolates the userEmail/userName payload into a message.
    captureEdgeError(err, { fn: 'post-purchase-confirm', criticalPath: true, extra: { phase: 'handler' } });
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});