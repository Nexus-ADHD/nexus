/**
 * north-star-metrics.ts — NEX-188 (ADHD Pivot P0-c, backlog L-4)
 *
 * The canonical contract + computation for Nexus's two north-star metrics,
 * which replace DAU and streak-length (both mislead for an ADHD audience — see
 * the original internal metrics spec):
 *
 *   1. hunts-to-find-a-captured-item → 0   (object permanence / Law A)
 *   2. return-after-a-lapse rate           (re-engagement without shame / Laws B,C)
 *
 * This module is PURE: no React Native / Expo / analytics imports, so vitest
 * (Node-only) covers every boundary. It is the single source of truth for the
 * metric enums, constants, the per-event PII-free prop-key arrays, and the
 * offline computation helpers. `analytics.ts` may import FROM here (one-way);
 * this module must never import `analytics.ts` (that would pull AsyncStorage).
 *
 * SCOPE NOTE: NEX-188 defined the contract; NEX-222 wires the capture/open
 * emitters; NEX-215 wires the SURFACED reach emitters; NEX-261 wires the
 * `manual_nav` HUNT path. `item_captured` (capture site) and `app_opened`
 * (foreground) are live, consent-gated. `item_captured` is in `BACKFILL_PROP_KEYS`
 * (low-frequency, replay-worthy); `app_opened` is deliberately excluded
 * (every-foreground → replay flood).
 *
 * `captured_item_first_reached` now carries BOTH surfaced reaches
 * (`confirmation_jump`, `home_echo`) and the `manual_nav` hunt path (first
 * deliberate engagement with a captured item via the Inbox list — complete /
 * edit). True-first attribution across all sites is enforced by the device-local
 * `capture-reach-tracker` (emit once, on the genuine first reach). `search` stays
 * inert (no search surface).
 *
 * HARD PRECONDITION for `computeHuntFirstReachRate` below — do NOT relax to prose:
 * its inputs MUST be pre-filtered to a single item_type whose hunt path is fully
 * instrumented. Today that is `item_type === 'one_off'` ONLY (the Inbox is the one
 * list with both surfaced reaches AND the deliberate-interaction manual_nav paths
 * — complete / manage; incidental touches like drag-reorder are intentionally
 * excluded). Feeding the raw, multi-item_type stream SILENTLY produces a
 * false-zero hunt rate, because
 * non-one_off surfaces (habit/recurring/mandate) still emit `confirmation_jump`
 * but have NO manual_nav path yet — so their reaches are all surfaced by
 * construction. Filter to `one_off` at query time. Caveat (documented, accepted
 * for P4): the rate is device-local first-reach and the tracker's LRU cap can
 * evict the oldest captures, slightly biasing very-high-volume users' rate down.
 * The exported key arrays below are the single source the allow-list reuses.
 *
 * PRIVACY: every prop key listed below is metrics-only (opaque store-entity id,
 * enum, count, or local day-key) — never user-authored content. Per the
 * 2026-06-04 "metrics-only until consent" decision.
 *
 * Day math is done in local `day_key` space (`YYYY-MM-DD`), matching
 * `lastOpenDate` (app-state) and `nexus_events.day_key`, so a lapse is stable
 * across DST and travel — a raw millisecond delta is not.
 *
 * NEX-222 adds the EMISSION helpers below (item-type derivation + ledger capture
 * extraction). The CaptureSurface import is TYPE-ONLY (erased at runtime), and
 * `confirmation-copy` is itself a pure, React-free module, so this stays
 * vitest-Node loadable.
 */
import type { CaptureSurface } from '../features/command/confirmation-copy';

// ─── Enums / types ──────────────────────────────────────────────────────────

/** What kind of entity a capture produced. Enum, never the item's title. */
export type ItemType = 'one_off' | 'recurring' | 'habit' | 'calendar' | 'mandate';

/**
 * HOW a captured item was first reached. Maps 1:1 to concrete tap sites so the
 * emitter ticket has an unambiguous wiring target:
 *  - confirmation_jump  → the NEX-195 ledger one-tap JUMP
 *  - home_echo          → the NEX-196 Home echo chip
 *  - home_today         → reached via the Home "Today" surfaced slot
 *  - manual_nav         → user navigated to a tab/list to find it   (a HUNT)
 *  - search             → user searched to find it                  (a HUNT)
 *  - deep_link          → opened from a widget / notification (reserved; inert
 *                         until those surfaces ship)
 */
export type AccessMethod =
  | 'confirmation_jump'
  | 'home_echo'
  | 'home_today'
  | 'manual_nav'
  | 'search'
  | 'deep_link';

