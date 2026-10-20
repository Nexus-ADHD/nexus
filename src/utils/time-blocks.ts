// NEX-205 (Or-2): wide energy-shaped time-blocks. Pure, RN-free helpers so the
// Node/vitest suite can cover the clock math (app-state / RN components are not
// importable in that suite — see LEARNINGS).

// A new time-block opens its end-time at a wide default so it reads as a
// "window," not a clock slot (the ADHD time-blocking pattern: "9–12 Study").
export const TIME_BLOCK_DEFAULT_DURATION_MINUTES = 90;

/**
 * Add `mins` to an "HH:MM" 24h time, wrapping within a single day (so 23:30 + 90
 * → 01:00). Negative offsets wrap too. Invalid input falls back to 0 components.
 */
export function addMinutesToHHMM(hhmm: string, mins: number): string {
  const [h, m] = String(hhmm).split(':').map(Number);
  const base = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  const total = (((base + mins) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * The wide default end-time for a new time-block (start + 90 min), clamped so it
 * never wraps past midnight. A wrapped end (e.g. start 23:30 → 01:00) would read
 * as <= start under the sheet's string-compare validator and block save, so we
 * cap at end-of-day instead. Returns "HH:MM".
 */
export function wideBlockEndTime(startHHMM: string): string {
  const end = addMinutesToHHMM(startHHMM, TIME_BLOCK_DEFAULT_DURATION_MINUTES);
  return end <= startHHMM ? '23:59' : end;
}

// ---------------------------------------------------------------------------
// NEX-205 PR2a — grey-on-pass. A native energy time-block whose window has
// passed greys (never reds) and surfaces a no-shame "buffer" caption. These
// pure predicates/selectors let the timeline find the just-passed block and
// decide caption eligibility without pulling in RN.
// ---------------------------------------------------------------------------

// Minimal structural shape of a (normalized) orbit agenda item, as far as the
// time-block helpers care. The render layer carries far more.
export interface TimeBlockLike {
  id?: string;
  eventType?: string;
  source?: string;
  allDay?: boolean;
  endDate?: string;
  endISO?: string;
}

const endMsOf = (e: TimeBlockLike | null | undefined): number => {
  const raw = e?.endDate ?? e?.endISO;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return ms;
};

/** A user-created native time-block (the only events energy/slide attach to). */
export function isNativeTimeBlock(e: TimeBlockLike | null | undefined): boolean {
  return !!e && e.eventType === 'time_block' && e.source === 'manual' && !e.allDay;
}

/**
 * The single most-recently-passed native time-block in a day's agenda (its
 * window ended at/before `nowMs`), or null. Used to surface the "just passed"
 * block inline so the buffer reassurance is visible without opening the
 * collapsed past drawer. Ties break toward the later end.
 */
export function selectJustPassedBlock<T extends TimeBlockLike>(
  events: readonly T[] | null | undefined,
  nowMs: number,
): T | null {
  const passed = (events ?? []).filter((e) => {
    if (!isNativeTimeBlock(e)) return false;
    const end = endMsOf(e);
    return Number.isFinite(end) && end <= nowMs;
  });
  if (passed.length === 0) return null;
  return passed.reduce((latest, e) => (endMsOf(e) >= endMsOf(latest) ? e : latest));
}

// ---------------------------------------------------------------------------
// NEX-205 PR2b — move to next window. A passed block "slides" forward: the user
// taps once and it lands in the next free slot later today (no auto-cascade —
// that's Or-3). Pure interval-fit so vitest covers the edges (overlaps, no room,
// day-end, blockers that touch). Time is local minutes-since-midnight; the
// caller derives blockers from the day's *timed* agenda (excluding the target
// and all-day events) and applies the result to the same day's dateKey.
// ---------------------------------------------------------------------------

export interface MinuteInterval {
  startMin: number;
  endMin: number;
}

const ceilTo = (min: number, step: number): number => Math.ceil(min / step) * step;

/**
 * Earliest start (minutes-since-midnight, rounded up to `stepMin`) at/after
 * `earliestMin` where a block of `durationMin` fits before the next blocker and
 * before `dayEndMin`, given `blockers` (other timed intervals, target excluded).
 * Returns null when no room remains today. Pure + deterministic.
 */
export function nextFreeStart(
  blockers: readonly MinuteInterval[],
  durationMin: number,
  earliestMin: number,
  dayEndMin = 24 * 60 - 1, // 23:59
  stepMin = 15,
): number | null {
  if (!Number.isFinite(durationMin) || durationMin <= 0) return null;
  const sorted = [...(blockers ?? [])]
    .filter((b) => Number.isFinite(b?.startMin) && Number.isFinite(b?.endMin) && b.endMin > b.startMin)
    .sort((a, b) => a.startMin - b.startMin);

  let candidate = ceilTo(Math.max(0, earliestMin), stepMin);
  // Walk forward past any blocker the candidate window would overlap. Each step
  // jumps to the blocker's end (rounded up), so this terminates.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (candidate + durationMin > dayEndMin) return null;
    const hit = sorted.find((b) => candidate < b.endMin && candidate + durationMin > b.startMin);
    if (!hit) return candidate;
    candidate = ceilTo(hit.endMin, stepMin);
  }
}

/** Local minutes-since-midnight for an ISO/date string, or NaN. */
export function localMinutesOf(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? NaN : d.getHours() * 60 + d.getMinutes();
}
