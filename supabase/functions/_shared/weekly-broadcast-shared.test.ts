/**
 * NEX-185 — pins the weekly-broadcast content + scheduling math so the pure move
 * out of weekly-broadcast/index.ts can't silently regress the email channel, and
 * guarantees every authored SMS line fits a single send without UCS-2 surprises.
 *
 * Run: deno test --allow-import supabase/functions/_shared/weekly-broadcast-shared.test.ts
 * (CI's deno-check type-checks this file; behavior is gated by running it locally.)
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  WEEKS,
  currentBroadcastKey,
  pickWeekContent,
  weeksSinceTrialStart,
} from './weekly-broadcast-shared.ts';
import { emailToSms } from './sms.ts';

// GSM-7 basic + default-extension set. A char outside this forces UCS-2
// (70/segment), so an authored line that sneaks one in would segment oddly.
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
  '€'; // € is a GSM-7 extension char
function isGsm7(s: string): boolean {
  for (const ch of s) if (!GSM7.includes(ch)) return false;
  return true;
}

Deno.test('WEEKS: 12 entries, stable 1..12 indices', () => {
  assertEquals(WEEKS.length, 12);
  WEEKS.forEach((w, i) => assertEquals(w.index, i + 1));
});

Deno.test('WEEKS: subject + body snapshot (email content unchanged by the move)', () => {
  // Spot-check the load-bearing strings rather than a full dump; if the essays
  // are ever intentionally rewritten, update these three anchors deliberately.
  assertEquals(WEEKS[0].subject, 'The score is a measurement, not a verdict.');
  assert(WEEKS[0].body.startsWith('Hey {firstName},'));
  assert(WEEKS[0].body.includes('66 days to feel automatic'));
  assertEquals(WEEKS[11].subject, 'A year from now.');
  assert(WEEKS[11].body.trimEnd().endsWith('— Circle of Light'));
});

Deno.test('SMS lines: each wraps to <=2 GSM-7 segments, no truncation, GSM-7-safe', () => {
  for (const w of WEEKS) {
    // Called exactly as production does: emailToSms(week.sms) with no linkUrl.
    const { body, truncated } = emailToSms(w.sms);
    assert(!truncated, `week ${w.index} sms was truncated (author it shorter)`);
    assert(body.length <= 306, `week ${w.index} body ${body.length} > 306 chars`);
    assert(isGsm7(body), `week ${w.index} body has a non-GSM-7 char (would force UCS-2)`);
    assert(body.startsWith('Nexus: '), `week ${w.index} missing prefix`);
    assert(body.endsWith(' Reply STOP to unsubscribe.'), `week ${w.index} missing opt-out suffix`);
  }
});

Deno.test('pickWeekContent: 1-indexed, wraps at 13 -> week 1', () => {
  assertEquals(pickWeekContent(1).index, 1);
  assertEquals(pickWeekContent(12).index, 12);
  assertEquals(pickWeekContent(13).index, 1);
  assertEquals(pickWeekContent(24).index, 12);
  assertEquals(pickWeekContent(25).index, 1);
});

Deno.test('weeksSinceTrialStart: floor of day-delta / 7', () => {
  const start = '2026-01-01T00:00:00Z';
  assertEquals(weeksSinceTrialStart(start, new Date('2026-01-01T00:00:00Z')), 0);
  assertEquals(weeksSinceTrialStart(start, new Date('2026-01-07T23:59:59Z')), 0);
  assertEquals(weeksSinceTrialStart(start, new Date('2026-01-08T00:00:00Z')), 1);
  assertEquals(weeksSinceTrialStart(start, new Date('2026-01-15T00:00:00Z')), 2);
});

Deno.test('currentBroadcastKey: ISO-week, stable within a week, year-boundary', () => {
  // Tue 2026-06-23 and the surrounding Mon/Sun land in the same ISO week key.
  const tue = currentBroadcastKey(new Date('2026-06-23T14:00:00Z'));
  assertEquals(tue, currentBroadcastKey(new Date('2026-06-22T00:00:00Z'))); // Mon
  assertEquals(tue, currentBroadcastKey(new Date('2026-06-28T23:59:59Z'))); // Sun
  assert(/^weekly_broadcast_2026_W\d{2}$/.test(tue));
  // 2026-01-01 is a Thursday → ISO week 1 of 2026.
  assertEquals(currentBroadcastKey(new Date('2026-01-01T12:00:00Z')), 'weekly_broadcast_2026_W01');
  // 2025-12-29 (Mon) is in ISO week 1 of 2026 (ISO weeks belong to the year of their Thursday).
  assertEquals(currentBroadcastKey(new Date('2025-12-29T12:00:00Z')), 'weekly_broadcast_2026_W01');
});
