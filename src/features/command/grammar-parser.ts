/**
 * grammar-parser.ts — Tier-1 deterministic offline capture grammar (NEX-223).
 *
 * CLAUDE.md §14.1 specs a two-tier capture parser: a deterministic OFFLINE
 * grammar (this file) → AI proxy fallback. This runs in `generateProposal`
 * BEFORE `chatCompletion`. On a confident match it returns fully-resolved
 * `ProposedAction[]` and the screen skips the proxy entirely; otherwise it
 * returns `null` and the capture falls through to the AI exactly as today.
 *
 * SCOPE (deliberately narrow — see NEX-223 review history): Tier-1 handles the
 * cases that are robust to resolve offline and are reversible:
 *   - recurring_add (habit): cadence only — days / timesPerDay / a time-of-day
 *     block from "every morning". NO clock time.
 *   - todo_add: a resolvable DATE and/or an UNAMBIGUOUS clock (NEX-258). A clock
 *     resolves only when connector-led/trailing and unambiguous (am/pm, 24h hour
 *     0 or 13–23, noon/midnight); a no-date clock emits a time-only todo that the
 *     confidence-tier "When?" chip dates with one tap.
 *   - inbox_add: reminder/note framing with no schedule at all.
 *   - calendar_add (NEX-241): the §14.1 explicit-calendar override — an
 *     IRREVERSIBLE EventKit write, so only on an explicit calendar phrase + an
 *     explicit date + an unambiguous clock + a non-past start. Anything short defers.
 *
 * Still DEFERRED to the AI: a vague time-of-day ("this afternoon"), an AMBIGUOUS
 * clock ("at 3"), an interval cadence, or "next <weekday>". `resolveTime` resolves
 * "which time" only for the unambiguous subset; `hasClock` detection still defers
 * everything it can't resolve. A calendar event with no date, no unambiguous time,
 * or a past start defers (the AI can ask a clarifying question).
 *
 * Design contract: conservative (null on doubt), high-confidence only, no-throw.
 * Every result still flows through the unchanged `resolveCaptureTier` safety gate.
 *
 * Pure, side-effect-free, RN-free — vitest-coverable outside React Native.
 */

import { ProposedAction, TimeBlock, normalizeProposedAction } from '../../utils/recurrence';
import { dateKeyOf, nextWeekday, pad, todayKey, tomorrowKey } from './date-tokens';
import { resolveChronoDate, isAmbiguousNextWeekday } from './chrono-date';

// ─── Shared framing prefixes (rule-16 title parity with the AI prompt) ───────

/**
 * Leading reminder/task framing stripped from a title (CLAUDE.md prompt rule 16).
 * Exported and interpolated into the system prompt's rule 16 in `index.tsx` so
 * the AI path and this offline path strip from ONE source of truth — the same
 * phrase must never yield two different titles.
 */
export const CAPTURE_FRAMING_PREFIXES: string[] = [
  'can you set a reminder to',
  'can you remind me to',
  'could you remind me to',
  'please remind me to',
  'set me a reminder to',
  'i need a reminder to',
  'create a reminder to',
  'make a reminder to',
  'add a reminder to',
  'set a reminder to',
  'set a reminder for',
  'remind me about',
  'remind me to',
  'i need to',
  'i want to',
  'note to self',
  'remember to',
  'note:',
];

// Longest-first so "can you set a reminder to" wins over "set a reminder to".
const FRAMING_SORTED = [...CAPTURE_FRAMING_PREFIXES].sort((a, b) => b.length - a.length);

/**
 * The framing prefix the text opens with (longest match), or null. The prefix
 * must end at a word/separator boundary so "i need tomatoes" does NOT match
 * "i need to" and get sliced into "matoes". Prefixes ending in their own
 * separator (e.g. "note:") are self-bounded.
 */
function matchFramingPrefix(lower: string): string | null {
  const t = lower.trimStart();
  for (const prefix of FRAMING_SORTED) {
    if (!t.startsWith(prefix)) continue;
    const next = t[prefix.length];
    const selfBounded = /[^a-z0-9]$/i.test(prefix);
    if (next === undefined || selfBounded || /[^a-z0-9]/i.test(next)) return prefix;
  }
  return null;
}

/**
 * Strip leading reminder framing (one prefix), trailing politeness, and
 * capitalize the first letter — replicates prompt rule 16's title normalization.
 */
export function stripCaptureFraming(text: string): string {
  let out = (text ?? '').trim();
  const prefix = matchFramingPrefix(out.toLowerCase());
  if (prefix) out = out.slice(prefix.length).replace(/^[\s:,\-]+/, '');
  out = out.replace(/[\s,]+(please|thanks|thank you)\s*[.!?]*$/i, '');
  out = out.replace(/[.!?]+$/, '').trim();
  return capitalize(out);
}

function capitalize(s: string): string {
  // Only an all-lowercase first word is capitalized — uppercasing a mixed-case
  // first word ("iOS review", "eBay listing") corrupts its casing.
  if (!/^[a-z]/.test(s)) return s;
  const firstWord = s.split(/\s+/, 1)[0];
  if (/[A-Z]/.test(firstWord)) return s;
  return s[0].toUpperCase() + s.slice(1);
}

/** True when the text opens with explicit reminder/note framing (boundary-checked). */
function hasReminderFraming(lower: string): boolean {
  return matchFramingPrefix(lower) !== null;
}

// ─── Weekday vocabulary (narrow + resolvable) ────────────────────────────────

const WEEKDAYS: [string, number][] = [
  ['sunday', 0], ['monday', 1], ['tuesday', 2], ['wednesday', 3],
  ['thursday', 4], ['friday', 5], ['saturday', 6],
  ['tues', 2], ['weds', 3], ['thurs', 4], ['thur', 4],
  ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6],
];

// ─── Date resolution (narrow vocabulary the parser can actually compute) ─────

