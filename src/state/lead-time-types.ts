/**
 * Lead-Time Radar (NEX-162) — pure types + date/status helpers.
 *
 * A `LeadTimeAction` is a prep action attached to a future event date with a
 * computed "act-by" date. Status (waiting/due/overdue/done) is DERIVED from
 * dates by a selector and never stored — there is no scheduler.
 *
 * Pure module (no RN imports) so app-state.ts imports FROM here and the math is
 * unit-testable in the Node vitest suite — same direction as `today-rollup` and
 * `habit-log-reconcile`. See `selectors/lead-time.ts` for the rollup.
 */
import { getLocalDateKey } from '../utils/recurrence';

export interface LeadTimeAction {
  id: string;
  title: string;            // the action: "Request June 28 off"
  eventTitle: string;       // "Sean's wedding"
  eventDate: string;        // YYYY-MM-DD (projected via getLocalDateKey at creation)
  eventId?: string | null;  // informational only — EventKit ids churn across sync; never navigate by it
  actByDate: string;        // YYYY-MM-DD; eventDate minus leadDays at creation, user-editable after
  leadDays: number;         // 7 | 14 | 21 | 30 | custom
  completed: boolean;       // toggle source of truth; `done` status derives from THIS
  completedAt?: number;     // unix ms; stamped once on false→true, never overwritten/cleared (InboxTask precedent)
  createdAt: number;
  source: 'manual';         // 'voice' reserved for the Eye fast-follow
}

export type LeadTimeStatus = 'waiting' | 'due' | 'overdue' | 'done';

/** Default surfacing window: an open action becomes "due" once today is within
 *  this many days BEFORE its act-by date. */
export const LEAD_TIME_DUE_WINDOW_DAYS = 7;

/** Hour (local) the act-by-morning notification fires. */
export const LEAD_TIME_FIRE_HOUR = 9;

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a well-formed YYYY-MM-DD key. */
function isDateKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v);
}

/**
 * Parse a YYYY-MM-DD key to a LOCAL-noon Date. Noon (not midnight) so adding or
 * subtracting whole days can never cross a midnight under a ±1h DST shift, which
 * `new Date('YYYY-MM-DD')` (parsed as UTC) would do — shifting the date a day in
 * US time zones. Returns null for a malformed key.
 */
