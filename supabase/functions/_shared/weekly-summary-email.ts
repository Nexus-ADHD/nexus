/**
 * Shared weekly-summary email: payload type, HTML template, subject, and the
 * Resend send. Single source of truth so both `weekly-summary` (client-invoked
 * backstop) and `weekly-summary-scheduler` (server cron, the primary path) use
 * the SAME template — no duplication. The HTML originated in `weekly-summary/index.ts`;
 * NEX-270 reskinned it to the v3 "stellar" palette + a cosmic background so it matches the app.
 */

export interface WeeklySummaryPayload {
  userEmail: string;
  userName: string;
  weekLabel: string;
  habitsCompleted: number;
  habitsMissed: number;
  completionRate: number;
  topStreaks: { habit: string; days: number }[];
  longestStreakDays: number;
  longestStreakHabit: string;
  disciplineScoreAvg: number;
  motivationalTip: string;
  appUrl: string;
}

/**
 * Escape user-authored text before interpolating into the email HTML. Habit
 * names and the profile display name are user-controlled; without escaping a
 * name like `</td><script>` would corrupt the table layout (and some clients
 * render injected markup).
 */
function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// NEX-270: cosmic background for the weekly email — a static, pre-darkened galaxy JPG so the
// email reads as the same "made of starlight" material as the app (CLAUDE.md §1). Email clients
// can't run the in-app animated StarField, so this is a hosted image with a solid #06060C floor
// + an Apple-Mail gradient fallback (see the <head> <style> and the wrapper-table inline bg).
//
// The URL is derived from SUPABASE_URL, which the Supabase edge runtime always injects — so real
// sends always use the correct (prod/staging) host. The fallback is only ever reached in Node-side
// tests/preview, where no email is delivered; it's a localhost sentinel so a missing-env regression
// fails loudly/visibly instead of silently shipping a prod URL. (To preview the real image locally,
// set SUPABASE_URL.) Versioned filename — never overwrite (email/CDN caches are aggressive); bump to -v2 to change
// the art. Hosted in the public `email-assets` bucket (see migration). The repo's
// assets/email/cosmic-bg-v1.jpg is the source of record (same basename as the storage object);
// the email loads it from Storage, not the repo. Upload the object with:
//   supabase storage cp ./assets/email/cosmic-bg-v1.jpg ss:///email-assets/weekly/cosmic-bg-v1.jpg
// Read env via globalThis (not a bare `Deno` reference) so this stays typecheckable in the RN
// program that imports it for tests — `Deno` isn't a declared name there. In the edge runtime
// globalThis.Deno is present; in Node-side preview/tests it's undefined → the prod fallback.
const denoEnv = (globalThis as { Deno?: { env: { get(key: string): string | undefined } } }).Deno?.env;
const SUPABASE_URL = denoEnv?.get('SUPABASE_URL') ?? 'http://localhost:54321';
const COSMIC_BG_URL = `${SUPABASE_URL}/storage/v1/object/public/email-assets/weekly/cosmic-bg-v1.jpg`;

