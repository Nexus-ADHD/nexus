/**
 * Nexus Welcome Email — Supabase Edge Function
 * Called once on first app activation when activatedDate is set.
 */

import { escapeHtml, firstNameFrom, requireUser } from '../_shared/caller-auth.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
// The CTA link is fixed server-side; the request body never chooses it.
const APP_STORE_URL = 'https://apps.apple.com/app/id6761865566';
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') ?? 'Nexus <hello@example.com>';

interface Payload {
  userEmail: string;
  userName: string;
  appUrl: string;
}

function buildWelcomeHtml(p: Payload): string {
  const firstName = escapeHtml(firstNameFrom(p.userName, 'there'));

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to Nexus</title>
</head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:40px 0;">
  <tr>
    <td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="padding:0 0 40px;text-align:center;">
            <p style="margin:0;color:#D4AF37;font-size:11px;font-weight:900;letter-spacing:6px;">N E X U S</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:0 0 28px;">
            <p style="margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;">
              Hey ${firstName},
            </p>
            <p style="margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;">
              We built Nexus because we got tired of productivity tools that tracked tasks but never measured who we were becoming.
            </p>
            <p style="margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;">
              Nexus is different. Every habit you log feeds your daily discipline score. Every day compounds. Over time, the score doesn't just reflect what you did — it reflects who you're becoming.
            </p>
            <p style="margin:0 0 8px;color:#F0F0F0;font-size:15px;line-height:26px;font-weight:600;">
              One thing to do today:
            </p>
            <p style="margin:0 0 28px;color:#B0B0B0;font-size:15px;line-height:26px;">
              Log your first habit. Your discipline score updates the moment you do. Check it tonight and you'll see exactly where you stand. That number is yours — and it only moves when you move.
            </p>
            <p style="margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;">
              We read every reply to this email. If something isn't working, or you have a question, just write back.
            </p>
            <p style="margin:0;color:#B0B0B0;font-size:15px;line-height:26px;">
              Welcome to the work.
            </p>
            <p style="margin:16px 0 0;color:#F0F0F0;font-size:15px;">
              Circle of Light
            </p>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:12px 0 40px;" align="center">
            <a href="${APP_STORE_URL}"
               style="display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;">
              OPEN NEXUS
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;">
            <p style="margin:0;color:#2A2A2A;font-size:11px;letter-spacing:1px;">Nexus · Built for the intentional</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
  `.trim();
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
      appUrl: APP_STORE_URL,
    };

    if (!RESEND_API_KEY) {
      console.error('[welcome-email] RESEND_API_KEY not set');
      return new Response(JSON.stringify({ error: 'Email service not configured' }), { status: 500 });
    }

    const html = buildWelcomeHtml(payload);
    const subject = `Welcome to Nexus, ${firstNameFrom(payload.userName, 'friend')}.`;

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
      console.error('[welcome-email] Resend error:', errText);
      return new Response(JSON.stringify({ error: 'Failed to send email', detail: errText }), { status: 500 });
    }

    const data = await res.json();
    console.log('[welcome-email] Email sent:', data.id);

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[welcome-email] Unexpected error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
