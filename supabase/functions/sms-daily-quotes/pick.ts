/**
 * NEX-323 sms-daily-quotes — pure logic (deno-testable, no I/O).
 *
 * Slot matching, quote picking, and SMS body composition for the daily
 * wisdom-quote sender. Everything here is deterministic given (now, state),
 * so index.ts stays a thin DB/Twilio shell.
 */

export interface WisdomQuote {
  quote: string;
  author: string;
}

export interface WisdomHistoryEntry extends WisdomQuote {
  dateKey: string; // 'YYYY-MM-DD' in the user's local tz
}

/** Loose shape of user_state.state_data — every field may be absent. */
export interface UserStateData {
  timezone?: string;
  notificationSettings?: {
    morningHour?: number;
    morningMinute?: number;
    eveningHour?: number;
    eveningMinute?: number;
  };
  dailyWisdomQuotes?: WisdomQuote[];
  dailyWisdomDate?: string; // 'YYYY-MM-DD' local date dailyWisdomQuotes belongs to
  recentWisdomHistory?: WisdomHistoryEntry[];
}

export type QuoteSlot = 'morning' | 'evening';

export const DEFAULT_MORNING = { hour: 8, minute: 0 };
// Matches the app's own evening-notification default (20:00) — the SMS must
// land with the push, not an hour after it.
export const DEFAULT_EVENING = { hour: 20, minute: 0 };

/** One cron tick: a slot fires when local time is within [slot, slot+15min). */
// A slot stays eligible for catch-up this long after it starts. The dedupe
// key (daily-quote:<slot>:<dateKey>, unique per user) makes every later tick
// a safe retry, so recipients deferred by the per-run cap/deadline are
// recovered on subsequent ticks instead of silently missing the slot. 3h is
// long enough to absorb big backlogs (12 ticks × SMS_MAX_PER_RUN), short
// enough that a phone-off-all-day user never gets a stale morning quote at
// night.
export const SLOT_CATCH_UP_MINUTES = 180;

/** True when tz is a string Intl accepts as an IANA time zone. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalNow {
  dateKey: string; // 'YYYY-MM-DD'
  hour: number;    // 0-23
  minute: number;  // 0-59
}

/**
 * The user's local wall-clock `now` in their IANA tz. Never Date#getHours —
 * that would be the server's tz. Returns null for an invalid tz.
 */
export function localNowParts(now: Date, tz: string): LocalNow | null {
  if (!isValidTimezone(tz)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // en-US hour12:false renders midnight as '24' on some ICU versions.
  const hour = Number(get('hour')) % 24;
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: Number(get('minute')),
  };
}

function saneHour(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
}

function saneMinute(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 59 ? v : fallback;
}

/** Resolve the two slots, applying defaults for missing/invalid settings. */
export function slotTimes(
  settings: UserStateData['notificationSettings'],
): { morning: { hour: number; minute: number }; evening: { hour: number; minute: number } } {
  return {
    morning: {
      hour: saneHour(settings?.morningHour, DEFAULT_MORNING.hour),
      minute: saneMinute(settings?.morningMinute, DEFAULT_MORNING.minute),
    },
    evening: {
      hour: saneHour(settings?.eveningHour, DEFAULT_EVENING.hour),
      minute: saneMinute(settings?.eveningMinute, DEFAULT_EVENING.minute),
    },
  };
}

/**
 * All slots DUE for this user right now (morning first). A slot becomes due
 * the moment its local start time passes and stays due for
 * SLOT_CATCH_UP_MINUTES — the send-time dedupe key makes every tick in that
 * span a safe retry, so cap/deadline deferrals recover instead of being lost.
 * The dateKey is the DAY THE SLOT STARTED IN (yesterday for a past-midnight
 * catch-up of a 23:46 slot), which is what the broadcast key uses.
 *
 * Returns an ARRAY, not the first match: with overlapping slots the caller
 * must attempt each one — after the morning send reserves, 'already' must
 * fall through to the evening slot in the same tick, otherwise an evening
 * slot inside the morning catch-up span starves (and identical slot times
 * would never send at all).
 */
