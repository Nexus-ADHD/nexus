/**
 * Pure DayPicker selection logic, split out so vitest (node env) covers it —
 * DayPicker.tsx imports react-native and can't load under the node runner.
 * Import-free on purpose (pill-metrics.ts / list-row-metrics.ts pattern).
 */

export type DayPickerMode = 'single' | 'multi';

// Visual circle; hitSlop lifts the touch target to the 44pt floor without
// changing layout. Today's chips are 36pt with NO slop (Orbit), which is under
// the floor outright.
export const DAY_CIRCLE_SIZE = 34;
export const DAY_HIT_SLOP = (44 - DAY_CIRCLE_SIZE) / 2; // 5

/**
 * Toggle a day.
 *
 * single — the tapped day REPLACES the selection; tapping the selected day is
 *   a no-op, never a deselect, because "no day" is not a valid weekly-summary
 *   state.
 * multi — the tapped day flips. Deselecting the last day IS allowed: the two
 *   forms that use this gate their own save on a non-empty selection and show
 *   their own error, so silently refusing here would strand the user with no
 *   feedback and change validation they already own.
 *
 * The result is always sorted ascending, so callers can compare selections by
 * value and persisted `daysOfWeek` arrays stay canonical.
 */
export function toggleDay({
  value,
  day,
  mode,
}: {
  value: readonly number[];
  day: number;
  mode: DayPickerMode;
}): number[] {
  if (mode === 'single') return [day];
  const has = value.includes(day);
  const next = has ? value.filter((d) => d !== day) : [...value, day];
  return [...next].sort((a, b) => a - b);
}

/** True when `day` should render as selected. */
export function isDaySelected(value: readonly number[], day: number): boolean {
  return value.includes(day);
}

// ─── Accessibility roles ──────────────────────────────────────────────────────

/**
 * Roles follow the MODE, because they are a promise about what the control can
 * do. A radiogroup tells assistive tech the choice is mutually exclusive — say
 * that over a multi-select and you have described a control that cannot do what
 * it visibly does (Greptile #400, reproduced against the rendered multi path).
 *
 * single → radiogroup of radios: exactly one, and picking another moves it.
 * multi  → a plain list of checkboxes: each day is independently on or off.
 */
export function groupRole(mode: DayPickerMode): 'radiogroup' | 'list' {
  return mode === 'single' ? 'radiogroup' : 'list';
}

export function dayRole(mode: DayPickerMode): 'radio' | 'checkbox' {
  return mode === 'single' ? 'radio' : 'checkbox';
}

/**
 * Normalizes whatever a caller holds into the array the renderer wants.
 * `single` mode exposes a plain number in its public API — an array there is
 * an easy way to persist two "single" days by accident, especially since the
 * biggest consumer file is @ts-nocheck and would not catch it.
 */
export function toSelectionArray(value: number | readonly number[]): number[] {
  return typeof value === 'number' ? [value] : [...value];
}