export function buildWeeklySummaryHtml(p: WeeklySummaryPayload): string {
  // NEX-192 / §1.5 Law B: cumulative, non-breakable framing only. We surface the
  // habits the user is leaning on by name — never a consecutive-day count, and
  // never a "broken streak" state. A miss zeroes nothing earned, so no day-count
  // is rendered. `topStreaks` still carries day data in the payload (consumed by
  // in-app/widget surfaces, NEX-190); the email deliberately ignores `.days`.
  const habitRows = p.topStreaks
    .map(s => `
      <tr>
        <td style="padding:8px 0;color:#FFFFFF;font-size:14px;">${escapeHtml(s.habit)}</td>
      </tr>
    `)
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>Your Nexus Weekly Summary</title>
<style>
  /* Apple Mail / iOS Mail enhancement ONLY: a nebula gradient floor for when remote images
     are disabled. Gmail strips <style> entirely, so the real universal floor is the inline
     background-color:#06060C below — not this. */
  body { background-color:#06060C; background-image: radial-gradient(ellipse at 50% 0%, #1b1430 0%, #0c0b1a 45%, #06060C 100%); }
</style>
</head>
<body bgcolor="#06060C" style="margin:0;padding:0;background-color:#06060C;color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<!-- Full-bleed cosmic backdrop. Universal floor: bgcolor + background-color:#06060C (survives
     Gmail's <style> stripping). Galaxy photo via the (non-HTML5 but client-honored) background
     attribute + inline background-image — shows in Apple Mail + modern Gmail, degrades cleanly
     to the solid floor in Outlook/everywhere else. No VML: a variable-height email makes
     bulletproof VML fragile, and a flat #06060C is an acceptable Outlook fallback. -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#06060C" background="${COSMIC_BG_URL}" style="background-color:#06060C;background-image:url('${COSMIC_BG_URL}');background-size:cover;background-position:top center;background-repeat:no-repeat;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="padding:0 0 40px;text-align:center;">
            <p style="margin:0;color:#E5BA6E;font-size:11px;font-weight:900;letter-spacing:6px;text-shadow:0 1px 4px rgba(0,0,0,0.55);">N E X U S</p>
            <p style="margin:8px 0 0;color:#9AA3B5;font-size:12px;letter-spacing:1px;text-shadow:0 1px 4px rgba(0,0,0,0.55);">WEEKLY SUMMARY · ${escapeHtml(p.weekLabel)}</p>
          </td>
        </tr>

        <!-- Greeting -->
        <tr>
          <td style="padding:0 0 32px;">
            <p style="margin:0;color:#FFFFFF;font-size:22px;font-weight:300;text-shadow:0 1px 4px rgba(0,0,0,0.55);">
              ${p.disciplineScoreAvg >= 70 ? 'Strong week,' : 'Keep building,'} ${escapeHtml(p.userName)}.
            </p>
            <p style="margin:8px 0 0;color:#E8EEF6;font-size:14px;line-height:22px;text-shadow:0 1px 4px rgba(0,0,0,0.55);">
              Here's how you showed up this week.
            </p>
          </td>
        </tr>

        <!-- Stats grid -->
        <tr>
          <td style="padding:0 0 24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="32%" bgcolor="#0A0D16" style="background-color:rgba(10,13,22,0.80);border-radius:12px;padding:20px;text-align:center;border:1px solid #1C1F2A;">
                  <p style="margin:0;color:#E5BA6E;font-size:32px;font-weight:900;">${p.completionRate}%</p>
                  <p style="margin:4px 0 0;color:#9AA3B5;font-size:10px;letter-spacing:1px;">COMPLETION</p>
                </td>
                <td width="4%"></td>
                <td width="32%" bgcolor="#0A0D16" style="background-color:rgba(10,13,22,0.80);border-radius:12px;padding:20px;text-align:center;border:1px solid #1C1F2A;">
                  <p style="margin:0;color:#E5BA6E;font-size:32px;font-weight:900;">${p.disciplineScoreAvg}</p>
                  <p style="margin:4px 0 0;color:#9AA3B5;font-size:10px;letter-spacing:1px;">AVG SCORE</p>
                </td>
                <td width="4%"></td>
                <td width="28%" bgcolor="#0A0D16" style="background-color:rgba(10,13,22,0.80);border-radius:12px;padding:20px;text-align:center;border:1px solid #1C1F2A;">
                  <p style="margin:0;color:#E5BA6E;font-size:32px;font-weight:900;">${p.habitsCompleted}</p>
                  <p style="margin:4px 0 0;color:#9AA3B5;font-size:10px;letter-spacing:1px;">REPS THIS WEEK</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Habits summary -->
        <tr>
          <td bgcolor="#0A0D16" style="background-color:rgba(10,13,22,0.80);border-radius:14px;padding:20px;border:1px solid #1C1F2A;margin-bottom:20px;">
            <p style="margin:0 0 12px;color:#9AA3B5;font-size:9px;font-weight:800;letter-spacing:2px;">HABIT EXECUTION</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="color:#FFFFFF;font-size:14px;">Completed</td>
                <td style="color:#5FE0EA;font-size:14px;font-weight:700;text-align:right;">${p.habitsCompleted}</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr><td style="height:16px;"></td></tr>

        <!-- Habits you're leaning on (cumulative, never a breakable streak) -->
        ${habitRows ? `
        <tr>
          <td bgcolor="#0A0D16" style="background-color:rgba(10,13,22,0.80);border-radius:14px;padding:20px;border:1px solid #1C1F2A;">
            <p style="margin:0 0 12px;color:#9AA3B5;font-size:9px;font-weight:800;letter-spacing:2px;">STRUCTURES YOU'RE LEANING ON</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${habitRows}
            </table>
          </td>
        </tr>
        <tr><td style="height:16px;"></td></tr>
        ` : ''}

        <!-- Motivational tip -->
        <tr>
          <td bgcolor="#0A0D16" style="background-color:rgba(10,13,22,0.80);border-radius:14px;padding:24px;border-left:3px solid #E5BA6E;border-right:1px solid #1C1F2A;border-top:1px solid #1C1F2A;border-bottom:1px solid #1C1F2A;">
            <p style="margin:0 0 8px;color:#E5BA6E;font-size:9px;font-weight:800;letter-spacing:2px;">THIS WEEK'S PRINCIPLE</p>
            <p style="margin:0;color:#E8EEF6;font-size:14px;line-height:22px;font-style:italic;">${p.motivationalTip}</p>
          </td>
        </tr>

        <tr><td style="height:32px;"></td></tr>

        <!-- CTA -->
        <tr>
          <td align="center">
            <a href="${p.appUrl}"
               style="display:inline-block;background:#E5BA6E;color:#06060C;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;">
              OPEN NEXUS →
            </a>
          </td>
        </tr>

        <tr><td style="height:40px;"></td></tr>

        <!-- Footer -->
        <tr>
          <td style="text-align:center;border-top:1px solid rgba(255,255,255,0.12);padding-top:24px;">
            <p style="margin:0;color:#9AA3B5;font-size:11px;letter-spacing:1px;text-shadow:0 1px 4px rgba(0,0,0,0.55);">Nexus · Built for the intentional</p>
            <p style="margin:8px 0 0;color:#9AA3B5;font-size:11px;text-shadow:0 1px 4px rgba(0,0,0,0.55);">
              You're receiving this because you enabled weekly summaries in Nexus settings.
            </p>
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

export function weeklySummarySubject(p: WeeklySummaryPayload): string {
  // NEX-192 / §1.5 Law B & C: forward/cumulative framing only. No consecutive-day
  // streak count (breakable, shame-adjacent) — `habitsCompleted` is this week's
  // cumulative reps, which a miss never zeroes.
  return `Your Nexus Week: ${p.completionRate}% completion • ${p.habitsCompleted} reps`;
}

const FROM_EMAIL = Deno.env.get('FROM_EMAIL') ?? 'Nexus <hello@example.com>';

/**
 * Send the weekly summary via Resend. Returns the Resend message id; throws on
 * a non-2xx response so callers can record the failure. Identical send path to
 * the original `weekly-summary` function (same FROM, same endpoint).
 */
export async function sendWeeklySummaryEmail(
  payload: WeeklySummaryPayload,
  resendApiKey: string,
): Promise<string> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [payload.userEmail],
      subject: weeklySummarySubject(payload),
      html: buildWeeklySummaryHtml(payload),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }

  const data = await res.json() as { id: string };
  return data.id;
}
