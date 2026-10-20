/**
 * NEX-323 (C6) — pins the win-back email copy (S8): §18/§1.5 voice invariant
 * (no em dash, no exclamation point, no emoji), List-Unsubscribe present, and
 * the (a) template carries the real access-until date.
 *
 * Run: deno test --allow-import supabase/functions/rc-winback-webhook/
 */

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { formatAccessUntil, winbackEmail } from './copy.ts';
import type { WinbackKind } from './classify.ts';

const KINDS: WinbackKind[] = ['trial_cancel_value', 'lapsed_offer'];
const EMOJI = /[\u2600-\u27BF\uFE0F\u{1F000}-\u{1FAFF}]/u;

Deno.test('S8: copy-cleanliness invariant — no em dash, no exclamation, no emoji', () => {
  for (const kind of KINDS) {
    const { subject, html, headers } = winbackEmail(kind, {
      firstName: 'Alex',
      accessUntil: 'August 12, 2026',
    });
    // The §18 ban governs copy, not markup: strip the doctype (<!DOCTYPE…)
    // before asserting on the assembled email.
    const all = (subject + html + JSON.stringify(headers)).replace(/<!DOCTYPE[^>]*>/gi, '');
    assert(!all.includes('—'), `${kind}: em dash found`);
    assert(!all.includes('–'), `${kind}: en dash found`);
    assert(!all.includes('!'), `${kind}: exclamation point found`);
    assert(!EMOJI.test(all), `${kind}: emoji found`);
  }
});

Deno.test('S8: both templates carry List-Unsubscribe and a visible opt-out line', () => {
  for (const kind of KINDS) {
    const email = winbackEmail(kind, { firstName: 'Alex' });
    assertStringIncludes(email.headers['List-Unsubscribe'], 'mailto:hello@example.com');
    assertStringIncludes(email.html, 'unsubscribe');
  }
});

Deno.test('(a) names the real access-until date; (b) states the grant already landed', () => {
  const a = winbackEmail('trial_cancel_value', { firstName: 'Alex', accessUntil: 'August 12, 2026' });
  assertStringIncludes(a.html, 'August 12, 2026');
  assertStringIncludes(a.subject, 'Alex');
  const b = winbackEmail('lapsed_offer', { firstName: 'Alex' });
  assertStringIncludes(b.html, 'already on your account');
});

Deno.test('formatAccessUntil renders a stable en-US date in UTC', () => {
  assertEquals(formatAccessUntil(Date.UTC(2026, 7, 12, 23, 30)), 'August 12, 2026');
});

Deno.test('firstName is HTML-escaped (no injection from profile names)', () => {
  const { html } = winbackEmail('trial_cancel_value', { firstName: '<img src=x>' });
  assert(!html.includes('<img src=x>'), 'raw HTML in name leaked into template');
});

Deno.test('missing firstName falls back to "there"', () => {
  const { html } = winbackEmail('lapsed_offer', { firstName: '' });
  assertStringIncludes(html, 'Hey there,');
});
