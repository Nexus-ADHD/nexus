/**
 * Nexus Trial Day-12 Nurture Email
 * ────────────────────────────────────────────────────────────────────
 * Sent on the 12th day of a user's trial — 1 day before trial ends.
 * Goal: urgency + value reinforcement before the paywall decision.
 *
 * Trigger: email-scheduler runs daily via pg_cron, checks trial_start + 12 days.
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
  daysLeft: number;       // always 1 — but dynamic so we can reuse for day-13
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
<title>Your trial ends tomorrow</title>
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

        <!-- Urgency label -->
        <tr>
          <td style=\"padding:0 0 32px;\">
            <p style=\"margin:0;color:#D4AF37;font-size:12px;font-weight:700;letter-spacing:1px;\">Your trial ends in ${p.daysLeft} day</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style=\"padding:0 0 28px;\">
            <p style=\"margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;\">
              Hey ${first},
            </p>
            ${hasStreak ? `
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              You've held a ${p.streakDays}-day streak on <strong style=\"color:#F0F0F0;\">${p.topHabit}</strong>. That didn't happen by accident — it happened because you showed up.
            </p>
            ` : `
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              Your Nexus trial ends tomorrow. You've built something here, even if it wasn't a streak yet.
            </p>
            `}
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              Nexus Pro is $9.99/month. No ads. No noise. Just a system that keeps measuring who you are against who you said you'd be.
            </p>
            <p style=\"margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;\">
              If you've been on the fence — tomorrow's the day. I'm not going to push harder than that.
            </p>
            <p style=\"margin:0;color:#B0B0B0;font-size:15px;line-height:26px;\">
              Either way, thanks for the time. I built this for people like you.
            </p>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style=\"padding:12px 0 40px;\" align=\"center\">
            <a href=\"${p.appUrl}\"
               style=\"display:inline-block;background:#D4AF37;color:#000;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;\">
              GO PRO — $9.99/mo
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
      console.error('[trial-day-12] RESEND_API_KEY not set');
      return new Response(JSON.stringify({ error: 'Email service not configured' }), { status: 500 });
    }

    const html = buildHtml(payload);
    const first = payload.userName?.split(' ')[0] || 'there';
    const subject = `Your trial ends tomorrow, ${first}`;

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
      console.error('[trial-day-12] Resend error:', errText);
      return new Response(JSON.stringify({ error: 'Failed to send email', detail: errText }), { status: 500 });
    }

    const data = await res.json();
    console.log('[trial-day-12] Sent:', data.id);

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[trial-day-12] Unexpected error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});