/** Coarse "how long after capture was it first reached" bucket. Enum, not a raw ts. */
export type AgeBucket = 'under_1m' | 'under_1h' | 'under_1d' | 'over_1d';

/**
 * Coarse-bucket the latency from capture to a reach (NEX-215, L-4). A raw ms
 * delta would be PII-adjacent and noisy; the enum is the metrics-only signal.
 * A reach earlier than the capture (clock skew) clamps to `under_1m`, never a
 * negative-derived bucket. The caller is responsible for NOT emitting when
 * `capturedAtMs` is unknown (missing / `0` sentinel / non-finite) — this helper
 * assumes both inputs are finite ms.
 */
export function ageBucket(capturedAtMs: number, reachedAtMs: number): AgeBucket {
  const diff = reachedAtMs - capturedAtMs;
  if (diff < 60_000) return 'under_1m'; // also catches clock-skew negatives
  if (diff < 3_600_000) return 'under_1h';
  if (diff < 86_400_000) return 'under_1d';
  return 'over_1d';
}

/** A first reach is either a hunt (friction) or surfaced (frictionless). */
export type ReachAttribution = 'hunt' | 'surfaced';

// ─── Emission helpers (NEX-222) ─────────────────────────────────────────────

/**
 * `item_type` derived deterministically from the capture surface — a closed
 * enum, never the freeform `LedgerItem.type` string (which could carry content).
 * The surface IS the type discriminator the executor already uses:
 * `home_today` carries `recurring_add` habit captures (habits surface on Home
 * Today), while `orbit` carries recurring to-dos — so they map to `habit` vs
 * `recurring` respectively, keeping the habit slice intact.
 */
export function itemTypeForSurface(surface: CaptureSurface): ItemType {
  switch (surface) {
    case 'inbox':
      return 'one_off';
    case 'orbit':
      return 'recurring';
    case 'home_today':
      return 'habit';
    case 'align':
      return 'mandate';
    case 'calendar':
      return 'calendar';
  }
}

/** One `item_captured` fact extracted from a committed ledger row. */
export interface ExtractedCapture {
  captureId: string;
  itemType: ItemType;
  surface: CaptureSurface;
}

/** Minimal shape of a committed ledger row the extractor reads. */
export interface LedgerRowLike {
  status: 'success' | 'failed' | 'partial';
  entityId?: string;
  surface?: CaptureSurface;
}

/**
 * The captures to emit `item_captured` for, from an executor ledger. A row
 * counts when it did NOT fail AND created a Nexus entity (`entityId`) on a known
 * `surface` — so `partial` rows (local entity created, Apple sync failed) still
 * count, and raw `calendar` events (no `entityId`) are excluded (they have no
 * stable, opaque `capture_id`). `entityId` is the opaque join key, never content.
 */