/**
 * Resolve a date token to a local `YYYY-MM-DD`, or null if none/unresolvable.
 * Deliberately narrow: today/tonight/tomorrow + the 7 weekday names + "next
 * <weekday>" (chrono, NEX-316) + a valid ISO date. "this week"/"the 5th"/month
 * names are NOT resolvable to a single date and fall through to the AI.
 */
function resolveDate(lower: string, now: Date): string | null {
  const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const [, y, mo, d] = iso;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    const valid =
      dt.getFullYear() === Number(y) &&
      dt.getMonth() === Number(mo) - 1 &&
      dt.getDate() === Number(d);
    return valid ? `${y}-${mo}-${d}` : null;
  }
  if (/\b(tomorrow|tmrw|tmw)\b/.test(lower)) return tomorrowKey(now);
  if (/\b(today|tonight|tonite)\b/.test(lower)) return todayKey(now);
  // "next <weekday>" (NEX-316) — colloquially ambiguous (this-coming vs the
  // following week); the bare-weekday loop below can't tell it from "friday".
  // chrono resolves the coming one; tryCalendar flags it so an IRREVERSIBLE
  // calendar write asks first rather than silently committing the guess (a
  // reversible to-do takes it directly). Runs before the loop so "next friday"
  // is chrono-sourced, not loop-sourced.
  if (isAmbiguousNextWeekday(lower)) {
    const chrono = resolveChronoDate(lower, now);
    if (chrono) return chrono.dateStr;
  }
  for (const [name, dow] of WEEKDAYS) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return nextWeekday(now, dow);
  }
  return null;
}

// ─── Time DETECTION (never resolution) ───────────────────────────────────────

/**
 * True when the utterance names a clock. Detection only — Tier-1 never resolves
 * a clock to a time (that long tail of precedence edge cases is deferred to the
 * AI). A clock present → defer the whole capture.
 */
function hasClock(lower: string): boolean {
  return (
    /\b\d{1,2}:\d{2}\b/.test(lower) ||
    /\b\d{1,2}\s*(a\.?m\.?|p\.?m\.?)\b/.test(lower) ||
    /\b(at|by|before|around|til|till|until)\s+\d{1,2}\b/.test(lower) || // incl. connector clocks ("by 3")
    /@\s*\d{1,2}\b/.test(lower) || // "@" connector — resolveTime accepts it, so detection must match ("@ 3 tomorrow" defers, not "Call mom @ 3")
    /\b(noon|midday|midnight)\b/.test(lower)
  );
}

/**
 * True when the utterance names a vague time-of-day ("this afternoon", "at
 * night") that implies a schedule we can't represent — defer to the AI. NOTE:
 * "tonight" is intentionally excluded: `resolveDate` maps it cleanly to today,
 * so "help with dinner tonight" stays an offline dated to-do (matches the
 * prompt's own example). The habit path consumes "every morning" as a cadence
 * block before these checks run, so habits are unaffected.
 */
function hasTimeOfDayWord(lower: string): boolean {
  return /\b(this\s+|in\s+the\s+)?(morning|afternoon|evening|night)\b/.test(lower);
}

// ─── Time RESOLUTION (NEX-258) ───────────────────────────────────────────────
//
// Resolve ONLY unambiguous clocks, and only when connector-led (at/by/around/@)
// or trailing — so a mid-title number ("the 7pm show", "table for 2 at 8pm" is
// fine; "the 7pm show" is not) never becomes the schedule. Bare/ambiguous hours
// ("at 3", "at 3:30" with no meridiem) resolve to null → the capture still
// defers to the AI (hasClock detects them; tryTodo bails on hasClock && !time).
//
// CLOCK_TOKEN is the SINGLE source of truth for "what a clock looks like",
// shared by resolveTime and the trailing-title stripper (CLOCK_STRIP) so the two
// can't drift. It matches a whole clock as ONE token (so "9:00pm" isn't double-
// counted by a colon + am/pm pass).
const CLOCK_TOKEN =
  /\d{1,2}:[0-5]\d\s*(?:a\.?m\.?|p\.?m\.?)?|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|\b(?:noon|midday|midnight)\b/gi;

// Parse a single clock token to {h,m}, or null if ambiguous/out-of-range.
function parseClockToken(tok: string): { h: number; m: number } | null {
  const t = tok.trim().toLowerCase();
  if (t === 'noon' || t === 'midday') return { h: 12, m: 0 };
  if (t === 'midnight') return { h: 0, m: 0 };
  // am/pm (hour 1–12, optional minutes)
  const ap = t.match(/^(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)$/);
  if (ap) {
    let h = parseInt(ap[1], 10);
    const m = ap[2] ? parseInt(ap[2], 10) : 0;
    if (h < 1 || h > 12) return null;
    const pm = ap[3].startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return { h, m };
  }
  // 24-hour colon — only unambiguous hours (0 or 13–23); 1–12 without a meridiem
  // is ambiguous and defers.
  const h24 = t.match(/^(\d{1,2}):([0-5]\d)$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const m = parseInt(h24[2], 10);
    if (h !== 0 && (h < 13 || h > 23)) return null; // 1–12 ambiguous, >23 invalid
    return { h, m };
  }
  return null;
}

/**
 * Resolve an unambiguous, connector-led/trailing clock to 'HH:mm', or null.
 * Conservative: ≥2 clock tokens anywhere → null (defer); 0 resolvable → null.
 */
