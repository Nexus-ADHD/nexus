/**
 * Pure Stepper arithmetic, split out so vitest (node env) covers it —
 * Stepper.tsx imports react-native and can't load under the node runner.
 * Import-free on purpose (pill-metrics.ts / list-row-metrics.ts pattern).
 */

/**
 * Step a WRAPPING value (hour mod 24, minute mod 60). Wrap, not clamp: a time
 * control must roll 23 -> 0, which min/max clamping cannot express.
 *
 * Snaps to the step grid FIRST. Blind addition strands an off-grid value
 * forever: stored minute 7 with step 5 cycles 7 -> 12 -> ... -> 57 -> 2 -> 7
 * and NEVER reaches 0. Minutes are contracted as 0-59 (app-state) and arrive
 * from cloud sync unnormalized, so off-grid input is reachable in production,
 * not hypothetical. Snapping means 7 goes to 10 (up) or 5 (down) and is on the
 * grid from then on.
 */
export function stepValue({
  value,
  dir,
  step = 1,
  wrap,
}: {
  value: number;
  dir: 1 | -1;
  step?: number;
  /** Modulus — 24 for hours, 60 for minutes. */
  wrap: number;
}): number {
  // Snap toward the direction of travel: from a stray 7 with step 5, "up"
  // means the next grid point ABOVE (10) and "down" the one BELOW (5).
  // Rounding to nearest instead would send 7 down to 0, skipping 5 — the user
  // would watch the value jump past the number they were aiming for.
  const onGrid = value % step === 0;
  const next = onGrid
    ? value + dir * step
    : (dir === 1 ? Math.ceil(value / step) : Math.floor(value / step)) * step;
  return ((next % wrap) + wrap) % wrap; // correct for negatives
}

/** True when a stored value does not sit on the step grid. */
export function isOffGrid(value: number, step: number): boolean {
  return value % step !== 0;
}

// ─── 12-hour clock ────────────────────────────────────────────────────────────

export type Meridiem = 'AM' | 'PM';

/**
 * 24-hour -> 12-hour display. The two boundaries people get wrong are
 * midnight (0 -> "12 AM", not "0 AM") and noon (12 -> "12 PM", not "0 PM").
 */
export function to12Hour(hour24: number): { hour12: number; meridiem: Meridiem } {
  const h = ((hour24 % 24) + 24) % 24;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return { hour12, meridiem: h < 12 ? 'AM' : 'PM' };
}

/** Zero-padded two-digit display (minutes, and the hour where padding is wanted). */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The spoken form of a time, for accessibilityValue.text. VoiceOver announcing
 * a bare "11" on an adjustable control leaves the user without the meridiem —
 * the one thing that makes a reminder time meaningful.
 */
export function spokenTime(hour24: number, minute: number): string {
  const { hour12, meridiem } = to12Hour(hour24);
  return `${hour12}:${pad2(minute)} ${meridiem}`;
}

/** A time the two Steppers edit together. */
export interface StepperTime {
  hour: number;
  minute: number;
}

/**
 * The next time after one Stepper press.
 *
 * A time row has TWO Steppers and they can both fire inside a single React
 * commit — press hour, then minute, before a rerender. Basing each update on
 * the render-captured value therefore loses the earlier press: 08:00 → 09:00 →
 * 08:05 drops the hour. Basing it on the PENDING value instead makes the two
 * controls compose rather than race.
 *
 * Pure so the rule can be tested: the component holds `pending` in a ref, which
 * vitest cannot mount, but the composition is the part that was wrong.
 */
export function nextStepperTime(
  pending: StepperTime | null,
  shown: StepperTime,
  patch: Partial<StepperTime>,
): StepperTime {
  return { ...(pending ?? shown), ...patch };
}
