/**
 * NEX-323 — pins the sms-daily-quotes pure logic: slot due/catch-up edges, tz
 * validation, quote picking per slot, and body composition.
 *
 * Run: deno test --allow-import supabase/functions/sms-daily-quotes/
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  composeQuoteBody,
  dueSlots,
  isValidTimezone,
  pickQuote,
  shiftDateKey,
  type UserStateData,
} from './pick.ts';

// Fixed tz + instants. America/Chicago is UTC-5 (CDT) in June, so
// 13:00Z == 08:00 local — the default morning slot.
const TZ = 'America/Chicago';
const at = (isoZ: string) => new Date(isoZ);
const state = (over: Partial<UserStateData> = {}): UserStateData => ({ timezone: TZ, ...over });

// ── Slot due + catch-up edges ────────────────────────────────────────────────

Deno.test('dueSlots: fires exactly on the slot minute', () => {
  const m = dueSlots(at('2026-06-23T13:00:00Z'), state()); // 08:00 local
  assertEquals(m, [{ slot: 'morning', dateKey: '2026-06-23' }]);
});

Deno.test('dueSlots: does NOT fire one minute before the slot', () => {
  assertEquals(dueSlots(at('2026-06-23T12:59:00Z'), state()), []); // 07:59 local
});

Deno.test('dueSlots: stays due through the catch-up span (cap/deadline retry)', () => {
  // 08:15 and even 10:59 local are still due — later ticks retry recipients
  // the per-run cap deferred. This is the property that replaces the lost
  // 15-minute window.
  assertEquals(dueSlots(at('2026-06-23T13:15:00Z'), state())[0]?.slot, 'morning');
  assertEquals(dueSlots(at('2026-06-23T15:59:00Z'), state())[0]?.slot, 'morning');
});

Deno.test('dueSlots: NOT due after the catch-up span (no stale quotes)', () => {
  assertEquals(dueSlots(at('2026-06-23T16:01:00Z'), state()), []); // 11:01 local, 3h1m past
});

Deno.test('dueSlots: evening default 20:00, and custom settings honored', () => {
  const e = dueSlots(at('2026-06-24T01:00:00Z'), state()); // 20:00 local on 06-23
  assertEquals(e, [{ slot: 'evening', dateKey: '2026-06-23' }]);

  const custom = state({
    notificationSettings: { morningHour: 8, morningMinute: 30, eveningHour: 21, eveningMinute: 0 },
  });
  const m = dueSlots(at('2026-06-23T13:30:00Z'), custom); // 08:30 local
  assertEquals(m[0]?.slot, 'morning');
  assertEquals(dueSlots(at('2026-06-23T13:00:00Z'), custom), []); // old default not yet due
});

Deno.test('dueSlots: overlapping and identical slots return BOTH, morning first', () => {
  // Greptile P1: after the morning send reserves, the evening slot must still
  // be attempted in the same tick — so dueSlots returns every due slot.
  const overlap = state({
    notificationSettings: { morningHour: 8, morningMinute: 0, eveningHour: 8, eveningMinute: 5 },
  });
  const both = dueSlots(at('2026-06-23T13:05:00Z'), overlap); // 08:05 local
  assertEquals(both.map((d) => d.slot), ['morning', 'evening']);

  const identical = state({
    notificationSettings: { morningHour: 8, morningMinute: 0, eveningHour: 8, eveningMinute: 0 },
  });
  const same = dueSlots(at('2026-06-23T13:00:00Z'), identical);
  assertEquals(same.map((d) => d.slot), ['morning', 'evening']);
  // Identical times share a start, so both key to the same day — distinct
  // broadcast keys (morning/evening) keep the two sends independent.
  assertEquals(same, [
    { slot: 'morning', dateKey: '2026-06-23' },
    { slot: 'evening', dateKey: '2026-06-23' },
  ]);
});

Deno.test('dueSlots: midnight wrap keeps the slot-day dateKey, then closes', () => {
  const late = state({
    notificationSettings: { morningHour: 8, morningMinute: 0, eveningHour: 23, eveningMinute: 46 },
  });
  // 23:46 local on 06-23: due, keyed to that day.
  assertEquals(dueSlots(at('2026-06-24T04:46:00Z'), late), [{ slot: 'evening', dateKey: '2026-06-23' }]);
  // 00:00 and 00:01 local on 06-24: the wrap case — yesterday's occurrence is
  // minutes old, and the key must stay on 06-23 so straddling ticks dedupe.
  assertEquals(dueSlots(at('2026-06-24T05:00:00Z'), late), [{ slot: 'evening', dateKey: '2026-06-23' }]);
  assertEquals(dueSlots(at('2026-06-24T05:01:00Z'), late), [{ slot: 'evening', dateKey: '2026-06-23' }]);
  // 02:47 local: 3h1m past the slot — catch-up has closed.
  assertEquals(dueSlots(at('2026-06-24T07:47:00Z'), late), []);
});

Deno.test('dueSlots: invalid or missing timezone skips ([])', () => {
  assertEquals(dueSlots(at('2026-06-23T13:00:00Z'), state({ timezone: 'Not/AZone' })), []);
  assertEquals(dueSlots(at('2026-06-23T13:00:00Z'), state({ timezone: undefined })), []);
  assertEquals(dueSlots(at('2026-06-23T13:00:00Z'), state({ timezone: '' })), []);
  assertEquals(dueSlots(at('2026-06-23T13:00:00Z'), {}), []);
  assert(!isValidTimezone('Not/AZone'));
  assert(isValidTimezone('America/Chicago'));
});

// ── Quote picking ────────────────────────────────────────────────────────────

const TODAY = '2026-06-23';
const YESTERDAY = '2026-06-22';

Deno.test('shiftDateKey: yesterday, across month boundary', () => {
  assertEquals(shiftDateKey(TODAY, -1), YESTERDAY);
  assertEquals(shiftDateKey('2026-03-01', -1), '2026-02-28');
});

Deno.test('pickQuote: morning takes the last history entry dated yesterday', () => {
  const s = state({
    recentWisdomHistory: [
      { quote: 'older', author: 'A', dateKey: YESTERDAY },
      { quote: 'today quote', author: 'B', dateKey: TODAY },
      { quote: 'newest yesterday', author: 'C', dateKey: YESTERDAY },
    ],
  });
  assertEquals(pickQuote(s, 'morning', TODAY), { quote: 'newest yesterday', author: 'C' });
});

Deno.test('pickQuote: evening prefers today\'s dailyWisdomQuotes when fresh', () => {
  const s = state({
    dailyWisdomDate: TODAY,
    dailyWisdomQuotes: [{ quote: 'fresh daily', author: 'D' }],
    recentWisdomHistory: [{ quote: 'today history', author: 'E', dateKey: TODAY }],
  });
  assertEquals(pickQuote(s, 'evening', TODAY), { quote: 'fresh daily', author: 'D' });

  // Stale dailyWisdomDate → falls through to today's history entry.
  const stale = state({
    dailyWisdomDate: YESTERDAY,
    dailyWisdomQuotes: [{ quote: 'stale daily', author: 'D' }],
    recentWisdomHistory: [{ quote: 'today history', author: 'E', dateKey: TODAY }],
  });
  assertEquals(pickQuote(stale, 'evening', TODAY), { quote: 'today history', author: 'E' });
});

Deno.test('pickQuote: both slots fall back to the most recent history entry overall', () => {
  const s = state({
    recentWisdomHistory: [
      { quote: 'week old', author: 'F', dateKey: '2026-06-16' },
      { quote: 'most recent', author: 'G', dateKey: '2026-06-20' },
    ],
  });
  assertEquals(pickQuote(s, 'morning', TODAY), { quote: 'most recent', author: 'G' });
  assertEquals(pickQuote(s, 'evening', TODAY), { quote: 'most recent', author: 'G' });
});

Deno.test('pickQuote: empty history and no daily set → null (skip user)', () => {
  assertEquals(pickQuote(state(), 'morning', TODAY), null);
  assertEquals(pickQuote(state({ recentWisdomHistory: [] }), 'evening', TODAY), null);
  assertEquals(pickQuote(state({ recentWisdomHistory: [{ quote: '  ', author: 'X', dateKey: TODAY }] }), 'evening', TODAY), null);
});

// ── Body composition ─────────────────────────────────────────────────────────

Deno.test('composeQuoteBody: house shape with hyphen attribution (no em dashes)', () => {
  assertEquals(
    composeQuoteBody('Stillness speaks.', 'Rumi'),
    'Nexus: "Stillness speaks." - Rumi. Reply STOP to unsubscribe.',
  );
});

Deno.test('composeQuoteBody: author omitted (dash and all) when empty', () => {
  assertEquals(
    composeQuoteBody('Stillness speaks.', ''),
    'Nexus: "Stillness speaks.". Reply STOP to unsubscribe.',
  );
  assertEquals(
    composeQuoteBody('Stillness speaks.', '   '),
    'Nexus: "Stillness speaks.". Reply STOP to unsubscribe.',
  );
});

Deno.test('composeQuoteBody: over-long quote truncates at a word boundary, body ≤ 300', () => {
  const longQuote = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const body = composeQuoteBody(longQuote, 'Some Author');
  assert(body.length <= 300, `body ${body.length} > 300`);
  assert(body.includes('..."'), 'ellipsis before closing quote');
  // The truncated quote ends on a whole word, then the ellipsis.
  const inner = body.slice('Nexus: "'.length, body.indexOf('..."'));
  assert(!inner.endsWith(' '), 'no dangling space before ellipsis');
  assert(/word\d+$/.test(inner), `cut mid-word: "...${inner.slice(-12)}"`);
  assert(body.endsWith(' - Some Author. Reply STOP to unsubscribe.'));
});

Deno.test('composeQuoteBody: a synced 400-char author is capped, body ≤ 300', () => {
  // Greptile P1: authors are unbounded upstream (synced, AI-generated), and
  // MIN_QUOTE_CHARS used to force the body past the budget when the author
  // alone consumed it.
  const longAuthor = 'Attributed To ' + 'X'.repeat(400);
  const body = composeQuoteBody('Stillness speaks.', longAuthor);
  assert(body.length <= 300, `body ${body.length} > 300`);
  assert(!body.includes('X'.repeat(61)), 'author was not capped');
  const longBoth = composeQuoteBody(Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '), longAuthor);
  assert(longBoth.length <= 300, `body ${longBoth.length} > 300`);
});

Deno.test('composeQuoteBody: short quote passes through untruncated', () => {
  const body = composeQuoteBody('Short and sweet.', 'A');
  assert(!body.includes('...'));
  assert(body.length <= 300);
});
