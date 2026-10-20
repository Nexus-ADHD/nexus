// Pure helper for rendering daysOfWeek arrays as human-readable
// cadence strings. Extracted from review-screen.tsx so vitest can
// import it without dragging the React Native render runtime in.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Render daysOfWeek as a human-readable cadence string.
 *
 *   [0,1,2,3,4,5,6] → "Daily"
 *   [1,2,3,4,5]     → "Weekdays"
 *   [0,6]           → "Weekends"
 *   [1,3,5]         → "Mon, Wed, Fri"
 *
 * Out-of-range integers are silently dropped. Empty input returns "".
 */
export function formatDaysOfWeek(daysOfWeek: number[]): string {
  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) return '';
  const sorted = [...daysOfWeek]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  if (sorted.length === 7) return 'Daily';
  if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) return 'Weekdays';
  if (sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6) return 'Weekends';
  return sorted.map((d) => DAY_NAMES[d]).join(', ');
}