function parseKeyToLocalNoon(key: string): Date | null {
  const m = KEY_RE.exec(typeof key === 'string' ? key : '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

/** Shift a YYYY-MM-DD key by `days` (may be negative), DST-safe. Malformed → returned unchanged. */
export function addDaysToKey(key: string, days: number): string {
  const d = parseKeyToLocalNoon(key);
  if (!d) return key;
  d.setDate(d.getDate() + Math.round(days));
  return getLocalDateKey(d);
}

/**
 * Act-by date = event date minus the lead days. `eventDate` is normalized
 * through `getLocalDateKey` first so a raw ISO datetime (e.g. an all-day
 * EventKit event's midnight timestamp) is projected to the correct local day
 * before the subtraction. `leadDays` is clamped to a non-negative integer.
 */
export function computeActByDate(eventDate: string | Date, leadDays: number): string {
  const key = getLocalDateKey(eventDate);
  const lead = Number.isFinite(leadDays) ? Math.max(0, Math.round(leadDays)) : 0;
  return addDaysToKey(key, -lead);
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format a YYYY-MM-DD key as "Jun 27" (no weekday, no year). Malformed → returned unchanged. */
export function formatKeyShort(key: string): string {
  const m = KEY_RE.exec(typeof key === 'string' ? key : '');
  if (!m) return key;
  return `${MONTHS_SHORT[Number(m[2]) - 1]} ${Number(m[3])}`;
}

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Format a YYYY-MM-DD key as "Sat, Jun 27" (short weekday + short month + day,
 * no year). The shared label for the weekly look-forward and lead-time surfaces
 * (NEX-271) so both stay consistent. Weekday derives from the local-noon parse
 * (DST-safe) and a static array (no `toLocaleDateString` locale/timezone
 * variance). Malformed → returned unchanged.
 */
export function formatKeyShortWithWeekday(key: string): string {
  const d = parseKeyToLocalNoon(key);
  if (!d) return key;
  return `${DAYS_SHORT[d.getDay()]}, ${formatKeyShort(key)}`;
}

/** Whole-day delta `toKey - fromKey` (DST-safe, local-noon). Malformed → 0. */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  const a = parseKeyToLocalNoon(fromKey);
  const b = parseKeyToLocalNoon(toKey);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Fire time (ms) for a lead-time one-shot: LEAD_TIME_FIRE_HOUR local on the
 * act-by date. Field-based parse (never the `new Date('YYYY-MM-DD')` UTC trap).
 * Returns null if the key is malformed OR the fire time is already past — so a
 * past/today-after-9 act-by schedules nothing. Pure (`nowMs` injectable).
 */
export function leadTimeFireAt(actByDate: string, nowMs: number = Date.now()): number | null {
  const m = KEY_RE.exec(typeof actByDate === 'string' ? actByDate : '');
  if (!m) return null;
  const fire = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), LEAD_TIME_FIRE_HOUR, 0, 0, 0).getTime();
  return fire > nowMs ? fire : null;
}

/**
 * Derive an action's status as a pure function of the action + today's key.
 * - done:    completed flag set.
 * - overdue: open and today is past the act-by date.
 * - due:     open and act-by is today..today+window (the surfacing window).
 * - waiting: open and act-by is further out.
 * Keys compare lexicographically because YYYY-MM-DD sorts chronologically.
 */
export function bucketLeadTimeAction(
  action: Pick<LeadTimeAction, 'actByDate' | 'completed'>,
  todayKey: string,
  dueWindowDays: number = LEAD_TIME_DUE_WINDOW_DAYS,
): LeadTimeStatus {
  if (action.completed) return 'done';
  if (action.actByDate < todayKey) return 'overdue';
  const dueThreshold = addDaysToKey(todayKey, dueWindowDays);
  if (action.actByDate <= dueThreshold) return 'due';
  return 'waiting';
}

/**
 * v28 migration body / inbound-cloud sanitizer. Validates and normalizes a
 * persisted `leadTimeActions` value. Pure and idempotent — a well-formed array
 * round-trips unchanged; anything malformed is dropped. For the brand-new field
 * the persisted value is `undefined` for every existing user → `[]`.
 */
export function backfillLeadTimeActions(persisted: unknown): LeadTimeAction[] {
  if (!Array.isArray(persisted)) return [];
  const out: LeadTimeAction[] = [];
  for (const a of persisted) {
    if (
      !a ||
      typeof a !== 'object' ||
      typeof (a as any).id !== 'string' ||
      typeof (a as any).title !== 'string' ||
      // Validate the date-key FORMAT, not just the type — a corrupted cloud row
      // with eventDate/actByDate "not-a-date" would otherwise survive and bucket
      // wrong (lexicographic compares against a malformed key). (Greptile)
      !isDateKey((a as any).eventDate) ||
      !isDateKey((a as any).actByDate)
    ) {
      continue;
    }
    const r = a as any;
    out.push({
      id: r.id,
      title: r.title,
      eventTitle: typeof r.eventTitle === 'string' ? r.eventTitle : '',
      eventDate: r.eventDate,
      eventId: typeof r.eventId === 'string' ? r.eventId : null,
      actByDate: r.actByDate,
      leadDays: typeof r.leadDays === 'number' && Number.isFinite(r.leadDays) ? r.leadDays : 0,
      completed: r.completed === true,
      completedAt: typeof r.completedAt === 'number' ? r.completedAt : undefined,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      source: 'manual',
    });
  }
  return out;
}
