/**
 * Nexus Trial Day-13 — Trial Ended Email
 * ────────────────────────────────────────────────────────────────────
 * Sent when the 13-day trial ends and the user has NOT yet subscribed.
 * Goal: one last push with a gentle offer — no pressure, just clarity.
 *
 * Trigger: email-scheduler runs daily, sees trial_end passed + subscribed = false.
 * Env: RESEND_API_KEY
 */

import { isServiceRoleCaller } from '../_shared/caller-auth.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') ?? 'Nexus <hello@example.com>';

interface Payload {
  userEmail: string;
  userName: string;
  streakDays: number;
  topHabit: string;
  appUrl: string;
}

function buildHtml(p: Payload): string {
  const first = p.userName?.split(' ')[0] || 'there';
  const hasStreak = p.streakDays >= 1;

  return `<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"UTF-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<title>Your trial has ended — one offer</title>
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

        <!-- Body -->
        <tr>
          <td style=\"padding:0 0 28px;\">
            <p style=\"margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;\">
              Hey ${first},
            </p>
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              Your Nexus trial has ended.
            </p>
            ${hasStreak ? `
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              You built a ${p.streakDays}-day streak on <strong style=\"color:#F0F0F0;\">${p.topHabit}</strong>. That's real. That didn't go anywhere — it's still yours.
            </p>
            ` : `
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              You gave Nexus a real shot. Whether or not it clicked, I respect that.
            </p>
            `}
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              If there's one thing I'd ask — it's to give it one more week. Habits take longer than 13 days to actually form. Nexus Pro is $9.99/month. No ads. No noise. Just your system, uninterrupted.
            </p>
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              If it's not for you, totally fair. Unsubscribe from notifications and I'll stop reaching out. No hard feelings — I built this to help, not to pressure.
            </p>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style=\"padding:12px 0 40px;\" align=\"center\">
            <a href=\"${p.appUrl}\"
               style=\"display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;\">
              START PRO — $9.99/mo
            </a>
          </td>
        </tr>

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

    // Server-to-server only (email-scheduler renders these itself today, so
    // nothing legitimate calls this from outside). Without this gate anyone
    // could send branded mail with their own HTML and links to any address.
    if (!(await isServiceRoleCaller(req))) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }

    const payload: Payload = await req.json();

    if (!payload.userEmail) {
      return new Response(JSON.stringify({ error: 'userEmail required' }), { status: 400 });
    }

    if (!RESEND_API_KEY) {
      console.error('[trial-day-13] RESEND_API_KEY not set');
      return new Response(JSON.stringify({ error: 'Email service not configured' }), { status: 500 });
    }

    const html = buildHtml(payload);
    const first = payload.userName?.split(' ')[0] || 'there';
    const subject = `Your trial ended — one offer, no pressure`;

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
      console.error('[trial-day-13] Resend error:', errText);
      return new Response(JSON.stringify({ error: 'Failed to send email', detail: errText }), { status: 500 });
    }

    const data = await res.json();
    console.log('[trial-day-13] Sent:', data.id);

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[trial-day-13] Unexpected error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});