function resolveTime(lower: string): string | null {
  const all = lower.match(CLOCK_TOKEN);
  if (all && all.length >= 2) return null; // multiple clocks → defer (also guards stray title words like "Midnight")
  CLOCK_TOKEN.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = CLOCK_TOKEN.exec(lower)) !== null) {
    const start = mm.index;
    const end = start + mm[0].length;
    const before = lower.slice(0, start);
    const after = lower.slice(end);
    const connectorLed = /(?:\bat|\bby|\baround|@)\s*$/.test(before);
    const trailing = /^\s*[.!?]*\s*$/.test(after);
    if (!connectorLed && !trailing) continue;
    const parsed = parseClockToken(mm[0]);
    if (parsed) return `${pad(parsed.h)}:${pad(parsed.m)}`;
  }
  return null;
}

// ─── Event duration + ISO building (NEX-241, calendar_add) ───────────────────

/**
 * Explicit event duration in minutes, or the 60-min default. "for N min" (1–600),
 * "for N hour" (1–12). **Connector-anchored** (`for`/`lasting`) the same way
 * `resolveTime` anchors the clock — a BARE mid-title number ("45 minute review",
 * "table for 2") must NOT silently become the event length on the no-undo path.
 * An out-of-range or absent duration → 60 (we never defer on duration, and never
 * emit 0 — `start < end` must always hold for the irreversible write).
 *
 * INVARIANT: the per-unit digit widths here (minutes `\d{1,3}`, hours `\d{1,2}`)
 * must stay identical to the title duration-strip in `stripCalendarScheduleTail`, so a
 * phrase is either consumed-as-duration AND stripped, or neither — the two can't
 * disagree on what counts as a duration.
 */
function parseDurationMinutes(lower: string): number {
  const min = lower.match(/\b(?:for|lasting)\s+(\d{1,3})\s*-?\s*(min|mins|minute|minutes)\b/);
  if (min) {
    const n = parseInt(min[1], 10);
    if (n >= 1 && n <= 600) return n;
  }
  const hr = lower.match(/\b(?:for|lasting)\s+(\d{1,2})\s*-?\s*(hour|hours|hr|hrs)\b/);
  if (hr) {
    const n = parseInt(hr[1], 10);
    if (n >= 1 && n <= 12) return n * 60;
  }
  return 60;
}

/**
 * Build naive-LOCAL start/end ISO (`YYYY-MM-DDTHH:mm:00`, NO `Z`) from a date key
 * + `HH:mm` + duration. Naive-local is load-bearing: the executor does
 * `new Date(action.startISO)`, which parses a no-`Z` string as LOCAL time — a `Z`
 * would shift it by the UTC offset and write the wrong hour. End is start +
 * durationMin via ms math, so a DST-boundary event still spans the right elapsed
 * time. Returns the built start Date too so the caller can apply the past guard.
 */