export function dueSlots(
  now: Date,
  state: UserStateData,
): { slot: QuoteSlot; dateKey: string }[] {
  const tz = state.timezone;
  if (!isValidTimezone(tz)) return [];
  const local = localNowParts(now, tz);
  if (!local) return [];
  const mins = local.hour * 60 + local.minute;
  const MINUTES_PER_DAY = 24 * 60;
  const { morning, evening } = slotTimes(state.notificationSettings);
  const candidates: { slot: QuoteSlot; startMins: number }[] = [
    { slot: 'morning', startMins: morning.hour * 60 + morning.minute },
    { slot: 'evening', startMins: evening.hour * 60 + evening.minute },
  ];
  const due: { slot: QuoteSlot; dateKey: string }[] = [];
  for (const { slot, startMins } of candidates) {
    // Today's occurrence, then yesterday's (the midnight-wrap case: a 23:46
    // slot is 14 minutes old at the 00:00 tick, which belongs to yesterday).
    for (const dayOffset of [0, -1]) {
      const elapsed = mins - startMins - dayOffset * MINUTES_PER_DAY;
      if (elapsed >= 0 && elapsed <= SLOT_CATCH_UP_MINUTES) {
        due.push({ slot, dateKey: shiftDateKey(local.dateKey, dayOffset) });
        break; // a slot can only have one live occurrence
      }
    }
  }
  return due;
}

/** 'YYYY-MM-DD' shifted by whole days (tz-safe: pure calendar math on the key). */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function lastForDate(
  history: WisdomHistoryEntry[] | undefined,
  dateKey: string,
): WisdomQuote | null {
  if (!history) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h && h.dateKey === dateKey && typeof h.quote === 'string' && h.quote.trim()) {
      return { quote: h.quote, author: h.author ?? '' };
    }
  }
  return null;
}

/**
 * Quote for a slot. Morning → yesterday's set (last history entry dated
 * yesterday). Evening → today's dailyWisdomQuotes[0] when fresh, else last
 * history entry dated today. Both fall back to the most recent history entry
 * overall. Null when there is genuinely nothing to send.
 */
export function pickQuote(
  state: UserStateData,
  slot: QuoteSlot,
  todayKey: string,
): WisdomQuote | null {
  const history = state.recentWisdomHistory;

  if (slot === 'evening') {
    if (
      state.dailyWisdomDate === todayKey &&
      Array.isArray(state.dailyWisdomQuotes) &&
      state.dailyWisdomQuotes.length > 0 &&
      typeof state.dailyWisdomQuotes[0]?.quote === 'string' &&
      state.dailyWisdomQuotes[0].quote.trim()
    ) {
      const q = state.dailyWisdomQuotes[0];
      return { quote: q.quote, author: q.author ?? '' };
    }
    const todayEntry = lastForDate(history, todayKey);
    if (todayEntry) return todayEntry;
  } else {
    const yesterdayEntry = lastForDate(history, shiftDateKey(todayKey, -1));
    if (yesterdayEntry) return yesterdayEntry;
  }

  // Fallback for both slots: most recent history entry overall.
  if (history && history.length > 0) {
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h && typeof h.quote === 'string' && h.quote.trim()) {
        return { quote: h.quote, author: h.author ?? '' };
      }
    }
  }
  return null;
}

// Body: `Nexus: "<quote>" - <author>. Reply STOP to unsubscribe.`
// Hyphen, not an em dash: CLAUDE.md bans em dashes in user-facing copy, and
// the GSM-7 encoding helper in _shared/sms.ts would replace it anyway.
// Budget ~300 chars total so the send stays inside 2 SMS segments.
const SMS_PREFIX = 'Nexus: ';
const SMS_SUFFIX = '. Reply STOP to unsubscribe.';
const BODY_BUDGET = 300;
const MIN_QUOTE_CHARS = 20;
// Authors come from synced, AI-generated data and are unbounded upstream.
// Cap the attribution BEFORE sizing the quote allowance, else a 400-char
// "author" eats the whole budget and MIN_QUOTE_CHARS forces the body over it.
const AUTHOR_BUDGET = 60;

/** Cut s to budget chars at a word boundary, ending with an ellipsis. */
function cutAtWord(s: string, budget: number): string {
  if (s.length <= budget) return s;
  const cut = s.slice(0, Math.max(1, budget - 3)); // room for the ellipsis
  const boundary = cut.lastIndexOf(' ');
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trim() + '...';
}

/**
 * Compose the SMS body. Author omitted (dash and all) when empty, capped at
 * AUTHOR_BUDGET otherwise. An over-long quote is cut at a word boundary with
 * an ellipsis. The assembled body never exceeds BODY_BUDGET.
 */
export function composeQuoteBody(quote: string, author: string): string {
  const cleanAuthor = (author ?? '').replace(/\s+/g, ' ').trim();
  const attribution = cleanAuthor ? ` - ${cutAtWord(cleanAuthor, AUTHOR_BUDGET)}` : '';
  const fixed = SMS_PREFIX.length + 2 + attribution.length + SMS_SUFFIX.length; // 2 = the quotes
  const maxQuote = Math.max(MIN_QUOTE_CHARS, BODY_BUDGET - fixed);
  const q = cutAtWord(quote.replace(/\s+/g, ' ').trim(), maxQuote);
  return `${SMS_PREFIX}"${q}"${attribution}${SMS_SUFFIX}`;
}