export function extractCaptures(ledger: readonly LedgerRowLike[]): ExtractedCapture[] {
  const out: ExtractedCapture[] = [];
  for (const row of ledger) {
    if (row.status === 'failed' || !row.entityId || !row.surface) continue;
    out.push({
      captureId: row.entityId,
      itemType: itemTypeForSurface(row.surface),
      surface: row.surface,
    });
  }
  return out;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** A lapse is at least this many consecutive inactive days after the last active day. */
export const LAPSE_THRESHOLD_DAYS = 3;

/** A return counts if it falls within this many days of the last active day. */
export const RETURN_WINDOW_DAYS = 30;

// ─── PII-free prop-key contract (for the emitter ticket) ────────────────────
//
// These are the EXACT prop keys each event may carry. The emitter ticket adds
// matching entries to `BACKFILL_PROP_KEYS` in analytics.ts; until then the
// replay allow-list is untouched (no emitters → nothing to replay).

export const ITEM_CAPTURED_KEYS = [
  'capture_id',
  'item_type',
  'capture_surface',
  // NEX-200: which surface the user *initiated* the capture from
  // ('command' = the Eye/Command tab; 'home' = the Home quick-add bar).
  // Distinct from capture_surface (the DESTINATION, e.g. 'inbox') — this is
  // the friction dimension that measures whether Home capture reduces tab
  // hopping. Purely additive; old rows simply lack it (no backfill bump —
  // the deterministic UUID seeds on capture_id, so dedup is unaffected).
  'capture_origin',
  'local_day_key',
] as const;

export const CAPTURED_ITEM_FIRST_REACHED_KEYS = [
  'capture_id',
  'item_type',
  'age_bucket',
  'surface',
  'access_method',
] as const;

export const APP_OPENED_KEYS = ['local_day_key', 'days_since_last_active_day'] as const;

// ─── Minimal record shapes the helpers read ─────────────────────────────────

/** One `item_captured` fact. `captureId` is the opaque store-entity id (join key). */
export interface CaptureRecord {
  captureId: string;
  dayKey: string;
}

/**
 * One reach of a captured item. `seq` is a monotonic ordinal (e.g. the event
 * timestamp in ms) that gives a TOTAL order so the first reach is deterministic
 * even when several reaches share a `dayKey` — without it, same-day duplicates
 * would tie-break on input order and flip the hunt attribution. It is a count,
 * not user content (PII-free).
 */
export interface FirstReachRecord {
  captureId: string;
  accessMethod: AccessMethod;
  dayKey: string;
  seq: number;
}

/** A single lapse episode derived from active-day history. */
export interface LapseEpisode {
  /** The last active day before the gap (day `D`). */
  startDayKey: string;
  /** Whether the return window has fully closed (`D + RETURN_WINDOW_DAYS < today`). */
  matured: boolean;
  /** Whether an active day fell in `[D+4, D+30]`. */
  returned: boolean;
  /** Days from `D` to the returning active day, when returned. */
  returnLatencyDays?: number;
}

// ─── Day-key math ───────────────────────────────────────────────────────────

/**
 * Whole CALENDAR days from day-key `a` to day-key `b` (`b - a`). Parses the
 * `YYYY-MM-DD` as a UTC midpoint (noon) so DST never shifts the day boundary.
 * Positive when `b` is later than `a`.
 */
export function dayKeyDiff(a: string, b: string): number {
  const ms = (key: string): number => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12, 0, 0);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

// ─── Metric 2: return-after-a-lapse ─────────────────────────────────────────

/**
 * Current-open classification, computed off the already-persisted `lastOpenDate`
 * (app-state) — no new persisted state. Returns RAW facts only (no verdict baked
 * into the event); the rate is computed offline by `computeReturnAfterLapseRate`.
 *
 * `previousDayKey === null` (first-ever open) is not a return — `daysSinceLastActiveDay`
 * is null in that case.
 */
export function classifyOpen(
  previousDayKey: string | null | undefined,
  todayDayKey: string,
): { daysSinceLastActiveDay: number | null } {
  if (!previousDayKey) return { daysSinceLastActiveDay: null };
  return { daysSinceLastActiveDay: Math.max(0, dayKeyDiff(previousDayKey, todayDayKey)) };
}

/**
 * Derive lapse episodes from the full sequence of ACTIVE days (opens ∪ actions).
 * A lapse begins at active day `D` when more than `LAPSE_THRESHOLD_DAYS`
 * consecutive days pass with no activity — i.e. the gap to the next active day
 * is `> LAPSE_THRESHOLD_DAYS`, OR there is no next active day and more than
 * `LAPSE_THRESHOLD_DAYS` have already elapsed to `today` (an open, ongoing gap).
 * It "returned" if the next active day is within `[D+1, D+RETURN_WINDOW_DAYS]`
 * (the first 3 are inactive by definition, so the earliest qualifying return is
 * `D+4`). An episode is "matured" only once the return window has fully CLOSED,
 * i.e. `D + RETURN_WINDOW_DAYS < today` — on day `D + RETURN_WINDOW_DAYS` itself
 * the user can still open and count as a return, so it is not yet final. Immature
 * episodes are excluded from the rate so a still-open window can't be miscounted
 * as a non-return. A user active within the threshold of `today` produces NO
 * trailing episode (they have not lapsed).
 *
 * `activeDayKeys` may be unsorted and contain duplicates; both are normalized.
 */
export function computeLapseEpisodes(
  activeDayKeys: readonly string[],
  opts: { todayDayKey: string },
): LapseEpisode[] {
  // Point-in-time correct: ignore any activity dated after the snapshot day, so
  // a historical run can't count a future active day as an already-settled return.
  const days = Array.from(new Set(activeDayKeys))
    .filter((d) => d <= opts.todayDayKey)
    .sort();
  const episodes: LapseEpisode[] = [];

  for (let i = 0; i < days.length; i++) {
    const start = days[i];
    const next = days[i + 1]; // undefined if this is the last active day
    // For a tail (no next active day), the gap is measured to today — an open,
    // ongoing absence. A return is only possible when there IS a next active day.
    const gap = next != null ? dayKeyDiff(start, next) : dayKeyDiff(start, opts.todayDayKey);

    // Not a lapse: still active within the threshold (or this tail is recent).
    if (gap <= LAPSE_THRESHOLD_DAYS) continue;

    const matured = dayKeyDiff(start, opts.todayDayKey) > RETURN_WINDOW_DAYS;
    const returnedWithinWindow = next != null && gap <= RETURN_WINDOW_DAYS;

    episodes.push({
      startDayKey: start,
      matured,
      returned: returnedWithinWindow,
      ...(returnedWithinWindow ? { returnLatencyDays: gap } : {}),
    });
  }

  return episodes;
}

/**
 * The return-after-a-lapse RATE: `returned_episodes / settled_episodes`.
 *
 * An episode is "settled" once its outcome is final: a RETURNED episode is final
 * the instant the return lands (no later day can un-return it), so it counts
 * immediately regardless of window maturity. A NOT-yet-returned episode only
 * settles once its 30-day window has matured — until then it is excluded, so an
 * open window can't be miscounted as a non-return. `rate` is null when no
 * episodes have settled yet (undefined, not zero).
 */
export function computeReturnAfterLapseRate(
  activeDayKeys: readonly string[],
  todayDayKey: string,
): { rate: number | null; returned: number; total: number } {
  const settled = computeLapseEpisodes(activeDayKeys, { todayDayKey }).filter(
    (e) => e.returned || e.matured,
  );
  const returned = settled.filter((e) => e.returned).length;
  const total = settled.length;
  return { rate: total === 0 ? null : returned / total, returned, total };
}

// ─── Metric 1: hunts-to-find ────────────────────────────────────────────────

/** A first reach via manual navigation or search is a HUNT; everything else is surfaced. */
export function attributeReach(accessMethod: AccessMethod): ReachAttribution {
  return accessMethod === 'manual_nav' || accessMethod === 'search' ? 'hunt' : 'surfaced';
}

/** Total order on reaches: earlier `dayKey`, then lower `seq`. */
function isEarlierReach(a: FirstReachRecord, b: FirstReachRecord): boolean {
  return a.dayKey < b.dayKey || (a.dayKey === b.dayKey && a.seq < b.seq);
}

/**
 * The hunt rate among captures that have been reached:
 * `hunt_first_reaches / captures_with_a_first_reach` → target 0.
 *
 * Joined on `captureId`. Only the FIRST reach per capture counts; when several
 * reaches share a capture the earliest by `(dayKey, seq)` wins — a TOTAL order,
 * so the result is independent of input array order (the emitter is expected to
 * dedupe; this is order-stable defense in depth). Reaches with no matching
 * capture are ignored.
 *
 * HARD PRECONDITION (NEX-261): `captures` and `firstReaches` MUST be pre-filtered
 * to a single item_type whose hunt path is fully instrumented — today
 * `item_type === 'one_off'` ONLY. This function does NOT filter; feeding a mixed
 * stream silently yields a false-zero hunt rate (non-one_off surfaces emit only
 * surfaced reaches). See the module SCOPE NOTE.
 */
export function computeHuntFirstReachRate(
  captures: readonly CaptureRecord[],
  firstReaches: readonly FirstReachRecord[],
): { rate: number | null; hunts: number; reached: number } {
  const captureIds = new Set(captures.map((c) => c.captureId));

  const firstByCapture = new Map<string, FirstReachRecord>();
  for (const r of firstReaches) {
    if (!captureIds.has(r.captureId)) continue;
    const existing = firstByCapture.get(r.captureId);
    if (!existing || isEarlierReach(r, existing)) firstByCapture.set(r.captureId, r);
  }

  let hunts = 0;
  for (const r of firstByCapture.values()) {
    if (attributeReach(r.accessMethod) === 'hunt') hunts++;
  }
  const reached = firstByCapture.size;
  return { rate: reached === 0 ? null : hunts / reached, hunts, reached };
}

/**
 * Companion guard so "hunts → 0" can't be gamed by simply never reaching items.
 * The UNREACHED rate among captures old enough to have been reached:
 * `unreached_captures_past_grace / captures_past_grace`. A capture is "past grace"
 * once `captureDay + graceDays <= today`. Returns the rate over that mature set.
 *
 * Point-in-time correct: only reaches that have ALREADY happened as of
 * `todayDayKey` count — a reach dated after the snapshot day must not mark a
 * capture reached (it would undercount unreached captures in a historical view).
 */
export function computeUnreachedCaptureRate(
  captures: readonly CaptureRecord[],
  firstReaches: readonly FirstReachRecord[],
  opts: { todayDayKey: string; graceDays: number },
): { rate: number | null; unreached: number; total: number } {
  const reachedIds = new Set(
    firstReaches.filter((r) => r.dayKey <= opts.todayDayKey).map((r) => r.captureId),
  );
  const mature = captures.filter(
    (c) => dayKeyDiff(c.dayKey, opts.todayDayKey) >= opts.graceDays,
  );
  const unreached = mature.filter((c) => !reachedIds.has(c.captureId)).length;
  const total = mature.length;
  return { rate: total === 0 ? null : unreached / total, unreached, total };
}