function buildEventISO(
  dateKey: string,
  hhmm: string,
  durationMin: number,
): { startISO: string; endISO: string; start: Date } {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const start = new Date(y, mo - 1, d, h, mi, 0, 0);
  const end = new Date(start.getTime() + durationMin * 60000);
  const fmt = (dt: Date) => `${dateKeyOf(dt)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
  return { startISO: fmt(start), endISO: fmt(end), start };
}

// ─── Title cleanup ───────────────────────────────────────────────────────────

// The schedule phrase is at the END of natural captures ("pick up milk friday").
// Strip TRAILING schedule tokens only, so mid-title words and names are preserved
// ("prep the sat materials", "email Thu about Friday" keep their interior words).
const TRAILING_SCHEDULE: RegExp[] = [
  /\s+every\s+(morning|afternoon|evening|night)$/i,
  /\s+(this\s+|in\s+the\s+)?(morning|afternoon|evening|night)$/i,
  /\s+(every\s*day|everyday|daily|each\s*day)$/i,
  /\s+(on\s+|every\s+|each\s+)?(weekdays?|weekends?)$/i,
  /\s+(on\s+|by\s+|due\s+|before\s+|every\s+|each\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)s?$/i,
  /\s+(once|twice|three|four|five|six|\d{1,2})\s*(times?)?\s*(a|per)\s*day$/i,
  // NEX-302: redundant cadence tails Rule 16 promises to strip ("…every week",
  // "…every 2 weeks", "weekly"). Tail-anchored, so a leading "Weekly review"
  // stays intact. The bare (every|each)( other)? form clears the residue left
  // once a weekday token strips out of "…every other Friday".
  /\s+(weekly|biweekly|fortnightly)$/i,
  /\s+(every|each)\s+(other\s+|second\s+|two\s+|three\s+|few\s+|\d+\s+)?(days?|weeks?|months?)$/i,
  /\s+(every|each)(\s+other)?$/i,
  /\s+\d{4}-\d{2}-\d{2}$/,
  /\s+(today|tonight|tonite|tomorrow|tmrw|tmw)$/i,
  // NEX-258: trailing clock — mirrors exactly the forms resolveTime accepts
  // (connector + clock, trailing meridiem-bearing clock, noon/midnight). The
  // bare form REQUIRES a meridiem so "buy 3 apples" / "level 9 boss" are kept.
  // These only ever run on a capture that resolved a time (a present-but-
  // unresolved clock defers before we strip), so the single clock here is it.
  // A trailing comma (left behind once a date/clock token between commas is
  // stripped, e.g. "call mom at 10pm, tomorrow" → "…at 10pm,") so the next loop
  // pass can match the now-trailing clock. Titles never meaningfully end in a comma.
  /\s*,\s*$/,
  /\s+(at|by|around|@)\s*\d{1,2}(:[0-5]\d)?\s*(a\.?m\.?|p\.?m\.?)$/i, // "at 10pm", "by 9:30 am"
  /\s+(at|by|around|@)\s*([01]?\d|2[0-3]):[0-5]\d$/i, // "at 15:30" (connector + 24h colon)
  /\s+([01]?\d|2[0-3]):[0-5]\d$/i, // trailing bare 24h colon ("standup 15:30") — mirrors resolveTime's trailing branch
  /\s+\d{1,2}(:[0-5]\d)?\s*(a\.?m\.?|p\.?m\.?)$/i, // trailing bare clock WITH meridiem ("3pm", "10:30 pm")
  // noon/midnight — bare OR with the SAME connectors resolveTime accepts (at/by/around/@).
  /\s+((at|by|around|@)\s+)?(noon|midday|midnight)$/i,
  // NEX-302: "to"/"until" joined the residue set — a stripped trailing clock
  // can leave them dangling ("Wait until 5pm" → "Wait until"). Tail-anchored,
  // so an interior "how to" is untouched; a title genuinely ENDING in a bare
  // connector is residue, not content.
  // NEX-316: "for" joined the residue set — the date-tail strip of "for next
  // thursday" / "for tomorrow" leaves a dangling scheduling "for" ("Flag football
  // for"). Tail-anchored, so an interior "time for tea" is untouched; a title
  // genuinely ending in a bare "for" is residue, matching the to/until precedent.
  /\s+(by|due|before|on|to|until|til|till|for)$/i,
];

function stripTrailingSchedule(s: string): string {
  let out = s.trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of TRAILING_SCHEDULE) {
      const next = out.replace(re, '').trim();
      if (next !== out) {
        out = next;
        changed = true;
        break;
      }
    }
  }
  return out;
}

// ─── Defer detectors ─────────────────────────────────────────────────────────

// Explicit calendar phrasing → defer (offline calendar events are a follow-up).
function hasCalendarPhrase(lower: string): boolean {
  return (
    /\b(to|on|onto|in)\s+(my\s+|the\s+)?calendar\b/.test(lower) ||
    /\bcalendar\s+(block|event|invite)\b/.test(lower)
  );
}

// Duration-bearing event nouns the AI routes to calendar; keep on the AI path.
const APPOINTMENT_RE =
  /\b(meeting|appointment|appt|dentist|doctor|interview|flight|conference|consultation|checkup|check-up|call with|meet with|sync with)\b/i;

// Multiple-intent signals → defer to the AI (which splits compounds).
function isCompound(lower: string): boolean {
  return /\sand\s/.test(lower) || /;|,\s*then\b|\balso\b|\bplus\b/.test(lower);
}

// Interval / biweekly cadence ("every other Friday", "every 2 weeks") is not
// representable in the daysOfWeek model → defer to the AI.
function isIntervalCadence(lower: string): boolean {
  return (
    /\bevery\s+other\b/.test(lower) ||
    /\bbi-?weekly\b/.test(lower) ||
    /\bfortnight/.test(lower) ||
    /\bevery\s+(\d+|other|second|two|three|few)\s+(day|days|week|weeks|month|months)\b/.test(lower)
  );
}

// Two or more disagreeing date tokens ("renew 2026-06-20 cert tomorrow",
// "email friday about thursday") — we can't tell which is the schedule vs part
// of the title, so defer to the AI rather than pick the wrong one.
function hasMultipleDateTokens(lower: string): boolean {
  let count = 0;
  const isoDates = lower.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (isoDates) count += isoDates.length;
  const relatives = lower.match(/\b(today|tonight|tonite|tomorrow|tmrw|tmw)\b/g);
  if (relatives) count += relatives.length;
  const weekdays = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g);
  if (weekdays) count += weekdays.length;
  return count >= 2;
}

// An ISO-shaped date token that does not name a real day (2026-02-31) means our
// parse is untrustworthy — defer the whole capture to the AI.
function hasUnresolvableIsoDate(lower: string): boolean {
  const m = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (!m) return false;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return !(
    dt.getFullYear() === Number(y) &&
    dt.getMonth() === Number(mo) - 1 &&
    dt.getDate() === Number(d)
  );
}

// ─── Identity-verb allow-list (habit-vs-chore is semantic; only fire on these) ─

const IDENTITY_RE =
  /\b(meditat|mantra|pray|prayer|journal|read|reading|work\s*out|workout|gym|exercise|stretch|gratitude|breathwork|breathe|cold plunge|supplements?|water|hydrate|yoga|affirmation)/i;

// Cessation / "break the habit" wording is NOT a new recurring_add — quitting or
// reducing a behavior is a different intent (abstinence, not a daily rep), so
// defer it to the AI rather than create a habit that fires every day.
function isNegativeHabit(lower: string): boolean {
  return (
    /\b(quit|stop|stopping|avoid|avoiding|reduce|reducing|give\s+up|giving\s+up|cut\s+(out|down|back))\b/.test(lower) ||
    /\b(break|kick)\s+(the|my|this|a)\s+habit\b/.test(lower) ||
    /\bbad\s+habit\b/.test(lower) ||
    /\bno\s+more\b/.test(lower)
  );
}

// ─── Cadence parsing for habits (days / timesPerDay / block — never a clock) ──

interface Cadence {
  daysOfWeek: number[];
  preferredTimeBlock?: TimeBlock;
  timesPerDay?: number;
  hasSignal: boolean;
}

const WORD_NUM: Record<string, number> = {
  once: 1, twice: 2, three: 3, four: 4, five: 5, six: 6,
};

function parseCadence(lower: string): Cadence {
  let daysOfWeek: number[] = [];
  let hasSignal = false;

  if (/\b(every\s*day|everyday|daily|each\s*day)\b/.test(lower)) {
    daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
    hasSignal = true;
  } else if (/\b(every\s+)?weekdays?\b/.test(lower)) {
    daysOfWeek = [1, 2, 3, 4, 5];
    hasSignal = true;
  } else if (/\b(every\s+)?weekends?\b/.test(lower)) {
    daysOfWeek = [0, 6];
    hasSignal = true;
  } else {
    // Recurrence is "every/each <weekday>" or a plural "<weekday>s" — NOT a bare
    // "on <weekday>", which is a one-off date the to-do path should resolve.
    const wk =
      lower.match(
        /\b(?:every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)s?\b/,
      ) ?? lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\b/);
    if (wk) {
      const dow = WEEKDAYS.find(([n]) => n === wk[1])?.[1];
      if (dow !== undefined) {
        daysOfWeek = [dow];
        hasSignal = true;
      }
    }
  }

  // Only a RECURRING "every <block>" sets a habit's time block. A one-off
  // "this morning" / "in the morning" is not a recurring time-of-day and must
  // not become a habit's preferredTimeBlock (tryHabit defers those outright).
  let preferredTimeBlock: TimeBlock | undefined;
  const everyBlock = lower.match(/\bevery\s+(morning|afternoon|evening|night)\b/);
  if (everyBlock) {
    preferredTimeBlock = everyBlock[1] as TimeBlock;
    if (daysOfWeek.length === 0) daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
    hasSignal = true;
  }

  let timesPerDay: number | undefined;
  const tpd = lower.match(/\b(once|twice|three|four|five|six|\d{1,2})\s*(times?)?\s*(a|per)\s*day\b/);
  if (tpd) {
    const n = WORD_NUM[tpd[1]] ?? parseInt(tpd[1], 10);
    if (Number.isFinite(n) && n >= 1) {
      timesPerDay = Math.min(12, n);
      hasSignal = true;
      if (daysOfWeek.length === 0) daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
    }
  }

  return { daysOfWeek, preferredTimeBlock, timesPerDay, hasSignal };
}

// ─── Title extractors ────────────────────────────────────────────────────────

function extractHabitTitle(original: string): string {
  let out = original.trim();
  out = out.replace(
    /^(can you |could you |please )?(add|create|make|start|build|set up|set)\s+(a\s+|an\s+)?(new\s+)?(daily\s+)?habit(\s+(of|to|for|called|named))?\s*:?\s*/i,
    '',
  );
  out = out.replace(/^(a\s+|an\s+)?(new\s+)?habit(\s+(of|to|for))?\s*:?\s*/i, '');
  out = stripCaptureFraming(out);
  out = stripTrailingSchedule(out);
  return capitalize(out);
}

// NEX-302: the user's request frame — "can you…", "could you please…", bare
// "please…". Distinct from CAPTURE_FRAMING_PREFIXES (whole compound phrases):
// this matches ONLY the frame, so the remainder can still be framing-stripped
// or verb-stripped by the steps that follow.
const REQUEST_FRAME_RE = /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)/i;

/**
 * Strip the explicit calendar phrase (anywhere — it can be mid-string: "lunch
 * on my calendar friday"). Shared by the offline calendar extractor and the AI
 * title normalizer so the two can't drift. Fresh regex literals per call —
 * never share a /g instance across .test()/.replace() (lastIndex statefulness,
 * see the CLOCK_TOKEN reset above).
 */
function stripCalendarPhrase(s: string): string {
  return s
    .replace(/\b(to|on|onto|in)\s+(my\s+|the\s+)?calendar\b/gi, ' ')
    .replace(/\bcalendar\s+(block|event|invite)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Strip a leading calendar command verb + article. Conservative: only "add"/
 * "schedule"/"set up" — verbs that are almost never title words. NOT "book"/
 * "make"/"put" (Book club, Make dinner) which often ARE the title. (Prompt Rule
 * 16's verb list is wider — it is bare-leading and model-judged; this
 * deterministic strip stays narrow on purpose.)
 */
function stripLeadingCalendarVerb(s: string): string {
  return s.replace(/^(add|schedule|set\s+up)\s+(a\s+|an\s+|the\s+)?/i, '');
}

/**
 * Calendar schedule + duration tail loop. Calendar CONSUMES the duration
 * (parseDurationMinutes), so — unlike the todo path that keeps "for 1 hour" in
 * the title — strip a trailing duration too. Loop schedule+duration together so
 * they peel off in any order ("…at noon for 90 minutes" and "…for 90 minutes at
 * noon" both clean fully). The duration alternative is connector-anchored,
 * mirroring parseDurationMinutes EXACTLY (minutes \d{1,3}, hours \d{1,2}) —
 * only a "for/lasting N <unit>" the parser could consume is stripped; a bare
 * trailing "<N> minutes" (or an out-of-digit-width "100 hours") stays in the
 * title, so strip and parse never disagree on what's a duration.
 */
function stripCalendarScheduleTail(s: string): string {
  let out = s.trim();
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = stripTrailingSchedule(out);
    out = out
      .replace(/\s+(?:for|lasting)\s+(?:\d{1,3}\s*-?\s*(?:minutes?|mins?)|\d{1,2}\s*-?\s*(?:hours?|hrs?))\.?$/i, '')
      .trim();
  }
  return out;
}

/**
 * Calendar title: strip the explicit calendar phrase (anywhere), then the
 * leading framing, the request frame + command verb, the trailing date/clock/
 * duration schedule, and a leading article. Interior words are kept
 * (stripTrailingSchedule only touches the tail).
 */
function extractCalendarTitle(original: string): string {
  let out = stripCalendarPhrase(original.trim());
  out = stripCaptureFraming(out);
  // NEX-302: "can you add X to my calendar…" kept "Can you" in the offline title
  // (the verb strip below couldn't fire through the frame) — strip the frame first.
  out = out.replace(REQUEST_FRAME_RE, '');
  out = stripLeadingCalendarVerb(out);
  out = stripCalendarScheduleTail(out);
  out = out.replace(/^(a\s+|an\s+|for\s+|called\s+|named\s+)/i, '').trim();
  return capitalize(out);
}

// ─── AI-title normalization (NEX-302) ────────────────────────────────────────

/**
 * Deterministic enforcement of prompt Rule 16 on an AI-RETURNED title — the
 * client-side guarantee behind the prompt's ask (the model occasionally echoes
 * the utterance verbatim; a calendar event titled "Can you add podcast at 5 PM
 * today?" shipped that way).
 *
 * PROGRESSIVE: a stage whose output would be empty is skipped, so a non-empty
 * input never normalizes to '' (and never reverts to the verbatim question).
 * Idempotent over realistic AI titles (property-tested); a pathological verb
 * chain ("Add a schedule review") re-strips on a second pass — harmless, since
 * coerceAction applies it exactly once. Each strip is gated by what the action
 * itself carries:
 *   - reminder framing (stripCaptureFraming) — always; it runs FIRST so the
 *     compound prefixes ("can you set a reminder to") match whole, before the
 *     generic frame strip could dismember them;
 *   - the request frame ("can you …") — when the action carries a schedule or
 *     is a calendar event, OR when the post-frame remainder itself opens with
 *     reminder framing ("can you please set a reminder to…"). A rhetorical
 *     unscheduled thought ("can you believe he said that") is untouched;
 *   - calendar phrase + conservative leading verb — calendar_add only;
 *   - the trailing schedule clause (plus duration for calendar) — only when
 *     the action carries its own schedule, so a mid-title clock ("Call about
 *     the 3 PM meeting") and unscheduled titles keep every word.
 */
export function normalizeAiTitle(
  title: string,
  opts: { hasSchedule: boolean; isCalendar: boolean },
): string {
  const keep = (prev: string, next: string): string => (next.trim() ? next.trim() : prev);
  let out = (title ?? '').trim();
  if (!out) return '';
  out = keep(out, stripCaptureFraming(out));
  const frame = out.match(REQUEST_FRAME_RE);
  if (frame) {
    const rest = out.slice(frame[0].length);
    const restHasFraming = matchFramingPrefix(rest.toLowerCase()) !== null;
    if (opts.hasSchedule || opts.isCalendar || restHasFraming) {
      out = keep(out, restHasFraming ? stripCaptureFraming(rest) : rest);
    }
  }
  if (opts.isCalendar) {
    out = keep(out, stripCalendarPhrase(out));
    out = keep(out, stripLeadingCalendarVerb(out));
    out = keep(out, out.replace(/^(a\s+|an\s+|for\s+|called\s+|named\s+)/i, ''));
  }
  if (opts.hasSchedule) {
    // ≥2 clocks in the title means we can't tell a redundant schedule tail
    // from schedule CONTENT ("Move the 3pm call to 5pm") — mirror resolveTime's
    // multi-clock defer and leave the title whole. The TRAILING_SCHEDULE
    // regexes assume the offline invariant "the single clock here is it".
    const clocks = out.match(CLOCK_TOKEN);
    CLOCK_TOKEN.lastIndex = 0;
    if (!clocks || clocks.length < 2) {
      out = keep(out, opts.isCalendar ? stripCalendarScheduleTail(out) : stripTrailingSchedule(out));
    }
  }
  return capitalize(out.replace(/\s{2,}/g, ' ').trim());
}

// ─── Intent attempts (first confident match wins) ────────────────────────────

/**
 * NEX-241: the §14.1 explicit-calendar override → an offline `calendar_add`. This
 * is the ONLY Tier-1 path that triggers an IRREVERSIBLE EventKit write (a real
 * Apple Calendar event, surfaced jump-only with NO undo), so it fires only when
 * the utterance is unambiguous on every axis:
 *   - an explicit calendar phrase (the override), and NOT "habit" (which wins → AI),
 *   - an explicit, resolvable DATE (never date-guess for an irreversible write),
 *   - an unambiguous, connector-led/trailing CLOCK (reuses NEX-258's `resolveTime`,
 *     which defers on ≥2 clocks / ambiguous / mid-title), and
 *   - a start that is NOT in the past (never write a past event; "calendar today
 *     at 9am" said at 5pm defers so the AI can ask "today or tomorrow?").
 * Anything short → `null` (defer to the AI). A surviving event still passes the
 * `resolveCaptureTier` gate (downgrades to Inbox unless the raw transcript carries
 * explicit date+time and confidence is high) — defense in depth.
 *
 * `nextWeekday` returns TODAY when today is that weekday, so a bare-weekday +
 * clock resolves to today; the past guard catches an already-passed time, and a
 * still-future today event fires (consistent with the existing todo path). The
 * residual "meant next <weekday> but it's that weekday this morning" writes a
 * today event — accepted, matching the todo path.
 */
function tryCalendar(original: string, lower: string, now: Date): ProposedAction[] | null {
  if (!hasCalendarPhrase(lower)) return null;
  if (/\bhabit\b/.test(lower)) return null; // "habit" beats the calendar override → AI
  // A recurring cadence ("every Sunday", "every weekday", "every day"/"every week")
  // means a REPEATING calendar event. We don't build recurrence offline — defer to
  // the AI so it emits a calendar_add with a `recurrence` object instead of a wrong
  // one-off. (`isIntervalCadence` already defers "every other"/biweekly upstream.)
  if (parseCadence(lower).hasSignal || /\bevery\s+(week|day)\b/.test(lower)) return null;
  const dateKey = resolveDate(lower, now);
  if (!dateKey) return null; // an irreversible write needs an explicit date
  const time = resolveTime(lower);
  if (!time) return null; // …and an unambiguous clock (ambiguous/multiple → defer)
  const title = extractCalendarTitle(original);
  if (!title) return null;
  const { startISO, endISO, start } = buildEventISO(dateKey, time, parseDurationMinutes(lower));
  if (start.getTime() < now.getTime()) return null; // never write a past event
  // NEX-316: "next <weekday>" is colloquially ambiguous (this-coming vs the
  // following week). chrono resolved ONE date, but for an IRREVERSIBLE EventKit
  // write that guess must be confirmed, never silently committed — emit at
  // 'medium' so resolveCaptureTier captures it to a visible Inbox item (Law A)
  // rather than auto-writing. A non-ambiguous date (tomorrow, a named weekday, an
  // ISO date) stays 'high' and writes directly.
  const ambiguous = isAmbiguousNextWeekday(lower);
  return [
    normalizeProposedAction({
      type: 'calendar_add',
      title,
      startISO,
      endISO,
      confidence: ambiguous ? 'medium' : 'high',
      missingFields: [],
      explanation: ambiguous
        ? 'Recognized offline, but "next <weekday>" is ambiguous, so captured to Inbox to confirm the date.'
        : 'Recognized offline. Explicit calendar reference with a date and time.',
    }),
  ];
}

function tryHabit(original: string, lower: string): ProposedAction[] | null {
  if (hasCalendarPhrase(lower)) return null; // habit + explicit calendar is ambiguous → AI
  if (hasClock(lower)) return null; // a habit with a specific clock → AI (no offline clock resolution)
  if (isNegativeHabit(lower)) return null; // "quit/break the habit" is not a new recurring rep → AI
  if (/\b(this|in\s+the)\s+(morning|afternoon|evening|night)\b/.test(lower)) return null; // one-off time-of-day, not a recurring routine → AI
  const hasHabitWord = /\bhabit\b/.test(lower);
  const cadence = parseCadence(lower);
  const fire = hasHabitWord || (cadence.hasSignal && IDENTITY_RE.test(lower));
  if (!fire) return null;
  const title = extractHabitTitle(original);
  if (!title) return null;
  return [
    normalizeProposedAction({
      type: 'recurring_add',
      title,
      daysOfWeek: cadence.daysOfWeek,
      preferredTimeBlock: cadence.preferredTimeBlock,
      timesPerDay: cadence.timesPerDay,
      confidence: 'high',
      missingFields: cadence.daysOfWeek.length === 0 ? ['daysOfWeek'] : [],
      explanation: 'Recognized offline as a recurring habit.',
    }),
  ];
}

/**
 * NEX-262: strip a FRAMED time-of-day block ("this afternoon", "in the evening")
 * from ANYWHERE in a to-do title — the "this"/"in the" frame is clearly schedule
 * intent, never a title word, so a leading/mid block ("this afternoon walk the dog
 * tomorrow") doesn't leak. A POSSESSIVE ("this morning's standup notes") is KEPT
 * via the `(?!['’]s)` guard — it's a legitimate reference, not a schedule. BARE
 * blocks ("morning walk", "night shift") are intentionally NOT touched here; they
 * stay as title words, and `stripTrailingSchedule` removes them only when trailing.
 */
function stripTodoTimeOfDay(s: string): string {
  return s
    .replace(/\b(this|in\s+the)\s+(morning|afternoon|evening|night)\b(?!['’]s)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * NEX-262: true when a stripped to-do title carries NO real content — only
 * leftover schedule/date/article tokens. Stripping a framed block can expose a
 * lone date that the tail-anchored `stripTrailingSchedule` can't reach
 * ("this evening tomorrow" → "tomorrow"); such a "title" is a degenerate schedule
 * fragment, so the capture defers to the AI instead of becoming a to-do called
 * "Tomorrow". A title with any real word ("Monday report" → "report" remains) is
 * NOT residue and keeps its full text.
 */
function isScheduleOnlyTitle(title: string): boolean {
  const remaining = title
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(
      /\b(today|tonight|tonite|tomorrow|tmrw|tmw|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|morning|afternoon|evening|night|the|a|an)\b/g,
      ' ',
    )
    // Only whitespace + punctuation count as "nothing left". Letters of ANY script,
    // digits, and emoji/symbols are real content, so "🌙 tonight" and "买菜 tomorrow"
    // still fire while a lone "tomorrow" or "the ," defers. (Don't nuke non-ASCII.)
    .replace(/[\s\p{P}]+/gu, '');
  return remaining.length === 0;
}

function tryTodo(original: string, lower: string, now: Date): ProposedAction[] | null {
  if (hasCalendarPhrase(lower)) return null;
  if (APPOINTMENT_RE.test(lower)) return null; // duration-event nouns stay on the AI path
  if (parseCadence(lower).hasSignal) return null; // recurring intent is the AI's call, not a one-off
  const dateKey = resolveDate(lower, now);
  // NEX-262: a time-of-day block ("tomorrow afternoon", "friday evening") is
  // scheduleable offline ONLY when it rides an EXPLICIT date — then the block is a
  // refinement we drop and the date carries the to-do (and the confidence-tier
  // gate, which re-checks the RAW transcript for a DATE word — time-of-day words
  // live in its TIME_RE, but todo_add's actionNeed only consults hasExplicitDate).
  // A date-LESS block ("this afternoon") would need a
  // clock guess or a second gate change, so it still defers to the AI.
  if (hasTimeOfDayWord(lower) && !dateKey) return null;
  // NEX-258: resolve an unambiguous clock offline. An ambiguous / mid-title clock
  // (hasClock true but unresolved) still defers, exactly as before.
  const time = resolveTime(lower);
  if (hasClock(lower) && !time) return null;
  // A clock with no explicit date emits a time-only todo (no dateStr): the
  // confidence-tier "When?" chip resolves the day (one tap) and preserves time.
  // Neither a date nor a time → today's behavior (defer).
  if (!dateKey && !time) return null;
  // capitalize LAST: stripTodoTimeOfDay can remove the leading (already-capitalized)
  // framed block, so re-capitalize the new first word ("this afternoon walk…" → "Walk…").
  // A trailing dangling article (left when a tail block strips, "review the evening
  // tomorrow" → "Review the") is also cleaned.
  const stripped = stripTrailingSchedule(stripTodoTimeOfDay(stripCaptureFraming(original)))
    .replace(/\s+(the|a|an)$/i, '')
    .trim();
  const title = capitalize(stripped);
  // Defer when nothing real survives the strip (a lone residual date/schedule word,
  // e.g. "this evening tomorrow" → "tomorrow") — never auto-fire a junk title.
  if (!title || isScheduleOnlyTitle(stripped)) return null;
  return [
    normalizeProposedAction({
      type: 'todo_add',
      title,
      ...(dateKey ? { dateStr: dateKey } : {}),
      ...(time ? { time } : {}),
      confidence: 'high',
      missingFields: dateKey ? [] : ['dateStr'],
      explanation: 'Recognized offline as a dated to-do.',
    }),
  ];
}

function tryInbox(original: string, lower: string, now: Date): ProposedAction[] | null {
  if (!hasReminderFraming(lower)) return null;
  if (parseCadence(lower).hasSignal) return null; // recurring framing → AI
  if (resolveDate(lower, now)) return null; // a date → todo/calendar territory
  if (hasClock(lower) || hasTimeOfDayWord(lower)) return null; // an implied time → AI can schedule/ask
  const title = stripCaptureFraming(original);
  if (!title) return null;
  return [
    normalizeProposedAction({
      type: 'inbox_add',
      title,
      confidence: 'high',
      missingFields: [],
      explanation: 'Recognized offline as a capture for your Inbox.',
    }),
  ];
}

/**
 * Explicit-inbox list override — the one compound the grammar handles itself.
 *
 * "Add to my inbox: call the mortgage company, call the city, and change my
 * bank accounts" is an EXPLICIT routing instruction plus a comma-separated
 * list; deferring it to the AI made the whole capture hostage to network/auth
 * weather (the exact production incident: a stale-JWT 401 read as "no" three
 * times). When the user names the destination, saving there must not require
 * a model. Fires only when:
 *   - an add-verb + inbox phrase is present ("add/put/save/... to/in my
 *     inbox", "inbox this/these"), so "the email in my inbox is old" never
 *     matches, and
 *   - the item list splits on commas/semicolons. A comma-less "A and B" still
 *     defers to the AI — a bare "and" is often mid-title ("call mom and dad"),
 *     and a wrong split is worse than the AI path. A leading "and/also/then"
 *     on a fragment (the Oxford tail) is framing, not content, and is
 *     stripped.
 * Items are captured VERBATIM (no date parsing, per the §14.1 explicit-
 * destination spirit); resolveCaptureTier still re-gates the result.
 */
const EXPLICIT_INBOX_DIRECTIVE_RE =
  /\b(?:add|put|save|drop|throw|dump|stick|toss|capture)\b[^.?!]{0,40}?\b(?:to|in|into|onto|on)\s+(?:my\s+|the\s+)?inbox\b|\binbox\s+(?:this|these|it|them)\b/i;

// Mirrors buildTranscriptInboxAction's cap in command-parser.ts — keeping the
// words beats keeping them pretty, but an unbounded verbatim title is still a
// latent overflow risk downstream (rendering, storage). Duplicated rather
// than imported: command-parser.ts already imports FROM this file
// (normalizeAiTitle), so importing back would create a cycle.
function capTitle(s: string): string {
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

function tryExplicitInboxList(original: string): ProposedAction[] | null {
  // Match against `original` — the regex already carries the `i` flag, so
  // case doesn't affect where it matches, and this keeps match.index valid
  // for slicing the ORIGINAL (not lowercased) string below.
  const match = EXPLICIT_INBOX_DIRECTIVE_RE.exec(original);
  if (!match) return null;
  // Slice from the END of the MATCHED directive, not from an independently
  // re-searched "first inbox in the string" — a transcript can mention
  // "inbox" earlier for an unrelated reason ("my inbox is a mess, add to my
  // inbox: buy milk") and a first-occurrence search would fold that leading,
  // unrelated text into the captured list. Anchoring on match.index makes
  // the remainder start exactly where the directive itself ends, regardless
  // of which alternative fired or what came before it in the utterance.
  const remainder = original
    .slice(match.index + match[0].length)
    .replace(/^[\s:,.?!-]+/, '')
    .trim();
  if (!remainder) return null;
  const fragments = remainder
    .split(/[,;]/)
    .map((f) => f.replace(/^\s*(?:and|also|then|plus)\b\s*/i, '').replace(/[.!?\s]+$/g, '').trim())
    .filter(Boolean);
  if (fragments.length === 0) return null;
  // No commas + a bare "and" → ambiguous split, defer to the AI.
  if (fragments.length === 1 && /\sand\s/.test(fragments[0].toLowerCase())) return null;
  return fragments.map((fragment) =>
    normalizeProposedAction({
      type: 'inbox_add',
      title: capTitle(capitalize(fragment)),
      confidence: 'high',
      missingFields: [],
      explanation: 'Recognized offline — explicit inbox list.',
    }),
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Deterministic Tier-1 parse. Returns fully-resolved high-confidence actions, or
 * `null` to fall through to the AI proxy. Total / no-throw by construction.
 */
export function parseCaptureGrammar(text: string, now: Date): ProposedAction[] | null {
  try {
    const original = (text ?? '').trim();
    if (!original) return null;
    const lower = original.toLowerCase();
    // Runs BEFORE the compound bail: an explicit inbox directive + comma list
    // is the one compound whose destination the user already decided.
    const explicitInbox = tryExplicitInboxList(original);
    if (explicitInbox) return explicitInbox;
    if (isCompound(lower)) return null;
    if (isIntervalCadence(lower)) return null;
    if (hasMultipleDateTokens(lower)) return null;
    if (hasUnresolvableIsoDate(lower)) return null;
    return (
      tryCalendar(original, lower, now) ?? // explicit-calendar override (NEX-241) runs first
      tryHabit(original, lower) ??
      tryTodo(original, lower, now) ??
      tryInbox(original, lower, now) ??
      null
    );
  } catch {
    return null;
  }
}
