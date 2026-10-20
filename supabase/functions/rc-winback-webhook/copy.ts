/**
 * NEX-323 (C6) — win-back email content. Pure, no I/O, deno-testable.
 *
 * Voice gate (CLAUDE.md §18 / §1.5 Law C): forward-looking, no absence
 * counting, no shame, no em dash, no exclamation point, no emoji. Hand-written
 * templates, approved in the spec (docs/plans/nex-323-cancel-winback.md);
 * copy-cleanliness invariant pinned in copy.test.ts (S8).
 *
 * (b) is commercial email: every send carries a List-Unsubscribe header and a
 * visible opt-out line. (A physical postal address is the one CAN-SPAM gap —
 * no existing Nexus template carries one and none is invented here; tracked
 * as a follow-on in the spec.)
 */

import type { WinbackKind } from './classify.ts';

export const FROM_EMAIL = Deno.env.get('FROM_EMAIL') ?? 'Nexus <hello@example.com>';
export const APP_URL = 'https://apps.apple.com/app/id6761865566';
export const UNSUBSCRIBE_MAILTO = `mailto:${Deno.env.get('REPLY_TO_EMAIL') ?? 'hello@example.com'}?subject=unsubscribe`;

export interface WinbackEmailInput {
  firstName: string;
  /** e.g. "August 12, 2026" — (a) only; the trial's paid-through date. */
  accessUntil?: string;
}

export interface WinbackEmail {
  subject: string;
  html: string;
  headers: Record<string, string>;
}

/** Format an epoch-ms timestamp as "August 12, 2026" (UTC, stable for tests). */
export function formatAccessUntil(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shell(opts: { label?: string; body: string }): string {
  const label = opts.label
    ? `<tr><td style="padding:0 0 32px;"><p style="margin:0;color:#B0B0B0;font-size:13px;letter-spacing:0.5px;">${opts.label}</p></td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#06060C;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#06060C;padding:40px 0;">
  <tr>
    <td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="padding:0 0 40px;text-align:center;">
            <p style="margin:0;color:#E5BA6E;font-size:11px;font-weight:900;letter-spacing:6px;">N E X U S</p>
          </td>
        </tr>
        ${label}
        <tr>
          <td style="padding:0 0 28px;">
            ${opts.body}
          </td>
        </tr>
        <tr>
          <td style="padding:12px 0 40px;" align="center">
            <a href="${APP_URL}"
               style="display:inline-block;background:#E5BA6E;color:#06060C;font-size:13px;font-weight:900;letter-spacing:2px;padding:14px 40px;border-radius:30px;text-decoration:none;">
              OPEN NEXUS
            </a>
          </td>
        </tr>
        <tr>
          <td style="text-align:center;border-top:1px solid #1A1A1A;padding-top:24px;">
            <p style="margin:0 0 8px;color:#2A2A2A;font-size:11px;letter-spacing:1px;">Nexus · Built for the intentional</p>
            <p style="margin:0;color:#2A2A2A;font-size:11px;">Don't want these emails? Reply "unsubscribe" and I'll stop.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 20px;color:#B0B0B0;font-size:15px;line-height:26px;">${text}</p>`;
}

function pLead(text: string): string {
  return `<p style="margin:0 0 20px;color:#F0F0F0;font-size:16px;line-height:26px;">${text}</p>`;
}

export function winbackEmail(kind: WinbackKind, input: WinbackEmailInput): WinbackEmail {
  const first = escapeHtml(input.firstName || 'there');

  if (kind === 'trial_cancel_value') {
    const until = escapeHtml(input.accessUntil ?? 'the end of your trial');
    return {
      subject: `Your trial is still on, ${first}`,
      html: shell({
        label: 'Trial update',
        body:
          pLead(`Hey ${first},`) +
          p('Cancelling stops the renewal, not the access.') +
          p(`Nexus Pro is yours until ${until}. Your mandate, your habits, your morning brief. All still there.`) +
          p('Today, return.'),
      }),
      headers: { 'List-Unsubscribe': `<${UNSUBSCRIBE_MAILTO}>` },
    };
  }

  // lapsed_offer — the promotional grant has already landed server-side, so
  // the email only ever describes something that is already true.
  return {
    subject: 'One more month, on us',
    html: shell({
      body:
        pLead(`Hey ${first},`) +
        p('A free month of Nexus Pro is already on your account. No charge, no action needed.') +
        p('Your mandate, your habits, your history. Nothing was reset.') +
        p('Open the app and pick up where you left off.'),
    }),
    headers: { 'List-Unsubscribe': `<${UNSUBSCRIBE_MAILTO}>` },
  };
}
