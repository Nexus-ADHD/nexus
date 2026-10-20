/**
 * date-tokens.ts
 *
 * Pure, side-effect-free local-date helpers shared by the capture pipeline.
 *
 * Extracted from confidence-tier.ts (NEX-223) so the Tier-1 grammar parser
 * (grammar-parser.ts) and the confidence-tier safety gate resolve dates in the
 * SAME naive-local `YYYY-MM-DD` format. A format mismatch would make the gate
 * reject the grammar's own dateStr, so this consistency is load-bearing.
 *
 * All math is local `setDate` arithmetic — never `toISOString()`, which would
 * shift the date across the UTC boundary (the repo guards this in
 * src/utils/__tests__/week-ahead.test.ts).
 */

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Naive-local `YYYY-MM-DD` for a Date (matches the command screen's format). */
export function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(now: Date): string {
  return dateKeyOf(now);
}

export function tomorrowKey(now: Date): string {
  const d = new Date(now);
  d.setDate(now.getDate() + 1);
  return dateKeyOf(d);
}

/** Upcoming weekend: today if Sat/Sun, else the next Saturday. */
export function weekendKey(now: Date): string {
  const dow = now.getDay();
  if (dow === 0 || dow === 6) return dateKeyOf(now);
  const d = new Date(now);
  d.setDate(now.getDate() + ((6 - dow + 7) % 7));
  return dateKeyOf(d);
}

/**
 * The next occurrence of `targetDow` (0=Sun … 6=Sat), returning TODAY when today
 * already is that weekday (a spoken "Friday" on a Friday means today). Local math.
 */
export function nextWeekday(now: Date, targetDow: number): string {
  const delta = ((targetDow - now.getDay()) + 7) % 7;
  const d = new Date(now);
  d.setDate(now.getDate() + delta);
  return dateKeyOf(d);
}
