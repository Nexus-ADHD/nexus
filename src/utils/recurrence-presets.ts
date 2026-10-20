/**
 * Shared recurrence preset definitions for recurring to-dos.
 *
 * Used by both the Orbit ScheduleEditModal (editing existing to-dos) and
 * OrbitManualAddSheet (creating new ones). One source of truth so the
 * "Daily / Weekdays / Weekends / Weekly / Biweekly / Monthly / Custom"
 * vocabulary can't drift between the two surfaces.
 */

export type RecurrencePreset =
  | 'daily'
  | 'weekdays'
  | 'weekends'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'custom';

export interface RecurrenceConfig {
  daysOfWeek: number[];
  interval: number;
  preset: RecurrencePreset;
}

export const RECURRENCE_PRESETS: { id: RecurrencePreset; label: string; sub: string }[] = [
  { id: 'daily',     label: 'Every Day',     sub: 'Sun – Sat' },
  { id: 'weekdays',  label: 'Weekdays',      sub: 'Mon – Fri' },
  { id: 'weekends',  label: 'Weekends',      sub: 'Sat & Sun' },
  { id: 'weekly',    label: 'Once a Week',   sub: 'Pick a day below' },
  { id: 'biweekly',  label: 'Every 2 Weeks', sub: 'Pick a day below' },
  { id: 'monthly',   label: 'Once a Month',  sub: 'Pick a day — ~4 weeks' },
  { id: 'custom',    label: 'Custom',        sub: 'Pick any days + interval' },
];

export function presetToDays(preset: RecurrencePreset): number[] {
  if (preset === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (preset === 'weekdays') return [1, 2, 3, 4, 5];
  if (preset === 'weekends') return [0, 6];
  return [];
}

export function presetToInterval(preset: RecurrencePreset): number {
  if (preset === 'biweekly') return 2;
  if (preset === 'monthly') return 4;
  return 1;
}

export function detectPreset(daysOfWeek: number[], interval: number): RecurrencePreset {
  const sorted = [...daysOfWeek].sort().join(',');
  if (sorted === '0,1,2,3,4,5,6' && interval === 1) return 'daily';
  if (sorted === '1,2,3,4,5' && interval === 1) return 'weekdays';
  if (sorted === '0,6' && interval === 1) return 'weekends';
  if (daysOfWeek.length === 1 && interval === 1) return 'weekly';
  if (daysOfWeek.length === 1 && interval === 2) return 'biweekly';
  if (daysOfWeek.length === 1 && interval === 4) return 'monthly';
  return 'custom';
}

/** Whether a preset requires a day picker UI. */
export function presetNeedsDayPicker(preset: RecurrencePreset): boolean {
  return ['weekly', 'biweekly', 'monthly', 'custom'].includes(preset);
}
