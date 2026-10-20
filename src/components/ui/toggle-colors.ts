/**
 * Pure Toggle policy, split out so vitest (node env) covers it — Toggle.tsx
 * imports react-native and can't load under the node runner. Import-free on
 * purpose (mirrors pill-metrics.ts / list-row-metrics.ts).
 *
 * This module decides ROLES, never hex: Toggle maps the roles onto tokens, so
 * the "no hardcoded hex in components" rule holds in both files.
 */

export type TogglePlatform = 'ios' | 'android';

/** Which track the switch wears. 'on' is the teal sacred-active track. */
export type ToggleTrackRole = 'on' | 'off';

/**
 * 'native' means DO NOT set thumbColor at all.
 *
 * React Native's own docs (Switch.js: "Color of the foreground switch grip. If
 * this is set on iOS, the switch grip will lose its drop shadow") — forcing a
 * thumb colour on iOS flattens the grip. iOS already ships a white thumb WITH
 * the shadow, so the correct way to get "white thumb" on iOS is to ask for
 * nothing. Android has no such default, so it is set explicitly.
 */
export type ToggleThumbRole = 'native' | 'light';

export type ToggleResolution = {
  track: ToggleTrackRole;
  thumb: ToggleThumbRole;
  /** Disabled dims the whole control rather than inventing a third palette. */
  opacity: number;
};

export const TOGGLE_DISABLED_OPACITY = 0.4;

/**
 * The thumb is a physical object and the TRACK carries the state — which is
 * how the platform switch reads, and why the thumb never changes colour with
 * value. State is never colour-alone (§17): thumb POSITION and the OS's own
 * on/off announcement both carry it.
 */
export function resolveToggleColors({
  value,
  disabled = false,
  platform,
}: {
  value: boolean;
  disabled?: boolean;
  platform: TogglePlatform;
}): ToggleResolution {
  return {
    track: value ? 'on' : 'off',
    thumb: platform === 'ios' ? 'native' : 'light',
    opacity: disabled ? TOGGLE_DISABLED_OPACITY : 1,
  };
}
